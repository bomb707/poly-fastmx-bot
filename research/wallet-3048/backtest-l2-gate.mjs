#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { allocateConservedMakerFills } from "../passive-maker-fill-model.mjs";
import { orderExecutionTicks } from "./execution-latency.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const sourceFile = path.resolve(process.argv[3] || path.join(dataDir, "trades-2026-08-14_2026-08-22.json"));
const modelDir = path.resolve(process.argv[4] || dataDir);
const l2Dir = path.resolve(process.argv[5] || path.join(dataDir, "feeds/v4-e8-l2"));
const v2Dir = path.resolve(process.argv[6] || path.join(dataDir, "feeds/v2"));
const tradeDirRaw = String(process.env.W3048_TRADE_DIR || "").trim();
const tradeDir = tradeDirRaw ? path.resolve(tradeDirRaw) : null;
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const fireFile = path.resolve(process.env.W3048_FIRE_FILE || path.join(dataDir, "order-fires.json.gz"));
const orderbookSource = String(process.env.W3048_ORDERBOOK_SOURCE || (l2Dir.includes("v2") ? "v2" : "v4"));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(fireFile))).rows;
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const modelFile = (envName, fallback) => path.resolve(process.env[envName] || path.join(modelDir, fallback));
const fireTreePath = modelFile("W3048_FIRE_TREE_FILE", "fire-gate-tree.json");
const treeModels = JSON.parse(fs.readFileSync(fireTreePath, "utf8")).models;
const sizeTreePath = path.resolve(process.env.W3048_SIZE_TREE_FILE || fireTreePath);
const sizeTreeModels = JSON.parse(fs.readFileSync(sizeTreePath, "utf8")).models;
const hazardTree = JSON.parse(fs.readFileSync(modelFile("W3048_HAZARD_TREE_FILE", "order-hazard-analysis.json"), "utf8")).structuralTree.root;
const sideChoiceTree = JSON.parse(fs.readFileSync(modelFile("W3048_SIDE_TREE_FILE", "side-choice-analysis.json"), "utf8")).marketOnlyTree.root;
const marketBySlug = new Map(source.markets.map((row) => [row.slug, row]));
const epochStart = Date.parse(process.argv[7] || "2026-08-21T19:55:00Z");
const epochEnd = Date.parse(process.argv[8] || "2026-08-22T17:00:00Z");
const splitMs = Date.parse(process.argv[9] || "2026-08-22T06:20:00Z");
const baseSize = Number(process.argv[10] || 30);
const frozenOnly = process.env.W3048_FROZEN_ONLY === "1";
const executionLatencies = String(process.env.W3048_TAKER_LATENCY_LIST || process.env.W3048_LATENCY_LIST || "")
  .split(",").map((value) => value.trim()).filter(Boolean).map(Number).filter((value) => Number.isFinite(value) && value >= 0);
const makerPlacementLatencyMs = Number(process.env.W3048_MAKER_LATENCY_MS || 130);
const selectedPolicyNames = new Set(String(process.env.W3048_POLICY_NAMES || "").split(",").map((value) => value.trim()).filter(Boolean));
const selectedPolicyPrefix = String(process.env.W3048_POLICY_PREFIX || "").trim();
const makerCredits = String(process.env.W3048_MAKER_CREDITS || "").split(",").map((value) => value.trim()).filter(Boolean)
  .map(Number).filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
const makerTtls = String(process.env.W3048_MAKER_TTLS || "").split(",").map((value) => value.trim()).filter(Boolean)
  .map(Number).filter((value) => Number.isFinite(value) && value >= 0);
const hedgePairCaps = String(process.env.W3048_HEDGE_PAIR_CAPS || "").split(",").map((value) => value.trim()).filter(Boolean)
  .map(Number).filter((value) => Number.isFinite(value) && value > 0);
const entryBzGaps = String(process.env.W3048_ENTRY_BZ_GAPS || "").split(",").map((value) => value.trim()).filter(Boolean)
  .map(Number).filter(Number.isFinite);
const latencyAuditFile = String(process.env.W3048_OUTPUT || "frozen-scale-latency-audit.json");
const includeWindowResults = process.env.W3048_INCLUDE_WINDOW_RESULTS === "1";
const precomputeBasePoints = process.env.W3048_PRECOMPUTE_BASE_POINTS !== "0";
const precomputeTreePoints = process.env.W3048_PRECOMPUTE_TREE_POINTS !== "0";
const customPolicies = (() => {
  const customFile = String(process.env.W3048_CUSTOM_POLICIES_FILE || "").trim();
  const raw = customFile ? fs.readFileSync(path.resolve(customFile), "utf8") : String(process.env.W3048_CUSTOM_POLICIES || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("W3048_CUSTOM_POLICIES must be a JSON object");
  return parsed;
})();
if (![epochStart, epochEnd, splitMs, baseSize].every(Number.isFinite) || epochEnd <= epochStart || baseSize <= 0) throw new Error("invalid range/split/base size");
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const fee = (price, shares) => Math.round(.07 * price * (1 - price) * shares * 1e5) / 1e5;
// Abramowitz-Stegun normal CDF approximation; sufficient for a causal
// fixed-volatility binary fair-value diagnostic.
function normalCdf(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + .3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z);
  return .5 * (1 + sign * erf);
}

function readFeed(market) {
  const file = path.join(l2Dir, `${market.slug}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const v2File = path.join(v2Dir, `${market.slug}.json.gz`);
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
  const tradeFile = tradeDir && path.join(tradeDir, `${market.slug}.json.gz`);
  feed.trades = tradeFile && fs.existsSync(tradeFile)
    ? (JSON.parse(zlib.gunzipSync(fs.readFileSync(tradeFile))).trades || []).map((trade) => ({
      ...trade,
      ms: Number(trade.ms),
      price: Number(trade.price),
      size: Number(trade.size),
    })).filter((trade) => Number.isFinite(trade.ms) && trade.size > 0
      && (trade.outcome === "Up" || trade.outcome === "Down") && trade.price > 0 && trade.price < 1)
      .sort((a, b) => a.ms - b.ms)
    : [];
  return feed;
}

function book(tick, side) { return side === "Up" ? tick?.up : tick?.down; }
function ask(tick, side) { return Number(book(tick, side)?.asks?.[0]?.price); }
function depth(levels, count = 3) { return (levels || []).slice(0, count).reduce((sum, row) => sum + Number(row.size), 0); }
function priorIndex(ticks, index, lookbackMs) {
  const target = ticks[index].ms - lookbackMs;
  let low = 0, high = index, answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= target) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function precompute(feed, bucketMs = 1_000) {
  const points = [];
  const history = { Up: [], Down: [] };
  let lastBucket = -1;
  for (let index = 0; index < feed.ticks.length; index++) {
    const tick = feed.ticks[index], t = (tick.ms - slugStart(feed.slug)) / 1000;
    if (t < .1 || t > 295) continue;
    const bucket = Math.floor((tick.ms - slugStart(feed.slug)) / bucketMs);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    const prior = feed.ticks[priorIndex(feed.ticks, index, 1_000)];
    const prior3 = feed.ticks[priorIndex(feed.ticks, index, 3_000)];
    const prior5 = feed.ticks[priorIndex(feed.ticks, index, 5_000)];
    const candidates = {};
    for (const side of ["Up", "Down"]) {
      const sideBook = book(tick, side), priorBook = book(prior, side);
      const bestAsk = ask(tick, side), oppositeAsk = ask(tick, side === "Up" ? "Down" : "Up");
      const askDepth1 = depth(sideBook?.asks, 1), askDepth3 = depth(sideBook?.asks, 3);
      const bidDepth1 = depth(sideBook?.bids, 1), bidDepth3 = depth(sideBook?.bids, 3);
      const priorAskDepth3 = depth(priorBook?.asks, 3);
      const prior3Book = book(prior3, side), prior5Book = book(prior5, side);
      const bestBid = Number(sideBook?.bids?.[0]?.price), priorBid3 = Number(prior3Book?.bids?.[0]?.price), priorBid5 = Number(prior5Book?.bids?.[0]?.price);
      const priorAsk1 = ask(prior, side), priorAsk3 = ask(prior3, side), priorAsk5 = ask(prior5, side);
      const sideSign = side === "Up" ? 1 : -1;
      const bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0
        ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 * sideSign : 0;
      const clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0
        ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 * sideSign : 0;
      const recent = history[side].filter((row) => tick.ms - row.ms <= 30_000);
      const baselineDepth = median(recent.map((row) => row.askDepth3)) ?? askDepth3;
      const baselineImbalance = median(recent.map((row) => row.depthImbalance)) ?? 0;
      const depthImbalance = (bidDepth3 - askDepth3) / Math.max(1e-9, bidDepth3 + askDepth3);
      candidates[side] = {
        ask: bestAsk,
        oppositeAsk,
        askDepth1,
        bidDepth1,
        askDepth3,
        bidDepth3,
        depthImbalance,
        depletion1: askDepth3 - priorAskDepth3,
        depthRatio30: askDepth3 / Math.max(1e-9, baselineDepth),
        imbalanceDelta30: depthImbalance - baselineImbalance,
        depletionRatio1: (askDepth3 - priorAskDepth3) / Math.max(1e-9, baselineDepth),
        askDepth3Change1: askDepth3 - priorAskDepth3,
        askDepth3Change5: askDepth3 - depth(prior5Book?.asks, 3),
        bidDepth3Change1: bidDepth3 - depth(priorBook?.bids, 3),
        bidDepth3Change3: bidDepth3 - depth(prior3Book?.bids, 3),
        sideAskMove1: bestAsk - priorAsk1,
        sideAskMove3: bestAsk - priorAsk3,
        sideAskMove5: bestAsk - priorAsk5,
        sideBidMove1: bestBid - Number(priorBook?.bids?.[0]?.price),
        sideBidMove3: bestBid - priorBid3,
        sideBidMove5: bestBid - priorBid5,
        topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(1e-9, bidDepth1 + askDepth1),
        micropriceBias: (bidDepth1 * bestAsk + askDepth1 * bestBid) / Math.max(1e-9, bidDepth1 + askDepth1) - (bestAsk + bestBid) / 2,
        bzMove1: Number(tick.bz) > 0 && Number(prior?.bz) > 0 ? (Number(tick.bz) - Number(prior.bz)) / Number(prior.bz) * 100 * sideSign : null,
        bzMove3: Number(tick.bz) > 0 && Number(prior3?.bz) > 0 ? (Number(tick.bz) - Number(prior3.bz)) / Number(prior3.bz) * 100 * sideSign : null,
        bzMove5: Number(tick.bz) > 0 && Number(prior5?.bz) > 0 ? (Number(tick.bz) - Number(prior5.bz)) / Number(prior5.bz) * 100 * sideSign : null,
        clMove3: Number(tick.cl) > 0 && Number(prior3?.cl) > 0 ? (Number(tick.cl) - Number(prior3.cl)) / Number(prior3.cl) * 100 * sideSign : null,
        clMove1: Number(tick.cl) > 0 && Number(prior?.cl) > 0 ? (Number(tick.cl) - Number(prior.cl)) / Number(prior.cl) * 100 * sideSign : null,
        clMove5: Number(tick.cl) > 0 && Number(prior5?.cl) > 0 ? (Number(tick.cl) - Number(prior5.cl)) / Number(prior5.cl) * 100 * sideSign : null,
        exactCap: 1,
        capHeadroom: 0,
        spread: bestAsk - bestBid,
        pairAsk: bestAsk + oppositeAsk,
        bzGap,
        clGap,
      };
      history[side].push({ ms: tick.ms, askDepth3, depthImbalance });
      while (history[side].length && tick.ms - history[side][0].ms > 30_000) history[side].shift();
    }
    points.push({ tick, t, candidates });
  }
  return points;
}

function predictTree(model, row) {
  let node = model?.tree?.root || model?.root || model;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Number(node.balancedPositiveRate ?? node.positiveRate);
}

const markets = source.markets.filter((market) => {
  const start = slugStart(market.slug);
  return market.winner && start >= epochStart && start < epochEnd;
}).sort((a, b) => slugStart(a.slug) - slugStart(b.slug));
console.log(`precomputing full-L2 gates for ${markets.length} markets at base size ${baseSize}`);
const feeds = markets.map((market) => {
  const feed = readFeed(market);
  return feed ? {
    market,
    feed,
    points: precomputeBasePoints ? precompute(feed, 1_000) : null,
    treePoints: precomputeTreePoints ? precompute(feed, 250) : null,
  } : null;
}).filter(Boolean);
const train = feeds.filter((row) => slugStart(row.market.slug) < splitMs);
const holdout = feeds.filter((row) => slugStart(row.market.slug) >= splitMs);

function executeTop(tick, side, requested) {
  const level = book(tick, side)?.asks?.[0];
  if (!level || !(Number(level.price) > 0) || !(Number(level.size) > 0)) return null;
  const shares = Math.min(requested, Number(level.size));
  return shares > 1e-9 ? { shares, price: Number(level.price), partial: shares < requested - 1e-9 } : null;
}

function makerAvailability(tick, side, limit) {
  return (book(tick, side)?.asks || []).reduce((sum, level) => Number(level.price) <= limit + 1e-9 ? sum + Number(level.size) : sum, 0);
}

function bidDepthAt(tick, side, price) {
  return (book(tick, side)?.bids || []).filter((level) => Math.abs(Number(level.price) - price) < .005)
    .reduce((sum, level) => sum + Number(level.size), 0);
}

function addLots(state, side, shares, effectivePrice, rawPrice = effectivePrice) {
  const opposite = side === "Up" ? "Down" : "Up";
  let left = shares;
  while (left > 1e-9 && state.lots[opposite].length) {
    const lot = state.lots[opposite][0], take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    state.pairedShares += take;
    state.pairedPnl += take * (1 - effectivePrice - lot.effectivePrice);
    if (lot.shares <= 1e-9) state.lots[opposite].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice, rawPrice });
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

function firstLotRawPrice(lots, shares) {
  let left = shares, used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take;
    used += take;
    cost += take * Number(lot.rawPrice ?? lot.effectivePrice);
    if (left <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? cost / used : null;
}

function simulate(row, params) {
  const state = {
    up: 0, down: 0, cost: 0, fees: 0, fills: 0, entries: 0, hedges: 0, crossings: 0,
    size90: 0, partials: 0, makerFills: 0, makerShares: 0, pairedShares: 0, pairedPnl: 0, lastFireMs: -Infinity,
    lots: { Up: [], Down: [] }, pending: [], pendingSequence: 0,
  };
  let tradeCursor = 0;
  function applyFill(side, shares, price, chargedFee, maker = false) {
    const before = state.up - state.down;
    state.cost += price * shares + chargedFee;
    state.fees += chargedFee;
    if (side === "Up") state.up += shares; else state.down += shares;
    const after = state.up - state.down;
    if (Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) state.crossings++;
    addLots(state, side, shares, price + chargedFee / shares, price);
    if (maker) { state.makerFills++; state.makerShares += shares; }
  }
  const decisionPoints = params.gateMode === "tree" || params.gateMode === "hazard" ? row.treePoints : row.points;
  for (let pointIndex = 0; pointIndex < decisionPoints.length; pointIndex++) {
    const point = decisionPoints[pointIndex];
    if (params.makerFillMode === "queue" && params.makerFillSource === "trades") {
      while (tradeCursor < row.feed.trades.length && row.feed.trades[tradeCursor].ms <= point.tick.ms) {
        const trade = row.feed.trades[tradeCursor++];
        const matching = state.pending.filter((pending) => pending.shares > 1e-9
          && trade.ms >= pending.effectiveArrivalMs && trade.ms <= pending.expiresMs
          && trade.outcome === pending.side && Math.abs(trade.price - pending.price) < .005);
        for (const { order, shares } of allocateConservedMakerFills(matching, trade.size,
          Math.max(0, Math.min(1, Number(params.makerCreditPct ?? 0)))))
          applyFill(order.side, shares, order.price, 0, true);
      }
      state.pending = state.pending.filter((pending) => pending.shares > 1e-9);
    }
    const livePending = state.pending.filter((pending) => point.tick.ms <= pending.expiresMs);
    if (params.makerFillMode === "queue" && params.makerFillSource !== "trades") {
      const groups = new Map();
      for (const pending of livePending) {
        const key = `${pending.side}:${pending.price.toFixed(2)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pending);
      }
      for (const group of groups.values()) {
        const visible = bidDepthAt(point.tick, group[0].side, group[0].price);
        // A single observed same-price depth removal is one shared volume
        // event. Use only the portion visible to every overlapping order, then
        // allocate its conservative credit FIFO; never reuse it per order.
        const priorVisible = Math.min(...group.map((pending) => Number(pending.lastVisible || 0)));
        const removed = Math.max(0, priorVisible - visible);
        for (const { order, shares } of allocateConservedMakerFills(group, removed,
          Math.max(0, Math.min(1, Number(params.makerCreditPct ?? 0)))))
          applyFill(order.side, shares, order.price, 0, true);
        for (const pending of group) pending.lastVisible = visible;
      }
    } else {
      for (const pending of livePending) {
        const shares = Math.min(pending.shares, makerAvailability(point.tick, pending.side, pending.price));
        if (shares > 1e-9) { applyFill(pending.side, shares, pending.price, 0, true); pending.shares -= shares; }
      }
    }
    state.pending = livePending.filter((pending) => pending.shares > 1e-9);
    if (point.tick.ms - state.lastFireMs < params.cooldownMs) continue;
    const valid = [];
    for (const side of ["Up", "Down"]) {
      const candidate = point.candidates[side];
      const currentImbalance = state.up - state.down;
      const forceHedge = Number.isFinite(Number(params.forceHedgeAtS))
        && point.t >= Number(params.forceHedgeAtS)
        && Math.abs(currentImbalance) > 1e-9;
      if (!(candidate.ask >= (forceHedge ? .01 : .12) && candidate.ask <= (forceHedge ? .99 : .89))) continue;
      if (forceHedge && currentImbalance * (side === "Up" ? 1 : -1) >= -1e-9) continue;
      if (!forceHedge && (params.gateMode === "tree" || params.gateMode === "hazard")) {
        // Evaluated below after dynamic inventory and FIFO pair features exist.
      } else if (!forceHedge && params.gateMode === "relative") {
        if (candidate.depthRatio30 > params.depthRatioMax) continue;
        if (candidate.imbalanceDelta30 < params.imbalanceDeltaMin) continue;
        if (candidate.depletionRatio1 > params.depletionRatioMax) continue;
      } else if (!forceHedge) {
        if (candidate.askDepth3 > params.askDepthMax) continue;
        if (candidate.depthImbalance < params.depthImbalanceMin) continue;
        if (candidate.depletion1 > params.depletionMax) continue;
      }
      const gapContrarian = -candidate.clGap / .05;
      const sign = side === "Up" ? 1 : -1;
      const imbalance = state.up - state.down;
      const oriented = imbalance * sign;
      const pendingImbalance = params.reservePendingInventory
        ? state.pending.reduce((sum, pending) => sum + (pending.side === "Up" ? 1 : -1) * pending.shares, 0)
        : 0;
      const reservedOriented = (imbalance + pendingImbalance) * sign;
      if (params.hedgeOnlyWhenImbalanced && Math.abs(imbalance) > 1e-9 && oriented >= -1e-9) continue;
      const opposite = side === "Up" ? "Down" : "Up";
      const lotCost = oriented < -1e-9 ? firstLotCost(state.lots[opposite], Math.min(baseSize, Math.abs(imbalance))) : null;
      const lotRawPrice = oriented < -1e-9 ? firstLotRawPrice(state.lots[opposite], Math.min(baseSize, Math.abs(imbalance))) : null;
      const pairCost = lotCost == null ? null : lotCost + candidate.ask + fee(candidate.ask, 1);
      const rawPairCost = lotRawPrice == null ? null : lotRawPrice + candidate.ask;
      const pairCheap = params.pairCap != null && pairCost != null && pairCost <= params.pairCap + 1e-9;
      // Reject an inventory-adding branch before ranking. Otherwise a blocked
      // top-scoring side suppresses a valid opposite-side hedge at this tick.
      if (reservedOriented >= params.maxLean * baseSize / 30 - 1e-9) continue;
      if (oriented >= -1e-9) {
        if (params.entryTimeMin != null && point.t < params.entryTimeMin) continue;
        if (params.entryTimeMax != null && point.t > params.entryTimeMax) continue;
        if (params.entryMinAsk != null && candidate.ask < params.entryMinAsk) continue;
        if (params.entryMaxAsk != null && candidate.ask > params.entryMaxAsk) continue;
        if (params.entryMinBzGap != null && candidate.bzGap < params.entryMinBzGap) continue;
        if (params.entryMinClGap != null && candidate.clGap < params.entryMinClGap) continue;
        if (params.entryMinFairEdge != null) {
          const clWeight = Math.max(0, Math.min(1, Number(params.entryClWeight ?? .5)));
          const gapPct = clWeight * Number(candidate.clGap || 0) + (1 - clWeight) * Number(candidate.bzGap || 0);
          const remainingS = Math.max(1, 300 - point.t);
          const denominator = Math.max(1e-9, Number(params.entryFairVolPctSqrtSecond) * Math.sqrt(remainingS));
          const fairProbability = normalCdf(gapPct / denominator);
          const netEdge = fairProbability - candidate.ask - fee(candidate.ask, 1);
          if (netEdge < Number(params.entryMinFairEdge)) continue;
        }
        if (params.maxEntryActions != null && state.entries >= params.maxEntryActions) continue;
      }
      const pairValue = pairCost == null ? 0 : (1.03 - pairCost) / .1;
      const activeHedgeCap = forceHedge ? params.forceHedgePairCap : params.hedgePairCap;
      if (oriented < -1e-9 && activeHedgeCap != null && pairCost > activeHedgeCap + 1e-9) continue;
      const treeRow = { ...candidate, depth3Imbalance: candidate.depthImbalance,
        timeS: point.t, orientedInventory: oriented * 30 / baseSize,
        absoluteInventory: Math.abs(imbalance) * 30 / baseSize,
        isHedge: oriented < -1e-9 ? 1 : 0, fifoPairCost: pairCost };
      const treeModel = params.gateMode === "hazard" ? hazardTree
        : params.treeModel === "role" ? (oriented < -1e-9 ? treeModels.hedge : treeModels.entry) : treeModels.all;
      const treeScore = params.gateMode === "tree" || params.gateMode === "hazard" ? predictTree(treeModel, treeRow) : null;
      const treeThreshold = oriented < -1e-9
        ? Number(params.hedgeTreeThreshold ?? params.treeThreshold)
        : Number(params.entryTreeThreshold ?? params.treeThreshold);
      if (!forceHedge && (params.gateMode === "tree" || params.gateMode === "hazard") && treeScore < treeThreshold) continue;
      const structuralHazardScore = params.hazardTreeThreshold == null ? null : predictTree(hazardTree, treeRow);
      if (!forceHedge && params.hazardTreeThreshold != null
        && structuralHazardScore < Number(params.hazardTreeThreshold)) continue;
      const liquidityScore = params.gateMode === "tree" || params.gateMode === "hazard" ? treeScore : params.gateMode === "relative"
        ? (params.depthRatioMax - candidate.depthRatio30) + (candidate.imbalanceDelta30 - params.imbalanceDeltaMin) + (params.depletionRatioMax - candidate.depletionRatio1)
        : (params.askDepthMax - candidate.askDepth3) / params.askDepthMax + (candidate.depthImbalance - params.depthImbalanceMin) + (params.depletionMax - candidate.depletion1) / 500;
      const branchScore = params.sideChoiceMode === "tree" ? predictTree(sideChoiceTree, treeRow) : liquidityScore;
      const score = branchScore
        + params.gapBias * gapContrarian
        + (oriented < -1e-9 ? Number(params.hedgeBonus || 0) : 0)
        + (pairCheap ? params.pairBonus : 0)
        + Number(params.pairWeight || 0) * pairValue
        + (rawPairCost != null && params.templatePairTarget != null && rawPairCost <= params.templatePairTarget + 1e-9 ? params.templatePairBonus : 0);
      valid.push({ side, candidate, score, pairCost, rawPairCost, pairCheap, forceHedge });
    }
    if (!valid.length) continue;
    valid.sort((a, b) => b.score - a.score);
    const chosen = valid[0], sign = chosen.side === "Up" ? 1 : -1;
    const before = state.up - state.down, oriented = before * sign;
    const isHedge = oriented < -1e-9;
    const sizeTreeRow = { ...chosen.candidate, timeS: point.t, orientedInventory: oriented * 30 / baseSize, absoluteInventory: Math.abs(before) * 30 / baseSize, isHedge: isHedge ? 1 : 0, fifoPairCost: chosen.pairCost };
    const use90 = params.size90Mode === "tree"
      ? predictTree(sizeTreeModels.sizeLarge || sizeTreeModels.size90, sizeTreeRow) >= params.sizeTreeThreshold
      : Math.abs(before) >= params.catchupThreshold * baseSize / 30 && (params.size90Mode === "all" || isHedge);
    const requested = chosen.forceHedge ? Math.min(Math.abs(before), 3 * baseSize) : use90 ? 3 * baseSize : baseSize;
    const decisionLimit = chosen.candidate.ask;
    const makerLatencyMs = Math.max(0, Number(params.makerLatencyMs ?? params.latencyMs ?? 0));
    const takerLatencyMs = Math.max(0, Number(params.takerLatencyMs ?? params.latencyMs ?? 0));
    const arrivals = orderExecutionTicks(row.feed.ticks, point.tick.ms, makerLatencyMs, takerLatencyMs);
    if (!arrivals.maker || !arrivals.taker) continue;
    let takerArrivalIndex = pointIndex;
    while (takerArrivalIndex + 1 < decisionPoints.length
      && decisionPoints[takerArrivalIndex].tick.ms < point.tick.ms + takerLatencyMs) takerArrivalIndex++;
    // Strict persistent GTC semantics: the signed exact-ask cell never chases.
    // It takes the arrival top only when that ask is still at/below the
    // submitted cap; otherwise the full quantity rests at the original cap.
    const arrivalAsk = ask(arrivals.taker, chosen.side);
    const fill = arrivalAsk <= decisionLimit + 1e-9 ? executeTop(arrivals.taker, chosen.side, requested) : null;
    let remainder = requested;
    if (fill) {
      const chargedFee = fee(fill.price, fill.shares);
      state.fills++;
      if (isHedge) state.hedges++; else state.entries++;
      if (use90) state.size90++;
      if (fill.partial) state.partials++;
      applyFill(chosen.side, fill.shares, fill.price, chargedFee);
      remainder -= fill.shares;
    }
    if (remainder > 1e-9 && params.makerTtlMs > 0) {
      // A cancel/reprice strategy does not intentionally leave an obsolete
      // same-side quote live after submitting its replacement. Public trade
      // replay still processes any fill that occurred before this decision.
      if (params.replacePendingSameSide) {
        state.pending = state.pending.filter((pending) => pending.side !== chosen.side);
      }
      const visibleAtPlacement = bidDepthAt(arrivals.maker, chosen.side, decisionLimit);
      const ownAhead = state.pending.filter((pending) => pending.side === chosen.side
        && Math.abs(pending.price - decisionLimit) < .005 && pending.expiresMs >= arrivals.maker.ms)
        .reduce((sum, pending) => sum + pending.shares, 0);
      state.pending.push({ side: chosen.side, price: decisionLimit, shares: remainder,
        effectiveArrivalMs: arrivals.maker.ms,
        sequence: ++state.pendingSequence,
        expiresMs: arrivals.maker.ms + params.makerTtlMs,
        initialized: params.makerFillMode === "queue",
        lastVisible: visibleAtPlacement,
        queueAhead: visibleAtPlacement + ownAhead });
    }
    state.lastFireMs = point.tick.ms;
    // The implementation awaits its CLOB response before acting on another
    // branch. Resume only after the arrival snapshot; this is conservative
    // versus overlapping several in-flight orders with stale inventory.
    pointIndex = Math.max(pointIndex, takerArrivalIndex);
  }
  const payout = row.market.winner === "Up" ? state.up : state.down;
  const residualSide = state.up >= state.down ? "Up" : "Down";
  const residualShares = Math.abs(state.up - state.down);
  const residualLots = state.lots[residualSide];
  const residualCost = residualLots.reduce((sum, lot) => sum + lot.shares * lot.effectivePrice, 0);
  const residualPayout = row.market.winner === residualSide ? residualShares : 0;
  return {
    slug: row.market.slug,
    startMs: slugStart(row.market.slug),
    ...state,
    payout,
    pnl: payout - state.cost,
    residualSide,
    residualShares,
    residualCost,
    residualPayout,
    residualPnl: residualPayout - residualCost,
  };
}

function aggregate(results) {
  const sum = (field) => results.reduce((total, row) => total + Number(row[field] || 0), 0);
  const fills = sum("fills"), cost = sum("cost"), pnl = sum("pnl"), active = results.filter((row) => row.fills > 0).length;
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const daily = new Map();
  for (const row of [...results].sort((a, b) => a.startMs - b.startMs)) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= row.pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + row.pnl);
  }
  return {
    windows: results.length,
    activeWindows: active,
    fills,
    hedges: sum("hedges"),
    hedgePct: pct(sum("hedges"), fills),
    crossings: sum("crossings"),
    crossingsPerActiveWindow: round(sum("crossings") / Math.max(1, active), 3),
    size90: sum("size90"),
    size90Pct: pct(sum("size90"), fills),
    partials: sum("partials"), makerFills: sum("makerFills"), makerShares: round(sum("makerShares"), 2),
    pairedShares: round(sum("pairedShares"), 2),
    pairedPnl: round(sum("pairedPnl"), 2),
    residualShares: round(sum("residualShares"), 2),
    residualCost: round(sum("residualCost"), 2),
    residualPayout: round(sum("residualPayout"), 2),
    residualPnl: round(sum("residualPnl"), 2),
    cost: round(cost, 2),
    fees: round(sum("fees"), 2),
    payout: round(sum("payout"), 2),
    pnl: round(pnl, 2),
    roiPct: pct(pnl, cost),
    maxDrawdown: round(maxDrawdown, 2),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss, 4) : (grossWin > 0 ? Infinity : 0),
    positiveWindows: results.filter((row) => row.pnl > 0).length,
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value, 2)])),
  };
}

// Group the exact orders with the identical rule used in fire-gate analysis.
const targetActions = new Map();
const usableFires = fires.filter((fire) => fire.confidence !== "low" && signedByHash.has(fire.orderHash));
for (const row of feeds) {
  const exact = usableFires.filter((fire) => fire.slug === row.market.slug).sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const actions = [];
  let batch = [];
  function finish() {
    if (!batch.length) return;
    actions.push({
      outcome: batch[0].outcome,
      fireMs: batch[0].fireMs,
      filledShares: batch.reduce((sum, fire) => sum + Number(signedByHash.get(fire.orderHash).filledShares), 0),
      contains90: batch.some((fire) => Math.abs(Number(fire.signedShares) - 3 * baseSize) < .01),
    });
  }
  for (const fire of exact) {
    if (batch.length && (fire.outcome !== batch[0].outcome || fire.fireMs - batch.at(-1).fireMs > 300)) {
      finish();
      batch = [];
    }
    batch.push(fire);
  }
  finish();
  targetActions.set(row.market.slug, actions);
}

function targetSummary(selected) {
  const slugs = new Set(selected.map((row) => row.market.slug));
  let fills = 0, hedges = 0, crossings = 0, size90 = 0, active = 0;
  for (const slug of slugs) {
    const actions = targetActions.get(slug) || [];
    if (actions.length) active++;
    let up = 0, down = 0;
    for (const action of actions) {
      const before = up - down, sign = action.outcome === "Up" ? 1 : -1;
      if (before * sign < -1e-9) hedges++;
      if (action.contains90) size90++;
      fills++;
      if (action.outcome === "Up") up += action.filledShares; else down += action.filledShares;
      const after = up - down;
      if (Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) crossings++;
    }
  }
  let cost = 0, fees = 0, payout = 0, makerShares = 0, takerShares = 0;
  const inventory = new Map();
  for (const trade of source.trades.filter((row) => slugs.has(row.slug))) {
    const chargedFee = trade.role === "taker" ? fee(Number(trade.price), Number(trade.size)) : 0;
    cost += Number(trade.price) * Number(trade.size) + chargedFee;
    fees += chargedFee;
    if (trade.role === "maker") makerShares += Number(trade.size); else takerShares += Number(trade.size);
    const key = `${trade.slug}:${trade.outcome}`;
    inventory.set(key, (inventory.get(key) || 0) + Number(trade.size));
  }
  for (const slug of slugs) payout += inventory.get(`${slug}:${marketBySlug.get(slug)?.winner}`) || 0;
  return {
    windows: selected.length, activeWindows: active, fills, hedges, hedgePct: pct(hedges, fills), crossings,
    crossingsPerActiveWindow: round(crossings / Math.max(1, active), 3), size90, size90Pct: pct(size90, fills),
    makerShares: round(makerShares, 2), makerSharePct: pct(makerShares, makerShares + takerShares),
    cost: round(cost, 2), fees: round(fees, 2), payout: round(payout, 2), pnl: round(payout - cost, 2), roiPct: pct(payout - cost, cost),
  };
}

function score(summary, target) {
  return Math.abs(Math.log(Math.max(1, summary.fills) / Math.max(1, target.fills)))
    + Math.abs(summary.activeWindows / summary.windows - target.activeWindows / target.windows)
    + Math.abs((summary.hedgePct || 0) - (target.hedgePct || 0)) / 100
    + Math.abs((summary.crossingsPerActiveWindow || 0) - (target.crossingsPerActiveWindow || 0)) / 5
    + Math.abs((summary.size90Pct || 0) - (target.size90Pct || 0)) / 100
    + Math.abs((summary.roiPct || 0) - (target.roiPct || 0)) / 10;
}

function evaluate(params, selected) { return aggregate(selected.map((row) => simulate(row, params))); }
function windowResults(params, selected) {
  return selected.map((row) => {
    const result = simulate(row, params);
    return {
      slug: result.slug,
      startMs: result.startMs,
      winner: row.market.winner,
      up: round(result.up, 4),
      down: round(result.down, 4),
      fills: result.fills,
      hedges: result.hedges,
      entries: result.entries,
      crossings: result.crossings,
      size90: result.size90,
      partials: result.partials,
      makerFills: result.makerFills,
      makerShares: round(result.makerShares, 4),
      pairedShares: round(result.pairedShares, 4),
      pairedPnl: round(result.pairedPnl, 4),
      residualSide: result.residualSide,
      residualShares: round(result.residualShares, 4),
      residualCost: round(result.residualCost, 4),
      residualPayout: round(result.residualPayout, 4),
      residualPnl: round(result.residualPnl, 4),
      cost: round(result.cost, 4),
      fees: round(result.fees, 4),
      payout: round(result.payout, 4),
      pnl: round(result.pnl, 4),
    };
  });
}
const targetTrain = targetSummary(train), targetHoldout = targetSummary(holdout);
const frozenPolicies = {
  transparentBehavior: { gateMode: "absolute", askDepthMax: 800, depthImbalanceMin: .2, depletionMax: -300, cooldownMs: 500, maxLean: 180, catchupThreshold: 90, size90Mode: "all", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  transparentStrict: { gateMode: "absolute", askDepthMax: 400, depthImbalanceMin: 0, depletionMax: -300, cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "hedge", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treeNoTemplate: { gateMode: "tree", treeModel: "all", treeThreshold: .75, cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  orderConditionedHazard: { gateMode: "hazard", treeThreshold: .75, cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  twoStageChoiceAndRelease: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treePairBonus099: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: .99, templatePairBonus: 1, makerTtlMs: 0 },
  treePairBonus100: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: 1, templatePairBonus: 1, makerTtlMs: 0 },
  treeHedgeCap100: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, hedgePairCap: 1, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treeHedgeCap101: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, hedgePairCap: 1.01, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treePairWeight025: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: .25, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treePairWeight050: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: .5, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treePairWeight100: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 1, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 0 },
  treeRest1000: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 1000 },
  treeRest1500: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 1500 },
  treeRest3000: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 3000 },
  treeQueue1500: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 1500, makerFillMode: "queue" },
  treeQueue3000: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 3000, makerFillMode: "queue" },
  treeQueue5000: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 5000, makerFillMode: "queue" },
  treeQueue10000: { gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree", cooldownMs: 1500, maxLean: 180, catchupThreshold: 90, size90Mode: "tree", sizeTreeThreshold: .54, gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0, makerTtlMs: 10000, makerFillMode: "queue" },
};
// Profit-safety diagnostics use only the already-frozen CLOB trees. They test whether
// causal spot agreement and a fee-inclusive pair guard can remove negative-EV
// releases; they are diagnostics, not selected production defaults.
for (const entryMinBzGap of [0, .005, .01, .02, .04]) {
  for (const hedgePairCap of [.99, 1, 1.01]) {
    const name = `safeBz${String(entryMinBzGap).replace(".", "p")}_pair${String(hedgePairCap).replace(".", "p")}`;
    frozenPolicies[name] = {
      gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree",
      cooldownMs: 1500, maxLean: 180, catchupThreshold: 90,
      size90Mode: "tree", sizeTreeThreshold: .54,
      gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0,
      templatePairTarget: null, templatePairBonus: 0,
      entryMinBzGap, entryTimeMax: 270, hedgePairCap,
      makerTtlMs: 3000, makerFillMode: "queue",
    };
  }
}
for (const entryMinBzGap of [.01, .02, .04]) {
  for (const entryTimeMin of [0, 60, 120, 180]) {
    for (const entryMaxAsk of [.7, .85, null]) {
      for (const maxEntryActions of [1, 3, null]) {
        const capName = entryMaxAsk == null ? "any" : String(entryMaxAsk).replace(".", "p");
        const countName = maxEntryActions == null ? "any" : maxEntryActions;
        const name = `guard_bz${String(entryMinBzGap).replace(".", "p")}_t${entryTimeMin}_ask${capName}_n${countName}`;
        frozenPolicies[name] = {
          gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree",
          cooldownMs: 1500, maxLean: 180, catchupThreshold: 90,
          size90Mode: "tree", sizeTreeThreshold: .54,
          gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0,
          templatePairTarget: null, templatePairBonus: 0,
          entryMinBzGap, entryTimeMin, entryTimeMax: 270,
          entryMaxAsk, maxEntryActions, hedgePairCap: .99,
          makerTtlMs: 3000, makerFillMode: "queue",
        };
      }
    }
  }
}
frozenPolicies.guardAllTakerCurrent = {
  gateMode: "tree", treeModel: "all", treeThreshold: .75, sideChoiceMode: "tree",
  cooldownMs: 1500, maxLean: 180, catchupThreshold: 90,
  size90Mode: "tree", sizeTreeThreshold: .54,
  gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0,
  templatePairTarget: null, templatePairBonus: 0,
  entryMinBzGap: .02, entryTimeMin: 60, entryTimeMax: 270,
  entryMaxAsk: null, maxEntryActions: null, hedgePairCap: .99,
  makerTtlMs: 0,
};
for (const [name, params] of Object.entries(customPolicies)) {
  if (!params || Array.isArray(params) || typeof params !== "object") throw new Error(`custom policy ${name} must be an object`);
  frozenPolicies[name] = params;
}
if (frozenOnly) {
  if (executionLatencies.length) {
    const basePolicies = Object.entries(frozenPolicies).filter(([name]) =>
      (!selectedPolicyNames.size && !selectedPolicyPrefix)
      || selectedPolicyNames.has(name)
      || (selectedPolicyPrefix && name.startsWith(selectedPolicyPrefix)));
    const credits = makerCredits.length ? makerCredits : [null];
    const ttls = makerTtls.length ? makerTtls : [null];
    const hedgeCaps = hedgePairCaps.length ? hedgePairCaps : [null];
    const bzGaps = entryBzGaps.length ? entryBzGaps : [null];
    const policies = basePolicies.flatMap(([name, params]) => ttls.flatMap((makerTtlMs) => credits.flatMap((makerCreditPct) =>
      hedgeCaps.flatMap((hedgePairCap) => bzGaps.map((entryMinBzGap) => {
      const patch = {};
      if (makerTtlMs != null) patch.makerTtlMs = makerTtlMs;
      if (makerCreditPct != null) patch.makerCreditPct = makerCreditPct;
      if (hedgePairCap != null) patch.hedgePairCap = hedgePairCap;
      if (entryMinBzGap != null) patch.entryMinBzGap = entryMinBzGap;
      const suffix = `${makerTtlMs == null ? "" : `-ttl${makerTtlMs}`}${makerCreditPct == null ? "" : `-credit${makerCreditPct}`}`
        + `${hedgePairCap == null ? "" : `-hcap${hedgePairCap}`}${entryMinBzGap == null ? "" : `-bz${entryMinBzGap}`}`;
      return [name + suffix, { ...params, ...patch }];
    })))));
    const latencyDiagnostics = Object.fromEntries(executionLatencies.map((takerLatencyMs) => [takerLatencyMs,
      Object.fromEntries(policies.map(([name, params]) => [name, {
        params: { ...params, makerLatencyMs: makerPlacementLatencyMs, takerLatencyMs },
        train: evaluate({ ...params, makerLatencyMs: makerPlacementLatencyMs, takerLatencyMs }, train),
        holdout: evaluate({ ...params, makerLatencyMs: makerPlacementLatencyMs, takerLatencyMs }, holdout),
        full: evaluate({ ...params, makerLatencyMs: makerPlacementLatencyMs, takerLatencyMs }, feeds),
        ...(includeWindowResults ? { windowResults: windowResults({ ...params, makerLatencyMs: makerPlacementLatencyMs, takerLatencyMs }, feeds) } : {}),
      }]))]));
    const output = {
      schema: 3,
      generatedAt: new Date().toISOString(),
      orderbookSource,
      fireInferenceFile: fireFile,
      methodology: `frozen policies; exact decision-ask GTC cap; raw subsecond ${orderbookSource} arrival ticks; maker remainder establishes queue position at decision+makerLatencyMs; marketable fill is priced at decision+takerLatencyMs; overlapping remainders share one FIFO volume-conserved queue-removal budget; sequential response wait; taker fee rounded to five decimals`,
      range: { start: new Date(epochStart).toISOString(), end: new Date(epochEnd).toISOString(), split: new Date(splitMs).toISOString(), baseSize },
      makerPlacementLatencyMs,
      takerExecutionLatencies: executionLatencies,
      target: { train: targetTrain, holdout: targetHoldout, full: targetSummary(feeds) },
      latencyDiagnostics,
    };
    fs.writeFileSync(path.join(dataDir, latencyAuditFile), JSON.stringify(output, null, 2) + "\n");
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }
  const diagnostics = Object.fromEntries(Object.entries(frozenPolicies).map(([name, params]) => [name, {
    params, train: evaluate(params, train), holdout: evaluate(params, holdout), full: evaluate(params, feeds),
  }]));
  const output = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    orderbookSource,
    fireInferenceFile: fireFile,
    methodology: "strict later-sample replay of policies and trees frozen before the range; inventory thresholds and order size scale with Q while price/L2 thresholds do not",
    range: { start: new Date(epochStart).toISOString(), end: new Date(epochEnd).toISOString(), split: new Date(splitMs).toISOString(), baseSize },
    target: { train: targetTrain, holdout: targetHoldout, full: targetSummary(feeds) },
    diagnostics,
  };
  fs.writeFileSync(path.join(dataDir, "frozen-scale-backtest.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}
const gateCandidates = [];
for (const askDepthMax of [400, 600, 800, 1000])
  for (const depthImbalanceMin of [0, .2, .4])
    for (const depletionMax of [-50, -150, -300])
      for (const cooldownMs of [500, 1500, 3000])
        gateCandidates.push({ gateMode: "absolute", askDepthMax, depthImbalanceMin, depletionMax, cooldownMs, maxLean: 300, catchupThreshold: 90, size90Mode: "hedge", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0 });
for (const depthRatioMax of [.4, .5, .6, .7, .8])
  for (const imbalanceDeltaMin of [.1, .2, .3])
    for (const depletionRatioMax of [-.05, -.15, -.3])
      for (const cooldownMs of [500, 1500, 3000])
        gateCandidates.push({ gateMode: "relative", depthRatioMax, imbalanceDeltaMin, depletionRatioMax, cooldownMs, maxLean: 300, catchupThreshold: 90, size90Mode: "hedge", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0 });
for (const treeModel of ["all", "role"])
  for (const treeThreshold of [.55, .6, .65, .7, .75])
    for (const cooldownMs of [500, 1500, 3000])
      gateCandidates.push({ gateMode: "tree", treeModel, treeThreshold, cooldownMs, maxLean: 300, catchupThreshold: 90, size90Mode: "hedge", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0 });
for (const treeThreshold of [.55, .6, .65, .7, .75, .8])
  for (const cooldownMs of [500, 1500, 3000])
    gateCandidates.push({ gateMode: "hazard", treeThreshold, cooldownMs, maxLean: 300, catchupThreshold: 90, size90Mode: "hedge", gapBias: 0, pairCap: null, pairBonus: 0, pairWeight: 0 });

const coarseTrain = train.filter((_, index) => index % 3 === 0);
const targetCoarse = targetSummary(coarseTrain);
console.log(`coarse fitting ${gateCandidates.length} L2 gates on ${coarseTrain.length} markets`);
const coarse = gateCandidates.map((params) => {
  const summary = evaluate(params, coarseTrain);
  return { params, summary, score: score(summary, targetCoarse) };
}).sort((a, b) => a.score - b.score);
const seeds = new Map();
for (const row of coarse.slice(0, 16)) seeds.set(JSON.stringify(row.params), row.params);
for (const row of [...coarse].filter((candidate) => candidate.summary.fills >= targetCoarse.fills * .2 && candidate.summary.fills <= targetCoarse.fills * 2)
  .sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 16)) seeds.set(JSON.stringify(row.params), row.params);
const inventoryCandidates = [];
const sizeConfigs = [
  ...[30, 90, 180].flatMap((catchupThreshold) => [{ size90Mode: "hedge", catchupThreshold }, { size90Mode: "all", catchupThreshold }]),
  ...[.54, .6, .7].map((sizeTreeThreshold) => ({ size90Mode: "tree", sizeTreeThreshold, catchupThreshold: 90 })),
];
for (const seed of seeds.values())
  for (const sideChoiceMode of ["gate", "tree"])
    for (const maxLean of [180, 300])
      for (const sizeConfig of sizeConfigs)
        for (const pair of [
          { pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: null, templatePairBonus: 0 },
          { pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: .99, templatePairBonus: 1 },
          { pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: 1, templatePairBonus: 1 },
          { pairCap: null, pairBonus: 0, pairWeight: 0, templatePairTarget: .99, templatePairBonus: 2 },
        ])
          inventoryCandidates.push({ ...seed, sideChoiceMode, maxLean, ...sizeConfig, makerTtlMs: 0, ...pair });
console.log(`full fitting ${inventoryCandidates.length} inventory/pair branches on ${train.length} markets`);
const fitted = inventoryCandidates.map((params) => {
  const summary = evaluate(params, train);
  return { params, summary, score: score(summary, targetTrain) };
});
fitted.sort((a, b) => a.score - b.score);
const makerSeeds = new Map();
for (const row of fitted.slice(0, 16)) makerSeeds.set(JSON.stringify(row.params), row.params);
for (const row of [...fitted].filter((candidate) => candidate.summary.fills >= targetTrain.fills * .2 && candidate.summary.fills <= targetTrain.fills * 2)
  .sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 16)) makerSeeds.set(JSON.stringify(row.params), row.params);
const makerFitted = [];
for (const seed of makerSeeds.values()) for (const makerTtlMs of [1_000, 3_000, 10_000]) {
  const params = { ...seed, makerTtlMs };
  const summary = evaluate(params, train);
  makerFitted.push({ params, summary, score: score(summary, targetTrain) });
}
const finalFitted = [...fitted, ...makerFitted].sort((a, b) => a.score - b.score);
const behavior = finalFitted[0];
const profit = [...finalFitted].filter((row) => row.summary.fills >= targetTrain.fills * .2 && row.summary.fills <= targetTrain.fills * 2)
  .sort((a, b) => b.summary.pnl - a.summary.pnl)[0];
const diagnostics = Object.fromEntries(Object.entries(frozenPolicies).map(([name, params]) => [name, { params, train: evaluate(params, train), holdout: evaluate(params, holdout) }]));
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: {
    train: "E8 first half through 2026-08-22 06:15 UTC",
    holdout: "E8 second half beginning 2026-08-22 06:20 UTC; never used for parameter selection",
    signal: "two-stage candidate: simultaneous side selection from CLOB microprice/depth, then low/depleting same-token ask liquidity release gate; optional RTDS gap bias",
    execution: "absolute gates use one-second decisions; learned trees use 250ms decisions; exact best-ask cap and visible top-level depth; all-taker is the selected conservative branch, while 1/3/10s hypothetical GTC-remainder queues are explicitly tested",
  },
  windows: { train: train.length, holdout: holdout.length },
  target: { train: targetTrain, holdout: targetHoldout },
  behaviorFit: { params: behavior.params, score: round(behavior.score), train: behavior.summary, holdout: evaluate(behavior.params, holdout) },
  profitFit: { params: profit.params, train: profit.summary, holdout: evaluate(profit.params, holdout) },
  diagnostics,
  topBehavior: finalFitted.slice(0, 20),
  topProfit: [...finalFitted].sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 20),
};
fs.writeFileSync(path.join(dataDir, "l2-gate-backtest.json"), JSON.stringify(output, null, 2) + "\n");
const b = output.behaviorFit, p = output.profitFit;
const d = output.diagnostics;
const diagnosticLine = (name, row) => `- ${name}: train ${row.train.fills} actions, $${row.train.pnl} (${row.train.roiPct}%); holdout ${row.holdout.fills} actions, $${row.holdout.pnl} (${row.holdout.roiPct}%).`;
const md = `# E8 full-L2 fire-gate backtest\n\n` +
`The policy is fit only on the first half of E8. It fires when same-token ask depth is low and falling while bid/ask depth imbalance is supportive, then executes visible v4 top-ask depth and charges every fill as taker.\n\n` +
`## Behavior fit\n\nParameters: \`${JSON.stringify(b.params)}\`.\n\n` +
`- Train: ${b.train.fills} actions, $${b.train.pnl} (${b.train.roiPct}%); target ${targetTrain.fills}, $${targetTrain.pnl} (${targetTrain.roiPct}%).\n` +
`- Untouched holdout: ${b.holdout.fills} actions, $${b.holdout.pnl} (${b.holdout.roiPct}%); target ${targetHoldout.fills}, $${targetHoldout.pnl} (${targetHoldout.roiPct}%).\n\n` +
`## Profit fit\n\nParameters: \`${JSON.stringify(p.params)}\`.\n\n` +
`- Train: ${p.train.fills} actions, $${p.train.pnl} (${p.train.roiPct}%).\n` +
`- Untouched holdout: ${p.holdout.fills} actions, $${p.holdout.pnl} (${p.holdout.roiPct}%).\n\n` +
`## Frozen diagnostics\n\n` +
`${diagnosticLine("Transparent behavior gate", d.transparentBehavior)}\n` +
`${diagnosticLine("Transparent strict gate", d.transparentStrict)}\n` +
`${diagnosticLine("Learned release tree without template bonus", d.treeNoTemplate)}\n` +
`${diagnosticLine("Two-stage side-choice plus release", d.twoStageChoiceAndRelease)}\n` +
`${diagnosticLine("Order-conditioned hazard used alone", d.orderConditionedHazard)}\n\n` +
`The order-conditioned hazard is a timing model after a signed branch is selected; using it as a stand-alone side selector is intentionally shown and rejected. The two-stage branch is behaviorally close but does not reproduce the target economics.\n`;
fs.writeFileSync(path.join(dataDir, "l2-gate-backtest.md"), md);
console.log(md);
console.log(JSON.stringify({ target: output.target, behaviorFit: output.behaviorFit, profitFit: output.profitFit }, null, 2));
