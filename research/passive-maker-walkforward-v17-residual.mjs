#!/usr/bin/env node
/**
 * Causal passive-maker research replay.
 *
 * Decisions use only the current RTDS Chainlink price relative to the official
 * TWAP-60 window open, the current public CLOB book, time, and this strategy's
 * own inventory. No target-wallet order, fire, fill, or outcome information is
 * used to place an order. Historical outcomes are consulted only at settlement.
 *
 * Resting fills can be credited only from normalized public market-wide taker
 * prints after visible same-price queue ahead has traded. `makerCredit` is the
 * conservative fraction of remaining taker volume credited to our order.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { allocateConservedMakerFills } from "./passive-maker-fill-model.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FROM_MS = Date.parse(process.argv[2] || "2026-08-21T19:55:00Z");
const TO_MS = Date.parse(process.argv[3] || "2026-08-25T00:00:00Z");
const OUTPUT = path.resolve(process.argv[4] || path.join(ROOT, "data/research/passive-maker-walkforward.json"));
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");

const splitList = (name, fallback) => String(process.env[name] || fallback).split(path.delimiter).filter(Boolean);
const L2_DIRS = splitList("MAKER_L2_DIRS", [
  path.join(ROOT, "data/wallet-3048/feeds/v4-post-twap-full-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-e8-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-r2-l2"),
  path.join(ROOT, "data/wallet-3048-r3/feeds/v4-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-l2"),
  // Compact v4 retains both outcome ask ladders. Binary complementarity makes
  // each opposite ask the exact bid ladder for the other outcome, which is
  // enough to reconstruct best-bid queue ahead for the passive replay.
  path.join(ROOT, "data/lockstep-v4-top"),
].join(path.delimiter));
// Optional independent orderbook source used only to confirm opening-cycle
// maker decisions. An absent or stale confirmation snapshot is fail-closed.
const CONFIRM_L2_DIRS = splitList("MAKER_CONFIRM_L2_DIRS", "");
const V2_DIRS = splitList("MAKER_V2_DIRS", [
  path.join(ROOT, "data/wallet-3048/feeds/v2"),
  path.join(ROOT, "data/wallet-3048-r3/feeds/v2"),
].join(path.delimiter));
const TRADE_DIRS = splitList("MAKER_TRADE_DIRS", [
  path.join(ROOT, "data/wallet-3048/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r3/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r4/feeds/market-trades"),
].join(path.delimiter));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const logit = (probability) => {
  const p = clamp(Number(probability), 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
};
const logistic = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));
// Abramowitz-Stegun 7.1.26. Sufficient for a probability gate and avoids a
// fitted dependency in the causal Brownian terminal-price model.
const normalCdf = (value) => {
  const z = Math.abs(Number(value)) / Math.sqrt(2), t = 1 / (1 + .3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - .284496736) * t + .254829592) * t * Math.exp(-z * z);
  return .5 * (1 + (value < 0 ? -erf : erf));
};
const slugStart = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const normalizationFailures = {};
const rejectNormalization = (reason) => {
  normalizationFailures[reason] = (normalizationFailures[reason] || 0) + 1;
  return null;
};
// Polymarket crypto taker fee: 7% * p * (1-p) * shares, charged to five
// decimal places per matched price level. Values that round below $0.00001
// are zero, matching the documented minimum fee precision.
const fee = (price, shares) => Math.round(.07 * price * (1 - price) * shares * 1e5) / 1e5;

function envNumbers(name, fallback) {
  if (!process.env[name]) return fallback;
  const values = process.env[name].split(",").map(Number).filter(Number.isFinite);
  if (!values.length) throw new Error(`${name} contains no numbers`);
  return values;
}

function discover() {
  const l2 = new Map(), confirmL2 = new Map(), v2 = new Map(), trades = new Map();
  for (const dir of L2_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8), startMs = slugStart(slug);
      if (startMs >= FROM_MS && startMs < TO_MS && !l2.has(slug)) l2.set(slug, path.join(dir, name));
    }
  }
  for (const dir of CONFIRM_L2_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8), startMs = slugStart(slug);
      if (startMs >= FROM_MS && startMs < TO_MS && !confirmL2.has(slug)) confirmL2.set(slug, path.join(dir, name));
    }
  }
  for (const dir of V2_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8);
      if (l2.has(slug) && !v2.has(slug)) v2.set(slug, path.join(dir, name));
    }
  }
  for (const dir of TRADE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8);
      if (l2.has(slug) && !trades.has(slug)) trades.set(slug, path.join(dir, name));
    }
  }
  return [...l2].map(([slug, l2File]) => ({ slug, l2File, confirmL2File: confirmL2.get(slug), v2File: v2.get(slug), tradeFile: trades.get(slug) }))
    .filter((row) => row.v2File && (!CONFIRM_L2_DIRS.length || row.confirmL2File)
      && (process.env.MAKER_FILL_SOURCE !== "trades" || row.tradeFile))
    .sort((a, b) => slugStart(a.slug) - slugStart(b.slug));
}

function normalize(meta) {
  const raw = readGzip(meta.l2File), rtds = readGzip(meta.v2File);
  const openBinance = Number(rtds.openBinance);
  const openChainlink = Number(rtds.openChainlink);
  const winner = /^up$/i.test(raw.winner) ? "Up" : /^down$/i.test(raw.winner) ? "Down" : null;
  if (!(openChainlink > 0)) return rejectNormalization("invalid-rtds-open");
  if (!winner) return rejectNormalization("missing-winner");
  if (raw.sparseWindow === true || raw.isStale === true) return rejectNormalization("v4-quality-flag");
  const rtdsTicks = (rtds.ticks || []).map((tick) => ({ ms: Number(tick.ms), cl: Number(tick.cl), bz: Number(tick.bz) }))
    .filter((tick) => Number.isFinite(tick.ms) && tick.cl > 0).sort((a, b) => a.ms - b.ms);
  let cursor = -1, cl = null, bz = null;
  const ticks = (raw.ticks || []).map((tick) => {
    const ms = Number(tick.ms ?? Date.parse(tick.time || ""));
    while (cursor + 1 < rtdsTicks.length && rtdsTicks[cursor + 1].ms <= ms) {
      const source = rtdsTicks[++cursor];
      cl = source.cl;
      if (source.bz > 0) bz = source.bz;
    }
    if (!Array.isArray(tick.up) || !Array.isArray(tick.down)) return { ms, cl, bz, up: tick.up, down: tick.down };
    const rows = (flat) => {
      const out = [];
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const price = Number(flat[index]), size = Number(flat[index + 1]);
        if (price >= .01 && price <= .99 && size > 0) out.push({ price, size });
      }
      return out;
    };
    const upAsks = rows(tick.up), downAsks = rows(tick.down);
    return { ms, cl, bz,
      up: { asks: upAsks, bids: downAsks.map((row) => ({ price: 1 - row.price, size: row.size })) },
      down: { asks: downAsks, bids: upAsks.map((row) => ({ price: 1 - row.price, size: row.size })) } };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.cl > 0 && tick.up && tick.down).sort((a, b) => a.ms - b.ms);
  const trades = meta.tradeFile ? (readGzip(meta.tradeFile).trades || []).map((trade) => ({
    ...trade, ms: Number(trade.ms), price: Number(trade.price), size: Number(trade.size),
  })).filter((trade) => Number.isFinite(trade.ms) && (trade.side === "SELL" || trade.side === "PAIR_BUY") && trade.size > 0).sort((a, b) => a.ms - b.ms) : [];
  const normalizeBookTick = (tick) => {
    const ms = Number(tick.ms ?? Date.parse(tick.time || ""));
    if (!Number.isFinite(ms)) return null;
    const decorate = (book) => {
      const best = (side) => (book[side]?.bids || []).reduce((top, row) => Number(row.price) > Number(top?.price ?? -Infinity) ? row : top, null);
      return { ...book, confirmBestBids: { Up: best("up"), Down: best("down") } };
    };
    if (!Array.isArray(tick.up) || !Array.isArray(tick.down))
      return tick.up && tick.down ? decorate({ ms, up: tick.up, down: tick.down }) : null;
    const rows = (flat) => {
      const out = [];
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const price = Number(flat[index]), size = Number(flat[index + 1]);
        if (price >= .01 && price <= .99 && size > 0) out.push({ price, size });
      }
      return out;
    };
    const upAsks = rows(tick.up), downAsks = rows(tick.down);
    return decorate({ ms,
      up: { asks: upAsks, bids: downAsks.map((row) => ({ price: 1 - row.price, size: row.size })) },
      down: { asks: downAsks, bids: upAsks.map((row) => ({ price: 1 - row.price, size: row.size })) } });
  };
  const confirmTicks = meta.confirmL2File
    ? (readGzip(meta.confirmL2File).ticks || []).map(normalizeBookTick).filter(Boolean).sort((a, b) => a.ms - b.ms)
    : [];
  return ticks.length > 20
    ? { slug: meta.slug, startMs: slugStart(meta.slug), openBinance, openChainlink, winner, ticks, confirmTicks, trades }
    : rejectNormalization("insufficient-aligned-ticks");
}

function sideBook(tick, side) { return side === "Up" ? tick.up : tick.down; }
function sortedRows(rows, direction) {
  return (rows || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => row.price >= .01 && row.price <= .99 && row.size > 0).sort((a, b) => direction * (a.price - b.price));
}
// A normalized snapshot is immutable during replay. Reuse its sorted levels
// across policy/latency/credit configurations instead of sorting the same L2
// rows millions of times in a stress matrix.
const sortedBookCache = new WeakMap();
function cachedRows(tick, side, kind) {
  let cache = sortedBookCache.get(tick);
  if (!cache) { cache = {}; sortedBookCache.set(tick, cache); }
  const key = `${side}:${kind}`;
  if (!cache[key]) cache[key] = sortedRows(sideBook(tick, side)?.[kind], kind === "bids" ? -1 : 1);
  return cache[key];
}
function bids(tick, side) { return cachedRows(tick, side, "bids"); }
function asks(tick, side) { return cachedRows(tick, side, "asks"); }
function makerReleaseFeature(tick, side) {
  const sideBids = bids(tick, side), sideAsks = asks(tick, side);
  const bestBid = sideBids[0], bestAsk = sideAsks[0];
  if (!bestBid || !bestAsk) return null;
  const bidDepth1 = bestBid.size, askDepth1 = bestAsk.size;
  const bidDepth3 = sideBids.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
  const askDepth3 = sideAsks.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
  const topDenominator = bidDepth1 + askDepth1, depth3Denominator = bidDepth3 + askDepth3;
  const midpoint = (bestBid.price + bestAsk.price) / 2;
  const microprice = topDenominator > 0
    ? (bestAsk.price * bidDepth1 + bestBid.price * askDepth1) / topDenominator : midpoint;
  return { ms: tick.ms, askDepth1, askDepth3,
    topDepthImbalance: topDenominator > 0 ? (bidDepth1 - askDepth1) / topDenominator : 0,
    depth3Imbalance: depth3Denominator > 0 ? (bidDepth3 - askDepth3) / depth3Denominator : 0,
    micropriceBias: microprice - midpoint };
}
function bidDepth(tick, side, price) {
  return bids(tick, side).reduce((sum, row) => Math.abs(row.price - price) < .005 ? sum + row.size : sum, 0);
}
function executeTaker(tick, side, requested, limit) {
  let left = requested, shares = 0, cost = 0, fees = 0;
  for (const level of asks(tick, side)) {
    if (level.price > limit + 1e-9 || left <= 1e-9) break;
    const take = Math.min(left, level.size);
    left -= take; shares += take; cost += take * level.price; fees += fee(level.price, take);
  }
  return shares > 1e-9 ? { shares, cost, fees, price: cost / shares } : null;
}
function executeSafeTaker(tick, side, requested, heldUnitCost, pairCap) {
  let left = requested, shares = 0, cost = 0, fees = 0;
  for (const level of asks(tick, side)) {
    if (heldUnitCost + level.price + fee(level.price, 1) > pairCap + 1e-9 || left <= 1e-9) break;
    const take = Math.min(left, level.size);
    left -= take; shares += take; cost += take * level.price; fees += fee(level.price, take);
  }
  return shares > 1e-9 ? { shares, cost, fees, price: cost / shares } : null;
}
function executeTakerSell(tick, side, requested, minOrderShares) {
  if (requested + 1e-9 < minOrderShares) return null;
  let left = requested, shares = 0, proceeds = 0, fees = 0;
  for (const level of bids(tick, side)) {
    if (left <= 1e-9) break;
    const take = Math.min(left, level.size);
    left -= take; shares += take; proceeds += take * level.price; fees += fee(level.price, take);
  }
  return shares > 1e-9 ? { shares, proceeds, fees, price: proceeds / shares } : null;
}

function replayWindow(feed, p) {
  let up = 0, down = 0, cost = 0, grossBuySpend = 0, grossSellProceeds = 0, fees = 0;
  let makerFeeEquivalent = 0;
  let makerShares = 0, takerShares = 0, takerBuyShares = 0, takerSellShares = 0;
  let upCost = 0, downCost = 0;
  let placements = 0, cancels = 0, rejected = 0, makerFillEvents = 0, takerFillEvents = 0, firstPlacementT = null;
  let confirmationUnavailable = 0, confirmationGateRejected = 0;
  let overweightCancelTriggers = 0, overweightCancelRequests = 0;
  let firstTimedExitT = null, firstTimedExitSide = null, firstTimedExitClAlignedPct = null, firstTimedExitBzAlignedPct = null;
  let firstMakerFillT = null, firstMakerSide = null, firstMakerPrice = null, firstMakerPairBidSum = null;
  let firstMakerSideBidDepth = null, firstMakerOtherBidDepth = null, firstMakerInitialQueueAhead = null;
  let firstMakerClGapPct = null, firstMakerBzGapPct = null, firstMakerSideSpread = null;
  let firstMakerExpectedEdge = null, firstMakerFairProbability = null, firstMakerRole = null;
  let firstMakerBrownianProbability = null, firstMakerMarketMid = null;
  const arriving = [], pending = [], safeHedges = [], liquidations = [];
  const residualLots = { Up: [], Down: [] };
  let fifoPairedShares = 0, fifoPairedPnl = 0;
  let nextOrderSequence = 1;
  let tradeCursor = 0;
  let confirmCursor = -1, confirmTick = null;
  let imbalanceSinceMs = null, imbalanceSide = null;
  let holdResidualSide = null, signalHoldEvents = 0, signalHoldShares = 0;
  let residualPredictedSide = null, residualSignalReversals = 0, residualSignalEntries = 0;
  let residualDirectionalPlacements = 0, residualReversalPlacements = 0, residualIndependentPlacements = 0;
  let residualCancelTriggers = 0, residualCancelRequests = 0;
  let lastSpotSecond = null, lastSpotPrice = null;
  const spotReturns = [];
  const releaseTrace = { Up: [], Down: [] };
  const inventory = (side) => side === "Up" ? up : down;
  const committed = (side) => arriving.concat(pending, safeHedges).filter((order) => order.side === side).reduce((sum, order) => sum + order.shares, 0);
  const residualUnitCost = (side) => {
    const lots = residualLots[side];
    const shares = lots.reduce((sum, lot) => sum + lot.shares, 0);
    return shares > 1e-9 ? lots.reduce((sum, lot) => sum + lot.shares * lot.unitCost, 0) / shares : null;
  };
  const signalSupports = (tick, side) => {
    const sign = side === "Up" ? 1 : -1;
    const clPct = Number(feed.openChainlink) > 0
      ? sign * (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100 : -Infinity;
    const bzPct = Number(feed.openBinance) > 0 && Number(tick.bz) > 0
      ? sign * (Number(tick.bz) / Number(feed.openBinance) - 1) * 100 : -Infinity;
    return clPct + 1e-12 >= p.signalHoldClMinPct && bzPct + 1e-12 >= p.signalHoldBzMinPct;
  };
  const residualFair = (tick, t) => {
    if (!(Number(feed.openChainlink) > 0) || !(Number(feed.openBinance) > 0)
      || !(Number(tick.cl) > 0) || !(Number(tick.bz) > 0)) return null;
    const clGapPct = (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100;
    const bzGapPct = (Number(tick.bz) / Number(feed.openBinance) - 1) * 100;
    const chainlinkWeight = clamp(Number(p.residualChainlinkWeight), 0, 1);
    const blendedGapPct = chainlinkWeight * clGapPct + (1 - chainlinkWeight) * bzGapPct;
    const usableReturns = spotReturns.filter((row) => tick.ms - row.ms <= p.residualVolLookbackS * 1000);
    const mean = usableReturns.length ? usableReturns.reduce((sum, row) => sum + row.value, 0) / usableReturns.length : 0;
    const variance = usableReturns.length > 1
      ? usableReturns.reduce((sum, row) => sum + (row.value - mean) ** 2, 0) / (usableReturns.length - 1) : 0;
    const sigmaPctPerSqrtSecond = Math.max(Number(p.residualVolFloorPctPerSqrtS), Math.sqrt(Math.max(0, variance)));
    const remainingS = Math.max(1, 300 - t);
    const brownianUp = normalCdf(blendedGapPct / (sigmaPctPerSqrtSecond * Math.sqrt(remainingS)));
    const upBid = bids(tick, "Up")[0]?.price, upAsk = asks(tick, "Up")[0]?.price;
    const marketMid = Number.isFinite(upBid) && Number.isFinite(upAsk) ? (upBid + upAsk) / 2 : brownianUp;
    const marketWeight = clamp(Number(p.residualMarketWeight), 0, 1);
    const fairUp = logistic((1 - marketWeight) * logit(brownianUp) + marketWeight * logit(marketMid));
    return { fairUp, brownianUp, marketMid, clGapPct, bzGapPct, blendedGapPct, sigmaPctPerSqrtSecond };
  };
  const addResidualLots = (side, shares, unitCost) => {
    const opposite = side === "Up" ? "Down" : "Up";
    let left = shares;
    while (left > 1e-9 && residualLots[opposite].length) {
      const lot = residualLots[opposite][0], take = Math.min(left, lot.shares);
      left -= take; lot.shares -= take; fifoPairedShares += take;
      fifoPairedPnl += take * (1 - unitCost - lot.unitCost);
      if (lot.shares <= 1e-9) residualLots[opposite].shift();
    }
    if (left > 1e-9) residualLots[side].push({ shares: left, unitCost });
  };
  const removeResidualLots = (side, shares) => {
    let left = shares;
    while (left > 1e-9 && residualLots[side].length) {
      const lot = residualLots[side][0], take = Math.min(left, lot.shares);
      left -= take; lot.shares -= take;
      if (lot.shares <= 1e-9) residualLots[side].shift();
    }
  };
  const apply = (side, shares, price, taker, exactFee = null, makerOrder = null, fillMs = null) => {
    const chargedFee = taker ? (Number.isFinite(exactFee) ? exactFee : fee(price, shares)) : 0;
    cost += price * shares + chargedFee; grossBuySpend += price * shares + chargedFee; fees += chargedFee;
    if (side === "Up") upCost += price * shares + chargedFee; else downCost += price * shares + chargedFee;
    if (taker) { takerShares += shares; takerBuyShares += shares; takerFillEvents++; }
    else {
      makerShares += shares; makerFillEvents++;
      if (firstMakerFillT == null && makerOrder) {
        firstMakerFillT = Number.isFinite(fillMs) ? (fillMs - feed.startMs) / 1000 : makerOrder.decisionT;
        firstMakerSide = side;
        firstMakerPrice = price;
        firstMakerPairBidSum = makerOrder.decisionPairBidSum;
        firstMakerSideBidDepth = makerOrder.decisionSideBidDepth;
        firstMakerOtherBidDepth = makerOrder.decisionOtherBidDepth;
        firstMakerInitialQueueAhead = makerOrder.initialQueueAhead;
        firstMakerClGapPct = makerOrder.decisionClGapPct;
        firstMakerBzGapPct = makerOrder.decisionBzGapPct;
        firstMakerSideSpread = makerOrder.decisionSideSpread;
        firstMakerExpectedEdge = makerOrder.decisionExpectedEdge;
        firstMakerFairProbability = makerOrder.decisionFairProbability;
        firstMakerRole = makerOrder.decisionRole;
        firstMakerBrownianProbability = makerOrder.decisionBrownianProbability;
        firstMakerMarketMid = makerOrder.decisionMarketMid;
      }
      // Maker rebates use the same crypto fee curve. Keep the fee equivalent
      // and its modeled rebate separate from trading cash flow.
      makerFeeEquivalent += fee(price, shares);
    }
    addResidualLots(side, shares, price + chargedFee / shares);
    if (side === "Up") up += shares; else down += shares;
  };
  const applySell = (side, fill) => {
    const held = inventory(side), heldCost = side === "Up" ? upCost : downCost;
    const shares = Math.min(held, fill.shares);
    if (shares <= 1e-9) return;
    const unitCost = held > 1e-9 ? heldCost / held : 0;
    const scale = shares / fill.shares;
    cost -= fill.proceeds * scale - fill.fees * scale; grossSellProceeds += fill.proceeds * scale; fees += fill.fees * scale;
    if (side === "Up") { up -= shares; upCost -= unitCost * shares; }
    else { down -= shares; downCost -= unitCost * shares; }
    removeResidualLots(side, shares);
    takerShares += shares; takerSellShares += shares; takerFillEvents++;
  };
  const applyMarketTradesThrough = (tickMs) => {
    while (tradeCursor < feed.trades.length && feed.trades[tradeCursor].ms <= tickMs) {
      const trade = feed.trades[tradeCursor++];
      const matching = [];
      for (const order of pending) {
        const priceMatches = p.tradePriceMode === "exact"
          ? Math.abs(trade.price - order.price) < .005
          : trade.price <= order.price + 1e-9;
        // Public prints have one-second precision and are normalized to the
        // end of their reported second. Equal-time boundaries are therefore
        // not strong enough evidence that our order was already live.
        if (trade.ms <= order.effectiveArrivalMs || trade.ms >= order.expiresMs
          || trade.outcome !== order.side || !priceMatches) continue;
        matching.push(order);
      }
      for (const { order, shares } of allocateConservedMakerFills(matching, trade.size, p.makerCredit))
        apply(order.side, shares, order.price, false, null, order, trade.ms);
      for (let index = pending.length - 1; index >= 0; index--)
        if (pending[index].shares <= 1e-9) pending.splice(index, 1);
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      if (tickMs >= pending[index].expiresMs) { pending.splice(index, 1); cancels++; }
    }
  };

  for (const tick of feed.ticks) {
    const t = (tick.ms - feed.startMs) / 1000;
    while (confirmCursor + 1 < feed.confirmTicks.length && feed.confirmTicks[confirmCursor + 1].ms <= tick.ms)
      confirmTick = feed.confirmTicks[++confirmCursor];

    let currentResidualFair = null, currentReleaseFeatures = null;
    if (p.signalMode === "residual") {
      const spotSecond = Math.floor(tick.ms / 1000), spotPrice = Number(tick.bz);
      if (Number.isFinite(spotPrice) && spotPrice > 0 && spotSecond !== lastSpotSecond) {
        if (Number.isFinite(lastSpotPrice) && lastSpotPrice > 0 && Number.isFinite(lastSpotSecond)) {
          const elapsedS = Math.max(1, spotSecond - lastSpotSecond);
          spotReturns.push({ ms: tick.ms, value: Math.log(spotPrice / lastSpotPrice) * 100 / Math.sqrt(elapsedS) });
        }
        lastSpotSecond = spotSecond; lastSpotPrice = spotPrice;
      }
      while (spotReturns.length && tick.ms - spotReturns[0].ms > p.residualVolLookbackS * 1000) spotReturns.shift();
      currentReleaseFeatures = { Up: makerReleaseFeature(tick, "Up"), Down: makerReleaseFeature(tick, "Down") };
      for (const side of ["Up", "Down"]) {
        if (currentReleaseFeatures[side]) releaseTrace[side].push(currentReleaseFeatures[side]);
        while (releaseTrace[side].length && tick.ms - releaseTrace[side][0].ms > 12_000) releaseTrace[side].shift();
      }
      currentResidualFair = residualFair(tick, t);
      if (currentResidualFair) {
        const gap = Math.max(0, Number(p.residualSpotMinGapPct) || 0);
        const upSupported = currentResidualFair.clGapPct + 1e-12 >= gap && currentResidualFair.bzGapPct + 1e-12 >= gap;
        const downSupported = currentResidualFair.clGapPct - 1e-12 <= -gap && currentResidualFair.bzGapPct - 1e-12 <= -gap;
        const entryProbability = clamp(Number(p.residualEntryProbability), .5, .99);
        const reversalProbability = clamp(Number(p.residualReversalProbability), .5, .99);
        let nextPredictedSide = residualPredictedSide;
        if (!residualPredictedSide) {
          if (upSupported && currentResidualFair.fairUp >= entryProbability) nextPredictedSide = "Up";
          else if (downSupported && 1 - currentResidualFair.fairUp >= entryProbability) nextPredictedSide = "Down";
          if (nextPredictedSide) residualSignalEntries++;
        } else if (residualPredictedSide === "Up" && downSupported
          && 1 - currentResidualFair.fairUp >= reversalProbability) nextPredictedSide = "Down";
        else if (residualPredictedSide === "Down" && upSupported
          && currentResidualFair.fairUp >= reversalProbability) nextPredictedSide = "Up";
        if (residualPredictedSide && nextPredictedSide !== residualPredictedSide) residualSignalReversals++;
        residualPredictedSide = nextPredictedSide;
      }
    }

    // Existing resting orders see every public print timestamped before this
    // executable snapshot. Taker actions due on the snapshot run afterward.
    if (p.fillSource === "trades") applyMarketTradesThrough(tick.ms);

    for (let index = liquidations.length - 1; index >= 0; index--) {
      const order = liquidations[index];
      if (order.arrivalMs > tick.ms) continue;
      liquidations.splice(index, 1);
      const fill = executeTakerSell(tick, order.side, Math.min(order.shares, inventory(order.side)), p.minOrderShares);
      if (fill) applySell(order.side, fill);
    }

    for (let index = safeHedges.length - 1; index >= 0; index--) {
      const hedge = safeHedges[index];
      if (hedge.arrivalMs > tick.ms) continue;
      safeHedges.splice(index, 1);
      const needed = hedge.side === "Up" ? Math.max(0, down - up) : Math.max(0, up - down);
      const heldSide = hedge.side === "Up" ? "Down" : "Up";
      const heldUnitCost = residualUnitCost(heldSide) ?? Infinity;
      const fill = executeSafeTaker(tick, hedge.side, Math.min(hedge.shares, needed), heldUnitCost,
        hedge.pairCap ?? p.pairCompleteCap);
      if (fill) apply(hedge.side, fill.shares, fill.price, true, fill.fees);
    }

    for (let index = arriving.length - 1; index >= 0; index--) {
      const order = arriving[index];
      if (order.arrivalMs > tick.ms) continue;
      arriving.splice(index, 1);
      const bestAsk = asks(tick, order.side)[0]?.price;
      if (bestAsk != null && bestAsk <= order.price + 1e-9) {
        if (p.postOnly) { rejected++; continue; }
        const fill = executeTaker(tick, order.side, order.shares, order.price);
        if (fill) { apply(order.side, fill.shares, fill.price, true, fill.fees); order.shares -= fill.shares; }
      }
      if (order.shares > 1e-9) {
        const visible = bidDepth(tick, order.side, order.price);
        const independentVisible = Number(order.decisionConfirmBidDepth);
        const conservativeVisible = p.conservativeConfirmQueue === true && Number.isFinite(independentVisible)
          ? Math.max(visible, independentVisible) : visible;
        const ownAhead = pending.filter((row) => row.side === order.side && Math.abs(row.price - order.price) < .005)
          .reduce((sum, row) => sum + row.shares, 0);
        const roleTtlMs = order.decisionRole === "balance-locked" && Number(p.residualLockedPairTtlMs) > 0
          ? Number(p.residualLockedPairTtlMs) : p.ttlMs;
        const normalExpiryMs = tick.ms + roleTtlMs + p.cancelLatencyMs;
        const expiresMs = order.cancelOnArrival ? Math.min(normalExpiryMs, tick.ms + p.cancelLatencyMs) : normalExpiryMs;
        pending.push({ ...order, effectiveArrivalMs: tick.ms, expiresMs,
          queueAhead: conservativeVisible + ownAhead, initialQueueAhead: conservativeVisible + ownAhead, lastVisible: visible });
      }
    }

    if (p.fillSource !== "trades") {
      for (let index = pending.length - 1; index >= 0; index--) {
        const order = pending[index];
        if (tick.ms > order.expiresMs) { pending.splice(index, 1); cancels++; continue; }
        const visible = bidDepth(tick, order.side, order.price);
        let removed = Math.max(0, order.lastVisible - visible);
        const ahead = Math.min(order.queueAhead, removed);
        order.queueAhead -= ahead; removed -= ahead;
        const shares = Math.min(order.shares, removed * p.makerCredit);
        if (shares > 1e-9) { apply(order.side, shares, order.price, false, null, order, tick.ms); order.shares -= shares; }
        order.lastVisible = visible;
        if (order.shares <= 1e-9) pending.splice(index, 1);
      }
    }

    if (p.cancelOverweightOnFill === true) {
      const imbalance = up - down;
      const overweightSide = imbalance > 1e-9 ? "Up" : imbalance < -1e-9 ? "Down" : null;
      if (overweightSide) {
        let requested = 0;
        for (const order of pending) {
          if (order.side !== overweightSide) continue;
          const cancelEffectiveMs = tick.ms + p.cancelLatencyMs;
          if (cancelEffectiveMs + 1e-9 < order.expiresMs) {
            order.expiresMs = cancelEffectiveMs;
            requested++;
          }
        }
        for (const order of arriving) {
          if (order.side === overweightSide && order.cancelOnArrival !== true) {
            order.cancelOnArrival = true;
            requested++;
          }
        }
        if (requested > 0) { overweightCancelTriggers++; overweightCancelRequests += requested; }
      }
    }

    const safeCompletionActive = p.signalMode === "twoSided"
      && (p.safeHedgeEveryTick === true || (p.endCompleteS > 0 && t >= p.endCompleteS));
    if (safeCompletionActive && safeHedges.length === 0) {
      const imbalance = up - down;
      if (Math.abs(imbalance) > 1e-9) {
        const missingSide = imbalance > 0 ? "Down" : "Up";
        if (committed(missingSide) <= 1e-9) {
          const heldSide = imbalance > 0 ? "Up" : "Down";
          const heldUnitCost = residualUnitCost(heldSide) ?? Infinity;
          const bestAsk = asks(tick, missingSide)[0]?.price;
          if (Number.isFinite(bestAsk) && heldUnitCost + bestAsk + fee(bestAsk, 1) <= p.pairCompleteCap + 1e-9) {
            safeHedges.push({ side: missingSide, shares: Math.abs(imbalance), heldUnitCost,
              pairCap: p.pairCompleteCap, arrivalMs: tick.ms + p.takerLatencyMs });
          }
        }
      }
    }

    const currentImbalance = up - down;
    const currentImbalanceSide = currentImbalance > 1e-9 ? "Up" : currentImbalance < -1e-9 ? "Down" : null;
    if (!currentImbalanceSide) holdResidualSide = null;
    if (!currentImbalanceSide) { imbalanceSinceMs = null; imbalanceSide = null; }
    else if (imbalanceSide !== currentImbalanceSide) { imbalanceSinceMs = tick.ms; imbalanceSide = currentImbalanceSide; }
    const timedRiskExit = p.effectiveUnpairedTimeoutS > 0 && Math.abs(currentImbalance) + 1e-9 >= p.minOrderShares && imbalanceSinceMs != null
      && tick.ms - imbalanceSinceMs >= p.effectiveUnpairedTimeoutS * 1000;

    if (timedRiskExit && firstTimedExitT == null) {
      firstTimedExitT = t;
      firstTimedExitSide = currentImbalanceSide;
      const sign = currentImbalanceSide === "Up" ? 1 : -1;
      firstTimedExitClAlignedPct = Number(feed.openChainlink) > 0
        ? sign * (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100 : null;
      firstTimedExitBzAlignedPct = Number(feed.openBinance) > 0 && Number(tick.bz) > 0
        ? sign * (Number(tick.bz) / Number(feed.openBinance) - 1) * 100 : null;
    }

    if (timedRiskExit && holdResidualSide == null && arriving.length === 0 && pending.length === 0
      && safeHedges.length === 0 && liquidations.length === 0) {
      const signalHold = p.timeoutSignalHold === true && t >= p.signalHoldMinTimeS
        && signalSupports(tick, currentImbalanceSide);
      if (signalHold) {
        holdResidualSide = currentImbalanceSide;
        signalHoldEvents++;
        signalHoldShares += Math.abs(currentImbalance);
      } else {
      const timeoutCompleteCap = Number(p.timeoutCompleteCap);
      const missingSide = currentImbalanceSide === "Up" ? "Down" : "Up";
      const heldUnitCost = residualUnitCost(currentImbalanceSide) ?? Infinity;
      const bestAsk = asks(tick, missingSide)[0]?.price;
      if (Number.isFinite(timeoutCompleteCap) && timeoutCompleteCap > 0 && Number.isFinite(bestAsk)
        && heldUnitCost + bestAsk + fee(bestAsk, 1) <= timeoutCompleteCap + 1e-9) {
        safeHedges.push({ side: missingSide, shares: Math.abs(currentImbalance), heldUnitCost,
          pairCap: timeoutCompleteCap, arrivalMs: tick.ms + p.takerLatencyMs });
      } else {
        liquidations.push({ side: currentImbalanceSide, shares: Math.abs(currentImbalance), arrivalMs: tick.ms + p.takerLatencyMs });
      }
      }
    }

    if (p.signalMode === "twoSided" && p.endLiquidateS > 0 && t >= p.endLiquidateS
      && arriving.length === 0 && pending.length === 0 && safeHedges.length === 0 && liquidations.length === 0) {
      const imbalance = up - down;
      if (Math.abs(imbalance) > 1e-9) liquidations.push({
        side: imbalance > 0 ? "Up" : "Down", shares: Math.abs(imbalance), arrivalMs: tick.ms + p.takerLatencyMs,
      });
    }

    if (!p.makerTradingEnabled || holdResidualSide != null || t < p.effectiveMinTimeS || t >= p.maxTimeS || timedRiskExit
      || liquidations.length > 0 || safeHedges.length > 0 || !Number.isFinite(tick.cl)) continue;
    const currentLimits = { Up: round((bids(tick, "Up")[0]?.price ?? NaN) + p.bidOffset, 2), Down: round((bids(tick, "Down")[0]?.price ?? NaN) + p.bidOffset, 2) };
    const projected = { Up: up + committed("Up"), Down: down + committed("Down") };
    let wanted = p.signalMode === "residual" ? new Set() : p.signalMode === "twoSided"
      ? projected.Up > projected.Down + 1e-9 ? new Set(["Down"])
        : projected.Down > projected.Up + 1e-9 ? new Set(["Up"]) : new Set(["Up", "Down"])
      : null;
    if (p.signalMode === "residual" && (!currentResidualFair || !residualPredictedSide)) continue;
    const balancedOpening = p.signalMode === "twoSided" && wanted.size === 2;
    let openingSignalSide = null;
    const openingSignalPolicy = balancedOpening && (p.openingSignalEntry === true
      || p.openingSignalSkewTicks > 0 || p.openingSignalRequireAgreement === true);
    if (openingSignalPolicy) {
      const clGapPct = Number(feed.openChainlink) > 0
        ? (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100 : NaN;
      const bzGapPct = Number(feed.openBinance) > 0 && Number(tick.bz) > 0
        ? (Number(tick.bz) / Number(feed.openBinance) - 1) * 100 : NaN;
      const threshold = Math.max(0, Number(p.openingSignalMinPct) || 0);
      openingSignalSide = Number.isFinite(clGapPct) && Number.isFinite(bzGapPct)
        && clGapPct + 1e-12 >= threshold && bzGapPct + 1e-12 >= threshold ? "Up"
        : Number.isFinite(clGapPct) && Number.isFinite(bzGapPct)
          && clGapPct - 1e-12 <= -threshold && bzGapPct - 1e-12 <= -threshold ? "Down" : null;
      if (!openingSignalSide && (p.openingSignalEntry === true || p.openingSignalRequireAgreement === true)) continue;
      if (p.openingSignalEntry === true) wanted = new Set([openingSignalSide]);
    }
    let openingConfirmTick = null;
    if ((balancedOpening || p.signalMode === "residual") && p.confirmPairQuoteCap > 0) {
      const ageMs = confirmTick ? tick.ms - confirmTick.ms : Infinity;
      if (!confirmTick || ageMs < 0 || ageMs > p.confirmMaxAgeMs) { confirmationUnavailable++; continue; }
      const confirmLimits = {
        Up: round((confirmTick.confirmBestBids.Up?.price ?? NaN) + p.bidOffset, 2),
        Down: round((confirmTick.confirmBestBids.Down?.price ?? NaN) + p.bidOffset, 2),
      };
      const confirmPairBidSum = confirmLimits.Up + confirmLimits.Down;
      if (!Number.isFinite(confirmPairBidSum) || confirmPairBidSum > p.confirmPairQuoteCap + 1e-9) {
        confirmationGateRejected++;
        continue;
      }
      // A disagreement cannot improve our quote. This prevents a one-tick
      // optimistic source from manufacturing queue priority or a fill.
      currentLimits.Up = round(Math.min(currentLimits.Up, confirmLimits.Up), 2);
      currentLimits.Down = round(Math.min(currentLimits.Down, confirmLimits.Down), 2);
      openingConfirmTick = confirmTick;
    }
    const visiblePairBidSum = currentLimits.Up + currentLimits.Down;
    const residualPlan = {};
    if (p.signalMode === "residual") {
      const predictedSide = residualPredictedSide, otherSide = predictedSide === "Up" ? "Down" : "Up";
      const predictedSign = predictedSide === "Up" ? 1 : -1;
      const projectedImbalance = projected.Up - projected.Down;
      const orientedImbalance = projectedImbalance * predictedSign;
      const projectedGross = projected.Up + projected.Down;
      const grossAvailable = Math.max(0, Number(p.residualGrossCapShares) - projectedGross);
      const predictedLimit = currentLimits[predictedSide], otherLimit = currentLimits[otherSide];
      const fairPredicted = predictedSide === "Up" ? currentResidualFair.fairUp : 1 - currentResidualFair.fairUp;
      const brownianPredicted = predictedSide === "Up" ? currentResidualFair.brownianUp : 1 - currentResidualFair.brownianUp;
      const marketPredicted = predictedSide === "Up" ? currentResidualFair.marketMid : 1 - currentResidualFair.marketMid;
      const fairOther = 1 - fairPredicted;
      const predictedEdge = fairPredicted - predictedLimit, otherEdge = fairOther - otherLimit;
      const spotGap = Math.max(0, Number(p.residualSpotMinGapPct) || 0);
      const predictedCurrentlySupported = predictedSide === "Up"
        ? currentResidualFair.clGapPct + 1e-12 >= spotGap && currentResidualFair.bzGapPct + 1e-12 >= spotGap
        : currentResidualFair.clGapPct - 1e-12 <= -spotGap && currentResidualFair.bzGapPct - 1e-12 <= -spotGap;
      const minEdge = Number(p.residualMinExpectedEdge);
      const target = Number(p.residualTargetShares), baseSize = Number(p.residualBaseOrderShares);
      const largeSize = Number(p.residualLargeOrderShares), largeEdge = Number(p.residualLargeExpectedEdge);
      const largeMinProbability = clamp(Number(p.residualLargeMinProbability), .5, 1);
      const predictedSideAvailable = Math.max(0, p.exposureCap - projected[predictedSide]);
      const reversalNeed = predictedCurrentlySupported ? Math.max(0, -orientedImbalance) : 0;
      const directionalEntryOpen = t <= Number(p.residualDirectionalMaxTimeS) + 1e-9;
      const marketConsensus = marketPredicted + 1e-12 >= Number(p.residualMinMarketProbability)
        && Math.abs(brownianPredicted - marketPredicted) <= Number(p.residualMaxSpotMarketProbabilityGap) + 1e-12;
      const valueNeed = directionalEntryOpen && predictedCurrentlySupported && marketConsensus
        && predictedEdge + 1e-12 >= minEdge
        ? Math.max(0, target - orientedImbalance) : 0;
      // A reversal order may reduce the obsolete residual to neutral, but it
      // must not cross neutral and silently become a new directional entry.
      // Building the new residual requires a later decision with standalone
      // expected edge after projected inventory is no longer obsolete.
      const reducingObsoleteResidual = reversalNeed + 1e-9 >= p.minOrderShares;
      const predictedNeed = reducingObsoleteResidual ? reversalNeed : valueNeed;
      if (predictedNeed + 1e-9 >= p.minOrderShares && grossAvailable + 1e-9 >= p.minOrderShares) {
        // The observed wallet uses a discrete small/large size menu, but its
        // large size is not simply the previous fill size.  Reserve that menu
        // step for an unusually strong terminal forecast so a cheap token on
        // only a modest spot signal cannot manufacture a large order.
        const useLarge = predictedEdge + 1e-12 >= largeEdge
          && fairPredicted + 1e-12 >= largeMinProbability
          && predictedNeed + 1e-9 >= 2 * baseSize;
        const menuSize = useLarge ? largeSize : baseSize;
        const shares = Math.min(menuSize, predictedNeed, predictedSideAvailable, grossAvailable);
        if (shares + 1e-9 >= p.minOrderShares) residualPlan[predictedSide] = {
          shares,
          role: reducingObsoleteResidual ? "reversal" : "directional",
          expectedEdge: predictedEdge,
        };
      }

      // A non-predicted-side maker is allowed only while building the small
      // paired base and only when it has standalone model edge or locks a
      // positive complete-set edge against an already-filled residual lot.
      const pairedProjected = Math.min(projected.Up, projected.Down);
      const balanceNeed = Math.max(0, Number(p.residualBalanceShares) - pairedProjected);
      const heldUnitCost = orientedImbalance > 1e-9 ? residualUnitCost(predictedSide) : null;
      const locksPairEdge = Number.isFinite(heldUnitCost) && Number.isFinite(otherLimit)
        && heldUnitCost + otherLimit <= Number(p.residualLockedPairCostCap) + 1e-9;
      const independentValue = otherEdge + 1e-12 >= Number(p.residualIndependentMinExpectedEdge) || locksPairEdge;
      const otherSideAvailable = Math.max(0, p.exposureCap - projected[otherSide]);
      const grossAfterPredicted = grossAvailable - Number(residualPlan[predictedSide]?.shares || 0);
      if (orientedImbalance + 1e-9 >= p.minOrderShares && independentValue
        && balanceNeed + 1e-9 >= p.minOrderShares
        && grossAfterPredicted + 1e-9 >= p.minOrderShares) {
        const shares = Math.min(baseSize, balanceNeed, otherSideAvailable, grossAfterPredicted);
        if (shares + 1e-9 >= p.minOrderShares) residualPlan[otherSide] = {
          shares,
          role: locksPairEdge ? "balance-locked" : "independent",
          expectedEdge: otherEdge,
        };
      }
      wanted = new Set(Object.keys(residualPlan));
      if (wanted.size === 2 && (!Number.isFinite(visiblePairBidSum)
        || visiblePairBidSum > p.pairQuoteCap + 1e-9)) {
        delete residualPlan[otherSide];
        wanted.delete(otherSide);
      }
      if (p.residualCancelInvalidOrders === true || p.residualCancelRepricedOrders === true) {
        const actualOrientedImbalance = (up - down) * predictedSign;
        const pairedActual = Math.min(up, down);
        const actualHeldUnitCost = actualOrientedImbalance > 1e-9 ? residualUnitCost(predictedSide) : null;
        const actualLocksPairEdge = Number.isFinite(actualHeldUnitCost) && Number.isFinite(otherLimit)
          && actualHeldUnitCost + otherLimit <= Number(p.residualLockedPairCostCap) + 1e-9;
        const otherStillIndependent = actualOrientedImbalance + 1e-9 >= p.minOrderShares
          && pairedActual < Number(p.residualBalanceShares) - 1e-9
          && (otherEdge + 1e-12 >= Number(p.residualIndependentMinExpectedEdge) || actualLocksPairEdge);
        const existingOrderValid = (order) => order.side === predictedSide
          ? predictedCurrentlySupported : order.side === otherSide && otherStillIndependent;
        const shouldCancel = (order) => {
          if (p.residualCancelInvalidOrders === true && !existingOrderValid(order)) return true;
          // A locked-balance quote is intentionally improved above the deep
          // directional limit and capped by complete-set cost, so comparing
          // it with the deep limit would cancel it immediately by mistake.
          if (order.decisionRole === "balance-locked" && Number(p.residualLockedPairImproveTicks) > 0) return false;
          const desiredLimit = currentLimits[order.side];
          const repriceThreshold = Math.max(1, Number(p.residualRepriceTicks) || 1) * .01;
          return p.residualCancelRepricedOrders === true && existingOrderValid(order)
            && Number.isFinite(desiredLimit) && Number(order.price) - desiredLimit >= repriceThreshold - 1e-9;
        };
        let requested = 0;
        for (const order of pending) {
          if (!shouldCancel(order)) continue;
          const cancelEffectiveMs = tick.ms + p.cancelLatencyMs;
          if (cancelEffectiveMs + 1e-9 < order.expiresMs) {
            order.expiresMs = cancelEffectiveMs;
            requested++;
          }
        }
        for (const order of arriving) {
          if (shouldCancel(order) && order.cancelOnArrival !== true) {
            order.cancelOnArrival = true;
            requested++;
          }
        }
        if (requested > 0) { residualCancelTriggers++; residualCancelRequests += requested; }
      }
      if (wanted.size === 0) continue;
    }
    // When inventory is still balanced, an asymmetric outstanding quote is
    // only operational exposure: one side is pending/rejecting/cancelling,
    // not a filled position that needs a hedge.  Optionally suppress new
    // orders in that state when binary bid complementarity has tightened.
    // Once a maker fill creates real inventory imbalance, hedging remains
    // unrestricted by this veto.
    if (p.signalMode === "twoSided" && p.balancedInventoryPairBidCap > 0
      && Math.abs(up - down) <= 1e-9
      && (!Number.isFinite(visiblePairBidSum) || visiblePairBidSum > p.balancedInventoryPairBidCap + 1e-9)) continue;
    if (p.signalMode === "twoSided" && balancedOpening
      && (!Number.isFinite(currentLimits.Up) || !Number.isFinite(currentLimits.Down) || visiblePairBidSum > p.pairQuoteCap + 1e-9)) continue;
    for (const side of ["Up", "Down"]) {
      if (wanted && !wanted.has(side)) continue;
      if (inventory(side) + committed(side) >= p.exposureCap - 1e-9) continue;
      const sign = side === "Up" ? 1 : -1;
      const alignedGapPct = (tick.cl - feed.openChainlink) / feed.openChainlink * 100 * sign;
      if (!wanted && (alignedGapPct < p.clMinPct || alignedGapPct > p.clMaxPct)) continue;
      let limit = currentLimits[side];
      if (!Number.isFinite(limit)) continue;
      if (p.signalMode === "residual") {
        const primaryFeature = currentReleaseFeatures?.[side];
        const confirmFeature = openingConfirmTick ? makerReleaseFeature(openingConfirmTick, side) : null;
        const fiveSecondFeature = [...releaseTrace[side]].reverse().find((row) => row.ms <= tick.ms - 5_000) || null;
        const askDepth3Change5 = primaryFeature && fiveSecondFeature
          ? primaryFeature.askDepth3 - fiveSecondFeature.askDepth3 : null;
        const maxAskDepth1 = Number(p.residualMaxAskDepth1), maxAskDepth3 = Number(p.residualMaxAskDepth3);
        const minTopImbalance = Number(p.residualMinTopDepthImbalance);
        const minDepth3Imbalance = Number(p.residualMinDepth3Imbalance);
        const minMicropriceBias = Number(p.residualMinMicropriceBias);
        const maxAskDepth3Change5 = Number(p.residualMaxAskDepth3Change5);
        if (!primaryFeature || !confirmFeature
          || (Number.isFinite(maxAskDepth1) && Math.max(primaryFeature.askDepth1, confirmFeature.askDepth1) > maxAskDepth1 + 1e-9)
          || (Number.isFinite(maxAskDepth3) && Math.max(primaryFeature.askDepth3, confirmFeature.askDepth3) > maxAskDepth3 + 1e-9)
          || (Number.isFinite(minTopImbalance) && Math.min(primaryFeature.topDepthImbalance, confirmFeature.topDepthImbalance) < minTopImbalance - 1e-9)
          || (Number.isFinite(minDepth3Imbalance) && Math.min(primaryFeature.depth3Imbalance, confirmFeature.depth3Imbalance) < minDepth3Imbalance - 1e-9)
          || (Number.isFinite(minMicropriceBias) && Math.min(primaryFeature.micropriceBias, confirmFeature.micropriceBias) < minMicropriceBias - 1e-9)
          || (Number.isFinite(maxAskDepth3Change5) && (!Number.isFinite(askDepth3Change5)
            || askDepth3Change5 > maxAskDepth3Change5 + 1e-9))) continue;
        if (residualPlan[side]?.role === "balance-locked" && Number(p.residualLockedPairImproveTicks) > 0) {
          const heldSide = side === "Up" ? "Down" : "Up";
          const heldUnitCost = residualUnitCost(heldSide);
          const bestAsk = asks(tick, side)[0]?.price;
          const lockedCeiling = Number.isFinite(heldUnitCost)
            ? Math.floor((Number(p.residualLockedPairCostCap) - heldUnitCost + 1e-9) * 100) / 100 : -Infinity;
          if (Number.isFinite(bestAsk)) limit = round(Math.min(limit + Number(p.residualLockedPairImproveTicks) * .01,
            lockedCeiling, bestAsk - .01), 2);
        }
      }
      if (balancedOpening && wanted.size === 2 && openingSignalSide && side !== openingSignalSide
        && p.openingSignalSkewTicks > 0) limit = round(limit - p.openingSignalSkewTicks * .01, 2);
      if (p.signalMode === "twoSided" && wanted.size === 1 && p.hedgeImproveTicks !== 0) {
        const heldSide = side === "Up" ? "Down" : "Up";
        const heldShares = inventory(heldSide), heldCost = heldSide === "Up" ? upCost : downCost;
        const bestAsk = asks(tick, side)[0]?.price;
        if (heldShares > 1e-9 && Number.isFinite(bestAsk)) {
          const safeCeiling = Math.floor((p.pairCostCap - heldCost / heldShares + 1e-9) * 100) / 100;
          const improved = p.hedgeImproveTicks < 0 ? safeCeiling : limit + p.hedgeImproveTicks * .01;
          limit = round(Math.max(limit, Math.min(improved, safeCeiling, bestAsk - .01)), 2);
        }
      }
      if (limit < p.priceMin || limit >= p.priceMax || limit < .01 || limit > .99) continue;
      if (p.signalMode === "twoSided" && wanted.size === 1) {
        const heldSide = side === "Up" ? "Down" : "Up";
        const heldShares = inventory(heldSide), heldCost = heldSide === "Up" ? upCost : downCost;
        if (heldShares > 1e-9 && heldCost / heldShares + limit > p.pairCostCap + 1e-9) continue;
      }
      const shares = p.signalMode === "residual"
        ? Math.min(Number(residualPlan[side]?.shares || 0), p.exposureCap - inventory(side) - committed(side))
        : Math.min(Math.max(p.orderSize, p.minOrderShares), p.exposureCap - inventory(side) - committed(side));
      if (shares + 1e-9 < p.minOrderShares) continue;
      const otherSide = side === "Up" ? "Down" : "Up";
      const sideBid = bids(tick, side)[0], otherBid = bids(tick, otherSide)[0], sideAsk = asks(tick, side)[0];
      arriving.push({ side, price: limit, shares, arrivalMs: tick.ms + p.effectiveMakerLatencyMs,
        sequence: nextOrderSequence++, decisionT: t,
        decisionConfirmBidDepth: openingConfirmTick ? bidDepth(openingConfirmTick, side, limit) : null,
        decisionPairBidSum: Number(sideBid?.price) + Number(otherBid?.price),
        decisionSideBidDepth: Number(sideBid?.size), decisionOtherBidDepth: Number(otherBid?.size),
        decisionClGapPct: (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100,
        decisionBzGapPct: Number(feed.openBinance) > 0 && Number(tick.bz) > 0
          ? (Number(tick.bz) / Number(feed.openBinance) - 1) * 100 : null,
        decisionSideSpread: Number(sideAsk?.price) - Number(sideBid?.price),
        decisionExpectedEdge: residualPlan[side]?.expectedEdge ?? null,
        decisionFairProbability: p.signalMode === "residual"
          ? (side === "Up" ? currentResidualFair?.fairUp : 1 - currentResidualFair?.fairUp) : null,
        decisionBrownianProbability: p.signalMode === "residual"
          ? (side === "Up" ? currentResidualFair?.brownianUp : 1 - currentResidualFair?.brownianUp) : null,
        decisionMarketMid: p.signalMode === "residual"
          ? (side === "Up" ? currentResidualFair?.marketMid : 1 - currentResidualFair?.marketMid) : null,
        decisionRole: residualPlan[side]?.role ?? null });
      placements++;
      if (p.signalMode === "residual") {
        if (residualPlan[side]?.role === "reversal") residualReversalPlacements++;
        else if (residualPlan[side]?.role === "independent" || residualPlan[side]?.role === "balance-locked") residualIndependentPlacements++;
        else residualDirectionalPlacements++;
      }
      if (firstPlacementT == null) firstPlacementT = t;
    }
  }
  const payout = feed.winner === "Up" ? up : down;
  const pairedShares = fifoPairedShares;
  const pairedPnl = fifoPairedPnl;
  const tradingPnl = payout - cost;
  const makerRebate = makerFeeEquivalent * p.makerRebateRate;
  const heldToSettlementShares = p.signalMode === "residual" ? Math.abs(up - down)
    : holdResidualSide == null ? 0 : Math.abs(up - down);
  return { slug: feed.slug, startMs: feed.startMs, winner: feed.winner, placements, cancels, rejected, confirmationUnavailable, confirmationGateRejected, overweightCancelTriggers, overweightCancelRequests, residualSignalEntries, residualSignalReversals, residualDirectionalPlacements, residualReversalPlacements, residualIndependentPlacements, residualCancelTriggers, residualCancelRequests, firstTimedExitT, firstTimedExitSide, firstTimedExitClAlignedPct, firstTimedExitBzAlignedPct, firstPlacementT, up, down, makerShares, takerShares, takerBuyShares, takerSellShares, makerFillEvents, takerFillEvents,
    cost, grossBuySpend, grossSellProceeds, fees, makerFeeEquivalent, makerRebate, payout,
    tradingPnl, pnl: tradingPnl + makerRebate, pairedShares, pairedPnl, residualPnl: tradingPnl - pairedPnl,
    signalHoldEvents, signalHoldShares, heldToSettlementShares,
    firstMakerFillT, firstMakerSide, firstMakerPrice, firstMakerPairBidSum, firstMakerSideBidDepth,
    firstMakerOtherBidDepth, firstMakerInitialQueueAhead, firstMakerClGapPct, firstMakerBzGapPct, firstMakerSideSpread,
    firstMakerExpectedEdge, firstMakerFairProbability, firstMakerRole, firstMakerBrownianProbability, firstMakerMarketMid };
}

function bootstrapLower(values, samples, seed) {
  if (!values.length || samples <= 0) return null;
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const totals = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)];
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  return round(totals[Math.floor((totals.length - 1) * .025)]);
}

function summarize(windows) {
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const daily = new Map(), sum = (field) => windows.reduce((total, row) => total + Number(row[field] || 0), 0);
  for (const row of windows) {
    equity += row.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= row.pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + row.pnl);
  }
  const cost = sum("cost"), grossBuySpend = sum("grossBuySpend"), pnl = sum("pnl");
  const dayPnls = [...daily.values()], bootstrapSamples = Number(process.env.MAKER_BOOTSTRAP_SAMPLES || 2000);
  return { windows: windows.length, activeWindows: windows.filter((row) => row.makerShares + row.takerShares > 0).length,
    placements: sum("placements"), cancels: sum("cancels"), rejected: sum("rejected"),
    confirmationUnavailable: sum("confirmationUnavailable"), confirmationGateRejected: sum("confirmationGateRejected"),
    overweightCancelTriggers: sum("overweightCancelTriggers"), overweightCancelRequests: sum("overweightCancelRequests"),
    residualSignalEntries: sum("residualSignalEntries"), residualSignalReversals: sum("residualSignalReversals"),
    residualDirectionalPlacements: sum("residualDirectionalPlacements"),
    residualReversalPlacements: sum("residualReversalPlacements"), residualIndependentPlacements: sum("residualIndependentPlacements"),
    residualCancelTriggers: sum("residualCancelTriggers"), residualCancelRequests: sum("residualCancelRequests"),
    makerFillEvents: sum("makerFillEvents"), takerFillEvents: sum("takerFillEvents"),
    makerShares: round(sum("makerShares")), takerShares: round(sum("takerShares")), takerBuyShares: round(sum("takerBuyShares")),
    takerSellShares: round(sum("takerSellShares")), cost: round(cost), grossBuySpend: round(grossBuySpend),
    grossSellProceeds: round(sum("grossSellProceeds")), fees: round(sum("fees")),
    makerFeeEquivalent: round(sum("makerFeeEquivalent")), makerRebate: round(sum("makerRebate")),
    payout: round(sum("payout")), tradingPnl: round(sum("tradingPnl")), pnl: round(pnl),
    roiPct: grossBuySpend ? round(pnl / grossBuySpend * 100) : 0,
    pairedShares: round(sum("pairedShares")), pairedPnl: round(sum("pairedPnl")), residualPnl: round(sum("residualPnl")),
    signalHoldEvents: sum("signalHoldEvents"), signalHoldShares: round(sum("signalHoldShares")),
    heldToSettlementShares: round(sum("heldToSettlementShares")),
    maxDrawdown: round(maxDrawdown), profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    bootstrapWindowLower95: bootstrapLower(windows.map((row) => row.pnl), bootstrapSamples, 0x3048d653),
    bootstrapDayLower95: bootstrapLower(dayPnls, bootstrapSamples, 0x21be3497),
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])) };
}

const base = {
  orderSize: Number(process.env.MAKER_ORDER_SIZE || 1), minOrderShares: Number(process.env.MAKER_MIN_ORDER_SHARES || 1),
  exposureCap: Number(process.env.MAKER_EXPOSURE_CAP || 1),
  ttlMs: Number(process.env.MAKER_TTL_MS || 3000), cancelLatencyMs: Number(process.env.MAKER_CANCEL_LATENCY_MS || 500),
  takerLatencyMs: Number(process.env.MAKER_TAKER_LATENCY_MS || 520),
  targetMakerLatencyMs: Number(process.env.MAKER_TARGET_LATENCY_MS || 130),
  pauseMakerAboveLatencyMs: Number(process.env.MAKER_PAUSE_ABOVE_LATENCY_MS || 0),
  clMinPct: Number(process.env.MAKER_CL_MIN_PCT || -.05), clMaxPct: Number(process.env.MAKER_CL_MAX_PCT || -.01),
  priceMin: Number(process.env.MAKER_PRICE_MIN || .12), priceMax: Number(process.env.MAKER_PRICE_MAX || .89),
  minTimeS: Number(process.env.MAKER_MIN_TIME_S || 0), maxTimeS: Number(process.env.MAKER_MAX_TIME_S || 285),
  bidOffset: Number(process.env.MAKER_BID_OFFSET || 0), postOnly: process.env.MAKER_POST_ONLY === "1",
  fillSource: process.env.MAKER_FILL_SOURCE === "trades" ? "trades" : "depth",
  tradePriceMode: process.env.MAKER_TRADE_PRICE_MODE === "sweep" ? "sweep" : "exact",
  signalMode: process.env.MAKER_SIGNAL_MODE === "residual" ? "residual"
    : process.env.MAKER_SIGNAL_MODE === "twoSided" ? "twoSided" : "chainlink",
  pairQuoteCap: Number(process.env.MAKER_PAIR_QUOTE_CAP || .98), pairCostCap: Number(process.env.MAKER_PAIR_COST_CAP || .98),
  endCompleteS: Number(process.env.MAKER_END_COMPLETE_S || 0), pairCompleteCap: Number(process.env.MAKER_PAIR_COMPLETE_CAP || .99),
  safeHedgeEveryTick: process.env.MAKER_SAFE_HEDGE_EVERY_TICK === "1",
  makerRebateRate: Number(process.env.MAKER_REBATE_RATE || 0),
  timeoutSignalHold: process.env.MAKER_TIMEOUT_SIGNAL_HOLD === "1",
  signalHoldMinTimeS: Number(process.env.MAKER_SIGNAL_HOLD_MIN_TIME_S || 0),
  signalHoldClMinPct: Number(process.env.MAKER_SIGNAL_HOLD_CL_MIN_PCT || 0),
  signalHoldBzMinPct: Number(process.env.MAKER_SIGNAL_HOLD_BZ_MIN_PCT || 0),
  balancedInventoryPairBidCap: Number(process.env.MAKER_BALANCED_INVENTORY_PAIR_BID_CAP || 0),
  confirmPairQuoteCap: Number(process.env.MAKER_CONFIRM_PAIR_QUOTE_CAP || 0),
  confirmMaxAgeMs: Number(process.env.MAKER_CONFIRM_MAX_AGE_MS || 1000),
  conservativeConfirmQueue: process.env.MAKER_CONSERVATIVE_CONFIRM_QUEUE === "1",
  cancelOverweightOnFill: process.env.MAKER_CANCEL_OVERWEIGHT_ON_FILL === "1",
  openingSignalEntry: process.env.MAKER_OPENING_SIGNAL_ENTRY === "1",
  openingSignalMinPct: Number(process.env.MAKER_OPENING_SIGNAL_MIN_PCT || 0),
  openingSignalSkewTicks: Number(process.env.MAKER_OPENING_SIGNAL_SKEW_TICKS || 0),
  openingSignalRequireAgreement: process.env.MAKER_OPENING_SIGNAL_REQUIRE_AGREEMENT === "1",
  residualChainlinkWeight: Number(process.env.MAKER_RESIDUAL_CHAINLINK_WEIGHT || .7),
  residualMarketWeight: Number(process.env.MAKER_RESIDUAL_MARKET_WEIGHT || .5),
  residualVolLookbackS: Number(process.env.MAKER_RESIDUAL_VOL_LOOKBACK_S || 60),
  residualVolFloorPctPerSqrtS: Number(process.env.MAKER_RESIDUAL_VOL_FLOOR_PCT || .006),
  residualSpotMinGapPct: Number(process.env.MAKER_RESIDUAL_SPOT_MIN_GAP_PCT || .002),
  residualEntryProbability: Number(process.env.MAKER_RESIDUAL_ENTRY_PROBABILITY || .55),
  residualReversalProbability: Number(process.env.MAKER_RESIDUAL_REVERSAL_PROBABILITY || .55),
  residualMinExpectedEdge: Number(process.env.MAKER_RESIDUAL_MIN_EXPECTED_EDGE || .03),
  residualIndependentMinExpectedEdge: Number(process.env.MAKER_RESIDUAL_INDEPENDENT_MIN_EXPECTED_EDGE || .08),
  residualLargeExpectedEdge: Number(process.env.MAKER_RESIDUAL_LARGE_EXPECTED_EDGE || .08),
  residualLargeMinProbability: Number(process.env.MAKER_RESIDUAL_LARGE_MIN_PROBABILITY || .5),
  residualBaseOrderShares: Number(process.env.MAKER_RESIDUAL_BASE_ORDER_SHARES || 5),
  residualLargeOrderShares: Number(process.env.MAKER_RESIDUAL_LARGE_ORDER_SHARES || 15),
  residualBalanceShares: Number(process.env.MAKER_RESIDUAL_BALANCE_SHARES || 5),
  residualTargetShares: Number(process.env.MAKER_RESIDUAL_TARGET_SHARES || 10),
  residualGrossCapShares: Number(process.env.MAKER_RESIDUAL_GROSS_CAP_SHARES || 60),
  residualLockedPairCostCap: Number(process.env.MAKER_RESIDUAL_LOCKED_PAIR_COST_CAP || .97),
  residualLockedPairImproveTicks: Number(process.env.MAKER_RESIDUAL_LOCKED_PAIR_IMPROVE_TICKS || 0),
  residualLockedPairTtlMs: Number(process.env.MAKER_RESIDUAL_LOCKED_PAIR_TTL_MS || 0),
  residualDirectionalMaxTimeS: Number(process.env.MAKER_RESIDUAL_DIRECTIONAL_MAX_TIME_S || 285),
  residualMinMarketProbability: Number(process.env.MAKER_RESIDUAL_MIN_MARKET_PROBABILITY || 0),
  residualMaxSpotMarketProbabilityGap: process.env.MAKER_RESIDUAL_MAX_SPOT_MARKET_PROBABILITY_GAP == null
    ? Infinity : Number(process.env.MAKER_RESIDUAL_MAX_SPOT_MARKET_PROBABILITY_GAP),
  residualCancelInvalidOrders: process.env.MAKER_RESIDUAL_CANCEL_INVALID_ORDERS === "1",
  residualCancelRepricedOrders: process.env.MAKER_RESIDUAL_CANCEL_REPRICED_ORDERS === "1",
  residualRepriceTicks: Number(process.env.MAKER_RESIDUAL_REPRICE_TICKS || 1),
  residualMaxAskDepth1: process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH1 == null ? Infinity : Number(process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH1),
  residualMaxAskDepth3: process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH3 == null ? Infinity : Number(process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH3),
  residualMinTopDepthImbalance: process.env.MAKER_RESIDUAL_MIN_TOP_IMBALANCE == null ? -Infinity : Number(process.env.MAKER_RESIDUAL_MIN_TOP_IMBALANCE),
  residualMinDepth3Imbalance: process.env.MAKER_RESIDUAL_MIN_DEPTH3_IMBALANCE == null ? -Infinity : Number(process.env.MAKER_RESIDUAL_MIN_DEPTH3_IMBALANCE),
  residualMinMicropriceBias: process.env.MAKER_RESIDUAL_MIN_MICROPRICE_BIAS == null ? -Infinity : Number(process.env.MAKER_RESIDUAL_MIN_MICROPRICE_BIAS),
  residualMaxAskDepth3Change5: process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH3_CHANGE5 == null ? Infinity : Number(process.env.MAKER_RESIDUAL_MAX_ASK_DEPTH3_CHANGE5),
  timeoutCompleteCap: process.env.MAKER_TIMEOUT_COMPLETE_CAP == null ? null : Number(process.env.MAKER_TIMEOUT_COMPLETE_CAP),
  endLiquidateS: Number(process.env.MAKER_END_LIQUIDATE_S || 0),
  unpairedTimeoutS: Number(process.env.MAKER_UNPAIRED_TIMEOUT_S || 0),
  hedgeImproveTicks: Number(process.env.MAKER_HEDGE_IMPROVE_TICKS || 0),
};
const policies = (() => {
  const file = String(process.env.MAKER_POLICIES_FILE || "").trim();
  if (!file) return [{ name: "base" }];
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed?.policies;
  const defaults = Array.isArray(parsed) ? {} : parsed?.defaults || {};
  if (!Array.isArray(rows) || !rows.length) throw new Error("MAKER_POLICIES_FILE must contain a non-empty array or {defaults, policies}");
  return rows.map((policy, index) => ({ ...defaults, ...policy, name: String(policy.name || `policy${index}`) }));
})();
const configs = [];
for (const policy of policies)
  for (const latencyMs of envNumbers("MAKER_LATENCIES", [130]))
    for (const makerCredit of envNumbers("MAKER_CREDITS", [.1, .25, .5]))
      {
        const config = { ...base, ...policy, latencyMs, makerCredit };
        const threshold = Number(config.highLatencyThresholdMs);
        const highLatencyMinTimeS = Number(config.highLatencyMinTimeS);
        const highLatencyUnpairedTimeoutS = Number(config.highLatencyUnpairedTimeoutS);
        const targetMakerLatencyMs = Number(config.targetMakerLatencyMs);
        const pauseMakerAboveLatencyMs = Number(config.pauseMakerAboveLatencyMs);
        config.effectiveMakerLatencyMs = Number.isFinite(targetMakerLatencyMs) && targetMakerLatencyMs > 0
          ? Math.max(latencyMs, targetMakerLatencyMs) : latencyMs;
        config.makerTradingEnabled = !(Number.isFinite(pauseMakerAboveLatencyMs) && pauseMakerAboveLatencyMs > 0
          && latencyMs > pauseMakerAboveLatencyMs);
        config.effectiveMinTimeS = Number.isFinite(threshold) && Number.isFinite(highLatencyMinTimeS) && latencyMs >= threshold
          ? highLatencyMinTimeS : config.minTimeS;
        config.effectiveUnpairedTimeoutS = Number.isFinite(threshold) && Number.isFinite(highLatencyUnpairedTimeoutS) && latencyMs >= threshold
          ? highLatencyUnpairedTimeoutS : config.unpairedTimeoutS;
        configs.push(config);
      }

const metas = discover(), windowsByKey = new Map(configs.map((p) => [`${p.name}_${p.latencyMs}ms_credit${p.makerCredit}`, []]));
let loaded = 0, failed = 0;
for (const meta of metas) {
  try {
    const feed = normalize(meta);
    if (!feed) { failed++; continue; }
    loaded++;
    for (const p of configs) windowsByKey.get(`${p.name}_${p.latencyMs}ms_credit${p.makerCredit}`).push(replayWindow(feed, p));
  } catch {
    failed++;
    normalizationFailures.exception = (normalizationFailures.exception || 0) + 1;
  }
}
const diagnostics = {};
for (const p of configs) {
  const key = `${p.name}_${p.latencyMs}ms_credit${p.makerCredit}`;
  diagnostics[key] = { params: p, ...summarize(windowsByKey.get(key)),
    ...(process.env.MAKER_INCLUDE_WINDOWS === "1" ? { windowsDetail: windowsByKey.get(key) } : {}) };
}
const output = {
  schema: 1, generatedAt: new Date().toISOString(),
  methodology: "causal passive GTC replay: public CLOB plus official RTDS TWAP-60 controls only; optional independent v2/v4 orderbook confirmation is fail-closed for opening-cycle decisions and uses the more conservative bid; confirmed normalized market-wide taker prints at the exact one-cent maker level consume visible queue ahead before a shared, FIFO, volume-conserved maker-credit budget; post-only arrival checks; crypto taker fee 0.07*p*(1-p)*shares rounded to five decimals per consumed price level; maker rebates are an explicit policy sensitivity equal to makerRebateRate times each maker fill's same-curve fee equivalent and are reported separately from trading PnL; settlement outcome used only for PnL",
  range: { from: new Date(FROM_MS).toISOString(), to: new Date(TO_MS).toISOString(), discovered: metas.length, loaded, failed,
    normalizationFailures },
  base, policies, diagnostics,
};
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
if (process.env.MAKER_QUIET === "1") console.log(JSON.stringify({ generatedAt: output.generatedAt, range: output.range }));
else console.log(JSON.stringify(output, null, 2));
