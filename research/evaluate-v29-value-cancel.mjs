#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const feedModel = process.argv[2] === "v30" ? { experiment: "v30-feed-intersection", candidateName: "v30_feed_intersection", aggregation: "conservative" }
  : process.argv[2] === "v31" ? { experiment: "v31-feed-geometric", candidateName: "v31_feed_geometric", aggregation: "geometric" } : null;
const experiment = feedModel?.experiment || "v29-value-cancel";
const candidateName = feedModel?.candidateName || "v29_value_cancel";
const phase = String(feedModel ? process.argv[3] || "screen" : process.argv[2] || "screen");
if (!["screen", "full"].includes(phase)) throw new Error("phase must be screen or full");
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(ROOT, file), "utf8"));
const reports = {
  v2: read(`data/research/passive-maker-${experiment}-${phase}-v2.json`),
  v4: read(`data/research/passive-maker-${experiment}-${phase}-v4.json`),
};
const authoritative = {
  v2: read("data/research/passive-maker-v25-partial-cancel-stress-v2.json"),
  v4: read("data/research/passive-maker-v25-partial-cancel-stress-v4.json"),
};
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const ignoredNewFields = new Set(["residualValueCancelTriggers", "residualValueCancelRequests"]);
const economicFields = ["placements", "cancels", "rejected", "overweightCancelTriggers", "overweightCancelRequests",
  "residualSignalEntries", "residualSignalReversals", "residualDirectionalPlacements", "residualReversalPlacements",
  "residualIndependentPlacements", "residualCancelTriggers", "residualCancelRequests", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "up", "down", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl",
  "residualPnl", "heldToSettlementShares", "firstMakerFillT", "firstMakerSide", "firstMakerPrice", "firstMakerRole"];

function cell(report, name, latency, credit) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params.name === name
    && Number(entry.params.latencyMs) === latency && Number(entry.params.makerCredit) === credit);
}

function exactControl(actual, expected) {
  const summaryFields = ["windows", "activeWindows", "placements", "cancels", "rejected", "makerFillEvents", "takerFillEvents",
    "makerShares", "takerShares", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl", "residualPnl",
    "maxDrawdown", "profitFactor", "bootstrapWindowLower95", "bootstrapDayLower95"];
  const summary = Object.fromEntries(summaryFields.map((field) => [field, {
    actual: actual?.[field] ?? null, expected: expected?.[field] ?? null,
    matches: Object.is(actual?.[field] ?? null, expected?.[field] ?? null),
  }]));
  const left = actual?.windowsDetail || [], right = expected?.windowsDetail || [];
  let differing = 0, maxAbsDifference = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index], b = right[index];
    if (!a || !b || a.slug !== b.slug) { differing++; continue; }
    let rowDiffers = false;
    for (const field of economicFields) {
      if (ignoredNewFields.has(field)) continue;
      const av = a[field] ?? null, bv = b[field] ?? null;
      if (!Object.is(av, bv)) {
        rowDiffers = true;
        if (Number.isFinite(Number(av)) && Number.isFinite(Number(bv)))
          maxAbsDifference = Math.max(maxAbsDifference, Math.abs(Number(av) - Number(bv)));
      }
    }
    if (rowDiffers) differing++;
  }
  return { summary, actualWindows: left.length, expectedWindows: right.length, differing,
    maxAbsDifference: round(maxAbsDifference, 12), passed: left.length === right.length && differing === 0
      && Object.values(summary).every((check) => check.matches) };
}

function folds(entry) {
  const from = Date.parse("2026-08-16T00:00:00Z"), to = Date.parse("2026-08-25T12:55:00Z"), width = (to - from) / 3;
  return [0, 1, 2].map((index) => {
    const start = from + index * width, end = index === 2 ? to : from + (index + 1) * width;
    const rows = (entry.windowsDetail || []).filter((row) => row.startMs >= start && row.startMs < end);
    return { index: index + 1, activeWindows: rows.filter((row) => Number(row.makerShares) + Number(row.takerShares) > 1e-9).length,
      pnl: round(rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0)) };
  });
}

function executionInvariants(entry, makerEnabled) {
  const p = entry?.params || {};
  return p.postOnly === true && p.fillSource === "trades" && p.tradePriceMode === "exact"
    && Number(p.targetMakerLatencyMs) === 130 && Number(p.takerLatencyMs) === 520
    && Number(p.cancelLatencyMs) === 500 && Number(p.pauseMakerAboveLatencyMs) === 250
    && p.safeHedgeEveryTick === false && Number(p.endLiquidateS) === 0
    && Number(p.residualTargetShares) === 5 && Number(p.makerRebateRate) === 0
    && p.makerTradingEnabled === makerEnabled;
}

function assess(entry, control) {
  const chronological = folds(entry);
  const metrics = { activeWindows: Number(entry.activeWindows), spend: Number(entry.grossBuySpend), pnl: Number(entry.pnl),
    roiPct: Number(entry.roiPct), maxDrawdown: Number(entry.maxDrawdown), profitFactor: Number(entry.profitFactor),
    bootstrapWindowLower95: Number(entry.bootstrapWindowLower95), bootstrapDayLower95: Number(entry.bootstrapDayLower95),
    takerFillEvents: Number(entry.takerFillEvents), fees: Number(entry.fees), makerRebate: Number(entry.makerRebate),
    valueCancelTriggers: Number(entry.residualValueCancelTriggers), valueCancelRequests: Number(entry.residualValueCancelRequests),
    gapAggregation: entry.params.residualGapAggregation,
    partialFillCancelTriggers: Number(entry.overweightCancelTriggers), folds: chronological };
  const requirements = {
    activeWindowsAtLeast75: metrics.activeWindows >= 75,
    positivePnl: metrics.pnl > 0,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5,
    maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0,
    positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    everyChronologicalFoldPositive: chronological.every((fold) => fold.pnl > 0),
    executionInvariants: executionInvariants(entry, true),
    noTakerFillsOrFees: metrics.takerFillEvents === 0 && metrics.fees === 0,
    zeroMakerRebate: metrics.makerRebate === 0,
    partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0,
    ...(feedModel ? {
      requestedFeedAggregationSelected: metrics.gapAggregation === feedModel.aggregation,
      feedAggregationChangesEconomicRows: !exactControl(entry, control).passed,
    } : {
      valueCancellationExercised: metrics.valueCancelTriggers > 0 && metrics.valueCancelRequests > 0,
    }),
  };
  return { metrics, requirements, passed: Object.values(requirements).every(Boolean), deltaVsControl: {
    activeWindows: metrics.activeWindows - Number(control.activeWindows),
    pnl: round(metrics.pnl - Number(control.pnl)),
    maxDrawdown: round(metrics.maxDrawdown - Number(control.maxDrawdown)),
    windowLower95: round(metrics.bootstrapWindowLower95 - Number(control.bootstrapWindowLower95)),
    dayLower95: round(metrics.bootstrapDayLower95 - Number(control.bootstrapDayLower95)),
  } };
}

const latencies = phase === "full" ? [130, 200, 300] : [130, 200];
const credits = phase === "full" ? [.025, .05, .075, .1] : [.025, .05];
const sources = {};
for (const source of ["v2", "v4"]) {
  sources[source] = {};
  for (const latency of latencies) for (const credit of credits) {
    const key = `${latency}ms_credit${credit}`;
    const control = cell(reports[source], "v25_control", latency, credit);
    const expected = cell(authoritative[source], "partial_cancel_v25_selected", latency, credit);
    const candidate = cell(reports[source], candidateName, latency, credit);
    const reproduction = exactControl(control, expected);
    if (latency === 300) {
      const paused = [control, candidate].every((entry) => entry.params.makerTradingEnabled === false
        && executionInvariants(entry, false)
        && ["placements", "makerFillEvents", "takerFillEvents", "grossBuySpend", "pnl"].every((field) => Number(entry[field]) === 0));
      sources[source][key] = { controlReproduction: reproduction, paused };
    } else {
      sources[source][key] = { controlReproduction: reproduction, candidate: assess(candidate, control) };
    }
  }
}
const rows = Object.values(sources).flatMap((source) => Object.values(source));
const controlsReproduced = rows.every((row) => row.controlReproduction.passed);
const enabled = rows.filter((row) => row.candidate);
const allCandidateCellsPass = enabled.length > 0 && enabled.every((row) => row.candidate.passed);
const pausedCellsPass = rows.filter((row) => Object.hasOwn(row, "paused")).every((row) => row.paused === true);
const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  phase,
  methodology: feedModel
    ? `Predeclared structural feed aggregation (${feedModel.aggregation}): same-direction Binance and Chainlink gaps are combined without a fitted numeric cutoff; disagreement maps to zero. Exact V25 control reproduction, independent V2/V4 books, realistic latency, conservative conserved maker credit, fixed folds, confidence tails, drawdown, activity, and zero taker/rebate dependence are required.`
    : "Predeclared boolean invariant: a pending directional maker remains valid only while the same causal value predicates that admitted it still pass. No new numeric threshold is fitted. Exact V25 control reproduction, independent V2/V4 books, 130/200ms latency, conservative conserved maker credit, fixed chronological folds, confidence tails, drawdown, activity, zero takers/rebates, and an exercised value-cancellation branch are required.",
  promotion: { controlsReproduced, allCandidateCellsPass, pausedCellsPass, passed: controlsReproduced && allCandidateCellsPass && pausedCellsPass },
  sources,
};
const output = path.join(ROOT, `data/research/passive-maker-${experiment}-${phase}-assessment.json`);
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, output), promotion: result.promotion,
  cells: Object.fromEntries(Object.entries(sources).map(([source, cells]) => [source,
    Object.fromEntries(Object.entries(cells).map(([key, row]) => [key, row.candidate ? {
      passed: row.candidate.passed, metrics: row.candidate.metrics, failed: Object.entries(row.candidate.requirements)
        .filter(([, passed]) => !passed).map(([name]) => name), deltaVsControl: row.candidate.deltaVsControl,
    } : { paused: row.paused }]))])) }, null, 2));
if (!controlsReproduced) process.exitCode = 2;
