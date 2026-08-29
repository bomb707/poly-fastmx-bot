import assert from "node:assert/strict";
import test from "node:test";
import { validVenueOrderShares } from "./passive-maker-order-minimum.mjs";

test("accepts a five-share or larger submitted order", () => {
  assert.equal(validVenueOrderShares(5, 5), true);
  assert.equal(validVenueOrderShares(7.5, 5), true);
});

test("rejects a sub-five-share completion request", () => {
  assert.equal(validVenueOrderShares(4.999, 5), false);
  assert.equal(validVenueOrderShares(0.2, 5), false);
});
