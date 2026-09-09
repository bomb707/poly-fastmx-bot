import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { simulateFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/wallet3048.js";
import { buildRecorderInstrumentation, finiteNumber,
  freshnessAtEvaluation, inspectDepthBook } from "../../engine/recorder-quality.js";
import { validateRecorderCohort, validateRecorderWindow } from "./validate-recorder-cohort.mjs";

const windowStart = 1_800_000_000;
const sourceKeys = (tick, source, receive) => Object.assign(tick, {
  binanceAtMs: source, binanceReceivedAtMs: receive,
  chainlinkAtMs: source, chainlinkReceivedAtMs: receive,
  upQuoteAtMs: source, upQuoteReceivedAtMs: receive,
  downQuoteAtMs: source, downQuoteReceivedAtMs: receive,
  upDepthAtMs: source, upDepthReceivedAtMs: receive,
  downDepthAtMs: source, downDepthReceivedAtMs: receive,
});

function book(ask, eventId, source, receive, firstDepth = 100) {
  return { bestAsk: ask, bestBid: ask - 0.01, depthEventId: eventId,
    depthTs: source, depthReceivedAtMs: receive,
    quoteSourceAtMs: source, quoteReceivedAtMs: receive,
    asks: [[ask, firstDepth], [ask + 0.01, 100], [ask + 0.02, 100]],
    bids: [[ask - 0.01, 100], [ask - 0.02, 100], [ask - 0.03, 100]] };
}

function tick(sequence, t, bz, upAsk, firstDepth = 100) {
  const source = windowStart * 1000 + t * 1000 + 0.123456;
  const receive = source + 0.234567;
  const ms = receive + 0.345678;
  const up = book(upAsk, `up-${sequence}`, source, receive, firstDepth);
  const down = book(1.01 - upAsk, `down-${sequence}`, source, receive);
  return sourceKeys({ schema: 2, sequence, t, tMs: t * 1000, ms,
    receivedAtMs: ms, bz, cl: 100.9876543210123,
    upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: down.bestAsk,
    dnBid: down.bestBid, upDepthEventId: up.depthEventId,
    downDepthEventId: down.depthEventId, up, down }, source, receive);
}

function syntheticPayload() {
  const params = { ...STRAT, STRATEGY: "wallet3048", LATENCY_MS: 0,
    W3048_REQUIRE_SOURCE_TIMESTAMPS: true, W3048_RELEASE_GATE: false,
    W3048_CLOB_VELOCITY_GATE: false,
    W3048_COOLDOWN_MS: 10_000, W3048_MAX_ACTIONS: 1,
    W3048_BETA_MARKET_LOGIT: 0, W3048_BETA_MOMENTUM: 1,
    W3048_BETA_LATEST_UPDATE: 0, W3048_BETA_RELATIVE_LEAD: 0,
    W3048_BETA_CHAINLINK_DISTANCE: 0, W3048_BETA_CLOB: 0,
    W3048_BETA_TIME_CHAINLINK: 0, W3048_EDGE_BUFFER: 0,
    W3048_MIN_EXPECTED_EDGE_START: 0, W3048_MIN_EXPECTED_EDGE_END: 0,
    W3048_LARGE_EDGE: 1, W3048_CROSS_HEADROOM_TICKS: 1,
    W3048_MAKER_EXECUTION_POLICY: "strict-no-maker" };
  const ticks = [tick(1, 4.5, 100.1234567890123, 0.400000000123, 100),
    tick(2, 5, 101.1234567890123, 0.400000000123, 10),
    tick(3, 5.2, 101.1234567890123, 0.420000000123, 100)];
  const diagnostics = {};
  const data = { schema: 2, recorder: "synthetic-schema-2", slug: `btc-updown-5m-${windowStart}`,
    windowStart, ws: windowStart, openBinance: 100.1234567890123,
    openBz: 100.1234567890123, openPrice: 100.9876543210123,
    openCl: 100.9876543210123, winSide: "Up", settlement: { outcome: "Up" },
    cfg: { params }, ticks };
  data.fills = simulateFills(data, params, diagnostics);
  data.decisions = diagnostics.decisions;
  return data;
}

test("strict numeric and depth semantics reject null, blanks, and unusable arrays", () => {
  assert.equal(finiteNumber(null), false);
  assert.equal(finiteNumber(undefined), false);
  assert.equal(finiteNumber(""), false);
  assert.equal(finiteNumber("   "), false);
  assert.equal(finiteNumber("12.5"), true);
  const depth = inspectDepthBook({ asks: [[null, 10]], bids: [[0.4, 10]] });
  assert.equal(depth.arraysPresent, true);
  assert.equal(depth.usable, false);
  assert.equal(depth.invalidAskLevels, 1);
});

test("fresh delivery becomes stale when evaluation continues after the feed stops", () => {
  const report = freshnessAtEvaluation([
    { ms: 1_020, source: 1_000, receive: 1_010 },
    { ms: 5_000, source: 1_000, receive: 1_010 },
  ], "source", "receive", 1_000);
  assert.equal(report.receiveMinusSource.maxMs, 10);
  assert.equal(report.evaluationMinusSource.maxMs, 4_000);
  assert.equal(report.evaluationMinusLatestReceive.maxMs, 3_990);
  assert.equal(report.evaluationMinusSource.fresh, 1);
  assert.equal(report.evaluationMinusSource.stale, 1);
});

test("synthetic schema-2 recorder payload retains precision and replays exactly", () => {
  const payload = syntheticPayload();
  const roundTrip = JSON.parse(JSON.stringify(payload));
  assert.equal(roundTrip.openBinance, 100.1234567890123);
  assert.equal(roundTrip.ticks[0].upAsk, 0.400000000123);
  assert.ok(roundTrip.fills.length > 0);
  assert.ok(roundTrip.fills[0].levels.length >= 2, "fixture crosses multiple price levels");
  const report = validateRecorderWindow(roundTrip, "synthetic.json");
  assert.equal(report.completeness.readyForExactParity, true);
  assert.equal(report.completeness.usableDepthTicks, roundTrip.ticks.length);
  assert.equal(report.parity.exact, true);
  assert.equal(report.reconciliation.recorded.exact, true);
  assert.equal(report.reconciliation.recorded.levelDiscrepancies, 0);
  const instrumentation = buildRecorderInstrumentation(roundTrip, roundTrip.cfg.params);
  assert.equal(instrumentation.depthIdentityTicks, roundTrip.ticks.length);
});

test("ordinary cohort validation never opens or exposes sealed final-test performance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wallet3048-sealed-"));
  fs.mkdirSync(path.join(root, "sealed-final-test"), { recursive: true });
  fs.mkdirSync(path.join(root, "instrumentation"), { recursive: true });
  fs.mkdirSync(path.join(root, "payloads"), { recursive: true });
  fs.writeFileSync(path.join(root, "sealed-final-test/final.json"),
    "{\"outcome\":\"SECRET_OUTCOME\",\"pnl\":987654321,"); // Deliberately invalid JSON.
  const metadata = buildRecorderInstrumentation(syntheticPayload(), STRAT);
  fs.writeFileSync(path.join(root, "instrumentation/final.instrumentation.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(root, "payloads/unlisted.json"), "not json");
  const report = validateRecorderCohort({ recorderRoot: root, manifest: {
    schema: 1, cohortId: "sealed-regression", retentionWindows: 10,
    finalTest: { sealed: true, payloadRoot: "sealed-final-test",
      memberWindowStarts: [windowStart] },
    members: [{ windowStart, split: "final-test", payload: "sealed-final-test/final.json",
      instrumentation: "instrumentation/final.instrumentation.json" }],
  } });
  const serialized = JSON.stringify(report);
  assert.equal(report.summary.expectedWindows, 1);
  assert.equal(report.summary.analyzedWindows, 0);
  assert.equal(report.sealedFinalTest.validInstrumentationFiles, 1);
  assert.equal(report.windows.length, 0);
  assert.equal(serialized.includes("SECRET_OUTCOME"), false);
  assert.equal(serialized.includes("987654321"), false);
  assert.equal(serialized.includes("unlisted.json"), false);
  fs.writeFileSync(path.join(root, "instrumentation/final.instrumentation.json"),
    JSON.stringify({ ...metadata, settlementPnl: 987654321 }));
  const rejectedMetadata = validateRecorderCohort({ recorderRoot: root, manifest: {
    schema: 1, finalTest: { sealed: true, payloadRoot: "sealed-final-test",
      memberWindowStarts: [windowStart] },
    members: [{ windowStart, split: "final-test", payload: "sealed-final-test/final.json",
      instrumentation: "instrumentation/final.instrumentation.json" }],
  } });
  assert.equal(rejectedMetadata.sealedFinalTest.validInstrumentationFiles, 0);
  assert.equal(JSON.stringify(rejectedMetadata).includes("987654321"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a split-label change cannot move a protected payload into ordinary analysis", () => {
  assert.throws(() => validateRecorderCohort({ recorderRoot: "/tmp", manifest: {
    schema: 1, finalTest: { sealed: true, payloadRoot: "sealed-final-test",
      memberWindowStarts: [windowStart] },
    members: [{ windowStart, split: "development",
      payload: "sealed-final-test/final.json" }],
  } }), /must agree/);
});
