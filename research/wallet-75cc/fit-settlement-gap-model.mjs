#!/usr/bin/env node
// Fit an independent causal direction model from Binance/Chainlink settlement
// gaps. Whole market windows remain in chronological segments. Both candidate
// sides are emitted per checkpoint so the fitted probability is side-symmetric.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { REGIME_FEATURE_NAMES, regimeFeatures, regimePriorAt }
  from "../../engine/strategies/target75cc-regime-features.js";

const root = path.resolve(import.meta.dirname, "../..");
const cacheDir = path.resolve(process.argv[2] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[3]
  || path.join(root, "data/wallet-75cc/exact-2026-08-20_2026-08-27/settlement-gap-model.json"));
const exportFile = path.resolve(process.argv[4]
  || path.join(root, "engine/strategies/target75cc-settlement-gap-model.js"));
const START = Date.parse(process.env.GAP_MODEL_START || "2026-08-14T00:00:00Z") / 1_000;
const TRAIN_END = Date.parse(process.env.GAP_MODEL_TRAIN_END || "2026-08-25T00:00:00Z") / 1_000;
const VALIDATION_END = Date.parse(process.env.GAP_MODEL_VALIDATION_END || "2026-08-26T00:00:00Z") / 1_000;
const HOLDOUT_END = Date.parse(process.env.GAP_MODEL_HOLDOUT_END || "2026-08-27T00:00:00Z") / 1_000;
const END = Date.parse(process.env.GAP_MODEL_END || "2026-09-03T12:00:00Z") / 1_000;
const CHECKPOINTS_S = [30, 60, 90, 120, 150, 180, 210, 240, 270];
const finite = (input) => input != null && input !== "" && Number.isFinite(Number(input));
const round = (input, digits = 6) => finite(input) ? +Number(input).toFixed(digits) : null;
const hash = (input) => crypto.createHash("sha256").update(input).digest("hex");

function levels(rows, ascending) {
  return (Array.isArray(rows) ? rows : []).map((row) => [
    Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((left, right) => ascending ? left[0] - right[0] : right[0] - left[0]);
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
  })).filter((row) => finite(row.ms)).sort((left, right) => left.ms - right.ms);
}

function segment(windowStart) {
  return windowStart < TRAIN_END ? "train" : windowStart < VALIDATION_END ? "validation"
    : windowStart < HOLDOUT_END ? "holdout" : "oos";
}

const coreNames = [
  "binanceOwnGapUsd", "binanceSettlementGapUsd", "twapSettlementGapUsd",
  "binanceSettlementGapBps", "twapSettlementGapBps",
  "binanceSettlementGapWhenAgree", "binanceSettlementGapWhenDisagree",
  "twapSettlementGapWhenAgree", "twapSettlementGapWhenDisagree",
  "binanceSettlementRequiredVelocity", "twapSettlementRequiredVelocity",
  "binanceSettlementSafetyZ", "twapSettlementSafetyZ",
];
const bandNames = REGIME_FEATURE_NAMES.filter((name) => /Settlement(?:Above|Below)Usd/.test(name));
const sessionNames = REGIME_FEATURE_NAMES.filter((name) => /SettlementGap_utc/.test(name));
const featureSets = {
  core: coreNames,
  bands: [...coreNames, ...bandNames],
  sessions: [...coreNames, ...sessionNames],
  all: [...coreNames, ...bandNames, ...sessionNames],
};
for (const names of Object.values(featureSets)) for (const name of names) {
  if (!REGIME_FEATURE_NAMES.includes(name)) throw new Error(`missing regime feature ${name}`);
}

const files = fs.readdirSync(cacheDir).map((file) => {
  const match = file.match(/^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/);
  return match ? { file, windowStart: Number(match[1]) } : null;
}).filter((row) => row && row.windowStart >= START && row.windowStart < END)
  .sort((left, right) => left.windowStart - right.windowStart);

const rows = [];
let invalid = 0;
for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
  const { file, windowStart } = files[fileIndex];
  let feed;
  try { feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file)))); }
  catch { invalid++; continue; }
  if (!["Up", "Down"].includes(feed.winSide) || !Array.isArray(feed.ticks)
    || !(Number(feed.openBinance) > 0 && Number(feed.openPrice ?? feed.openChainlink) > 0)) {
    invalid++; continue;
  }
  const history = snapshots(feed, windowStart), winHour = new Date(windowStart * 1_000).getUTCHours();
  for (const t of CHECKPOINTS_S) {
    const clockMs = (windowStart + t) * 1_000;
    const current = regimePriorAt(history, clockMs);
    if (!current || clockMs - current.ms > 2_500) continue;
    for (const side of ["Up", "Down"]) {
      const feature = regimeFeatures({ history, current, side, clockMs,
        tk: { t, winHour, openBinance: feed.openBinance,
          openChainlink: feed.openPrice ?? feed.openChainlink } });
      if (!feature) continue;
      rows.push({ slug: `btc-updown-5m-${windowStart}`, windowStart, segment: segment(windowStart),
        t, side, label: Number(side === feed.winSide), raw: feature.raw });
    }
  }
  if ((fileIndex + 1) % 300 === 0 || fileIndex + 1 === files.length) {
    console.log(JSON.stringify({ phase: "gap-dataset", done: fileIndex + 1,
      total: files.length, rows: rows.length }));
  }
}

function normalization(trainRows, featureNames) {
  const mean = new Array(featureNames.length).fill(0), scale = new Array(featureNames.length).fill(0);
  for (const row of trainRows) for (let index = 0; index < featureNames.length; index++) {
    mean[index] += Number(row.raw[featureNames[index]]) || 0;
  }
  for (let index = 0; index < featureNames.length; index++) mean[index] /= Math.max(1, trainRows.length);
  for (const row of trainRows) for (let index = 0; index < featureNames.length; index++) {
    const delta = (Number(row.raw[featureNames[index]]) || 0) - mean[index];
    scale[index] += delta * delta;
  }
  for (let index = 0; index < featureNames.length; index++) {
    scale[index] = Math.max(1e-8, Math.sqrt(scale[index] / Math.max(1, trainRows.length)));
  }
  return { count: trainRows.length, mean, scale };
}

function fit(trainRows, featureNames, epochs = 24) {
  const norm = normalization(trainRows, featureNames), weights = new Array(featureNames.length).fill(0);
  const m = new Array(weights.length + 1).fill(0), v = new Array(weights.length + 1).fill(0);
  const order = trainRows.map((_, index) => index);
  let intercept = 0, step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    order.sort((left, right) => hash(`${epoch}:${trainRows[left].slug}:${trainRows[left].t}:${trainRows[left].side}`)
      .localeCompare(hash(`${epoch}:${trainRows[right].slug}:${trainRows[right].t}:${trainRows[right].side}`)));
    const rate = .006 * (.94 ** epoch);
    for (const rowIndex of order) {
      const row = trainRows[rowIndex];
      let logit = intercept;
      const z = featureNames.map((name, index) => Math.max(-12, Math.min(12,
        ((Number(row.raw[name]) || 0) - norm.mean[index]) / norm.scale[index])));
      for (let index = 0; index < weights.length; index++) logit += weights[index] * z[index];
      const probability = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
      const error = probability - row.label;
      const gradients = [error, ...weights.map((weight, index) => error * z[index] + .002 * weight)];
      step++;
      for (let slot = 0; slot < gradients.length; slot++) {
        m[slot] = .9 * m[slot] + .1 * gradients[slot];
        v[slot] = .999 * v[slot] + .001 * gradients[slot] ** 2;
        const update = rate * (m[slot] / (1 - .9 ** step))
          / (Math.sqrt(v[slot] / (1 - .999 ** step)) + 1e-8);
        if (slot === 0) intercept -= update; else weights[slot - 1] -= update;
      }
    }
  }
  return { type: "causal-settlement-gap-logistic-v1", featureNames,
    normalization: norm, intercept, weights };
}

function score(model, raw) {
  let logit = model.intercept;
  for (let index = 0; index < model.featureNames.length; index++) {
    const z = Math.max(-12, Math.min(12, ((Number(raw[model.featureNames[index]]) || 0)
      - model.normalization.mean[index]) / model.normalization.scale[index]));
    logit += model.weights[index] * z;
  }
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}

function auc(scored) {
  const sorted = [...scored].sort((left, right) => left.p - right.p);
  let negatives = 0, positives = 0, rankSum = 0, cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor + 1;
    while (end < sorted.length && Math.abs(sorted[end].p - sorted[cursor].p) < 1e-12) end++;
    const averageRank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index++) {
      if (sorted[index].label) { positives++; rankSum += averageRank; } else negatives++;
    }
    cursor = end;
  }
  return positives && negatives
    ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : null;
}

function metrics(model, selectedRows) {
  const scored = selectedRows.map((row) => ({ label: row.label, p: score(model, row.raw) }));
  const logLoss = scored.reduce((sum, row) => sum - row.label * Math.log(Math.max(1e-9, row.p))
    - (1 - row.label) * Math.log(Math.max(1e-9, 1 - row.p)), 0) / Math.max(1, scored.length);
  const brier = scored.reduce((sum, row) => sum + (row.p - row.label) ** 2, 0) / Math.max(1, scored.length);
  return { rows: scored.length, auc: round(auc(scored)), logLoss: round(logLoss), brier: round(brier),
    accuracyPct: round(100 * scored.filter((row) => Number(row.p >= .5) === row.label).length
      / Math.max(1, scored.length), 3) };
}

const trainRows = rows.filter((row) => row.segment === "train");
const models = Object.fromEntries(Object.entries(featureSets).map(([name, featureNames]) => [name,
  fit(trainRows, featureNames)]));
const evaluations = Object.fromEntries(Object.entries(models).map(([name, model]) => [name,
  Object.fromEntries(["train", "validation", "holdout", "oos"].map((segmentName) => [segmentName,
    metrics(model, rows.filter((row) => row.segment === segmentName))]))]));
const selectedName = Object.keys(models).sort((left, right) =>
  evaluations[left].validation.logLoss - evaluations[right].validation.logLoss
    || evaluations[right].validation.auc - evaluations[left].validation.auc)[0];
const model = models[selectedName];
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  definition: "Independent causal probability that a candidate side wins from Binance and Chainlink TWAP-60 gaps; winner is a label only.",
  source: { cacheDir, files: files.length, invalid, checkpointsS: CHECKPOINTS_S,
    range: { start: new Date(START * 1_000).toISOString(), end: new Date(END * 1_000).toISOString() },
    splits: { trainEnd: new Date(TRAIN_END * 1_000).toISOString(),
      validationEnd: new Date(VALIDATION_END * 1_000).toISOString(),
      holdoutEnd: new Date(HOLDOUT_END * 1_000).toISOString() } },
  noLookahead: "Features use snapshots at or before fixed checkpoints; whole markets remain in chronological segments.",
  rows: Object.fromEntries(["train", "validation", "holdout", "oos"]
    .map((name) => [name, rows.filter((row) => row.segment === name).length])),
  selection: { criterion: "minimum validation log loss, then maximum validation AUC; holdout and OOS excluded",
    selectedFeatureSet: selectedName },
  evaluations,
  model,
};
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const exported = JSON.stringify(model), meta = JSON.stringify({ modelSha256: hash(exported),
  source: report.source, noLookahead: report.noLookahead, selection: report.selection,
  metrics: evaluations[selectedName] });
fs.writeFileSync(exportFile, `// Generated by research/wallet-75cc/fit-settlement-gap-model.mjs.\n`
  + `// Outcome is a training label only; runtime inputs are causal.\n`
  + `export const SETTLEMENT_GAP_MODEL = ${exported};\n`
  + `export const SETTLEMENT_GAP_META = ${meta};\n`);
console.log(JSON.stringify({ outputFile, exportFile, rows: report.rows,
  selection: report.selection, evaluations }, null, 2));

