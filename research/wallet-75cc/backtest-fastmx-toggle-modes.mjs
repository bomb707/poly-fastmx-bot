#!/usr/bin/env node
// Paired exact-engine replay of the two supported FastMX toggle modes:
//   1. Binance gap velocity only
//   2. CLOB midpoint velocity + Binance gap velocity agreement
// Every market is decoded once, then both modes receive the same causal ticks,
// 520 ms execution delay, future visible L2, fee model, and order safeguards.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const dataRoot = path.resolve(process.argv[2] || "data/wallet-75cc");
const resultRoot = path.resolve(process.argv[3] || "research/wallet-75cc/results");
const splitMs = Date.parse(process.argv[4] || "2026-08-22T00:00:00Z");
const cohortFile = path.join(dataRoot, "cohort-2026-08-16_2026-08-26-btc.json");
const feedDir = path.join(dataRoot, "feeds/v2-l2");
const outputJson = path.join(resultRoot, "fastmx-toggle-backtest-2026-08-27.json");
const outputMd = path.join(resultRoot, "fastmx-toggle-backtest-2026-08-27.md");

const modes = {
  binanceOnly: {
    ...STRAT,
    H_CLOB_MID_VELOCITY_ON: false,
    H_BINANCE_GAP_MOMENTUM_ON: true,
  },
  both: {
    ...STRAT,
    H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true,
  },
};

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

function summarize(rows) {
  let activeMarkets = 0, orders = 0, full = 0, partial = 0;
  let upShares = 0, downShares = 0, cost = 0, fees = 0, pnl = 0;
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const row of rows) {
    if (row.orders) activeMarkets++;
    orders += row.orders; full += row.full; partial += row.partial;
    upShares += row.upShares; downShares += row.downShares;
    cost += row.cost; fees += row.fees; pnl += row.pnl;
    if (row.pnl > 0) { wins++; grossProfit += row.pnl; }
    else if (row.pnl < 0) { losses++; grossLoss += -row.pnl; }
    equity += row.pnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const deployed = cost + fees;
  return {
    markets: rows.length,
    activeMarkets,
    participationPct: rows.length ? round(activeMarkets / rows.length * 100, 3) : null,
    orders,
    ordersPerActiveMarket: activeMarkets ? round(orders / activeMarkets, 3) : null,
    full,
    partial,
    fillCompletionPct: orders ? round(full / orders * 100, 3) : null,
    upShares: round(upShares),
    downShares: round(downShares),
    cost: round(cost),
    fees: round(fees),
    pnl: round(pnl),
    roiPct: deployed > 0 ? round(pnl / deployed * 100) : null,
    wins,
    losses,
    winRatePct: activeMarkets ? round(wins / activeMarkets * 100, 3) : null,
    averagePnlPerActiveMarket: activeMarkets ? round(pnl / activeMarkets) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    maxDrawdown: round(maxDrawdown),
  };
}

function paired(rows) {
  let bothActive = 0, binanceOnlyActive = 0, overlap = 0;
  let bothOnly = 0, binanceOnlyOnly = 0, neither = 0;
  let bothBetter = 0, binanceOnlyBetter = 0, equal = 0, pnlDelta = 0;
  for (const row of rows) {
    const b = row.results.both, z = row.results.binanceOnly;
    const ba = b.orders > 0, za = z.orders > 0;
    if (ba) bothActive++; if (za) binanceOnlyActive++;
    if (ba && za) overlap++; else if (ba) bothOnly++; else if (za) binanceOnlyOnly++; else neither++;
    const delta = b.pnl - z.pnl;
    pnlDelta += delta;
    if (delta > 1e-9) bothBetter++; else if (delta < -1e-9) binanceOnlyBetter++; else equal++;
  }
  return { markets: rows.length, bothActive, binanceOnlyActive, overlap, bothOnly,
    binanceOnlyOnly, neither, bothBetter, binanceOnlyBetter, equal,
    bothMinusBinanceOnlyPnl: round(pnlDelta) };
}

function marketResult(feed, market, ws, params) {
  const ticks = (feed.ticks || []).map((tick) => {
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    return { t: (tick.ms - ws) / 1000, ms: tick.ms, bz: tick.bz, cl: tick.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid,
      up, down };
  });
  const fills = simulateFills({ ticks, openBinance: feed.openBinance,
    openPrice: feed.openChainlink, windowStart: ws / 1000 }, params);
  const pos = positionFromFills(fills, market.winner, ticks);
  return {
    orders: fills.length,
    full: fills.filter((fill) => fill.status === "full").length,
    partial: fills.filter((fill) => fill.status === "partial").length,
    upShares: round(pos.upShares),
    downShares: round(pos.downShares),
    cost: round(pos.totalCost),
    fees: round(pos.fee),
    pnl: round(pos.realizedPnl),
  };
}

const windows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  windows.push({ slug: market.slug, startMs: ws, winner: market.winner,
    results: Object.fromEntries(Object.entries(modes)
      .map(([name, params]) => [name, marketResult(feed, market, ws, params)])) });
  if ((index + 1) % 100 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: "paired-toggle-replay", done: index + 1, total: markets.length }));
  }
}

const splits = {
  train: windows.filter((row) => row.startMs < splitMs),
  holdout: windows.filter((row) => row.startMs >= splitMs),
  all: windows,
};
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: "paired exact engine/strategies/helpme.js + engine/simrun.js",
  cohortFile,
  feedDir,
  split: new Date(splitMs).toISOString(),
  assumptions: {
    latencyMs: STRAT.LATENCY_MS,
    feeBps: STRAT.FEE_BPS,
    simulationOrderType: "fixed-USD FAK",
    signalLookbackMs: STRAT.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS,
    clobMidVelocityMin: STRAT.H_MID_VELOCITY_MIN,
    binanceGapVelocityMinUsd: STRAT.H_BINANCE_GAP_VELOCITY_MIN,
  },
  configs: modes,
  results: Object.fromEntries(Object.entries(splits).map(([split, rows]) => [split, {
    modes: Object.fromEntries(Object.keys(modes)
      .map((name) => [name, summarize(rows.map((row) => row.results[name]))])),
    paired: paired(rows),
  }])),
  daily: Object.fromEntries([...new Set(windows.map((row) => new Date(row.startMs).toISOString().slice(0, 10)))]
    .map((day) => {
      const rows = windows.filter((row) => new Date(row.startMs).toISOString().slice(0, 10) === day);
      return [day, Object.fromEntries(Object.keys(modes)
        .map((name) => [name, summarize(rows.map((row) => row.results[name]))]))];
    })),
  windows,
  caveat: "Historical strategy PnL under modeled fills is not evidence of future profitability.",
};

const money = (value) => `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}`;
const dollars = (value) => `$${Math.abs(value).toFixed(2)}`;
const resultLine = (name, value) => `| ${name} | ${value.activeMarkets}/${value.markets} (${value.participationPct}%) | ${value.orders} | ${value.winRatePct}% | ${money(value.pnl)} | ${value.roiPct}% | ${dollars(value.maxDrawdown)} | ${value.profitFactor ?? "n/a"} |`;
let markdown = "# FastMX paired toggle-mode backtest\n\n";
markdown += "Exact current-engine replay. Both modes use identical settled BTC 5m markets, causal V2 L2 frames, 520 ms delayed fixed-USD FAK matching, and modeled fees.\n\n";
for (const split of ["holdout", "train", "all"]) {
  const result = report.results[split];
  markdown += `## ${split}\n\n`;
  markdown += "| Mode | Active markets | Orders | Active win rate | PnL | ROI | Max drawdown | Profit factor |\n";
  markdown += "|---|---:|---:|---:|---:|---:|---:|---:|\n";
  markdown += resultLine("Binance only", result.modes.binanceOnly) + "\n";
  markdown += resultLine("CLOB + Binance", result.modes.both) + "\n\n";
  markdown += `Paired PnL difference (both − Binance-only): **${money(result.paired.bothMinusBinanceOnlyPnl)}**. `;
  markdown += `Both was better in ${result.paired.bothBetter} markets, Binance-only in ${result.paired.binanceOnlyBetter}, equal in ${result.paired.equal}.\n\n`;
}
markdown += `Caveat: ${report.caveat}\n`;

fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputMd, markdown);
console.log(markdown);
console.log(JSON.stringify({ outputJson, outputMd }, null, 2));
