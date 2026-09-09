import test from "node:test";
import assert from "node:assert/strict";

import { simulateFills } from "../../engine/simrun.js";
import { createShadow } from "./shadow.js";
import { setRunning } from "./botState.js";
import { validateRecorderWindow } from "../../research/wallet-3048/validate-recorder-cohort.mjs";

const windowStart = 1_800_000_000;
const slug = `btc-updown-5m-${windowStart}`;
const side = (ask, depth, depthEventId, depthTs) => ({ bestAsk: ask,
  bestBid: +(ask - 0.01).toFixed(2), depthEventId, depthTs, depthReceivedAtMs: depthTs,
  depthValid: true,
  quoteSourceAtMs: depthTs, quoteReceivedAtMs: depthTs,
  asks: [[ask, depth], [+(ask + 0.01).toFixed(2), depth], [+(ask + 0.02).toFixed(2), depth]],
  bids: [[+(ask - 0.01).toFixed(2), depth], [+(ask - 0.02).toFixed(2), depth],
    [+(ask - 0.03).toFixed(2), depth]] });

function fixtureTick(t, bz, upAsk, upDepth, event) {
  const nowMs = windowStart * 1000 + t * 1000;
  const up = side(upAsk, upDepth, `up-${event}`, nowMs);
  const down = side(1.01 - upAsk, 300, `down-${event}`, nowMs);
  return { t, ms: nowMs, bz, cl: 100, binanceAtMs: nowMs, chainlinkAtMs: nowMs,
    upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk, dnBid: down.bestBid,
    up, down };
}

const params = { STRATEGY: "wallet3048", W3048_SPEC_VERSION: 5,
  LATENCY_MS: 100, W3048_REQUIRE_SOURCE_TIMESTAMPS: true,
  W3048_CLOB_VELOCITY_GATE: false,
  W3048_RELEASE_GATE: false, W3048_COOLDOWN_MS: 0,
  W3048_SAME_SIDE_RETRY_MS: 0, W3048_MAX_ACTIONS: 2,
  W3048_BETA_MARKET_LOGIT: 0, W3048_BETA_MOMENTUM: 1,
  W3048_BETA_LATEST_UPDATE: 0, W3048_BETA_RELATIVE_LEAD: 0,
  W3048_BETA_CHAINLINK_DISTANCE: 0, W3048_BETA_CLOB: 0,
  W3048_BETA_TIME_CHAINLINK: 0, W3048_EDGE_BUFFER: 0,
  W3048_MIN_EXPECTED_EDGE_START: 0, W3048_MIN_EXPECTED_EDGE_END: 0,
  W3048_LARGE_EDGE: 1, W3048_CROSS_HEADROOM_TICKS: 1,
  W3048_MAKER_EXECUTION_POLICY: "strict-no-maker" };

function runShadow(ticks, selectedParams) {
  const shadow = createShadow(() => {}, () => false);
  shadow.setParams(selectedParams);
  setRunning(true);
  try {
    for (const tick of ticks) shadow.tick({ slug, windowStart, openBinance: 100,
      openChainlink: 100, tInto: tick.t, bzPrice: tick.bz, clPrice: tick.cl,
      binanceAtMs: tick.binanceAtMs, binanceReceivedAtMs: tick.ms,
      chainlinkAtMs: tick.chainlinkAtMs, chainlinkReceivedAtMs: tick.ms,
      nowMs: tick.ms, up: tick.up, down: tick.down });
  } finally {
    setRunning(false);
  }
  return shadow.windows.get(slug);
}

const comparableExecution = (fills) => fills.map((fill) => ({ oid: fill.oid,
  fillId: fill.fillId, side: fill.side, shares: fill.shares, usdc: fill.usdc,
  fee: fill.fee, effPx: fill.effPx, decidedT: fill.decidedT, tInto: fill.tInto,
  ts: fill.ts, maker: fill.maker, evidence: fill.fillEvidence,
  verified: fill.fillEvidenceVerified, policy: fill.makerExecutionPolicy,
  queue: fill.queueAssumption, evidenceIds: fill.evidenceIds }));

for (const scenario of [
  { policy: "strict-no-maker", crossed: true, expectedShares: 10, evidence: null },
  { policy: "book-cross-inference", crossed: true, expectedShares: 50,
    evidence: "book-cross-inference" },
  { policy: "observed-flow-estimate", queue: "front-of-queue", expectedShares: 50,
    evidence: "observed-flow-estimate" },
  { policy: "optimistic-touch", expectedShares: 50, evidence: "optimistic-touch" },
]) {
  test(`shadow/replay parity for maker policy ${scenario.policy}`, () => {
    const ticks = [fixtureTick(4.5, 100, 0.40, 100, `${scenario.policy}-0`),
      fixtureTick(5, 101, 0.40, 10, `${scenario.policy}-1`),
      fixtureTick(6, 101, scenario.crossed ? 0.39 : 0.40, 100, `${scenario.policy}-2`)];
    if (scenario.policy === "observed-flow-estimate") {
      ticks[2].up.makerEvidence = [{ id: "eligible-sell-1", ts: ticks[2].ms,
        price: 0.40, shares: 40, aggressorSide: "sell" }];
    }
    const selected = { ...params, LATENCY_MS: 0, W3048_MAX_ACTIONS: 1,
      W3048_COOLDOWN_MS: 10_000, W3048_CROSS_HEADROOM_TICKS: 0,
      W3048_REST_TIMEOUT_MS: 10_000, W3048_SIM_TOUCH_FILL_PCT: 100,
      W3048_MAKER_EXECUTION_POLICY: scenario.policy,
      W3048_MAKER_QUEUE_ALLOCATION: scenario.queue || "none" };
    const replay = simulateFills({ windowStart, openBinance: 100,
      openPrice: 100, ticks }, selected);
    const shadowWindow = runShadow(ticks, selected);
    const live = shadowWindow.fills;
    assert.deepEqual(comparableExecution(live), comparableExecution(replay));
    assert.equal(live.reduce((sum, fill) => sum + fill.shares, 0), scenario.expectedShares);
    const maker = live.filter((fill) => fill.maker === true);
    if (scenario.policy === "strict-no-maker") {
      assert.equal(maker.length, 0);
      assert.equal(shadowWindow.pendingFills.length, 0,
        "canceled resting remainder releases its lifecycle reservation");
    }
    else {
      assert.equal(maker.length, 1);
      assert.equal(maker[0].fillEvidence, scenario.evidence);
      assert.equal(maker[0].fillEvidenceVerified, false);
      assert.equal(maker[0].makerExecutionPolicy, scenario.policy);
    }
  });
}

test("shadow/replay parity includes the +0.02 CLOB-confirmed entry", () => {
  const ticks = [fixtureTick(4, 100, 0.40, 100, "clob-0"),
    fixtureTick(6.5, 100, 0.40, 100, "clob-1"),
    fixtureTick(7, 101, 0.42, 100, "clob-2"),
    fixtureTick(7.2, 101, 0.42, 100, "clob-3")];
  const selected = { ...params, W3048_CLOB_VELOCITY_GATE: true,
    W3048_CLOB_VELOCITY_LOOKBACK_MS: 3000, W3048_CLOB_VELOCITY_MIN: 0.02,
    W3048_MAX_ACTIONS: 1 };
  const replayDiagnostics = {};
  const replay = simulateFills({ windowStart, openBinance: 100,
    openPrice: 100, ticks }, selected, replayDiagnostics);
  const shadowWindow = runShadow(ticks, selected);
  assert.deepEqual(comparableExecution(shadowWindow.fills), comparableExecution(replay));
  assert.equal(shadowWindow.recDecisions.length, 1);
  assert.equal(replayDiagnostics.decisions.length, 1);
  assert.equal(shadowWindow.recDecisions[0].signal.clobVelocity, 0.02);
  assert.equal(shadowWindow.recDecisions[0].side, "Up");
  assert.deepEqual(shadowWindow.recDecisions.map((decision) => ({ side: decision.side,
    reason: decision.reason, signal: decision.signal })),
  replayDiagnostics.decisions.map((decision) => ({ side: decision.side,
    reason: decision.reason, signal: decision.signal })));
});

test("shadow and replay use the same last-known book when arrival falls between updates", () => {
  const ticks = [fixtureTick(4.5, 100, 0.40, 100, 1),
    fixtureTick(5, 101, 0.40, 100, 2), fixtureTick(5.2, 101, 0.42, 100, 3),
    fixtureTick(5.4, 101, 0.43, 100, 4)];
  const replay = simulateFills({ windowStart, openBinance: 100, openPrice: 100, ticks }, params);
  const shadow = createShadow(() => {}, () => false);
  shadow.setParams(params);
  setRunning(true);
  try {
    for (const tick of ticks) shadow.tick({ slug, windowStart, openBinance: 100,
      openChainlink: 100, tInto: tick.t, bzPrice: tick.bz, clPrice: tick.cl,
      binanceAtMs: tick.binanceAtMs, binanceReceivedAtMs: tick.ms,
      chainlinkAtMs: tick.chainlinkAtMs, chainlinkReceivedAtMs: tick.ms,
      nowMs: tick.ms, up: tick.up, down: tick.down });
  } finally {
    setRunning(false);
  }
  const window = shadow.windows.get(slug);
  const live = window.fills;
  const project = (fills) => fills.map((fill) => ({ oid: fill.oid, side: fill.side,
    shares: fill.shares, usdc: fill.usdc, fee: fill.fee, effPx: fill.effPx,
    decidedT: fill.decidedT, tInto: fill.tInto, ts: fill.ts, reason: fill.reason }));
  assert.deepEqual(project(live), project(replay));
  assert.equal(live[0].tInto, 5.1);
  assert.equal(live[0].effPx, 0.4);
  assert.equal(live[1].reason, "w3048-directional-reinforcement",
    "the post-arrival inventory decision also remains identical");
  const recorderReport = validateRecorderWindow({ schema: 2, slug, windowStart,
    openBinance: 100, openPrice: 100, winSide: "Up", cfg: { params },
    ticks: window.recTicks, decisions: window.recDecisions, fills: window.fills });
  assert.equal(recorderReport.completeness.readyForExactParity, true);
  assert.equal(recorderReport.parity.exact, true);
});

test("shadow and replay cancel a resting remainder before a sparse later update", () => {
  const expiryParams = { ...params, LATENCY_MS: 0, W3048_MAX_ACTIONS: 1,
    W3048_COOLDOWN_MS: 10_000, W3048_CROSS_HEADROOM_TICKS: 0,
    W3048_REST_TIMEOUT_MS: 500 };
  const ticks = [fixtureTick(4.5, 100, 0.40, 100, "expiry-1"),
    fixtureTick(5, 101, 0.40, 10, "expiry-2"),
    fixtureTick(6, 101, 0.39, 100, "expiry-3")];
  const replay = simulateFills({ windowStart, openBinance: 100, openPrice: 100, ticks }, expiryParams);
  const shadow = createShadow(() => {}, () => false);
  shadow.setParams(expiryParams);
  setRunning(true);
  try {
    for (const tick of ticks) shadow.tick({ slug, windowStart, openBinance: 100,
      openChainlink: 100, tInto: tick.t, bzPrice: tick.bz, clPrice: tick.cl,
      binanceAtMs: tick.binanceAtMs, binanceReceivedAtMs: tick.ms,
      chainlinkAtMs: tick.chainlinkAtMs, chainlinkReceivedAtMs: tick.ms,
      nowMs: tick.ms, up: tick.up, down: tick.down });
  } finally {
    setRunning(false);
  }
  const live = shadow.windows.get(slug).fills;
  assert.deepEqual(live.map((fill) => [fill.side, fill.shares, fill.tInto]),
    replay.map((fill) => [fill.side, fill.shares, fill.tInto]));
  assert.equal(live.reduce((sum, fill) => sum + fill.shares, 0), 10);
});

test("window close does not turn an unarrived intent into a fill", () => {
  const closeParams = { ...params, LATENCY_MS: 1000, W3048_MAX_ACTIONS: 1 };
  const ticks = [fixtureTick(4.5, 100, 0.40, 100, "close-1"),
    fixtureTick(5, 101, 0.40, 100, "close-2")];
  const replay = simulateFills({ windowStart, openBinance: 100, openPrice: 100, ticks }, closeParams);
  const shadow = createShadow(() => {}, () => false);
  shadow.setParams(closeParams);
  setRunning(true);
  try {
    for (const tick of ticks) shadow.tick({ slug, windowStart, openBinance: 100,
      openChainlink: 100, tInto: tick.t, bzPrice: tick.bz, clPrice: tick.cl,
      binanceAtMs: tick.binanceAtMs, binanceReceivedAtMs: tick.ms,
      chainlinkAtMs: tick.chainlinkAtMs, chainlinkReceivedAtMs: tick.ms,
      nowMs: tick.ms, up: tick.up, down: tick.down });
    shadow.recordPending(slug);
  } finally {
    setRunning(false);
  }
  assert.equal(replay.length, 0);
  assert.equal(shadow.windows.get(slug).fills.length, 0);
});
