import test from "node:test";
import assert from "node:assert/strict";
import { aggregateSpotGap } from "./passive-maker-gap-aggregation.mjs";

test("weighted mode preserves the historical 70/30 blend", () => {
  assert.equal(aggregateSpotGap(.04, .01, "weighted", .7), .7 * .04 + .3 * .01);
  assert.equal(aggregateSpotGap(-.04, .01, "weighted", .7), .7 * -.04 + .3 * .01);
});

test("consensus modes fail closed on feed-direction disagreement", () => {
  for (const mode of ["conservative", "harmonic", "geometric", "arithmetic",
    "lower-ensemble", "power-ensemble", "upper-ensemble"])
    assert.equal(aggregateSpotGap(.04, -.01, mode), 0);
});

test("power means and ensembles preserve their mathematical ordering", () => {
  const modes = ["conservative", "harmonic", "lower-ensemble", "geometric",
    "power-ensemble", "upper-ensemble", "arithmetic"];
  const values = modes.map((mode) => aggregateSpotGap(.01, .09, mode));
  for (let index = 1; index < values.length; index++) assert.ok(values[index] >= values[index - 1]);
  const down = modes.map((mode) => Math.abs(aggregateSpotGap(-.01, -.09, mode)));
  assert.deepEqual(down, values);
});

test("power ensemble is the equal-weight model average and scale equivariant", () => {
  const h = aggregateSpotGap(.02, .08, "harmonic");
  const g = aggregateSpotGap(.02, .08, "geometric");
  const a = aggregateSpotGap(.02, .08, "arithmetic");
  const ensemble = aggregateSpotGap(.02, .08, "power-ensemble");
  assert.equal(ensemble, (h + g + a) / 3);
  assert.equal(aggregateSpotGap(.2, .8, "power-ensemble"), 10 * ensemble);
});
