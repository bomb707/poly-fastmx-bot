#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/wallet3048.js";
import { fillFee, isFeeFill } from "../../engine/fees.js";

const root = path.resolve(import.meta.dirname, "../..");
const manifestPath = path.resolve(process.argv[2]
  || path.join(import.meta.dirname, "correctness-cohort-manifest.json"));
const dataDir = path.resolve(process.argv[3] || path.join(root, "data/wincache"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const round = (value) => +Number(value || 0).toFixed(4);
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function load(entry) {
  const file = path.join(dataDir, entry.name);
  const compressed = fs.readFileSync(file);
  if (hash(compressed) !== entry.sha256) throw new Error(`manifest mismatch: ${entry.name}`);
  const data = JSON.parse(zlib.gunzipSync(compressed));
  data.windowStart = Number(entry.name.match(/-(\d+)_/)?.[1]);
  return data;
}

function purpose(fill) {
  if (fill.reason === "w3048-initial-release") return "firstEntry";
  if (fill.reason === "w3048-directional-reinforcement") return "reinforcement";
  if (fill.reason === "w3048-pair-completion") return "pairing";
  if (fill.reason === "w3048-loss-cap-repair") return "repair";
  return fill.leg || "other";
}

function groupedFillMetrics(fills, keyOf) {
  const groups = {};
  for (const fill of fills) {
    const key = String(keyOf(fill));
    const group = groups[key] ||= { fillEvents: 0, shares: 0, turnover: 0, fees: 0, pnl: 0 };
    group.fillEvents++;
    group.shares += Number(fill.shares) || 0;
    group.turnover += Number(fill.usdc) || 0;
    group.fees += fill._fee;
    group.pnl += fill._pnl;
  }
  for (const group of Object.values(groups)) {
    for (const key of ["shares", "turnover", "fees", "pnl"]) group[key] = round(group[key]);
  }
  return groups;
}

function probabilityMetrics(orders) {
  const observations = orders.filter((order) => Number.isFinite(order.signal?.fairUp)
    && Number.isFinite(order.signal?.clobUpProbability));
  const scored = (field) => observations.reduce((sum, order) => {
    const y = order._winner === "Up" ? 1 : 0;
    return sum + (Number(order.signal[field]) - y) ** 2;
  }, 0) / Math.max(1, observations.length);
  const calibration = [];
  for (let low = 0; low < 1; low += 0.2) {
    const bin = observations.filter((order) => order.signal.fairUp >= low
      && (low >= 0.8 ? order.signal.fairUp <= 1 : order.signal.fairUp < low + 0.2));
    if (!bin.length) continue;
    calibration.push({ low: round(low), high: round(low + 0.2), count: bin.length,
      meanForecast: round(bin.reduce((sum, order) => sum + order.signal.fairUp, 0) / bin.length),
      upRate: round(bin.filter((order) => order._winner === "Up").length / bin.length) });
  }
  return { filledOrders: observations.length,
    heuristicBrier: round(scored("fairUp")), marketBrier: round(scored("clobUpProbability")), calibration };
}

function aggregate(rows, includeDays = true) {
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const row of rows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const fills = rows.flatMap((row) => row._fills);
  const orders = [];
  for (const row of rows) {
    const seen = new Set();
    for (const fill of row._fills) {
      const key = fill.oid ?? fill.fillId;
      if (seen.has(key)) continue;
      seen.add(key);
      orders.push({ ...fill, _winner: row.winner });
    }
  }
  const decisionCost = fills.reduce((sum, fill) => sum
    + (Number.isFinite(fill.decisionExpectedPx) ? fill.decisionExpectedPx * fill.shares : 0), 0);
  const actualCost = fills.reduce((sum, fill) => sum + fill.usdc, 0);
  const result = {
    windows: rows.length,
    activeWindows: rows.filter((row) => row.fills > 0).length,
    fills: rows.reduce((sum, row) => sum + row.fills, 0),
    immediateFills: rows.reduce((sum, row) => sum + row.immediateFills, 0),
    restingFills: rows.reduce((sum, row) => sum + row.restingFills, 0),
    turnover: round(rows.reduce((sum, row) => sum + row.turnover, 0)),
    fees: round(rows.reduce((sum, row) => sum + row.fees, 0)),
    pnl: round(rows.reduce((sum, row) => sum + row.pnl, 0)),
    maxDrawdown: round(maxDrawdown),
    losingWindows: rows.filter((row) => row.pnl < 0).length,
    executionEconomics: { fillsWithDecisionPrice: fills.filter((fill) => Number.isFinite(fill.decisionExpectedPx)).length,
      decisionExpectedCost: round(decisionCost), actualArrivalCost: round(actualCost),
      arrivalMinusDecisionCost: round(actualCost - decisionCost) },
    executionAttribution: groupedFillMetrics(fills, (fill) => fill.maker === true ? "resting" : "immediate"),
    purposeAttribution: groupedFillMetrics(fills, purpose),
    sizeBlockAttribution: groupedFillMetrics(fills, (fill) => fill.requestedShares || "unknown"),
    scenarioRisk: { emittedOrders: orders.length,
      evaluatedScenarios: orders.reduce((sum, order) => sum + (Number(order.signal?.riskScenarios) || 0), 0),
      scenariosOutsideOrdinaryLimits: orders.reduce((sum, order) => sum
        + (Number(order.signal?.scenarioLimitViolations) || 0), 0),
      boundedRepairScenarios: orders.reduce((sum, order) => sum
        + (Number(order.signal?.boundedRepairScenarios) || 0), 0) },
    probabilityDiagnostic: probabilityMetrics(orders),
  };
  if (includeDays) {
    result.byDay = Object.fromEntries([...new Set(rows.map((row) => row.day))]
      .map((day) => [day, aggregate(rows.filter((row) => row.day === day), false)]));
  }
  return result;
}

function evaluate(name, overrides, includeRows = true) {
  const rows = manifest.files.map((entry) => {
    const data = load(entry);
    const fills = simulateFills(data, { ...STRAT, ...overrides });
    const position = positionFromFills(fills, data.winSide, data.ticks);
    const enriched = fills.filter((fill) => fill.leg !== "merge").map((fill) => {
      const fee = Number.isFinite(Number(fill.fee)) ? Number(fill.fee)
        : fillFee(fill.effPx ?? (fill.shares ? fill.usdc / fill.shares : null),
          fill.shares, isFeeFill(fill));
      return { ...fill, _fee: fee,
        _pnl: (fill.side === data.winSide ? fill.shares : 0) - fill.usdc - fee };
    });
    const decisionCost = enriched.reduce((sum, fill) => sum
      + (Number.isFinite(fill.decisionExpectedPx) ? fill.decisionExpectedPx * fill.shares : 0), 0);
    return {
      slug: entry.name.replace("_v2-l2-120-coherent.json.gz", ""),
      day: new Date(data.windowStart * 1000).toISOString().slice(0, 10),
      winner: data.winSide,
      fills: fills.length,
      immediateFills: fills.filter((fill) => fill.maker !== true).length,
      restingFills: fills.filter((fill) => fill.maker === true).length,
      turnover: round(position.totalCost),
      fees: round(position.fee),
      pnl: round(position.realizedPnl),
      decisionExpectedCost: round(decisionCost),
      arrivalMinusDecisionCost: round(position.totalCost - decisionCost),
      _fills: enriched,
    };
  });
  const developmentEnd = manifest.splits.development;
  const validationEnd = developmentEnd + manifest.splits.validation;
  const result = { name, overrides, all: aggregate(rows),
    development: aggregate(rows.slice(0, developmentEnd)),
    validation: aggregate(rows.slice(developmentEnd, validationEnd)),
    holdout: aggregate(rows.slice(validationEnd)) };
  if (includeRows) result.rows = rows.map(({ _fills, ...row }) => row);
  return result;
}

const results = [
  evaluate("strict_causal_strict_no_maker", {
    W3048_MAKER_EXECUTION_POLICY: "strict-no-maker",
  }),
  evaluate("timestamp_assumed_strict_no_maker", {
    W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
    W3048_MAKER_EXECUTION_POLICY: "strict-no-maker",
  }),
  evaluate("historical_zero_setting_relabelled_book_cross_inference", {
    W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
    W3048_MAKER_EXECUTION_POLICY: "book-cross-inference",
  }),
  evaluate("timestamp_assumed_optimistic_touch", {
    W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
    W3048_MAKER_EXECUTION_POLICY: "optimistic-touch",
  }),
];

const comparisons = {
  latency: [0, 520, 1000].map((latencyMs) => evaluate(`latency_${latencyMs}ms`, {
    W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
    W3048_MAKER_EXECUTION_POLICY: "strict-no-maker",
    LATENCY_MS: latencyMs,
  }, false)),
};

console.log(JSON.stringify({ schema: 2, manifest: path.relative(root, manifestPath),
  dataDir, strategySpec: STRAT.W3048_SPEC_VERSION,
  warning: "Sensitivity audit only. This cohort cannot establish out-of-sample profitability.",
  splitWarning: "The historical development/validation/holdout labels are diagnostic only; all 14 windows have already been inspected and none is a sealed final test.",
  executionWarning: "The former zero-maker label was inaccurate: that setting credited unverified book-cross inference. Strict no-maker is now a separate policy. Observed-flow is unavailable because this cohort has no identified public aggressor events or queue data.",
  attributionWarning: "Fill-purpose attribution is descriptive and cannot establish the counterfactual profitability effect of removing repairs or hedges.",
  modelWarning: "Brier scores use filled orders only and are descriptive. No residual model was fitted.",
  results, comparisons }, null, 2));
