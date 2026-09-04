// Live Helpme simulation harness. Runs the reconstructed strategy on the same
// Binance, RTDS, and Polymarket CLOB data displayed by the dashboard.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/config.js";
import { fillFee, isFeeFill } from "../../engine/fees.js";
import { DEFAULT_STRATEGY, getStrategy } from "../../engine/strategies/index.js";
import { applyMergeToLedger } from "../../engine/mergesim.js";   // merge-sim — apply a merge record to the live ledger
import { walkVisibleAsks, walkVisibleBudget } from "../../engine/fillsim.js";
import { STAGES } from "../lib/orderstatus.js";
import { isRunning } from "./botState.js";
import { createSessionCircuitBreaker } from "./sessionCircuitBreaker.js";
import { recordFill, recordSession } from "../sources/db.js";   // MongoDB record store (mode-split collections)
import { verbose, verboseOn } from "../logging/verbose.js";     // diagnostic trace (verbose switch) → pm2 logs

export function createShadow(onEvent = () => {}, uiActive = () => true) {
  /** @type {Map<string, object>} */
  const windows = new Map();
  let liveParams = {};             // UI overrides merged over STRAT (set by setParams; defaults until then)
  let curStrat = getStrategy(DEFAULT_STRATEGY);
  let mergedP = { ...curStrat.STRAT, LIVE_FILLS: false };      // Helpme is permanently shadow-only.
                                   //   config-object spread on EVERY book update). Read-only in the hot path.
  const circuitBreaker = createSessionCircuitBreaker(
    () => (mergedP && mergedP.MAX_SESSION_LOSS != null) ? (+mergedP.MAX_SESSION_LOSS || 0) : (config.maxSessionLoss || 0),
    (event) => { try { onEvent({ kind: "circuit_breaker", ...event }); } catch {} },
  );
  let activeSlug = null;           // the currently-ticking window's slug — target for MANUAL buys

  fs.mkdirSync(config.dataDir, { recursive: true });

  function getW(slug, windowStart, openBinance) {
    let w = windows.get(slug);
    if (!w) {
      w = { slug, windowStart, openBinance, winSide: null, upShares: 0, downShares: 0, cost: 0, fee: 0,
            upCost: 0, downCost: 0, mergedRealized: 0, mergedUsd: 0, fills: [], settled: false,
            breakerGeneration: circuitBreaker.stamp(),
            // strategy state (self-initialized by Helpme on the first tick)
            orders: [], seq: 0, lastTickMs: null,
            // Per-window cadence and gate diagnostics.
            vDiag: { open: false, tickN: 0, dtSum: 0, dtMax: 0, gate: {} } };
      windows.set(slug, w);
    }
    if (openBinance != null && w.openBinance == null) w.openBinance = openBinance;
    return w;
  }

  // Restore a still-open window after a process restart. Fills and decisions
  // are durable in MongoDB. Momentum history intentionally warms up again from
  // the fresh feed; fabricating pre-restart samples would be non-causal.
  function hydrateWindow({ slug, windowStart, fills = [], orderStatus = [] }) {
    const w = getW(slug, windowStart, null);
    if (w.hydrated || w.fills.length || w.seq > 0) return w;
    const seenFills = new Set();
    for (const rec of [...fills].sort((a, b) => (+a.tInto || 0) - (+b.tInto || 0))) {
      const key = `${rec.oid ?? ""}:${rec.leg ?? ""}:${rec.tInto ?? ""}:${rec.side ?? ""}`;
      if (seenFills.has(key)) continue;
      seenFills.add(key);
      if (rec.leg === "merge") applyMergeToLedger(w, rec);
      else {
        const shares = +rec.shares || 0, usdc = +rec.usdc || 0;
        if (rec.side === "Up") { w.upShares += shares; w.upCost += usdc; }
        else if (rec.side === "Down") { w.downShares += shares; w.downCost += usdc; }
        w.cost += usdc;
        w.fee += fillFee(rec.effPx, shares, isFeeFill(rec, mergedP), mergedP);
      }
      w.fills.push(rec);
      w.seq = Math.max(w.seq, +rec.oid || 0);
    }
    const decisions = new Map();
    for (const event of orderStatus) {
      if (event?.stage !== STAGES.DECIDED || event.oid == null) continue;
      decisions.set(String(event.oid), event);
      w.seq = Math.max(w.seq, +event.oid || 0);
    }
    if (decisions.size) {
      const model = w.helpme = { history: [], historyHead: 0, lastSignalKey: null,
        lastOrderMs: -Infinity, orderCount: decisions.size };
      for (const event of decisions.values()) {
        const ask = Number(event.decPx), explicitCap = Number(event.limitPx);
        const cap = Number.isFinite(explicitCap) && explicitCap > 0 ? explicitCap
          : Number.isFinite(ask) && ask > 0
            ? Math.min(+mergedP.LIMIT || .99,
              Math.ceil((ask + Math.max(0, +mergedP.H_CAP_HEADROOM || 0) - 1e-9) * 100) / 100)
            : null;
        w.orders.push({ oid: event.oid, side: event.side, limit: cap, kind: event.leg || "entry",
          budgetUsd: event.budgetUsd ?? null, filledUsd: 0, placedT: event.tInto ?? null });
        const eventMs = Number(event.ts);
        if (Number.isFinite(eventMs)) model.lastOrderMs = Math.max(model.lastOrderMs, eventMs);
      }
    }
    w.hydrated = true;
    if (w.fills.length || decisions.size) console.log(`[shadow hydrate] ${String(slug).split("-").pop()}: restored ${w.fills.length} fills / ${decisions.size} decisions`);
    return w;
  }

  // Book a taker FILL (record from stepMomTaker) → update aggregate position + emit a circle + persist.
  function bookFill(w, rec) {
    const fee = fillFee(rec.effPx, rec.shares, isFeeFill(rec, mergedP), mergedP);
    // snapshot BEFORE this fill (for the property menu's before→after view)
    const posBefore = { upShares: w.upShares, downShares: w.downShares, upCost: w.upCost, downCost: w.downCost, totalCost: w.cost,
                        ifUpWins: w.upShares - w.cost - w.fee, ifDownWins: w.downShares - w.cost - w.fee };
    // Every active-strategy fill is an entry BUY → add shares/cost to its side.
    if (rec.side === "Up") { w.upShares += rec.shares; w.upCost += rec.usdc; }
    else { w.downShares += rec.shares; w.downCost += rec.usdc; }
    w.cost += rec.usdc; w.fee += fee;
    w.fills.push(rec);
    try {
      onEvent({ kind: "shadow_buy", slug: w.slug, windowStart: w.windowStart, rec,
        pos: { upShares: w.upShares, downShares: w.downShares, cost: w.cost, fee: w.fee,
               upCost: w.upCost, downCost: w.downCost, posBefore,
               ifUpWins: w.upShares - w.cost - w.fee, ifDownWins: w.downShares - w.cost - w.fee } });
      // ORDER STATUS — the SIM leg filled (immediately / deferred / resting-maker fill / escalate-take).
      if (rec.leg !== "merge") onEvent({ kind: "order_status", stage: STAGES.SIM_FILLED, key: `${w.windowStart}:${rec.oid}`,
        slug: w.slug, ws: w.windowStart, oid: rec.oid, side: rec.side, leg: rec.leg, reason: rec.reason,
        tInto: rec.tInto, shares: rec.shares, simFillPx: rec.effPx, simFilledLate: !!rec.filledLate,
        maker: !!rec.maker, ts: Date.now() });
    } catch {}
    recordFill({ ...rec, slug: w.slug, windowStart: w.windowStart });   // → MongoDB shadow_fills_<mode>
  }

  // Apply a MERGE record (leg:"merge") from stepSignalHedge — reclaim the MAIN complete sets: remove them
  // from the position, BANK the realized profit (moved out of if-up/if-down into mergedRealized so they reset),
  // and emit shadow_merge (which index.js routes to the REAL on-chain mergePositions tx in live mode). The
  // special-hedge shares are excluded (they stay in the position). PnL-neutral; see strategy.maybeMerge.
  function applyMerge(w, rec) {
    const posBefore = { upShares: w.upShares, downShares: w.downShares, upCost: w.upCost, downCost: w.downCost, totalCost: w.cost,
                        ifUpWins: w.upShares - w.cost - w.fee, ifDownWins: w.downShares - w.cost - w.fee };
    applyMergeToLedger(w, rec);   // remove merged sets + their cost/fee, bank realized + reclaimed collateral (mergesim)
    w.fills.push(rec);
    try {
      onEvent({ kind: "shadow_merge", slug: w.slug, windowStart: w.windowStart, rec,
        pos: { upShares: w.upShares, downShares: w.downShares, cost: w.cost, fee: w.fee,
               mergedRealized: w.mergedRealized, mergedUsd: w.mergedUsd, posBefore,
               ifUpWins: w.upShares - w.cost - w.fee, ifDownWins: w.downShares - w.cost - w.fee } });
    } catch {}
    recordFill({ ...rec, slug: w.slug, windowStart: w.windowStart });   // → MongoDB shadow_fills_<mode>
  }

  // Full config snapshot for a window — the SINGLE source of truth for what settings produced these fills.
  // Stamped into every window_open / settle verbose line AND into the persisted settle record, so a later
  // live-vs-backtest comparison never has to GUESS the config (the #1 cause of spurious "divergence").
  function cfgStamp() {
    const P = mergedP;
    return {
      strategy: DEFAULT_STRATEGY,
      latencyMs: P.LATENCY_MS || 0,
      baseOrderShares: P.H_BASE_ORDER_SH,
      targetSizeOn: P.H_TARGET_SIZE_ON === true,
      targetSizeScale: P.H_TARGET_SIZE_SCALE,
      targetSizeMaxShares: P.H_TARGET_SIZE_MAX_SH,
      targetTopupMinScale: P.H_TARGET_TOPUP_MIN_SCALE,
      targetReversalSizeOn: P.H_TARGET_REVERSAL_SIZE_ON === true,
      targetDirectionOn: P.H_TARGET_DIRECTION_ON === true,
      directionLookbackMs: P.H_DIRECTION_LOOKBACK_MS,
      directionWeights: [P.H_DIRECTION_LEVEL_WEIGHT, P.H_DIRECTION_CLOB_WEIGHT,
        P.H_DIRECTION_BINANCE_WEIGHT],
      directionEnterScore: P.H_DIRECTION_ENTER_SCORE,
      directionExitScore: P.H_DIRECTION_EXIT_SCORE,
      signalHysteresisOn: P.H_SIGNAL_HYSTERESIS_ON === true,
      firstEntryEarliestS: P.H_FIRST_ENTRY_EARLIEST_S,
      topupCooldownMs: P.H_TOPUP_COOLDOWN_MS,
      maximumActions: P.H_MAX_ACTIONS_PER_WINDOW,
      cooldownMs: P.H_COOLDOWN_MS,
      activeFromS: P.H_START_S,
      stopAtS: P.H_STOP_S,
      clobMidVelocityOn: P.H_CLOB_MID_VELOCITY_ON,
      midVelocityLookbackMs: P.H_MID_VELOCITY_LOOKBACK_MS,
      midVelocityMin: P.H_MID_VELOCITY_MIN,
      binanceGapMomentumOn: P.H_BINANCE_GAP_MOMENTUM_ON,
      binanceGapVelocityLookbackMs: P.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS,
      binanceGapVelocityMin: P.H_BINANCE_GAP_VELOCITY_MIN,
      binanceTrendOn: P.H_BINANCE_TREND_ON,
      binanceTrendLookbackSec: P.H_BINANCE_TREND_LOOKBACK_SEC,
      binanceTrendMinPct: P.H_BINANCE_TREND_MIN_PCT,
      binanceCountertrendLookbackSec: P.H_BINANCE_COUNTERTREND_LOOKBACK_SEC,
      binanceCountertrendMinPct: P.H_BINANCE_COUNTERTREND_MIN_PCT,
      binanceGapAgreeOn: P.H_BINANCE_GAP_AGREE_ON,
      hedgeOn: P.H_HEDGE_ON,
      hedgeRetainShares: P.H_HEDGE_RETAIN_SH,
      hedgeRetainMaxShares: P.H_HEDGE_RETAIN_MAX_SH,
      hedgeScoreMin: P.H_HEDGE_SCORE_MIN,
      hedgeMinPairEdge: P.H_HEDGE_MIN_PAIR_EDGE,
      reversalOn: P.H_REVERSAL_ON,
      reversalResidualShares: P.H_REVERSAL_RESIDUAL_SH,
      reversalConfirmMs: P.H_REVERSAL_CONFIRM_MS,
      reversalScoreMin: P.H_REVERSAL_SCORE_MIN,
      oppositeCandidateResetMs: P.H_OPPOSITE_CANDIDATE_RESET_MS,
      reversalMinPairEdge: P.H_REVERSAL_MIN_PAIR_EDGE,
      reversalMaxWorstLossUsd: P.H_REVERSAL_MAX_WORST_LOSS_USD,
      reversalMaxOrderShares: P.H_REVERSAL_MAX_ORDER_SH,
      priceMin: P.H_MIN_ASK,
      priceMax: P.H_MAX_ASK,
      capHeadroom: P.H_CAP_HEADROOM,
      liveOrderType: P.H_LIVE_ORDER_TYPE || config.liveTakerOrderType,
      limit: P.LIMIT,
      apiVer: config.backtestApiVersion,
      mode: config.executionMode,
    };
  }

  // Called every UI sample tick with the live best bid/ask of the CURRENT window.
  function tick({ slug, windowStart, openBinance,
    openChainlink, tInto, up, down, bzPrice, binanceAtMs, clPrice, nowMs }) {
    if (!isRunning()) return;   // bot is STOPPED → no strategy step (no shadow entries, no live orders)
    const w = getW(slug, windowStart, openBinance);
    if (w.settled || !up || !down) return;
    const P = mergedP;
    if (tInto >= config.windowSec) return;

    const dtMs = w.lastTickMs != null ? Math.max(1, nowMs - w.lastTickMs) : 120;
    w.lastTickMs = nowMs;
    w.lastAsk = { up: up.bestAsk, dn: down.bestAsk, tInto, bz: bzPrice, cl: clPrice, nowMs };   // latest book (for MANUAL buys)
    activeSlug = slug;

    // STRATEGY + FILL — FastMX returns entry, hedge, or reversal decisions.
    const bzGap = (bzPrice != null && w.openBinance != null) ? bzPrice - w.openBinance : null;   // for @-fill stamps + seed trigger
    const bzGapPct = (bzGap != null && w.openBinance) ? (bzGap / w.openBinance) * 100 : null;
    const clGap = (clPrice != null && openChainlink != null) ? clPrice - openChainlink : null;
    // FIRST driven tick of this window — snapshot the EXACT config (always, cheap once/window) so the persisted
    //   settle record is self-describing; also the verbose header for everything that follows.
    if (w.cfgAtOpen == null) {
      w.cfgAtOpen = cfgStamp();
      if (openChainlink != null) w.openChainlink = openChainlink;
      if (w.vDiag) w.vDiag.open = true;
      if (verboseOn) verbose("shadow.window_open", { slug, ws: w.windowStart, openBz: w.openBinance, openCl: openChainlink, ...w.cfgAtOpen });
    }
    // Capture the exact CLOB BBA and spot values used by the live simulation.
    // Both Up quotes are required to reconstruct the midpoint-velocity signal.
    if (config.recordLiveTicks) {
      const recTick = { t: +tInto.toFixed(2),
        ua: r2(up.bestAsk), ub: r2(up.bestBid), da: r2(down.bestAsk), db: r2(down.bestBid),
        cl: clPrice != null ? +clPrice.toFixed(2) : null,
        bz: bzPrice != null ? +bzPrice.toFixed(2) : null };
      const recTicks = w.recTicks = w.recTicks || [], previous = recTicks.at(-1);
      // The diagnostic series records values, not redundant depth-event
      // heartbeats. Preserve every transition plus a one-second coverage mark.
      if (!previous || previous.ua !== recTick.ua || previous.ub !== recTick.ub
        || previous.da !== recTick.da || previous.db !== recTick.db
        || previous.cl !== recTick.cl || previous.bz !== recTick.bz
        || recTick.t - previous.t >= 1) recTicks.push(recTick);
    }
    const clGapPct = (clGap != null && openChainlink) ? (clGap / openChainlink) * 100 : null;
    const got = curStrat.step(w, { t: tInto, up, down, bzPrice, clPrice, openBinance: w.openBinance,
      binanceAtMs,
      openChainlink, bzGap, bzGapPct, clGap, clGapPct }, P, dtMs, nowMs);
    // Per-tick cadence and gate diagnostics. Guarded so it has no hot-path cost
    // when verbose logging is disabled.
    if (verboseOn && w.vDiag) {
      w.vDiag.tickN++; w.vDiag.dtSum += dtMs; if (dtMs > w.vDiag.dtMax) w.vDiag.dtMax = dtMs;
      const gr = w.gateReason || "?"; w.vDiag.gate[gr] = (w.vDiag.gate[gr] || 0) + 1;
    }
    // notify the UI of any order PLACED this tick (distinct from a FILL) — for the "placed" toast
    for (const pl of (w.placedThisTick || [])) {
      try { onEvent({ kind: "shadow_placed", slug, windowStart: w.windowStart, tInto, order: pl }); } catch {}
    }
    // LATENCY: a real order fills ~LATENCY_MS after the decision, at the ask THEN. We DEFER the shadow's
    // display/PnL booking by LATENCY_MS and book it at the current (delayed) ask when due. This is now applied
    // in ALL modes — including real-live — because the REAL order is routed IMMEDIATELY (shadow_order below),
    // decoupled from this deferred display booking, so real orders are never delayed.
    const simLat = P.LATENCY_MS || 0;
    for (const rec of got) {
      rec.ts = nowMs;
      // stamp spot price + gap @ fill (price − window-open) so the property menu's "market @ fill" shows it
      if (bzPrice != null) { rec.bz = bzPrice; if (bzGap != null) { rec.bzGap = bzGap; rec.bzGapPct = w.openBinance ? (bzGap / w.openBinance) * 100 : null; } }
      if (clPrice != null) { rec.cl = clPrice; if (clGap != null) { rec.clGap = clGap; rec.clGapPct = openChainlink ? (clGap / openChainlink) * 100 : null; } }
      // Every distinct qualifying velocity snapshot can enter or adapt inventory.
      if (verboseOn && rec.leg !== "merge") {
        verbose("shadow.decision", { slug, t: +tInto.toFixed(3), leg: rec.leg, side: rec.side, reason: rec.reason,
          upBid: r2(up.bestBid), upAsk: r2(up.bestAsk), midpoint: rec.signal?.midpoint ?? null,
          priorMidpoint: rec.signal?.priorMidpoint ?? null, midVelocity: rec.signal?.midVelocity ?? null,
          binancePrice: rec.signal?.binancePrice ?? null,
          priorBinancePrice: rec.signal?.priorBinancePrice ?? null,
          binanceGapVelocity: rec.signal?.binanceGapVelocity ?? null,
          clobMidVelocityOn: rec.signal?.clobMidVelocityOn ?? null,
          binanceGapMomentumOn: rec.signal?.binanceGapMomentumOn ?? null,
          binanceGapAgreeOn: rec.signal?.binanceGapAgreeOn ?? null,
          binanceWindowOpen: rec.signal?.binanceWindowOpen ?? null,
          binanceWindowGap: rec.signal?.binanceWindowGap ?? null,
          binanceWindowGapDir: rec.signal?.binanceWindowGapDir ?? null,
          binanceTrendPct: rec.signal?.binanceTrendPct ?? null,
          binanceTrendDir: rec.signal?.binanceTrendDir ?? null,
          binanceStrongTrend: rec.signal?.binanceStrongTrend ?? null,
          binanceCountertrend: rec.signal?.binanceCountertrend ?? null,
          binanceCountertrendConfirmed: rec.signal?.binanceCountertrendConfirmed ?? null,
          binanceCountertrendMomentumPct: rec.signal?.binanceCountertrendMomentumPct ?? null,
          midLookbackMs: rec.signal?.midLookbackMs ?? null,
          binanceLookbackMs: rec.signal?.binanceLookbackMs ?? null,
          capDepth: rec.signal?.capDepth ?? null,
          budgetUsd: rec.budgetUsd ?? null, minimumShares: rec.minimumShares ?? rec.shares,
          decPx: r2(rec.effPx), dtMs: Math.round(dtMs) });
      }
      if (rec.leg === "merge") { applyMerge(w, rec); continue; }
      // route the REAL order NOW (at the decision) — index.js listens to shadow_order. Display/PnL booked below.
      if (rec.exec === "marketable") { try { onEvent({ kind: "shadow_order", slug, windowStart: w.windowStart, rec }); } catch {} }
      // ORDER STATUS — the strategy DECIDED to place this order (fires in sim AND live; live adds real stages downstream).
      if (rec.exec === "marketable" && rec.leg !== "merge") { try { onEvent({ kind: "order_status", stage: STAGES.DECIDED,
        key: `${w.windowStart}:${rec.oid}`, slug, ws: w.windowStart, oid: rec.oid, side: rec.side, leg: rec.leg,
        reason: rec.reason, tInto: rec.tInto, reqShares: rec.shares, decPx: rec.effPx,
        limitPx: rec.limitPx, budgetUsd: rec.budgetUsd ?? null,
        mode: (config.executionMode === "live" ? "live" : "sim"), simLatencyMs: (P.LATENCY_MS || 0), ts: nowMs }); } catch {} }
      if (simLat > 0 && rec.exec === "marketable") (w.pendingFills = w.pendingFills || []).push(
        { rec, dueMs: nowMs + simLat, dueTInto: rec.tInto + simLat / 1000, upA: up.bestAsk, dnA: down.bestAsk,
          upBook: up, dnBook: down, decPx0: rec.effPx });  // snapshot decision book + decision px, track fwd
      else bookFill(w, rec);
    }
    // resolve deferred fills now due → fill at the CURRENT (delayed) ask, capped at the order's limit.
    if (w.pendingFills && w.pendingFills.length) {
      const keep = [];
      for (const p of w.pendingFills) {
        if (nowMs >= p.dueMs) {
          const r = p.rec;
          // Fill EXACTLY at decision+LATENCY — do NOT wait for the next tick. Price against the book AS OF the
          //   deadline (p.upA/p.dnA = the last book ≤ deadline, tracked forward while pending), and stamp the fill
          //   time at the exact deadline (p.dueTInto). Matches the backview's fill-at-exactly-latency model.
          const upA = p.upA, dnA = p.dnA;
          const px0 = (r.side === "Up" ? upA : dnA);   // every leg is a BUY → fill at its own-side ask
          const fixedUsd = r.amountMode === "usd"
            || (r.budgetUsd != null && Number.isFinite(+r.budgetUsd));
          const requestedShares = r.minimumShares ?? r.shares;
          const requestedBudgetUsd = fixedUsd ? (+r.budgetUsd || +r.usdc || 0) : null;
          const arrivalBook = r.side === "Up" ? p.upBook : p.dnBook;
          const fill = fixedUsd
            ? walkVisibleBudget(arrivalBook, requestedBudgetUsd, r.limitPx)
            : walkVisibleAsks(arrivalBook, requestedShares, r.limitPx);
          r.decidedT = r.tInto; r.tInto = p.dueTInto;   // exact fill time = decision + latency (no tick-wait)
          r.placedT = r.decidedT;                       // SIM: placed (order-fire) time = the decision tick
          if (fill.shares > 0) {
            r.requestedShares = requestedShares;
            if (fixedUsd) r.requestedBudgetUsd = requestedBudgetUsd;
            r.shares = +fill.shares.toFixed(4); r.effPx = +fill.avgPx.toFixed(4); r.usdc = +fill.cost.toFixed(4);
            r.status = fixedUsd
              ? (fill.cost + 1e-9 < requestedBudgetUsd ? "partial" : "full")
              : (fill.shares + 1e-9 < r.requestedShares ? "partial" : "full");
            r.filledLate = true; r.ts = nowMs;
            if (bzPrice != null) { r.bz = bzPrice; if (bzGap != null) { r.bzGap = bzGap; r.bzGapPct = w.openBinance ? (bzGap / w.openBinance) * 100 : null; } } }
          // VERBOSE: distinguish an actual match from a FAK that reached the
          // future book after its cap had disappeared. Previously both paths
          // were labeled `shadow.fill`, which could corrupt forward-analysis
          // counts even though the ledger and order-status record were correct.
          if (verboseOn && fill.shares > 0) verbose("shadow.fill", { slug, leg: r.leg, side: r.side,
            decidedT: r2(r.decidedT), fillT: r2(r.tInto), decPx: r2(p.decPx0), fillPx: r2(r.effPx),
            shares: r2(r.shares), usdc: r2(r.usdc),
            slip: (p.decPx0 != null && r.effPx != null) ? r2(r.effPx - p.decPx0) : null, latencyMs: simLat });
          else if (verboseOn) verbose("shadow.no_fill", { slug, leg: r.leg, side: r.side,
            decidedT: r2(r.decidedT), arrivalT: r2(r.tInto), decPx: r2(p.decPx0), cap: r2(r.limitPx),
            arrivalAsk: r2(px0), reason: px0 == null ? "no-ask" : "outside-cap-or-no-depth", latencyMs: simLat });
          if (fill.shares > 0) bookFill(w, r);
          else {
            try { onEvent({ kind: "order_status", stage: STAGES.SKIPPED, key: `${w.windowStart}:${r.oid}`,
              slug, ws: w.windowStart, oid: r.oid, side: r.side, leg: r.leg,
              note: px0 == null ? "no ask at simulated match time" : `ask/depth outside cap ${r.limitPx}`,
              ts: nowMs }); } catch {}
          }
        } else { if (up.bestAsk != null) p.upA = up.bestAsk; if (down.bestAsk != null) p.dnA = down.bestAsk;
          p.upBook = up; p.dnBook = down; keep.push(p); }   // track full book fwd to the deadline
      }
      w.pendingFills = keep;
    }

    // broadcast a live snapshot (open order + aggregate position) — THROTTLED: now event-driven (one tick
    // per book update), an un-throttled broadcast would flood every browser with JSON. Always emit on a
    // fill (got.length) so the position is never stale; otherwise at most every ~200ms.
    if (got.length === 0 && nowMs - (w.lastLadderMs || 0) < 200) return;
    if (!uiActive()) return;   // UI-only snapshot — skip the payload build entirely when no browser is watching (headless/no-viewer). PnL/state already booked above.
    w.lastLadderMs = nowMs;
    const orders = (w.orders || []).map((o) => ({ oid: o.oid, side: o.side, limit: o.limit, leg: o.kind,
      budgetUsd: o.budgetUsd, filledUsd: +(o.filledUsd || 0).toFixed(2),
      placedT: o.placedT ?? null, expireS: o.expireS ?? null, ageS: 0 }));   // placedT/expireS → GTD countdown
    try {
      onEvent({ kind: "shadow_ladder", slug, windowStart: w.windowStart, tInto, orders, rounds: [], sealed: 0,
        pos: { upShares: +w.upShares.toFixed(1), downShares: +w.downShares.toFixed(1), cost: +w.cost.toFixed(2), fee: +w.fee.toFixed(4),
               merged: +(w.mergedRealized || 0).toFixed(2), mergedUsd: +(w.mergedUsd || 0).toFixed(2),
               ifUpWins: +(w.upShares - w.cost - w.fee).toFixed(2), ifDownWins: +(w.downShares - w.cost - w.fee).toFixed(2),
               roundUp: null, roundDn: null, roundAvgUp: null, roundAvgDn: null, roundIfUp: null, roundIfDn: null } });
    } catch {}
  }

  // Record a REAL on-chain fill (from a live order's response) into a parallel "real" ledger for the window —
  // real shares (takingAmount) + real USDC spent (makingAmount). This is the HONEST cost, used to report the
  // actual on-chain PnL alongside the (optimistic) modeled shadow PnL. Real fee estimated on the real fill price.
  function recordRealFill(slug, windowStart, { side, shares, spent, price, leg, oid, latencyMs, tInto }) {
    const w = windows.get(slug); if (!w) return;
    const sh = +shares || 0, usd = +spent || 0; if (!(sh > 0)) return;
    const px = price != null ? price : (sh ? usd / sh : null);
    // ACTUAL fill time (window-relative s): recordRealFill runs when the fill is booked — synchronously for a
    //   marketable match, or at the reconcile-poll moment for a resting order that fills LATE. So this is the real
    //   fill x-position (vs `tInto` = the decision time). The chart plots the solid circle here in live mode.
    const fillTInto = +((Date.now() / 1000) - windowStart).toFixed(2);
    const fee = fillFee(px, sh, true, mergedP);
    w.realUp = w.realUp || 0; w.realDn = w.realDn || 0; w.realCost = w.realCost || 0; w.realFee = w.realFee || 0; w.realFills = w.realFills || 0;
    if (side === "Up") w.realUp += sh; else w.realDn += sh;   // every active leg is an entry BUY
    w.realCost += usd; w.realFee += fee; w.realFills += 1;
    // REAL-FILL-DRIVEN STATE (live): advance the ENGINE's positions on this REAL fill (entry → open; hedge →
    //   settle + drop) so decisions run on reality, not the modeled fill. No-op unless the strategy's LIVE_FILLS is on.
    if (config.executionMode === "live") { try { curStrat.injectRealFill?.(w, { leg: leg || "entry", side, shares: sh, px, oid }); } catch {} }
    try {
      onEvent({ kind: "shadow_real", slug, windowStart: w.windowStart,
        // the REAL fill (to stamp onto the modeled fill with matching oid — property menu shows modeled→real)
        fill: { oid: oid ?? null, side, shares: sh, spent: +usd.toFixed(4), price: px != null ? +px.toFixed(4) : null, fee: +fee.toFixed(4), leg: leg || null, tInto: tInto != null ? +tInto : null, fillTInto: (fillTInto >= 0 && fillTInto < 600) ? fillTInto : (tInto != null ? +tInto : null), latencyMs: latencyMs != null ? Math.round(latencyMs) : null },
        // the running REAL position (cards / if-up/if-down use this in live mode)
        pos: { upShares: w.realUp, downShares: w.realDn, cost: +w.realCost.toFixed(2), fee: +w.realFee.toFixed(4), nFills: w.realFills,
               ifUpWins: +(w.realUp - w.realCost - w.realFee).toFixed(2), ifDownWins: +(w.realDn - w.realCost - w.realFee).toFixed(2) } });
    } catch {}
  }

  // A live order will NOT fill (real cancel / reject / expire from the status poll) → clear the engine's pending
  //   guard so it can retry. Called by index.js when the order-status track reports a terminal-no-fill state.
  function cancelLivePending(slug, oid) { const w = windows.get(slug); if (w) curStrat.clearLivePending?.(w, oid); }

  // Called when the tracker settles a window (winSide known + bot summary available).
  function settle(slug, winSide, botSummary) {
    const w = windows.get(slug);
    if (!w || w.settled) return null;
    // flush any still-deferred (latency) fills at their last price so they're counted in settlement
    if (w.pendingFills && w.pendingFills.length) { for (const p of w.pendingFills) bookFill(w, p.rec); w.pendingFills = []; }
    w.winSide = winSide;
    w.settled = true;
    const winSh = winSide === "Up" ? w.upShares : w.downShares;
    const pnl = winSh - w.cost - w.fee + (w.mergedRealized || 0);   // taker fee included; + banked merges (PnL-neutral)
    // Window summary: PnL, config, decision-gate histogram, and feed cadence.
    if (verboseOn && w.vDiag) {
      const d = w.vDiag;
      verbose("shadow.settle", { slug, winSide, pnl: r2(pnl), nFills: w.fills.length,
        ticks: d.tickN, recordedTicks: w.recTicks?.length || 0,
        dtMeanMs: d.tickN ? Math.round(d.dtSum / d.tickN) : null, dtMaxMs: Math.round(d.dtMax),
        gate: d.gate, cfg: w.cfgAtOpen || cfgStamp() });
    }
    // PERSIST the live-tick series → data/live-ticks/<slug>.json (the ground-truth LIVE feed the sim decided on).
    //   Enables a definitive live-vs-v2 tick-by-tick diff. Fire-and-forget; keep only the most-recent N windows.
    if (config.recordLiveTicks && w.recTicks && w.recTicks.length) {
      try {
        const dir = path.join(config.dataDir, "live-ticks");
        fs.mkdirSync(dir, { recursive: true });
        const payload = { slug, ws: w.windowStart, winSide, cfg: w.cfgAtOpen || cfgStamp(),
          openBz: w.openBinance,
          openCl: w.openChainlink ?? null, ticks: w.recTicks };
        fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(payload), () => {});
        fs.readdir(dir, (e, files) => { if (e) return;
          const epoch = (f) => +(f.replace(".json", "").split("-").pop()) || 0;   // sort by WINDOW EPOCH → correct across markets (btc/eth/…), not filename alpha
          const js = files.filter((f) => f.endsWith(".json")).sort((a, b) => epoch(a) - epoch(b));
          const keep = config.recordLiveTicksKeep || 50;
          for (const f of js.slice(0, Math.max(0, js.length - keep))) fs.unlink(path.join(dir, f), () => {});
        });
      } catch {}
    }
    // Settled windows never tick or trade again, and the diagnostic payload was
    // serialized above. Release high-cadence buffers now instead of retaining
    // them for the 30-minute UI/settlement grace period.
    w.recTicks = null;
    w.pendingFills = [];
    w.lastAsk = null;
    if (w.helpme) {
      w.helpme.history = [];
      w.helpme.historyHead = 0;
      w.helpme.binanceHistory = [];
      w.helpme.binanceHistoryHead = 0;
      w.helpme.cells?.clear?.();
      w.helpme.execSide?.clear?.();
    }
    const ab = {
      slug, windowStart: w.windowStart, winSide, status: "resolved", ts: Math.floor(Date.now() / 1000),
      sim: { pnl: r2(pnl), winSh: r2(winSh), upShares: r2(w.upShares), downShares: r2(w.downShares),
             net: w.upShares > w.downShares ? "Up" : "Down", cost: r2(w.cost), fee: r2(w.fee),
             merged: r2(w.mergedRealized || 0), nFills: w.fills.length, cfg: w.cfgAtOpen || cfgStamp() },
      bot: botSummary ? {
        pnl: botSummary.realizedPnl, upShares: botSummary.upShares, downShares: botSummary.downShares,
        net: botSummary.netShares > 0 ? "Up" : "Down", cost: botSummary.totalCost, nFills: botSummary.nTrades,
      } : null,
    };
    // REAL on-chain PnL (from actual fills) — the HONEST number; null when no real fills (simulation).
    if (w.realFills > 0) {
      const winShR = winSide === "Up" ? (w.realUp || 0) : (w.realDn || 0);
      ab.real = { pnl: r2(winShR - (w.realCost || 0) - (w.realFee || 0)), winSh: r2(winShR),
                  upShares: r2(w.realUp || 0), downShares: r2(w.realDn || 0),
                  cost: r2(w.realCost || 0), fee: r2(w.realFee || 0), nFills: w.realFills };
    }
    ab.netMatch = ab.bot ? ab.sim.net === ab.bot.net : null;
    ab.pnlErr = ab.bot && ab.bot.pnl != null ? r2(Math.abs(ab.sim.pnl - ab.bot.pnl)) : null;
    recordSession(ab);   // → MongoDB shadow_sessions_<mode>
    try { onEvent({ kind: "shadow_resolved", slug, ab }); } catch {}
    // SESSION CIRCUIT-BREAKER: accumulate the session's realized PnL (REAL in live, else sim) and, if it breaches
    //   the configured max loss, emit `circuit_breaker` ONCE (index.js halts the bot). Re-arms via resetBreaker().
    // A stopped engine can leave unresolved windows in memory. Starting a new
    // session resets the breaker, after which lifecycle may settle one of those
    // old windows. Count only windows created in this Start generation; otherwise
    // the stale settlement immediately halts the freshly re-armed session.
    circuitBreaker.record(w.breakerGeneration, ab.real ? ab.real.pnl : ab.sim.pnl);
    return ab;
  }

  // Record a just-CLOSED window as "pending" (before Polymarket resolves) so history shows it immediately with a
  // pending icon. Upserted by windowStart → settle() later overwrites it with the resolved winner/PnL. Only
  // windows we actually traded; recorded once (w.pendingRecorded). Flushes any still-deferred latency fills first.
  function recordPending(slug) {
    const w = windows.get(slug);
    if (!w || w.settled || w.pendingRecorded) return;
    // Record EVERY closed window as pending — including 0-fill windows — so the history shows a ⏳ pending row
    // the instant a window ends, then flips to the winner on settle (mirrors settle(), which records all windows).
    if (w.pendingFills && w.pendingFills.length) { for (const p of w.pendingFills) bookFill(w, p.rec); w.pendingFills = []; }
    w.pendingRecorded = true;
    const ab = {
      slug, windowStart: w.windowStart, winSide: null, status: "pending", ts: Math.floor(Date.now() / 1000),
      sim: { pnl: null, upShares: r2(w.upShares), downShares: r2(w.downShares),
             net: w.upShares > w.downShares ? "Up" : "Down", cost: r2(w.cost), fee: r2(w.fee),
             merged: r2(w.mergedRealized || 0), nFills: w.fills.length,
             cfg: w.cfgAtOpen || cfgStamp() },
      bot: null,
    };
    if (w.realFills > 0) ab.real = { pnl: null, upShares: r2(w.realUp || 0), downShares: r2(w.realDn || 0),
                                     cost: r2(w.realCost || 0), fee: r2(w.realFee || 0), nFills: w.realFills };
    recordSession(ab);
    try { onEvent({ kind: "shadow_pending", slug, ab }); } catch {}
  }

  function prune(nowSec) {
    for (const [slug, w] of windows) {
      const endedAgo = nowSec - (w.windowStart + config.windowSec);
      // settled windows: keep 30min (history/redeem view). UNSETTLED (Polymarket resolution stalled/failing):
      // still drop after 2h so a window that never resolves can't leak its tick/calib history forever.
      if ((w.settled && endedAgo > 1800) || endedAgo > 7200) windows.delete(slug);
    }
  }

  function setParams(obj) { if (obj && typeof obj === "object") {
    const allowed = new Set(Object.keys(curStrat.STRAT));
    const clean = Object.fromEntries(Object.entries(obj).filter(([key]) => allowed.has(key)));
    const nextLiveParams = { ...liveParams, ...clean, STRATEGY: DEFAULT_STRATEGY };
    const nextStrat = getStrategy(DEFAULT_STRATEGY);
    const nextMerged = { ...nextStrat.STRAT, ...nextLiveParams,
      STRATEGY: DEFAULT_STRATEGY, LIVE_FILLS: false };
    nextStrat.validateParams?.(nextMerged);
    liveParams = nextLiveParams;
    curStrat = nextStrat;
    mergedP = nextMerged;
  } }
  function getParams() { return { ...curStrat.STRAT, ...liveParams }; }
  // Circuit-breaker controls: reset re-arms it on Start.
  function resetBreaker() { circuitBreaker.reset(); }
  function breakerState() { const { sessionRealized, tripped, limit } = circuitBreaker.state(); return { sessionRealized, tripped, limit }; }

  // MANUAL buy (SIM): book a taker fill into the CURRENT live window at the latest ask (≤ limit) — flows through
  //   bookFill exactly like a strategy fill, so it draws a circle, updates the position/PnL, and lands in live
  //   history. Tagged manual:true → the property menu badges it. This is a user-directed leg ALONGSIDE the
  //   strategy's own position; it's counted in the window's settlement like any other buy.
  function manualBuy({ side, shares, limit }) {
    const sh = Math.max(0, +shares || 0);
    const lim = Math.max(0.01, Math.min(0.99, +limit || 0.99));
    if (!(sh > 0)) return { error: "size must be > 0" };
    if (!isRunning()) return { error: "bot is stopped — press Start" };
    const w = activeSlug ? windows.get(activeSlug) : null;
    if (!w || w.settled) return { error: "no active window yet — wait for a live window" };
    if (!w.lastAsk) return { error: "no book yet — wait a moment" };
    if (Date.now() / 1000 - w.windowStart >= config.windowSec) return { error: "window is closing — wait for the next window" };   // rollover guard
    const S = side === "Down" ? "Down" : "Up";
    const ask = S === "Up" ? w.lastAsk.up : w.lastAsk.dn;
    if (ask == null) return { error: `no ${S} ask on the book` };
    if (ask > lim) return { error: `${S} ask ${ask.toFixed(2)} > limit ${lim.toFixed(2)} — GTC would rest, no fill` };
    const px = Math.min(ask, lim), t = w.lastAsk.tInto;
    const rec = { tInto: t, decidedT: t, placedT: t, side: S, shares: sh, effPx: +px.toFixed(4), usdc: +(px * sh).toFixed(4),
      exec: "marketable", kind: "taker", leg: "entry", reason: "manual", manual: true, status: "full", limitPx: lim, oid: ++w.seq, ts: w.lastAsk.nowMs };
    if (w.lastAsk.bz != null) { rec.bz = w.lastAsk.bz; if (w.openBinance != null) { rec.bzGap = w.lastAsk.bz - w.openBinance; rec.bzGapPct = w.openBinance ? (rec.bzGap / w.openBinance) * 100 : null; } }
    if (w.lastAsk.cl != null) rec.cl = w.lastAsk.cl;
    const simLat = mergedP.LATENCY_MS || 0;
    if (simLat > 0) {   // fill at decision+LATENCY_MS, tracked forward — SAME latency model as strategy fills (property-menu latency row)
      (w.pendingFills = w.pendingFills || []).push({ rec, dueMs: w.lastAsk.nowMs + simLat, dueTInto: t + simLat / 1000, upA: w.lastAsk.up, dnA: w.lastAsk.dn, decPx0: rec.effPx });
      return { ok: true, manual: true, pending: true, side: S, shares: sh, decidedT: +t.toFixed(2), latencyMs: simLat, slug: w.slug };
    }
    bookFill(w, rec);   // latency 0 → book immediately
    return { ok: true, manual: true, side: S, shares: sh, px: +px.toFixed(4), tInto: +t.toFixed(2), slug: w.slug };
  }

  // Draw a circle for a LIVE manual fill: emit a DISPLAY-ONLY shadow_buy (using the REAL position) so the chart marks
  //   the manual buy. The real ledger is updated separately by recordRealFill — this ONLY draws the marker
  //   (no sim-ledger mutation, so the strategy A/B sim is untouched).
  function emitManualFill(slug, rec) {
    const w = windows.get(slug); if (!w || !rec) return;
    const ru = +(w.realUp || 0), rd = +(w.realDn || 0), rc = +(w.realCost || 0), rf = +(w.realFee || 0);
    try {
      onEvent({ kind: "shadow_buy", slug, windowStart: w.windowStart, rec,
        pos: { upShares: ru, downShares: rd, cost: +rc.toFixed(2), fee: +rf.toFixed(4),
               ifUpWins: +(ru - rc - rf).toFixed(2), ifDownWins: +(rd - rc - rf).toFixed(2) } });
    } catch {}
  }

  // Live Helpme decision status for the dashboard header.
  function liveStatus() {
    const w = activeSlug ? windows.get(activeSlug) : null;
    if (!w || w.settled) return null;
    if (w.helpmeStatus) return { strategy: DEFAULT_STRATEGY, ...w.helpmeStatus };
    return { strategy: DEFAULT_STRATEGY, gate: w.gateReason || null };
  }
  return { tick, settle, prune, recordPending, hydrateWindow, windows, setParams, getParams,
    recordRealFill, cancelLivePending, resetBreaker, breakerState,
    manualBuy, emitManualFill, liveStatus };
}

const r2 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
