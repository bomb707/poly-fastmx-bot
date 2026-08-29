import test from "node:test";
import assert from "node:assert/strict";

import { STRAT, buildFeatures, fairProbability, step, injectRealFill, clearLivePending } from "./wallet3048.js";
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
  W3048_BETA_MOMENTUM: 1,
  W3048_BETA_RELATIVE_LEAD: 0,
  W3048_BETA_CHAINLINK_DISTANCE: 0,
  W3048_BETA_CLOB: 0,
  W3048_BETA_TIME_CHAINLINK: 0,
  W3048_LARGE_EDGE: 1,
};

test("causal features implement the report's momentum and relative-lead definitions", () => {
  const model = { history: [] };
  buildFeatures(model, tick(5, { bz: 100, cl: 100 }), signalP, 5000);
  const f = buildFeatures(model, tick(10, { bz: 101, cl: 100.25 }), signalP, 10000);
  assert.ok(Math.abs(f.momentum5s - Math.log(101 / 100)) < 1e-12);
  assert.ok(Math.abs(f.relativeLead - (Math.log(101 / 100) - Math.log(100.25 / 100))) < 1e-12);
  assert.ok(fairProbability(f, signalP) > 0.9);
});

test("initial signal submits an exact 50-share prebuilt non-post-only GTC rung", () => {
  const state = {};
  const [order] = step(state, tick(5), signalP, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.shares, 50);
  assert.equal(order.reason, "w3048-initial-release");
  assert.equal(order.orderType, "GTC");
  assert.equal(order.postOnly, false);
  assert.equal(order.prepared, true);
  assert.equal(order.preparedLeadMs, 90000);
  assert.equal(order.limitPx, 0.40);
  assert.deepEqual(state.wallet3048.preparedMenu.sizes, [50, 150]);
});

test("150-share parent is the catch-up branch, while a new cycle starts at 50", () => {
  const fresh = {};
  const [small] = step(fresh, tick(5), signalP, 120, 5000);
  assert.equal(small.shares, 50);

  const catchup = { fills: [{ side: "Up", shares: 200, effPx: 0.40, leg: "entry", maker: false }] };
  const [large] = step(catchup, tick(5, { bz: 99, downAsk: 0.55, upAsk: 0.46 }), signalP, 120, 5000);
  assert.equal(large.side, "Down");
  assert.equal(large.shares, 150);
});

test("opposite inventory records FIFO economics but uses the exact ask, even above pair cap", () => {
  const state = { fills: [{ side: "Up", shares: 50, effPx: 0.40, leg: "entry", maker: false }] };
  const [hedge] = step(state, tick(7, { bz: 99, downAsk: 0.80, upAsk: 0.91 }), signalP, 120, 7000);
  assert.equal(hedge.side, "Down");
  assert.equal(hedge.shares, 50);
  assert.equal(hedge.leg, "hedge");
  assert.equal(hedge.reason, "w3048-inventory-repair");
  assert.ok(hedge.signal.pairCap < hedge.signal.signalCap);
  assert.equal(hedge.limitPx, 0.80);
  assert.ok(hedge.signal.pairCost > 1);
  assert.ok(hedge.signal.worstCaseImprovement > 0);
});

test("CLOB release gate waits for a persistent thin, depleting ask", () => {
  const state = {};
  const P = { ...signalP, W3048_RELEASE_GATE: true };
  assert.deepEqual(step(state, tick(5), P, 120, 5000), []);
  assert.equal(state.gateReason, "w3048-no-release");
  const pressured = tick(6.1);
  pressured.up = side(0.40, 20);
  const [order] = step(state, pressured, P, 120, 6100);
  assert.equal(order.side, "Up");
  assert.equal(order.signal.releaseMode, "thin-depletion");
  assert.ok(order.signal.executableRunMs >= 525);
  assert.ok(order.signal.depletion1 <= -110);
});

test("a completed hedge rearms the same loop for another entry/cross cycle", () => {
  const state = {};
  const [first] = step(state, tick(5), signalP, 120, 5000);
  state.fills = [{ side: first.side, shares: 50, effPx: 0.40, leg: "entry", maker: false }];
  const [repair] = step(state, tick(7, { bz: 99, downAsk: 0.80, upAsk: 0.21 }), signalP, 120, 7000);
  state.fills.push({ side: repair.side, shares: 50, effPx: 0.80, leg: "hedge", maker: false });
  const [next] = step(state, tick(9, { bz: 101, upAsk: 0.30, downAsk: 0.71 }), signalP, 120, 9000);
  assert.equal(next.side, "Up");
  assert.equal(next.leg, "entry");
  assert.equal(next.reason, "w3048-cycle-entry");
});

test("the final 30 seconds are a hard no-order interval", () => {
  const state = {};
  assert.deepEqual(step(state, tick(270.01), signalP, 120, 270010), []);
  assert.equal(state.gateReason, "w3048-time");
});

test("live inventory advances only from confirmed partial fills and clears on cancel", () => {
  const state = {};
  const P = { ...signalP, LIVE_FILLS: true };
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
  const historical = (t, upAsk, upDepth) => {
    const up = side(upAsk, upDepth), down = side(1.01 - upAsk, 300);
    return { t, upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk, dnBid: down.bestBid,
      up, down, bz: 101, cl: 100 };
  };
  const fills = simulateFills({
    openBinance: 100,
    openPrice: 100,
    windowStart: 0,
    ticks: [historical(5, 0.40, 10), historical(6, 0.40, 100), historical(7, 0.40, 100)],
  }, { ...signalP, STRATEGY: "wallet3048", W3048_COOLDOWN_MS: 10000,
    W3048_SIM_TOUCH_FILL_PCT: 100 });
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 50);
  assert.equal(fills.length, 2, "resting accrual is emitted once, not once per book tick");
  assert.equal(fills[0].status, "partial");
  assert.ok(fills.slice(1).every((fill) => fill.maker === true && fill.exec === "resting"));
  assert.equal(new Set(fills.map((fill) => fill.oid)).size, 1);
});
