#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const file = path.resolve(process.argv[2] || path.join(root, "data/research/passive-maker-pair-v11-volume-conserved-full-stress.json"));
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const mirrorAudit = JSON.parse(fs.readFileSync(path.join(root, "data/research/v4-complement-mirroring-audit.json"), "utf8"));
assert.equal(mirrorAudit.passed, true);
assert.equal(mirrorAudit.files, 739);
assert.equal(mirrorAudit.priceMirrors, mirrorAudit.totalLevels);
assert.equal(mirrorAudit.sizeMirrors, mirrorAudit.totalLevels);
assert.match(report.methodology, /shared, FIFO, volume-conserved maker-credit budget/);
assert.match(report.methodology, /0\.07\*p\*\(1-p\)\*shares rounded to five decimals/);

const rows = Object.values(report.diagnostics || {});
const enabled = rows.filter((row) => row.params.makerTradingEnabled);
const paused = rows.filter((row) => !row.params.makerTradingEnabled);
assert.equal(rows.length, 12);
assert.equal(report.range.loaded, 734);
assert.equal(enabled.length, 9);
assert.equal(paused.length, 3);
assert.ok(enabled.every((row) => row.pnl > 0 && row.pairedPnl > 0
  && row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0));
assert.ok(paused.every((row) => row.placements === 0 && row.activeWindows === 0 && row.pnl === 0));
assert.ok(rows.every((row) => row.params.tradePriceMode === "exact"));
assert.ok(rows.every((row) => row.params.orderSize === 5 && row.params.minOrderShares === 5
  && row.params.exposureCap === 10));
assert.ok(rows.every((row) => row.params.pairQuoteCap === .9 && row.params.pairCostCap === .9
  && row.params.effectiveUnpairedTimeoutS === 15));
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
  for (const window of row.windowsDetail) assert.ok(Math.abs(window.pnl - (window.payout - window.cost)) < 1e-9,
    `accounting identity failed for ${window.slug}`);
  for (const [from, to] of cuts) {
    const windows = row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to);
    assert.ok(windows.length > 0);
    assert.ok(windows.reduce((sum, window) => sum + window.pnl, 0) > 0);
    chronologicalCells++;
  }
}
assert.equal(chronologicalCells, 45);

const focus = enabled.find((row) => row.params.latencyMs === 2733 && row.params.makerCredit === .1);
assert.ok(focus.pnl > 100 && focus.roiPct > 12 && focus.profitFactor > 2.2);
assert.ok(focus.maxDrawdown < 10 && focus.bootstrapWindowLower95 > 50);
console.log(JSON.stringify({ ok: true, stableProfitConfirmed: false, reason: "fresh 30-day three-fold forward cohort pending",
  file, enabledStressCells: enabled.length, pausedStressCells: paused.length,
  complementMirrorLevels: mirrorAudit.totalLevels,
  chronologicalStressCells: chronologicalCells, focus: { pnl: focus.pnl, roiPct: focus.roiPct,
    profitFactor: focus.profitFactor, maxDrawdown: focus.maxDrawdown,
    profitableDays: Object.values(focus.daily).filter((pnl) => pnl > 0).length, days: Object.keys(focus.daily).length } }));
