#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.resolve(process.argv[2]
  || path.join(ROOT, "data/research/passive-maker-maker130-baseline-full-stress.json"));
const report = JSON.parse(fs.readFileSync(FILE, "utf8"));
assert.match(report.methodology, /FIFO same-snapshot arrival staging/);
assert.match(report.methodology, /shared, FIFO, volume-conserved maker-credit budget/);
assert.deepEqual(report.range, {
  from: "2026-08-14T00:00:00.000Z", to: "2026-08-24T04:35:00.000Z",
  discovered: 739, loaded: 734, failed: 5,
});

const rows = Object.values(report.diagnostics || {});
assert.equal(rows.length, 12);
assert.deepEqual([...new Set(rows.map((row) => row.params.latencyMs))], [130, 200, 300, 520]);
assert.deepEqual([...new Set(rows.map((row) => row.params.makerCredit))], [.075, .1, .25]);
assert.ok(rows.every((row) => row.params.targetMakerLatencyMs === 130));
assert.ok(rows.every((row) => row.params.takerLatencyMs === 520));
assert.ok(rows.every((row) => row.params.tradePriceMode === "exact" && row.params.postOnly === true));
assert.ok(rows.every((row) => row.params.orderSize === 5 && row.params.minOrderShares === 5));
assert.ok(rows.every((row) => row.takerShares === 0 || row.fees > 0));

const cuts = [
  [Date.parse("2026-08-14T00:00:00Z"), Date.parse("2026-08-22T17:00:00Z")],
  [Date.parse("2026-08-22T17:00:00Z"), Date.parse("2026-08-23T06:15:00Z")],
  [Date.parse("2026-08-23T07:00:00Z"), Date.parse("2026-08-24T00:50:00Z")],
  [Date.parse("2026-08-24T00:50:00Z"), Date.parse("2026-08-24T03:35:00Z")],
  [Date.parse("2026-08-24T03:35:00Z"), Date.parse("2026-08-24T04:35:00Z")],
];
const passes = (row) => {
  const days = Object.values(row.daily || {});
  const folds = cuts.map(([from, to]) => row.windowsDetail.filter((window) => window.startMs >= from && window.startMs < to)
    .reduce((sum, window) => sum + window.pnl, 0));
  return row.pnl > 0 && row.pairedPnl > 0 && row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0
    && days.filter((pnl) => pnl > 0).length / days.length >= .8
    && row.maxDrawdown / row.grossBuySpend <= .05 && folds.every((pnl) => pnl > 0);
};

const actualLatencyRows = rows.filter((row) => row.params.latencyMs === 130);
assert.equal(actualLatencyRows.length, 3);
assert.ok(actualLatencyRows.every((row) => !passes(row) && row.bootstrapWindowLower95 < 0));
const passingRows = rows.filter(passes);
assert.equal(passingRows.length, 1);
assert.equal(passingRows[0].params.latencyMs, 520);
assert.equal(passingRows[0].params.makerCredit, .25);

console.log(JSON.stringify({ ok: true, stableProfitConfirmed: false,
  reason: "the prior p90 policy fails all actual 130ms maker-latency cells; replacement research required",
  file: FILE, actualMakerLatencyMs: 130, takerLatencyMs: 520,
  actualLatencyCellsPassing: actualLatencyRows.filter(passes).length,
  allStressCellsPassing: passingRows.length, totalStressCells: rows.length }));
