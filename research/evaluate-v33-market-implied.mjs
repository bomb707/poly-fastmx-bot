#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const phase = String(process.argv[2] || "screen");
if (!["screen", "neighborhood", "full"].includes(phase)) throw new Error("phase must be screen, neighborhood, or full");
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const reports = Object.fromEntries(["v2", "v4"].map((source) => [source,
  read(`data/research/passive-maker-v33-market-implied-${phase}-${source}.json`)]));
const authoritative = {
  v25: Object.fromEntries(["v2", "v4"].map((source) => [source,
    read(`data/research/passive-maker-v25-partial-cancel-stress-${source}.json`)])),
  v31: Object.fromEntries(["v2", "v4"].map((source) => [source,
    read(`data/research/passive-maker-v31-feed-geometric-full-${source}.json`)])),
};
const screen = phase === "neighborhood" ? Object.fromEntries(["v2", "v4"].map((source) => [source,
  read(`data/research/passive-maker-v33-market-implied-screen-${source}.json`)])) : null;
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const summaryFields = ["windows", "activeWindows", "placements", "cancels", "rejected", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl", "residualPnl",
  "maxDrawdown", "profitFactor", "bootstrapWindowLower95", "bootstrapDayLower95"];
const rowFields = ["slug", "placements", "cancels", "rejected", "overweightCancelTriggers", "overweightCancelRequests",
  "residualSignalEntries", "residualSignalReversals", "residualDirectionalPlacements", "residualReversalPlacements",
  "residualIndependentPlacements", "residualCancelTriggers", "residualCancelRequests", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "up", "down", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl",
  "residualPnl", "heldToSettlementShares", "firstMakerFillT", "firstMakerSide", "firstMakerPrice", "firstMakerRole"];
const economicRowFields = ["slug", "placements", "cancels", "rejected", "makerFillEvents", "takerFillEvents",
  "makerShares", "takerShares", "up", "down", "grossBuySpend", "fees", "makerRebate", "payout", "pnl", "pairedPnl",
  "residualPnl", "heldToSettlementShares", "firstMakerFillT", "firstMakerSide", "firstMakerPrice", "firstMakerRole"];

function cell(report, name, latency, credit) {
  return Object.values(report.diagnostics || {}).find((entry) => entry.params.name === name
    && Number(entry.params.latencyMs) === latency && Number(entry.params.makerCredit) === credit);
}

function exact(left, right, comparedRowFields = rowFields) {
  const summary = summaryFields.every((field) => Object.is(left?.[field] ?? null, right?.[field] ?? null));
  const a = left?.windowsDetail || [], b = right?.windowsDetail || [];
  let differing = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (!a[index] || !b[index] || comparedRowFields.some((field) => !Object.is(a[index]?.[field] ?? null, b[index]?.[field] ?? null))) differing++;
  }
  return { actualWindows: a.length, expectedWindows: b.length, differing,
    passed: summary && a.length === b.length && differing === 0 };
}
const exactEconomics = (left, right) => exact(left, right, economicRowFields);

function folds(entry) {
  const from = Date.parse("2026-08-16T00:00:00Z"), to = Date.parse("2026-08-25T12:55:00Z"), width = (to - from) / 3;
  return [0, 1, 2].map((index) => {
    const start = from + width * index, end = index === 2 ? to : from + width * (index + 1);
    const rows = (entry?.windowsDetail || []).filter((row) => row.startMs >= start && row.startMs < end);
    return { index: index + 1,
      activeWindows: rows.filter((row) => Number(row.makerShares) + Number(row.takerShares) > 1e-9).length,
      pnl: round(rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0)) };
  });
}

function executionInvariants(entry, enabled = true) {
  const p = entry?.params || {};
  return p.postOnly === true && p.fillSource === "trades" && p.tradePriceMode === "exact"
    && Number(p.targetMakerLatencyMs) === 130 && Number(p.takerLatencyMs) === 520
    && Number(p.cancelLatencyMs) === 500 && Number(p.pauseMakerAboveLatencyMs) === 250
    && p.safeHedgeEveryTick === false && Number(p.endLiquidateS) === 0 && Number(p.unpairedTimeoutS) === 0
    && Number(p.residualTargetShares) === 5 && Number(p.residualBaseOrderShares) === 5
    && Number(p.makerRebateRate) === 0 && p.makerTradingEnabled === enabled;
}

function selectedParams(entry, expected = {}) {
  return Object.entries(expected).every(([key, value]) => Object.is(entry?.params?.[key], value));
}

function assess(entry, expected = {}) {
  const chronological = folds(entry);
  const metrics = { activeWindows: Number(entry?.activeWindows), spend: Number(entry?.grossBuySpend), pnl: Number(entry?.pnl),
    roiPct: Number(entry?.roiPct), maxDrawdown: Number(entry?.maxDrawdown), profitFactor: Number(entry?.profitFactor),
    bootstrapWindowLower95: Number(entry?.bootstrapWindowLower95), bootstrapDayLower95: Number(entry?.bootstrapDayLower95),
    takerFillEvents: Number(entry?.takerFillEvents), fees: Number(entry?.fees), makerRebate: Number(entry?.makerRebate),
    partialFillCancelTriggers: Number(entry?.overweightCancelTriggers), folds: chronological };
  const requirements = { activeWindowsAtLeast75: metrics.activeWindows >= 75, positivePnl: metrics.pnl > 0,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5, maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0, positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    everyChronologicalFoldPositive: chronological.every((fold) => fold.pnl > 0), executionInvariants: executionInvariants(entry),
    noTakerFillsOrFees: metrics.takerFillEvents === 0 && metrics.fees === 0, zeroMakerRebate: metrics.makerRebate === 0,
    partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0, selectedParams: selectedParams(entry, expected) };
  return { metrics, requirements, passed: Object.values(requirements).every(Boolean) };
}

function paused(entry) {
  return executionInvariants(entry, false)
    && ["placements", "cancels", "makerFillEvents", "takerFillEvents", "makerShares", "takerShares",
      "grossBuySpend", "fees", "makerRebate", "pnl"].every((field) => Number(entry?.[field] || 0) === 0);
}

const centerExpected = { residualMarketWeight: 1, residualMaxSpotMarketProbabilityGap: 1 };
let output;
if (phase === "screen") {
  const aggregationPolicies = {
    v33_market_implied_conservative: "conservative",
    v33_market_implied_harmonic: "harmonic",
    v33_market_implied_geometric: "geometric",
    v33_market_implied_arithmetic: "arithmetic",
  };
  const sources = {};
  for (const source of ["v2", "v4"]) {
    sources[source] = {};
    for (const latency of [130, 200]) for (const credit of [.025, .05]) {
      const key = `${latency}ms_credit${credit}`;
      const v25 = cell(reports[source], "v25_control", latency, credit);
      const v31 = cell(reports[source], "v31_control", latency, credit);
      const center = cell(reports[source], "v33_market_implied_weighted", latency, credit);
      sources[source][key] = { controls: {
        v25: exact(v25, cell(authoritative.v25[source], "partial_cancel_v25_selected", latency, credit)),
        v31: exact(v31, cell(authoritative.v31[source], "v31_feed_geometric", latency, credit)),
      }, center: assess(center, { ...centerExpected, residualGapAggregation: "weighted" }),
      changesEconomicsVsV31: !exactEconomics(center, v31).passed,
      aggregationVariants: Object.fromEntries(Object.entries(aggregationPolicies).map(([name, aggregation]) => {
        const candidate = cell(reports[source], name, latency, credit);
        return [name, { assessment: assess(candidate, { ...centerExpected, residualGapAggregation: aggregation }),
          exactEconomicIdentityWithCenter: exactEconomics(candidate, center) }];
      })) };
    }
  }
  const rows = Object.values(sources).flatMap((source) => Object.values(source));
  const controlsReproduced = rows.every((row) => row.controls.v25.passed && row.controls.v31.passed);
  const centerPasses = rows.every((row) => row.center.passed && row.changesEconomicsVsV31);
  const aggregationInvariant = rows.every((row) => Object.values(row.aggregationVariants)
    .every((variant) => variant.assessment.requirements.selectedParams
      && variant.exactEconomicIdentityWithCenter.passed));
  output = { schema: 1, generatedAt: new Date().toISOString(), phase,
    methodology: "Predeclared V33 screen: same-direction Binance/Chainlink support chooses the eligible side, while CLOB midpoint alone supplies fair probability. Five gap aggregators must be economically identical. Exact V25/V31 controls, dual order-book reconstructions, realistic latency, conserved maker credit, fixed folds, confidence tails, drawdown, activity, and zero taker/rebate dependence are mandatory.",
    promotion: { controlsReproduced, centerPasses, aggregationInvariant,
      passed: controlsReproduced && centerPasses && aggregationInvariant }, sources };
} else if (phase === "neighborhood") {
  const specs = {
    v33_ttl700: { ttlMs: 700 }, v33_ttl800: { ttlMs: 800 },
    v33_entry0525: { residualEntryProbability: .525 }, v33_entry0575: { residualEntryProbability: .575 },
    v33_edge0025: { residualMinExpectedEdge: .025 }, v33_edge0035: { residualMinExpectedEdge: .035 },
    v33_bid_offset_m001: { bidOffset: -.01 }, v33_bid_offset_m003: { bidOffset: -.03 },
    v33_market_weight090: { residualMarketWeight: .9 },
  };
  const sources = {}, exercised = Object.fromEntries(Object.keys(specs).map((name) => [name, false]));
  for (const source of ["v2", "v4"]) {
    sources[source] = {};
    for (const latency of [130, 200]) {
      const key = `${latency}ms_credit0.025`;
      const control = cell(reports[source], "v25_control", latency, .025);
      const center = cell(reports[source], "v33_center", latency, .025);
      const screenCenter = cell(screen[source], "v33_market_implied_weighted", latency, .025);
      sources[source][key] = { control: exact(control,
        cell(authoritative.v25[source], "partial_cancel_v25_selected", latency, .025)),
      centerReproduction: exact(center, screenCenter), center: assess(center, centerExpected), neighbors: {} };
      for (const [name, override] of Object.entries(specs)) {
        const candidate = cell(reports[source], name, latency, .025);
        const expected = name === "v33_market_weight090"
          ? { ...centerExpected, ...override } : { ...centerExpected, ...override };
        const economicIdentity = exactEconomics(candidate, center);
        if (!economicIdentity.passed) exercised[name] = true;
        sources[source][key].neighbors[name] = { assessment: assess(candidate, expected), economicIdentityWithCenter: economicIdentity };
      }
    }
  }
  const rows = Object.values(sources).flatMap((source) => Object.values(source));
  const controlsReproduced = rows.every((row) => row.control.passed);
  const centerReproduced = rows.every((row) => row.centerReproduction.passed && row.center.passed);
  const everyNeighborPasses = rows.every((row) => Object.values(row.neighbors).every((neighbor) => neighbor.assessment.passed));
  const everyNeighborExercised = Object.values(exercised).every(Boolean);
  output = { schema: 1, generatedAt: new Date().toISOString(), phase,
    methodology: "Predeclared immediate V33 neighborhood at 2.5% conserved credit: symmetric TTL, entry-probability, edge, and quote-offset perturbations plus a 10% Brownian-probability admixture. Every V2/V4 and 130/200ms cell must pass, every perturbation must change economics in at least one cell, and the V25 control and V33 center must reproduce exactly.",
    promotion: { controlsReproduced, centerReproduced, expectedNeighbors: Object.keys(specs).length === 9,
      everyNeighborPasses, everyNeighborExercised,
      passed: controlsReproduced && centerReproduced && Object.keys(specs).length === 9
        && everyNeighborPasses && everyNeighborExercised }, exercised, sources };
} else {
  const sources = {};
  for (const source of ["v2", "v4"]) {
    sources[source] = {};
    for (const latency of [130, 200, 300]) for (const credit of [.025, .05, .075, .1]) {
      const key = `${latency}ms_credit${credit}`;
      const v25 = cell(reports[source], "v25_control", latency, credit);
      const v31 = cell(reports[source], "v31_control", latency, credit);
      const center = cell(reports[source], "v33_market_implied", latency, credit);
      sources[source][key] = { controls: {
        v25: exact(v25, cell(authoritative.v25[source], "partial_cancel_v25_selected", latency, credit)),
        v31: exact(v31, cell(authoritative.v31[source], "v31_feed_geometric", latency, credit)),
      }, ...(latency === 300 ? { paused: [v25, v31, center].every(paused) }
        : { center: assess(center, { ...centerExpected, residualGapAggregation: "weighted" }) }) };
    }
  }
  const rows = Object.values(sources).flatMap((source) => Object.values(source));
  const controlsReproduced = rows.every((row) => row.controls.v25.passed && row.controls.v31.passed);
  const everyEnabledCellPasses = rows.filter((row) => row.center).every((row) => row.center.passed);
  const everyOverLatencyCellPaused = rows.filter((row) => Object.hasOwn(row, "paused")).every((row) => row.paused);
  output = { schema: 1, generatedAt: new Date().toISOString(), phase,
    methodology: "Gated V33 full stress over V2/V4, 130/200/300ms, and 2.5%-10% conserved maker credit. Exact V25/V31 controls, every enabled economics gate, and exact pause above the 250ms latency limit are required.",
    promotion: { controlsReproduced, everyEnabledCellPasses, everyOverLatencyCellPaused,
      passed: controlsReproduced && everyEnabledCellPasses && everyOverLatencyCellPaused }, sources };
}

const outputPath = path.join(ROOT, `data/research/passive-maker-v33-market-implied-${phase}-assessment.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
const failures = [];
for (const [source, rows] of Object.entries(output.sources)) for (const [key, row] of Object.entries(rows)) {
  if (row.center && !row.center.passed) failures.push({ source, key, policy: "center",
    failed: Object.entries(row.center.requirements).filter(([, pass]) => !pass).map(([name]) => name), metrics: row.center.metrics });
  for (const [name, neighbor] of Object.entries(row.neighbors || {})) if (!neighbor.assessment.passed)
    failures.push({ source, key, policy: name,
      failed: Object.entries(neighbor.assessment.requirements).filter(([, pass]) => !pass).map(([field]) => field),
      metrics: neighbor.assessment.metrics });
  for (const [name, variant] of Object.entries(row.aggregationVariants || {})) {
    const failed = [!variant.assessment.requirements.selectedParams ? "aggregationSelection" : null,
      !variant.exactEconomicIdentityWithCenter.passed ? "aggregationIdentity" : null].filter(Boolean);
    if (failed.length) failures.push({ source, key, policy: name, failed, metrics: variant.assessment.metrics });
  }
}
console.log(JSON.stringify({ output: path.relative(ROOT, outputPath), promotion: output.promotion, failures }, null, 2));
if (!output.promotion.controlsReproduced) process.exitCode = 2;
