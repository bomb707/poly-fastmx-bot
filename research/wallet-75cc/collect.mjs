#!/usr/bin/env node
// Collect every crypto Up/Down five-minute fill for the target wallet without
// relying on the Data API's global 20,000-row history ceiling. V4 supplies the
// complete market/condition-id universe; Data API queries are then sharded by
// those condition IDs. `takerOnly=true` is subtracted as a multiset from the
// maker-inclusive response so role labels remain exact even for duplicate rows.
import fs from "node:fs";
import path from "node:path";
import { TARGET_COINS, TARGET_WALLET } from "./constants.mjs";

const numberKey = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(8) : "nan";
const tradeFingerprint = (row) => [
  String(row?.transactionHash || "").toLowerCase(), String(row?.asset || ""),
  String(row?.side || "").toUpperCase(), String(row?.outcome || ""),
  Number(row?.timestamp) || 0, numberKey(row?.price), numberKey(row?.size),
].join(":");

function labelTradeRoles(allRows, takerRows) {
  const takerCounts = new Map();
  for (const row of takerRows || []) {
    const key = tradeFingerprint(row);
    takerCounts.set(key, (takerCounts.get(key) || 0) + 1);
  }
  return (allRows || []).map((row) => {
    const key = tradeFingerprint(row), count = takerCounts.get(key) || 0;
    if (count > 0) takerCounts.set(key, count - 1);
    return { ...row, role: count > 0 ? "taker" : "maker" };
  });
}

function normalizeTrade(row) {
  const size = Number(row?.size), price = Number(row?.price);
  return {
    slug: String(row?.slug || ""), conditionId: String(row?.conditionId || "").toLowerCase(),
    asset: String(row?.asset || ""), outcome: /^up$/i.test(row?.outcome || "") ? "Up" : "Down",
    action: String(row?.side || "BUY").toUpperCase(), role: row?.role === "maker" ? "maker" : "taker",
    size: Number.isFinite(size) ? size : 0, price: Number.isFinite(price) ? price : 0,
    timestamp: Number(row?.timestamp) || 0,
    transactionHash: String(row?.transactionHash || "").toLowerCase(),
  };
}

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}

const FROM = process.argv[2] || "2026-08-16T00:00:00Z";
const TO = process.argv[3] || new Date().toISOString();
const fromMs = Date.parse(FROM), toMs = Date.parse(TO);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("invalid from/to range");

const coins = String(process.env.W75CC_COINS || TARGET_COINS.join(","))
  .split(",").map((coin) => coin.trim().toUpperCase()).filter(Boolean);
const base = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const key = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!key) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const v4Headers = { Accept: "application/json", "X-API-Key": key, Authorization: `Bearer ${key}` };
const concurrency = Math.max(1, Number(process.env.W75CC_COLLECT_CONCURRENCY || 10));
const stamp = (ms) => new Date(ms).toISOString().replace(/:/g, "_").replace(/\.\d{3}Z$/, "Z");
const output = path.resolve(process.argv[4] || path.join("data", "wallet-75cc", `trades-${stamp(fromMs)}_${stamp(toMs)}.json`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonFetch(url, options = {}, attempt = 0) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000) }); }
  catch (error) {
    if (attempt >= 7) throw error;
    await sleep(Math.min(5000, 300 * 2 ** attempt));
    return jsonFetch(url, options, attempt + 1);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 7) {
    const retryAfter = Number(response.headers.get("retry-after")) * 1000;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(5000, 300 * 2 ** attempt));
    return jsonFetch(url, options, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 240)}`);
  return response.json();
}

async function listMarketsForCoin(coin) {
  const markets = [];
  try {
    for (let page = 1; ; page++) {
      const url = new URL("markets", `${base}/`);
      for (const [name, value] of Object.entries({
        coin, market_type: "5m", from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(), page, limit: 500,
      })) url.searchParams.set(name, String(value));
      const body = await jsonFetch(url, { headers: v4Headers });
      markets.push(...(body.markets || []).map((market) => ({ ...market, coin })));
      if (page >= Number(body.pagination?.totalPages || 1)) break;
    }
  } catch (error) {
    // Some API credentials cover the v2/v3 replay databases but not the v4
    // market index. Five-minute slugs are deterministic, so Gamma can provide
    // the public condition/token identifiers needed to shard wallet trades.
    // Do not turn an otherwise valid replay credential into a hard failure.
    if (!/^401\b/.test(String(error?.message || ""))) throw error;
    console.log(JSON.stringify({ phase: "v4-market-index-unavailable", coin,
      fallback: "gamma-deterministic-slugs" }));
  }
  if (markets.length) return markets;
  // V4 currently has no XRP market index/snapshots even though Polymarket and
  // V2 do. Gamma's canonical slug endpoint fills that enumerator gap.
  const starts = [];
  for (let ms = Math.ceil(fromMs / 300_000) * 300_000; ms < toMs; ms += 300_000) starts.push(ms);
  console.log(JSON.stringify({ phase: "gamma-market-fallback", coin, candidates: starts.length }));
  const rows = await pool(starts, async (ms) => gammaMarket(coin, ms), `gamma-${coin.toLowerCase()}`);
  return rows.filter(Boolean);
}

const parseArray = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
};

async function gammaMarket(coin, startMs) {
  const slug = `${coin.toLowerCase()}-updown-5m-${Math.floor(startMs / 1000)}`;
  const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await sleep(Math.min(5000, 200 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      const raw = await response.json();
      const outcomes = parseArray(raw.outcomes).map(String);
      const prices = parseArray(raw.outcomePrices).map(Number);
      const tokens = parseArray(raw.clobTokenIds).map(String);
      const upIndex = outcomes.findIndex((outcome) => /^up$/i.test(outcome));
      const downIndex = outcomes.findIndex((outcome) => /^down$/i.test(outcome));
      let winner = null;
      if (upIndex >= 0 && prices[upIndex] >= .99) winner = "Up";
      else if (downIndex >= 0 && prices[downIndex] >= .99) winner = "Down";
      return {
        coin, slug, conditionId: raw.conditionId,
        clobTokenUp: upIndex >= 0 ? tokens[upIndex] : "",
        clobTokenDown: downIndex >= 0 ? tokens[downIndex] : "",
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(startMs + 300_000).toISOString(),
        winner, sparseWindow: false, isStale: false, snapshotTotal: 0,
        orderbooksSynced: false, source: "gamma",
      };
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(Math.min(5000, 200 * 2 ** attempt));
    }
  }
  return null;
}

async function queryTrades(markets, takerOnly) {
  const url = new URL("https://data-api.polymarket.com/trades");
  for (const [name, value] of Object.entries({
    user: TARGET_WALLET,
    market: markets.map((market) => market.conditionId).join(","),
    takerOnly: String(takerOnly), limit: 10000, offset: 0,
  })) url.searchParams.set(name, String(value));
  const rows = await jsonFetch(url, { headers: { Accept: "application/json" } });
  if (!Array.isArray(rows)) throw new Error("unexpected Data API trade response");
  if (rows.length >= 9950 && markets.length > 1) {
    const middle = Math.ceil(markets.length / 2);
    const [left, right] = await Promise.all([
      queryTrades(markets.slice(0, middle), takerOnly),
      queryTrades(markets.slice(middle), takerOnly),
    ]);
    return [...left, ...right];
  }
  if (rows.length >= 9950) throw new Error(`single market ${markets[0]?.slug} exceeded the 10,000-row cap`);
  return rows;
}

async function pool(items, worker, label) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function lane() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      done++;
      if (done % 25 === 0 || done === items.length) console.log(JSON.stringify({ phase: label, done, total: items.length }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

const marketParts = await Promise.all(coins.map(listMarketsForCoin));
const seenMarkets = new Set();
const markets = marketParts.flat().filter((market) => {
  const start = Date.parse(market.startTime || "");
  const id = String(market.conditionId || "").toLowerCase();
  if (!(start >= fromMs && start < toMs) || !id || seenMarkets.has(id)) return false;
  seenMarkets.add(id);
  return true;
}).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.coin.localeCompare(b.coin));
console.log(JSON.stringify({ phase: "markets", wallet: TARGET_WALLET, coins, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), markets: markets.length }));

const batches = [];
for (let index = 0; index < markets.length; index += 25) batches.push(markets.slice(index, index + 25));
const parts = await pool(batches, async (batch) => {
  const [all, taker] = await Promise.all([queryTrades(batch, false), queryTrades(batch, true)]);
  return labelTradeRoles(all, taker).map(normalizeTrade);
}, "trade-batches");

const seenTrades = new Set(), trades = [];
for (const row of parts.flat()) {
  const identity = [row.transactionHash, row.asset, row.outcome, row.role, row.timestamp, row.price.toFixed(8), row.size.toFixed(8)].join(":");
  if (!seenTrades.has(identity)) { seenTrades.add(identity); trades.push(row); }
}
trades.sort((a, b) => a.timestamp - b.timestamp || a.slug.localeCompare(b.slug));
const marketRows = markets.map((market) => ({
  coin: market.coin,
  slug: market.slug,
  conditionId: String(market.conditionId).toLowerCase(),
  upToken: String(market.clobTokenUp || ""), downToken: String(market.clobTokenDown || ""),
  startTime: market.startTime, endTime: market.endTime,
  openBinance: Number(market.binanceSpotPriceStart) || null,
  openChainlink: Number(market.coinPriceStart) || null,
  winner: /^up$/i.test(market.winner || "") ? "Up" : /^down$/i.test(market.winner || "") ? "Down" : null,
  sparse: market.sparseWindow === true || market.isStale === true,
  snapshots: Number(market.snapshotTotal) || 0,
  orderbooksSynced: market.orderbooksSynced === true,
}));

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({
  schema: 1, wallet: TARGET_WALLET, coins,
  from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
  collectedAt: new Date().toISOString(), markets: marketRows, trades,
}));
const maker = trades.filter((trade) => trade.role === "maker").length;
const byCoin = Object.fromEntries(coins.map((coin) => [coin, trades.filter((trade) => trade.slug.startsWith(`${coin.toLowerCase()}-`)).length]));
console.log(JSON.stringify({ phase: "done", output, markets: marketRows.length, trades: trades.length, taker: trades.length - maker, maker, byCoin }));
