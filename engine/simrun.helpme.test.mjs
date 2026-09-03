import test from "node:test";
import assert from "node:assert/strict";
import { positionFromFills, simulateFills } from "./simrun.js";

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
    H_SESSION_POLICY_ON: false, H_DYNAMIC_SIZE_ON: false,
    H_RISK_LIMITS_ON: false, H_PARTICIPATION_ON: false,
    H_RESCUE_MAKER_ON: false,
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

test("replay carries resolved taker fees into the next hard-loss projection", () => {
  const deep = (ask) => [[ask, 500]];
  const ticks = [
    tick(60, 0.15, 0.85, 100, deep(0.15), deep(0.85)),
    tick(61, 0.18, 0.82, 100, deep(0.18), deep(0.82)),
    tick(63, 0.20, 0.80, 100, deep(0.20), deep(0.80)),
    tick(65, 0.22, 0.78, 100, deep(0.22), deep(0.78)),
    tick(67, 0.24, 0.76, 100, deep(0.24), deep(0.76)),
  ];
  const fills = simulateFills({ ticks, openBinance: 100, openPrice: 100, windowStart: 0 }, {
    LATENCY_MS: 0, STALE_GAP_MS: 10_000,
    H_SESSION_POLICY_ON: false, H_START_S: 60, H_STOP_S: 239,
    H_COOLDOWN_MS: 0, H_MID_VELOCITY_LOOKBACK_MS: 1_000,
    H_MID_VELOCITY_MIN: 0.01, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: false, H_DYNAMIC_SIZE_ON: true,
    H_ENTRY_RISK_USD: 4, H_RISK_LIMITS_ON: true,
    H_MAX_SIGNAL_ORDERS: 4, H_MAX_ORDER_SH: 100,
    H_MAX_GROSS_SH: 500, H_MAX_ROUND_COST_USD: 250,
    H_MAX_ROUND_WORST_LOSS_USD: 10, H_PARTICIPATION_ON: false,
    H_RESCUE_MAKER_ON: false,
  });
  const position = positionFromFills(fills, "Down", ticks);
  assert.ok(fills.length >= 2);
  assert.ok(-position.realizedPnl <= 10.0001,
    `realized loss ${position.realizedPnl} exceeded the configured ceiling`);
});

test("replay books rescue makers only when the ask later touches their resting limits", () => {
  const deep = (ask) => [[ask, 400]];
  const ticks = [
    tick(0, 0.50, 0.50, 100, deep(0.50), deep(0.50)),
    tick(5, 0.60, 0.40, 101, deep(0.60), deep(0.40)),
    tick(270, 0.90, 0.10, 101, deep(0.90), deep(0.10)),
    tick(270.2, 0.90, 0.10, 101, deep(0.90), deep(0.10)),
    tick(271, 0.98, 0.02, 101, deep(0.98), deep(0.02)),
    tick(272, 0.99, 0.01, 101, deep(0.99), deep(0.01)),
  ];
  const fills = simulateFills({ ticks, openBinance: 100, openPrice: 100, windowStart: 0 }, {
    LATENCY_MS: 0, STALE_GAP_MS: 300_000, H_COOLDOWN_MS: 0,
    H_SESSION_POLICY_ON: false, H_DYNAMIC_SIZE_ON: false,
    H_PARTICIPATION_ON: false,
    H_STOP_S: 239,
    H_BINANCE_GAP_MOMENTUM_ON: false, H_BINANCE_TREND_ON: false,
    H_MID_VELOCITY_MIN: 0.01, H_BASE_ORDER_SH: 200,
    H_MAX_ORDER_SH: 250, H_MAX_GROSS_SH: 500,
    H_MAX_ROUND_COST_USD: 250, H_MAX_ROUND_WORST_LOSS_USD: 200,
    H_RESCUE_MAKER_ON: true, H_RESCUE_START_S: 270,
    H_RESCUE_END_S: 299, H_RESCUE_TOTAL_RISK_USD: 2,
    H_RESCUE_RETAIN_SH: 25,
  });
  assert.deepEqual(fills.map((fill) => [fill.leg, fill.side, fill.effPx, fill.shares, fill.tInto]), [
    ["entry", "Up", 0.6, 203.3333, 5],
    ["rescue", "Down", 0.02, 50, 271],
    ["rescue", "Down", 0.01, 100, 272],
  ]);
  assert.ok(fills.slice(1).every((fill) => fill.exec === "maker" && fill.maker));
});
