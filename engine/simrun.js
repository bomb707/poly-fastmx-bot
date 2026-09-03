// Backtest one window by replaying the registered Helpme strategy tick by tick.
// Pure ESM.
import { fillFee, isFeeFill } from "./fees.js";
import { getStrategy } from "./strategies/index.js";
import { makerTouchFill, stampLatencyDisplay, walkVisibleAsks, walkVisibleBudget } from "./fillsim.js";

// NOTE (browser-safe): this module is dynamically imported by the dashboard and
// must not import Node-only modules.

const REF_MS = 120;   // reference tick for fill-speed normalization (matches strategy.js)
// STALE GUARD: live never trades on a stale book (src/index.js gates on config.tradeFreshMs). The replay
// must match — when the recorded feed has a gap > STALE_GAP_MS the book was stale, so we DON'T feed that
// just-reconnected tick as a trade opportunity (it would otherwise spawn a spurious huge-dt fill / a fake
// velocity spike across the gap). Default 6s = config.tradeFreshMs default. Override via P.STALE_GAP_MS.
const STALE_GAP_MS = 6000;

/**
 * Replay one window through the same Helpme step function used by the live simulation.
 * @param {{ticks:Array<{t,upAsk,upBid,dnAsk,dnBid,bz?}>, openBinance:number}} d
 * @param {object} [params] UI overrides merged over the Helpme defaults
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
  const applyInventory = (f) => {
    state.upShares = +state.upShares || 0; state.downShares = +state.downShares || 0;
    state.upCost = +state.upCost || 0; state.downCost = +state.downCost || 0;
    state.cost = +state.cost || 0; state.fee = +state.fee || 0;
    if (f.side === "Up") { state.upShares += f.shares; state.upCost += f.usdc; }
    else { state.downShares += f.shares; state.downCost += f.usdc; }
    state.cost += f.usdc;
    // The strategy's risk projection includes state.fee. Keep replay state in
    // parity with shadow/live after each resolved fill so a completed taker
    // fee cannot disappear from the next order's worst-settlement-loss check.
    state.fee += fillFee(f.effPx ?? (f.shares ? f.usdc / f.shares : null),
      f.shares, isFeeFill(f));
    (state.fills = state.fills || []).push(f);
  };
  const resolveMakers = (tk, dtMs) => {
    if (!Array.isArray(state.restingMakers) || !state.restingMakers.length) return;
    const keep = [];
    for (const pendingMaker of state.restingMakers) {
      const rec = pendingMaker?.rec;
      if (!rec) continue;
      if (rec.expireT != null && tk.t > rec.expireT + 1e-9) continue;
      const ask = bookAt(tk, rec.side).bestAsk;
      if (!pendingMaker.activated) {
        if (tk.t + 1e-9 < (+pendingMaker.activeAfterT || rec.tInto)) {
          keep.push(pendingMaker); continue;
        }
        // If the limit is already marketable when it reaches the venue, a
        // post-only order is rejected rather than retrospectively filled.
        if (ask == null || ask <= rec.limitPx + 1e-9) continue;
        pendingMaker.activated = true;
        keep.push(pendingMaker); continue;
      }
      const previous = +pendingMaker.filled || 0;
      const target = +pendingMaker.target || +rec.shares || 0;
      const filled = makerTouchFill({ askNow: ask, limit: rec.limitPx,
        filled: previous, target, dtMs,
        touchMs: P.H_RESCUE_SIM_TOUCH_MS, fillPct: P.H_RESCUE_SIM_FILL_PCT });
      pendingMaker.filled = filled;
      const delta = filled - previous;
      if (delta > 1e-9) {
        const fill = { ...rec, decidedT: rec.tInto, placedT: rec.tInto,
          tInto: tk.t, requestedShares: target, shares: +delta.toFixed(4),
          effPx: rec.limitPx, usdc: +(delta * rec.limitPx).toFixed(4),
          status: filled + 1e-9 >= target ? "full" : "partial",
          filledLate: true };
        applyInventory(fill);
        fills.push(fill);
      }
      if (filled + 1e-9 < target) keep.push(pendingMaker);
    }
    state.restingMakers = keep;
  };
  const resolveDue = (throughT) => {
    while (pending.length && pending[0].dueT <= throughT + 1e-9) {
      const p = pending.shift(), f = p.rec, at = p.arrivalTick;
      const arrivalBook = bookAt(at, f.side);
      const fixedUsd = f.amountMode === "usd"
        || (f.budgetUsd != null && Number.isFinite(+f.budgetUsd));
      const requestedShares = f.minimumShares ?? f.shares;
      const requestedBudgetUsd = fixedUsd ? (+f.budgetUsd || +f.usdc || 0) : null;
      const match = fixedUsd
        ? walkVisibleBudget(arrivalBook, requestedBudgetUsd, f.limitPx, { allowBbaFallback: false })
        : walkVisibleAsks(arrivalBook, requestedShares, f.limitPx, { allowBbaFallback: false });
      stampLatencyDisplay(f, p.dueT);
      f.requestedShares = requestedShares;
      if (fixedUsd) f.requestedBudgetUsd = requestedBudgetUsd;
      if (!(match.shares > 0)) continue;
      f.shares = +match.shares.toFixed(4);
      f.effPx = +match.avgPx.toFixed(4);
      f.usdc = +match.cost.toFixed(4);
      f.status = fixedUsd
        ? (match.cost + 1e-9 < requestedBudgetUsd ? "partial" : "full")
        : (match.shares + 1e-9 < f.requestedShares ? "partial" : "full");
      f.filledLate = latSec > 0;
      if (at.bz != null) {
        f.bz = at.bz;
        if (openBz != null) { f.bzGap = at.bz - openBz; f.bzGapPct = openBz ? (f.bzGap / openBz) * 100 : null; }
      }
      if (at.cl != null) f.cl = at.cl;
      applyInventory(f);
      fills.push(f);
    }
  };
  let prevT = null;
  for (let i = 0; i < bk.length; i++) {
    const tk = bk[i];
    resolveDue(tk.t);
    const gapMs = prevT != null ? (tk.t - prevT) * 1000 : 0;
    prevT = tk.t;
    // STALE: a gap > staleMs means the book was stale through it. Live would not trade on the
    // just-reconnected tick → skip it (prevT is already advanced, so only this one tick is skipped).
    if (gapMs > staleMs) continue;
    const up = bookAt(tk, "Up"), down = bookAt(tk, "Down");
    const bz = tk.bz != null ? tk.bz : null;
    const bzGap = (bz != null && openBz != null) ? bz - openBz : null;
    const bzGapPct = (bzGap != null && openBz) ? (bzGap / openBz) * 100 : null;
    const dtMs = gapMs > 0 ? Math.max(1, gapMs) : REF_MS;
    resolveMakers(tk, dtMs);
    // The strategy derives its deterministic clock from window time.
    const cl = tk.cl != null ? tk.cl : null;
    const got = strat.step(state, { t: tk.t, up, down, bzPrice: bz, clPrice: cl,
      openBinance: openBz,
      openChainlink: openCl, bzGap, bzGapPct,
      winHour, winDay }, P, dtMs);
    for (const f of got) {
      if (f.exec === "maker") continue; // resting lifecycle is resolved above on later ticks
      const ai = arrivalIndex[i];
      pending.push({ rec: f, dueT: tk.t + latSec, arrivalTick: bk[ai] });
    }
    resolveDue(tk.t);   // latency=0 intents match on the decision frame
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
