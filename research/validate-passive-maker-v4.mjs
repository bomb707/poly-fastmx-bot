#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const file = path.resolve(process.argv[2] || path.join(root, "data/research/passive-maker-pair-v4-full-stress.json"));
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = Object.values(report.diagnostics || {});
assert.equal(rows.length, 12, "expected 4 latency x 3 queue-credit stress cells");
assert.equal(report.range.loaded, 734);
assert.ok(rows.every((row) => row.pnl > 0), "every aggregate stress must be profitable");
assert.ok(rows.every((row) => row.pairedPnl > 0), "every aggregate stress must have positive paired PnL");
assert.ok(rows.every((row) => row.bootstrapWindowLower95 > 0), "every aggregate lower-95% bound must be positive");
assert.ok(rows.every((row) => row.params.takerLatencyMs === 520), "taker latency must remain 520ms");
assert.ok(rows.every((row) => row.takerBuyShares === 0), "v4 risk control must not use taker buys");
assert.ok(rows.every((row) => row.takerShares === 0 || row.fees > 0), "taker exits must pay fees");

const expectedControls = new Set(["500:5:30", "1500:5:30", "2733:5:30", "5000:60:0"]);
assert.deepEqual(new Set(rows.map((row) => [row.params.latencyMs, row.params.effectiveMinTimeS,
  row.params.effectiveUnpairedTimeoutS].join(":"))), expectedControls);

const cuts = [
  [Date.parse("2026-08-14T00:00:00Z"), Date.parse("2026-08-22T17:00:00Z")],
  [Date.parse("2026-08-22T17:00:00Z"), Date.parse("2026-08-23T06:15:00Z")],
  [Date.parse("2026-08-23T07:00:00Z"), Date.parse("2026-08-24T00:50:00Z")],
  [Date.parse("2026-08-24T00:50:00Z"), Date.parse("2026-08-24T03:35:00Z")],
  [Date.parse("2026-08-24T03:35:00Z"), Date.parse("2026-08-24T04:35:00Z")],
];
let chronologicalCells = 0;
for (const row of rows) {
  assert.equal(row.windowsDetail.length, 734);
  for (const window of row.windowsDetail) assert.ok(Math.abs(window.pnl - (window.payout - window.cost)) < 1e-9,
    `accounting identity failed for ${window.slug}`);
  for (const [from, to] of cuts) {
    const windows = row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to);
    assert.ok(windows.length > 0);
    assert.ok(windows.reduce((sum, window) => sum + window.pnl, 0) > 0, "chronological stress cell must be profitable");
    chronologicalCells++;
  }
}
assert.equal(chronologicalCells, 60);

const focus = rows.find((row) => row.params.latencyMs === 2733 && row.params.makerCredit === .1);
assert.ok(focus);
assert.ok(focus.pnl > 118 && focus.profitFactor > 3 && focus.roiPct > 8.9);
assert.ok(focus.maxDrawdown < 3 && focus.residualPnl > 0);
console.log(JSON.stringify({ ok: true, file, aggregateStressCells: rows.length, chronologicalStressCells: chronologicalCells,
  focus: { pnl: focus.pnl, roiPct: focus.roiPct, profitFactor: focus.profitFactor, maxDrawdown: focus.maxDrawdown } }));
