import test from "node:test";
import assert from "node:assert/strict";

import * as gapPredictor from "./gap_predictor.js";
import * as wallet3048 from "./wallet3048.js";
import { getStrategy, listStrategies } from "./index.js";

const tick = (t, gap, upAsk, downAsk, intensity) => ({
  t,
  bzGap: gap,
  intensity,
  winHour: 15,
  winDay: 3,
  up: { bestAsk: upAsk, bestBid: Math.max(0.01, upAsk - 0.01) },
  down: { bestAsk: downAsk, bestBid: Math.max(0.01, downAsk - 0.01) },
});

function run(ticks, overrides = {}) {
  const state = {};
  const params = { ...gapPredictor.STRAT, ...overrides };
  const fills = [];
  for (const tk of ticks) fills.push(...gapPredictor.step(state, tk, params, 120, tk.t * 1000));
  return { state, fills };
}

test("Gap Predictor remains a research artifact while wallet3048 is runtime-selectable", () => {
  assert.equal(getStrategy("gap_predictor"), wallet3048);
  assert.deepEqual(listStrategies().map((row) => row.name), ["wallet3048"]);
  assert.equal(getStrategy("wallet3048").NAME, "wallet3048");
  // Its extracted defaults stay testable in isolation for reproducible research.
  assert.equal(gapPredictor.STRAT.L_VOL_ROUNDS, 6);
  assert.equal(gapPredictor.STRAT.L_VOL_MODE, "max");
  assert.equal(gapPredictor.STRAT.L_SCALING, "linear");
  assert.equal(gapPredictor.STRAT.L_EDGE_BUFFER, 0);
  assert.equal(gapPredictor.STRAT.L_ENTRY_FLOOR, 0.5);
  assert.equal(gapPredictor.STRAT.L_ENTRY_CEIL, 0);
  assert.equal(gapPredictor.STRAT.L_HEDGE_EXEC, "taker");
  assert.equal(gapPredictor.STRAT.L_HEDGE_CAP, 0.02);
  assert.equal(gapPredictor.STRAT.L_HEDGE_MIN_PROFIT, 0.03);
});

test("locks only when |gap| exceeds the linear possible remaining move", () => {
  // At t=100, 200/300 of the round remains: intensity 100 => possible move 66.67.
  const below = run([tick(100, 66, 0.80, 0.21, 100)]);
  assert.equal(below.fills.length, 0);
  assert.equal(below.state.gateReason, "no-lock");

  const above = run([tick(100, 67, 0.80, 0.21, 100)]);
  assert.equal(above.fills.length, 1);
  assert.equal(above.fills[0].leg, "entry");
  assert.equal(above.fills[0].side, "Up");
  assert.equal(above.fills[0].reason, "gap-lock");

  const warmup = run([tick(270, 500, 0.80, 0.21, null)]);
  assert.equal(warmup.fills.length, 0);
  assert.equal(warmup.state.gateReason, "vol-warmup");
});

test("price-mode hedge requires both <=2 cents and >=3 cents net profit per share", () => {
  // Entry 0.95 + hedge 0.02 leaves only 0.03 raw; taker fees push net below the 0.03 floor.
  const thin = run([
    tick(240, 60, 0.95, 0.06, 100),
    tick(250, 60, 0.98, 0.02, 100),
  ]);
  assert.equal(thin.fills.filter((f) => f.leg === "hedge").length, 0);
  assert.equal(thin.state.positions.length, 1);

  const profitable = run([
    tick(240, 60, 0.90, 0.06, 100),
    tick(250, 60, 0.98, 0.02, 100),
  ], { L_HEDGE_EXEC: "maker", L_HEDGE_EAGER: true, L_END_HEDGE_S: 30 });
  const hedge = profitable.fills.find((f) => f.leg === "hedge");
  assert.ok(hedge);
  assert.equal(hedge.side, "Down");
  assert.equal(hedge.kind, "taker");
  assert.equal(hedge.reason, "gap-hedge");
  assert.equal(profitable.state.positions.length, 0);
});

test("optional source profit mode can hedge above the price cap when net profit clears the floor", () => {
  const { fills } = run([
    tick(240, 60, 0.70, 0.31, 100),
    tick(250, 60, 0.78, 0.20, 100),
  ], { L_HEDGE_MODE: "profit" });
  const hedge = fills.find((f) => f.leg === "hedge");
  assert.ok(hedge);
  assert.equal(hedge.effPx, 0.20);
  assert.equal(hedge.kind, "taker");
});
