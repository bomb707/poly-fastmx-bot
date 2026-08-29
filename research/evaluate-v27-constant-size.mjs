#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = {
  screenV2: path.resolve(process.argv[2] || path.join(ROOT, "data/research/passive-maker-v27-constant-size-screen-v2.json")),
  screenV4: path.resolve(process.argv[3] || path.join(ROOT, "data/research/passive-maker-v27-constant-size-screen-v4.json")),
  controlV2: path.resolve(process.argv[4] || path.join(ROOT, "data/research/passive-maker-v25-partial-cancel-stress-v2.json")),
  controlV4: path.resolve(process.argv[5] || path.join(ROOT, "data/research/passive-maker-v25-partial-cancel-stress-v4.json")),
  output: path.resolve(process.argv[6] || path.join(ROOT, "data/research/passive-maker-v27-constant-size-assessment.json")),
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const METRICS = ["windows", "activeWindows", "placements", "cancels", "overweightCancelTriggers", "makerFillEvents",
  "takerFillEvents", "makerShares", "grossBuySpend", "fees", "makerRebate", "pnl", "maxDrawdown",
  "profitFactor", "bootstrapWindowLower95", "bootstrapDayLower95"];

function cell(report, name, latency) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params?.name === name
    && Number(entry.params?.latencyMs) === latency && Number(entry.params?.makerCredit) === 0.025);
}

function exactMetrics(actual, expected) {
  const fields = Object.fromEntries(METRICS.map((field) => [field, {
    actual: actual?.[field] ?? null,
    expected: expected?.[field] ?? null,
    matches: (actual?.[field] ?? null) === (expected?.[field] ?? null),
  }]));
  return { fields, passed: Object.values(fields).every((field) => field.matches) };
}

function exactWindows(actual, control) {
  const left = actual?.windowsDetail || [], right = control?.windowsDetail || [];
  const rightBySlug = new Map(right.map((row) => [row.slug, row]));
  const fields = ["placements", "cancels", "overweightCancelTriggers", "makerFillEvents", "takerFillEvents",
    "makerShares", "grossBuySpend", "pnl", "up", "down"];
  let missing = 0, differing = 0, maxAbsPnlDifference = 0;
  for (const row of left) {
    const other = rightBySlug.get(row.slug);
    if (!other) { missing++; continue; }
    const difference = Math.abs(Number(row.pnl || 0) - Number(other.pnl || 0));
    maxAbsPnlDifference = Math.max(maxAbsPnlDifference, difference);
    if (fields.some((field) => (row[field] ?? null) !== (other[field] ?? null))) differing++;
  }
  return { actualWindows: left.length, controlWindows: right.length, missing, differing,
    maxAbsPnlDifference, exact: left.length === right.length && missing === 0 && differing === 0 };
}

const reports = {
  screen: { v2: read(files.screenV2), v4: read(files.screenV4) },
  control: { v2: read(files.controlV2), v4: read(files.controlV4) },
};
const sources = {};
for (const source of ["v2", "v4"]) {
  sources[source] = {};
  for (const latency of [130, 200]) {
    const screenedControl = cell(reports.screen[source], "v25_control_large15", latency);
    const authoritativeControl = Object.values(reports.control[source].diagnostics || {}).find((entry) =>
      Number(entry.params?.latencyMs) === latency && Number(entry.params?.makerCredit) === 0.025);
    const reproduction = exactMetrics(screenedControl, authoritativeControl);
    const variants = Object.fromEntries(["v27_constant5", "v27_large7p5", "v27_large10"].map((name) => {
      const entry = cell(reports.screen[source], name, latency);
      const metrics = exactMetrics(entry, screenedControl);
      const windows = exactWindows(entry, screenedControl);
      return [name, { metrics, windows, exactNoOp: metrics.passed && windows.exact }];
    }));
    sources[source][`${latency}ms`] = {
      controlReproduction: reproduction,
      variants,
      passed: reproduction.passed && Object.values(variants).every((variant) => variant.exactNoOp),
    };
  }
}
const reproduced = Object.values(sources).flatMap((source) => Object.values(source))
  .every((entry) => entry.controlReproduction.passed);
const everyVariantNoOp = Object.values(sources).flatMap((source) => Object.values(source))
  .every((entry) => Object.values(entry.variants).every((variant) => variant.exactNoOp));
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: "The constant-size hypothesis is accepted as a valid experiment only if the V25 control exactly reproduces all authoritative low-credit summary metrics. Per-window order, fill, inventory, and PnL rows are then compared exactly.",
  sources,
  conclusion: {
    authoritativeControlReproduced: reproduced,
    everySizeVariantExactNoOp: everyVariantNoOp,
    rejectedAsNoOp: reproduced && everyVariantNoOp,
    reason: reproduced && everyVariantNoOp
      ? "With residualTargetShares=5 and residualBaseOrderShares=5, directional need cannot reach the two-base-size condition required to activate residualLargeOrderShares."
      : "The result differs and requires performance validation.",
  },
};
fs.mkdirSync(path.dirname(files.output), { recursive: true });
fs.writeFileSync(files.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, files.output), conclusion: output.conclusion }, null, 2));
if (!reproduced) process.exitCode = 2;
