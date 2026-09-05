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

const BINANCE_ONLY = { H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_TREND_ON: false,
  H_BINANCE_GAP_AGREE_ON: false, H_STOP_S: 300, H_COOLDOWN_MS: 2000 };

for (const latency of [500, 520]) {
  test(`replay rejects an arrival ${latency === 500 ? 'at' : 'after'} market expiry`, () => {
    const ticks = [tick(296, .5, .5, 100), tick(299.5, .5, .5, 106)];
    assert.deepEqual(simulateFills({ ticks, openBinance: 100 },
      { ...BINANCE_ONLY, LATENCY_MS: latency }), []);
  });
}

test('replay excludes boundary/post-window decisions even with zero latency', () => {
  const ticks = [tick(297, .5, .5, 100), tick(300, .5, .5, 106), tick(301, .5, .5, 112)];
  assert.deepEqual(simulateFills({ ticks, openBinance: 100 },
    { ...BINANCE_ONLY, H_STOP_S: 999, LATENCY_MS: 0 }), []);
});

test('replay retains a one-sided frame which removes pending arrival liquidity', () => {
  const empty = tick(3.4, .5, .5, 106);
  empty.upAsk = null; empty.up.bestAsk = null; empty.up.asks = [];
  const ticks = [tick(0, .5, .5, 100), tick(3, .5, .5, 106), empty, tick(3.6, .5, .5, 106)];
  assert.deepEqual(simulateFills({ ticks, openBinance: 100 }, BINANCE_ONLY), []);
});

test('replay uses the book at the deadline and never the first future frame', () => {
  const ticks = [tick(0, .5, .5, 100), tick(3, .5, .5, 106),
    tick(3.519, .5, .5, 107, [[.5, 4]]), tick(3.521, .6, .5, 120)];
  const [fill] = simulateFills({ ticks, openBinance: 100 }, BINANCE_ONLY);
  assert.equal(fill.shares, 4); assert.equal(fill.usdc, 2); assert.equal(fill.bz, 107);
  ticks[2].t = 3.52;
  assert.equal(simulateFills({ ticks, openBinance: 100 }, BINANCE_ONLY)[0].shares, 4);
});

test('replay cannot extrapolate a stale final book through a long latency', () => {
  const ticks = [tick(0, .5, .5, 100), tick(3, .5, .5, 106)];
  assert.deepEqual(simulateFills({ ticks, openBinance: 100 },
    { ...BINANCE_ONLY, LATENCY_MS: 7000 }), []);
});

test('replay rejects stale or future CLOB receive timestamps carried by fresh frames', () => {
  for (const depthTs of [-5000, 5000]) {
    const ticks = [tick(0, .5, .5, 100), tick(3, .5, .5, 106)];
    ticks[1].up.depthTs = depthTs;
    assert.deepEqual(simulateFills({ ticks, openBinance: 100 }, BINANCE_ONLY), []);
  }
});

test('a pre-expiry final arrival remains depth-limited and causally timestamped', () => {
  const ticks = [tick(296, .5, .5, 100), tick(299.2, .5, .5, 106, [[.5, 4]])];
  const [f] = simulateFills({ ticks, openBinance: 100 }, BINANCE_ONLY);
  assert.equal(f.shares, 4); assert.equal(f.usdc, 2); assert.equal(f.status, 'partial');
  assert.ok(Math.abs(f.tInto - 299.72) < 1e-9);
});
