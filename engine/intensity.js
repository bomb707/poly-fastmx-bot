// engine/intensity.js — REUSABLE volatility sensor for the LOCKSTEP strategy.
//
// ── LIB BOUNDARY ─────────────────────────────────────────────────────────────────────────────────────
// Pure, dependency-free functions: the single source of truth for the "how far could BTC still move?"
// estimate that gates every Lockstep lock. Lives in engine/ (not src/lib/) because engine/strategy.js
// imports it AND is served to the browser at /engine/*.js (a src/lib/ path wouldn't resolve there).
//
// THE MODEL (see the strategy spec, §3/§6/§7). Each COMPLETED 5-minute round has an EXCURSION = the
// largest distance the price reached from that round's open (max |price − open| over the round). The
// volatility window is the last L_VOL_ROUNDS completed rounds (default 6 ≈ 30 min). INTENSITY collapses
// those excursions to one number (MAX or SMOOTH). The POSSIBLE REMAINING MOVE scales INTENSITY down by
// the fraction of the round still left. Lockstep locks the current leader when |GAP| already exceeds that.
//
//   INTENSITY            = max (or trimmed-mean) of the last N rounds' excursions
//   POSSIBLE REMAINING   = INTENSITY × timeLeftFraction(secondsRemaining)
//
// IMPORTANT: the ACTIVE round is EXCLUDED from the window — only completed rounds count. Folding the live
// round's own gap into the max would inflate the estimate to meet whatever the price is doing right now,
// and the lock condition would almost never trigger. The caller (shadow live / backtest driver) owns the
// rolling buffer and pushes a round's excursion only once the round has closed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * roundExcursion — the largest absolute distance the price traveled from `open` during one round.
 * @param {number[]|Float64Array} prices  the round's price series (e.g. Binance spot per tick)
 * @param {number} open   the round's open price
 * @returns {number} max |price − open| over the round (0 if no valid prices)
 */
export function roundExcursion(prices, open) {
  if (open == null || prices == null || !prices.length) return 0;
  let mx = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p == null || !isFinite(p)) continue;
    const d = Math.abs(p - open);
    if (d > mx) mx = d;
  }
  return mx;
}

/**
 * computeIntensity — collapse the last N completed rounds' excursions to a single INTENSITY ($).
 *   "max"    (default, most cautious): the single largest excursion among the window.
 *   "smooth" (steadier): drop the highest AND lowest, average the rest (needs ≥ 3 samples; else falls
 *            back to the plain mean, and to max on a single sample). Ignores one freak-quiet + one
 *            freak-violent round.
 * @param {number[]} excursions  recent completed-round excursions (any order); only the last `rounds` are used
 * @param {{L_VOL_MODE?:string, L_VOL_ROUNDS?:number}} [P]
 * @returns {number} INTENSITY ($); 0 when there are no samples (⇒ possibleMove 0 ⇒ never gates — caller
 *          should treat 0/insufficient-history as "not ready" and not lock; see intensityReady).
 */
export function computeIntensity(excursions, P = {}) {
  const rounds = Math.max(1, Math.round(+P.L_VOL_ROUNDS || 6));
  const mode = (P.L_VOL_MODE === "smooth") ? "smooth" : "max";
  if (!Array.isArray(excursions) || !excursions.length) return 0;
  const w = excursions.slice(-rounds).filter((x) => x != null && isFinite(x) && x >= 0);
  if (!w.length) return 0;
  if (mode === "max") return Math.max(...w);
  // smooth: drop hi+lo, average the remaining. <3 samples ⇒ can't trim ⇒ plain mean; 1 sample ⇒ that value.
  if (w.length < 3) return w.reduce((a, b) => a + b, 0) / w.length;
  const s = w.slice().sort((a, b) => a - b);
  const mid = s.slice(1, -1);   // drop lowest [0] and highest [len-1]
  return mid.reduce((a, b) => a + b, 0) / mid.length;
}

/**
 * timeLeftFraction — the fraction of the round still remaining, used to scale INTENSITY down as the clock runs.
 *   "linear" (default): frac = secondsRemaining / windowSec — shrinks proportionally to time.
 *   "sqrt": frac = sqrt(secondsRemaining / windowSec) — shrinks slower early, faster late (closer to how a
 *           random walk's range grows with time; more conservative mid-round). Clamped to [0, 1].
 * @param {number} secsRemaining
 * @param {number} windowSec
 * @param {string} [scaling]  "linear" | "sqrt"
 */
export function timeLeftFraction(secsRemaining, windowSec, scaling = "linear") {
  const win = windowSec > 0 ? windowSec : 300;
  let f = secsRemaining / win;
  if (f < 0) f = 0; else if (f > 1) f = 1;
  return (scaling === "sqrt") ? Math.sqrt(f) : f;
}

/**
 * possibleMove — the largest price swing that could still plausibly happen in the time left ($).
 *   = INTENSITY × timeLeftFraction(secsRemaining) + L_EDGE_BUFFER (an optional extra cushion that demands
 *   an even larger gap before locking). The edge buffer is added AFTER scaling so it's a flat floor on how
 *   much room the estimate always leaves.
 * @param {number} intensity
 * @param {number} secsRemaining
 * @param {number} windowSec
 * @param {{L_SCALING?:string, L_EDGE_BUFFER?:number}} [P]
 */
export function possibleMove(intensity, secsRemaining, windowSec, P = {}) {
  const frac = timeLeftFraction(secsRemaining, windowSec, P.L_SCALING === "sqrt" ? "sqrt" : "linear");
  return (+intensity || 0) * frac + (+P.L_EDGE_BUFFER || 0);
}

/**
 * intensityReady — do we have enough completed rounds to trust the estimate? Lockstep must NOT lock before
 * the volatility window has filled (an empty/1-round buffer gives a wild or zero estimate). The caller gates
 * on this; the strategy also treats intensity==null as "not ready".
 * @param {number[]} excursions
 * @param {number} [minRounds]  minimum completed rounds required (default 1 — at least one real sample)
 */
export function intensityReady(excursions, minRounds = 1) {
  if (!Array.isArray(excursions)) return false;
  const good = excursions.filter((x) => x != null && isFinite(x) && x > 0);
  return good.length >= Math.max(1, minRounds);
}

/**
 * IntensityBuffer — a tiny rolling store of completed-round excursions the CALLER (shadow live / backtest
 * driver) owns. Keeps at most `keep` recent excursions (a couple extra beyond L_VOL_ROUNDS is harmless —
 * computeIntensity slices to the window). This is deliberately a plain object, not per-window strategy state
 * (which resets each round) — the volatility window spans rounds.
 */
export function makeIntensityBuffer(keep = 12) {
  return { ex: [], keep: Math.max(1, keep) };
}
/** push a completed round's excursion; trims to `keep`. */
export function pushExcursion(buf, excursion) {
  if (!buf) return;
  if (excursion == null || !isFinite(excursion) || excursion < 0) return;
  buf.ex.push(excursion);
  if (buf.ex.length > buf.keep) buf.ex.splice(0, buf.ex.length - buf.keep);
}
