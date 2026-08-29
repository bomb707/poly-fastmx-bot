#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const reports = {
  v2: read("data/research/passive-maker-v32-power-ensemble-screen-v2.json"),
  v4: read("data/research/passive-maker-v32-power-ensemble-screen-v4.json"),
};
const controls = {
  v25: {
    v2: read("data/research/passive-maker-v25-partial-cancel-stress-v2.json"),
    v4: read("data/research/passive-maker-v25-partial-cancel-stress-v4.json"),
  },
  v31: {
    v2: read("data/research/passive-maker-v31-feed-geometric-full-v2.json"),
    v4: read("data/research/passive-maker-v31-feed-geometric-full-v4.json"),
  },
};
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const summaryFields = ["windows", "activeWindows", "placements", "cancels", "rejected", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl", "residualPnl",
  "maxDrawdown", "profitFactor", "bootstrapWindowLower95", "bootstrapDayLower95"];
const rowFields = ["slug", "placements", "cancels", "rejected", "overweightCancelTriggers", "overweightCancelRequests",
  "residualSignalEntries", "residualSignalReversals", "residualDirectionalPlacements", "residualReversalPlacements",
  "residualIndependentPlacements", "residualCancelTriggers", "residualCancelRequests", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "up", "down", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl",
  "residualPnl", "heldToSettlementShares", "firstMakerFillT", "firstMakerSide", "firstMakerPrice", "firstMakerRole"];

function cell(report, name, latency, credit) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params.name === name
    && Number(entry.params.latencyMs) === latency && Number(entry.params.makerCredit) === credit);
}

function exact(left, right) {
  const summary = summaryFields.every((field) => Object.is(left?.[field] ?? null, right?.[field] ?? null));
  const a = left?.windowsDetail || [], b = right?.windowsDetail || [];
  let differing = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (!a[index] || !b[index] || rowFields.some((field) => !Object.is(a[index]?.[field] ?? null, b[index]?.[field] ?? null))) differing++;
  }
  return { actualWindows: a.length, expectedWindows: b.length, differing,
    passed: summary && a.length === b.length && differing === 0 };
}

function folds(entry) {
  const from = Date.parse("2026-08-16T00:00:00Z"), to = Date.parse("2026-08-25T12:55:00Z"), width = (to - from) / 3;
  return [0, 1, 2].map((index) => {
    const start = from + width * index, end = index === 2 ? to : from + width * (index + 1);
    const rows = entry.windowsDetail.filter((row) => row.startMs >= start && row.startMs < end);
    return { index: index + 1,
      activeWindows: rows.filter((row) => Number(row.makerShares) + Number(row.takerShares) > 1e-9).length,
      pnl: round(rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0)) };
  });
}

function executionInvariants(entry) {
  const p = entry?.params || {};
  return p.postOnly === true && p.fillSource === "trades" && p.tradePriceMode === "exact"
    && Number(p.targetMakerLatencyMs) === 130 && Number(p.takerLatencyMs) === 520
    && Number(p.cancelLatencyMs) === 500 && Number(p.pauseMakerAboveLatencyMs) === 250
    && p.safeHedgeEveryTick === false && Number(p.endLiquidateS) === 0
    && Number(p.residualTargetShares) === 5 && Number(p.makerRebateRate) === 0
    && p.makerTradingEnabled === true;
}

function assess(entry, v31, aggregation) {
  const chronological = folds(entry);
  const metrics = { activeWindows: Number(entry.activeWindows), spend: Number(entry.grossBuySpend), pnl: Number(entry.pnl),
    roiPct: Number(entry.roiPct), maxDrawdown: Number(entry.maxDrawdown), profitFactor: Number(entry.profitFactor),
    bootstrapWindowLower95: Number(entry.bootstrapWindowLower95), bootstrapDayLower95: Number(entry.bootstrapDayLower95),
    takerFillEvents: Number(entry.takerFillEvents), fees: Number(entry.fees), makerRebate: Number(entry.makerRebate),
    partialFillCancelTriggers: Number(entry.overweightCancelTriggers), aggregation: entry.params.residualGapAggregation,
    folds: chronological };
  const requirements = { activeWindowsAtLeast75: metrics.activeWindows >= 75, positivePnl: metrics.pnl > 0,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5, maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0, positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    everyChronologicalFoldPositive: chronological.every((fold) => fold.pnl > 0), executionInvariants: executionInvariants(entry),
    noTakerFillsOrFees: metrics.takerFillEvents === 0 && metrics.fees === 0, zeroMakerRebate: metrics.makerRebate === 0,
    partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0,
    requestedAggregationSelected: metrics.aggregation === aggregation,
    changesEconomicRowsVsV31: !exact(entry, v31).passed };
  return { metrics, requirements, passed: Object.values(requirements).every(Boolean), deltaVsV31: {
    activeWindows: metrics.activeWindows - Number(v31.activeWindows), pnl: round(metrics.pnl - Number(v31.pnl)),
    maxDrawdown: round(metrics.maxDrawdown - Number(v31.maxDrawdown)),
    windowLower95: round(metrics.bootstrapWindowLower95 - Number(v31.bootstrapWindowLower95)),
    dayLower95: round(metrics.bootstrapDayLower95 - Number(v31.bootstrapDayLower95)) } };
}

const variants = {
  v32_lower_ensemble: "lower-ensemble",
  v32_power_ensemble: "power-ensemble",
  v32_upper_ensemble: "upper-ensemble",
};
const sources = {};
for (const source of ["v2", "v4"]) {
  sources[source] = {};
  for (const latency of [130, 200]) for (const credit of [.025, .05]) {
    const key = `${latency}ms_credit${credit}`;
    const v25 = cell(reports[source], "v25_control", latency, credit);
    const v31 = cell(reports[source], "v31_control", latency, credit);
    sources[source][key] = {
      controls: {
        v25: exact(v25, cell(controls.v25[source], "partial_cancel_v25_selected", latency, credit)),
        v31: exact(v31, cell(controls.v31[source], "v31_feed_geometric", latency, credit)),
      },
      variants: Object.fromEntries(Object.entries(variants).map(([name, aggregation]) =>
        [name, assess(cell(reports[source], name, latency, credit), v31, aggregation)])),
    };
  }
}
const cells = Object.values(sources).flatMap((source) => Object.values(source));
const controlsReproduced = cells.every((row) => row.controls.v25.passed && row.controls.v31.passed);
const variantPass = Object.fromEntries(Object.keys(variants).map((name) => [name,
  cells.every((row) => row.variants[name].passed)]));
const output = { schema: 1, generatedAt: new Date().toISOString(),
  methodology: "Predeclared model-uncertainty ensemble over signed harmonic/geometric/arithmetic Binance/Chainlink gap estimators. The equal-weight three-model center and mandatory lower (harmonic+geometric) and upper (geometric+arithmetic) leave-one-side-out ensembles must all pass both source orientations, 130/200ms, 2.5%/5% conserved credit, activity, PnL/PF/DD, bootstrap, fixed folds, execution invariants, and zero taker/rebate dependence. V25 and V31 controls reproduce exactly.",
  promotion: { controlsReproduced, ...variantPass,
    passed: controlsReproduced && Object.values(variantPass).every(Boolean) }, sources };
const outputPath = path.join(ROOT, "data/research/passive-maker-v32-power-ensemble-screen-assessment.json");
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, outputPath), promotion: output.promotion,
  variants: Object.fromEntries(Object.keys(variants).map((name) => [name,
    Object.fromEntries(Object.entries(sources).map(([source, rows]) => [source,
      Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, {
        passed: row.variants[name].passed, metrics: row.variants[name].metrics,
        failed: Object.entries(row.variants[name].requirements).filter(([, pass]) => !pass).map(([requirement]) => requirement),
        deltaVsV31: row.variants[name].deltaVsV31 }]))]))])) }, null, 2));
if (!controlsReproduced) process.exitCode = 2;
