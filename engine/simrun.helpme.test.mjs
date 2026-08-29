import test from "node:test";
import assert from "node:assert/strict";
import { simulateFills } from "./simrun.js";

function side(bestAsk, bestBid, askRows = [[bestAsk, 30], [+(bestAsk + 0.01).toFixed(2), 30]]) {
  return { bestAsk, bestBid, asks: askRows, bids: [[bestBid, 50], [+(bestBid - 0.01).toFixed(2), 50]], depthKnown: true };
}
function tick(t, upAsk, dnAsk, bz, upRows, dnRows) {
  const up = side(upAsk, +(upAsk - 0.02).toFixed(2), upRows);
  const down = side(dnAsk, +(dnAsk - 0.02).toFixed(2), dnRows);
  return { t, ms: t * 1000, upAsk, dnAsk, upBid: up.bestBid, dnBid: down.bestBid,
    up, down, bz, cl: 100 };
}

test("recorded:false replay keeps entries fixed-USD and opposing hedges exact-share", () => {
  const ticks = [
    tick(60, 0.50, 0.50, 100),
    tick(65, 0.52, 0.48, 101, [[0.52, 10], [0.53, 20]]),
    tick(65.52, 0.53, 0.47, 101.1, [[0.53, 6], [0.54, 50]]),
    tick(66, 0.52, 0.48, 101),
    tick(71, 0.42, 0.43, 99, undefined, [[0.43, 20], [0.44, 20]]),
    tick(71.52, 0.43, 0.44, 98.9, undefined, [[0.44, 20]]),
  ];
  const fills = simulateFills({ ticks, openBinance: 100, openPrice: 100, windowStart: 0 }, {
    LATENCY_MS: 520, STALE_GAP_MS: 10000, H_COOLDOWN_MS: 0,
    H_MID_VELOCITY_MIN: 0.01,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5000, H_BINANCE_GAP_VELOCITY_MIN: 0.01,
    H_BINANCE_TREND_ON: false, H_HEDGE_ON: true, H_REVERSAL_ON: false,
  });
  assert.equal(fills.length, 5);
  assert.deepEqual(fills.map((f) => [f.side, f.role, f.shares, f.effPx, f.decidedT, f.tInto, f.status]), [
    ["Up", "entry", 6, 0.53, 65, 65.52, "partial"],
    ["Up", "entry", 7.2692, 0.52, 65.52, 66.03999999999999, "full"],
    ["Up", "entry", 7.1346, 0.52, 66, 66.52, "full"],
    ["Down", "hedge", 7, 0.44, 71, 71.52, "full"],
    ["Down", "hedge", 7, 0.44, 71.52, 72.03999999999999, "full"],
  ]);
  assert.equal(fills[0].requestedBudgetUsd, 3.71);
  assert.ok(fills.slice(0, 3).every((f) => f.amountMode === "usd" && f.leg === "entry"));
  assert.ok(fills.slice(3).every((f) => f.amountMode === "shares" && f.leg === "hedge"));
});

test("BBA-only historical ticks cannot fabricate Helpme L2 liquidity", () => {
  const ticks = [
    { t: 60, upAsk: 0.50, dnAsk: 0.50, bz: 100.1, cl: 100 },
    { t: 65, upAsk: 0.52, dnAsk: 0.48, bz: 100.1, cl: 100 },
  ];
  assert.deepEqual(simulateFills({ ticks, openBinance: 100, openPrice: 100 },
    { LATENCY_MS: 520, H_BINANCE_TREND_ON: false }), []);
});
