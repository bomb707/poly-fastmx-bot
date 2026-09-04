// Shared FAK ask-ladder walking and simulated latency display helpers. The
// production strategy uses visible L2 depth. Replay decisions are causal; an
// accepted intent is matched only against the book at its modeled arrival.

const EPS = 1e-9;

/**
 * Walk the visible ask ladder for a marketable BUY, never paying above the signed limit.
 * This is shared by live-shadow and historical replay so partial fills and VWAP are identical.
 * A best-ask fallback is retained only for legacy/manual callers; Helpme backviews disable it
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
  const ceiling = Number.isFinite(+cap) ? +cap : 1;
  for (const [px, size] of asks) {
    if (px > ceiling + EPS || left <= EPS) break;
    const take = Math.min(left, size);
    shares += take; cost += take * px; left -= take;
  }
  return { shares, cost, avgPx: shares > 0 ? cost / shares : null };
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
  const ceiling = Number.isFinite(+cap) ? +cap : 1;
  for (const [px, size] of asks) {
    if (px > ceiling + EPS || left <= EPS) break;
    const take = Math.min(size, left / px);
    shares += take; cost += take * px; left -= take * px;
  }
  // Suppress floating dust so status checks can compare spent with budget.
  if (left <= EPS) left = 0;
  return { shares, cost, avgPx: shares > 0 ? cost / shares : null, unspent: left };
}

/**
 * Restamp a marketable fill's display times for latency parity (fill shows at decision+latency, decision kept as
 *   decidedT). PnL uses effPx, not tInto, so this is display-only — but it keeps chart/circle timing identical
 *   between the backtest and the recorded live fill.
 * @param {object} f       the fill record (mutated in place)
 * @param {number} fillT   the modeled fill time, or null to leave the time unchanged
 * @returns {object} f
 */
export function stampLatencyDisplay(f, fillT) {
  if (f == null || f.exec !== "marketable") return f;
  if (fillT != null) { f.decidedT = f.tInto; f.tInto = fillT; }
  f.placedT = (f.decidedT != null ? f.decidedT : f.tInto);   // SIM: placed (order-fire) time = the decision tick
  return f;
}
