#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STRESS = path.join(ROOT, "data/research/passive-maker-maker130-latency-stress-grid.json");
const ORIGINAL = path.join(ROOT, "data/research/passive-maker-maker130-candidate-500-5-deep-event-order-corrected.json");
const FORWARD = path.join(ROOT, "data/research/passive-maker-forward-v13b-state.json");
const stress = JSON.parse(fs.readFileSync(STRESS, "utf8"));
const original = JSON.parse(fs.readFileSync(ORIGINAL, "utf8"));

const originalSlugs = new Set(original.diagnostics["maker130_ttl500_timeout5_130ms_credit0.075"].windowsDetail
  .map((row) => row.slug));
const keys = [
  "q088_e10_rebate20_130ms_credit0.075",
  "q088_e10_rebate20_130ms_credit0.1",
];
const jitterKeys = [
  "q088_e10_rebate20_200ms_credit0.075",
  "q088_e10_rebate20_200ms_credit0.1",
];

function bootstrapLower(values, samples, seed) {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const totals = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)];
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  return totals[Math.floor((totals.length - 1) * .025)];
}

function fiveFolds(windows) {
  return Array.from({ length: 5 }, (_, index) => windows
    .slice(Math.floor(index * windows.length / 5), Math.floor((index + 1) * windows.length / 5))
    .reduce((total, row) => total + Number(row.pnl || 0), 0));
}

assert.equal(stress.range.loaded, 2869);
assert.ok(stress.range.failed / stress.range.discovered <= .05);
const aggregate = keys.map((key) => {
  const row = stress.diagnostics[key];
  assert.ok(row, `missing ${key}`);
  assert.equal(row.params.effectiveMakerLatencyMs, 130);
  assert.equal(row.params.takerLatencyMs, 520);
  assert.equal(row.params.makerRebateRate, .2);
  const positiveDates = Object.values(row.daily).filter((pnl) => pnl > 0).length;
  const folds = fiveFolds(row.windowsDetail);
  return { key, pnl: row.pnl, profitFactor: row.profitFactor, windowLower95: row.bootstrapWindowLower95,
    dayLower95: row.bootstrapDayLower95, positiveDates, folds,
    passes: row.pnl > 0 && row.profitFactor >= 1.25 && row.bootstrapWindowLower95 > 0
      && row.bootstrapDayLower95 > 0 && positiveDates >= 9 && folds.every((pnl) => pnl > 0) };
});

const newWindow = keys.map((key) => {
  const windows = stress.diagnostics[key].windowsDetail.filter((row) => !originalSlugs.has(row.slug));
  const values = windows.map((row) => Number(row.pnl || 0));
  const lower95 = bootstrapLower(values, 20_000, 0x3048d653);
  const folds = fiveFolds(windows);
  return { key, windows: windows.length, pnl: values.reduce((total, value) => total + value, 0), lower95, folds,
    passes: lower95 > 0 && folds.every((pnl) => pnl > 0) };
});

const jitter = jitterKeys.map((key) => {
  const row = stress.diagnostics[key];
  return { key, pnl: row.pnl, windowLower95: row.bootstrapWindowLower95, dayLower95: row.bootstrapDayLower95,
    passes: row.pnl > 0 && row.bootstrapWindowLower95 > 0 && row.bootstrapDayLower95 > 0 };
});
let forwardPassed = false;
if (fs.existsSync(FORWARD)) {
  const state = JSON.parse(fs.readFileSync(FORWARD, "utf8"));
  forwardPassed = state.assessment?.passed === true;
}
const requirements = {
  aggregateHistoricalPasses: aggregate.every((row) => row.passes),
  newWindowBootstrapAndFoldsPass: newWindow.every((row) => row.passes),
  makerLatencyJitterPasses: jitter.every((row) => row.passes),
  frozenForward30DayPasses: forwardPassed,
};
const stableProfitConfirmed = Object.values(requirements).every(Boolean);

// This validator is deliberately fail-closed: the current evidence must not
// be represented as stable until every independent and forward gate passes.
assert.equal(stableProfitConfirmed, false, "v13 unexpectedly passed every stable-profit gate; audit before promotion");
console.log(JSON.stringify({ schema: 1, candidate: "v13", aggregate, newWindow, jitter, requirements,
  stableProfitConfirmed }, null, 2));
