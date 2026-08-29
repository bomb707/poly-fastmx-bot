#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const file = path.resolve(process.argv[2] || path.join(root, "data/research/passive-maker-pair-v8-volume-conserved-full-stress.json"));
const report = JSON.parse(fs.readFileSync(file, "utf8"));
assert.match(report.methodology, /shared, FIFO, volume-conserved maker-credit budget/);
assert.match(report.methodology, /0\.07\*p\*\(1-p\)\*shares rounded to five decimals/);
const rows = Object.values(report.diagnostics || {});
const enabled = rows.filter((row) => row.params.makerTradingEnabled);
const paused = rows.filter((row) => !row.params.makerTradingEnabled);
assert.equal(rows.length, 12);
assert.equal(report.range.loaded, 734);
assert.equal(enabled.length, 9);
assert.equal(paused.length, 3);
assert.ok(enabled.every((row) => row.pnl > 0 && row.pairedPnl > 0 && row.bootstrapWindowLower95 > 0));
assert.ok(paused.every((row) => row.placements === 0 && row.activeWindows === 0 && row.pnl === 0));
assert.ok(rows.every((row) => row.params.tradePriceMode === "exact"));
assert.ok(rows.every((row) => row.params.orderSize === 5 && row.params.minOrderShares === 5));
assert.ok(rows.every((row) => row.params.takerLatencyMs === 520 && row.takerBuyShares === 0));
assert.ok(rows.every((row) => row.takerShares === 0 || row.fees > 0));
assert.ok(enabled.every((row) => row.params.effectiveMakerLatencyMs === 2733));

const cuts = [
  [Date.parse("2026-08-14T00:00:00Z"), Date.parse("2026-08-22T17:00:00Z")],
  [Date.parse("2026-08-22T17:00:00Z"), Date.parse("2026-08-23T06:15:00Z")],
  [Date.parse("2026-08-23T07:00:00Z"), Date.parse("2026-08-24T00:50:00Z")],
  [Date.parse("2026-08-24T00:50:00Z"), Date.parse("2026-08-24T03:35:00Z")],
  [Date.parse("2026-08-24T03:35:00Z"), Date.parse("2026-08-24T04:35:00Z")],
];
let chronologicalCells = 0, positiveChronologicalCells = 0;
for (const row of enabled) {
  assert.equal(row.windowsDetail.length, 734);
  for (const window of row.windowsDetail) assert.ok(Math.abs(window.pnl - (window.payout - window.cost)) < 1e-9,
    `accounting identity failed for ${window.slug}`);
  for (const [from, to] of cuts) {
    const windows = row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to);
    assert.ok(windows.length > 0);
    if (windows.reduce((sum, window) => sum + window.pnl, 0) > 0) positiveChronologicalCells++;
    chronologicalCells++;
  }
}
assert.equal(chronologicalCells, 45);
assert.equal(positiveChronologicalCells, 42);

const focus = enabled.find((row) => row.params.latencyMs === 2733 && row.params.makerCredit === .1);
assert.ok(focus.pnl > 142 && focus.roiPct > 5 && focus.profitFactor > 1.6);
assert.ok(focus.maxDrawdown < 17.2 && focus.bootstrapWindowLower95 > 65);
console.log(JSON.stringify({ ok: true, stableProfitConfirmed: false,
  reason: "v8 rejected after FIFO trade-volume conservation; only 42/45 chronological stress cells positive",
  file, enabledStressCells: enabled.length, pausedStressCells: paused.length,
  chronologicalStressCells: chronologicalCells, positiveChronologicalCells, focus: { pnl: focus.pnl, roiPct: focus.roiPct,
    profitFactor: focus.profitFactor, maxDrawdown: focus.maxDrawdown } }));
