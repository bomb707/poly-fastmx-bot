#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const l2Dir = path.resolve(process.argv[3] || path.join(dataDir, "feeds/v4-e8-l2"));
const v2Dir = path.resolve(process.argv[4] || path.join(dataDir, "feeds/v2"));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const firesFile = path.resolve(process.argv[8] || path.join(dataDir, "order-fires.json.gz"));
const outputSuffix = String(process.argv[9] || "").replace(/[^a-zA-Z0-9_-]/g, "");
const orderbookSource = String(process.argv[10] || (firesFile.includes("v2") ? "v2" : "v4"));
const decisionLatencyMs = Math.max(0, Number(process.env.W3048_DECISION_LATENCY_MS || 0));
const slugPrefix = String(process.env.W3048_SLUG_PREFIX || "").trim().toLowerCase();
const skipControls = /^(1|true|yes)$/i.test(String(process.env.W3048_SKIP_CONTROLS || ""));
const onlySamples = /^(1|true|yes)$/i.test(String(process.env.W3048_ONLY_SAMPLES || ""));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(firesFile))).rows;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const epochStart = Date.parse(process.argv[5] || "2026-08-21T19:55:00Z");
const epochEnd = Date.parse(process.argv[6] || "2026-08-22T17:00:00Z");
const baseSize = Number(process.argv[7] || 30);
if (!Number.isFinite(epochStart) || !Number.isFinite(epochEnd) || epochEnd <= epochStart || !Number.isFinite(baseSize) || baseSize <= 0) throw new Error("invalid start/end/base size");
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const outputName = (base, extension) => path.join(dataDir, `${base}${outputSuffix ? `-${outputSuffix}` : ""}.${extension}`);
const q = (values) => ({
  p10: round(quantile(values.filter(finite), .1), 6),
  p25: round(quantile(values.filter(finite), .25), 6),
  p50: round(quantile(values.filter(finite), .5), 6),
  p75: round(quantile(values.filter(finite), .75), 6),
  p90: round(quantile(values.filter(finite), .9), 6),
});

function exactOrderFee(order) {
  return order.settlements.reduce((sum, settlement) => settlement.role === "taker"
    ? sum + .07 * Number(settlement.vwap) * (1 - Number(settlement.vwap)) * Number(settlement.shares)
    : sum, 0);
}

const exactRows = fires.filter((row) => {
  const start = slugStart(row.slug);
  return (!slugPrefix || row.slug.toLowerCase().startsWith(slugPrefix))
    && row.confidence !== "low" && start >= epochStart && start < epochEnd && signedByHash.has(row.orderHash);
}).map((row) => {
  const order = signedByHash.get(row.orderHash);
  return { ...row, order, orderFee: exactOrderFee(order) };
});
const bySlug = new Map();
for (const row of exactRows) {
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}

// First group exact on-chain order hashes, then attach their independently
// inferred v4 release. Orders of the same side released within 300 ms form one
// observable action. This prevents duplicated menu branches from masquerading
// as independent signal decisions.
const actionBySlug = new Map();
for (const [slug, rows] of bySlug) {
  const ordered = [...rows].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const actions = [];
  let batch = [];
  function finish() {
    if (!batch.length) return;
    const filledShares = batch.reduce((sum, row) => sum + Number(row.order.filledShares), 0);
    const allInCost = batch.reduce((sum, row) => sum + Number(row.order.filledUsd) + Number(row.orderFee), 0);
    actions.push({
      slug,
      outcome: batch[0].outcome,
      fireMs: Math.min(...batch.map((row) => row.fireMs)),
      intervalStartMs: Math.min(...batch.map((row) => row.intervalStartMs)),
      intervalEndMs: Math.max(...batch.map((row) => row.intervalEndMs)),
      exactOrders: batch.length,
      orderHashes: batch.map((row) => row.orderHash),
      signedSizes: batch.map((row) => Number(row.signedShares)),
      signedShares: batch.reduce((sum, row) => sum + Number(row.signedShares), 0),
      filledShares,
      effectivePrice: filledShares ? allInCost / filledShares : null,
      methods: [...new Set(batch.map((row) => row.method))],
    });
  }
  for (const row of ordered) {
    if (batch.length && (row.outcome !== batch[0].outcome || row.fireMs - batch.at(-1).fireMs > 300)) {
      finish();
      batch = [];
    }
    batch.push(row);
  }
  finish();
  actionBySlug.set(slug, actions);
}

function readL2(slug) {
  const file = path.join(l2Dir, `${slug}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const v2File = path.join(v2Dir, `${slug}.json.gz`);
  if (fs.existsSync(v2File)) {
    const rtds = JSON.parse(zlib.gunzipSync(fs.readFileSync(v2File)));
    feed.openChainlink = Number(rtds.openChainlink);
    let cursor = -1, current = null;
    for (const tick of feed.ticks) {
      while (cursor + 1 < rtds.ticks.length && rtds.ticks[cursor + 1].ms <= tick.ms) {
        cursor++;
        if (Number(rtds.ticks[cursor].cl) > 0) current = Number(rtds.ticks[cursor].cl);
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

function bookAt(tick, side) { return side === "Up" ? tick?.up : tick?.down; }
function bestAsk(tick, side) { return Number(bookAt(tick, side)?.asks?.[0]?.price); }
function bestBid(tick, side) { return Number(bookAt(tick, side)?.bids?.[0]?.price); }
function depth(levels, count = 3) { return (levels || []).slice(0, count).reduce((sum, level) => sum + Number(level.size), 0); }
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

function addInventory(state, action) {
  const side = action.outcome, opposite = side === "Up" ? "Down" : "Up";
  let left = Number(action.filledShares);
  while (left > 1e-9 && state.lots[opposite].length) {
    const lot = state.lots[opposite][0], take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    if (lot.shares <= 1e-9) state.lots[opposite].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice: Number(action.effectivePrice) });
  if (side === "Up") state.up += Number(action.filledShares); else state.down += Number(action.filledShares);
  state.lastFireMs = action.fireMs;
  state.lastSideMs[side] = action.fireMs;
}

function featureAt(feed, index, side, state, queryMs = null) {
  if (index < 0) return null;
  const tick = feed.ticks[index], sideSign = side === "Up" ? 1 : -1, opposite = side === "Up" ? "Down" : "Up";
  const book = bookAt(tick, side), otherBook = bookAt(tick, opposite);
  const ask = bestAsk(tick, side), bid = bestBid(tick, side), otherAsk = bestAsk(tick, opposite);
  if (!Number.isFinite(ask) || !Number.isFinite(bid)) return null;
  const askDepth1 = depth(book.asks, 1), bidDepth1 = depth(book.bids, 1);
  const askDepth3 = depth(book.asks, 3), bidDepth3 = depth(book.bids, 3);
  const imbalance = state.up - state.down, orientedInventory = imbalance * sideSign;
  const lotCost = orientedInventory < -1e-9 ? firstLotCost(state.lots[opposite], Math.min(30, Math.abs(imbalance))) : null;
  const features = {
    timeS: (tick.ms - slugStart(feed.slug)) / 1000,
    ask,
    spread: ask - bid,
    pairAsk: ask + otherAsk,
    askDepth1,
    bidDepth1,
    askDepth3,
    bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(1e-9, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(1e-9, bidDepth3 + askDepth3),
    topAskShareOfDepth3: askDepth1 / Math.max(1e-9, askDepth3),
    micropriceBias: (bidDepth1 * ask + askDepth1 * bid) / Math.max(1e-9, bidDepth1 + askDepth1) - (ask + bid) / 2,
    orientedInventory,
    absoluteInventory: Math.abs(imbalance),
    isHedge: orientedInventory < -1e-9 ? 1 : 0,
    fifoPairCost: lotCost == null ? null : lotCost + ask + .07 * ask * (1 - ask),
    sinceLastFireS: Number.isFinite(state.lastFireMs) ? (tick.ms - state.lastFireMs) / 1000 : 300,
    sinceSameSideFireS: Number.isFinite(state.lastSideMs[side]) ? (tick.ms - state.lastSideMs[side]) / 1000 : 300,
    observationAgeMs: Math.max(0, Number(queryMs ?? tick.ms) - tick.ms),
  };
  const previous = feed.ticks[index - 1];
  features.sideAskTickMove = Number.isFinite(bestAsk(previous, side)) ? ask - bestAsk(previous, side) : null;
  features.sideBidTickMove = Number.isFinite(bestBid(previous, side)) ? bid - bestBid(previous, side) : null;
  for (const [label, lookbackMs] of [["100ms", 100], ["250ms", 250], ["500ms", 500], ["1", 1_000], ["3", 3_000], ["5", 5_000], ["10", 10_000]]) {
    const prior = feed.ticks[indexAtOrBefore(feed.ticks, tick.ms - lookbackMs)];
    const priorAsk = bestAsk(prior, side), priorBid = bestBid(prior, side);
    const priorBook = bookAt(prior, side);
    features[`sideAskMove${label}`] = Number.isFinite(priorAsk) ? ask - priorAsk : null;
    features[`sideBidMove${label}`] = Number.isFinite(priorBid) ? bid - priorBid : null;
    features[`askDepth3Change${label}`] = priorBook ? askDepth3 - depth(priorBook.asks, 3) : null;
    features[`bidDepth3Change${label}`] = priorBook ? bidDepth3 - depth(priorBook.bids, 3) : null;
    features[`bzMove${label}`] = Number(tick.bz) > 0 && Number(prior?.bz) > 0 ? (Number(tick.bz) - Number(prior.bz)) / Number(prior.bz) * 100 * sideSign : null;
    features[`clMove${label}`] = Number(tick.cl) > 0 && Number(prior?.cl) > 0 ? (Number(tick.cl) - Number(prior.cl)) / Number(prior.cl) * 100 * sideSign : null;
  }
  features.sideAskAccel500ms = finite(features.sideAskMove500ms) && finite(features.sideAskMove1)
    ? 2 * features.sideAskMove500ms - features.sideAskMove1 : null;
  features.sideBidAccel500ms = finite(features.sideBidMove500ms) && finite(features.sideBidMove1)
    ? 2 * features.sideBidMove500ms - features.sideBidMove1 : null;
  features.bzAccel500ms = finite(features.bzMove500ms) && finite(features.bzMove1)
    ? 2 * features.bzMove500ms - features.bzMove1 : null;
  features.bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0 ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 * sideSign : null;
  features.clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0 ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 * sideSign : null;
  return features;
}

const positives = [], negatives = [], actionRows = [];
for (const [slug, actions] of actionBySlug) {
  const feed = readL2(slug);
  if (!feed?.ticks?.length) continue;
  const ordered = [...actions].sort((a, b) => a.fireMs - b.fireMs);
  const positiveState = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
  for (const action of ordered) {
    const sign = action.outcome === "Up" ? 1 : -1;
    action.contains90 = action.signedSizes.includes(90);
    action.containsLarge = action.signedSizes.some((size) => Math.abs(Number(size) - 3 * baseSize) < .01);
    const decisionMs = action.fireMs - decisionLatencyMs;
    const decisionState = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
    for (const prior of ordered) {
      if (prior === action || prior.fireMs > decisionMs) break;
      addInventory(decisionState, prior);
    }
    const before = decisionState.up - decisionState.down;
    const oriented = before * sign;
    const after = before + sign * Number(action.filledShares);
    action.role = oriented >= -1e-9 ? "entry/topup" : after * sign > 1e-9 ? "overhedge-cross" : "hedge";
    const feature = featureAt(feed, indexAtOrBefore(feed.ticks, decisionMs), action.outcome, decisionState, decisionMs);
    if (feature) positives.push({ slug, ms: decisionMs, fillMs: action.fireMs, side: action.outcome, label: 1, role: action.role, contains90: action.contains90, containsLarge: action.containsLarge, ...feature });
    actionRows.push({ ...action, decisionMs, decisionLatencyMs, beforeImbalance: before, afterImbalance: after });
    addInventory(positiveState, action);
  }

  if (skipControls) continue;
  const negativeState = { up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity } };
  let actionCursor = 0, lastBucket = -1;
  for (let index = 0; index < feed.ticks.length; index++) {
    const tick = feed.ticks[index], t = (tick.ms - slugStart(slug)) / 1000;
    while (actionCursor < ordered.length && ordered[actionCursor].fireMs <= tick.ms) addInventory(negativeState, ordered[actionCursor++]);
    if (t < 4 || t > 270) continue;
    const bucket = Math.floor(t);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    for (const side of ["Up", "Down"]) {
      if (ordered.some((action) => action.outcome === side && Math.abs(action.fireMs - decisionLatencyMs - tick.ms) <= 500)) continue;
      const feature = featureAt(feed, index, side, negativeState);
      if (feature) negatives.push({ slug, ms: tick.ms, side, label: 0, role: feature.isHedge ? "hedge" : "entry/topup", contains90: false, containsLarge: false, ...feature });
    }
  }
}

if (onlySamples) {
  fs.writeFileSync(outputName("fire-actions", "json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, orderbookSource, rows: actionRows }), { level: 9 }));
  async function* sampleNdjsonChunks() {
    yield JSON.stringify({ kind: "meta", schema: 1, orderbookSource }) + "\n";
    for (let index = 0; index < positives.length; index += 500) {
      yield positives.slice(index, index + 500).map((row) => JSON.stringify({ kind: "positive", ...row })).join("\n") + "\n";
    }
    for (let index = 0; index < negatives.length; index += 500) {
      yield negatives.slice(index, index + 500).map((row) => JSON.stringify({ kind: "control", ...row })).join("\n") + "\n";
    }
  }
  await pipeline(Readable.from(sampleNdjsonChunks()), zlib.createGzip({ level: 6 }), fs.createWriteStream(outputName("fire-gate-samples", "ndjson.gz")));
  console.log(JSON.stringify({ onlySamples: true, positives: positives.length, controls: negatives.length }));
  process.exit(0);
}

const featureNames = Object.keys(positives[0] || {}).filter((key) => !["slug", "ms", "fillMs", "side", "label", "role", "contains90", "containsLarge"].includes(key));
function auc(positive, negative, field) {
  const rows = [...positive.map((row) => ({ value: Number(row[field]), positive: true })), ...negative.map((row) => ({ value: Number(row[field]), positive: false }))]
    .filter((row) => Number.isFinite(row.value)).sort((a, b) => a.value - b.value);
  const positiveCount = rows.filter((row) => row.positive).length, negativeCount = rows.length - positiveCount;
  if (!positiveCount || !negativeCount) return null;
  let rankSum = 0;
  for (let index = 0; index < rows.length;) {
    let end = index + 1;
    while (end < rows.length && rows[end].value === rows[index].value) end++;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (rows[cursor].positive) rankSum += averageRank;
    index = end;
  }
  return (rankSum - positiveCount * (positiveCount + 1) / 2) / (positiveCount * negativeCount);
}

function contrast(positive, negative) {
  return featureNames.map((field) => {
    const positiveValues = positive.map((row) => row[field]).filter(finite).map(Number);
    const negativeValues = negative.map((row) => row[field]).filter(finite).map(Number);
    const rawAuc = auc(positive, negative, field);
    return {
      field,
      positives: positiveValues.length,
      negatives: negativeValues.length,
      positive: q(positiveValues),
      control: q(negativeValues),
      auc: round(rawAuc, 6),
      separation: rawAuc == null ? null : round(Math.abs(rawAuc - .5) * 2, 6),
      positiveDirection: rawAuc == null ? null : rawAuc >= .5 ? "higher" : "lower",
    };
  }).sort((a, b) => Number(b.separation || 0) - Number(a.separation || 0));
}

const allContrast = contrast(positives, negatives);
const entryContrast = contrast(positives.filter((row) => row.role === "entry/topup"), negatives.filter((row) => row.role === "entry/topup"));
const hedgeContrast = contrast(positives.filter((row) => row.role !== "entry/topup"), negatives.filter((row) => row.role === "hedge"));
const sizeContrast = contrast(positives.filter((row) => row.contains90), positives.filter((row) => !row.contains90));
const largeContrast = contrast(positives.filter((row) => row.containsLarge), positives.filter((row) => !row.containsLarge));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  orderbookSource,
  decisionLatencyMs,
  slugPrefix: slugPrefix || null,
  skipControls,
  fireInferenceFile: firesFile,
  method: `exact on-chain hashes -> same-side 300ms action groups -> full-${orderbookSource} L2 features at inferred fill minus ${decisionLatencyMs}ms; one-second no-fire controls use the target's reconstructed completed inventory state`,
  grouping: {
    exactHighMediumOrders: exactRows.length,
    actionGroups: actionRows.length,
    multiOrderActions: actionRows.filter((row) => row.exactOrders > 1).length,
    multiOrderActionPct: pct(actionRows.filter((row) => row.exactOrders > 1).length, actionRows.length),
    exactOrdersPerAction: q(actionRows.map((row) => row.exactOrders)),
    signedSharesPerAction: q(actionRows.map((row) => row.signedShares)),
    filledSharesPerAction: q(actionRows.map((row) => row.filledShares)),
    roles: {
      entry: actionRows.filter((row) => row.role === "entry/topup").length,
      hedge: actionRows.filter((row) => row.role === "hedge").length,
      overhedgeCross: actionRows.filter((row) => row.role === "overhedge-cross").length,
    },
    actionsContaining90: actionRows.filter((row) => row.contains90).length,
    actionsContainingLarge: actionRows.filter((row) => row.containsLarge).length,
  },
  samples: { positives: positives.length, controls: negatives.length },
  contrasts: { all: allContrast, entry: entryContrast, hedge: hedgeContrast, size90Vs30: sizeContrast, largeVsBase: largeContrast },
};
fs.writeFileSync(outputName("fire-gate-analysis", "json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputName("fire-actions", "json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, orderbookSource, rows: actionRows }), { level: 9 }));
fs.writeFileSync(outputName("fire-gate-samples", "json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, orderbookSource, positives, controls: negatives }), { level: 9 }));
const top = (rows, count = 10) => rows.slice(0, count).map((row) => `${row.field} (${row.positiveDirection}, AUC ${row.auc}; median ${row.positive.p50} vs ${row.control.p50})`).join("; ");
const md = `# Grouped-action fire gates (${orderbookSource})\n\n` +
`${report.grouping.exactHighMediumOrders.toLocaleString()} exact high/medium signed orders collapse to ${report.grouping.actionGroups.toLocaleString()} same-side 300 ms actions; ${report.grouping.multiOrderActionPct}% contain multiple exact hashes. Fire remains independently timed from ${orderbookSource} transitions.\n\n` +
`One-second no-fire controls are sampled from the same 250 markets and evaluated with the wallet's reconstructed inventory state. Univariate AUC measures discrimination, not causation or a complete formula.\n\n` +
`- Strongest all-action contrasts: ${top(allContrast)}.\n` +
`- Strongest entry contrasts: ${top(entryContrast)}.\n` +
`- Strongest hedge contrasts: ${top(hedgeContrast)}.\n` +
`- Strongest 90-vs-30 action contrasts: ${top(sizeContrast)}.\n`;
fs.writeFileSync(outputName("fire-gate-analysis", "md"), md);
console.log(md);
console.log(JSON.stringify({ grouping: report.grouping, samples: report.samples, top: { all: allContrast.slice(0, 12), entry: entryContrast.slice(0, 12), hedge: hedgeContrast.slice(0, 12), size90Vs30: sizeContrast.slice(0, 12) } }, null, 2));
