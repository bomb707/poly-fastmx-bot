// engine/intensity.test.mjs — unit tests for the Lockstep volatility sensor. Run: node engine/intensity.test.mjs
import { roundExcursion, computeIntensity, timeLeftFraction, possibleMove, intensityReady,
         makeIntensityBuffer, pushExcursion } from "./intensity.js";

let pass = 0, fail = 0;
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } }

// ── roundExcursion ──
ok("excursion: max distance from open", approx(roundExcursion([100, 103, 98, 101], 100), 3));   // |98-100|=2, |103-100|=3 → 3
ok("excursion: below-open dominates", approx(roundExcursion([100, 99, 95, 100], 100), 5));       // |95-100|=5
ok("excursion: empty → 0", roundExcursion([], 100) === 0);
ok("excursion: null open → 0", roundExcursion([1, 2, 3], null) === 0);
ok("excursion: skips null/NaN ticks", approx(roundExcursion([100, null, NaN, 104], 100), 4));

// ── computeIntensity: MAX ──
ok("max: largest excursion", approx(computeIntensity([10, 30, 20], { L_VOL_MODE: "max" }), 30));
ok("max: default mode is max", approx(computeIntensity([10, 30, 20]), 30));
ok("max: windows to last N rounds", approx(computeIntensity([99, 1, 2, 3, 4, 5, 6], { L_VOL_ROUNDS: 6 }), 6));  // drops the leading 99
ok("max: empty → 0", computeIntensity([]) === 0);

// ── computeIntensity: SMOOTH (drop hi+lo, avg rest) ──
ok("smooth: drop hi+lo of 6, avg the 4", approx(computeIntensity([10, 12, 14, 16, 18, 100], { L_VOL_MODE: "smooth", L_VOL_ROUNDS: 6 }), (12 + 14 + 16 + 18) / 4));
ok("smooth: <3 samples → plain mean", approx(computeIntensity([10, 20], { L_VOL_MODE: "smooth" }), 15));
ok("smooth: 1 sample → that value", approx(computeIntensity([42], { L_VOL_MODE: "smooth" }), 42));
ok("smooth: generally ≤ max", computeIntensity([10, 12, 14, 16, 18, 100], { L_VOL_MODE: "smooth", L_VOL_ROUNDS: 6 }) < computeIntensity([10, 12, 14, 16, 18, 100], { L_VOL_MODE: "max", L_VOL_ROUNDS: 6 }));

// ── timeLeftFraction ──
ok("linear: half left → 0.5", approx(timeLeftFraction(150, 300, "linear"), 0.5));
ok("linear: clamps >1", approx(timeLeftFraction(400, 300, "linear"), 1));
ok("linear: clamps <0", approx(timeLeftFraction(-5, 300, "linear"), 0));
ok("sqrt: half left → ~0.707", approx(timeLeftFraction(150, 300, "sqrt"), Math.sqrt(0.5)));
ok("sqrt: more room than linear mid-round", timeLeftFraction(150, 300, "sqrt") > timeLeftFraction(150, 300, "linear"));

// ── possibleMove ──
ok("possible: intensity × frac", approx(possibleMove(300, 150, 300, { L_SCALING: "linear" }), 150));       // 300 × 0.5
ok("possible: + edge buffer", approx(possibleMove(300, 150, 300, { L_SCALING: "linear", L_EDGE_BUFFER: 20 }), 170));
ok("possible: shrinks toward 0 at end", approx(possibleMove(300, 0, 300, {}), 0));
ok("possible: sqrt scaling bigger mid-round", possibleMove(300, 150, 300, { L_SCALING: "sqrt" }) > possibleMove(300, 150, 300, { L_SCALING: "linear" }));

// The core lock inequality: |GAP| > possibleMove. Early (much time left) needs a big gap; late (little time) trivial.
ok("lock: early round rarely fires (big possible move)", !(50 > possibleMove(200, 240, 300, {})));   // possible=200×0.8=160 > 50 → no lock
ok("lock: late round fires (tiny possible move)", (50 > possibleMove(200, 15, 300, {})));             // possible=200×0.05=10 < 50 → lock

// ── intensityReady ──
ok("ready: false when empty", intensityReady([]) === false);
ok("ready: false when only zeros", intensityReady([0, 0]) === false);
ok("ready: true with a real sample", intensityReady([5]) === true);
ok("ready: respects minRounds", intensityReady([5, 6], 3) === false && intensityReady([5, 6, 7], 3) === true);

// ── buffer ──
{
  const buf = makeIntensityBuffer(3);
  pushExcursion(buf, 10); pushExcursion(buf, 20); pushExcursion(buf, 30); pushExcursion(buf, 40);
  ok("buffer: trims to keep (last 3)", buf.ex.length === 3 && buf.ex[0] === 20 && buf.ex[2] === 40);
  pushExcursion(buf, null); pushExcursion(buf, -1); pushExcursion(buf, NaN);
  ok("buffer: ignores invalid", buf.ex.length === 3);
  ok("buffer: feeds computeIntensity", approx(computeIntensity(buf.ex, { L_VOL_MODE: "max" }), 40));
}

console.log(`\nintensity.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
