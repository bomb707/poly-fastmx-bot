#!/usr/bin/env node
// Chronological, causal model of the wallet's selected pre-signed quantity.
// The wallet has several choices at a price cell; this estimates which tier it
// releases from public L2/feed/inventory state without using resolution data.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "../wallet-3048/core.mjs";

const dataDir = path.resolve(process.argv[2] || "data/wallet-75cc");
const splitMs = Date.parse(process.argv[3] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[4] || path.join(dataDir, "action-size-tree.json"));
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const targetMode = String(process.env.W75CC_SIZE_TARGET || "signed").trim();
if (!["signed", "residual"].includes(targetMode)) throw new Error(`unknown W75CC_SIZE_TARGET ${targetMode}`);
const actionsFile = path.resolve(process.env.W75CC_FIRE_ACTIONS_FILE || path.join(dataDir, "fire-actions-v2.json.gz"));
const samplesFile = path.resolve(process.env.W75CC_FIRE_SAMPLES_FILE || path.join(dataDir, "fire-gate-samples-v2.json.gz"));
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionsFile))).rows;
const positives = JSON.parse(zlib.gunzipSync(fs.readFileSync(samplesFile))).positives;
const featureByKey = new Map(positives.map((row) => [`${row.slug}:${row.fillMs ?? row.ms}:${row.side}`, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
const q = (values, ps = [.1, .25, .5, .75, .9]) => Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, round(quantile(values.filter(finite).map(Number), p))]));
const featureNames = [
  "timeS", "ask", "spread", "pairAsk", "askDepth1", "bidDepth1", "askDepth3", "bidDepth3",
  "topDepthImbalance", "depth3Imbalance", "topAskShareOfDepth3", "micropriceBias",
  "sideAskMove1", "sideBidMove1", "sideAskMove3", "sideBidMove3", "sideAskMove5", "sideBidMove5",
  "sideAskMove10", "sideBidMove10", "askDepth3Change1", "bidDepth3Change1", "askDepth3Change3",
  "bidDepth3Change3", "askDepth3Change5", "bidDepth3Change5", "bzMove1", "bzMove3", "bzMove5",
  "bzMove10", "clMove1", "clMove3", "clMove5", "clMove10", "bzGap", "clGap", "absoluteInventory",
  "orientedInventory", "isHedge", "fifoPairCost", "sinceLastFireS", "sinceSameSideFireS", "coinBtc",
];
const rows = actions.map((action) => {
  const sample = featureByKey.get(`${action.slug}:${action.fireMs}:${action.outcome}`);
  if (!sample) return null;
  return {
    ...Object.fromEntries(featureNames.map((field) => [field, field === "coinBtc" ? Number(action.slug.startsWith("btc-")) : sample[field]])),
    slug: action.slug, ms: action.fireMs, side: action.outcome, role: action.role,
    size: targetMode === "residual" ? Math.abs(Number(action.afterImbalance)) : Number(action.signedShares),
    logSize: Math.log1p(targetMode === "residual" ? Math.abs(Number(action.afterImbalance)) : Number(action.signedShares)),
  };
}).filter((row) => row && finite(row.size));

function variance(nodeRows) {
  if (!nodeRows.length) return 0;
  const mean = nodeRows.reduce((sum, row) => sum + row.logSize, 0) / nodeRows.length;
  return nodeRows.reduce((sum, row) => sum + (row.logSize - mean) ** 2, 0);
}
function fitTree(trainRows, { maxDepth = 6, minRows = 45 } = {}) {
  let nextId = 0;
  function build(nodeRows, depth) {
    const node = {
      id: nextId++, depth, rows: nodeRows.length,
      medianSize: round(quantile(nodeRows.map((row) => row.size), .5)),
      meanLogSize: round(nodeRows.reduce((sum, row) => sum + row.logSize, 0) / nodeRows.length, 9),
      size: q(nodeRows.map((row) => row.size)),
    };
    if (depth >= maxDepth || nodeRows.length < minRows * 2) return node;
    const parentError = variance(nodeRows);
    let best = null;
    for (const field of featureNames) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .72) continue;
      for (const threshold of [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))]) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (left.length < minRows || right.length < minRows) continue;
        const gain = (parentError - variance(left) - variance(right)) / Math.max(1e-9, parentError);
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < .006) return node;
    node.field = best.field; node.threshold = round(best.threshold, 8); node.gain = round(best.gain, 8);
    node.left = build(best.left, depth + 1); node.right = build(best.right, depth + 1);
    return node;
  }
  return build(trainRows, 0);
}
function leaf(tree, row) {
  let node = tree;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return node;
}
function evaluate(tree, evalRows) {
  const predictions = evalRows.map((row) => Math.max(5, Math.min(227, Math.round(leaf(tree, row).medianSize))));
  const actual = evalRows.map((row) => row.size);
  const baseline = Math.round(quantile(rows.filter((row) => row.ms < splitMs).map((row) => row.size), .5));
  const absolute = predictions.map((value, index) => Math.abs(value - actual[index]));
  const absoluteLog = predictions.map((value, index) => Math.abs(Math.log1p(value) - Math.log1p(actual[index])));
  const withinTier = predictions.filter((value, index) => tier(value) === tier(actual[index])).length;
  const largeActual = actual.map((value) => value >= 16), largePredicted = predictions.map((value) => value >= 16);
  let tp = 0, fp = 0, fn = 0;
  for (let index = 0; index < actual.length; index++) {
    if (largePredicted[index] && largeActual[index]) tp++;
    else if (largePredicted[index]) fp++;
    else if (largeActual[index]) fn++;
  }
  return {
    rows: evalRows.length, actual: q(actual), predicted: q(predictions),
    medianAbsoluteError: round(quantile(absolute, .5)), p90AbsoluteError: round(quantile(absolute, .9)),
    medianAbsoluteLogError: round(quantile(absoluteLog, .5)), exactTierPct: pct(withinTier, actual.length),
    large16PrecisionPct: pct(tp, tp + fp), large16RecallPct: pct(tp, tp + fn),
    baselineMedianSize: baseline,
    baselineMedianAbsoluteError: round(quantile(actual.map((value) => Math.abs(value - baseline)), .5)),
  };
}
function tier(value) { return value <= 7 ? "base" : value <= 15 ? "small" : value <= 29 ? "medium" : "large"; }
function leaves(node, rules = [], output = []) {
  if (!node.field) { output.push({ rules, rows: node.rows, medianSize: node.medianSize, size: node.size }); return output; }
  leaves(node.left, [...rules, `${node.field} <= ${node.threshold}`], output);
  leaves(node.right, [...rules, `${node.field} > ${node.threshold}`], output);
  return output;
}

const train = rows.filter((row) => row.ms < splitMs), holdout = rows.filter((row) => row.ms >= splitMs);
const tree = fitTree(train);
const report = {
  schema: 1, generatedAt: new Date().toISOString(), split: new Date(splitMs).toISOString(),
  targetMode,
  method: targetMode === "residual"
    ? "regression tree on log(1+absolute post-action residual shares), using only causal public pre-fire features and inventory"
    : "regression tree on log(1+signed minimum shares), using only causal public pre-fire features and inventory",
  features: featureNames, samples: { all: rows.length, train: train.length, holdout: holdout.length },
  tree, train: evaluate(tree, train), holdout: evaluate(tree, holdout),
  largestLeaves: leaves(tree).sort((a, b) => b.medianSize - a.medianSize || b.rows - a.rows).slice(0, 16),
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const md = `# ${targetMode === "residual" ? "Post-action residual" : "Action-size"} model\n\n` +
  `The size model is trained before ${report.split} and evaluated later. It does not use the market resolution or future data.\n\n` +
  `- Train median absolute error: ${report.train.medianAbsoluteError} shares; holdout: ${report.holdout.medianAbsoluteError}.\n` +
  `- Holdout exact size-band accuracy: ${report.holdout.exactTierPct}%; >=16-share precision ${report.holdout.large16PrecisionPct}%, recall ${report.holdout.large16RecallPct}%.\n` +
  `- Constant-median baseline holdout error: ${report.holdout.baselineMedianAbsoluteError} shares.\n`;
fs.writeFileSync(outputFile.replace(/\.json$/i, ".md"), md);
console.log(md);
console.log(JSON.stringify({ samples: report.samples, train: report.train, holdout: report.holdout, largestLeaves: report.largestLeaves.slice(0, 10) }, null, 2));
