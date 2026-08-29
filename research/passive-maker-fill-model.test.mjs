import assert from "node:assert/strict";
import test from "node:test";
import { allocateConservedMakerFills } from "./passive-maker-fill-model.mjs";

const order = (shares, queueAhead = 0, sequence = 0) => ({
  shares, queueAhead, sequence, effectiveArrivalMs: sequence,
});

test("one exact-price trade cannot be credited independently to overlapping orders", () => {
  const orders = [order(5, 0, 1), order(5, 0, 2)];
  const fills = allocateConservedMakerFills(orders, 10, .1);
  assert.deepEqual(fills.map((fill) => fill.shares), [1]);
  assert.deepEqual(orders.map((row) => row.shares), [4, 5]);
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 1);
});

test("shared maker-credit budget can advance FIFO only after the older order fills", () => {
  const orders = [order(5, 0, 1), order(5, 0, 2)];
  const fills = allocateConservedMakerFills(orders, 100, .1);
  assert.deepEqual(fills.map((fill) => fill.shares), [5, 5]);
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 10);
});

test("visible queue ahead is consumed before maker credit", () => {
  const orders = [order(5, 8, 1), order(5, 13, 2)];
  const fills = allocateConservedMakerFills(orders, 10, .5);
  assert.deepEqual(fills.map((fill) => fill.shares), [1]);
  assert.deepEqual(orders.map((row) => row.queueAhead), [0, 3]);
});

test("unused shared allowance can reach the next FIFO order", () => {
  const orders = [order(1, 0, 1), order(5, 0, 2)];
  const fills = allocateConservedMakerFills(orders, 10, .5);
  assert.deepEqual(fills.map((fill) => fill.shares), [1, 4]);
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 5);
});
