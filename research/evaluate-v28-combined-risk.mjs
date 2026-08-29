#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = {
  screenV2: path.resolve(process.argv[2] || path.join(ROOT, "data/research/passive-maker-v28-combined-risk-screen-v2.json")),
  screenV4: path.resolve(process.argv[3] || path.join(ROOT, "data/research/passive-maker-v28-combined-risk-screen-v4.json")),
  v25V2: path.resolve(process.argv[4] || path.join(ROOT, "data/research/passive-maker-v25-partial-cancel-stress-v2.json")),
  v25V4: path.resolve(process.argv[5] || path.join(ROOT, "data/research/passive-maker-v25-partial-cancel-stress-v4.json")),
  v20V2: path.resolve(process.argv[6] || path.join(ROOT, "data/research/passive-maker-v20-market-calibrated-smoke-v2.json")),
  v20V4: path.resolve(process.argv[7] || path.join(ROOT, "data/research/passive-maker-v20-market-calibrated-smoke-v4.json")),
  output: path.resolve(process.argv[8] || path.join(ROOT, "data/research/passive-maker-v28-combined-risk-assessment.json")),
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const CONTROL_FIELDS = ["windows", "activeWindows", "placements", "cancels", "makerFillEvents", "takerFillEvents",
  "grossBuySpend", "pnl", "maxDrawdown", "profitFactor", "bootstrapWindowLower95", "bootstrapDayLower95"];

function cell(report, name, latency) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params?.name === name
    && Number(entry.params?.latencyMs) === latency && Number(entry.params?.makerCredit) === 0.025);
}

function canonicalCell(report, latency) {
  return Object.values(report.diagnostics || {}).find((entry) => Number(entry.params?.latencyMs) === latency
    && Number(entry.params?.makerCredit) === 0.025);
}

function reproduce(actual, expected) {
  const fields = Object.fromEntries(CONTROL_FIELDS.map((field) => [field, {
    actual: actual?.[field] ?? null,
    expected: expected?.[field] ?? null,
    matches: (actual?.[field] ?? null) === (expected?.[field] ?? null),
  }]));
  return { fields, passed: Object.values(fields).every((field) => field.matches) };
}

function folds(entry, fromMs, toMs) {
  const width = (toMs - fromMs) / 3;
  return [0, 1, 2].map((index) => {
    const from = fromMs + index * width;
    const to = index === 2 ? toMs : fromMs + (index + 1) * width;
    const rows = (entry.windowsDetail || []).filter((row) => row.startMs >= from && row.startMs < to);
    return {
      index: index + 1,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      activeWindows: rows.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9).length,
      pnl: round(rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0)),
    };
  });
}

function assess(entry, fromMs, toMs) {
  const chronologicalFolds = folds(entry, fromMs, toMs);
  const metrics = {
    activeWindows: Number(entry.activeWindows),
    spend: Number(entry.grossBuySpend),
    pnl: Number(entry.pnl),
    roiPct: Number(entry.roiPct),
    maxDrawdown: Number(entry.maxDrawdown),
    profitFactor: Number(entry.profitFactor),
    bootstrapWindowLower95: Number(entry.bootstrapWindowLower95),
    bootstrapDayLower95: Number(entry.bootstrapDayLower95),
    takerFillEvents: Number(entry.takerFillEvents),
    fees: Number(entry.fees),
    makerRebate: Number(entry.makerRebate),
    partialFillCancelTriggers: Number(entry.overweightCancelTriggers),
    folds: chronologicalFolds,
  };
  const evidence = {
    activeWindowsAtLeast75: metrics.activeWindows >= 75,
    positivePnl: metrics.pnl > 0,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0,
    positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5,
    maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    everyChronologicalFoldPositive: chronologicalFolds.length === 3
      && chronologicalFolds.every((fold) => fold.pnl > 0),
    noTakerFillsOrFees: metrics.takerFillEvents === 0 && metrics.fees === 0,
    zeroMakerRebate: metrics.makerRebate === 0,
    partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0,
  };
  return { metrics, evidence, passed: Object.values(evidence).every(Boolean) };
}

const reports = {
  screen: { v2: read(files.screenV2), v4: read(files.screenV4) },
  v25: { v2: read(files.v25V2), v4: read(files.v25V4) },
  v20: { v2: read(files.v20V2), v4: read(files.v20V4) },
};
const fromMs = Date.parse("2026-08-16T00:00:00Z"), toMs = Date.parse("2026-08-25T12:55:00Z");
const sources = {};
for (const source of ["v2", "v4"]) {
  sources[source] = {};
  for (const latency of [130, 200]) {
    const v25 = cell(reports.screen[source], "v25_control", latency);
    const v20 = cell(reports.screen[source], "v20_control", latency);
    const candidate = cell(reports.screen[source], "v28_combined", latency);
    const v25Reproduction = reproduce(v25, canonicalCell(reports.v25[source], latency));
    const v20Reproduction = reproduce(v20, canonicalCell(reports.v20[source], latency));
    const candidateAssessment = assess(candidate, fromMs, toMs);
    sources[source][`${latency}ms`] = {
      controls: { v25: v25Reproduction, v20: v20Reproduction },
      candidate: candidateAssessment,
      deltaVsV25: {
        pnl: round(candidateAssessment.metrics.pnl - Number(v25.pnl)),
        maxDrawdown: round(candidateAssessment.metrics.maxDrawdown - Number(v25.maxDrawdown)),
        activeWindows: candidateAssessment.metrics.activeWindows - Number(v25.activeWindows),
      },
      passed: v25Reproduction.passed && v20Reproduction.passed && candidateAssessment.passed,
    };
  }
}
const controlsReproduced = Object.values(sources).flatMap((source) => Object.values(source))
  .every((cellResult) => cellResult.controls.v25.passed && cellResult.controls.v20.passed);
const everyCandidateCellPassed = Object.values(sources).flatMap((source) => Object.values(source))
  .every((cellResult) => cellResult.candidate.passed);
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: "Predeclared structural combination: V20's market-calibrated residual model plus V25's partial-fill cancellation and one-tick repricing. Each constituent control must exactly reproduce its authoritative 2.5%-credit replay before the combined candidate can be evaluated.",
  range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  sources,
  promotionToFullStress: {
    constituentControlsReproduced: controlsReproduced,
    everyV2V4LatencyCellPassed: everyCandidateCellPassed,
    passed: controlsReproduced && everyCandidateCellPassed,
  },
};
fs.mkdirSync(path.dirname(files.output), { recursive: true });
fs.writeFileSync(files.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, files.output), promotionToFullStress: output.promotionToFullStress,
  cells: Object.fromEntries(Object.entries(sources).map(([source, values]) => [source, Object.fromEntries(Object.entries(values)
    .map(([latency, value]) => [latency, { passed: value.passed, metrics: value.candidate.metrics,
      failed: Object.entries(value.candidate.evidence).filter(([, pass]) => !pass).map(([name]) => name),
      deltaVsV25: value.deltaVsV25 }]))])) }, null, 2));
if (!controlsReproduced) process.exitCode = 2;
