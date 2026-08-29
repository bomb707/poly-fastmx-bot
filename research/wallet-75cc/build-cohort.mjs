#!/usr/bin/env node
// Build a reproducible time cohort from the full wallet/market collection.
import fs from "node:fs";
import path from "node:path";

const input = path.resolve(process.argv[2] || "data/wallet-75cc/trades.json");
const from = process.argv[3] || "2026-08-25T00:00:00Z";
const to = process.argv[4] || "2026-08-26T00:00:00Z";
const output = path.resolve(process.argv[5] || "data/wallet-75cc/cohort.json");
const fromMs = Date.parse(from), toMs = Date.parse(to);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("invalid cohort range");
const source = JSON.parse(fs.readFileSync(input, "utf8"));
const coins = String(process.env.W75CC_COHORT_COINS || "").split(",").map((coin) => coin.trim().toLowerCase()).filter(Boolean);
const tradedOnly = /^(1|true|yes)$/i.test(String(process.env.W75CC_COHORT_TRADED_ONLY || ""));
const startsInRange = (slug) => {
  const seconds = Number(String(slug || "").split("-").at(-1));
  return Number.isFinite(seconds) && seconds * 1000 >= fromMs && seconds * 1000 < toMs;
};
const tradedSlugs = new Set(source.trades.map((trade) => trade.slug));
const markets = source.markets.filter((market) => startsInRange(market.slug)
  && (!coins.length || coins.includes(String(market.coin || market.slug.split("-")[0]).toLowerCase()))
  && (!tradedOnly || tradedSlugs.has(market.slug)));
const slugs = new Set(markets.map((market) => market.slug));
const trades = source.trades.filter((trade) => slugs.has(trade.slug));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ ...source, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), markets, trades }));
console.log(JSON.stringify({ output, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), markets: markets.length, trades: trades.length }));
