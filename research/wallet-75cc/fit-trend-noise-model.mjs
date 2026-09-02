#!/usr/bin/env node
// Fit a causal winner-probability model at the current target75cc decisions.
// Discovery split: Aug 20-24 train, Aug 25 validation, Aug 26 holdout.
// The final winner is a supervised label only; every input is reconstructed at
// or before the decision timestamp from the same BAPI v2 cache used by replay.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills } from "../../engine/simrun.js";
import { fillFee } from "../../engine/fees.js";
import { STRAT as TARGET } from "../../engine/strategies/target75cc.js";
import { MODEL_META } from "../../engine/strategies/target75cc-model.js";
import { RELEASE_META } from "../../engine/strategies/target75cc-release-model.js";
import { REGIME_FEATURE_NAMES, regimeFeatures, regimePriorAt }
  from "../../engine/strategies/target75cc-regime-features.js";

const root = path.resolve(import.meta.dirname, "../..");
const cacheDir = path.resolve(process.argv[2] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[3]
  || path.join(root, "data/wallet-75cc/exact-2026-08-20_2026-08-27/trend-noise-model.json"));
const exportFile = path.resolve(process.argv[4]
  || path.join(root, "engine/strategies/target75cc-regime-model.js"));
const start = Date.parse("2026-08-20T00:00:00Z") / 1_000;
const end = Date.parse("2026-08-27T00:00:00Z") / 1_000;
const trainEnd = Date.parse("2026-08-25T00:00:00Z") / 1_000;
const validationEnd = Date.parse("2026-08-26T00:00:00Z") / 1_000;
const finite = (input) => Number.isFinite(Number(input));
const round = (input, digits = 6) => finite(input) ? +Number(input).toFixed(digits) : null;
const hash = (input) => crypto.createHash("sha256").update(input).digest("hex");
// Freeze the decision population to the pre-enhancement strategy. Without this
// override a regenerated dataset would feed the newly enabled regime model back
// into its own training rows.
const baselineStrategy = { ...TARGET, T_REGIME_ON: false, T_REGIME_DIAGNOSTICS: false };
const baselinePolicySha256 = hash(JSON.stringify({
  params: baselineStrategy,
  releaseModelSha256: RELEASE_META.modelSha256,
  residualModelSha256: MODEL_META.residualSha256,
  crossModelSha256: MODEL_META.crossSha256,
}));

function levels(rows, ascending) {
  return (Array.isArray(rows) ? rows : []).map((row) => [
    Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((a, b) => ascending ? a[0] - b[0] : b[0] - a[0]);
}

function sideSnapshot(tick, side) {
  const nested = side === "Up" ? tick?.up : tick?.down;
  const asks = levels(nested?.asks, true), bids = levels(nested?.bids, false);
  const ask = Number(nested?.bestAsk ?? (side === "Up" ? tick?.upAsk : tick?.dnAsk) ?? asks[0]?.[0]);
  const bid = Number(nested?.bestBid ?? (side === "Up" ? tick?.upBid : tick?.dnBid) ?? bids[0]?.[0]);
  return {
    ask: finite(ask) ? ask : null,
    bid: finite(bid) ? bid : null,
    askDepth1: asks[0]?.[1] || 0,
    bidDepth1: bids[0]?.[1] || 0,
    askDepth3: asks.slice(0, 3).reduce((sum, row) => sum + row[1], 0),
    bidDepth3: bids.slice(0, 3).reduce((sum, row) => sum + row[1], 0),
  };
}

function snapshots(feed, windowStart) {
  return (feed.ticks || []).map((tick) => ({
    ms: finite(tick.ms) ? Number(tick.ms) : (windowStart + Number(tick.t || 0)) * 1_000,
    bz: finite(tick.bz) ? Number(tick.bz) : null,
    cl: finite(tick.cl) ? Number(tick.cl) : null,
    Up: sideSnapshot(tick, "Up"),
    Down: sideSnapshot(tick, "Down"),
  })).filter((row) => finite(row.ms)).sort((a, b) => a.ms - b.ms);
}

function segment(windowStart) {
  return windowStart < trainEnd ? "train" : windowStart < validationEnd ? "validation" : "holdout";
}

const files = fs.readdirSync(cacheDir).map((file) => {
  const match = file.match(/^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/);
  return match ? { file, windowStart: Number(match[1]) } : null;
}).filter((row) => row && row.windowStart >= start && row.windowStart < end)
  .sort((a, b) => a.windowStart - b.windowStart);

const rowsFile = outputFile.replace(/\.json$/i, "-rows.json.gz");
let rows = [], processed = 0, skipped = 0;
if (process.env.REBUILD_TREND_ROWS !== "1" && fs.existsSync(rowsFile)) {
  const cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(rowsFile)));
  if (cached.schema === 2 && cached.baselinePolicySha256 === baselinePolicySha256
    && JSON.stringify(cached.featureNames) === JSON.stringify(REGIME_FEATURE_NAMES)
    && Array.isArray(cached.rows)) {
    rows = cached.rows;
    processed = files.length;
    console.log(JSON.stringify({ phase: "dataset-cache", rows: rows.length, file: rowsFile }));
  }
}
for (const { file, windowStart } of rows.length ? [] : files) {
  let feed;
  try { feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file)))); }
  catch { skipped++; continue; }
  if (!feed.winSide || !Array.isArray(feed.ticks) || feed.ticks.length < 2) { skipped++; continue; }
  feed.windowStart = windowStart;
  const fills = simulateFills(feed, baselineStrategy);
  const history = snapshots(feed, windowStart);
  for (const fill of fills) {
    const decidedT = Number(fill.decidedT ?? fill.placedT ?? fill.tInto);
    const clockMs = (windowStart + decidedT) * 1_000;
    const current = regimePriorAt(history, clockMs);
    const feature = regimeFeatures({ history, current,
      tk: { t: decidedT, openBinance: feed.openBinance,
        openChainlink: feed.openPrice ?? feed.openChainlink },
      side: fill.side, clockMs });
    if (!feature) continue;
    const px = Number(fill.effPx), shares = Number(fill.shares), cost = Number(fill.usdc);
    const fee = fillFee(px, shares, true);
    const pnl = (fill.side === feed.winSide ? shares : 0) - cost - fee;
    rows.push({
      slug: `btc-updown-5m-${windowStart}`,
      windowStart,
      segment: segment(windowStart),
      t: decidedT,
      side: fill.side,
      winner: feed.winSide,
      label: Number(fill.side === feed.winSide),
      role: fill.role,
      ask: Number(fill.model?.features?.ask),
      cap: Number(fill.limitPx),
      minimumShares: Number(fill.minimumShares),
      filledShares: shares,
      pnl,
      dominantScore: feature.raw.dominantScore,
      shortScore: feature.raw.shortScore,
      pullback: feature.raw.dominantScore >= .2 && feature.raw.shortScore <= -.08,
      counterTrend: feature.raw.dominantScore <= -.2 && feature.raw.shortScore >= .08,
      vector: feature.vector,
    });
  }
  processed++;
  if (processed % 150 === 0) console.log(JSON.stringify({ phase: "dataset", processed,
    total: files.length, rows: rows.length }));
}

function featureGroup(name) {
  if (/Depth|depth|spread|microprice|Imbalance|Pressure/.test(name)) return "microstructure";
  if (/binance|twap|basis|crossFeed/i.test(name)) return "external";
  if (/mid|askMove|bidMove|positionInRange|discount/i.test(name)) return "token-path";
  return "context";
}
const featureGroups = Object.fromEntries(REGIME_FEATURE_NAMES.map((name) => [name, featureGroup(name)]));

function normalization(trainRows, active) {
  const mean = new Array(REGIME_FEATURE_NAMES.length).fill(0);
  const variance = new Array(REGIME_FEATURE_NAMES.length).fill(0);
  for (const row of trainRows) for (const index of active) mean[index] += row.vector[index];
  for (const index of active) mean[index] /= Math.max(1, trainRows.length);
  for (const row of trainRows) for (const index of active) {
    const delta = row.vector[index] - mean[index]; variance[index] += delta * delta;
  }
  const scale = variance.map((entry, index) => active.includes(index)
    ? Math.max(1e-8, Math.sqrt(entry / Math.max(1, trainRows.length))) : 1);
  return { count: trainRows.length, mean, scale };
}

function fit(trainRows, allowedGroups = null, epochs = 34) {
  const active = REGIME_FEATURE_NAMES.map((name, index) => ({ name, index }))
    .filter(({ name }) => !allowedGroups || allowedGroups.has(featureGroups[name]))
    .map(({ index }) => index);
  const norm = normalization(trainRows, active);
  const weights = new Array(REGIME_FEATURE_NAMES.length).fill(0);
  const m = new Array(weights.length + 1).fill(0), v = new Array(weights.length + 1).fill(0);
  let intercept = 0, step = 0;
  const order = trainRows.map((_, index) => index);
  for (let epoch = 0; epoch < epochs; epoch++) {
    order.sort((a, b) => hash(`${epoch}:${trainRows[a].slug}:${trainRows[a].t}:${a}`)
      .localeCompare(hash(`${epoch}:${trainRows[b].slug}:${trainRows[b].t}:${b}`)));
    const rate = .008 * (.93 ** epoch);
    for (const rowIndex of order) {
      const row = trainRows[rowIndex];
      let logit = intercept;
      for (const index of active) {
        const z = Math.max(-10, Math.min(10, (row.vector[index] - norm.mean[index]) / norm.scale[index]));
        logit += weights[index] * z;
      }
      const probability = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
      const error = probability - row.label;
      const gradients = new Array(weights.length + 1).fill(0); gradients[0] = error;
      for (const index of active) {
        const z = Math.max(-10, Math.min(10, (row.vector[index] - norm.mean[index]) / norm.scale[index]));
        gradients[index + 1] = error * z + .0015 * weights[index];
      }
      step++;
      for (const slot of [0, ...active.map((index) => index + 1)]) {
        m[slot] = .9 * m[slot] + .1 * gradients[slot];
        v[slot] = .999 * v[slot] + .001 * gradients[slot] ** 2;
        const update = rate * (m[slot] / (1 - .9 ** step))
          / (Math.sqrt(v[slot] / (1 - .999 ** step)) + 1e-8);
        if (slot === 0) intercept -= update; else weights[slot - 1] -= update;
      }
    }
  }
  return { type: "causal-standardized-logistic-v1", featureNames: REGIME_FEATURE_NAMES,
    featureGroups, normalization: norm, intercept, weights, activeGroups: allowedGroups ? [...allowedGroups] : ["all"] };
}

function score(model, vector) {
  let logit = model.intercept;
  for (let index = 0; index < vector.length; index++) {
    if (!model.weights[index]) continue;
    const z = Math.max(-10, Math.min(10, (vector[index] - model.normalization.mean[index])
      / model.normalization.scale[index]));
    logit += model.weights[index] * z;
  }
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}

function auc(scored) {
  const sorted = [...scored].sort((a, b) => a.p - b.p);
  let negatives = 0, rankSum = 0, positives = 0, cursor = 0;
  while (cursor < sorted.length) {
    let endIndex = cursor + 1;
    while (endIndex < sorted.length && Math.abs(sorted[endIndex].p - sorted[cursor].p) < 1e-12) endIndex++;
    const averageRank = (cursor + 1 + endIndex) / 2;
    for (let index = cursor; index < endIndex; index++) if (sorted[index].label) {
      positives++; rankSum += averageRank;
    } else negatives++;
    cursor = endIndex;
  }
  return positives && negatives ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : null;
}

function metrics(model, subset) {
  const scored = subset.map((row) => ({ ...row, p: score(model, row.vector) }));
  const correct = scored.filter((row) => Number(row.p >= .5) === row.label).length;
  const logLoss = scored.reduce((sum, row) => sum - row.label * Math.log(Math.max(1e-9, row.p))
    - (1 - row.label) * Math.log(Math.max(1e-9, 1 - row.p)), 0) / Math.max(1, scored.length);
  return { rows: scored.length, positivePct: round(100 * scored.filter((row) => row.label).length / Math.max(1, scored.length), 3),
    auc: round(auc(scored)), accuracyPct: round(100 * correct / Math.max(1, scored.length), 3),
    logLoss: round(logLoss) };
}

function filterScreen(model, subset, limit = 20) {
  const variants = [];
  for (const minimumProbability of [.5, .525, .55, .575, .6, .625, .65, .675, .7, .725, .75, .775, .8]) {
    for (const minimumEdge of [-.05, -.025, 0, .01, .02, .03, .04, .05]) {
      const kept = subset.filter((row) => {
        const probability = score(model, row.vector);
        const feePerShare = fillFee(row.ask, 1, true);
        return probability >= minimumProbability && probability - row.ask - feePerShare >= minimumEdge;
      });
      const pnl = kept.reduce((sum, row) => sum + row.pnl, 0);
      variants.push({ minimumProbability, minimumEdge, trades: kept.length,
        tradePct: 100 * kept.length / Math.max(1, subset.length), pnl,
        averagePnl: pnl / Math.max(1, kept.length),
        winnerPct: 100 * kept.filter((row) => row.label).length / Math.max(1, kept.length) });
    }
  }
  return variants.sort((a, b) => b.pnl - a.pnl || b.trades - a.trades).slice(0, limit)
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, round(entry, 4)])));
}

const trainRows = rows.filter((row) => row.segment === "train");
const groupSets = {
  context: new Set(["context"]),
  tokenPath: new Set(["context", "token-path"]),
  external: new Set(["context", "external"]),
  microstructure: new Set(["context", "microstructure"]),
  tokenExternal: new Set(["context", "token-path", "external"]),
  all: null,
};
const ablations = {};
const candidateModels = {};
for (const [name, groups] of Object.entries(groupSets)) {
  const candidate = fit(trainRows, groups, name === "all" ? 34 : 24);
  candidateModels[name] = candidate;
  ablations[name] = {
    validation: metrics(candidate, rows.filter((row) => row.segment === "validation")),
    holdout: metrics(candidate, rows.filter((row) => row.segment === "holdout")),
  };
}
const selectedName = Object.keys(candidateModels).sort((left, right) =>
  ablations[left].validation.logLoss - ablations[right].validation.logLoss
    || ablations[right].validation.auc - ablations[left].validation.auc)[0];
const model = candidateModels[selectedName];
const validationRows = rows.filter((row) => row.segment === "validation");
const holdoutRows = rows.filter((row) => row.segment === "holdout");
const validationFilterVariants = filterScreen(model, validationRows, Infinity);
const validationFilterScreen = validationFilterVariants.slice(0, 20);
const frozenPolicy = validationFilterVariants.filter((row) => row.minimumEdge >= 0)
  .sort((a, b) => b.pnl - a.pnl || b.trades - a.trades)[0];
function evaluateFilter(policy, subset) {
  const kept = subset.filter((row) => {
    const probability = score(model, row.vector);
    return probability >= policy.minimumProbability
      && probability - row.ask - fillFee(row.ask, 1, true) >= policy.minimumEdge;
  });
  const pnl = kept.reduce((sum, row) => sum + row.pnl, 0);
  return { ...policy, trades: kept.length, tradePct: round(100 * kept.length / Math.max(1, subset.length), 4),
    pnl: round(pnl, 4), averagePnl: round(pnl / Math.max(1, kept.length), 4),
    winnerPct: round(100 * kept.filter((row) => row.label).length / Math.max(1, kept.length), 4) };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  definition: "Causal probability that a pre-enhancement target75cc candidate side wins the market; final winner is the supervised target and never an input.",
  baselinePolicySha256,
  source: { type: "BAPI v2 coherent 120ms L2 cache", cacheDir,
    range: { start: new Date(start * 1_000).toISOString(), end: new Date(end * 1_000).toISOString() },
    split: { train: "Aug 20-24", validation: "Aug 25", holdout: "Aug 26" }, files: files.length,
    processed, skipped },
  noLookahead: "All features use snapshots with timestamp <= decision time. Splits are whole chronological market windows.",
  data: { rows: rows.length, bySegment: Object.fromEntries(["train", "validation", "holdout"]
    .map((name) => [name, rows.filter((row) => row.segment === name).length])),
    pullbacks: rows.filter((row) => row.pullback).length,
    counterTrend: rows.filter((row) => row.counterTrend).length },
  selection: { criterion: "minimum validation log loss; holdout excluded", selectedFeatureSet: selectedName,
    frozenFilterPolicy: frozenPolicy },
  model,
  metrics: Object.fromEntries(["train", "validation", "holdout"].map((name) =>
    [name, metrics(model, rows.filter((row) => row.segment === name))])),
  ablations,
  validationFilterScreen,
  frozenFilterEvaluation: {
    validation: evaluateFilter(frozenPolicy, validationRows),
    holdout: evaluateFilter(frozenPolicy, holdoutRows),
  },
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(rowsFile, zlib.gzipSync(JSON.stringify({
  schema: 2, baselinePolicySha256, featureNames: REGIME_FEATURE_NAMES, rows,
}), { level: 9 }));
const exportedModel = JSON.stringify(model);
const exportedPolicy = JSON.stringify({
  minimumProbability: frozenPolicy.minimumProbability,
  minimumEdge: frozenPolicy.minimumEdge,
  reversalMinimumProbability: .5,
  confirmedReversalProbability: .7,
  pullbackMinimumProbability: .5,
  dominantThreshold: .2,
  shortCounterThreshold: .08,
  confidenceScaleFloor: .5,
  confidenceScaleCeiling: 1,
});
const exportedMeta = JSON.stringify({
  modelSha256: hash(exportedModel),
  baselinePolicySha256: report.baselinePolicySha256,
  source: report.source,
  noLookahead: report.noLookahead,
  selection: report.selection,
  metrics: report.metrics,
  ablations: report.ablations,
  frozenFilterEvaluation: report.frozenFilterEvaluation,
});
fs.writeFileSync(exportFile, `// Generated by research/wallet-75cc/fit-trend-noise-model.mjs.\n`
  + `// Winner is a training label only; runtime inputs are causal snapshots at or before decision time.\n`
  + `export const REGIME_MODEL = ${exportedModel};\n`
  + `export const REGIME_POLICY = ${exportedPolicy};\n`
  + `export const REGIME_META = ${exportedMeta};\n`);
console.log(JSON.stringify({ outputFile, data: report.data, metrics: report.metrics,
  selection: report.selection, ablations: report.ablations,
  validationTop: report.validationFilterScreen.slice(0, 8),
  frozenFilterEvaluation: report.frozenFilterEvaluation, exportFile }, null, 2));
