import assert from "node:assert/strict";
import test from "node:test";
import { dueMakerArrivals } from "./passive-maker-arrival-order.mjs";

test("orders becoming due in one snapshot retain causal FIFO order", () => {
  const older = { arrivalMs: 100, sequence: 1 };
  const newer = { arrivalMs: 110, sequence: 2 };
  assert.deepEqual(dueMakerArrivals([newer, older], 120), [older, newer]);
});

test("sequence breaks equal-arrival ties and future orders remain queued", () => {
  const rows = [{ arrivalMs: 100, sequence: 2 }, { arrivalMs: 121, sequence: 1 }, { arrivalMs: 100, sequence: 1 }];
  assert.deepEqual(dueMakerArrivals(rows, 120).map((row) => row.sequence), [1, 2]);
  assert.equal(rows.length, 3);
});
