// Unit tests for engine/mergesim.js — maybeMerge (decision) + applyMergeToLedger (ledger reclaim).
// Run: node engine/mergesim.test.mjs
import { maybeMerge, applyMergeToLedger } from "./mergesim.js";
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "✓" : "✗ FAIL") + " " + n); };

// maybeMerge — balanced set, guaranteed = 10 - 9.08 - 0.175 = 0.745
const mkState = () => ({ mUpSh: 10, mDnSh: 10, mUpCost: 4.08, mDnCost: 5.0, mFee: 0.175, seq: 0 });
let s = mkState(), out = []; maybeMerge(s, out, { t: 5 }, { MERGE_ON: true, MERGE_X: 0.3 });
ok("fires when balanced + ≥ MERGE_X", out.length === 1 && out[0].leg === "merge" && out[0].sets === 10 && Math.abs(out[0].realized - 0.745) < 1e-3);
ok("resets set accounting to flat", s.mUpSh === 0 && s.mDnSh === 0 && s.mUpCost === 0 && s.mFee === 0);
s = mkState(); out = []; maybeMerge(s, out, { t: 5 }, { MERGE_ON: true, MERGE_X: 2 });   // 0.745 < 2
ok("no-op below MERGE_X", out.length === 0 && s.mUpSh === 10);
s = mkState(); s.mDnSh = 8; out = []; maybeMerge(s, out, { t: 5 }, { MERGE_ON: true, MERGE_X: 0.3 });
ok("no-op when unbalanced", out.length === 0);
s = mkState(); out = []; maybeMerge(s, out, { t: 5 }, { MERGE_ON: false, MERGE_X: 0.3 });
ok("no-op when MERGE_ON off", out.length === 0 && s.mUpSh === 10);

// applyMergeToLedger — removes sets/cost, banks realized + reclaim
const L = { upShares: 10, downShares: 10, cost: 9.08, fee: 0.175, upCost: 4.08, downCost: 5.0, mergedRealized: 0, mergedUsd: 0 };
applyMergeToLedger(L, { sets: 10, mainCost: 9.08, mainFee: 0.175, mainUpCost: 4.08, mainDnCost: 5.0, realized: 0.745, reclaimUsd: 10 });
ok("ledger reclaim → flat + banked", L.upShares === 0 && L.downShares === 0 && Math.abs(L.cost) < 1e-9 && Math.abs(L.mergedRealized - 0.745) < 1e-9 && L.mergedUsd === 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
