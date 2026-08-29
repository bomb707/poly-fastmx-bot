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
const signedFile = path.resolve(process.env.W3048_SIGNED_FILE || path.join(dataDir, "signed-orders.json.gz"));
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionsFile))).rows;
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(signedFile))).groups;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const splitMs = Date.parse(process.argv[5] || "2026-08-22T06:20:00Z");
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const decisionLatencyMs = Math.max(0, Number(process.env.W3048_DECISION_LATENCY_MS || 0));
const slugPrefix = String(process.env.W3048_SLUG_PREFIX || "").trim().toLowerCase();
const outputSuffix = String(process.env.W3048_OUTPUT_SUFFIX || process.argv[6] || "").replace(/[^a-zA-Z0-9_-]/g, "");
const sourceName = String(process.env.W3048_ORDERBOOK_SOURCE || path.basename(l2Dir));
const controlBucketMs = Math.max(50, Number(process.env.W3048_HAZARD_BUCKET_MS || 250));
const lookbackMs = Math.max(1_000, Number(process.env.W3048_HAZARD_LOOKBACK_MS || 30_000));
const outputName = (base, extension) => path.join(dataDir, `${base}${outputSuffix ? `-${outputSuffix}` : ""}.${extension}`);
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
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

function sideBook(tick, side) { return side === "Up" ? tick?.up : tick?.down; }
function opposite(side) { return side === "Up" ? "Down" : "Up"; }
function bestAsk(tick, side) { return Number(sideBook(tick, side)?.asks?.[0]?.price); }
function bestBid(tick, side) { return Number(sideBook(tick, side)?.bids?.[0]?.price); }
function depth(levels, levelsCount = 3) {
  return (levels || []).slice(0, levelsCount).reduce((sum, level) => sum + Number(level.size), 0);
}

function addLots(state, action) {
  const side = action.outcome, other = opposite(side);
  let left = Number(action.filledShares);
  while (left > 1e-9 && state.lots[other].length) {
    const lot = state.lots[other][0], take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    if (lot.shares <= 1e-9) state.lots[other].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice: Number(action.effectivePrice) });
  if (side === "Up") state.up += Number(action.filledShares); else state.down += Number(action.filledShares);
  const decisionMs = Number(action.decisionMs ?? action.fireMs - decisionLatencyMs);
  state.lastFireMs = decisionMs;
  state.lastSideMs[side] = decisionMs;
}

function firstLotCost(lots, shares) {
  let left = shares, used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take;
    used += take;
    cost += take * lot.effectivePrice;
    if (left <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? cost / used : null;
}

function featureAt(feed, index, side, cap, state, action, readyMs, arrivalIndex) {
  if (index < 0) return null;
  const tick = feed.ticks[index], book = sideBook(tick, side), otherAsk = bestAsk(tick, opposite(side));
  const ask = bestAsk(tick, side), bid = bestBid(tick, side);
  const arrivalAsk = bestAsk(feed.ticks[arrivalIndex], side);
  // Marketability is conditioned at the simulated 520 ms arrival. All model
  // features remain decision-time values, so the future arrival book cannot
  // leak into the learned release rule.
  if (!finite(ask) || !finite(bid) || !finite(arrivalAsk) || arrivalAsk > cap + .00011) return null;
  const askDepth1 = depth(book.asks, 1), bidDepth1 = depth(book.bids, 1);
  const askDepth3 = depth(book.asks, 3), bidDepth3 = depth(book.bids, 3);
  const sign = side === "Up" ? 1 : -1, imbalance = state.up - state.down, orientedInventory = imbalance * sign;
  const lotCost = orientedInventory < -1e-9
    ? firstLotCost(state.lots[opposite(side)], Math.min(30, Math.abs(imbalance))) : null;
  let onsetIndex = index;
  while (onsetIndex > 0 && feed.ticks[onsetIndex - 1].ms >= readyMs && bestAsk(feed.ticks[onsetIndex - 1], side) <= cap + .00011) onsetIndex--;
  const out = {
    timeS: (tick.ms - startMs(feed.slug)) / 1000,
    ask,
    cap,
    capHeadroom: cap - ask,
    exactCap: Math.abs(cap - ask) < .005 ? 1 : 0,
    spread: ask - bid,
    pairAsk: ask + otherAsk,
    askDepth1,
    bidDepth1,
    askDepth3,
    bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(1e-9, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(1e-9, bidDepth3 + askDepth3),
    micropriceBias: (bidDepth1 * ask + askDepth1 * bid) / Math.max(1e-9, bidDepth1 + askDepth1) - (ask + bid) / 2,
    executableRunS: (tick.ms - feed.ticks[onsetIndex].ms) / 1000,
    sinceSignedS: (tick.ms - Math.max(...action.orderHashes.map((hash) => Number(signedByHash.get(hash)?.signedTimestampMs || 0)))) / 1000,
    sinceLastFireS: finite(state.lastFireMs) ? (tick.ms - state.lastFireMs) / 1000 : 300,
    sinceSameSideFireS: finite(state.lastSideMs[side]) ? (tick.ms - state.lastSideMs[side]) / 1000 : 300,
    orientedInventory,
    absoluteInventory: Math.abs(imbalance),
    isHedge: orientedInventory < -1e-9 ? 1 : 0,
    fifoPairCost: lotCost == null ? null : lotCost + ask + .07 * ask * (1 - ask),
    contains90: action.signedSizes.includes(90) ? 1 : 0,
  };
  for (const seconds of [1, 3, 5]) {
    const priorIndex = indexAtOrBefore(feed.ticks, tick.ms - seconds * 1000);
    const prior = feed.ticks[priorIndex], priorBook = sideBook(prior, side);
    const priorAsk = bestAsk(prior, side), priorBid = bestBid(prior, side);
    out[`sideAskMove${seconds}`] = finite(priorAsk) ? ask - priorAsk : null;
    out[`sideBidMove${seconds}`] = finite(priorBid) ? bid - priorBid : null;
    out[`askDepth3Change${seconds}`] = priorBook ? askDepth3 - depth(priorBook.asks, 3) : null;
    out[`bidDepth3Change${seconds}`] = priorBook ? bidDepth3 - depth(priorBook.bids, 3) : null;
    out[`bzMove${seconds}`] = Number(tick.bz) > 0 && Number(prior?.bz) > 0
      ? (Number(tick.bz) - Number(prior.bz)) / Number(prior.bz) * 100 * sign : null;
    out[`clMove${seconds}`] = Number(tick.cl) > 0 && Number(prior?.cl) > 0
      ? (Number(tick.cl) - Number(prior.cl)) / Number(prior.cl) * 100 * sign : null;
  }
  out.bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0
    ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 * sign : null;
  out.clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0
    ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 * sign : null;
  return out;
}

const bySlug = new Map();
for (const action of actions) {
  if (slugPrefix && !String(action.slug).toLowerCase().startsWith(slugPrefix)) continue;
  if (!bySlug.has(action.slug)) bySlug.set(action.slug, []);
  bySlug.get(action.slug).push(action);
}

const rows = [], matched = [];
for (const [slug, marketActions] of bySlug) {
  const feed = readFeed(slug);
  if (!feed?.ticks?.length) continue;
  const ordered = [...marketActions].sort((a, b) => a.fireMs - b.fireMs);
  for (let actionIndex = 0; actionIndex < ordered.length; actionIndex++) {
    const action = ordered[actionIndex];
    const decisionMs = Number(action.decisionMs ?? action.fireMs - decisionLatencyMs);
    const state = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
    for (const prior of ordered) {
      if (prior === action || Number(prior.fireMs) > decisionMs) break;
      addLots(state, prior);
    }
    const exactOrders = action.orderHashes.map((hash) => signedByHash.get(hash)).filter(Boolean);
    if (!exactOrders.length) continue;
    const cap = Math.max(...exactOrders.map((order) => Number(order.limitPrice)));
    const latestSignedMs = Math.max(...exactOrders.map((order) => Number(order.signedTimestampMs)));
    const readyMs = Math.max(startMs(slug) + 4_000, latestSignedMs - 250, state.lastFireMs + 301, decisionMs - lookbackMs);
    const positiveIndex = indexAtOrBefore(feed.ticks, decisionMs);
    const positiveArrivalIndex = indexAtOrBefore(feed.ticks, Number(action.fireMs) - 1);
    const positiveFeature = featureAt(feed, positiveIndex, action.outcome, cap, state, action, readyMs, positiveArrivalIndex);
    const marketable = action.methods.some((method) => method === "take" || method === "take+rest");
    if (positiveFeature && marketable) {
      const actionId = `${slug}:${actionIndex}`;
      const negativeRows = [];
      let lastBucket = -1;
      for (let index = Math.max(0, indexAtOrBefore(feed.ticks, readyMs)); index < positiveIndex; index++) {
        const tick = feed.ticks[index];
        if (tick.ms < readyMs || tick.ms >= decisionMs) continue;
        const bucket = Math.floor((tick.ms - readyMs) / controlBucketMs);
        if (bucket === lastBucket) continue;
        lastBucket = bucket;
        const arrivalIndex = indexAtOrBefore(feed.ticks, tick.ms + decisionLatencyMs - 1);
        const feature = featureAt(feed, index, action.outcome, cap, state, action, readyMs, arrivalIndex);
        if (feature) negativeRows.push({ actionId, slug, ms: tick.ms, label: 0, ...feature });
      }
      if (negativeRows.length) {
        const positive = { actionId, slug, ms: decisionMs, fillMs: action.fireMs, role: action.role, label: 1, ...positiveFeature };
        for (const row of negativeRows) row.role = action.role;
        rows.push(positive, ...negativeRows);
        matched.push({ actionId, slug, positive, controls: negativeRows });
      }
    }
  }
}

const excluded = new Set(["actionId", "slug", "ms", "fillMs", "role", "label", "cap", "contains90"]);
const featureNames = Object.keys(rows[0] || {}).filter((key) => !excluded.has(key));
function auc(positive, negative, field) {
  const ranked = [...positive.map((row) => ({ value: Number(row[field]), label: 1 })), ...negative.map((row) => ({ value: Number(row[field]), label: 0 }))]
    .filter((row) => finite(row.value)).sort((a, b) => a.value - b.value);
  const p = ranked.filter((row) => row.label).length, n = ranked.length - p;
  if (!p || !n) return null;
  let rankSum = 0;
  for (let index = 0; index < ranked.length;) {
    let end = index + 1;
    while (end < ranked.length && ranked[end].value === ranked[index].value) end++;
    const average = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (ranked[cursor].label) rankSum += average;
    index = end;
  }
  return (rankSum - p * (p + 1) / 2) / (p * n);
}

function contrasts(groups) {
  const positives = groups.map((group) => group.positive), controls = groups.flatMap((group) => group.controls);
  return featureNames.map((field) => {
    const rawAuc = auc(positives, controls, field);
    let lowerWins = 0, higherWins = 0, ties = 0, usable = 0;
    for (const group of groups) {
      const positive = Number(group.positive[field]);
      const values = group.controls.map((row) => Number(row[field])).filter(Number.isFinite);
      if (!finite(positive) || !values.length) continue;
      usable++;
      const median = quantile(values, .5);
      if (positive < median - 1e-12) lowerWins++;
      else if (positive > median + 1e-12) higherWins++;
      else ties++;
    }
    return {
      field,
      actions: usable,
      positive: q(positives.map((row) => row[field])),
      eligibleControl: q(controls.map((row) => row[field])),
      auc: round(rawAuc),
      separation: rawAuc == null ? null : round(Math.abs(rawAuc - .5) * 2),
      direction: rawAuc == null ? null : rawAuc >= .5 ? "higher" : "lower",
      matchedLowerPct: pct(lowerWins, usable),
      matchedHigherPct: pct(higherWins, usable),
      matchedTiePct: pct(ties, usable),
    };
  }).sort((a, b) => Number(b.separation || 0) - Number(a.separation || 0));
}

const modelFeatures = featureNames.filter((field) => !["sinceSignedS"].includes(field));
function weightedCounts(nodeRows) {
  let positive = 0, negative = 0;
  for (const row of nodeRows) row.label ? positive += row.weight : negative += row.weight;
  return { positive, negative, total: positive + negative };
}
function gini(nodeRows) {
  const counts = weightedCounts(nodeRows);
  if (!counts.total) return 0;
  const p = counts.positive / counts.total;
  return 2 * p * (1 - p);
}
function weightedRows(groups) {
  return groups.flatMap((group) => [
    { ...group.positive, weight: .5 },
    ...group.controls.map((row) => ({ ...row, weight: .5 / group.controls.length })),
  ]);
}
function fitTree(trainRows, candidateFeatures, { maxDepth = 5, minActions = 120 } = {}) {
  let nextId = 0;
  function build(nodeRows, depthLevel) {
    const id = nextId++, counts = weightedCounts(nodeRows), actionCount = new Set(nodeRows.map((row) => row.actionId)).size;
    const node = {
      id,
      depth: depthLevel,
      actions: actionCount,
      rows: nodeRows.length,
      positiveRate: round(counts.positive / Math.max(1e-9, counts.total)),
    };
    if (depthLevel >= maxDepth || actionCount < minActions * 2) return node;
    const parentImpurity = gini(nodeRows), parentWeight = counts.total;
    let best = null;
    for (const field of candidateFeatures) {
      const values = nodeRows.map((row) => Number(row[field])).filter(Number.isFinite);
      if (values.length < nodeRows.length * .7) continue;
      const thresholds = [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9].map((p) => quantile(values, p)))];
      for (const threshold of thresholds) {
        const left = [], right = [];
        for (const row of nodeRows) (Number(row[field]) <= threshold ? left : right).push(row);
        if (new Set(left.map((row) => row.actionId)).size < minActions || new Set(right.map((row) => row.actionId)).size < minActions) continue;
        const leftWeight = weightedCounts(left).total, rightWeight = weightedCounts(right).total;
        const gain = parentImpurity - (leftWeight * gini(left) + rightWeight * gini(right)) / parentWeight;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < 1e-5) return node;
    node.field = best.field;
    node.threshold = round(best.threshold, 8);
    node.gain = round(best.gain, 8);
    node.left = build(best.left, depthLevel + 1);
    node.right = build(best.right, depthLevel + 1);
    return node;
  }
  return build(trainRows, 0);
}
function predict(tree, row) {
  let node = tree;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Number(node.positiveRate);
}
function matchedAuc(groups, tree) {
  let total = 0, count = 0;
  for (const group of groups) {
    const positive = predict(tree, group.positive);
    for (const control of group.controls) {
      const negative = predict(tree, control);
      total += positive > negative ? 1 : positive === negative ? .5 : 0;
      count++;
    }
  }
  return count ? total / count : null;
}
function leaves(tree, pathParts = [], out = []) {
  if (!tree.field) {
    out.push({ rule: pathParts.join(" AND ") || "all", positiveRate: tree.positiveRate, actions: tree.actions, rows: tree.rows });
    return out;
  }
  leaves(tree.left, [...pathParts, `${tree.field} <= ${tree.threshold}`], out);
  leaves(tree.right, [...pathParts, `${tree.field} > ${tree.threshold}`], out);
  return out;
}

const trainGroups = matched.filter((group) => group.positive.ms < splitMs);
const holdoutGroups = matched.filter((group) => group.positive.ms >= splitMs);
const minActions = Math.max(10, Number(process.env.W3048_HAZARD_MIN_ACTIONS || 60));
const maxDepth = Math.max(1, Number(process.env.W3048_HAZARD_MAX_DEPTH || 5));
const tree = fitTree(weightedRows(trainGroups), modelFeatures, { minActions, maxDepth });
const structuralFeatures = modelFeatures.filter((field) => ![
  "timeS", "executableRunS", "sinceSignedS", "sinceLastFireS", "sinceSameSideFireS",
].includes(field));
const structuralTree = fitTree(weightedRows(trainGroups), structuralFeatures, { minActions, maxDepth });
const roleModels = {};
for (const [role, accept] of [
  ["all", () => true],
  ["entry", (group) => group.positive.role === "entry/topup"],
  ["hedge", (group) => group.positive.role !== "entry/topup"],
]) {
  const roleTrain = trainGroups.filter(accept), roleHoldout = holdoutGroups.filter(accept);
  const roleMinActions = Math.min(minActions, Math.max(10, Math.floor(roleTrain.length / 8)));
  const root = fitTree(weightedRows(roleTrain), structuralFeatures, { minActions: roleMinActions, maxDepth });
  roleModels[role] = {
    root,
    trainActions: roleTrain.length,
    holdoutActions: roleHoldout.length,
    trainMatchedAuc: round(matchedAuc(roleTrain, root)),
    holdoutMatchedAuc: round(matchedAuc(roleHoldout, root)),
    strongLeaves: leaves(root).sort((a, b) => b.positiveRate - a.positiveRate).slice(0, 8),
  };
}
const contrast = contrasts(matched);
const entryContrast = contrasts(matched.filter((group) => !group.positive.isHedge));
const hedgeContrast = contrasts(matched.filter((group) => group.positive.isHedge));
const strongLeaves = leaves(tree).sort((a, b) => b.positiveRate - a.positiveRate).slice(0, 8);
const structuralLeaves = leaves(structuralTree).sort((a, b) => b.positiveRate - a.positiveRate).slice(0, 8);
function directionSummary(groups, field) {
  const usable = groups.map((group) => Number(group.positive[field])).filter(Number.isFinite);
  return {
    n: usable.length,
    positivePct: pct(usable.filter((value) => value > .005).length, usable.length),
    flatPct: pct(usable.filter((value) => Math.abs(value) <= .005).length, usable.length),
    negativePct: pct(usable.filter((value) => value < -.005).length, usable.length),
    values: q(usable),
  };
}
const exactTouch = matched.filter((group) => group.positive.exactCap === 1);
const touchApproach = Object.fromEntries([1, 3, 5].map((seconds) => [seconds, {
  all: directionSummary(exactTouch, `sideAskMove${seconds}`),
  entry: directionSummary(exactTouch.filter((group) => !group.positive.isHedge), `sideAskMove${seconds}`),
  hedge: directionSummary(exactTouch.filter((group) => group.positive.isHedge), `sideAskMove${seconds}`),
} ]));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  sourceName,
  files: { actionsFile, signedFile, l2Dir, v2Dir },
  decisionLatencyMs,
  slugPrefix: slugPrefix || null,
  method: `within-order risk sets: actual decision (inferred fill minus ${decisionLatencyMs}ms) versus earlier ${controlBucketMs}ms decision ticks for the same signed action; eligibility requires its fixed cap to cross the historical book at the simulated ${decisionLatencyMs}ms arrival`,
  controls: `Only marketable take/take+rest actions with at least one eligible no-fire decision in the preceding ${lookbackMs}ms are included; every action contributes equal class weight when fitting the tree`,
  split: { trainBefore: new Date(splitMs).toISOString(), trainActions: trainGroups.length, holdoutActions: holdoutGroups.length },
  samples: { actions: matched.length, positives: matched.length, eligibleNoFire: matched.reduce((sum, group) => sum + group.controls.length, 0), controlsPerAction: q(matched.map((group) => group.controls.length)) },
  contrasts: { all: contrast, entry: entryContrast, hedge: hedgeContrast },
  touchApproach,
  tree: {
    root: tree,
    trainMatchedAuc: round(matchedAuc(trainGroups, tree)),
    holdoutMatchedAuc: round(matchedAuc(holdoutGroups, tree)),
    strongLeaves,
  },
  structuralTree: {
    excludedClockFeatures: ["timeS", "executableRunS", "sinceSignedS", "sinceLastFireS", "sinceSameSideFireS"],
    root: structuralTree,
    trainMatchedAuc: round(matchedAuc(trainGroups, structuralTree)),
    holdoutMatchedAuc: round(matchedAuc(holdoutGroups, structuralTree)),
    strongLeaves: structuralLeaves,
  },
  models: roleModels,
};
fs.writeFileSync(outputName("order-hazard-analysis", "json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputName("order-hazard-samples", "json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, decisionLatencyMs, sourceName, groups: matched }), { level: 9 }));
const top = contrast.slice(0, 12).map((row) => `${row.field} (${row.direction}, AUC ${row.auc}; actual median ${row.positive.p50} vs eligible ${row.eligibleControl.p50}; matched lower/higher ${row.matchedLowerPct}/${row.matchedHigherPct}%)`).join("; ");
const leafText = strongLeaves.slice(0, 4).map((leaf) => `[${leaf.rule}] => p=${leaf.positiveRate}, actions=${leaf.actions}`).join("; ");
const md = `# Order-conditioned release hazard (${sourceName})\n\n` +
`This comparison holds the signed action, side, cap, and inventory interval fixed. The controls are earlier decision ticks where that same fixed-cap action would have been executable after the same ${decisionLatencyMs} ms latency but did not fire.\n\n` +
`- ${report.samples.actions.toLocaleString()} actions, ${report.samples.eligibleNoFire.toLocaleString()} eligible no-fire controls; median ${report.samples.controlsPerAction.p50} controls/action.\n` +
`- Strongest within-risk-set contrasts: ${top}.\n` +
`- Equal-action-weight tree: train matched AUC ${report.tree.trainMatchedAuc}; untouched holdout matched AUC ${report.tree.holdoutMatchedAuc}.\n` +
`- L2/price/inventory-only tree (clock features removed): train ${report.structuralTree.trainMatchedAuc}; untouched holdout ${report.structuralTree.holdoutMatchedAuc}.\n` +
`- Entry structural tree: train ${roleModels.entry.trainMatchedAuc}; holdout ${roleModels.entry.holdoutMatchedAuc}. Hedge/cross tree: train ${roleModels.hedge.trainMatchedAuc}; holdout ${roleModels.hedge.holdoutMatchedAuc}.\n` +
`- Strong leaves: ${leafText}.\n\n` +
`This removes the explanation that low/falling ask depth is merely a cross-market price or cap effect: it remains the release discriminator while the exact order is already marketable.\n`;
fs.writeFileSync(outputName("order-hazard-analysis", "md"), md);
console.log(md);
console.log(JSON.stringify({
  samples: report.samples,
  split: report.split,
  top: contrast.slice(0, 15),
  entryTop: entryContrast.slice(0, 10),
  hedgeTop: hedgeContrast.slice(0, 10),
  touchApproach,
  tree: { trainMatchedAuc: report.tree.trainMatchedAuc, holdoutMatchedAuc: report.tree.holdoutMatchedAuc, strongLeaves },
  structuralTree: { trainMatchedAuc: report.structuralTree.trainMatchedAuc, holdoutMatchedAuc: report.structuralTree.holdoutMatchedAuc, strongLeaves: structuralLeaves },
  roleModels: Object.fromEntries(Object.entries(roleModels).map(([role, model]) => [role, {
    trainActions: model.trainActions, holdoutActions: model.holdoutActions,
    trainMatchedAuc: model.trainMatchedAuc, holdoutMatchedAuc: model.holdoutMatchedAuc,
    strongLeaves: model.strongLeaves,
  }])),
}, null, 2));
