#!/usr/bin/env node
// Chronological probability/EV gate for BTC actions. The tree is trained only
// on target actions before the split and asks whether the chosen token wins;
// later actions are a true temporal validation. Resolution is never a feature.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "../wallet-3048/core.mjs";

const dataDir = path.resolve(process.argv[2] || "data/wallet-75cc");
const cohortFile = path.resolve(process.argv[3] || path.join(dataDir, "cohort-2026-08-25-btc-eth-traded.json"));
const splitMs = Date.parse(process.argv[4] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[5] || path.join(dataDir, "action-value-tree-btc.json"));
const actionsFile = path.resolve(process.env.W75CC_FIRE_ACTIONS_FILE || path.join(dataDir, "fire-actions-v2-btc-decision520.json.gz"));
const samplesFile = path.resolve(process.env.W75CC_FIRE_SAMPLES_FILE || path.join(dataDir, "fire-gate-samples-v2-btc-decision520.json.gz"));
const signedFile = path.resolve(process.env.W75CC_SIGNED_FILE || path.join(dataDir, "signed-orders.json.gz"));
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const actions = readGzip(actionsFile).rows;
const positives = readGzip(samplesFile).positives;
const signed = readGzip(signedFile).groups;
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const winnerBySlug = new Map(cohort.markets.map((market) => [market.slug, market.winner]));
const signedByHash = new Map(signed.map((order) => [order.orderHash, order]));
const sampleByKey = new Map(positives.map((row) => [`${row.slug}:${row.fillMs}:${row.side}`, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const featureNames = [
  "timeS", "ask", "spread", "pairAsk", "askDepth1", "bidDepth1", "askDepth3", "bidDepth3",
  "topDepthImbalance", "depth3Imbalance", "topAskShareOfDepth3", "micropriceBias",
  "sideAskMove1", "sideBidMove1", "sideAskMove3", "sideBidMove3", "sideAskMove5", "sideBidMove5",
  "sideAskMove10", "sideBidMove10", "bzMove1", "bzMove3", "bzMove5", "bzMove10",
  "clMove1", "clMove3", "clMove5", "clMove10", "bzGap", "clGap",
  "absoluteInventory", "orientedInventory", "isHedge", "fifoPairCost", "sinceLastFireS", "sinceSameSideFireS",
];

const rows = actions.map((action) => {
  const sample = sampleByKey.get(`${action.slug}:${action.fireMs}:${action.outcome}`);
  const winner = winnerBySlug.get(action.slug);
  const orders = action.orderHashes.map((hash) => signedByHash.get(hash)).filter(Boolean);
  if (!sample || !winner || !orders.length) return null;
  let shares = 0, cost = 0, fees = 0;
  for (const order of orders) {
    shares += Number(order.filledShares); cost += Number(order.filledUsd);
    for (const fill of order.settlements) fees += .07 * Number(fill.vwap) * (1 - Number(fill.vwap)) * Number(fill.shares);
  }
  const win = Number(winner === action.outcome), payout = win ? shares : 0;
  return {
    ...Object.fromEntries(featureNames.map((field) => [field, sample[field]])),
    slug: action.slug, ms: action.decisionMs, fillMs: action.fireMs, side: action.outcome,
    role: action.role, win, shares, cost, fees, payout, net: payout - cost - fees,
  };
}).filter(Boolean);

function gini(nodeRows) {
  if (!nodeRows.length) return 0;
  const p = nodeRows.reduce((sum, row) => sum + row.win, 0) / nodeRows.length;
  return 2 * p * (1 - p);
}
function fitTree(trainRows, { maxDepth = 5, minRows = 35, prior = 20 } = {}) {
  const base = trainRows.reduce((sum, row) => sum + row.win, 0) / trainRows.length;
  let nextId = 0;
  function build(nodeRows, depth) {
    const wins = nodeRows.reduce((sum, row) => sum + row.win, 0);
    const node = { id: nextId++, depth, rows: nodeRows.length, wins, winRate: round((wins + prior * base) / (nodeRows.length + prior), 9) };
    if (depth >= maxDepth || nodeRows.length < minRows * 2) return node;
    const parent = gini(nodeRows); let best = null;
    for (const field of featureNames) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .72) continue;
      for (const threshold of [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))]) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (left.length < minRows || right.length < minRows) continue;
        const gain = parent - (left.length * gini(left) + right.length * gini(right)) / nodeRows.length;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < .002) return node;
    node.field = best.field; node.threshold = round(best.threshold, 8); node.gain = round(best.gain, 8);
    node.left = build(best.left, depth + 1); node.right = build(best.right, depth + 1);
    return node;
  }
  return build(trainRows, 0);
}
function predict(tree, row) {
  let node = tree;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Number(node.winRate);
}
function auc(evalRows) {
  const ranked = evalRows.map((row) => ({ score: predict(tree, row), win: row.win })).sort((a, b) => a.score - b.score);
  const positives = ranked.filter((row) => row.win).length, negatives = ranked.length - positives;
  let rankSum = 0;
  for (let index = 0; index < ranked.length;) {
    let end = index + 1; while (end < ranked.length && ranked[end].score === ranked[index].score) end++;
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (ranked[cursor].win) rankSum += rank;
    index = end;
  }
  return positives && negatives ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : null;
}
function scoreRows(evalRows, minEdge) {
  const selected = evalRows.filter((row) => {
    const feePerShare = .07 * Number(row.ask) * (1 - Number(row.ask));
    return predict(tree, row) - Number(row.ask) - feePerShare >= minEdge;
  });
  const cost = selected.reduce((sum, row) => sum + row.cost + row.fees, 0), net = selected.reduce((sum, row) => sum + row.net, 0);
  return { actions: selected.length, cost: round(cost), net: round(net), roiPct: cost ? round(net / cost * 100) : null,
    winRatePct: selected.length ? round(selected.reduce((sum, row) => sum + row.win, 0) / selected.length * 100) : null };
}
function metrics(evalRows) {
  const predictions = evalRows.map((row) => predict(tree, row));
  const brier = predictions.reduce((sum, value, index) => sum + (value - evalRows[index].win) ** 2, 0) / evalRows.length;
  return { rows: evalRows.length, winRatePct: round(evalRows.reduce((sum, row) => sum + row.win, 0) / evalRows.length * 100), auc: round(auc(evalRows)), brier: round(brier) };
}
function leaves(node, rules = [], output = []) {
  if (!node.field) { output.push({ rules, rows: node.rows, wins: node.wins, winRate: node.winRate }); return output; }
  leaves(node.left, [...rules, `${node.field} <= ${node.threshold}`], output);
  leaves(node.right, [...rules, `${node.field} > ${node.threshold}`], output);
  return output;
}

const train = rows.filter((row) => row.ms < splitMs), holdout = rows.filter((row) => row.ms >= splitMs);
const tree = fitTree(train);
const candidates = [-.05, -.03, -.02, -.01, 0, .01, .02, .03, .05].map((minEdge) => ({ minEdge, train: scoreRows(train, minEdge), holdout: scoreRows(holdout, minEdge) }));
const selected = candidates.filter((row) => row.train.actions >= 100).sort((a, b) => b.train.net - a.train.net || b.train.roiPct - a.train.roiPct)[0];
const report = {
  schema: 1, generatedAt: new Date().toISOString(), split: new Date(splitMs).toISOString(),
  method: "chronological target-action win-probability tree; candidate EV = p(win)-decision ask-taker fee; resolution used only as training label",
  files: { cohortFile, actionsFile, samplesFile, signedFile }, features: featureNames,
  samples: { all: rows.length, train: train.length, holdout: holdout.length }, tree,
  train: metrics(train), holdout: metrics(holdout), candidates, selected,
  strongestLeaves: leaves(tree).sort((a, b) => b.winRate - a.winRate || b.rows - a.rows).slice(0, 16),
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const md = `# BTC action-value gate\n\n- Win AUC: train ${report.train.auc}, later holdout ${report.holdout.auc}.\n- Train-selected edge ${selected?.minEdge}: train ${selected?.train.net} USD, later ${selected?.holdout.net} USD.\n`;
fs.writeFileSync(outputFile.replace(/\.json$/i, ".md"), md);
console.log(md);
console.log(JSON.stringify({ samples: report.samples, train: report.train, holdout: report.holdout, selected, candidates, strongestLeaves: report.strongestLeaves.slice(0, 8) }, null, 2));
