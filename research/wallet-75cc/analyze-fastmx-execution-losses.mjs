#!/usr/bin/env node
// Diagnose where the current dual-velocity execution policy earns and loses.
// Direction is unchanged: both current signals must qualify and agree.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fillFee, isFeeFill } from "../../engine/fees.js";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const dataRoot = path.resolve(process.argv[2] || "data/wallet-75cc");
const resultRoot = path.resolve(process.argv[3] || "research/wallet-75cc/results");
const cohortFile = path.join(dataRoot, "cohort-2026-08-16_2026-08-26-btc.json");
const feedDir = path.join(dataRoot, "feeds/v2-l2");
const outputJson = path.join(resultRoot, "fastmx-execution-loss-diagnosis-2026-08-27.json");
const params = { ...STRAT, H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true };
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const markets = cohort.markets.filter((market) => market.winner && market.slug.startsWith("btc-")
  && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((left, right) => startMs(left.slug) - startMs(right.slug));

function nestedBook(raw) {
  const asks = raw?.asks || [], bids = raw?.bids || [];
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

function stat(rows) {
  const pnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  const fee = rows.reduce((sum, row) => sum + row.fee, 0);
  const wins = rows.filter((row) => row.pnl > 0).length;
  return { count: rows.length, cost: round(cost), fee: round(fee), pnl: round(pnl),
    roiPct: cost + fee > 0 ? round(pnl / (cost + fee) * 100, 3) : null,
    winRatePct: rows.length ? round(wins / rows.length * 100, 3) : null };
}

function grouped(rows, key) {
  return Object.fromEntries([...new Set(rows.map(key))].sort().map((value) =>
    [value, stat(rows.filter((row) => key(row) === value))]));
}

function priceBin(px) {
  const lo = Math.floor((px + 1e-9) * 10) / 10;
  return `${lo.toFixed(1)}-${Math.min(1, lo + 0.1).toFixed(1)}`;
}

function timeBin(t) {
  const lo = Math.floor(t / 30) * 30;
  return `${lo}-${lo + 30}s`;
}

function resultForPrefix(fills, winner, ticks, count) {
  const selected = fills.slice(0, count);
  const pos = positionFromFills(selected, winner, ticks);
  return { orders: selected.length, pnl: pos.realizedPnl, cost: pos.totalCost, fee: pos.fee };
}

const fillRows = [], windowRows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = (feed.ticks || []).map((tick) => {
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    return { t: (tick.ms - ws) / 1000, ms: tick.ms, bz: tick.bz, cl: tick.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid,
      up, down };
  });
  const fills = simulateFills({ ticks, openBinance: feed.openBinance,
    openPrice: feed.openChainlink, windowStart: ws / 1000 }, params);
  const pos = positionFromFills(fills, market.winner, ticks);
  for (let fillIndex = 0; fillIndex < fills.length; fillIndex++) {
    const fill = fills[fillIndex];
    const fee = fillFee(fill.effPx ?? fill.usdc / fill.shares, fill.shares, isFeeFill(fill));
    const pnl = (fill.side === market.winner ? fill.shares : 0) - fill.usdc - fee;
    fillRows.push({ slug: market.slug, day: new Date(ws).toISOString().slice(0, 10),
      fillIndex: fillIndex + 1, role: fill.role || fill.leg || "unknown", side: fill.side,
      winner: market.winner, correct: fill.side === market.winner,
      t: fill.tInto, px: fill.effPx, cost: fill.usdc, fee, pnl,
      midVelocity: fill.signal?.midVelocity ?? null,
      binanceGapVelocity: fill.signal?.binanceGapVelocity ?? null });
  }
  const grossWinnerShares = market.winner === "Up" ? pos.upShares : pos.downShares;
  const grossLoserShares = market.winner === "Up" ? pos.downShares : pos.upShares;
  const dominant = pos.upShares > pos.downShares ? "Up" : pos.downShares > pos.upShares ? "Down" : "Flat";
  windowRows.push({ slug: market.slug, day: new Date(ws).toISOString().slice(0, 10), winner: market.winner,
    orders: fills.length, pnl: pos.realizedPnl, cost: pos.totalCost, fee: pos.fee,
    upShares: pos.upShares, downShares: pos.downShares, dominant,
    dominantCorrect: dominant === market.winner,
    winnerMinusLoserShares: grossWinnerShares - grossLoserShares,
    prefixes: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, resultForPrefix(fills, market.winner, ticks, n)])) });
  if ((index + 1) % 100 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: "execution-diagnosis", done: index + 1, total: markets.length }));
  }
}

const activeWindows = windowRows.filter((row) => row.orders > 0);
const prefixRows = (n) => windowRows.map((row) => row.prefixes[n]).filter((row) => row.orders > 0);
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  params,
  totals: { windows: windowRows.length, activeWindows: activeWindows.length,
    windowPerformance: stat(activeWindows), fillPerformance: stat(fillRows),
    dominantSideCorrectPct: activeWindows.length
      ? round(activeWindows.filter((row) => row.dominantCorrect).length / activeWindows.length * 100, 3) : null,
    meanWinnerMinusLoserShares: activeWindows.length
      ? round(activeWindows.reduce((sum, row) => sum + row.winnerMinusLoserShares, 0) / activeWindows.length) : null },
  fillByRole: grouped(fillRows, (row) => row.role),
  fillByOrderIndex: grouped(fillRows, (row) => String(row.fillIndex)),
  fillByPrice: grouped(fillRows, (row) => priceBin(row.px)),
  fillByTime: grouped(fillRows, (row) => timeBin(row.t)),
  exactMaxOrderPrefixes: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, stat(prefixRows(n))])),
  dailyWindows: grouped(activeWindows, (row) => row.day),
  windows: windowRows,
  caveat: "Descriptive replay diagnostics, not a parameter-selection result or a guarantee of future returns.",
};

fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputJson, totals: report.totals, fillByRole: report.fillByRole,
  fillByOrderIndex: report.fillByOrderIndex, fillByPrice: report.fillByPrice,
  fillByTime: report.fillByTime, exactMaxOrderPrefixes: report.exactMaxOrderPrefixes }, null, 2));
