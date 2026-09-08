import test from "node:test";
import assert from "node:assert/strict";

import { executionFee, fillFee } from "./fees.js";

test("crypto taker fee matches the official symmetric 7% curve", () => {
  assert.equal(fillFee(0.50, 100, true), 1.75);
  assert.equal(fillFee(0.30, 100, true), 1.47);
  assert.equal(fillFee(0.70, 100, true), 1.47);
});

test("maker fills are fee-free and sub-minimum taker fees round to zero", () => {
  assert.equal(fillFee(0.50, 100, false), 0);
  assert.equal(fillFee(0.01, 0.001, true), 0);
  assert.equal(fillFee(0.50, 1 / 1750, true), 0.00001);
});

test("multi-level execution fees are summed at each actual match price", () => {
  const match = { shares: 20, avgPx: 0.5,
    levels: [{ price: 0.4, shares: 10 }, { price: 0.6, shares: 10 }] };
  assert.equal(executionFee(match, true), 0.336);
  assert.equal(executionFee(match, false), 0);
  assert.notEqual(executionFee(match, true), fillFee(match.avgPx, match.shares, true));
});
