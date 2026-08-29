import test from "node:test";
import assert from "node:assert/strict";

import { STRAT, buildFeatures, fairProbability, step, injectRealFill, clearLivePending,
  shouldCancelResting } from "./wallet3048.js";
import { simulateFills } from "../simrun.js";

const levels = (rows) => rows.map(([price, size]) => [price, size]);
function side(ask, depth = 300) {
  return {
    bestAsk: ask,
    bestBid: +(ask - 0.01).toFixed(2),
    asks: levels([[ask, depth], [+(ask + 0.01).toFixed(2), depth], [+(ask + 0.02).toFixed(2), depth]]),
    bids: levels([[+(ask - 0.01).toFixed(2), depth], [+(ask - 0.02).toFixed(2), depth],
      [+(ask - 0.03).toFixed(2), depth]]),
  };
}
function tick(t, { bz = 101, cl = 100, upAsk = 0.40, downAsk = 0.61, depth = 300 } = {}) {
  return { t, bzPrice: bz, clPrice: cl, openBinance: 100, openChainlink: 100,
    up: side(upAsk, depth), down: side(downAsk, depth) };
}
const signalP = {
  ...STRAT,
  LATENCY_MS: 0,
  W3048_COOLDOWN_MS: 1500,
  W3048_RELEASE_GATE: false,
  W3048_CROSS_HEADROOM_TICKS: 1,
  W3048_BETA_MOMENTUM: 1,
  W3048_BETA_MARKET_LOGIT: 0,
  W3048_BETA_LATEST_UPDATE: 0,
  W3048_BETA_RELATIVE_LEAD: 0,
  W3048_BETA_CHAINLINK_DISTANCE: 0,
  W3048_BETA_CLOB: 0,
  W3048_BETA_TIME_CHAINLINK: 0,
  W3048_EDGE_BUFFER: 0,
  W3048_MIN_EXPECTED_EDGE_START: 0,
  W3048_MIN_EXPECTED_EDGE_END: 0,
  W3048_LARGE_EDGE: 1,
};

function prime(state, P = signalP, at = 4500) {
  assert.deepEqual(step(state, tick(at / 1000, { bz: 100 }), P, 120, at), []);
}

test("causal features use the corrected 0.5-second Binance momentum and relative lead", () => {
  const model = { history: [] };
  buildFeatures(model, tick(4.5, { bz: 100, cl: 100 }), signalP, 4500);
  const f = buildFeatures(model, tick(5, { bz: 101, cl: 100.25 }), signalP, 5000);
  assert.ok(Math.abs(f.momentumFast - Math.log(101 / 100)) < 1e-12);
  assert.ok(Math.abs(f.relativeLead - (Math.log(101 / 100) - Math.log(100.25 / 100))) < 1e-12);
  assert.ok(fairProbability(f, signalP) > 0.9);
});

test("initial signal submits an exact 50-share prebuilt non-post-only GTC rung", () => {
  const state = {};
  prime(state);
  const [order] = step(state, tick(5), signalP, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.shares, 50);
  assert.equal(order.reason, "w3048-initial-release");
  assert.equal(order.orderType, "GTC");
  assert.equal(order.postOnly, false);
  assert.equal(order.prepared, true);
  assert.equal(order.preparedLeadMs, 90000);
  assert.equal(order.limitPx, 0.41);
  assert.equal(order.signal.expectedRole, "taker");
  assert.deepEqual(state.wallet3048.preparedMenu.sizes, [50, 150]);
  assert.equal(state.wallet3048.preparedMenu.prices.at(0), 0.01);
  assert.equal(state.wallet3048.preparedMenu.prices.at(-1), 0.99);
});

test("150-share parent requires strong edge, executable depth, and risk capacity", () => {
  const fresh = {};
  prime(fresh);
  const [small] = step(fresh, tick(5), signalP, 120, 5000);
  assert.equal(small.shares, 50);

  const strong = {};
  const P = { ...signalP, W3048_LARGE_EDGE: 0.035, W3048_LARGE_MIN_DEPTH: 150 };
  prime(strong, P);
  const [large] = step(strong, tick(5, { depth: 300 }), P, 120, 5000);
  assert.equal(large.shares, 150);
});

test("FIFO pair completion enforces the lot-aware pair cap", () => {
  const state = { fills: [{ side: "Up", shares: 50, effPx: 0.40, leg: "entry", maker: false }] };
  const P = { ...signalP, W3048_BETA0: -4 };
  const [hedge] = step(state, tick(7, { bz: 99, downAsk: 0.50, upAsk: 0.51 }), P, 120, 7000);
  assert.equal(hedge.side, "Down");
  assert.equal(hedge.shares, 50);
  assert.equal(hedge.leg, "hedge");
  assert.equal(hedge.reason, "w3048-pair-completion");
  assert.ok(hedge.signal.pairCap < hedge.signal.signalCap);
  assert.ok(hedge.limitPx <= hedge.signal.pairCap);
  assert.ok(hedge.signal.pairCost < 1);
  assert.ok(hedge.signal.worstCaseImprovement > 0);
});

test("an above-$1 complement is a separate signal-supported loss-cap repair", () => {
  const state = { fills: [{ side: "Up", shares: 50, effPx: 0.40, leg: "entry", maker: false }] };
  const P = { ...signalP, W3048_BETA0: -4 };
  const [repair] = step(state, tick(7, { bz: 99, downAsk: 0.80, upAsk: 0.21 }), P, 120, 7000);
  assert.equal(repair.reason, "w3048-loss-cap-repair");
  assert.equal(repair.shares, 50, "risk relief alone must not promote a repair to 150 shares");
  assert.equal(repair.signal.pairingIntended, false);
  assert.ok(repair.signal.pairCost > 1);
  assert.ok(repair.signal.riskAdjustedEdge >= repair.signal.minimumEdge);
});

test("a causal fast-Binance entry does not wait for its own post-fill depth drop", () => {
  const state = {};
  const P = { ...signalP, W3048_RELEASE_GATE: true };
  prime(state, P);
  const [order] = step(state, tick(5), P, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.signal.releaseMode, "disabled");
  assert.ok(order.signal.momentumFast > 0);
});

test("a completed hedge rearms the same loop for another entry/cross cycle", () => {
  const state = {};
  prime(state);
  const [first] = step(state, tick(5), signalP, 120, 5000);
  state.fills = [{ side: first.side, shares: 50, effPx: 0.40, leg: "entry", maker: false }];
  const downP = { ...signalP, W3048_BETA0: -4 };
  const [repair] = step(state, tick(7, { bz: 99, downAsk: 0.50, upAsk: 0.51 }), downP, 120, 7000);
  state.fills.push({ side: repair.side, shares: 50, effPx: 0.80, leg: "hedge", maker: false });
  const [next] = step(state, tick(9, { bz: 101, upAsk: 0.30, downAsk: 0.71 }), signalP, 120, 9000);
  assert.equal(next.side, "Up");
  assert.equal(next.leg, "entry");
  assert.equal(next.reason, "w3048-directional-reinforcement");
});

test("the final 30 seconds are a hard no-order interval", () => {
  const state = {};
  assert.deepEqual(step(state, tick(270.01), signalP, 120, 270010), []);
  assert.equal(state.gateReason, "w3048-time");

  const inFlight = {};
  const delayed = { ...signalP, LATENCY_MS: 520 };
  prime(inFlight, delayed);
  assert.deepEqual(step(inFlight, tick(269.6), delayed, 120, 269600), []);
  assert.equal(inFlight.gateReason, "w3048-time", "an order may not arrive inside the cutoff");
});

test("live inventory advances only from confirmed partial fills and clears on cancel", () => {
  const state = {};
  const P = { ...signalP, LIVE_FILLS: true };
  prime(state, P);
  const [order] = step(state, tick(5), P, 120, 5000);
  assert.equal(state.wallet3048.up, 0);
  assert.equal(state.wallet3048.pending.size, 1);
  injectRealFill(state, { oid: order.oid, side: "Up", shares: 20, px: 0.40 });
  assert.equal(state.wallet3048.up, 20);
  assert.equal(state.wallet3048.pending.size, 1);
  clearLivePending(state, order.oid);
  assert.equal(state.wallet3048.pending.size, 0);
});

test("backtest keeps a partial GTC remainder resting and models later maker fills", () => {
  const historical = (t, upAsk, upDepth, bz = 101) => {
    const up = side(upAsk, upDepth), down = side(1.01 - upAsk, 300);
    return { t, upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk, dnBid: down.bestBid,
      up, down, bz, cl: 100 };
  };
  const fills = simulateFills({
    openBinance: 100,
    openPrice: 100,
    windowStart: 0,
    ticks: [historical(4.5, 0.40, 100, 100), historical(5, 0.40, 10),
      historical(6, 0.40, 100), historical(7, 0.40, 100)],
  }, { ...signalP, STRATEGY: "wallet3048", W3048_COOLDOWN_MS: 10000,
    W3048_CROSS_HEADROOM_TICKS: 0, W3048_SIM_TOUCH_FILL_PCT: 100 });
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 50);
  assert.equal(fills.length, 2, "resting accrual is emitted once, not once per book tick");
  assert.equal(fills[0].status, "partial");
  assert.ok(fills.slice(1).every((fill) => fill.maker === true && fill.exec === "resting"));
  assert.equal(new Set(fills.map((fill) => fill.oid)).size, 1);
});

test("resting orders are canceled when their economic cap moves below the signed rung", () => {
  const state = { fills: [{ side: "Up", shares: 50, effPx: 0.40, leg: "entry", maker: false }] };
  const rec = { side: "Down", shares: 50, requestedShares: 50, limitPx: 0.80 };
  const P = { ...signalP, W3048_BETA0: 4 };
  const check = shouldCancelResting(state, rec,
    tick(20, { bz: 101, downAsk: 0.80, upAsk: 0.21 }), P, 20000);
  assert.equal(check.cancel, true);
  assert.equal(check.reason, "economic-cap-moved");
  assert.ok(check.currentCap < rec.limitPx);
});
