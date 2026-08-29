import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapRatioLower95,
  captureMetrics,
  groupTargetMakerFills,
  markOverlappingIntervals,
} from "./maker-credit-calibration-model.mjs";

test("aggregates exact maker partials without accepting taker rows", () => {
  const grouped = groupTargetMakerFills([
    { slug: "s", transactionHash: "0xA", outcome: "Up", action: "BUY", role: "maker", price: .37, size: 2, timestamp: 1 },
    { slug: "s", transactionHash: "0xa", outcome: "Up", action: "BUY", role: "maker", price: .37, size: 3, timestamp: 1 },
    { slug: "s", transactionHash: "0xa", outcome: "Up", action: "BUY", role: "taker", price: .37, size: 9, timestamp: 1 },
  ]);
  assert.equal(grouped.size, 1);
  assert.equal([...grouped.values()][0].shares, 5);
});

test("reports raw and post-queue capture without hiding queue inconsistency", () => {
  assert.deepEqual(captureMetrics({ targetShares: 5, exactVolume: 20, queueAhead: 10 }), {
    targetShares: 5, exactVolume: 20, queueAhead: 10, postQueueVolume: 10,
    rawCapture: .25, postQueueCapture: .5, volumeConsistent: true, queueConsistent: true,
  });
  assert.equal(captureMetrics({ targetShares: 5, exactVolume: 6, queueAhead: 5 }).queueConsistent, false);
});

test("isolates non-overlapping order lifetimes at the same price", () => {
  const rows = markOverlappingIntervals([
    { orderHash: "a", slug: "s", outcome: "Up", price: .4, fromMs: 1, toMs: 10 },
    { orderHash: "b", slug: "s", outcome: "Up", price: .4, fromMs: 9, toMs: 12 },
    { orderHash: "c", slug: "s", outcome: "Up", price: .4, fromMs: 13, toMs: 14 },
    { orderHash: "d", slug: "s", outcome: "Down", price: .4, fromMs: 9, toMs: 12 },
  ]);
  assert.deepEqual(rows.map((row) => row.overlapsTargetOrder), [true, true, false, false]);
});

test("cluster bootstrap is deterministic and resamples windows rather than orders", () => {
  const rows = [
    { slug: "a", got: 5, volume: 10 },
    { slug: "a", got: 5, volume: 10 },
    { slug: "b", got: 1, volume: 10 },
  ];
  const first = bootstrapRatioLower95(rows, "got", "volume", 1000, 7);
  const second = bootstrapRatioLower95(rows, "got", "volume", 1000, 7);
  assert.equal(first, second);
  assert.ok(first >= .1 && first <= .5);
});
