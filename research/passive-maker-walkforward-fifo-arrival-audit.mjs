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
import { dueMakerArrivals } from "./passive-maker-arrival-order.mjs";
import { assessDustLock } from "./passive-maker-dust-lock.mjs";
import { validVenueOrderShares } from "./passive-maker-order-minimum.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FROM_MS = Date.parse(process.argv[2] || "2026-08-21T19:55:00Z");
const TO_MS = Date.parse(process.argv[3] || "2026-08-25T00:00:00Z");
const OUTPUT = path.resolve(process.argv[4] || path.join(ROOT, "data/research/passive-maker-walkforward.json"));
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");

const splitList = (name, fallback) => String(process.env[name] || fallback).split(path.delimiter).filter(Boolean);
const L2_DIRS = splitList("MAKER_L2_DIRS", [
  path.join(ROOT, "data/lockstep-v4-top"),
].join(path.delimiter));
const V2_DIRS = splitList("MAKER_V2_DIRS", [
  path.join(ROOT, "data/passive-maker-forward-v15/feeds/v2"),
].join(path.delimiter));
const TRADE_DIRS = splitList("MAKER_TRADE_DIRS", [
  path.join(ROOT, "data/passive-maker-forward-v15/feeds/market-trades"),
].join(path.delimiter));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const slugStart = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
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
  const l2 = new Map(), v2 = new Map(), trades = new Map();
  for (const dir of L2_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8), startMs = slugStart(slug);
      if (startMs >= FROM_MS && startMs < TO_MS && !l2.has(slug)) l2.set(slug, path.join(dir, name));
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
  return [...l2].map(([slug, l2File]) => ({ slug, l2File, v2File: v2.get(slug), tradeFile: trades.get(slug) }))
    .filter((row) => row.v2File && (process.env.MAKER_FILL_SOURCE !== "trades" || row.tradeFile))
    .sort((a, b) => slugStart(a.slug) - slugStart(b.slug));
}

function normalize(meta) {
  const raw = readGzip(meta.l2File), rtds = readGzip(meta.v2File);
  const openChainlink = Number(rtds.openChainlink);
  const winner = /^up$/i.test(raw.winner) ? "Up" : /^down$/i.test(raw.winner) ? "Down" : null;
  if (!(openChainlink > 0) || !winner) return null;
  const rtdsTicks = (rtds.ticks || []).map((tick) => ({ ms: Number(tick.ms), cl: Number(tick.cl) }))
    .filter((tick) => Number.isFinite(tick.ms) && tick.cl > 0).sort((a, b) => a.ms - b.ms);
  let cursor = -1, cl = null;
  const ticks = (raw.ticks || []).map((tick) => {
    const ms = Number(tick.ms ?? Date.parse(tick.time || ""));
    while (cursor + 1 < rtdsTicks.length && rtdsTicks[cursor + 1].ms <= ms) cl = rtdsTicks[++cursor].cl;
    return { ms, cl, up: tick.up, down: tick.down };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.cl > 0 && tick.up && tick.down).sort((a, b) => a.ms - b.ms);
  const trades = meta.tradeFile ? (readGzip(meta.tradeFile).trades || []).map((trade) => ({
    ...trade, ms: Number(trade.ms), price: Number(trade.price), size: Number(trade.size),
  })).filter((trade) => Number.isFinite(trade.ms) && (trade.side === "SELL" || trade.side === "PAIR_BUY") && trade.size > 0).sort((a, b) => a.ms - b.ms) : [];
  return ticks.length > 20 ? { slug: meta.slug, startMs: slugStart(meta.slug), openChainlink, winner, ticks, trades } : null;
}

function sideBook(tick, side) { return side === "Up" ? tick.up : tick.down; }
function sortedRows(rows, direction) {
  return (rows || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => row.price >= .01 && row.price <= .99 && row.size > 0).sort((a, b) => direction * (a.price - b.price));
}
function bids(tick, side) { return sortedRows(sideBook(tick, side)?.bids, -1); }
function asks(tick, side) { return sortedRows(sideBook(tick, side)?.asks, 1); }
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
  let makerShares = 0, takerShares = 0, takerBuyShares = 0, takerSellShares = 0;
  let upCost = 0, downCost = 0;
  let placements = 0, cancels = 0, rejected = 0, makerFillEvents = 0, takerFillEvents = 0, firstPlacementT = null;
  let dustLocks = 0, dustLocked = false;
  const arriving = [], pending = [], safeHedges = [], liquidations = [];
  let nextOrderSequence = 1;
  let tradeCursor = 0;
  let imbalanceSinceMs = null, imbalanceSide = null;
  const inventory = (side) => side === "Up" ? up : down;
  const committed = (side) => arriving.concat(pending, safeHedges).filter((order) => order.side === side).reduce((sum, order) => sum + order.shares, 0);
  const apply = (side, shares, price, taker, exactFee = null) => {
    const chargedFee = taker ? (Number.isFinite(exactFee) ? exactFee : fee(price, shares)) : 0;
    cost += price * shares + chargedFee; grossBuySpend += price * shares + chargedFee; fees += chargedFee;
    if (side === "Up") upCost += price * shares + chargedFee; else downCost += price * shares + chargedFee;
    if (taker) { takerShares += shares; takerBuyShares += shares; takerFillEvents++; }
    else { makerShares += shares; makerFillEvents++; }
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
    takerShares += shares; takerSellShares += shares; takerFillEvents++;
  };

  for (const tick of feed.ticks) {
    const t = (tick.ms - feed.startMs) / 1000;

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
      if (hedge.kind === "dustLock") {
        const fill = executeTaker(tick, hedge.side, hedge.shares, .99);
        if (fill && fill.shares + 1e-9 >= hedge.shares) {
          const lock = assessDustLock({ up, down, cost, buySide: hedge.side, buyShares: fill.shares,
            buyCost: fill.cost, buyFees: fill.fees, minOrderShares: p.minOrderShares,
            minProfit: Number(p.dustLockMinProfit || 0) });
          if (lock.allowed) {
            apply(hedge.side, fill.shares, fill.price, true, fill.fees);
            dustLocks++;
            dustLocked = true;
          }
        }
        continue;
      }
      const fill = executeSafeTaker(tick, hedge.side, hedge.shares, hedge.heldUnitCost, p.pairCompleteCap);
      if (fill) apply(hedge.side, fill.shares, fill.price, true, fill.fees);
    }

    // Several orders can become due between two v4 snapshots. Stage them in
    // actual submission order so queue-ahead and the later fill allocator use
    // the same FIFO ordering. Reverse-index removal would stage the newest
    // same-price order first and then incorrectly put it ahead of the older
    // order when calculating own queue.
    const dueArrivals = dueMakerArrivals(arriving, tick.ms);
    for (const order of dueArrivals) {
      arriving.splice(arriving.indexOf(order), 1);
      const bestAsk = asks(tick, order.side)[0]?.price;
      if (bestAsk != null && bestAsk <= order.price + 1e-9) {
        if (p.postOnly) { rejected++; continue; }
        const fill = executeTaker(tick, order.side, order.shares, order.price);
        if (fill) { apply(order.side, fill.shares, fill.price, true, fill.fees); order.shares -= fill.shares; }
      }
      if (order.shares > 1e-9) {
        const visible = bidDepth(tick, order.side, order.price);
        const ownAhead = pending.filter((row) => row.side === order.side && Math.abs(row.price - order.price) < .005)
          .reduce((sum, row) => sum + row.shares, 0);
        pending.push({ ...order, effectiveArrivalMs: tick.ms, expiresMs: tick.ms + p.ttlMs + p.cancelLatencyMs,
          queueAhead: visible + ownAhead, lastVisible: visible });
      }
    }

    if (p.fillSource === "trades") {
      while (tradeCursor < feed.trades.length && feed.trades[tradeCursor].ms <= tick.ms) {
        const trade = feed.trades[tradeCursor++];
        const matching = [];
        for (const order of pending) {
          const priceMatches = p.tradePriceMode === "exact"
            ? Math.abs(trade.price - order.price) < .005
            : trade.price <= order.price + 1e-9;
          if (trade.ms < order.effectiveArrivalMs || trade.ms > order.expiresMs || trade.outcome !== order.side || !priceMatches) continue;
          matching.push(order);
        }
        for (const { order, shares } of allocateConservedMakerFills(matching, trade.size, p.makerCredit))
          apply(order.side, shares, order.price, false);
        for (let index = pending.length - 1; index >= 0; index--) if (pending[index].shares <= 1e-9) pending.splice(index, 1);
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        if (tick.ms > pending[index].expiresMs) { pending.splice(index, 1); cancels++; }
      }
    } else {
      for (let index = pending.length - 1; index >= 0; index--) {
        const order = pending[index];
        if (tick.ms > order.expiresMs) { pending.splice(index, 1); cancels++; continue; }
        const visible = bidDepth(tick, order.side, order.price);
        let removed = Math.max(0, order.lastVisible - visible);
        const ahead = Math.min(order.queueAhead, removed);
        order.queueAhead -= ahead; removed -= ahead;
        const shares = Math.min(order.shares, removed * p.makerCredit);
        if (shares > 1e-9) { apply(order.side, shares, order.price, false); order.shares -= shares; }
        order.lastVisible = visible;
        if (order.shares <= 1e-9) pending.splice(index, 1);
      }
    }

    if (p.signalMode === "twoSided" && p.endCompleteS > 0 && t >= p.endCompleteS && safeHedges.length === 0) {
      const imbalance = up - down;
      if (validVenueOrderShares(Math.abs(imbalance), p.minOrderShares)) {
        const missingSide = imbalance > 0 ? "Down" : "Up";
        if (committed(missingSide) <= 1e-9) {
          const heldShares = imbalance > 0 ? up : down, heldCost = imbalance > 0 ? upCost : downCost;
          const heldUnitCost = heldShares > 0 ? heldCost / heldShares : Infinity;
          const bestAsk = asks(tick, missingSide)[0]?.price;
          if (Number.isFinite(bestAsk) && heldUnitCost + bestAsk + fee(bestAsk, 1) <= p.pairCompleteCap + 1e-9) {
            safeHedges.push({ side: missingSide, shares: Math.abs(imbalance), heldUnitCost, arrivalMs: tick.ms + p.takerLatencyMs });
          }
        }
      }
    }

    const currentImbalance = up - down;
    const currentImbalanceSide = currentImbalance > 1e-9 ? "Up" : currentImbalance < -1e-9 ? "Down" : null;
    if (!currentImbalanceSide) { imbalanceSinceMs = null; imbalanceSide = null; }
    else if (imbalanceSide !== currentImbalanceSide) { imbalanceSinceMs = tick.ms; imbalanceSide = currentImbalanceSide; }
    const timedRiskExit = p.effectiveUnpairedTimeoutS > 0 && Math.abs(currentImbalance) + 1e-9 >= p.minOrderShares && imbalanceSinceMs != null
      && tick.ms - imbalanceSinceMs >= p.effectiveUnpairedTimeoutS * 1000;

    const dustCompletionReady = Number(p.dustCompleteS || 0) > 0 && t >= Number(p.dustCompleteS)
      && !dustLocked && currentImbalanceSide && Math.abs(currentImbalance) < p.minOrderShares - 1e-9
      && arriving.length === 0 && pending.length === 0 && safeHedges.length === 0 && liquidations.length === 0;
    if (dustCompletionReady) safeHedges.push({ kind: "dustLock",
      side: currentImbalance > 0 ? "Down" : "Up", shares: p.minOrderShares,
      arrivalMs: tick.ms + p.takerLatencyMs });

    if (timedRiskExit && arriving.length === 0 && pending.length === 0 && safeHedges.length === 0 && liquidations.length === 0) {
      liquidations.push({ side: currentImbalanceSide, shares: Math.abs(currentImbalance), arrivalMs: tick.ms + p.takerLatencyMs });
    }

    if (p.signalMode === "twoSided" && p.endLiquidateS > 0 && t >= p.endLiquidateS
      && arriving.length === 0 && pending.length === 0 && safeHedges.length === 0 && liquidations.length === 0) {
      const imbalance = up - down;
      if (Math.abs(imbalance) > 1e-9) liquidations.push({
        side: imbalance > 0 ? "Up" : "Down", shares: Math.abs(imbalance), arrivalMs: tick.ms + p.takerLatencyMs,
      });
    }

    if (dustLocked || !p.makerTradingEnabled || t < p.effectiveMinTimeS || t >= p.maxTimeS || timedRiskExit || liquidations.length > 0 || !Number.isFinite(tick.cl)) continue;
    const currentLimits = { Up: round((bids(tick, "Up")[0]?.price ?? NaN) + p.bidOffset, 2), Down: round((bids(tick, "Down")[0]?.price ?? NaN) + p.bidOffset, 2) };
    const projected = { Up: up + committed("Up"), Down: down + committed("Down") };
    const wanted = p.signalMode === "twoSided"
      ? projected.Up > projected.Down + 1e-9 ? new Set(["Down"])
        : projected.Down > projected.Up + 1e-9 ? new Set(["Up"]) : new Set(["Up", "Down"])
      : null;
    if (p.signalMode === "twoSided" && wanted.size === 2
      && (!Number.isFinite(currentLimits.Up) || !Number.isFinite(currentLimits.Down) || currentLimits.Up + currentLimits.Down > p.pairQuoteCap + 1e-9)) continue;
    for (const side of ["Up", "Down"]) {
      if (wanted && !wanted.has(side)) continue;
      if (inventory(side) + committed(side) >= p.exposureCap - 1e-9) continue;
      const sign = side === "Up" ? 1 : -1;
      const alignedGapPct = (tick.cl - feed.openChainlink) / feed.openChainlink * 100 * sign;
      if (!wanted && (alignedGapPct < p.clMinPct || alignedGapPct > p.clMaxPct)) continue;
      let limit = currentLimits[side];
      if (!Number.isFinite(limit)) continue;
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
      const shares = Math.min(Math.max(p.orderSize, p.minOrderShares), p.exposureCap - inventory(side) - committed(side));
      if (shares + 1e-9 < p.minOrderShares) continue;
      arriving.push({ side, price: limit, shares, arrivalMs: tick.ms + p.effectiveMakerLatencyMs,
        sequence: nextOrderSequence++ });
      placements++;
      if (firstPlacementT == null) firstPlacementT = t;
    }
  }
  const payout = feed.winner === "Up" ? up : down;
  const pairedShares = Math.min(up, down);
  const pairedUnitCost = (up > 1e-9 ? upCost / up : 0) + (down > 1e-9 ? downCost / down : 0);
  const pairedPnl = pairedShares * (1 - pairedUnitCost);
  return { slug: feed.slug, startMs: feed.startMs, winner: feed.winner, placements, cancels, rejected, firstPlacementT, up, down, makerShares, takerShares, takerBuyShares, takerSellShares, makerFillEvents, takerFillEvents, dustLocks,
    cost, grossBuySpend, grossSellProceeds, fees, payout, pnl: payout - cost, pairedShares, pairedPnl, residualPnl: payout - cost - pairedPnl };
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
    makerFillEvents: sum("makerFillEvents"), takerFillEvents: sum("takerFillEvents"), dustLocks: sum("dustLocks"),
    makerShares: round(sum("makerShares")), takerShares: round(sum("takerShares")), takerBuyShares: round(sum("takerBuyShares")),
    takerSellShares: round(sum("takerSellShares")), cost: round(cost), grossBuySpend: round(grossBuySpend),
    grossSellProceeds: round(sum("grossSellProceeds")), fees: round(sum("fees")),
    payout: round(sum("payout")), pnl: round(pnl), roiPct: grossBuySpend ? round(pnl / grossBuySpend * 100) : 0,
    pairedShares: round(sum("pairedShares")), pairedPnl: round(sum("pairedPnl")), residualPnl: round(sum("residualPnl")),
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
  targetMakerLatencyMs: Number(process.env.MAKER_TARGET_LATENCY_MS || 0),
  pauseMakerAboveLatencyMs: Number(process.env.MAKER_PAUSE_ABOVE_LATENCY_MS || 0),
  clMinPct: Number(process.env.MAKER_CL_MIN_PCT || -.05), clMaxPct: Number(process.env.MAKER_CL_MAX_PCT || -.01),
  priceMin: Number(process.env.MAKER_PRICE_MIN || .12), priceMax: Number(process.env.MAKER_PRICE_MAX || .89),
  minTimeS: Number(process.env.MAKER_MIN_TIME_S || 0), maxTimeS: Number(process.env.MAKER_MAX_TIME_S || 285),
  bidOffset: Number(process.env.MAKER_BID_OFFSET || 0), postOnly: process.env.MAKER_POST_ONLY === "1",
  fillSource: process.env.MAKER_FILL_SOURCE === "trades" ? "trades" : "depth",
  tradePriceMode: process.env.MAKER_TRADE_PRICE_MODE === "sweep" ? "sweep" : "exact",
  signalMode: process.env.MAKER_SIGNAL_MODE === "twoSided" ? "twoSided" : "chainlink",
  pairQuoteCap: Number(process.env.MAKER_PAIR_QUOTE_CAP || .98), pairCostCap: Number(process.env.MAKER_PAIR_COST_CAP || .98),
  endCompleteS: Number(process.env.MAKER_END_COMPLETE_S || 0), pairCompleteCap: Number(process.env.MAKER_PAIR_COMPLETE_CAP || .99),
  endLiquidateS: Number(process.env.MAKER_END_LIQUIDATE_S || 0),
  unpairedTimeoutS: Number(process.env.MAKER_UNPAIRED_TIMEOUT_S || 0),
  hedgeImproveTicks: Number(process.env.MAKER_HEDGE_IMPROVE_TICKS || 0),
};
const policies = (() => {
  const file = String(process.env.MAKER_POLICIES_FILE || "").trim();
  if (!file) return [{ name: "base" }];
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("MAKER_POLICIES_FILE must contain a non-empty array");
  return parsed.map((policy, index) => ({ name: String(policy.name || `policy${index}`), ...policy }));
})();
const configs = [];
for (const policy of policies)
  for (const latencyMs of envNumbers("MAKER_LATENCIES", [130, 200, 300, 520]))
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
  } catch { failed++; }
}
const diagnostics = {};
for (const p of configs) {
  const key = `${p.name}_${p.latencyMs}ms_credit${p.makerCredit}`;
  diagnostics[key] = { params: p, ...summarize(windowsByKey.get(key)),
    ...(process.env.MAKER_INCLUDE_WINDOWS === "1" ? { windowsDetail: windowsByKey.get(key) } : {}) };
}
const output = {
  schema: 1, generatedAt: new Date().toISOString(),
  methodology: "causal passive GTC replay with FIFO same-snapshot arrival staging: public CLOB plus official RTDS TWAP-60 controls only; confirmed normalized market-wide taker prints at the exact one-cent maker level consume visible queue ahead before a shared, FIFO, volume-conserved maker-credit budget; post-only arrival checks; crypto taker fee 0.07*p*(1-p)*shares rounded to five decimals per consumed price level; settlement outcome used only for PnL",
  range: { from: new Date(FROM_MS).toISOString(), to: new Date(TO_MS).toISOString(), discovered: metas.length, loaded, failed },
  base, policies, diagnostics,
};
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
if (process.env.MAKER_QUIET === "1") console.log(JSON.stringify({ generatedAt: output.generatedAt, range: output.range }));
else console.log(JSON.stringify(output, null, 2));
