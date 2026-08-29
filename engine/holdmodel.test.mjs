// engine/holdmodel.test.mjs — unit tests for the shared feature builder + scorer. Run: node engine/holdmodel.test.mjs
import { FEATURES, buildFeatures, scoreHold, lockEV } from "./holdmodel.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  ✗ " + name); } };
const approx = (a, b, e = 1e-9) => Math.abs(a - b) < e;

const baseCtx = { gap: 40, intensity: 50, winnerAsk: 0.90, loserAsk: 0.08, cl: 65900, open: 65860, secsLeft: 180, win: 300, winHour: 14, v10: 2, v30: 1 };

// 1. shape + determinism
{
  const f1 = buildFeatures(baseCtx), f2 = buildFeatures(baseCtx);
  ok("vector length matches FEATURES", f1.length === FEATURES.length);
  ok("all finite numbers", f1.every((x) => Number.isFinite(x)));
  ok("deterministic", f1.every((x, i) => x === f2[i]));
}

// 2. ratio = |gap|/intensity
ok("ratio feature = |gap|/intensity", approx(buildFeatures(baseCtx)[0], 40 / 50));

// 3. velocity ALIGNMENT sign: momentum toward the leader (gap>0, v>0) → positive velAlign
{
  const up = buildFeatures({ ...baseCtx, gap: 40, v10: 3 });        // Up leader, gap rising → confirming
  const dn = buildFeatures({ ...baseCtx, gap: 40, v10: -3 });       // Up leader, gap falling → fighting
  ok("velAlign10 positive when momentum confirms the lead", up[1] > 0);
  ok("velAlign10 negative when momentum fights the lead", dn[1] < 0);
  const dnLead = buildFeatures({ ...baseCtx, gap: -40, v10: -3 });  // Down leader, gap falling (more negative) → confirming
  ok("velAlign sign is leader-relative (down leader, down momentum → +)", dnLead[1] > 0);
}

// 4. clAlign: chainlink leading the same way as the gap → positive
{
  const agree = buildFeatures({ ...baseCtx, gap: 40, open: 65860, cl: 65900 });   // cl above open, Up leader → agree
  const disagree = buildFeatures({ ...baseCtx, gap: 40, open: 65860, cl: 65820 }); // cl below open, Up leader → disagree
  ok("clAlign positive when chainlink agrees with the lead", agree[5] > 0);
  ok("clAlign negative when chainlink disagrees", disagree[5] < 0);
}

// 5. scoreHold = manual sigmoid on standardized features
{
  const model = { mean: Array(FEATURES.length).fill(0), std: Array(FEATURES.length).fill(1),
                  weights: Array(FEATURES.length).fill(0), bias: 0 };
  ok("zero model → P=0.5", approx(scoreHold(model, buildFeatures(baseCtx)), 0.5));
  model.bias = 2;
  ok("bias 2 → sigmoid(2)", approx(scoreHold(model, buildFeatures(baseCtx)), 1 / (1 + Math.exp(-2))));
  // one active weight, standardization applied
  const m2 = { mean: [0.8, 0, 0, 0, 0, 0, 0, 0, 0], std: [0.5, 1, 1, 1, 1, 1, 1, 1, 1],
               weights: [1, 0, 0, 0, 0, 0, 0, 0, 0], bias: 0 };
  const feats = buildFeatures(baseCtx);          // ratio = 0.8 → standardized (0.8−0.8)/0.5 = 0 → P=0.5
  ok("standardization applied in score", approx(scoreHold(m2, feats), 0.5));
  ok("null model → null score", scoreHold(null, feats) === null);
}

// 6. lockEV: expected value per share
{
  ok("EV at p=1 = 1−ask (no fee)", approx(lockEV(1, 0.9, 0), 0.1));
  ok("EV at p=0 = −ask", approx(lockEV(0, 0.9, 0), -0.9));
  ok("EV subtracts fee", approx(lockEV(1, 0.9, 0.01), 0.09));
  // break-even p: p(1−a) − (1−p)a = 0 → p = a. So at p=ask, EV(no fee)=0.
  ok("break-even at p = ask", approx(lockEV(0.9, 0.9, 0), 0));
}

console.log(`\nholdmodel.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
