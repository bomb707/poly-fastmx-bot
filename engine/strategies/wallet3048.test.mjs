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
  W3048_DIRECTIONAL_OVERLAY_ON: true,
};

function prime(state, P = signalP, at = 2500, overrides = {}) {
  assert.deepEqual(step(state, tick(at / 1000,
    { bz: 100, upAsk: 0.42, downAsk: 0.59, ...overrides }), P, 120, at), []);
}

test("causal features use 2.5-second Binance momentum and the lagging Polymarket token", () => {
  const model = { history: [], polyHistory: [] };
  buildFeatures(model, tick(2.5, { bz: 100, cl: 100, upAsk: 0.42, downAsk: 0.59 }), signalP, 2500);
  const f = buildFeatures(model, tick(5, { bz: 101, cl: 100.25 }), signalP, 5000);
  assert.ok(Math.abs(f.momentumFast - Math.log(101 / 100)) < 1e-12);
  assert.ok(Math.abs(f.relativeLead - (Math.log(101 / 100) - Math.log(100.25 / 100))) < 1e-12);
  assert.ok(f.polyUpMove < 0);
  assert.equal(f.lagDirection, "Up");
  assert.ok(fairProbability(f, signalP) > 0.9);
});

test("initial signal submits an exact 50-share prebuilt non-post-only GTC rung", () => {
  const state = {};
  prime(state);
  const [order] = step(state, tick(5), signalP, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.shares, 50);
  assert.equal(order.reason, "w3048-initial-catchup");
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

test("150-share conviction parent requires an existing core, strong persistent catch-up, and depth", () => {
  const fresh = {};
  prime(fresh);
  const [small] = step(fresh, tick(5), signalP, 120, 5000);
  assert.equal(small.shares, 50);

  const strong = { fills: [
    { side: "Up", shares: 50, effPx: 0.30, leg: "entry", maker: false },
    { side: "Down", shares: 50, effPx: 0.60, leg: "hedge", maker: false },
  ] };
  const P = { ...signalP, W3048_LARGE_EDGE: 0.035, W3048_LARGE_MIN_DEPTH: 150 };
  prime(strong, P);
  const [large] = step(strong, tick(5, { depth: 300 }), P, 120, 5000);
  assert.equal(large.shares, 150);
  assert.equal(large.reason, "w3048-strong-catchup");
  assert.equal(large.signal.sizeMode, "strong-catchup");

  const shallow = { fills: [
    { side: "Up", shares: 50, effPx: 0.30, leg: "entry", maker: false },
    { side: "Down", shares: 50, effPx: 0.60, leg: "hedge", maker: false },
  ] };
  prime(shallow, P);
  const [fallback] = step(shallow, tick(5, { depth: 40 }), P, 120, 5000);
  assert.equal(fallback.shares, 50);
  assert.equal(fallback.signal.sizeMode, "standard");
});

test("an independently undervalued initial rung may follow Binance without pretending to be a lag entry", () => {
  const state = {};
  prime(state, signalP, 2500, { upAsk: 0.38, downAsk: 0.63 });
  const [entry] = step(state, tick(5, { bz: 101, upAsk: 0.40, downAsk: 0.61 }),
    signalP, 120, 5000);
  assert.equal(entry.reason, "w3048-initial-value");
  assert.equal(entry.signal.lagDirection, null);
  assert.ok(entry.signal.polyUpMove > 0);
});

test("only one initial parent may be outstanding before inventory is confirmed", () => {
  const state = {};
  const P = { ...signalP, LIVE_FILLS: true, W3048_COOLDOWN_MS: 0 };
  prime(state, P);
  const [first] = step(state, tick(5), P, 120, 5000);
  assert.ok(first);
  assert.deepEqual(step(state, tick(5.5), P, 120, 5500), []);
  assert.equal(state.gateReason, "w3048-await-initial-fill");
});

test("an optional pending complement cannot authorize an unsafe directional addition", () => {
  const state = {
    fills: [{ side: "Up", shares: 100, effPx: 0.20, leg: "entry", maker: false }],
    pendingFills: [{ phase: "resting", remaining: 150,
      rec: { side: "Down", shares: 150, requestedShares: 150, limitPx: 0.10 } }],
  };
  const P = { ...signalP, W3048_BETA0: 4,
    W3048_MAX_LEAN_START: 120, W3048_MAX_LEAN_END: 120,
    W3048_FLOOR_DRAWDOWN_START: 1000, W3048_FLOOR_DRAWDOWN_END: 1000 };
  prime(state, P, 2500, { upAsk: 0.22, downAsk: 0.79 });
  const orders = step(state,
    tick(5, { bz: 101, upAsk: 0.20, downAsk: 0.81 }), P, 120, 5000);
  assert.ok(orders.every((order) => order.side !== "Up"),
    "the pending Down order must not be treated as an assured hedge for another Up buy");
  assert.ok(orders.every((order) => order.signal.projectedLean <= 120));
});

test("one pending parent reserves a small imbalance from duplicate repair orders", () => {
  const state = {
    fills: [{ side: "Down", shares: 5.985, effPx: 0.25, leg: "entry", maker: true }],
    pendingFills: [{ phase: "resting", remaining: 50, makerShares: 0,
      rec: { side: "Up", shares: 50, requestedShares: 50, limitPx: 0.72 } }],
  };
  const P = { ...signalP, W3048_COOLDOWN_MS: 0, W3048_DIRECTIONAL_OVERLAY_ON: false };
  prime(state, P);
  const orders = step(state, tick(5), P, 120, 5000);
  assert.deepEqual(orders, [],
    "a 50-share UP remainder already owns the 5.985-share DOWN shortage");
});

test("unflushed maker accrual is confirmed inventory for the next decision", () => {
  const state = {
    fills: [{ side: "Down", shares: 5.985, effPx: 0.25, leg: "entry", maker: true }],
    pendingFills: [{ phase: "resting", remaining: 25, makerShares: 25,
      rec: { side: "Up", shares: 50, requestedShares: 50, limitPx: 0.40 } }],
  };
  const P = { ...signalP, W3048_COOLDOWN_MS: 0, W3048_DIRECTIONAL_OVERLAY_ON: false,
    W3048_BETA0: -4, W3048_BETA_MOMENTUM: 0 };
  prime(state, P, 2500, { upAsk: 0.81, downAsk: 0.20 });
  const [repair] = step(state,
    tick(5, { bz: 100, upAsk: 0.81, downAsk: 0.20 }), P, 120, 5000);
  assert.equal(repair.side, "Down");
  assert.equal(repair.reason, "w3048-pair-completion");
  assert.ok(Math.abs(repair.signal.priorLean - 19.015) < 1e-6);
  assert.ok(Math.abs(repair.signal.matchedShares - 19.015) < 1e-6);
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
  assert.equal(repair.shares, 50, "a 50-share lean is below the emergency geometry for a 150-share repair");
  assert.equal(repair.signal.pairingIntended, false);
  assert.ok(repair.signal.pairCost > 1);
  assert.ok(repair.signal.riskAdjustedEdge >= repair.signal.minimumEdge);
});

test("150 shares complete a fully executable profitable FIFO pair", () => {
  const state = { fills: [{ side: "Up", shares: 150, effPx: 0.40, leg: "entry", maker: false }] };
  const P = { ...signalP, W3048_BETA0: -4, W3048_LARGE_EDGE: 0.035 };
  const [pair] = step(state, tick(7, { bz: 99, downAsk: 0.50, upAsk: 0.51, depth: 300 }),
    P, 120, 7000);
  assert.equal(pair.shares, 150);
  assert.equal(pair.reason, "w3048-large-pair-completion");
  assert.equal(pair.signal.sizeMode, "large-pair-completion");
  assert.equal(pair.signal.matchedShares, 150);
  assert.ok(pair.signal.pairCost < 1);
});

test("150-share inventory emergency must reduce lean and improve worst-case PnL", () => {
  const state = { fills: [{ side: "Up", shares: 150, effPx: 0.80, leg: "entry", maker: false }] };
  const P = { ...signalP, W3048_BETA0: -4, W3048_LARGE_EDGE: 1 };
  const [repair] = step(state, tick(7, { bz: 99, downAsk: 0.50, upAsk: 0.51, depth: 300 }),
    P, 120, 7000);
  assert.equal(repair.shares, 150);
  assert.equal(repair.reason, "w3048-inventory-emergency");
  assert.equal(repair.signal.sizeMode, "inventory-emergency");
  assert.ok(repair.signal.projectedLean < repair.signal.priorLean);
  assert.ok(repair.signal.worstCaseImprovement > 0);
  assert.ok(repair.signal.pairCost > 1);
});

test("a 150-share complement can rest as a full-fill-safe passive reservoir", () => {
  const state = { fills: [{ side: "Up", shares: 150, effPx: 0.30, leg: "entry", maker: false }] };
  const P = { ...signalP, W3048_BETA0: -0.85, W3048_LARGE_EDGE: 1 };
  const [reservoir] = step(state,
    tick(7, { bz: 100, downAsk: 0.75, upAsk: 0.26, depth: 300 }), P, 120, 7000);
  assert.equal(reservoir.shares, 150);
  assert.equal(reservoir.reason, "w3048-passive-reservoir");
  assert.equal(reservoir.signal.sizeMode, "passive-reservoir");
  assert.equal(reservoir.signal.expectedRole, "maker");
  assert.equal(reservoir.restTimeoutMs, P.W3048_RESERVOIR_TIMEOUT_MS);
  assert.ok(reservoir.limitPx < 0.75);
  assert.ok(reservoir.signal.projectedLean < reservoir.signal.priorLean);
  assert.ok(reservoir.signal.worstCaseImprovement > 0);
});

test("the unverified broad directional overlay is disabled in production defaults", () => {
  assert.equal(STRAT.W3048_DIRECTIONAL_OVERLAY_ON, false);
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

test("a completed pair can rearm the 2.5-second catch-up loop", () => {
  const state = { fills: [
    { side: "Up", shares: 50, effPx: 0.40, leg: "entry", maker: false },
    { side: "Down", shares: 50, effPx: 0.50, leg: "hedge", maker: false },
  ] };
  prime(state);
  const [next] = step(state, tick(5, { bz: 101, upAsk: 0.30, downAsk: 0.71 }),
    signalP, 120, 5000);
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
    ticks: [historical(2.5, 0.42, 100, 100), historical(5, 0.40, 10),
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
