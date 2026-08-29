import assert from "node:assert/strict";
import test from "node:test";
import { firstTickAtOrAfter, orderExecutionTicks } from "./execution-latency.mjs";

const ticks = [1000, 1105, 1140, 1510, 1530].map((ms) => ({ ms }));

test("uses the first raw tick at or after an exact deadline", () => {
  assert.equal(firstTickAtOrAfter(ticks, 1130)?.ms, 1140);
  assert.equal(firstTickAtOrAfter(ticks, 1510)?.ms, 1510);
});

test("models maker placement and taker fill on separate clocks", () => {
  const arrival = orderExecutionTicks(ticks, 1000, 130, 520);
  assert.equal(arrival.maker.ms, 1140);
  assert.equal(arrival.taker.ms, 1530);
});

test("fails closed when no later raw tick exists", () => {
  assert.equal(firstTickAtOrAfter(ticks, 2000), null);
});
