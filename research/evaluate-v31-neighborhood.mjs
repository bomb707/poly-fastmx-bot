#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const reports = {
  v2: read("data/research/passive-maker-v31-feed-geometric-neighborhood-v2.json"),
  v4: read("data/research/passive-maker-v31-feed-geometric-neighborhood-v4.json"),
};
const authoritative = {
  v2: read("data/research/passive-maker-v25-partial-cancel-stress-v2.json"),
  v4: read("data/research/passive-maker-v25-partial-cancel-stress-v4.json"),
};
const full = {
  v2: read("data/research/passive-maker-v31-feed-geometric-full-v2.json"),
  v4: read("data/research/passive-maker-v31-feed-geometric-full-v4.json"),
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

function cell(report, name, latency) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params.name === name
    && Number(entry.params.latencyMs) === latency && Number(entry.params.makerCredit) === .025);
}

function exact(left, right) {
  const summary = summaryFields.every((field) => Object.is(left?.[field] ?? null, right?.[field] ?? null));
  const a = left?.windowsDetail || [], b = right?.windowsDetail || [];
  let differing = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (!a[index] || !b[index] || rowFields.some((field) => !Object.is(a[index]?.[field] ?? null, b[index]?.[field] ?? null))) differing++;
  }
  return { actualWindows: a.length, expectedWindows: b.length, differing, passed: summary && a.length === b.length && differing === 0 };
}

function folds(entry) {
  const from = Date.parse("2026-08-16T00:00:00Z"), to = Date.parse("2026-08-25T12:55:00Z"), width = (to - from) / 3;
  return [0, 1, 2].map((index) => {
    const start = from + width * index, end = index === 2 ? to : from + width * (index + 1);
    const rows = entry.windowsDetail.filter((row) => row.startMs >= start && row.startMs < end);
    return { index: index + 1, activeWindows: rows.filter((row) => Number(row.makerShares) + Number(row.takerShares) > 1e-9).length,
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

function assess(entry) {
  const chronological = folds(entry);
  const metrics = { activeWindows: Number(entry.activeWindows), spend: Number(entry.grossBuySpend), pnl: Number(entry.pnl),
    roiPct: Number(entry.roiPct), maxDrawdown: Number(entry.maxDrawdown), profitFactor: Number(entry.profitFactor),
    bootstrapWindowLower95: Number(entry.bootstrapWindowLower95), bootstrapDayLower95: Number(entry.bootstrapDayLower95),
    takerFillEvents: Number(entry.takerFillEvents), fees: Number(entry.fees), makerRebate: Number(entry.makerRebate),
    partialFillCancelTriggers: Number(entry.overweightCancelTriggers), folds: chronological };
  const requirements = { activeWindowsAtLeast75: metrics.activeWindows >= 75, positivePnl: metrics.pnl > 0,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5, maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0, positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    everyChronologicalFoldPositive: chronological.every((fold) => fold.pnl > 0),
    executionInvariants: executionInvariants(entry),
    noTakerFillsOrFees: metrics.takerFillEvents === 0 && metrics.fees === 0,
    zeroMakerRebate: metrics.makerRebate === 0, partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0 };
  return { metrics, requirements, passed: Object.values(requirements).every(Boolean) };
}

const controls = {}, center = {}, policies = {};
for (const source of ["v2", "v4"]) for (const latency of [130, 200]) {
  const key = `${source}_${latency}ms`;
  controls[key] = exact(cell(reports[source], "v25_control", latency),
    cell(authoritative[source], "partial_cancel_v25_selected", latency));
  center[key] = exact(cell(reports[source], "v31_center", latency), cell(full[source], "v31_feed_geometric", latency));
  for (const entry of Object.values(reports[source].diagnostics || {})) {
    if (entry.params.name === "v25_control") continue;
    const name = entry.params.name;
    policies[name] ||= { name, params: entry.params, cells: {} };
    policies[name].cells[key] = assess(entry);
  }
}
for (const policy of Object.values(policies)) {
  const cells = Object.values(policy.cells);
  policy.passed = cells.length === 4 && cells.every((cell) => cell.passed);
  policy.worst = { activeWindows: Math.min(...cells.map((cell) => cell.metrics.activeWindows)),
    pnl: round(Math.min(...cells.map((cell) => cell.metrics.pnl))),
    maxDrawdown: round(Math.max(...cells.map((cell) => cell.metrics.maxDrawdown))),
    profitFactor: round(Math.min(...cells.map((cell) => cell.metrics.profitFactor))),
    windowLower95: round(Math.min(...cells.map((cell) => cell.metrics.bootstrapWindowLower95))),
    dayLower95: round(Math.min(...cells.map((cell) => cell.metrics.bootstrapDayLower95))),
    foldPnl: round(Math.min(...cells.flatMap((cell) => cell.metrics.folds.map((fold) => fold.pnl)))) };
}
const controlsReproduced = Object.values(controls).every((check) => check.passed);
const centerReproduced = Object.values(center).every((check) => check.passed);
const everyNeighborPasses = Object.values(policies).length === 9 && Object.values(policies).every((policy) => policy.passed);
const output = { schema: 1, generatedAt: new Date().toISOString(),
  methodology: "Immediate V31 neighborhood at 2.5% conserved maker credit over independent V2/V4 and 130/200ms. The signed two-feed aggregation is varied to harmonic/geometric/arithmetic, while TTL, market weight, and entry edge receive symmetric one-at-a-time perturbations. Every cell must pass activity, PnL/PF/DD, confidence, fixed folds, zero takers/rebates, and exercised partial-fill cancellation. Controls and the center must reproduce exactly.",
  promotion: { controlsReproduced, centerReproduced, expectedPolicies: Object.values(policies).length === 9,
    everyNeighborPasses, passed: controlsReproduced && centerReproduced && everyNeighborPasses },
  controls, center, policies: Object.values(policies).sort((a, b) => a.name.localeCompare(b.name)) };
const outputPath = path.join(ROOT, "data/research/passive-maker-v31-feed-geometric-neighborhood-assessment.json");
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, outputPath), promotion: output.promotion,
  policies: output.policies.map(({ name, passed, worst }) => ({ name, passed, worst })) }, null, 2));
if (!controlsReproduced || !centerReproduced) process.exitCode = 2;
