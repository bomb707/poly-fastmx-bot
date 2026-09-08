// Unit tests for lib/fillsim.js — asserts each pure function matches the engine/simrun/shadow inline behavior.
// Run: node src/lib/fillsim.test.mjs
import { makerTouchFill, latencyFillPrice, futureAsks, stampLatencyDisplay, walkVisibleAsks,
  walkVisibleBudget, createAskPool, consumeVisibleAsks, consumeVisibleBudget,
  makerFillFromEvidence, createExecutionEvidenceLedger, takeReservationSlices,
  normalizeMakerExecutionPolicy, restingMakerExecution } from "./fillsim.js";
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "✓" : "✗ FAIL") + " " + n); };

// makerTouchFill — mirrors engine/strategy.js maker-touch block
ok("maker crossed → full", makerTouchFill({ askNow: 0.40, limit: 0.45, filled: 0, target: 10, dtMs: 120, touchMs: 250, fillPct: 100 }) === 10);
ok("maker touch full chunk", makerTouchFill({ askNow: 0.45, limit: 0.45, filled: 0, target: 10, dtMs: 250, touchMs: 250, fillPct: 100 }) === 10);
ok("maker touch 50%", makerTouchFill({ askNow: 0.45, limit: 0.45, filled: 0, target: 10, dtMs: 250, touchMs: 250, fillPct: 50 }) === 5);
ok("maker above → no fill", makerTouchFill({ askNow: 0.50, limit: 0.45, filled: 3, target: 10, dtMs: 250, touchMs: 250, fillPct: 100 }) === 3);
ok("maker NaN fillPct → 100%", makerTouchFill({ askNow: 0.45, limit: 0.45, filled: 0, target: 8, dtMs: 250, touchMs: 250, fillPct: NaN }) === 8);

// latencyFillPrice — mirrors shadow.js reprice (min(ask,limit), 4dp)
ok("fillPrice cap at limit", latencyFillPrice(0.42, 0.99) === 0.42);
ok("fillPrice ask>limit → limit", latencyFillPrice(0.55, 0.50) === 0.50);
ok("fillPrice null ask", latencyFillPrice(null, 0.9) === null);

const walked = walkVisibleAsks({ asks: [[0.50, 2], [0.51, 3], [0.52, 10]] }, 8, 0.51, { allowBbaFallback: false });
ok("visible ask walk is cap-bound and partial", walked.shares === 5 && Math.abs(walked.cost - 2.53) < 1e-9 && Math.abs(walked.avgPx - 0.506) < 1e-9);
ok("strict L2 walk never invents BBA depth", walkVisibleAsks({ bestAsk: 0.5 }, 10, 0.51, { allowBbaFallback: false }).shares === 0);
ok("walk reports level-by-level VWAP inputs", walked.levels.length === 2 && walked.levels[1].price === 0.51);

const pool = createAskPool({ asks: [[0.5, 5], [0.51, 5]] });
const poolFirst = consumeVisibleAsks(pool, 7, 0.51);
const poolSecond = consumeVisibleAsks(pool, 7, 0.51);
ok("orders share and consume one update's ask liquidity", poolFirst.shares === 7 && poolSecond.shares === 3);
ok("time at bid earns no maker fill in the default model", makerFillFromEvidence({
  book: { bestBid: 0.5 }, limit: 0.5, remaining: 10, dtMs: 10_000, fillPct: 100,
}).shares === 0);
ok("unidentified scalar sell flow is not executable maker evidence", makerFillFromEvidence({
  book: { sellFlowAtOrBelow: 4 }, limit: 0.5, remaining: 10,
}).shares === 0);
ok("touch maker credit is explicitly optimistic", makerFillFromEvidence({
  book: {}, limit: 0.5, remaining: 10, assumption: "touch", dtMs: 500,
  touchMs: 1000, fillPct: 100, target: 10,
}).shares === 5);

const evidence = createExecutionEvidenceLedger();
const evidenceBook = { makerEvidence: [
  { id: "trade-1", ts: 2000, price: 0.49, shares: 6, aggressorSide: "sell" },
  { id: "buy-flow", ts: 2000, price: 0.49, shares: 10, aggressorSide: "buy" },
  { id: "missing-time", price: 0.49, shares: 10, aggressorSide: "sell" },
  { id: "too-early", ts: 999, price: 0.49, shares: 10, aggressorSide: "sell" },
  { id: "too-expensive", ts: 2000, price: 0.51, shares: 10, aggressorSide: "sell" },
] };
const makerFirst = makerFillFromEvidence({ book: evidenceBook, limit: 0.5, remaining: 10,
  assumption: "observed-flow", queueAssumption: "front-of-queue",
  evidenceLedger: evidence.makerFlow, evidenceScope: "Up", restingSinceMs: 1000, throughMs: 2000 });
const makerSecond = makerFillFromEvidence({ book: evidenceBook, limit: 0.5, remaining: 10,
  assumption: "observed-flow", queueAssumption: "front-of-queue",
  evidenceLedger: evidence.makerFlow, evidenceScope: "Up", restingSinceMs: 1000, throughMs: 2000 });
ok("identified eligible maker flow is consumed once across orders", makerFirst.shares === 6
  && makerFirst.evidenceType === "observed-flow-estimate" && makerFirst.verified === false
  && makerSecond.shares === 0);
ok("legacy zero is accurately identified as book-cross inference",
  normalizeMakerExecutionPolicy(null, "zero") === "book-cross-inference");
const strictMaker = restingMakerExecution({ policy: "strict-no-maker",
  book: { bestAsk: 0.4, bestBid: 0.39, depthEventId: "strict-1" },
  pool: createAskPool({ asks: [[0.4, 10]] }), limit: 0.5, remaining: 10 });
ok("strict no-maker rejects a public-book cross", strictMaker.match === null
  && strictMaker.evidence.executionPolicy === "strict-no-maker");
const inferredMaker = restingMakerExecution({ policy: "book-cross-inference",
  book: { bestAsk: 0.4, bestBid: 0.39, depthEventId: "cross-1" },
  pool: createAskPool({ asks: [[0.4, 10]] }), limit: 0.5, remaining: 10 });
ok("book-cross inference remains explicitly unverified", inferredMaker.match.shares === 10
  && inferredMaker.evidence.evidenceType === "book-cross-inference"
  && inferredMaker.evidence.verified === false);

const reservation = [{ lotId: "a", shares: 5 }, { lotId: "b", shares: 5 }];
const takenReservation = takeReservationSlices(reservation, 7);
ok("partial fills consume only their reserved FIFO slices", takenReservation[0].shares === 5
  && takenReservation[1].shares === 2 && reservation.length === 1
  && reservation[0].lotId === "b" && reservation[0].shares === 3);

const budgetWalk = walkVisibleBudget({ asks: [[0.48, 5], [0.49, 10], [0.50, 10]] }, 4.9, 0.49, { allowBbaFallback: false });
ok("fixed-USD walk receives price-improved shares", Math.abs(budgetWalk.cost - 4.9) < 1e-9 && budgetWalk.shares > 10 && budgetWalk.unspent === 0);
const budgetPartial = walkVisibleBudget({ asks: [[0.48, 3], [0.50, 50]] }, 4.9, 0.49, { allowBbaFallback: false });
ok("fixed-USD walk cancels the unspent FAK remainder at the cap", Math.abs(budgetPartial.shares - 3) < 1e-9 && Math.abs(budgetPartial.cost - 1.44) < 1e-9 && budgetPartial.unspent > 3.45);
const budgetPool = createAskPool({ asks: [[0.5, 10]] });
const budgetPoolFirst = consumeVisibleBudget(budgetPool, 3, 0.5);
const budgetPoolSecond = consumeVisibleBudget(budgetPool, 3, 0.5);
ok("fixed-USD orders consume the shared update liquidity", budgetPoolFirst.shares === 6
  && budgetPoolSecond.shares === 4 && budgetPoolSecond.unspent === 1);

// futureAsks — mirrors simrun.js two-pointer future-ask precompute
const bk = [{ t: 0, upAsk: 0.5, dnAsk: 0.5 }, { t: 1, upAsk: 0.4, dnAsk: 0.6 }, { t: 2, upAsk: 0.3, dnAsk: 0.7 }];
const fa = futureAsks(bk, 1);
ok("futureAsks lat=1 up", fa.fUp[0] === 0.4 && fa.fUp[1] === 0.3 && fa.fUp[2] === 0.3);
ok("futureAsks fT = decision+lat", fa.fT[0] === 1 && fa.fT[1] === 2);
ok("futureAsks lat=0 → null", futureAsks(bk, 0) === null);

// stampLatencyDisplay
const f = { exec: "marketable", tInto: 5.0 }; stampLatencyDisplay(f, 5.6);
ok("stamp: tInto=fillT, decidedT=orig, placedT=decided", f.tInto === 5.6 && f.decidedT === 5.0 && f.placedT === 5.0);
const f2 = { exec: "maker", tInto: 3 }; stampLatencyDisplay(f2, 9);
ok("stamp: non-marketable untouched", f2.tInto === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
