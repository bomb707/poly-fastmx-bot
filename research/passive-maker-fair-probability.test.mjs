import test from "node:test";
import assert from "node:assert/strict";
import { poolFairProbability } from "./passive-maker-fair-probability.mjs";

const models = { harmonic: .58, geometric: .64, arithmetic: .72, market: .67 };

test("median pool is the mean of the middle two model probabilities", () => {
  assert.equal(poolFairProbability(models), (.64 + .67) / 2);
});

test("median pool resists a single extreme model", () => {
  assert.equal(poolFairProbability({ harmonic: .60, geometric: .61, arithmetic: .62, market: .99 }), .615);
});

test("lower, center, and upper pools preserve aligned-side ordering", () => {
  const lower = poolFairProbability(models, "median-pool-lower");
  const center = poolFairProbability(models, "median-pool");
  const upper = poolFairProbability(models, "median-pool-upper");
  assert.ok(lower <= center && center <= upper);

  const downModels = Object.fromEntries(Object.entries(models).map(([key, value]) => [key, 1 - value]));
  const downLower = 1 - poolFairProbability(downModels, "median-pool-lower");
  const downCenter = 1 - poolFairProbability(downModels, "median-pool");
  const downUpper = 1 - poolFairProbability(downModels, "median-pool-upper");
  assert.ok(downLower <= downCenter && downCenter <= downUpper);
});

test("pooling is complement symmetric and rejects invalid models", () => {
  const complement = Object.fromEntries(Object.entries(models).map(([key, value]) => [key, 1 - value]));
  for (const mode of ["median-pool-lower", "median-pool", "median-pool-upper"])
    assert.ok(Math.abs(poolFairProbability(complement, mode) - (1 - poolFairProbability(models, mode))) < 1e-12);
  assert.ok(Number.isNaN(poolFairProbability({ ...models, market: NaN })));
});
