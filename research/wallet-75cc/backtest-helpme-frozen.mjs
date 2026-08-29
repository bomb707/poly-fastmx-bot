#!/usr/bin/env node
// Replay the exact registered Helpme implementation over the BTC V2 L2 cohort.
// No proxy signal or duplicated execution model is used here.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const root = path.resolve(process.argv[2] || "data/wallet-75cc");
const cohortFile = path.join(root, "cohort-2026-08-16_2026-08-26-btc.json");
const feedDir = path.join(root, "feeds/v2-l2");
const outputFile = path.resolve(process.argv[3] || path.join(root, "helpme-frozen-backtest-btc-aug16-25.json"));
const splitMs = Date.parse(process.argv[4] || "2026-08-22T00:00:00Z");
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const markets = cohort.markets.filter((m) => m.winner && m.slug.startsWith("btc-")
  && fs.existsSync(path.join(feedDir, `${m.slug}.json.gz`)))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug));

function blank() {
  return { markets: 0, activeMarkets: 0, orders: 0, full: 0, partial: 0,
    upShares: 0, downShares: 0, cost: 0, fees: 0, pnl: 0, wins: 0, losses: 0 };
}
function add(total, row) {
  total.markets++; if (row.orders) total.activeMarkets++;
  for (const key of ["orders", "full", "partial", "upShares", "downShares", "cost", "fees", "pnl"])
    total[key] += row[key];
  if (row.pnl > 0) total.wins++; else if (row.pnl < 0) total.losses++;
}
function metrics(raw) {
  const rounded = Object.fromEntries(Object.entries(raw).map(([k, v]) =>
    [k, typeof v === "number" ? +v.toFixed(4) : v]));
  return { ...rounded,
    roiPct: raw.cost + raw.fees > 0 ? +(raw.pnl / (raw.cost + raw.fees) * 100).toFixed(4) : null,
    participationPct: raw.markets ? +(raw.activeMarkets / raw.markets * 100).toFixed(3) : null,
    ordersPerActiveMarket: raw.activeMarkets ? +(raw.orders / raw.activeMarkets).toFixed(3) : null,
    winRatePct: raw.activeMarkets ? +(raw.wins / raw.activeMarkets * 100).toFixed(3) : null };
}
function nestedBook(raw) {
  const asks = raw?.asks || [], bids = raw?.bids || [];
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

const totals = { train: blank(), holdout: blank(), all: blank() };
const daily = {}, windows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = (feed.ticks || []).map((x) => {
    const up = nestedBook(x.up), down = nestedBook(x.down);
    return { t: (x.ms - ws) / 1000, ms: x.ms, bz: x.bz, cl: x.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid, up, down };
  });
  const fills = simulateFills({ ticks, openBinance: feed.openBinance, openPrice: feed.openChainlink,
    windowStart: ws / 1000 }, STRAT);
  const pos = positionFromFills(fills, market.winner, ticks);
  const row = { slug: market.slug, winner: market.winner, orders: fills.length,
    full: fills.filter((f) => f.status === "full").length,
    partial: fills.filter((f) => f.status === "partial").length,
    upShares: pos.upShares, downShares: pos.downShares, cost: pos.totalCost,
    fees: pos.fee, pnl: pos.realizedPnl };
  windows.push(row);
  const segment = ws < splitMs ? "train" : "holdout";
  add(totals[segment], row); add(totals.all, row);
  const day = new Date(ws).toISOString().slice(0, 10);
  daily[day] ||= blank(); add(daily[day], row);
  if ((index + 1) % 100 === 0 || index + 1 === markets.length)
    console.log(JSON.stringify({ phase: "exact-replay", done: index + 1, total: markets.length }));
}

const report = { schema: 1, generatedAt: new Date().toISOString(), cohortFile, feedDir,
  split: new Date(splitMs).toISOString(), method: "exact engine/strategies/helpme.js + engine/simrun.js",
  config: STRAT, train: metrics(totals.train), holdout: metrics(totals.holdout), all: metrics(totals.all),
  daily: Object.fromEntries(Object.entries(daily).map(([day, raw]) => [day, metrics(raw)])), windows };
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, train: report.train, holdout: report.holdout, all: report.all, daily: report.daily }, null, 2));
