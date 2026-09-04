// Unit tests for the fill helpers shared by replay and live simulation.
import { stampLatencyDisplay, walkVisibleAsks, walkVisibleBudget } from "./fillsim.js";
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "✓" : "✗ FAIL") + " " + n); };

const walked = walkVisibleAsks({ asks: [[0.50, 2], [0.51, 3], [0.52, 10]] }, 8, 0.51, { allowBbaFallback: false });
ok("visible ask walk is cap-bound and partial", walked.shares === 5 && Math.abs(walked.cost - 2.53) < 1e-9 && Math.abs(walked.avgPx - 0.506) < 1e-9);
ok("strict L2 walk never invents BBA depth", walkVisibleAsks({ bestAsk: 0.5 }, 10, 0.51, { allowBbaFallback: false }).shares === 0);

const budgetWalk = walkVisibleBudget({ asks: [[0.48, 5], [0.49, 10], [0.50, 10]] }, 4.9, 0.49, { allowBbaFallback: false });
ok("fixed-USD walk receives price-improved shares", Math.abs(budgetWalk.cost - 4.9) < 1e-9 && budgetWalk.shares > 10 && budgetWalk.unspent === 0);
const budgetPartial = walkVisibleBudget({ asks: [[0.48, 3], [0.50, 50]] }, 4.9, 0.49, { allowBbaFallback: false });
ok("fixed-USD walk cancels the unspent FAK remainder at the cap", Math.abs(budgetPartial.shares - 3) < 1e-9 && Math.abs(budgetPartial.cost - 1.44) < 1e-9 && budgetPartial.unspent > 3.45);

// stampLatencyDisplay
const f = { exec: "marketable", tInto: 5.0 }; stampLatencyDisplay(f, 5.6);
ok("stamp: tInto=fillT, decidedT=orig, placedT=decided", f.tInto === 5.6 && f.decidedT === 5.0 && f.placedT === 5.0);
const f2 = { exec: "maker", tInto: 3 }; stampLatencyDisplay(f2, 9);
ok("stamp: non-marketable untouched", f2.tInto === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
