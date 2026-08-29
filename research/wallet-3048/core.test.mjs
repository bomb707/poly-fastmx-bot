import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFillBursts,
  inferMakerPlacement,
  inferTakerFire,
  labelTradeRoles,
  reconstructWindowCycles,
} from "./core.mjs";

const row = (overrides = {}) => ({
  transactionHash: "0xabc", asset: "1", side: "BUY", outcome: "Up",
  timestamp: 100, price: 0.4, size: 10, slug: "btc-updown-5m-0", conditionId: "0x1",
  ...overrides,
});

test("maker-inclusive rows are multiset-labeled against taker-only rows", () => {
  const duplicate = row();
  const labeled = labelTradeRoles([duplicate, duplicate, row({ price: 0.39 })], [duplicate]);
  assert.deepEqual(labeled.map((item) => item.role), ["taker", "maker", "maker"]);
});

test("partial rows in one transaction aggregate to share-weighted VWAP", () => {
  const bursts = aggregateFillBursts([
    { ...row({ price: 0.4, size: 10 }), role: "taker" },
    { ...row({ price: 0.5, size: 30 }), role: "taker" },
  ]);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].shares, 40);
  assert.equal(bursts[0].vwap, 0.475);
  assert.equal(bursts[0].maxPrice, 0.5);
  assert.ok(Math.abs(bursts[0].modeledFee - (0.07 * 0.4 * 0.6 * 10 + 0.07 * 0.5 * 0.5 * 30)) < 1e-12);
});

test("taker fire inference chooses the pre-consumption book matching shares and VWAP", () => {
  const ticks = [
    { ms: 99_000, up: { asks: [{ price: 0.4, size: 5 }] }, down: { asks: [] } },
    { ms: 99_500, up: { asks: [{ price: 0.4, size: 10 }, { price: 0.5, size: 30 }] }, down: { asks: [] } },
    { ms: 100_000, up: { asks: [] }, down: { asks: [] } },
  ];
  const inferred = inferTakerFire(ticks, { timestamp: 100, outcome: "Up", shares: 40, vwap: 0.475, maxPrice: 0.5 });
  assert.equal(inferred.ms, 99_500);
  assert.equal(inferred.confidence, "high");
  assert.equal(inferred.removedShares, 40);
});

test("taker inference rejects an older matching book without subsequent consumption", () => {
  const full = { asks: [{ price: 0.4, size: 10 }] };
  const ticks = [
    { ms: 97_000, up: full, down: { asks: [] } },
    { ms: 97_300, up: full, down: { asks: [] } },
    { ms: 99_500, up: full, down: { asks: [] } },
    { ms: 99_800, up: { asks: [] }, down: { asks: [] } },
  ];
  const inferred = inferTakerFire(ticks, { timestamp: 100, outcome: "Up", shares: 10, vwap: 0.4, maxPrice: 0.4 });
  assert.equal(inferred.ms, 99_500);
  assert.equal(inferred.consumptionMiss, 0);
});

test("maker placement inference detects a material bid-depth addition", () => {
  const book = (size) => ({ asks: [], bids: size ? [{ price: 0.2, size }] : [] });
  const ticks = [
    { ms: 80_000, up: book(5), down: book(0) },
    { ms: 85_000, up: book(45), down: book(0) },
    { ms: 100_000, up: book(20), down: book(0) },
  ];
  const inferred = inferMakerPlacement(ticks, { timestamp: 100, outcome: "Up", shares: 40, vwap: 0.2 });
  assert.equal(inferred.ms, 85_000);
  assert.equal(inferred.depthAdded, 40);
  assert.equal(inferred.confidence, "high");
});

test("inventory reconstruction labels the opposite-side balancing leg as hedge", () => {
  const rows = reconstructWindowCycles([
    { outcome: "Up", shares: 40 },
    { outcome: "Down", shares: 35 },
    { outcome: "Down", shares: 10 },
  ]);
  assert.equal(rows[0].inferredLeg, "entry/topup");
  assert.equal(rows[1].inferredLeg, "hedge");
  assert.equal(rows[1].pairedAdded, 35);
  assert.equal(rows[2].overbuyShares, 5);
});
