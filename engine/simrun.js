// Backtest one window by replaying the registered wallet3048 strategy tick by tick.
// Pure ESM.
import { fillFee, isFeeFill } from "./fees.js";
import { getStrategy } from "./strategies/index.js";
import { makerTouchFill, walkVisibleAsks, walkVisibleBudget } from "./fillsim.js";

// NOTE (browser-safe): this module is dynamically imported by the dashboard and
// must not import Node-only modules.

const REF_MS = 120;   // reference tick for fill-speed normalization (matches strategy.js)
// STALE GUARD: live never trades on a stale book (src/index.js gates on config.tradeFreshMs). The replay
// must match — when the recorded feed has a gap > STALE_GAP_MS the book was stale, so we DON'T feed that
// just-reconnected tick as a trade opportunity (it would otherwise spawn a spurious huge-dt fill / a fake
// velocity spike across the gap). Default 6s = config.tradeFreshMs default. Override via P.STALE_GAP_MS.
const STALE_GAP_MS = 6000;

/**
 * Replay one window through the same wallet3048 step function used by the live simulation.
 * @param {{ticks:Array<{t,upAsk,upBid,dnAsk,dnBid,bz?}>, openBinance:number}} d
 * @param {object} [params] UI overrides merged over the wallet3048 defaults
 */
// Down-sample ticks to a grid at `ms`. `mode`:
//   "last" (DEFAULT) — keep the LAST tick per bucket. Mirrors the live periodic sampler ("read latest state every N ms"),
//                      so live↔backtest stay in parity. Proven best live-$ in the 33-window gap study (2026-07-19).
//   "tmean"/"mean"   — flicker-ROBUST: replace each bucket's ask with a trimmed-mean (drops the bucket hi+lo, then means)
//                      or plain mean, stamped at the bucket's LAST tick time so NO extra latency is added. Cuts per-window
//                      scatter ~3-12% vs keep-last but is PnL-neutral (within noise). Only use when the LIVE sampler
//                      aggregates the same way — otherwise this reopens the live/backtest gap. Robust to 1-tick book spikes.
export function simulateFills(d, params) {
  const ticks = (d && d.ticks) || [];
  if (ticks.length < 2) return [];
  const strat = getStrategy((params || {}).STRATEGY);
  const P = { ...strat.STRAT, ...(params || {}) };
  const staleMs = P.STALE_GAP_MS > 0 ? P.STALE_GAP_MS : STALE_GAP_MS;
  const openBz = d && d.openBinance != null ? d.openBinance : null;
  const openCl = d && d.openPrice != null ? d.openPrice : null;
  const bk = ticks.filter((tk) => tk.upAsk != null && tk.dnAsk != null);   // per-tick replay (native cadence)
  if (bk.length < 2) return [];
  const state = {};               // fresh causal strategy state
  const fills = [];
  // UTC hour-of-day of this window's start — for the strategy's HOUR GATE (V_HOURS). Same value all window.
  const winHour = (d && d.windowStart != null) ? Math.floor((d.windowStart % 86400) / 3600) : null;
  const winDay = (d && d.windowStart != null) ? new Date(d.windowStart * 1000).getUTCDay() : null;   // UTC weekday → WEEKDAY GATE (V_DAYS)
  // LATENCY model: resolve each intent against the complete book AS OF decision+LATENCY_MS. Keep it pending until
  // that causal clock is reached, then feed the actual (possibly partial) match into inventory before the next decision.
  const latSec = (P.LATENCY_MS || 0) / 1000;
  const arrivalIndex = new Array(bk.length);
  let aj = 0;
  for (let i = 0; i < bk.length; i++) {
    if (aj < i) aj = i;
    const due = bk[i].t + latSec;
    while (aj < bk.length - 1 && bk[aj].t < due) aj++;
    arrivalIndex[i] = bk[aj].t <= due ? aj : Math.max(i, aj - 1);
  }
  const pending = [];
  state.pendingFills = pending;

  const levels = (rows, asc) => (Array.isArray(rows) ? rows : []).map((x) => [
    Number(Array.isArray(x) ? x[0] : x?.price), Number(Array.isArray(x) ? x[1] : x?.size),
  ]).filter(([px, size]) => Number.isFinite(px) && Number.isFinite(size) && size > 0)
    .sort((a, b) => asc ? a[0] - b[0] : b[0] - a[0]);
  const bookAt = (tk, side) => {
    const nested = side === "Up" ? tk.up : tk.down;
    const asks = levels(nested?.asks, true), bids = levels(nested?.bids, false);
    const bestAsk = side === "Up" ? tk.upAsk : tk.dnAsk;
    const bidField = side === "Up" ? tk.upBid : tk.dnBid;
    return { bestAsk: nested?.bestAsk ?? bestAsk ?? asks[0]?.[0] ?? null,
      bestBid: nested?.bestBid ?? bidField ?? bids[0]?.[0] ?? null,
      asks, bids, depthKnown: asks.length > 0 && bids.length > 0 };
  };
  const strategyTickAt = (tk) => {
    const up = bookAt(tk, "Up"), down = bookAt(tk, "Down");
    const bz = tk.bz != null ? tk.bz : null, cl = tk.cl != null ? tk.cl : null;
    const bzGap = (bz != null && openBz != null) ? bz - openBz : null;
    const clGap = (cl != null && openCl != null) ? cl - openCl : null;
    return { t: tk.t, up, down, bzPrice: bz, clPrice: cl,
      binanceAtMs: tk.binanceAtMs ?? tk.bzAtMs ?? tk.ms ?? null,
      openBinance: openBz, openChainlink: openCl,
      bzGap, bzGapPct: (bzGap != null && openBz) ? bzGap / openBz * 100 : null,
      clGap, clGapPct: (clGap != null && openCl) ? clGap / openCl * 100 : null,
      winHour, winDay };
  };
  const applyInventory = (f) => {
    state.upShares = +state.upShares || 0; state.downShares = +state.downShares || 0;
    state.upCost = +state.upCost || 0; state.downCost = +state.downCost || 0; state.cost = +state.cost || 0;
    if (f.side === "Up") { state.upShares += f.shares; state.upCost += f.usdc; }
    else { state.downShares += f.shares; state.downCost += f.usdc; }
    state.cost += f.usdc;
    (state.fills = state.fills || []).push(f);
  };
  const emitMatch = (p, match, fillT, maker = false) => {
      const f = p.hasFill ? { ...p.template, signal: p.template.signal ? { ...p.template.signal } : undefined } : p.rec;
      const requested = p.remainingBefore ?? p.requestedShares;
      f.decidedT = p.decisionT;
      f.placedT = p.decisionT;
      f.tInto = fillT;
      f.requestedShares = requested;
      f.shares = +match.shares.toFixed(4);
      f.effPx = +match.avgPx.toFixed(4);
      f.usdc = +match.cost.toFixed(4);
      f.status = match.shares + 1e-9 < requested ? "partial" : "full";
      f.filledLate = fillT > p.decisionT + 1e-9;
      if (maker) { f.maker = true; f.taker = false; f.exec = "resting"; f.kind = "maker"; }
      applyInventory(f);
      fills.push(f);
      p.hasFill = true;
      return f;
  };
  const flushMakerAccrual = (p, fallbackT) => {
    if (!(p.makerShares > 1e-9)) return null;
    const shares = p.makerShares;
    const cost = p.makerCost;
    p.remainingBefore = p.makerStartRemaining;
    const out = emitMatch(p, { shares, cost, avgPx: cost / shares }, p.makerLastT ?? fallbackT, true);
    p.makerShares = 0;
    p.makerCost = 0;
    return out;
  };
  const resolveDue = (throughT, currentTick = null) => {
    const keep = [];
    for (const p of pending) {
      if (p.phase === "resting") {
        if (!currentTick || throughT > p.expiresT + 1e-9 || !(p.remaining > 1e-9)) {
          flushMakerAccrual(p, Math.min(throughT, p.expiresT));
          continue;
        }
        const cancel = strat.shouldCancelResting?.(state, p.rec,
          strategyTickAt(currentTick), P, currentTick.t * 1000);
        if (cancel?.cancel) {
          p.rec.cancelReason = cancel.reason;
          p.rec.cancelCap = cancel.currentCap ?? null;
          flushMakerAccrual(p, throughT);
          continue;
        }
        const atBook = bookAt(currentTick, p.rec.side);
        const dtMs = Math.max(0, (throughT - p.lastT) * 1000);
        p.lastT = throughT;
        let match = null;
        if (atBook.bestAsk != null && atBook.bestAsk < p.rec.limitPx - 1e-9) {
          const crossed = walkVisibleAsks(atBook, p.remaining, p.rec.limitPx, { allowBbaFallback: false });
          // The order was already resting. A later sell that crosses it trades
          // at the resting maker's price, not at a newly observed lower ask.
          if (crossed.shares > 1e-9) match = { shares: crossed.shares,
            cost: crossed.shares * p.rec.limitPx, avgPx: p.rec.limitPx };
        } else if (atBook.bestBid != null && p.rec.limitPx >= atBook.bestBid - 1e-9) {
          // A resting buy is filled by sell flow at the bid. The historical L2
          // feed has no order IDs/trades, so accrue a conservative queue credit
          // only while this rung is at or better than the public best bid.
          const cumulative = makerTouchFill({ askNow: p.rec.limitPx, limit: p.rec.limitPx,
            filled: p.touchFilled, target: p.touchTarget, dtMs,
            touchMs: Number(P.W3048_SIM_TOUCH_MS || 1000),
            fillPct: Number(P.W3048_SIM_TOUCH_FILL_PCT || 10) });
          const delta = Math.max(0, cumulative - p.touchFilled);
          p.touchFilled = cumulative;
          if (delta > 1e-9) match = { shares: Math.min(delta, p.remaining),
            cost: Math.min(delta, p.remaining) * p.rec.limitPx, avgPx: p.rec.limitPx };
        }
        if (match?.shares > 1e-9) {
          p.makerShares = (p.makerShares || 0) + match.shares;
          p.makerCost = (p.makerCost || 0) + match.cost;
          p.makerLastT = throughT;
          p.remaining -= match.shares;
        }
        if (p.remaining > 1e-9) keep.push(p);
        else flushMakerAccrual(p, throughT);
        continue;
      }
      if (p.dueT > throughT + 1e-9) { keep.push(p); continue; }
      const f = p.rec, at = p.arrivalTick;
      const arrivalBook = bookAt(at, f.side);
      const fixedUsd = f.amountMode === "usd"
        || (f.budgetUsd != null && Number.isFinite(+f.budgetUsd));
      const requestedShares = f.minimumShares ?? f.shares;
      const requestedBudgetUsd = fixedUsd ? (+f.budgetUsd || +f.usdc || 0) : null;
      const match = fixedUsd
        ? walkVisibleBudget(arrivalBook, requestedBudgetUsd, f.limitPx, { allowBbaFallback: false })
        : walkVisibleAsks(arrivalBook, requestedShares, f.limitPx, { allowBbaFallback: false });
      p.requestedShares = requestedShares;
      p.decisionT = f.tInto;
      p.template = { ...f, signal: f.signal ? { ...f.signal } : undefined };
      if (fixedUsd) f.requestedBudgetUsd = requestedBudgetUsd;
      if (match.shares > 0) {
        const out = emitMatch(p, match, p.dueT, false);
        out.status = fixedUsd
          ? (match.cost + 1e-9 < requestedBudgetUsd ? "partial" : "full")
          : (match.shares + 1e-9 < requestedShares ? "partial" : "full");
        if (at.bz != null) {
          out.bz = at.bz;
          if (openBz != null) { out.bzGap = at.bz - openBz; out.bzGapPct = openBz ? (out.bzGap / openBz) * 100 : null; }
        }
        if (at.cl != null) out.cl = at.cl;
      }
      const shareRemainder = fixedUsd ? 0 : Math.max(0, requestedShares - match.shares);
      if (String(f.orderType || "").toUpperCase() === "GTC" && shareRemainder > 1e-9 && currentTick) {
        p.phase = "resting";
        p.remaining = shareRemainder;
        p.touchTarget = shareRemainder;
        p.touchFilled = 0;
        p.makerStartRemaining = shareRemainder;
        p.makerShares = 0;
        p.makerCost = 0;
        p.lastT = p.dueT;
        p.expiresT = p.dueT + Math.max(0, Number(f.restTimeoutMs || P.W3048_REST_TIMEOUT_MS || 0)) / 1000;
        keep.push(p);
      }
    }
    pending.splice(0, pending.length, ...keep);
  };
  let prevT = null;
  for (let i = 0; i < bk.length; i++) {
    const tk = bk[i];
    resolveDue(tk.t, tk);
    const gapMs = prevT != null ? (tk.t - prevT) * 1000 : 0;
    prevT = tk.t;
    // STALE: a gap > staleMs means the book was stale through it. Live would not trade on the
    // just-reconnected tick → skip it (prevT is already advanced, so only this one tick is skipped).
    if (gapMs > staleMs) continue;
    const dtMs = gapMs > 0 ? Math.max(1, gapMs) : REF_MS;
    // The strategy derives its deterministic clock from window time.
    const got = strat.step(state, strategyTickAt(tk), P, dtMs, tk.t * 1000);
    for (const f of got) {
      const ai = arrivalIndex[i];
      pending.push({ rec: f, dueT: tk.t + latSec, arrivalTick: bk[ai] });
    }
    resolveDue(tk.t, tk);   // latency=0 intents match on the decision frame
  }
  resolveDue(Infinity);
  return fills.sort((a, b) => a.tInto - b.tInto);
}


/** Settlement position/PnL from a set of fills, given the winning side. Taker fills pay the modeled fee. */
export function positionFromFills(fills, winSide, ticks) {
  // MERGE records (leg:"merge") reclaim complete sets: they REMOVE `sets` from BOTH sides and return
  // `reclaimUsd` cash (reducing net cost). PnL-neutral vs holding to settlement; see strategy.maybeMerge.
  // Every non-merge leg is a BUY (entry + hedge; sell-to-close removed) → all add shares to their side.
  const opens = fills.filter((f) => f.leg !== "merge");
  const merges = fills.filter((f) => f.leg === "merge");
  // MERGE mirrors shadow.applyMerge EXACTLY (live == backtest): remove `sets` from BOTH sides, remove the
  //   merged shares' ACTUAL cost/fee (mainCost/mainFee) — NOT the $1/set reclaim — and BANK the guaranteed
  //   profit into `merged`. So if-up/if-down DECREASE by the banked amount (the profit moves to the Merged
  //   card); the window total = merged + the remaining position's settlement.
  const mergedSets = merges.reduce((t, f) => t + (+f.sets || 0), 0);
  const mergedUpCost = merges.reduce((t, f) => t + (+f.mainUpCost || 0), 0);
  const mergedDnCost = merges.reduce((t, f) => t + (+f.mainDnCost || 0), 0);
  const mergedFee = merges.reduce((t, f) => t + (+f.mainFee || 0), 0);
  const merged = merges.reduce((t, f) => t + (+f.realized || 0), 0);   // profit BANKED via merges (Merged card)
  const shOf = (arr, s) => arr.filter((f) => f.side === s).reduce((t, f) => t + f.shares, 0);
  const usdOf = (arr, s) => arr.filter((f) => f.side === s).reduce((t, f) => t + f.usdc, 0);
  const up = shOf(opens, "Up") - mergedSets, dn = shOf(opens, "Down") - mergedSets;
  const upC = usdOf(opens, "Up") - mergedUpCost;   // merged shares' cost leaves the live position
  const dnC = usdOf(opens, "Down") - mergedDnCost;
  const total = upC + dnC;
  const fee = opens.reduce((t, f) => t + fillFee(f.effPx ?? (f.shares ? f.usdc / f.shares : null), f.shares, isFeeFill(f)), 0) - mergedFee;
  const ifUp = up - total - fee, ifDn = dn - total - fee;   // REMAINING (un-merged) position — decreased by each merge
  const realized = winSide ? merged + (winSide === "Up" ? ifUp : ifDn) : null;   // total = banked + remaining settlement
  return {
    upShares: up, downShares: dn, totalCost: total, fee, merged,
    ifUpWins: ifUp, ifDownWins: ifDn,
    upLegPnl: winSide === "Up" ? up - upC : -upC,
    downLegPnl: winSide === "Down" ? dn - dnC : -dnC,
    realizedPnl: realized,
  };
}
