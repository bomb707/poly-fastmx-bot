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

test("a one-sided coherent frame can trade only the side with real L2 liquidity", () => {
  const first = tick(0, 0.50, 0.50, 100);
  const up = side(0.52, 0.50, [[0.52, 30], [0.53, 30]]);
  const down = { bestAsk: null, bestBid: 0.48, asks: [], bids: [[0.48, 50]], depthKnown: false };
  const oneSided = { t: 5, ms: 5000, upAsk: 0.52, dnAsk: null,
    upBid: 0.50, dnBid: 0.48, up, down, bz: 110, cl: 100 };
  const fills = simulateFills({ ticks: [first, oneSided], openBinance: 100,
    openPrice: 100, windowStart: 0 }, {
    LATENCY_MS: 0, H_BINANCE_TREND_ON: false,
    H_MID_VELOCITY_MIN: 0.02, H_BINANCE_GAP_VELOCITY_MIN: 5,
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, "Up");
});

test("replay inventory economics include fees already paid by completed fills", () => {
  const ticks = [
    tick(0, 0.50, 0.50, 100),
    tick(1, 0.52, 0.48, 101),
    tick(2, 0.48, 0.45, 99),
  ];
  const fills = simulateFills({ ticks, openBinance: 100, openPrice: 100,
    windowStart: 0 }, {
    LATENCY_MS: 0, H_COOLDOWN_MS: 0,
    H_MID_VELOCITY_LOOKBACK_MS: 1000, H_MID_VELOCITY_MIN: 0.01,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 1000, H_BINANCE_GAP_VELOCITY_MIN: 0.01,
    H_BINANCE_TREND_ON: true, H_BINANCE_TREND_LOOKBACK_SEC: 1,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 1,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.05,
    H_HEDGE_ON: false, H_REVERSAL_ON: true, H_REVERSAL_CONFIRM_MS: 0,
    H_REVERSAL_MIN_PAIR_EDGE: -0.01,
    H_REVERSAL_MAX_WORST_LOSS_USD: 100, H_REVERSAL_MAX_ORDER_SH: 50,
  });
  assert.deepEqual(fills.map((fill) => [fill.side, fill.role]), [["Up", "entry"]]);
});

test("completed inventory transitions from entry through hedge into a confirmed reversal", () => {
  const ticks = [
    tick(0, 0.50, 0.50, 100),
    tick(1, 0.52, 0.48, 101),
    tick(2, 0.48, 0.45, 99),
    tick(3, 0.44, 0.45, 98),
  ];
  const fills = simulateFills({ ticks, openBinance: 100, openPrice: 100, windowStart: 0 }, {
    LATENCY_MS: 0, H_START_S: 0, H_COOLDOWN_MS: 0,
    H_MID_VELOCITY_LOOKBACK_MS: 1000, H_MID_VELOCITY_MIN: 0.01,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 1000, H_BINANCE_GAP_VELOCITY_MIN: 0.01,
    H_BINANCE_TREND_ON: true, H_BINANCE_TREND_LOOKBACK_SEC: 1,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 1,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.05,
    H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: true, H_REVERSAL_ON: true,
    H_REVERSAL_CONFIRM_MS: 1000, H_REVERSAL_MIN_PAIR_EDGE: -0.1,
    H_REVERSAL_MAX_WORST_LOSS_USD: 10, H_REVERSAL_MAX_ORDER_SH: 50,
  });

  assert.deepEqual(fills.map((fill) => [fill.side, fill.role]), [
    ["Up", "entry"],
    ["Down", "hedge"],
    ["Down", "reversal"],
  ]);
  const up = fills.filter((fill) => fill.side === "Up").reduce((n, fill) => n + fill.shares, 0);
  const down = fills.filter((fill) => fill.side === "Down").reduce((n, fill) => n + fill.shares, 0);
  assert.ok(Math.abs(down - up - 10) < 1e-9);
});
