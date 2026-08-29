#!/usr/bin/env node
// Learn the target wallet's causal inventory transition policy.  The fire
// action reconstruction already labels each fill as a same-side top-up, a
// partial hedge, or an over-hedge that crosses into the newly predicted side.
// This script deliberately excludes signed size/fill outcome from predictors:
// only information available before the inferred fire can select the branch.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "../wallet-3048/core.mjs";

const dataDir = path.resolve(process.argv[2] || "data/wallet-75cc");
const splitMs = Date.parse(process.argv[3] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[4] || path.join(dataDir, "reversal-sizing-analysis.json"));
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const actionsFile = path.resolve(process.env.W75CC_FIRE_ACTIONS_FILE || path.join(dataDir, "fire-actions-v2.json.gz"));
const samplesFile = path.resolve(process.env.W75CC_FIRE_SAMPLES_FILE || path.join(dataDir, "fire-gate-samples-v2.json.gz"));
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionsFile))).rows;
const positives = JSON.parse(zlib.gunzipSync(fs.readFileSync(samplesFile))).positives;
const featureByKey = new Map(positives.map((row) => [`${row.slug}:${row.fillMs ?? row.ms}:${row.side}`, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
const q = (values, ps = [.1, .25, .5, .75, .9]) => Object.fromEntries(ps.map((p) => [
  `p${Math.round(p * 100)}`, round(quantile(values.filter(finite).map(Number), p)),
]));

const featureNames = [
  "timeS", "ask", "spread", "pairAsk", "askDepth1", "bidDepth1", "askDepth3", "bidDepth3",
  "topDepthImbalance", "depth3Imbalance", "topAskShareOfDepth3", "micropriceBias",
  "sideAskMove1", "sideBidMove1", "sideAskMove3", "sideBidMove3", "sideAskMove5", "sideBidMove5",
  "sideAskMove10", "sideBidMove10", "askDepth3Change1", "bidDepth3Change1",
  "askDepth3Change3", "bidDepth3Change3", "askDepth3Change5", "bidDepth3Change5",
  "bzMove1", "bzMove3", "bzMove5", "bzMove10", "clMove1", "clMove3", "clMove5", "clMove10",
  "bzGap", "clGap", "absoluteInventory", "orientedInventory", "fifoPairCost",
  "sinceLastFireS", "sinceSameSideFireS",
];

const rows = actions.map((action) => {
  const sample = featureByKey.get(`${action.slug}:${action.fireMs}:${action.outcome}`)
    || featureByKey.get(`${action.slug}:${action.intervalStartMs}:${action.outcome}`);
  if (!sample) return null;
  const before = Number(action.beforeImbalance), after = Number(action.afterImbalance);
  const sign = action.outcome === "Up" ? 1 : -1;
  return {
    ...Object.fromEntries(featureNames.map((field) => [field, sample[field]])),
    slug: action.slug,
    ms: action.fireMs,
    side: action.outcome,
    role: action.role,
    crossLabel: action.role === "overhedge-cross" ? 1 : 0,
    signedShares: Number(action.signedShares),
    filledShares: Number(action.filledShares),
    beforeImbalance: before,
    afterImbalance: after,
    beforeOriented: before * sign,
    afterOriented: after * sign,
    targetResidual: action.role === "overhedge-cross" ? after * sign : null,
    trimResidual: action.role === "hedge" ? -(after * sign) : null,
  };
}).filter(Boolean);
const reversals = rows.filter((row) => row.role === "hedge" || row.role === "overhedge-cross");

function counts(nodeRows, positiveWeight = 1) {
  const rawPositives = nodeRows.filter((row) => row.crossLabel).length;
  return { positives: rawPositives * positiveWeight, negatives: nodeRows.length - rawPositives };
}
function gini(nodeRows, positiveWeight) {
  const c = counts(nodeRows, positiveWeight), total = c.positives + c.negatives;
  if (!total) return 0;
  const p = c.positives / total;
  return 2 * p * (1 - p);
}
function fitTree(trainRows, { maxDepth = 5, minRows = 60 } = {}) {
  const rawPositive = trainRows.filter((row) => row.crossLabel).length;
  const positiveWeight = rawPositive ? (trainRows.length - rawPositive) / rawPositive : 1;
  let nextId = 0;
  function build(nodeRows, depth) {
    const rawPos = nodeRows.filter((row) => row.crossLabel).length;
    const weighted = counts(nodeRows, positiveWeight);
    const node = {
      id: nextId++, depth, rows: nodeRows.length, positives: rawPos,
      observedPositiveRate: round(rawPos / Math.max(1, nodeRows.length)),
      balancedPositiveRate: round(weighted.positives / Math.max(1e-9, weighted.positives + weighted.negatives)),
    };
    if (depth >= maxDepth || nodeRows.length < minRows * 2 || rawPos < 15 || nodeRows.length - rawPos < 15) return node;
    const parentImpurity = gini(nodeRows, positiveWeight), parentWeight = weighted.positives + weighted.negatives;
    let best = null;
    for (const field of featureNames) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .72) continue;
      for (const threshold of [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))]) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (left.length < minRows || right.length < minRows) continue;
        const lc = counts(left, positiveWeight), rc = counts(right, positiveWeight);
        const lw = lc.positives + lc.negatives, rw = rc.positives + rc.negatives;
        const gain = parentImpurity - (lw * gini(left, positiveWeight) + rw * gini(right, positiveWeight)) / parentWeight;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < .0005) return node;
    node.field = best.field; node.threshold = round(best.threshold, 8); node.gain = round(best.gain, 8);
    node.left = build(best.left, depth + 1); node.right = build(best.right, depth + 1);
    return node;
  }
  return { positiveWeight, root: build(trainRows, 0) };
}
function predict(tree, row) {
  let node = tree.root;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return node.balancedPositiveRate;
}
function auc(evalRows, scores) {
  const ranked = evalRows.map((row, index) => ({ positive: Boolean(row.crossLabel), score: scores[index] })).sort((a, b) => a.score - b.score);
  const positives = ranked.filter((row) => row.positive).length, negatives = ranked.length - positives;
  if (!positives || !negatives) return null;
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
function thresholdFromTrain(tree, trainRows) {
  const prevalence = trainRows.filter((row) => row.crossLabel).length / Math.max(1, trainRows.length);
  const scores = trainRows.map((row) => predict(tree, row)).sort((a, b) => b - a);
  return scores[Math.min(scores.length - 1, Math.max(0, Math.round(prevalence * scores.length) - 1))] ?? .5;
}
function evaluate(tree, evalRows, threshold) {
  const scores = evalRows.map((row) => predict(tree, row));
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let index = 0; index < evalRows.length; index++) {
    const predicted = scores[index] >= threshold, actual = Boolean(evalRows[index].crossLabel);
    if (predicted && actual) tp++; else if (predicted) fp++; else if (actual) fn++; else tn++;
  }
  return {
    rows: evalRows.length, positives: evalRows.filter((row) => row.crossLabel).length,
    auc: round(auc(evalRows, scores)), threshold: round(threshold), tp, fp, tn, fn,
    accuracyPct: pct(tp + tn, evalRows.length), precisionPct: pct(tp, tp + fp), recallPct: pct(tp, tp + fn),
    predictedCrossPct: pct(tp + fp, evalRows.length), actualCrossPct: pct(tp + fn, evalRows.length),
  };
}
function leaves(node, rules = [], output = []) {
  if (!node.field) {
    output.push({ rules, rows: node.rows, positives: node.positives, observedPositiveRate: node.observedPositiveRate, balancedPositiveRate: node.balancedPositiveRate });
    return output;
  }
  leaves(node.left, [...rules, `${node.field} <= ${node.threshold}`], output);
  leaves(node.right, [...rules, `${node.field} > ${node.threshold}`], output);
  return output;
}
function bandSummary(selectedRows) {
  const bands = [[0, 7], [8, 15], [16, 29], [30, 59], [60, Infinity]];
  return bands.map(([low, high]) => {
    const subset = selectedRows.filter((row) => row.signedShares >= low && row.signedShares <= high);
    return { low, high: Number.isFinite(high) ? high : null, orders: subset.length, crossPct: pct(subset.filter((row) => row.crossLabel).length, subset.length), beforeAbs: q(subset.map((row) => Math.abs(row.beforeImbalance))), afterResidual: q(subset.map((row) => row.targetResidual)) };
  });
}

const train = reversals.filter((row) => row.ms < splitMs), holdout = reversals.filter((row) => row.ms >= splitMs);
const tree = fitTree(train), threshold = thresholdFromTrain(tree, train);
const crosses = reversals.filter((row) => row.crossLabel), hedges = reversals.filter((row) => !row.crossLabel);
const report = {
  schema: 1, generatedAt: new Date().toISOString(), split: new Date(splitMs).toISOString(),
  method: "chronological classifier for partial-hedge versus inventory-cross using only public pre-fire L2/feed and reconstructed pre-action inventory",
  samples: { actions: rows.length, reversals: reversals.length, train: train.length, holdout: holdout.length, hedge: hedges.length, cross: crosses.length },
  formulaEvidence: {
    hedge: { signedShares: q(hedges.map((row) => row.signedShares)), beforeAbs: q(hedges.map((row) => Math.abs(row.beforeImbalance))), remainingOldResidual: q(hedges.map((row) => row.trimResidual)) },
    cross: { signedShares: q(crosses.map((row) => row.signedShares)), beforeAbs: q(crosses.map((row) => Math.abs(row.beforeImbalance))), newSideResidual: q(crosses.map((row) => row.targetResidual)), sizeMinusOldImbalance: q(crosses.map((row) => row.filledShares - Math.abs(row.beforeImbalance))) },
    signedSizeBands: bandSummary(reversals),
  },
  model: {
    features: featureNames, tree, train: evaluate(tree, train, threshold), holdout: evaluate(tree, holdout, threshold),
    strongestCrossLeaves: leaves(tree.root).sort((a, b) => b.observedPositiveRate - a.observedPositiveRate || b.rows - a.rows).slice(0, 12),
    strongestHedgeLeaves: leaves(tree.root).sort((a, b) => a.observedPositiveRate - b.observedPositiveRate || b.rows - a.rows).slice(0, 12),
  },
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const md = `# Reversal and sizing analysis\n\n` +
  `At an opposite-side action, the target either trims the obsolete position or crosses balance into a new predicted-side residual. Signed/fill sizes are labels only; they are not classifier inputs.\n\n` +
  `- ${reversals.length.toLocaleString()} reconstructed reversal actions: ${hedges.length.toLocaleString()} partial hedges and ${crosses.length.toLocaleString()} inventory crossings.\n` +
  `- Cross formula: median old imbalance ${report.formulaEvidence.cross.beforeAbs.p50} shares, median fill ${report.formulaEvidence.cross.signedShares.p50} signed minimum shares, median new-side residual ${report.formulaEvidence.cross.newSideResidual.p50} shares.\n` +
  `- Chronological tree AUC: train ${report.model.train.auc}, untouched holdout ${report.model.holdout.auc}; holdout precision ${report.model.holdout.precisionPct}% and recall ${report.model.holdout.recallPct}%.\n`;
fs.writeFileSync(outputFile.replace(/\.json$/i, ".md"), md);
console.log(md);
console.log(JSON.stringify({ samples: report.samples, formulaEvidence: report.formulaEvidence, train: report.model.train, holdout: report.model.holdout, crossLeaves: report.model.strongestCrossLeaves.slice(0, 6), hedgeLeaves: report.model.strongestHedgeLeaves.slice(0, 6) }, null, 2));
