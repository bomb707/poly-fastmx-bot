#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CALIBRATION = path.resolve(process.argv[2] || path.join(ROOT, "data/research/wallet-maker-credit-calibration.json"));
const FLOOR = path.resolve(process.argv[3] || path.join(ROOT, "data/research/passive-maker-pair-v11-credit-floor.json"));
const calibration = JSON.parse(fs.readFileSync(CALIBRATION, "utf8"));
const floor = JSON.parse(fs.readFileSync(FLOOR, "utf8"));

assert.equal(calibration.assessment.conditionalCaptureSupports10Pct, true);
assert.equal(calibration.assessment.unconditionalMakerCreditConfirmed, false);
assert.equal(calibration.assessment.stableProfitConfirmed, false);
assert.ok(calibration.queueConsistentIsolated.orders >= 1_000);
assert.ok(calibration.queueConsistentIsolated.windows >= 400);
assert.ok(calibration.queueConsistentIsolated.utcDays.length >= 10);
assert.ok(calibration.queueConsistentIsolated.windowClusterBootstrapRawLower95 > .1);
assert.ok(calibration.queueConsistentIsolated.windowClusterBootstrapPostQueueLower95 > .1);
assert.equal(calibration.chronologicalCalibrationFolds.length, 3);
assert.ok(calibration.chronologicalCalibrationFolds.every((fold) => fold.orders > 0
  && fold.windows > 0 && fold.weightedRawCapture > .1 && fold.weightedPostQueueCapture > .1));

assert.match(floor.methodology, /shared, FIFO, volume-conserved maker-credit budget/);
assert.equal(floor.range.loaded, 734);
assert.equal(floor.range.failed, 5);
const rows = Object.values(floor.diagnostics || {});
assert.equal(rows.length, 7);
assert.deepEqual(rows.map((row) => row.params.makerCredit), [.05, .055, .06, .065, .07, .075, .08]);
assert.ok(rows.every((row) => row.params.latencyMs === 2733 && row.params.effectiveMakerLatencyMs === 2733
  && row.params.takerLatencyMs === 520 && row.params.makerTradingEnabled === true));
assert.ok(rows.every((row) => row.params.tradePriceMode === "exact" && row.params.orderSize === 5
  && row.params.minOrderShares === 5 && row.params.exposureCap === 10 && row.takerBuyShares === 0));
assert.ok(rows.every((row) => row.takerShares === 0 || row.fees > 0));

const cuts = [
  [Date.parse("2026-08-14T00:00:00Z"), Date.parse("2026-08-22T17:00:00Z")],
  [Date.parse("2026-08-22T17:00:00Z"), Date.parse("2026-08-23T06:15:00Z")],
  [Date.parse("2026-08-23T07:00:00Z"), Date.parse("2026-08-24T00:50:00Z")],
  [Date.parse("2026-08-24T00:50:00Z"), Date.parse("2026-08-24T03:35:00Z")],
  [Date.parse("2026-08-24T03:35:00Z"), Date.parse("2026-08-24T04:35:00Z")],
];
function gates(row) {
  const daily = Object.values(row.daily);
  const foldsPositive = cuts.every(([from, to]) => row.windowsDetail
    .filter((window) => window.startMs >= from && window.startMs < to)
    .reduce((total, window) => total + window.pnl, 0) > 0);
  return {
    positive: row.pnl > 0 && row.pairedPnl > 0,
    lowerBounds: row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0,
    profitableDays: daily.filter((pnl) => pnl > 0).length / daily.length >= .8,
    drawdown: row.maxDrawdown / row.grossBuySpend * 100 <= 5,
    chronologicalFolds: foldsPositive,
  };
}
const evaluated = rows.map((row) => ({ credit: row.params.makerCredit, row, gates: gates(row) }));
const passing = evaluated.filter((entry) => Object.values(entry.gates).every(Boolean));
assert.deepEqual(passing.map((entry) => entry.credit), [.075, .08]);
assert.equal(Object.values(evaluated.find((entry) => entry.credit === .07).gates).every(Boolean), false);
const boundary = evaluated.find((entry) => entry.credit === .075).row;

console.log(JSON.stringify({
  ok: true,
  stableProfitConfirmed: false,
  reason: "conditional fill calibration cannot observe never-filled private orders; fresh 30-day forward cohort remains pending",
  calibration: {
    queueConsistentOrders: calibration.queueConsistentIsolated.orders,
    windows: calibration.queueConsistentIsolated.windows,
    days: calibration.queueConsistentIsolated.utcDays.length,
    rawCaptureLower95: calibration.queueConsistentIsolated.windowClusterBootstrapRawLower95,
    postQueueCaptureLower95: calibration.queueConsistentIsolated.windowClusterBootstrapPostQueueLower95,
    chronologicalFoldRawCaptures: calibration.chronologicalCalibrationFolds.map((fold) => fold.weightedRawCapture),
  },
  historicalCreditFloor: {
    firstPassingCredit: .075,
    lastFailingCredit: .07,
    pnl: boundary.pnl,
    profitFactor: boundary.profitFactor,
    windowLower95: boundary.bootstrapWindowLower95,
    dayLower95: boundary.bootstrapDayLower95,
    profitableDays: Object.values(boundary.daily).filter((pnl) => pnl > 0).length,
    days: Object.keys(boundary.daily).length,
  },
}));
