#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const maker130 = read("data/research/passive-maker-balanced-inventory-pair-cap-maker130.json");
const maker200 = read("data/research/passive-maker-balanced-inventory-pair-cap-maker200.json");
const latencyStress = read("data/research/passive-maker-balanced-inventory-pair-cap-latency-stress.json");
const original = read("data/research/passive-maker-maker130-candidate-500-5-deep-event-order-corrected.json");
const selected = read("research/passive-maker-maker130-selected-v14.json");
const forwardFile = path.join(ROOT, "data/research/passive-maker-forward-v14-state.json");
const originalSlugs = new Set(Object.values(original.diagnostics)[0].windowsDetail.map((row) => row.slug));

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

function chronologicalFolds(windows, count = 5) {
  return Array.from({ length: count }, (_, index) => {
    const rows = windows.slice(Math.floor(index * windows.length / count), Math.floor((index + 1) * windows.length / count));
    return { index: index + 1, windows: rows.length,
      activeWindows: rows.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 0).length,
      pnl: rows.reduce((total, row) => total + Number(row.pnl || 0), 0) };
  });
}

function dayPnls(windows) {
  const daily = new Map();
  for (const row of windows) {
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + Number(row.pnl || 0));
  }
  return [...daily.values()];
}

function confidence(row, windows = row.windowsDetail) {
  const values = windows.map((window) => Number(window.pnl || 0));
  const folds = chronologicalFolds(windows);
  return {
    windows: windows.length,
    activeWindows: windows.filter((window) => Number(window.makerShares || 0) + Number(window.takerShares || 0) > 0).length,
    pnl: values.reduce((total, value) => total + value, 0),
    windowLower95: bootstrapLower(values, 20_000, 0x3048d653),
    dayLower95: bootstrapLower(dayPnls(windows), 20_000, 0x21be3497),
    folds,
  };
}

assert.equal(selected.length, 1);
assert.equal(selected[0].balancedInventoryPairBidCap, selected[0].pairQuoteCap);
assert.equal(selected[0].pairQuoteCap, .88);
assert.equal(selected[0].takerLatencyMs, 520);
for (const output of [maker130, maker200, latencyStress]) {
  assert.equal(output.range.loaded, 2869);
  assert.ok(output.range.failed / output.range.discovered <= .05);
}

const focusRows = [
  maker130.diagnostics["balanced_cap_088_130ms_credit0.075"],
  maker130.diagnostics["balanced_cap_088_130ms_credit0.1"],
];
const historical = focusRows.map((row) => ({
  makerCredit: row.params.makerCredit,
  profitFactor: row.profitFactor,
  maxDrawdown: row.maxDrawdown,
  drawdownPctGrossBuySpend: row.maxDrawdown / row.grossBuySpend * 100,
  ...confidence(row),
}));
const newWindow = focusRows.map((row) => ({ makerCredit: row.params.makerCredit,
  ...confidence(row, row.windowsDetail.filter((window) => !originalSlugs.has(window.slug))) }));

const latency = [maker200, latencyStress].flatMap((output) => Object.values(output.diagnostics))
  .filter((row) => row.params.balancedInventoryPairBidCap === .88)
  .map((row) => ({ makerLatencyMs: row.params.effectiveMakerLatencyMs, makerCredit: row.params.makerCredit,
    pnl: row.pnl, profitFactor: row.profitFactor, maxDrawdown: row.maxDrawdown,
    windowLower95: row.bootstrapWindowLower95, dayLower95: row.bootstrapDayLower95,
    folds: chronologicalFolds(row.windowsDetail) }));

const parameterNeighborhood = [maker130, maker200, latencyStress].flatMap((output) => Object.values(output.diagnostics))
  .filter((row) => Number(row.params.balancedInventoryPairBidCap) >= .88
    && Number(row.params.balancedInventoryPairBidCap) <= .96)
  .map((row) => ({ cap: row.params.balancedInventoryPairBidCap,
    makerLatencyMs: row.params.effectiveMakerLatencyMs, makerCredit: row.params.makerCredit,
    pnl: row.pnl, profitFactor: row.profitFactor, maxDrawdown: row.maxDrawdown }));

let forwardPassed = false;
let forward = null;
if (fs.existsSync(forwardFile)) {
  forward = JSON.parse(fs.readFileSync(forwardFile, "utf8"));
  forwardPassed = forward.assessment?.passed === true;
}

const requirements = {
  fullHistoricalConfidencePasses: historical.every((row) => row.pnl > 0 && row.profitFactor >= 1.25
    && row.windowLower95 > 0 && row.dayLower95 > 0 && row.drawdownPctGrossBuySpend <= 5),
  independentNewWindowConfidencePasses: newWindow.every((row) => row.pnl > 0
    && row.windowLower95 > 0 && row.dayLower95 > 0),
  realisticLatencyConfidencePasses: latency.every((row) => row.pnl > 0 && row.profitFactor >= 1.25
    && row.windowLower95 > 0 && row.dayLower95 > 0),
  parameterNeighborhoodPositive: parameterNeighborhood.length >= 20
    && parameterNeighborhood.every((row) => row.pnl > 0 && row.profitFactor >= 1.25),
  everyHistoricalFoldActiveAndPositive: historical.every((row) => row.folds.every((fold) => fold.activeWindows > 0 && fold.pnl > 0)),
  everyNewWindowFoldActiveAndPositive: newWindow.every((row) => row.folds.every((fold) => fold.activeWindows > 0 && fold.pnl > 0)),
  frozenForward30DayPasses: forwardPassed,
};
const stableProfitConfirmed = Object.values(requirements).every(Boolean);

// Fail closed until the late-fold activity and untouched 30-day cohort gates
// are genuinely satisfied and reviewed before any promotion.
assert.equal(stableProfitConfirmed, false, "v14 unexpectedly passed every stable-profit gate; audit before promotion");
console.log(JSON.stringify({ schema: 1, candidate: "v14", historical, newWindow, latency,
  parameterNeighborhood, forward: forward?.assessment || null, requirements, stableProfitConfirmed }, null, 2));
