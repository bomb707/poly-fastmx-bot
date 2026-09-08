import test from "node:test";
import assert from "node:assert/strict";

import { STRAT, buildFeatures, fairProbability, step, injectRealFill, clearLivePending,
  shouldCancelResting, evaluateRiskScenarios, economicCaps, realizedVol } from "./wallet3048.js";
import { normalizeReplayTimestamp, positionFromFills, simulateFills } from "../simrun.js";

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
function timestampedTick(t, options) {
  const value = tick(t, options);
  const ms = t * 1000;
  value.binanceAtMs = ms;
  value.chainlinkAtMs = ms;
  value.up.depthTs = ms;
  value.down.depthTs = ms;
  return value;
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
  W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
};

function prime(state, P = signalP, at = 4500) {
  assert.deepEqual(step(state, tick(at / 1000, { bz: 100 }), P, 120, at), []);
}

test("replay timestamp normalization preserves explicit clock domains", () => {
  const windowStartMs = 1_725_000_000_000;
  assert.equal(normalizeReplayTimestamp(1_725_000_012_345, windowStartMs), 1_725_000_012_345);
  assert.equal(normalizeReplayTimestamp(1_725_000_012, windowStartMs), 1_725_000_012_000);
  assert.equal(normalizeReplayTimestamp(12_345, windowStartMs), windowStartMs + 12_345);
  assert.equal(normalizeReplayTimestamp(12_345), 12_345);
  assert.equal(normalizeReplayTimestamp("not-a-time", windowStartMs), null);
});

test("causal features use the corrected 0.5-second Binance momentum and relative lead", () => {
  const model = { history: [] };
  buildFeatures(model, tick(4.5, { bz: 100, cl: 100 }), signalP, 4500);
  const f = buildFeatures(model, tick(5, { bz: 101, cl: 100.25 }), signalP, 5000);
  assert.ok(Math.abs(f.momentumFast - Math.log(101 / 100)) < 1e-12);
  assert.ok(Math.abs(f.relativeLead - (Math.log(101 / 100) - Math.log(100.25 / 100))) < 1e-12);
  assert.ok(fairProbability(f, signalP) > 0.9);
});

test("stale Binance source timestamps expire momentum", () => {
  const model = { history: [] };
  const P = { ...signalP, W3048_BINANCE_STALE_MS: 1_000, W3048_IMPULSE_TTL_MS: 1_000 };
  buildFeatures(model, { ...tick(1, { bz: 100 }), binanceAtMs: 1_000 }, P, 1_000);
  buildFeatures(model, { ...tick(1.5, { bz: 101 }), binanceAtMs: 1_500 }, P, 1_500);
  const stale = buildFeatures(model,
    { ...tick(4, { bz: 101 }), binanceAtMs: 1_500 }, P, 4_000);
  assert.equal(stale.binanceFresh, false);
  assert.equal(stale.momentumSignal, 0);
});

test("fresh unchanged Binance updates do not refresh an old distinct-price impulse", () => {
  const model = { history: [] };
  const P = { ...signalP, W3048_BINANCE_STALE_MS: 1_000, W3048_IMPULSE_TTL_MS: 750 };
  buildFeatures(model, { ...tick(1, { bz: 100 }), binanceAtMs: 1_000 }, P, 1_000);
  buildFeatures(model, { ...tick(1.5, { bz: 101 }), binanceAtMs: 1_500 }, P, 1_500);
  const unchanged = buildFeatures(model,
    { ...tick(3, { bz: 101 }), binanceAtMs: 3_000 }, P, 3_000);
  assert.equal(unchanged.binanceFresh, true);
  assert.equal(unchanged.latestUpdate, 0);
  assert.equal(unchanged.momentumSignal, 0);
});

test("step reports freshness failures independently for every required source", () => {
  const P = { ...signalP, W3048_REQUIRE_SOURCE_TIMESTAMPS: true,
    W3048_BINANCE_STALE_MS: 1_000, W3048_CHAINLINK_STALE_MS: 1_000,
    W3048_DEPTH_STALE_MS: 1_000 };
  const cases = [
    ["binanceAtMs", "w3048-stale-binance"],
    ["chainlinkAtMs", "w3048-stale-chainlink"],
    ["up.depthTs", "w3048-stale-up-depth"],
    ["down.depthTs", "w3048-stale-down-depth"],
  ];
  for (const [field, reason] of cases) {
    const state = {};
    const value = timestampedTick(5);
    if (field.includes(".")) {
      const [parent, key] = field.split(".");
      value[parent][key] = 3_000;
    } else value[field] = 3_000;
    assert.deepEqual(step(state, value, P, 120, 5_000), []);
    assert.equal(state.gateReason, reason);
  }
});

test("realized volatility is invariant to repeated event sampling", () => {
  const sparse = [
    { ms: 0, bz: 100 }, { ms: 1000, bz: 101 },
    { ms: 2000, bz: 99 }, { ms: 3000, bz: 100 },
  ];
  const dense = [];
  for (let ms = 0; ms <= 3000; ms += 100) {
    dense.push({ ms, bz: ms < 1000 ? 100 : ms < 2000 ? 101 : ms < 3000 ? 99 : 100 });
  }
  assert.ok(Math.abs(realizedVol(sparse, 3000) - realizedVol(dense, 3000)) < 1e-12);
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

test("experimental incremental sizing is configurable and remains risk bounded", () => {
  const state = {};
  const P = { ...signalP, W3048_SIZE_MODE: "incremental",
    W3048_INCREMENTAL_MIN_SIZE: 5, W3048_INCREMENTAL_STEP: 5,
    W3048_INCREMENTAL_MAX_SIZE: 25 };
  prime(state, P);
  const [order] = step(state, tick(5, { depth: 300 }), P, 120, 5000);
  assert.equal(order.shares, 25);
  assert.equal(order.signal.riskScenarios, 1);
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
  assert.equal(hedge.signal.directionalExpectedPnl, 0,
    "matched pair shares do not also receive directional expected-PnL attribution");
  assert.ok(hedge.signal.pairExpectedPnl > 0);
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
  assert.ok(repair.signal.expectedPnlSacrifice >= 0);
});

test("pending opposite orders do not grant risk capacity before they fill", () => {
  const model = { up: 100, down: 0, cost: 40, fees: 0 };
  const state = { pendingFills: [{ phase: "resting", remaining: 100,
    rec: { oid: 7, side: "Down", shares: 100, limitPx: 0.5 } }] };
  const P = { ...STRAT, W3048_MAX_LEAN_START: 120, W3048_MAX_LEAN_END: 120,
    W3048_LOSS_LIMIT_START: 1_000, W3048_LOSS_LIMIT_END: 1_000,
    W3048_MAX_WINDOW_SPEND: 1_000 };
  const risk = evaluateRiskScenarios(model, state, "Up", 50, 0.4, P, 0);
  assert.equal(risk.passes, false);
  assert.ok(risk.scenarios.some((scenario) => !scenario.afterWithin));
  assert.ok(risk.scenarios.some((scenario) => scenario.filledOids.length === 0
    && scenario.after.lean === 150));
});

test("pending complements reserve confirmed FIFO-matchable inventory once", () => {
  const model = { up: 50, down: 0, cost: 20, fees: 0,
    lots: { Up: [{ shares: 50, effectivePrice: 0.4 }], Down: [] } };
  const state = { pendingFills: [{ phase: "resting", remaining: 50,
    rec: { oid: 8, side: "Down", shares: 50, limitPx: 0.5 } }] };
  const book = { ask: 0.5, bid: 0.49, asks: [{ price: 0.5, size: 200 }],
    bids: [{ price: 0.49, size: 200 }] };
  const caps = economicCaps(model, state, "Down", book, 0.8, 50, signalP, 0);
  assert.equal(caps.matchedShares, 0);
  assert.equal(caps.directionalShares, 50);
  assert.equal(caps.pairCap, null);
});

test("pending FIFO reservations leave the next complement on the next lot", () => {
  const model = { up: 100, down: 0, cost: 50, fees: 0,
    lots: { Up: [
      { lotId: "up-1", shares: 50, effectivePrice: 0.20 },
      { lotId: "up-2", shares: 50, effectivePrice: 0.80 },
    ], Down: [] } };
  const state = { pendingFills: [{ phase: "resting", remaining: 50,
    rec: { oid: 8, side: "Down", shares: 50, requestedShares: 50, limitPx: 0.5,
      pairReservation: [{ lotId: "up-1", shares: 50, effectivePrice: 0.20 }] } }] };
  const book = { ask: 0.10, bid: 0.09, asks: [{ price: 0.10, size: 200 }],
    bids: [{ price: 0.09, size: 200 }] };
  const caps = economicCaps(model, state, "Down", book, 0.9, 50, signalP, 0);
  assert.equal(caps.matchedShares, 50);
  assert.equal(caps.oppositeCost, 0.80);
  assert.deepEqual(caps.pairReservation.map(({ lotId, shares }) => ({ lotId, shares })),
    [{ lotId: "up-2", shares: 50 }]);
  state.pendingFills = [];
  const afterCancel = economicCaps(model, state, "Down", book, 0.9, 50, signalP, 0);
  assert.equal(afterCancel.oppositeCost, 0.20, "cancellation releases the reserved FIFO head");
});

test("resting reevaluation retains its own slices while excluding other reservations", () => {
  const model = { up: 100, down: 0, cost: 50, fees: 0,
    lots: { Up: [
      { lotId: "up-1", shares: 50, effectivePrice: 0.20 },
      { lotId: "up-2", shares: 50, effectivePrice: 0.80 },
    ], Down: [] } };
  const own = { phase: "resting", remaining: 25,
    reservationRemaining: [{ lotId: "up-1", shares: 25, effectivePrice: 0.20 }],
    rec: { oid: 8, side: "Down", shares: 50, requestedShares: 50, limitPx: 0.5 } };
  const other = { phase: "resting", remaining: 50,
    reservationRemaining: [{ lotId: "up-2", shares: 50, effectivePrice: 0.80 }],
    rec: { oid: 9, side: "Down", shares: 50, requestedShares: 50, limitPx: 0.1 } };
  const book = { ask: 0.10, bid: 0.09, asks: [{ price: 0.10, size: 200 }],
    bids: [{ price: 0.09, size: 200 }] };
  const caps = economicCaps(model, { pendingFills: [own, other] }, "Down", book,
    0.9, own.remaining, signalP, 0, { excludeOid: own.rec.oid,
      preferredReservation: own.reservationRemaining });
  assert.equal(caps.matchedShares, 25, "only the resting remainder is reevaluated");
  assert.equal(caps.oppositeCost, 0.20, "the order keeps its own reserved FIFO identity");
  assert.deepEqual(caps.pairReservation.map(({ lotId, shares }) => ({ lotId, shares })),
    [{ lotId: "up-1", shares: 25 }]);
});

test("recorded fill amounts reconcile exactly into strategy and settlement ledgers", () => {
  const fill = { fillId: "1:1", oid: 1, side: "Up", shares: 10, effPx: 0.5,
    usdc: 4.9999, fee: 0.20001, maker: false, leg: "entry",
    levels: [{ price: 0.49, shares: 5, usdc: 2.45, fee: 0.08747 },
      { price: 0.50998, shares: 5, usdc: 2.5499, fee: 0.11254 }] };
  const state = { fills: [fill] };
  step(state, tick(0), signalP, 120, 0);
  assert.equal(state.wallet3048.up, 10);
  assert.equal(state.wallet3048.cost, fill.usdc);
  assert.equal(state.wallet3048.fees, fill.fee);
  assert.equal(state.wallet3048.lots.Up.reduce((sum, lot) => sum + lot.shares, 0), 10);
  assert.ok(Math.abs(state.wallet3048.lots.Up.reduce((sum, lot) =>
    sum + lot.shares * lot.effectivePrice, 0) - (fill.usdc + fill.fee)) < 1e-12);
});

test("rounding-sensitive partial fills reconcile after every execution record", () => {
  const state = { fills: [] };
  const records = [
    { fillId: "11:1", oid: 11, side: "Up", shares: 7.3333, effPx: 0.40173,
      usdc: 2.946011, fee: 0.036719, maker: false, leg: "entry",
      levels: [{ price: 0.40, shares: 3.1111, usdc: 1.24444, fee: 0.014001 },
        { price: 0.403, shares: 4.2222, usdc: 1.701571, fee: 0.022718 }] },
    { fillId: "11:2", oid: 11, side: "Up", shares: 4.1111, effPx: 0.407,
      usdc: 1.673018, fee: 0.019003, maker: false, leg: "entry", status: "partial",
      levels: [{ price: 0.405, shares: 2.0555 }, { price: 0.409, shares: 2.0556 }] },
  ];
  for (const record of records) {
    state.fills.push(record);
    step(state, tick(0), signalP, 120, 0);
    const expectedShares = state.fills.reduce((sum, fill) => sum + fill.shares, 0);
    const expectedCost = state.fills.reduce((sum, fill) => sum + fill.usdc, 0);
    const expectedFee = state.fills.reduce((sum, fill) => sum + fill.fee, 0);
    assert.equal(state.wallet3048.up, expectedShares);
    assert.equal(state.wallet3048.cost, expectedCost);
    assert.equal(state.wallet3048.fees, expectedFee);
    const settlement = positionFromFills(state.fills, "Up");
    assert.equal(settlement.upShares, state.wallet3048.up);
    assert.equal(settlement.totalCost, state.wallet3048.cost);
    assert.equal(settlement.fee, state.wallet3048.fees);
    assert.equal(settlement.realizedPnl,
      state.wallet3048.up - state.wallet3048.cost - state.wallet3048.fees);
  }
  const lots = state.wallet3048.lots.Up;
  assert.ok(lots.length >= 4, "execution levels remain separately attributable in FIFO inventory");
  assert.ok(Math.abs(lots.reduce((sum, lot) => sum + lot.shares * lot.effectivePrice, 0)
    - (state.wallet3048.cost + state.wallet3048.fees)) < 1e-12);
});

test("a partial complement consumes its named lot instead of the FIFO head", () => {
  const state = { fills: [
    { fillId: "up-cheap", oid: 1, side: "Up", shares: 50, effPx: 0.2,
      usdc: 10, fee: 0, maker: true, leg: "entry" },
    { fillId: "up-expensive", oid: 2, side: "Up", shares: 50, effPx: 0.8,
      usdc: 40, fee: 0, maker: true, leg: "entry" },
  ] };
  step(state, tick(0), signalP, 120, 0);
  const [cheap, expensive] = state.wallet3048.lots.Up;
  state.fills.push({ fillId: "down-partial", oid: 3, side: "Down", shares: 20,
    effPx: 0.1, usdc: 2, fee: 0, maker: true, leg: "hedge",
    pairReservation: [{ lotId: expensive.lotId, shares: 20,
      effectivePrice: expensive.effectivePrice }] });
  step(state, tick(0), signalP, 120, 0);
  assert.equal(state.wallet3048.lots.Up.find((lot) => lot.lotId === cheap.lotId)?.shares, 50);
  assert.equal(state.wallet3048.lots.Up.find((lot) => lot.lotId === expensive.lotId)?.shares, 30);
});

test("parent economics use size-dependent executable VWAP", () => {
  const model = { up: 0, down: 0, cost: 0, fees: 0, lots: { Up: [], Down: [] } };
  const book = { ask: 0.4, bid: 0.39,
    asks: [{ price: 0.4, size: 10 }, { price: 0.41, size: 40 }],
    bids: [{ price: 0.39, size: 100 }] };
  const caps = economicCaps(model, {}, "Up", book, 0.8, 50, signalP, 0);
  assert.equal(caps.immediateShares, 50);
  assert.ok(Math.abs(caps.immediateVwap - 0.408) < 1e-12);
  assert.ok(caps.expectedPx > book.ask);
});

test("pair attribution excludes a parent's new directional remainder", () => {
  const model = { up: 50, down: 0, cost: 20, fees: 0,
    lots: { Up: [{ shares: 50, effectivePrice: 0.4 }], Down: [] } };
  const book = { ask: 0.5, bid: 0.49,
    asks: [{ price: 0.5, size: 200 }], bids: [{ price: 0.49, size: 200 }] };
  const caps = economicCaps(model, {}, "Down", book, 0.8, 150, signalP, 0);
  assert.equal(caps.matchedShares, 50);
  assert.equal(caps.directionalShares, 100);
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

test("backtest gives no time-at-bid maker credit unless optimistic touch mode is explicit", () => {
  const historical = (t, upAsk, upDepth, bz = 101) => {
    const up = side(upAsk, upDepth), down = side(1.01 - upAsk, 300);
    return { t, upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk, dnBid: down.bestBid,
      up, down, bz, cl: 100 };
  };
  const input = {
    openBinance: 100,
    openPrice: 100,
    windowStart: 0,
    ticks: [historical(4.5, 0.40, 100, 100), historical(5, 0.40, 10),
      historical(6, 0.40, 100), historical(7, 0.40, 100)],
  };
  const base = { ...signalP, STRATEGY: "wallet3048", W3048_COOLDOWN_MS: 10000,
    W3048_CROSS_HEADROOM_TICKS: 0, W3048_SIM_TOUCH_FILL_PCT: 100 };
  const conservative = simulateFills(input, base);
  assert.equal(conservative.reduce((sum, fill) => sum + fill.shares, 0), 10);
  assert.equal(conservative.length, 1);

  const optimistic = simulateFills(input, { ...base, W3048_MAKER_FILL_ASSUMPTION: "touch" });
  assert.equal(optimistic.reduce((sum, fill) => sum + fill.shares, 0), 50);
  assert.equal(optimistic.length, 2);
  assert.equal(optimistic[0].status, "partial");
  assert.ok(optimistic.slice(1).every((fill) => fill.maker === true && fill.exec === "resting"));
  assert.ok(optimistic.slice(1).every((fill) => fill.fillEvidence === "optimistic-touch"));
  assert.equal(new Set(optimistic.map((fill) => fill.oid)).size, 1);
});

test("a resting execution implied by the update wins a same-update cancel race", () => {
  const historical = (t, upAsk, upDepth, bz) => {
    const up = side(upAsk, upDepth), down = side(1.01 - upAsk, 300);
    return { t, upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk, dnBid: down.bestBid,
      up, down, bz, cl: 100 };
  };
  const fills = simulateFills({ openBinance: 100, openPrice: 100, windowStart: 0,
    ticks: [historical(4.5, 0.4, 100, 100), historical(5, 0.4, 10, 101),
      historical(6, 0.39, 100, 99)] }, {
    ...signalP, W3048_COOLDOWN_MS: 10_000, W3048_CROSS_HEADROOM_TICKS: 0,
    W3048_MAKER_FILL_ASSUMPTION: "zero",
  });
  assert.equal(fills.reduce((sum, fill) => sum + fill.shares, 0), 50);
  assert.equal(fills.at(-1).maker, true);
  assert.equal(fills.at(-1).fillEvidence, "book-cross-inference");
  assert.equal(fills.at(-1).fillEvidenceVerified, false);
});

test("an unchanged depth event cannot replenish liquidity between replay phases", () => {
  const historical = (t, upAsk, upDepth, bz, depthEventId) => {
    const up = { ...side(upAsk, upDepth), asks: [[upAsk, upDepth]], depthEventId };
    const down = { ...side(1.01 - upAsk, 300), depthEventId: `down-${depthEventId}` };
    return { t, ms: t * 1000, upAsk: up.bestAsk, upBid: up.bestBid,
      dnAsk: down.bestAsk, dnBid: down.bestBid, up, down, bz, cl: 100,
      binanceAtMs: t * 1000, chainlinkAtMs: t * 1000 };
  };
  const fills = simulateFills({ openBinance: 100, openPrice: 100, windowStart: 0,
    ticks: [historical(4.5, 0.4, 100, 100, "u0"), historical(5, 0.4, 10, 101, "u1"),
      historical(6, 0.39, 20, 102, "u2"), historical(6.1, 0.39, 20, 102, "u2")] }, {
    ...signalP, W3048_REQUIRE_SOURCE_TIMESTAMPS: true, LATENCY_MS: 0,
    W3048_COOLDOWN_MS: 0, W3048_SAME_SIDE_RETRY_MS: 0,
    W3048_CROSS_HEADROOM_TICKS: 0, W3048_MAKER_FILL_ASSUMPTION: "zero",
  });
  const eventShares = fills.filter((fill) => fill.tInto >= 6 && fill.tInto <= 6.1)
    .reduce((sum, fill) => sum + fill.shares, 0);
  assert.ok(eventShares <= 20, `one external depth event supplied only 20 shares, got ${eventShares}`);
});

test("resting fills after timeout or final cutoff are prohibited", () => {
  const historical = (t, upAsk, upDepth, bz) => {
    const up = side(upAsk, upDepth), down = side(1.01 - upAsk, 300);
    return { t, ms: t * 1000, upAsk: up.bestAsk, upBid: up.bestBid,
      dnAsk: down.bestAsk, dnBid: down.bestBid, up, down, bz, cl: 100 };
  };
  const common = { ...signalP, W3048_COOLDOWN_MS: 10_000,
    W3048_CROSS_HEADROOM_TICKS: 0, W3048_MAKER_FILL_ASSUMPTION: "zero" };
  const expired = simulateFills({ openBinance: 100, openPrice: 100, windowStart: 0,
    ticks: [historical(4.5, 0.4, 100, 100), historical(5, 0.4, 10, 101),
      historical(6, 0.39, 100, 101)] }, { ...common, W3048_REST_TIMEOUT_MS: 500 });
  assert.equal(expired.reduce((sum, fill) => sum + fill.shares, 0), 10);

  const cutoff = simulateFills({ openBinance: 100, openPrice: 100, windowStart: 0,
    ticks: [historical(268.5, 0.4, 100, 100), historical(269, 0.4, 10, 101),
      historical(270.1, 0.39, 100, 101)] }, common);
  assert.equal(cutoff.reduce((sum, fill) => sum + fill.shares, 0), 10);
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
