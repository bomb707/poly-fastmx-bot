import assert from "node:assert/strict";
import test from "node:test";
import { assessDustLock } from "./passive-maker-dust-lock.mjs";

test("allows a five-share completion only when both outcomes are nonnegative", () => {
  const result = assessDustLock({ up: 5, down: .3, cost: 1.9, buySide: "Down", buyShares: 5,
    buyCost: 2.9, buyFees: .05, minOrderShares: 5 });
  assert.equal(result.allowed, true);
  assert.equal(result.worstPayout, 5);
  assert.ok(result.lockedPnl > 0);
});

test("rejects an apparently cheap hedge when total accumulated cost is not locked", () => {
  const result = assessDustLock({ up: 5, down: .3, cost: 2.5, buySide: "Down", buyShares: 5,
    buyCost: 2.5, buyFees: .05, minOrderShares: 5 });
  assert.equal(result.allowed, false);
  assert.ok(result.lockedPnl < 0);
});

test("rejects a subminimum completion", () => {
  assert.equal(assessDustLock({ up: 4, down: 0, cost: 1, buySide: "Down", buyShares: 4,
    buyCost: 2, buyFees: 0, minOrderShares: 5 }).allowed, false);
});
