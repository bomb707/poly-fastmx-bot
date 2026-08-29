#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const samplesFile = path.resolve(process.env.FIRE_SAMPLES_FILE || path.join(dataDir, "fire-gate-samples.json.gz"));
const samples = JSON.parse(zlib.gunzipSync(fs.readFileSync(samplesFile)));
const splitMs = Date.parse(process.argv[3] || "2026-08-22T06:20:00Z");
const sizeMode = String(process.argv[4] || "literal");
const capitalSizeMode = sizeMode === "capital";
const largeSizeMode = capitalSizeMode || sizeMode === "large";
const sizeHoldoutStartMs = Date.parse(process.argv[5] || new Date(splitMs).toISOString());
if (!Number.isFinite(splitMs) || !Number.isFinite(sizeHoldoutStartMs)) throw new Error("invalid split time");
const maxDepth = Math.max(1, Number(process.env.FIRE_TREE_MAX_DEPTH || 5));
const minRows = Math.max(20, Number(process.env.FIRE_TREE_MIN_ROWS || 250));
const sizeMaxDepth = Math.max(1, Number(process.env.FIRE_SIZE_TREE_MAX_DEPTH || Math.min(4, maxDepth)));
const sizeMinRows = Math.max(20, Number(process.env.FIRE_SIZE_TREE_MIN_ROWS || Math.min(120, minRows)));
const outputFile = path.resolve(process.env.FIRE_TREE_OUTPUT || path.join(dataDir, "fire-gate-tree.json"));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const featureNames = [
  "timeS", "ask", "spread", "pairAsk", "askDepth1", "bidDepth1", "askDepth3", "bidDepth3",
  "topDepthImbalance", "depth3Imbalance", "topAskShareOfDepth3", "micropriceBias",
  "sideAskTickMove", "sideBidTickMove",
  "sideAskMove100ms", "sideBidMove100ms", "sideAskMove250ms", "sideBidMove250ms",
  "sideAskMove500ms", "sideBidMove500ms", "bzMove100ms", "bzMove250ms", "bzMove500ms",
  "clMove100ms", "clMove250ms", "clMove500ms", "sideAskAccel500ms", "sideBidAccel500ms", "bzAccel500ms",
  "askDepth3Change1", "bidDepth3Change1", "askDepth3Change3", "bidDepth3Change3",
  "askDepth3Change5", "bidDepth3Change5", "sideAskMove1", "sideBidMove1", "sideAskMove3", "sideBidMove3",
  "sideAskMove5", "sideBidMove5", "bzMove1", "bzMove3", "bzMove5", "clMove1", "clMove3", "clMove5",
  "bzGap", "clGap", "absoluteInventory", "orientedInventory", "isHedge", "fifoPairCost",
];

const all = [...samples.positives, ...samples.controls];
function rowsFor(kind, train) {
  const rows = all.filter((row) => (train ? row.ms < splitMs : row.ms >= splitMs));
  if (kind === "entry") return rows.filter((row) => row.role === "entry/topup");
  if (kind === "hedge") return rows.filter((row) => row.role !== "entry/topup" || row.label === 0 && row.role === "hedge");
  return rows;
}

function counts(rows, positiveWeight) {
  let positives = 0, negatives = 0;
  for (const row of rows) if (row.label) positives += positiveWeight; else negatives++;
  return { positives, negatives, total: positives + negatives };
}
function gini(rows, positiveWeight) {
  const c = counts(rows, positiveWeight);
  if (!c.total) return 0;
  const p = c.positives / c.total;
  return 2 * p * (1 - p);
}

function fitTree(rows, { maxDepth = 5, minRows = 250 } = {}) {
  const rawPositive = rows.filter((row) => row.label).length, rawNegative = rows.length - rawPositive;
  const positiveWeight = rawPositive ? rawNegative / rawPositive : 1;
  let id = 0;
  function build(nodeRows, depth) {
    const nodeId = id++, rawPos = nodeRows.filter((row) => row.label).length, rawNeg = nodeRows.length - rawPos;
    const weighted = counts(nodeRows, positiveWeight);
    const node = {
      id: nodeId,
      depth,
      rows: nodeRows.length,
      positives: rawPos,
      negatives: rawNeg,
      balancedPositiveRate: round(weighted.positives / Math.max(1e-9, weighted.total)),
      observedPositiveRate: round(rawPos / Math.max(1, nodeRows.length)),
    };
    if (depth >= maxDepth || nodeRows.length < minRows * 2 || rawPos < 20 || rawNeg < 20) return node;
    const parentImpurity = gini(nodeRows, positiveWeight), parentWeight = weighted.total;
    let best = null;
    for (const field of featureNames) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .7) continue;
      const thresholds = [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))];
      for (const threshold of thresholds) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (left.length < minRows || right.length < minRows) continue;
        const leftWeight = counts(left, positiveWeight).total, rightWeight = counts(right, positiveWeight).total;
        const gain = parentImpurity - (leftWeight * gini(left, positiveWeight) + rightWeight * gini(right, positiveWeight)) / parentWeight;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < .0005) return node;
    node.field = best.field;
    node.threshold = round(best.threshold, 8);
    node.gain = round(best.gain, 8);
    node.left = build(best.left, depth + 1);
    node.right = build(best.right, depth + 1);
    return node;
  }
  return { positiveWeight, root: build(rows, 0) };
}

function predict(tree, row) {
  let node = tree.root;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return node.balancedPositiveRate;
}

function auc(rows, scores) {
  const ranked = rows.map((row, index) => ({ positive: Boolean(row.label), score: scores[index] })).sort((a, b) => a.score - b.score);
  const positives = ranked.filter((row) => row.positive).length, negatives = ranked.length - positives;
  let rankSum = 0;
  for (let index = 0; index < ranked.length;) {
    let end = index + 1;
    while (end < ranked.length && ranked[end].score === ranked[index].score) end++;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (ranked[cursor].positive) rankSum += averageRank;
    index = end;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function evaluate(tree, rows) {
  const scores = rows.map((row) => predict(tree, row));
  const positiveCount = rows.filter((row) => row.label).length;
  const ranked = rows.map((row, index) => ({ row, score: scores[index] })).sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, positiveCount);
  const truePositive = selected.filter((item) => item.row.label).length;
  return {
    rows: rows.length,
    positives: positiveCount,
    auc: round(auc(rows, scores)),
    topKPrecisionPct: round(truePositive / Math.max(1, positiveCount) * 100, 3),
    topKRecallPct: round(truePositive / Math.max(1, positiveCount) * 100, 3),
    scoreThreshold: round(selected.at(-1)?.score),
  };
}

function leaves(tree) {
  const out = [];
  function visit(node, rules = []) {
    if (!node.field) {
      out.push({ rules, rows: node.rows, positives: node.positives, balancedPositiveRate: node.balancedPositiveRate, observedPositiveRate: node.observedPositiveRate });
      return;
    }
    visit(node.left, [...rules, `${node.field} <= ${node.threshold}`]);
    visit(node.right, [...rules, `${node.field} > ${node.threshold}`]);
  }
  visit(tree.root);
  return out.sort((a, b) => b.balancedPositiveRate - a.balancedPositiveRate || b.rows - a.rows);
}

const models = {};
for (const kind of ["all", "entry", "hedge"]) {
  const train = rowsFor(kind, true), holdout = rowsFor(kind, false);
  const tree = fitTree(train, { maxDepth, minRows });
  models[kind] = {
    features: featureNames,
    tree,
    train: evaluate(tree, train),
    holdout: evaluate(tree, holdout),
    strongestLeaves: leaves(tree).slice(0, 12),
  };
}

const sizeTrain = samples.positives.filter((row) => row.ms < splitMs).map((row) => ({
  ...row,
  label: largeSizeMode ? (row.containsLarge ? 1 : 0) : (row.contains90 ? 1 : 0),
}));
const sizeHoldout = samples.positives.filter((row) => row.ms >= sizeHoldoutStartMs).map((row) => capitalSizeMode ? {
  ...row,
  label: row.containsLarge ? 1 : 0,
  orientedInventory: Number(row.orientedInventory) * 30 / 25,
  absoluteInventory: Number(row.absoluteInventory) * 30 / 25,
} : ({ ...row, label: largeSizeMode ? (row.containsLarge ? 1 : 0) : (row.contains90 ? 1 : 0) }));
const sizeTree = fitTree(sizeTrain, { maxDepth: sizeMaxDepth, minRows: sizeMinRows });
models.size90 = { features: featureNames, tree: sizeTree, train: evaluate(sizeTree, sizeTrain), holdout: evaluate(sizeTree, sizeHoldout), strongestLeaves: leaves(sizeTree).slice(0, 12) };
if (largeSizeMode) models.sizeLarge = models.size90;

const report = { schema: 1, generatedAt: new Date().toISOString(), split: new Date(splitMs).toISOString(), sizeHoldoutStart: new Date(sizeHoldoutStartMs).toISOString(), sizeMode, capitalSizeMode,
  orderbookSource: samples.orderbookSource || "unspecified", samplesFile,
  fitConfig: { maxDepth, minRows, sizeMaxDepth, sizeMinRows }, models };
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const describe = (model) => model.strongestLeaves.slice(0, 3).map((leaf) => `[${leaf.rules.join(" AND ")}] => balanced p=${leaf.balancedPositiveRate}, n=${leaf.rows}`).join("; ");
const md = `# Fire-gate decision trees\n\n` +
`Trees are trained only before ${new Date(splitMs).toISOString()} and evaluated on later markets. They use pre-fire public L2/feed/inventory features; class balancing prevents the much larger no-fire control set from dominating splits.\n\n` +
`- All actions: train AUC ${models.all.train.auc}, holdout AUC ${models.all.holdout.auc}. Strong leaves: ${describe(models.all)}.\n` +
`- Entries: train AUC ${models.entry.train.auc}, holdout AUC ${models.entry.holdout.auc}. Strong leaves: ${describe(models.entry)}.\n` +
`- Hedges: train AUC ${models.hedge.train.auc}, holdout AUC ${models.hedge.holdout.auc}. Strong leaves: ${describe(models.hedge)}.\n` +
`- 90-share branch: train AUC ${models.size90.train.auc}, holdout AUC ${models.size90.holdout.auc}. Strong leaves: ${describe(models.size90)}.\n`;
fs.writeFileSync(outputFile.replace(/\.json$/i, ".md"), md);
console.log(md);
console.log(JSON.stringify(Object.fromEntries(Object.entries(models).map(([key, value]) => [key, { train: value.train, holdout: value.holdout, strongestLeaves: value.strongestLeaves.slice(0, 5) }])), null, 2));
