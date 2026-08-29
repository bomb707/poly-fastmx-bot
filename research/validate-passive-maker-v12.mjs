#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.resolve(process.argv[2] || path.join(ROOT, "data/research/passive-maker-pair-v12-volume-conserved-full-stress.json"));
const report = JSON.parse(fs.readFileSync(FILE, "utf8"));
const mirror = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/v4-complement-mirroring-audit.json"), "utf8"));
assert.equal(mirror.passed, true);
assert.equal(mirror.files, 739);
assert.match(report.methodology, /shared, FIFO, volume-conserved maker-credit budget/);
assert.match(report.methodology, /0\.07\*p\*\(1-p\)\*shares rounded to five decimals/);
assert.equal(report.range.loaded, 734);
assert.equal(report.range.failed, 5);

const rows = Object.values(report.diagnostics || {});
const enabled = rows.filter((row) => row.params.makerTradingEnabled);
const paused = rows.filter((row) => !row.params.makerTradingEnabled);
assert.equal(rows.length, 12);
assert.equal(enabled.length, 9);
assert.equal(paused.length, 3);
assert.ok(enabled.every((row) => row.pnl > 0 && row.pairedPnl > 0
  && row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0));
assert.ok(paused.every((row) => row.placements === 0 && row.activeWindows === 0 && row.pnl === 0));
assert.ok(rows.every((row) => row.params.tradePriceMode === "exact" && row.params.postOnly === true));
assert.ok(rows.every((row) => row.params.orderSize === 5 && row.params.minOrderShares === 5
  && row.params.exposureCap === 10 && row.params.effectiveUnpairedTimeoutS === 10));
assert.ok(rows.every((row) => row.params.pairQuoteCap === .9 && row.params.pairCostCap === .9));
assert.ok(rows.every((row) => row.params.takerLatencyMs === 520 && row.takerBuyShares === 0));
assert.ok(rows.every((row) => row.takerShares === 0 || row.fees > 0));
assert.ok(enabled.every((row) => row.params.effectiveMakerLatencyMs === 2733));
assert.ok(enabled.every((row) => Object.values(row.daily).filter((pnl) => pnl > 0).length / Object.keys(row.daily).length >= .8));
assert.ok(enabled.every((row) => row.maxDrawdown / row.grossBuySpend * 100 <= 5));

const cuts = [
  [Date.parse("2026-08-14T00:00:00Z"), Date.parse("2026-08-22T17:00:00Z")],
  [Date.parse("2026-08-22T17:00:00Z"), Date.parse("2026-08-23T06:15:00Z")],
  [Date.parse("2026-08-23T07:00:00Z"), Date.parse("2026-08-24T00:50:00Z")],
  [Date.parse("2026-08-24T00:50:00Z"), Date.parse("2026-08-24T03:35:00Z")],
  [Date.parse("2026-08-24T03:35:00Z"), Date.parse("2026-08-24T04:35:00Z")],
];
let chronologicalCells = 0;
for (const row of enabled) {
  assert.equal(row.windowsDetail.length, 734);
  for (const window of row.windowsDetail) assert.ok(Math.abs(window.pnl - (window.payout - window.cost)) < 1e-9);
  for (const [from, to] of cuts) {
    const windows = row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to);
    assert.ok(windows.length > 0 && windows.reduce((sum, window) => sum + window.pnl, 0) > 0);
    chronologicalCells++;
  }
}
assert.equal(chronologicalCells, 45);
const focus = enabled.find((row) => row.params.latencyMs === 2733 && row.params.makerCredit === .1);
assert.ok(focus.pnl > 104 && focus.roiPct > 12 && focus.profitFactor > 2.3);
assert.ok(focus.maxDrawdown < 10 && focus.bootstrapWindowLower95 > 59);

const neighborhood = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/passive-maker-v11-timeout-neighborhood.json"), "utf8"));
const neighborRows = Object.values(neighborhood.diagnostics || {});
const timeout = (seconds, credit) => neighborRows.find((row) => row.params.effectiveUnpairedTimeoutS === seconds
  && row.params.makerCredit === credit);
assert.ok(timeout(10, .075).bootstrapDayLower95 > 0 && timeout(10, .075).pnl > 0);
assert.ok(timeout(15, .075).bootstrapDayLower95 > 0 && timeout(15, .075).pnl > 0);
assert.ok(timeout(5, .1).windowsDetail.filter((row) => row.startMs >= cuts.at(-1)[0] && row.startMs < cuts.at(-1)[1])
  .reduce((sum, row) => sum + row.pnl, 0) < 0);
assert.ok(timeout(20, .075).bootstrapDayLower95 < 0);
assert.ok(timeout(30, .075).bootstrapDayLower95 < 0);

const floor = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/passive-maker-pair-v12-credit-floor.json"), "utf8"));
const floorRows = Object.values(floor.diagnostics || {});
const stableFloor = floorRows.filter((row) => {
  const days = Object.values(row.daily);
  return row.pnl > 0 && row.pairedPnl > 0 && row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0
    && days.filter((pnl) => pnl > 0).length / days.length >= .8
    && row.maxDrawdown / row.grossBuySpend * 100 <= 5
    && cuts.every(([from, to]) => row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to)
      .reduce((sum, window) => sum + window.pnl, 0) > 0);
});
assert.deepEqual(stableFloor.map((row) => row.params.makerCredit), [.075, .08]);

console.log(JSON.stringify({ ok: true, stableProfitConfirmed: false,
  reason: "timeout-10 is a frozen simulation challenger; fresh 30-day three-fold forward cohort pending",
  file: FILE, enabledStressCells: enabled.length, pausedStressCells: paused.length,
  chronologicalStressCells: chronologicalCells, historicalCreditFloor: .075,
  focus: { pnl: focus.pnl, roiPct: focus.roiPct,
    profitFactor: focus.profitFactor, maxDrawdown: focus.maxDrawdown,
    profitableDays: Object.values(focus.daily).filter((pnl) => pnl > 0).length, days: Object.keys(focus.daily).length } }));
