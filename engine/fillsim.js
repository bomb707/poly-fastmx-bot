// engine/fillsim.js — REUSABLE fill-simulation model (how a MODELED order fills: resting/maker, crossing/taker, latency).
//
// ── LIB BOUNDARY ─────────────────────────────────────────────────────────────────────────────────────
// Pure, dependency-free functions — the SINGLE SOURCE OF TRUTH for "when and at what price does a modeled order
// fill". Lives in engine/ (not src/lib/) because engine/strategy.js + engine/simrun.js import it AND are served
// to the browser at /engine/*.js — a src/lib/ path wouldn't resolve there. Wired into all three consumers:
//   engine/strategy.js (makerTouchFill) · engine/simrun.js (futureAsks + stampLatencyDisplay) ·
//   src/execution/shadow.js (latencyFillPrice). Two ORCHESTRATION modes wrap these primitives (same model):
//   • Backtest — precompute the ask LATENCY_MS in the future per tick (`futureAsks`) and price the fill there.
//   • Live-shadow — defer the fill in a queue and, at decision+latency, price it against the book AS OF then.
// The maker touch-fill accrual (`makerTouchFill`) drives the engine's resting-order block; the taker/crossing
// case is just "fill at the ask" (`latencyFillPrice` with no maker resting).
//
// SIM/backtest ONLY — real live books the REAL CLOB fill via lib/executor.js (never a modeled fill).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;

/**
 * MAKER touch-fill accrual — how much of a resting GTC limit (below the ask, delta −δ) has filled this tick.
 *   askNow > limit           → no fill (the bid rests, waiting for price to come to it) → returns `filled` unchanged.
 *   askNow ≈ limit (touch)    → accrue `fillPct` of the WHOLE target per `touchMs`, scaled by this tick's `dtMs`.
 *   askNow < limit (crossed)  → the remainder fills fully → returns `target`.
 * Pure: no side effects. Caller decides what to do when `filled >= target` (open the leg) or at the end-cutoff.
 *
 * @param {object} a
 * @param {number} a.askNow   the resting side's best ask this tick
 * @param {number} a.limit    the order's limit price (the touch line)
 * @param {number} a.filled   shares filled so far
 * @param {number} a.target   total shares wanted
 * @param {number} a.dtMs     ms since the previous tick
 * @param {number} a.touchMs  ms to accrue one `fillPct` chunk at the touch (V_SIM_TOUCH_MS)
 * @param {number} a.fillPct  0..100 — % of target per touchMs at the touch (V_SIM_FILL_PCT)
 * @returns {number} the new `filled` (clamped to [0, target])
 */
export function makerTouchFill({ askNow, limit, filled, target, dtMs, touchMs, fillPct }) {
  filled = +filled || 0; target = +target || 0;
  if (askNow == null || !(filled < target - EPS)) return filled;
  if (askNow < limit - EPS) return target;                                   // crossed through → remainder fills fully
  if (Math.abs(askNow - limit) <= EPS) {                                     // at the touch → touch% of TOTAL per touchMs
    const tMs = Math.max(1, +touchMs || 250);
    const r = +fillPct; const fp = Math.max(0, Math.min(100, Number.isFinite(r) ? r : 100)) / 100;  // NaN-safe
    return Math.min(target, filled + fp * ((+dtMs || 0) / tMs) * target);
  }
  return filled;                                                             // askNow > limit → no fill this tick
}

/**
 * The fill PRICE for a marketable (or touched) buy: the side's ask, capped at the order's limit ceiling.
 *   A taker crosses and pays the ask (≤ limit). A resting maker fills AT its limit. Under latency, `sideAsk`
 *   is the ask AS OF decision+LATENCY_MS (see `futureAsks`), so the price reflects the move while in flight.
 * @param {number} sideAsk   the buy side's ask (at the fill instant)
 * @param {number} [limitPx] the order's limit ceiling (default 1 = uncapped)
 * @returns {number} fill price, rounded to the 0.0001 grid (or null if sideAsk is null)
 */
export function latencyFillPrice(sideAsk, limitPx) {
  if (sideAsk == null) return null;
  return +Math.min(sideAsk, limitPx != null ? limitPx : 1).toFixed(4);
}

/**
 * Walk the visible ask ladder for a marketable BUY, never paying above the signed limit.
 * This is shared by live-shadow and historical replay so partial fills and VWAP are identical.
 * A best-ask fallback is retained only for legacy/manual callers; full-depth replays disable it
 * because inventing infinite liquidity from BBA would invalidate the strategy's depth gate.
 */
export function walkVisibleAsks(book, requested, cap, { allowBbaFallback = true } = {}) {
  const rows = Array.isArray(book?.asks) ? book.asks : [];
  const asks = rows.map((x) => [
    Number(Array.isArray(x) ? x[0] : x?.price),
    Number(Array.isArray(x) ? x[1] : x?.size),
  ]).filter(([px, size]) => Number.isFinite(px) && Number.isFinite(size) && size > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!asks.length && allowBbaFallback && book?.bestAsk != null) {
    asks.push([Number(book.bestAsk), Number.POSITIVE_INFINITY]);
  }
  let left = Math.max(0, +requested || 0), shares = 0, cost = 0;
  const levels = [];
  const ceiling = Number.isFinite(+cap) ? +cap : 1;
  for (const [px, size] of asks) {
    if (px > ceiling + EPS || left <= EPS) break;
    const take = Math.min(left, size);
    shares += take; cost += take * px; left -= take;
    if (take > EPS) levels.push({ price: px, shares: take });
  }
  return { shares, cost, avgPx: shares > 0 ? cost / shares : null, levels,
    remaining: Math.max(0, left) };
}

/** Create a mutable, per-update liquidity pool so concurrent simulated orders cannot reuse asks. */
export function createAskPool(book) {
  const asks = (Array.isArray(book?.asks) ? book.asks : []).map((row) => [
    Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    .sort((a, b) => a[0] - b[0]);
  return { ...book, asks };
}

export function depthEventId(book, fallback = null) {
  const value = book?.depthEventId ?? book?.eventId
    ?? (book?.depthTs != null ? `depth:${book.depthTs}` : fallback);
  return value == null ? null : String(value);
}

/**
 * Liquidity belongs to an identified external depth event. Reprocessing that
 * event, including a second lifecycle phase, returns the already-consumed pool.
 * Only a new depth event identity replenishes visible liquidity.
 */
export function createExecutionEvidenceLedger() {
  const askPools = new Map();
  const makerFlow = new Map();
  return {
    askPools,
    makerFlow,
    poolFor(side, book, fallback = null) {
      const eventId = depthEventId(book, fallback);
      if (eventId == null) return null;
      const key = `${side}:${eventId}`;
      if (!askPools.has(key)) askPools.set(key, createAskPool(book));
      return askPools.get(key);
    },
  };
}

/** Walk and consume a per-update ask pool. */
export function consumeVisibleAsks(pool, requested, cap) {
  const match = walkVisibleAsks(pool, requested, cap, { allowBbaFallback: false });
  let left = match.shares;
  for (const row of pool?.asks || []) {
    if (left <= EPS) break;
    const take = Math.min(left, Number(row[1]) || 0);
    row[1] -= take;
    left -= take;
  }
  return match;
}

/**
 * Credit a resting maker only from explicit sell-flow evidence. `touch` is an
 * intentionally optimistic sensitivity mode; the production/replay default is
 * `zero`, which gives no fill merely for spending time at the public bid.
 */
export function makerFillFromEvidence({ book, limit, remaining, assumption = "zero",
  queueAssumption = "none", evidenceLedger = null, evidenceScope = "",
  restingSinceMs = -Infinity, throughMs = Infinity,
  dtMs = 0, touchMs = 1000, fillPct = 0, previouslyCredited = 0, target = remaining }) {
  const none = { shares: 0, evidenceType: "none", verified: false,
    queueAssumption: String(queueAssumption || "none"), evidenceIds: [] };
  if (assumption === "observed-flow" && queueAssumption === "front-of-queue"
    && evidenceLedger instanceof Map) {
    let available = Math.max(0, Number(remaining) || 0);
    let shares = 0;
    const evidenceIds = [];
    for (const event of Array.isArray(book?.makerEvidence) ? book.makerEvidence : []) {
      const id = event?.id == null ? null : String(event.id);
      const ts = Number(event?.ts), price = Number(event?.price), quantity = Number(event?.shares);
      const aggressorSide = String(event?.aggressorSide ?? event?.takerSide ?? "").toLowerCase();
      if (!id || !Number.isFinite(ts) || !Number.isFinite(price) || !(quantity > 0)) continue;
      if (aggressorSide !== "sell") continue;
      if (ts < Number(restingSinceMs) || ts > Number(throughMs)) continue;
      if (price > Number(limit) + EPS) continue;
      const key = `${evidenceScope}:${id}`;
      if (!evidenceLedger.has(key)) evidenceLedger.set(key, quantity);
      const take = Math.min(available, Math.max(0, Number(evidenceLedger.get(key)) || 0));
      if (!(take > EPS)) continue;
      evidenceLedger.set(key, Number(evidenceLedger.get(key)) - take);
      shares += take;
      available -= take;
      evidenceIds.push(id);
      if (available <= EPS) break;
    }
    if (shares > EPS) return { shares, evidenceType: "observed-flow-estimate",
      verified: false, queueAssumption, evidenceIds };
  }
  if (assumption !== "touch") return none;
  const cumulative = makerTouchFill({ askNow: limit, limit, filled: previouslyCredited,
    target, dtMs, touchMs, fillPct });
  return { shares: Math.min(Math.max(0, remaining), Math.max(0, cumulative - previouslyCredited)),
    evidenceType: "optimistic-touch", verified: false, queueAssumption: "time-at-bid",
    evidenceIds: [] };
}

/** Remove up to `shares` from ordered reservation slices, mutating the remainder. */
export function takeReservationSlices(reservation, shares) {
  let left = Math.max(0, Number(shares) || 0);
  const taken = [];
  for (const slice of Array.isArray(reservation) ? reservation : []) {
    if (left <= EPS) break;
    const available = Math.max(0, Number(slice.shares) || 0);
    const take = Math.min(left, available);
    if (!(take > EPS)) continue;
    taken.push({ ...slice, shares: take });
    slice.shares = available - take;
    left -= take;
  }
  for (let i = (reservation?.length || 0) - 1; i >= 0; i--) {
    if (!(Number(reservation[i]?.shares) > EPS)) reservation.splice(i, 1);
  }
  return taken;
}

/**
 * Walk the visible ask ladder for a fixed-USDC market BUY. Polymarket BUY
 * market orders fix the maker amount (USDC); the signed taker amount is the
 * minimum token output at the limit cap. A better execution price therefore
 * returns more shares instead of reducing the order's original budget.
 */
export function walkVisibleBudget(book, budgetUsd, cap, { allowBbaFallback = true } = {}) {
  const rows = Array.isArray(book?.asks) ? book.asks : [];
  const asks = rows.map((x) => [
    Number(Array.isArray(x) ? x[0] : x?.price),
    Number(Array.isArray(x) ? x[1] : x?.size),
  ]).filter(([px, size]) => Number.isFinite(px) && px > 0 && Number.isFinite(size) && size > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!asks.length && allowBbaFallback && book?.bestAsk != null) {
    asks.push([Number(book.bestAsk), Number.POSITIVE_INFINITY]);
  }
  let left = Math.max(0, +budgetUsd || 0), shares = 0, cost = 0;
  const levels = [];
  const ceiling = Number.isFinite(+cap) ? +cap : 1;
  for (const [px, size] of asks) {
    if (px > ceiling + EPS || left <= EPS) break;
    const take = Math.min(size, left / px);
    shares += take; cost += take * px; left -= take * px;
    if (take > EPS) levels.push({ price: px, shares: take });
  }
  // Suppress floating dust so status checks can compare spent with budget.
  if (left <= EPS) left = 0;
  return { shares, cost, avgPx: shares > 0 ? cost / shares : null, levels, unspent: left };
}

/** Walk a fixed-USDC order and consume the same per-update pool as share orders. */
export function consumeVisibleBudget(pool, budgetUsd, cap) {
  const match = walkVisibleBudget(pool, budgetUsd, cap, { allowBbaFallback: false });
  let left = match.shares;
  for (const row of pool?.asks || []) {
    if (left <= EPS) break;
    const take = Math.min(left, Number(row[1]) || 0);
    row[1] -= take;
    left -= take;
  }
  return match;
}

/**
 * BACKTEST latency precompute — for each tick i, the Up/Down ask that exists LATENCY_MS in the FUTURE (the ask a
 *   marketable order fills at, since it lands at decision+latency, not now). Two-pointer forward scan, O(n).
 * @param {Array<{t:number,upAsk:number,dnAsk:number}>} book  tick series (ascending t, seconds)
 * @param {number} latSec  latency in seconds (0 ⇒ returns null; caller uses the current ask)
 * @returns {{fUp:number[], fDn:number[], fT:number[]}|null}  future asks + exact fill times (decision+latency), or null
 */
export function futureAsks(book, latSec) {
  if (!(latSec > 0) || !Array.isArray(book) || !book.length) return null;
  const n = book.length, fUp = new Array(n), fDn = new Array(n), fT = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    const dl = book[i].t + latSec;                       // fill lands EXACTLY at decision+latency (no tick-wait)
    while (j < n - 1 && book[j].t < dl) j++;              // j = first tick at/after the deadline
    const m = (book[j].t <= dl) ? j : Math.max(i, j - 1); // ask AS OF the deadline = latest tick ≤ deadline
    fUp[i] = book[m].upAsk; fDn[i] = book[m].dnAsk; fT[i] = dl;
  }
  return { fUp, fDn, fT };
}

/**
 * Restamp a marketable fill's display times for latency parity (fill shows at decision+latency, decision kept as
 *   decidedT). PnL uses effPx, not tInto, so this is display-only — but it keeps chart/circle timing identical
 *   between the backtest and the recorded live fill.
 * @param {object} f       the fill record (mutated in place)
 * @param {number} fillT   the fill time = decision+latency (from `futureAsks().fT[i]`), or null to no-op the time move
 * @returns {object} f
 */
export function stampLatencyDisplay(f, fillT) {
  if (f == null || f.exec !== "marketable") return f;
  if (fillT != null) { f.decidedT = f.tInto; f.tInto = fillT; }
  f.placedT = (f.decidedT != null ? f.decidedT : f.tInto);   // SIM: placed (order-fire) time = the decision tick
  return f;
}
