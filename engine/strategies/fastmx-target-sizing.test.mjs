import test from "node:test";
import assert from "node:assert/strict";
import { targetSizeMedianAtCap, targetWalletEntryShares,
  targetWalletRoleShares } from "./fastmx-target-sizing.js";

test("target size curve interpolates the reconstructed cent-cap menu", () => {
  assert.equal(targetSizeMedianAtCap(0.70), 8);
  assert.equal(targetSizeMedianAtCap(0.955), 14.5);
  assert.equal(targetSizeMedianAtCap(0.01), 32);
  assert.equal(targetSizeMedianAtCap(0.99), 19);
});

test("target sizing preserves base size as risk scale and integer order tiers", () => {
  assert.equal(targetWalletEntryShares(0.70), 7);
  assert.equal(targetWalletEntryShares(0.95), 12);
  assert.equal(targetWalletEntryShares(0.05), 28);
  assert.equal(targetWalletEntryShares(0.05, { maxShares: 20 }), 20);
  assert.equal(Number.isInteger(targetWalletEntryShares(0.935)), true);
});

test("role-aware sizing reduces weak top-ups but leaves first entries on the full cap curve", () => {
  assert.equal(targetWalletRoleShares(0.95, { role: "first-entry" }), 12);
  assert.equal(targetWalletRoleShares(0.95, { role: "topup", confidence: 0.35 }), 8);
  assert.equal(targetWalletRoleShares(0.95, { role: "topup", confidence: 1 }), 12);
  assert.equal(targetWalletRoleShares(0.95, { role: "hedge", confidence: 0.35 }), 12);
});
