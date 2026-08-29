import assert from "node:assert/strict";
import test from "node:test";
import { inferCancelBeforeReplacement, inferGroupedOrderFire, synthesizeBinaryBooks } from "./order-fire.mjs";

const group = {
  isBuy: true,
  limitPrice: .69,
  signedShares: 80,
  firstPublicTs: 20,
  settlements: [
    { role: "taker", outcome: "Down", slug: "btc-updown-5m-0", shares: 64.1, usd: 44.229 },
    { role: "maker", outcome: "Down", slug: "btc-updown-5m-0", shares: 15.9, usd: 10.971 },
  ],
};

test("synthesizes one outcome's bid from the opposite ask", () => {
  const tick = synthesizeBinaryBooks({ up: { asks: [{ price: .31, size: 15.9 }] }, down: { asks: [] } });
  assert.equal(tick.down.bids[0].price, .69);
  assert.equal(tick.down.bids[0].size, 15.9);
});

test("finds a take-plus-rest transition using exact signed remainder", () => {
  const ticks = [
    { ms: 17_000, up: { asks: [] }, down: { asks: [{ price: .69, size: 100 }], bids: [] } },
    { ms: 18_500, up: { asks: [{ price: .31, size: 15.9 }] }, down: { asks: [], bids: [{ price: .69, size: 15.9 }] } },
    { ms: 19_000, up: { asks: [{ price: .31, size: 100 }] }, down: { asks: [], bids: [{ price: .69, size: 100 }] } },
  ];
  const result = inferGroupedOrderFire(ticks, group);
  assert.equal(result.fireMs, 18_500);
  assert.equal(result.method, "take+rest");
  assert.equal(result.confidence, "high");
  assert.ok(Math.abs(result.bidAdded - 15.9) < 1e-8);
});

test("uses construction time only as a lower bound and still selects a v4 transition", () => {
  const signed = { ...group, signedTimestampMs: 18_700 };
  const ticks = [
    { ms: 17_000, up: { asks: [] }, down: { asks: [{ price: .69, size: 100 }], bids: [] } },
    { ms: 18_000, up: { asks: [{ price: .31, size: 15.9 }] }, down: { asks: [], bids: [{ price: .69, size: 15.9 }] } },
    { ms: 18_800, up: { asks: [] }, down: { asks: [{ price: .69, size: 100 }], bids: [] } },
    { ms: 19_000, up: { asks: [{ price: .31, size: 15.9 }] }, down: { asks: [], bids: [{ price: .69, size: 15.9 }] } },
  ];
  const result = inferGroupedOrderFire(ticks, signed);
  assert.equal(result.fireMs, 19_000);
});

test("matches exact remainder removal to a subsequent replacement", () => {
  const ticks = [
    { ms: 18_500, up: { asks: [{ price: .31, size: 15.9 }] }, down: { asks: [], bids: [{ price: .69, size: 15.9 }] } },
    { ms: 20_000, up: { asks: [] }, down: { asks: [], bids: [] } },
    { ms: 20_100, up: { asks: [] }, down: { asks: [], bids: [] } },
  ];
  const result = inferCancelBeforeReplacement(ticks, { ...group, fireMs: 18_500, outcome: "Down" }, { fireMs: 20_100 }, 15.9);
  assert.equal(result.cancelMs, 20_000);
  assert.equal(result.confidence, "high");
  assert.ok(Math.abs(result.depthRemoved - 15.9) < 1e-8);
});
