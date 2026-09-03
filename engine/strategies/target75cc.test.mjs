import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STRATEGY, getStrategy, listStrategies } from "./index.js";
import { MODEL_META } from "./target75cc-model.js";
import { RELEASE_META, RELEASE_MODEL, RELEASE_POLICY } from "./target75cc-release-model.js";
import { REGIME_META } from "./target75cc-regime-model.js";
import { REGIME_CLASSES, interpretRegime } from "./target75cc-regime.js";
import { regimeFeatures } from "./target75cc-regime-features.js";
import { STRAT, step, validateParams } from "./target75cc.js";
import { SESSION_ENTRY_MIN_PROBABILITY, resolveSessionEntryConfidence } from "./target75cc-session-policy.js";

function book(ask, bid = ask - 0.02, depth = 100) {
  return {
    bestAsk: ask,
    bestBid: bid,
    asks: [[ask, depth], [+(ask + 0.01).toFixed(2), depth], [+(ask + 0.02).toFixed(2), depth]],
    bids: [[bid, depth], [+(bid - 0.01).toFixed(2), depth], [+(bid - 0.02).toFixed(2), depth]],
  };
}

function tick(t, upAsk, downAsk, bzPrice) {
  return {
    t,
    up: book(upAsk),
    down: book(downAsk),
    bzPrice,
    clPrice: bzPrice,
    openBinance: 100,
    openChainlink: 100,
    bzGap: bzPrice - 100,
  };
}

function state(extra = {}) {
  return { upShares: 0, downShares: 0, upCost: 0, downCost: 0,
    seq: 0, orders: [], fills: [], ...extra };
}

const FAST = {
  ...STRAT,
  T_START_S: 0,
  T_RELEASE_THRESHOLD: 0,
  T_COOLDOWN_MS: 0,
  T_DECISION_STEP_MS: 50,
  T_REGIME_ON: false,
};

function primeAndEnter(s, P = FAST) {
  return step(s, tick(5, 0.52, 0.48, 101), P, 120, 5000);
}

test("wallet-75cc logic is the only exposed FastMX runtime strategy", () => {
  assert.equal(DEFAULT_STRATEGY, "target75cc");
  assert.equal(getStrategy().NAME, "target75cc");
  assert.deepEqual(listStrategies(), [{ name: "target75cc", label: "FastMX · wallet-75cc logic" }]);
});

test("tracked model metadata preserves the chronological holdout evidence", () => {
  assert.equal(MODEL_META.residualHoldout.medianAbsoluteError, 3.446799);
  assert.equal(MODEL_META.residualHoldout.baselineMedianAbsoluteError, 7.401494);
  assert.equal(MODEL_META.crossHoldout.auc, 0.792915);
  assert.equal(MODEL_META.crossThreshold, 0.485064);
  assert.equal(RELEASE_POLICY.threshold, 0.9);
  assert.equal(RELEASE_META.rankMetrics.holdout.pairAuc, 0.867988);
  assert.equal(RELEASE_META.autonomousParity.holdout.timingF1Pct, 24.347);
  assert.equal(REGIME_META.selection.selectedFeatureSet, "tokenPath");
  assert.match(REGIME_META.baselinePolicySha256, /^[a-f0-9]{64}$/);
  assert.ok(REGIME_META.metrics.holdout.auc > .8);
});

test("trend/noise features cannot read a future snapshot", () => {
  const snapshot = (ms, ask, bz) => ({ ms, bz, cl: bz,
    Up: { ask, bid: ask - .01, askDepth1: 10, askDepth3: 30, bidDepth1: 12, bidDepth3: 32 },
    Down: { ask: 1.01 - ask, bid: 1 - ask, askDepth1: 12, askDepth3: 32, bidDepth1: 10, bidDepth3: 30 } });
  const prior = snapshot(5_000, .52, 100), current = snapshot(10_000, .55, 101);
  const futureA = snapshot(20_000, .99, 150), futureB = snapshot(20_000, .01, 50);
  const args = { current, tk: { t: 10, openBinance: 100, openChainlink: 100 },
    side: "Up", clockMs: 10_000 };
  const left = regimeFeatures({ ...args, history: [prior, current, futureA] });
  const right = regimeFeatures({ ...args, history: [prior, current, futureB] });
  assert.deepEqual(left.vector, right.vector);
});

test("counter-trend classification distinguishes noise, possible reversal, and confirmed reversal", () => {
  const raw = { dominantScore: -.6, shortScore: .4 };
  const P = { ...STRAT, T_REGIME_MIN_PROBABILITY: .5, T_REGIME_MIN_EDGE: 0,
    T_REGIME_REVERSAL_MIN_PROBABILITY: .5, T_REGIME_CONFIRMED_REVERSAL_PROBABILITY: .7 };
  assert.equal(interpretRegime(raw, .4, .3, P).classification, REGIME_CLASSES.TEMPORARY_NOISE);
  assert.equal(interpretRegime(raw, .6, .3, P).classification, REGIME_CLASSES.POSSIBLE_REVERSAL);
  assert.equal(interpretRegime(raw, .8, .3, P).classification, REGIME_CLASSES.CONFIRMED_REVERSAL);
  assert.equal(interpretRegime({ dominantScore: .6, shortScore: -.4 }, .6, .7, P).classification,
    REGIME_CLASSES.TEMPORARY_NOISE);
  const pullback = interpretRegime({ dominantScore: .6, shortScore: -.4 }, .8, .3, P);
  assert.equal(pullback.classification, REGIME_CLASSES.PULLBACK_ENTRY_OPPORTUNITY);
  assert.ok(pullback.sizeScale >= .5 && pullback.sizeScale <= 1);
});

test("trend/noise gate can reject or admit the same release candidate", () => {
  const rejectedState = state();
  const reject = { ...FAST, T_REGIME_ON: true, T_REGIME_MIN_PROBABILITY: 1,
    T_REGIME_MIN_EDGE: 1, T_REGIME_REVERSAL_MIN_PROBABILITY: 1 };
  assert.deepEqual(primeAndEnter(rejectedState, reject), []);
  assert.equal(rejectedState.gateReason, "target-regime-rejected");

  const acceptedState = state();
  const accept = { ...FAST, T_REGIME_ON: true, T_REGIME_MIN_PROBABILITY: 0,
    T_REGIME_MIN_EDGE: -1, T_REGIME_REVERSAL_MIN_PROBABILITY: 0 };
  const [order] = primeAndEnter(acceptedState, accept);
  assert.ok(order);
  assert.ok(order.signal.regimeClass);
  assert.ok(Number.isFinite(order.signal.sideProbability));
});

test("entry-confidence threshold resolves from the window's UTC session", () => {
  assert.equal(resolveSessionEntryConfidence({ winHour: 5 }).sessionId, "utc04_08");
  assert.equal(resolveSessionEntryConfidence({ winHour: 5 }).minimumProbability, .75);
  assert.equal(resolveSessionEntryConfidence({ windowStart: Date.parse("2026-08-26T09:00:00Z") / 1_000 })
    .minimumProbability, .65);
  assert.equal(resolveSessionEntryConfidence({ winHour: 5, enabled: false, fallback: .5 })
    .minimumProbability, .5);
});

test("runtime applies different probability floors to the same candidate by session", () => {
  const schedule = Object.fromEntries(Object.keys(SESSION_ENTRY_MIN_PROBABILITY).map((id) => [id, 0]));
  schedule.utc08_12 = 1;
  const P = { ...FAST, T_REGIME_ON: true, T_REGIME_SESSION_ON: true,
    T_REGIME_SESSION_MIN_PROBABILITY: schedule, T_REGIME_MIN_EDGE: -1,
    T_REGIME_REVERSAL_MIN_PROBABILITY: 0 };
  const asiaTick = { ...tick(5, .52, .48, 101), winHour: 5 };
  const [accepted] = step(state(), asiaTick, P, 120, 5_000);
  assert.equal(accepted.signal.entryConfidenceSession, "utc04_08");
  assert.equal(accepted.signal.entryConfidenceThreshold, 0);
  const europeState = state();
  assert.deepEqual(step(europeState, { ...asiaTick, winHour: 9 }, P, 120, 5_000), []);
  assert.equal(europeState.strategyStatus.entryConfidenceSession, "utc08_12");
  assert.equal(europeState.strategyStatus.entryConfidenceThreshold, 1);
});

test("observable release model gives private target state zero weight", () => {
  for (const name of RELEASE_META.excluded) {
    assert.equal(RELEASE_MODEL.weights[RELEASE_MODEL.featureNames.indexOf(name)], 0, name);
  }
  assert.ok(RELEASE_MODEL.normalization.mean[0] > 0 && RELEASE_MODEL.normalization.mean[0] < 1,
    "timeFraction must be relative window progress, not absolute epoch time");
});

test("flat inventory uses the residual model instead of fixed seven-share sizing", () => {
  const s = state();
  const [order] = primeAndEnter(s);
  assert.equal(order.side, "Down");
  assert.equal(order.role, "entry");
  assert.equal(order.minimumShares, 9);
  assert.notEqual(order.minimumShares, 7);
  assert.equal(order.amountMode, "usd");
  assert.equal(order.budgetUsd, +(order.limitPx * order.minimumShares).toFixed(4));
  assert.equal(order.model.predictedResidual, 9);
  assert.equal(order.model.residualSha256, MODEL_META.residualSha256);
});

test("an opposite signal can cross inventory into a modeled new-side residual", () => {
  const s = state();
  const [entry] = primeAndEnter(s);
  const fill = { ...entry, shares: entry.minimumShares, effPx: 0.52,
    usdc: entry.minimumShares * 0.52 };
  s.downShares += fill.shares;
  s.downCost = fill.usdc;
  s.fills.push(fill);

  const [reversal] = step(s, tick(10, 0.80, 0.20, 101), FAST, 120, 10000);
  assert.equal(reversal.side, "Up");
  assert.equal(reversal.role, "reversal");
  assert.equal(reversal.model.orientedInventory, -9);
  assert.equal(reversal.model.predictedResidual, 5);
  assert.equal(reversal.minimumShares, 14);
  assert.ok(reversal.model.crossScore >= reversal.model.crossThreshold);
});

test("a high cross threshold makes an opposite signal partially reduce inventory", () => {
  const s = state({ downShares: 20, downCost: 10 });
  const P = { ...FAST, T_START_S: 5, T_CROSS_THRESHOLD: 1 };
  assert.deepEqual(step(s, tick(0, 0.52, 0.48, 100), P, 120, 0), []);
  const [hedge] = step(s, tick(5, 0.80, 0.20, 101), P, 120, 5000);
  assert.equal(hedge.side, "Up");
  assert.equal(hedge.role, "hedge");
  assert.ok(hedge.minimumShares >= P.T_MIN_ORDER_SH);
  assert.ok(hedge.minimumShares < s.downShares);
  assert.equal(hedge.model.desiredOrientedShares, -hedge.model.predictedResidual);
});

test("gross inventory cap includes existing exposure and blocks another order", () => {
  const s = state({ upShares: 300, upCost: 150 });
  assert.deepEqual(step(s, tick(5, 0.45, 0.54, 99), FAST, 120, 5000), []);
  assert.equal(s.gateReason, "target-gross-cap");
});

test("a hydrated window restores the most recent decision cooldown", () => {
  const windowStart = 1_788_300_000;
  const prior = {
    oid: 4, side: "Up", shares: 9, effPx: 0.52, usdc: 4.68,
    decidedT: 5, placedT: 5, tInto: 5.52,
  };
  const s = state({ windowStart, upShares: 9, upCost: 4.68, fills: [prior] });
  const P = { ...FAST, T_COOLDOWN_MS: 2_000 };
  const nowMs = (windowStart + 6) * 1_000;
  assert.deepEqual(step(s, tick(6, 0.52, 0.48, 101), P, 120, nowMs), []);
  assert.equal(s.gateReason, "target-cooldown");
  assert.equal(s.target75cc.lastFireMs, (windowStart + 5) * 1_000);
});

test("target parameter validation rejects unsafe bounds", () => {
  assert.equal(validateParams(STRAT), true);
  assert.throws(() => validateParams({ ...STRAT, T_MIN_ORDER_SH: 10, T_MAX_ORDER_SH: 5 }), /order bounds/);
  assert.throws(() => validateParams({ ...STRAT, T_CROSS_THRESHOLD: 2 }), /cross threshold/);
  assert.throws(() => validateParams({ ...STRAT, T_RELEASE_THRESHOLD: 2 }), /release threshold/);
  assert.throws(() => validateParams({ ...STRAT, T_RESIDUAL_SCALE: 0 }), /residual scale/);
  assert.throws(() => validateParams({ ...STRAT, T_REGIME_MIN_PROBABILITY: 2 }), /T_REGIME_MIN_PROBABILITY/);
  assert.throws(() => validateParams({ ...STRAT, T_REGIME_SESSION_ON: "yes" }), /must be boolean/);
  assert.throws(() => validateParams({ ...STRAT, T_REGIME_SESSION_MIN_PROBABILITY:
    { ...SESSION_ENTRY_MIN_PROBABILITY, utc04_08: 2 } }), /utc04_08/);
  assert.throws(() => validateParams({ ...STRAT, T_REGIME_SIZE_FLOOR: 2,
    T_REGIME_SIZE_CEILING: 1 }), /regime size bounds/);
});
