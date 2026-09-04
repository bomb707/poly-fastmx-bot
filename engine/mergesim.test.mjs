// Unit test for historical merge-record accounting.
import { applyMergeToLedger } from "./mergesim.js";
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "✓" : "✗ FAIL") + " " + n); };

// applyMergeToLedger — removes sets/cost, banks realized + reclaim
const L = { upShares: 10, downShares: 10, cost: 9.08, fee: 0.175, upCost: 4.08, downCost: 5.0, mergedRealized: 0, mergedUsd: 0 };
applyMergeToLedger(L, { sets: 10, mainCost: 9.08, mainFee: 0.175, mainUpCost: 4.08, mainDnCost: 5.0, realized: 0.745, reclaimUsd: 10 });
ok("ledger reclaim → flat + banked", L.upShares === 0 && L.downShares === 0 && Math.abs(L.cost) < 1e-9 && Math.abs(L.mergedRealized - 0.745) < 1e-9 && L.mergedUsd === 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
