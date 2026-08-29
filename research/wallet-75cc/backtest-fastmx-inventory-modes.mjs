#!/usr/bin/env node
// Paired exact-engine replay for the FastMX inventory controls. Every mode sees
// identical causal V2 L2 frames and differs only by the hedge/reversal toggles.

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
const outputJson = path.join(resultRoot, "fastmx-inventory-mode-backtest-2026-08-27.json");
const outputMd = path.join(resultRoot, "fastmx-inventory-mode-backtest-2026-08-27.md");

const modes = {
  entryOnly: { ...STRAT, H_HEDGE_ON: false, H_REVERSAL_ON: false },
  hedgeOnly: { ...STRAT, H_HEDGE_ON: true, H_REVERSAL_ON: false },
  reversalOnly: { ...STRAT, H_HEDGE_ON: false, H_REVERSAL_ON: true },
  both: { ...STRAT, H_HEDGE_ON: true, H_REVERSAL_ON: true },
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

function transitionAudit(fills) {
  let up = 0, down = 0, hedgeViolations = 0, reversalCrosses = 0, reversalPartials = 0;
  for (const fill of fills) {
    const beforeNet = up - down;
    if (fill.side === "Up") up += fill.shares;
    else down += fill.shares;
    const afterNet = up - down;
    if (fill.leg === "hedge") {
      const preserved = beforeNet > 0 ? afterNet > 0 : beforeNet < 0 ? afterNet < 0 : false;
      if (!preserved) hedgeViolations++;
    }
    if (fill.leg === "reversal") {
      const crossed = fill.side === "Up" ? afterNet > 0 : afterNet < 0;
      if (crossed) reversalCrosses++; else reversalPartials++;
    }
  }
  return { hedgeViolations, reversalCrosses, reversalPartials };
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
  const audit = transitionAudit(fills);
  return {
    orders: fills.length,
    entries: fills.filter((fill) => fill.leg === "entry").length,
    hedges: fills.filter((fill) => fill.leg === "hedge").length,
    reversals: fills.filter((fill) => fill.leg === "reversal").length,
    full: fills.filter((fill) => fill.status === "full").length,
    partial: fills.filter((fill) => fill.status === "partial").length,
    upShares: round(pos.upShares), downShares: round(pos.downShares),
    cost: round(pos.totalCost), fees: round(pos.fee), pnl: round(pos.realizedPnl),
    ifUp: round(pos.ifUpWins), ifDown: round(pos.ifDownWins),
    ...audit,
  };
}

function summarize(rows) {
  let activeMarkets = 0, orders = 0, entries = 0, hedges = 0, reversals = 0, full = 0, partial = 0;
  let cost = 0, fees = 0, pnl = 0, wins = 0, losses = 0, grossProfit = 0, grossLoss = 0;
  let equity = 0, peak = 0, maxDrawdown = 0, hedgeViolations = 0, reversalCrosses = 0, reversalPartials = 0;
  for (const row of rows) {
    if (row.orders) activeMarkets++;
    orders += row.orders; entries += row.entries; hedges += row.hedges; reversals += row.reversals;
    full += row.full; partial += row.partial; cost += row.cost; fees += row.fees; pnl += row.pnl;
    hedgeViolations += row.hedgeViolations;
    reversalCrosses += row.reversalCrosses; reversalPartials += row.reversalPartials;
    if (row.pnl > 0) { wins++; grossProfit += row.pnl; }
    else if (row.pnl < 0) { losses++; grossLoss += -row.pnl; }
    equity += row.pnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const deployed = cost + fees;
  return {
    markets: rows.length, activeMarkets,
    participationPct: rows.length ? round(activeMarkets / rows.length * 100, 3) : null,
    orders, entries, hedges, reversals,
    ordersPerActiveMarket: activeMarkets ? round(orders / activeMarkets, 3) : null,
    full, partial, fillCompletionPct: orders ? round(full / orders * 100, 3) : null,
    cost: round(cost), fees: round(fees), pnl: round(pnl),
    roiPct: deployed > 0 ? round(pnl / deployed * 100) : null,
    wins, losses, winRatePct: activeMarkets ? round(wins / activeMarkets * 100, 3) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    maxDrawdown: round(maxDrawdown), hedgeViolations, reversalCrosses, reversalPartials,
    reversalCrossRatePct: reversals ? round(reversalCrosses / reversals * 100, 3) : null,
  };
}

function pairedAgainstEntry(rows, mode) {
  let better = 0, worse = 0, equal = 0, delta = 0;
  for (const row of rows) {
    const value = row.results[mode].pnl - row.results.entryOnly.pnl;
    delta += value;
    if (value > 1e-9) better++; else if (value < -1e-9) worse++; else equal++;
  }
  return { better, worse, equal, pnlDelta: round(delta) };
}

const windows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  windows.push({ slug: market.slug, startMs: ws, winner: market.winner,
    results: Object.fromEntries(Object.entries(modes)
      .map(([name, params]) => [name, marketResult(feed, market, ws, params)])) });
  if ((index + 1) % 100 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: "paired-inventory-replay", done: index + 1, total: markets.length }));
  }
}

const splitRows = {
  train: windows.filter((row) => row.startMs < splitMs),
  holdout: windows.filter((row) => row.startMs >= splitMs),
  all: windows,
};
const results = Object.fromEntries(Object.entries(splitRows).map(([split, rows]) => [split, {
  modes: Object.fromEntries(Object.keys(modes)
    .map((name) => [name, summarize(rows.map((row) => row.results[name]))])),
  pairedAgainstEntry: Object.fromEntries(Object.keys(modes).filter((name) => name !== "entryOnly")
    .map((name) => [name, pairedAgainstEntry(rows, name)])),
}]));
const report = {
  schema: 1, generatedAt: new Date().toISOString(),
  method: "paired exact engine/strategies/helpme.js + engine/simrun.js",
  cohortFile, feedDir, split: new Date(splitMs).toISOString(),
  assumptions: {
    latencyMs: STRAT.LATENCY_MS, feeBps: STRAT.FEE_BPS,
    entryOrder: "fixed-USD FAK", inventoryOrders: "exact-share FAK replay / GTC live intent",
    hedgeInvariant: "old-side post-fill lead >= H_HEDGE_RETAIN_SH",
    reversalRule: "CLOB + Binance fast direction + strong trailing trend + window-gap direction",
  },
  configs: modes, results,
  daily: Object.fromEntries([...new Set(windows.map((row) => new Date(row.startMs).toISOString().slice(0, 10)))]
    .map((day) => [day, Object.fromEntries(Object.keys(modes).map((name) => [name,
      summarize(windows.filter((row) => new Date(row.startMs).toISOString().slice(0, 10) === day)
        .map((row) => row.results[name]))]))])),
  windows,
  caveat: "Historical modeled PnL is not evidence of future profitability.",
};

const money = (value) => `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}`;
const label = { entryOnly: "Entry/top-up only", hedgeOnly: "Partial hedge only",
  reversalOnly: "Strong reversal only", both: "Hedge + reversal" };
let markdown = "# FastMX hedge/reversal paired backtest\n\n";
markdown += "Exact current-engine replay on causal V2 L2 frames with 520 ms latency and modeled taker fees. The split was fixed before comparison.\n\n";
for (const split of ["holdout", "train", "all"]) {
  markdown += `## ${split}\n\n`;
  markdown += "| Mode | Active | Orders (E/H/R) | Win rate | PnL | ROI | Max DD | Profit factor |\n";
  markdown += "|---|---:|---:|---:|---:|---:|---:|---:|\n";
  for (const name of Object.keys(modes)) {
    const value = results[split].modes[name];
    markdown += `| ${label[name]} | ${value.activeMarkets}/${value.markets} | ${value.orders} (${value.entries}/${value.hedges}/${value.reversals}) | ${value.winRatePct}% | ${money(value.pnl)} | ${value.roiPct}% | $${value.maxDrawdown.toFixed(2)} | ${value.profitFactor ?? "n/a"} |\n`;
  }
  markdown += "\n";
  for (const name of ["hedgeOnly", "reversalOnly", "both"]) {
    const value = results[split].pairedAgainstEntry[name];
    markdown += `${label[name]} minus entry-only: **${money(value.pnlDelta)}**; better/worse/equal windows ${value.better}/${value.worse}/${value.equal}.  \n`;
  }
  const both = results[split].modes.both;
  markdown += `\nBoth-mode invariant audit: ${both.hedgeViolations} realized hedge crossings; ${both.reversalCrosses}/${both.reversals} reversal fills crossed inventory (${both.reversalCrossRatePct ?? 0}%).\n\n`;
}
markdown += `Caveat: ${report.caveat}\n`;

fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputMd, markdown);
console.log(markdown);
console.log(JSON.stringify({ outputJson, outputMd }, null, 2));
