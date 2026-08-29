#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const l2Dir = path.resolve(process.argv[3] || path.join(dataDir, "feeds/v4-e8-l2"));
const v2Dir = path.resolve(process.argv[4] || path.join(dataDir, "feeds/v2"));
const actionsFile = path.resolve(process.env.W3048_FIRE_ACTIONS_FILE || path.join(dataDir, "fire-actions.json.gz"));
const slugPrefix = String(process.env.W3048_SLUG_PREFIX || "").trim().toLowerCase();
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionsFile))).rows
  .filter((action) => !slugPrefix || action.slug.toLowerCase().startsWith(slugPrefix));
const splitMs = Date.parse(process.argv[5] || "2026-08-22T06:20:00Z");
const decisionLatencyMs = Math.max(0, Number(process.env.W3048_DECISION_LATENCY_MS || 0));
const outputSuffix = String(process.argv[6] || "").replace(/[^a-zA-Z0-9_-]/g, "");
const outputName = (base, extension) => path.join(dataDir, `${base}${outputSuffix ? `-${outputSuffix}` : ""}.${extension}`);
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const opposite = (side) => side === "Up" ? "Down" : "Up";
const q = (values) => Object.fromEntries([.1, .25, .5, .75, .9].map((p) => [
  `p${Math.round(p * 100)}`,
  round(quantile(values.filter(finite).map(Number), p), 6),
]));

function readFeed(slug) {
  const file = path.join(l2Dir, `${slug}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const v2File = path.join(v2Dir, `${slug}.json.gz`);
  if (fs.existsSync(v2File)) {
    const v2 = JSON.parse(zlib.gunzipSync(fs.readFileSync(v2File)));
    feed.openChainlink = Number(v2.openChainlink);
    let cursor = -1, current = null;
    for (const tick of feed.ticks) {
      while (cursor + 1 < v2.ticks.length && v2.ticks[cursor + 1].ms <= tick.ms) {
        cursor++;
        if (Number(v2.ticks[cursor].cl) > 0) current = Number(v2.ticks[cursor].cl);
      }
      tick.cl = current;
    }
  }
  return feed;
}

function indexAtOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}
function book(tick, side) { return side === "Up" ? tick?.up : tick?.down; }
function ask(tick, side) { return Number(book(tick, side)?.asks?.[0]?.price); }
function bid(tick, side) { return Number(book(tick, side)?.bids?.[0]?.price); }
function depth(levels, count = 3) { return (levels || []).slice(0, count).reduce((sum, row) => sum + Number(row.size), 0); }
function firstLotCost(lots, shares) {
  let left = shares, used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take; used += take; cost += take * lot.effectivePrice;
    if (left <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? cost / used : null;
}
function addAction(state, action) {
  const side = action.outcome, other = opposite(side);
  let left = Number(action.filledShares);
  while (left > 1e-9 && state.lots[other].length) {
    const lot = state.lots[other][0], take = Math.min(left, lot.shares);
    left -= take; lot.shares -= take;
    if (lot.shares <= 1e-9) state.lots[other].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice: Number(action.effectivePrice) });
  if (side === "Up") state.up += Number(action.filledShares); else state.down += Number(action.filledShares);
  state.lastFireMs = action.fireMs;
  state.lastSideMs[side] = action.fireMs;
}

function features(feed, index, side, state) {
  const tick = feed.ticks[index], sideBook = book(tick, side), other = opposite(side);
  const bestAsk = ask(tick, side), bestBid = bid(tick, side), otherAsk = ask(tick, other);
  if (!finite(bestAsk) || !finite(bestBid) || !finite(otherAsk)) return null;
  const askDepth1 = depth(sideBook.asks, 1), bidDepth1 = depth(sideBook.bids, 1);
  const askDepth3 = depth(sideBook.asks, 3), bidDepth3 = depth(sideBook.bids, 3);
  const sign = side === "Up" ? 1 : -1, imbalance = state.up - state.down, orientedInventory = imbalance * sign;
  const lotCost = orientedInventory < -1e-9 ? firstLotCost(state.lots[other], Math.min(30, Math.abs(imbalance))) : null;
  const out = {
    timeS: (tick.ms - startMs(feed.slug)) / 1000,
    ask: bestAsk,
    spread: bestAsk - bestBid,
    pairAsk: bestAsk + otherAsk,
    askDepth1, bidDepth1, askDepth3, bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(1e-9, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(1e-9, bidDepth3 + askDepth3),
    micropriceBias: (bidDepth1 * bestAsk + askDepth1 * bestBid) / Math.max(1e-9, bidDepth1 + askDepth1) - (bestAsk + bestBid) / 2,
    orientedInventory,
    absoluteInventory: Math.abs(imbalance),
    isHedge: orientedInventory < -1e-9 ? 1 : 0,
    fifoPairCost: lotCost == null ? null : lotCost + bestAsk + .07 * bestAsk * (1 - bestAsk),
    sinceLastFireS: finite(state.lastFireMs) ? (tick.ms - state.lastFireMs) / 1000 : 300,
    sinceSameSideFireS: finite(state.lastSideMs[side]) ? (tick.ms - state.lastSideMs[side]) / 1000 : 300,
  };
  const previous = feed.ticks[index - 1];
  out.sideAskTickMove = finite(ask(previous, side)) ? bestAsk - ask(previous, side) : null;
  out.sideBidTickMove = finite(bid(previous, side)) ? bestBid - bid(previous, side) : null;
  for (const [label, lookbackMs] of [["100ms", 100], ["250ms", 250], ["500ms", 500], ["1", 1_000], ["3", 3_000], ["5", 5_000]]) {
    const prior = feed.ticks[indexAtOrBefore(feed.ticks, tick.ms - lookbackMs)], priorBook = book(prior, side);
    const priorAsk = ask(prior, side), priorBid = bid(prior, side);
    out[`sideAskMove${label}`] = finite(priorAsk) ? bestAsk - priorAsk : null;
    out[`sideBidMove${label}`] = finite(priorBid) ? bestBid - priorBid : null;
    out[`askDepth3Change${label}`] = priorBook ? askDepth3 - depth(priorBook.asks, 3) : null;
    out[`bidDepth3Change${label}`] = priorBook ? bidDepth3 - depth(priorBook.bids, 3) : null;
    out[`bzMove${label}`] = Number(tick.bz) > 0 && Number(prior?.bz) > 0
      ? (Number(tick.bz) - Number(prior.bz)) / Number(prior.bz) * 100 * sign : null;
    out[`clMove${label}`] = Number(tick.cl) > 0 && Number(prior?.cl) > 0
      ? (Number(tick.cl) - Number(prior.cl)) / Number(prior.cl) * 100 * sign : null;
  }
  out.sideAskAccel500ms = finite(out.sideAskMove500ms) && finite(out.sideAskMove1) ? 2 * out.sideAskMove500ms - out.sideAskMove1 : null;
  out.sideBidAccel500ms = finite(out.sideBidMove500ms) && finite(out.sideBidMove1) ? 2 * out.sideBidMove500ms - out.sideBidMove1 : null;
  out.bzAccel500ms = finite(out.bzMove500ms) && finite(out.bzMove1) ? 2 * out.bzMove500ms - out.bzMove1 : null;
  out.bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0
    ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 * sign : null;
  out.clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0
    ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 * sign : null;
  return out;
}

const bySlug = new Map();
for (const action of actions) {
  if (!bySlug.has(action.slug)) bySlug.set(action.slug, []);
  bySlug.get(action.slug).push(action);
}
const pairs = [];
for (const [slug, marketActions] of bySlug) {
  const feed = readFeed(slug);
  if (!feed?.ticks?.length) continue;
  const ordered = [...marketActions].sort((a, b) => a.fireMs - b.fireMs);
  const state = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
  for (let actionIndex = 0; actionIndex < ordered.length; actionIndex++) {
    const action = ordered[actionIndex];
    const ambiguousDual = ordered.some((other, index) => index !== actionIndex && other.outcome !== action.outcome && Math.abs(other.fireMs - action.fireMs) <= 500);
    const decisionMs = action.fireMs - decisionLatencyMs;
    const decisionState = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
    for (const prior of ordered) {
      if (prior === action || prior.fireMs > decisionMs) break;
      addAction(decisionState, prior);
    }
    const index = indexAtOrBefore(feed.ticks, decisionMs);
    const chosen = features(feed, index, action.outcome, decisionState), rejected = features(feed, index, opposite(action.outcome), decisionState);
    if (!ambiguousDual && chosen && rejected) {
      const before = decisionState.up - decisionState.down, sign = action.outcome === "Up" ? 1 : -1;
      const role = Math.abs(before) < 1e-9 ? "flat" : before * sign < 0 ? "hedge" : "entry/topup";
      const id = `${slug}:${actionIndex}`;
      pairs.push({ id, slug, ms: decisionMs, fillMs: action.fireMs, role, chosen: { id, slug, ms: decisionMs, fillMs: action.fireMs, role, label: 1, ...chosen }, rejected: { id, slug, ms: decisionMs, fillMs: action.fireMs, role, label: 0, ...rejected } });
    }
    addAction(state, action);
  }
}

const excluded = new Set(["id", "slug", "ms", "fillMs", "role", "label", "absoluteInventory", "sinceLastFireS"]);
const featureNames = Object.keys(pairs[0]?.chosen || {}).filter((field) => !excluded.has(field));
function contrast(selectedPairs) {
  return featureNames.map((field) => {
    let higher = 0, lower = 0, ties = 0, usable = 0;
    const chosen = [], rejected = [];
    for (const pair of selectedPairs) {
      const a = Number(pair.chosen[field]), b = Number(pair.rejected[field]);
      if (!finite(a) || !finite(b)) continue;
      usable++; chosen.push(a); rejected.push(b);
      if (a > b + 1e-12) higher++; else if (a < b - 1e-12) lower++; else ties++;
    }
    const auc = usable ? (higher + .5 * ties) / usable : null;
    return {
      field, pairs: usable, chosen: q(chosen), rejected: q(rejected), pairedAuc: round(auc),
      separation: auc == null ? null : round(Math.abs(auc - .5) * 2),
      chosenDirection: auc == null ? null : auc >= .5 ? "higher" : "lower",
      higherPct: pct(higher, usable), lowerPct: pct(lower, usable), tiePct: pct(ties, usable),
    };
  }).sort((a, b) => Number(b.separation || 0) - Number(a.separation || 0));
}

function gini(rows) {
  if (!rows.length) return 0;
  const positives = rows.filter((row) => row.label).length, p = positives / rows.length;
  return 2 * p * (1 - p);
}
function fitTree(rows, fields, { maxDepth = 5, minRows = 180 } = {}) {
  let nextId = 0;
  function build(nodeRows, depthLevel) {
    const positives = nodeRows.filter((row) => row.label).length;
    const node = { id: nextId++, depth: depthLevel, rows: nodeRows.length, positiveRate: round(positives / Math.max(1, nodeRows.length)) };
    if (depthLevel >= maxDepth || nodeRows.length < minRows * 2) return node;
    const parent = gini(nodeRows);
    let best = null;
    for (const field of fields) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .7) continue;
      for (const threshold of [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))]) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (left.length < minRows || right.length < minRows) continue;
        const gain = parent - (left.length * gini(left) + right.length * gini(right)) / nodeRows.length;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < 1e-5) return node;
    node.field = best.field; node.threshold = round(best.threshold, 8); node.gain = round(best.gain, 8);
    node.left = build(best.left, depthLevel + 1); node.right = build(best.right, depthLevel + 1);
    return node;
  }
  return build(rows, 0);
}
function predict(tree, row) {
  let node = tree;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Number(node.positiveRate);
}
function pairedAuc(selectedPairs, tree) {
  if (!selectedPairs.length) return null;
  let score = 0;
  for (const pair of selectedPairs) {
    const chosen = predict(tree, pair.chosen), rejected = predict(tree, pair.rejected);
    score += chosen > rejected ? 1 : chosen === rejected ? .5 : 0;
  }
  return score / selectedPairs.length;
}
function leaves(tree, pathParts = [], output = []) {
  if (!tree.field) { output.push({ rule: pathParts.join(" AND ") || "all", positiveRate: tree.positiveRate, rows: tree.rows }); return output; }
  leaves(tree.left, [...pathParts, `${tree.field} <= ${tree.threshold}`], output);
  leaves(tree.right, [...pathParts, `${tree.field} > ${tree.threshold}`], output);
  return output;
}

const trainPairs = pairs.filter((pair) => pair.ms < splitMs), holdoutPairs = pairs.filter((pair) => pair.ms >= splitMs);
const rows = trainPairs.flatMap((pair) => [pair.chosen, pair.rejected]);
const fullTree = fitTree(rows, featureNames);
const marketFields = featureNames.filter((field) => !["orientedInventory", "isHedge", "fifoPairCost", "sinceSameSideFireS"].includes(field));
const marketTree = fitTree(rows, marketFields);
const allContrast = contrast(pairs), flatContrast = contrast(pairs.filter((pair) => pair.role === "flat"));
const entryContrast = contrast(pairs.filter((pair) => pair.role === "entry/topup"));
const hedgeContrast = contrast(pairs.filter((pair) => pair.role === "hedge"));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  decisionLatencyMs,
  slugPrefix: slugPrefix || null,
  actionsFile,
  method: `at inferred fill minus ${decisionLatencyMs}ms, compare the selected token with the simultaneously available opposite token under completed pre-decision inventory; exclude opposite-side fills within 500ms`,
  samples: { pairs: pairs.length, train: trainPairs.length, holdout: holdoutPairs.length, roles: Object.fromEntries(["flat", "entry/topup", "hedge"].map((role) => [role, pairs.filter((pair) => pair.role === role).length])) },
  contrasts: { all: allContrast, flat: flatContrast, entry: entryContrast, hedge: hedgeContrast },
  fullTree: { root: fullTree, trainPairedAuc: round(pairedAuc(trainPairs, fullTree)), holdoutPairedAuc: round(pairedAuc(holdoutPairs, fullTree)), strongLeaves: leaves(fullTree).sort((a, b) => b.positiveRate - a.positiveRate).slice(0, 8) },
  marketOnlyTree: { excludedInventoryFeatures: ["orientedInventory", "isHedge", "fifoPairCost", "sinceSameSideFireS"], root: marketTree, trainPairedAuc: round(pairedAuc(trainPairs, marketTree)), holdoutPairedAuc: round(pairedAuc(holdoutPairs, marketTree)), strongLeaves: leaves(marketTree).sort((a, b) => b.positiveRate - a.positiveRate).slice(0, 8) },
};
fs.writeFileSync(outputName("side-choice-analysis", "json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputName("side-choice-samples", "json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, pairs }), { level: 9 }));
const top = (rows, count = 10) => rows.slice(0, count).map((row) => `${row.field} (${row.chosenDirection}, paired AUC ${row.pairedAuc}; chosen median ${row.chosen.p50} vs other ${row.rejected.p50})`).join("; ");
const md = `# Simultaneous side-choice analysis\n\n` +
`This separates branch selection from release timing by comparing the fired token against the opposite token at the same pre-consumption v4 tick.\n\n` +
`- ${report.samples.pairs.toLocaleString()} non-simultaneous choices: ${report.samples.roles.flat} flat, ${report.samples.roles["entry/topup"]} entry/top-up, ${report.samples.roles.hedge} hedge.\n` +
`- All choices: ${top(allContrast)}.\n` +
`- Flat choices: ${top(flatContrast)}.\n` +
`- Entry/top-up choices: ${top(entryContrast)}.\n` +
`- Hedge choices: ${top(hedgeContrast)}.\n` +
`- Inventory-aware tree paired AUC: train ${report.fullTree.trainPairedAuc}, untouched holdout ${report.fullTree.holdoutPairedAuc}.\n` +
`- Market-only tree paired AUC: train ${report.marketOnlyTree.trainPairedAuc}, untouched holdout ${report.marketOnlyTree.holdoutPairedAuc}.\n`;
fs.writeFileSync(outputName("side-choice-analysis", "md"), md);
console.log(md);
console.log(JSON.stringify({ samples: report.samples, top: { all: allContrast.slice(0, 12), flat: flatContrast.slice(0, 12), entry: entryContrast.slice(0, 12), hedge: hedgeContrast.slice(0, 12) }, trees: { full: report.fullTree, marketOnly: report.marketOnlyTree } }, null, 2));
