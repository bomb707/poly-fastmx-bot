// Public-data collector for wallet 0x3048... BTC Up/Down 5m fills.
// It avoids the global /trades history cap by filtering batches of v4 condition IDs,
// and labels maker/taker participation by subtracting takerOnly=true from false.
//
// Usage:
//   node research/wallet-3048/collect.mjs [fromIso=2026-08-14T00:00:00Z] [toIso=now] [output.json]
import fs from "node:fs";
import path from "node:path";
import { labelTradeRoles, normalizeTrade, WALLET_3048 } from "./core.mjs";

try { process.loadEnvFile?.(new URL("../../.env", import.meta.url)); } catch {}

const FROM = process.argv[2] || "2026-08-14T00:00:00Z";
const TO = process.argv[3] || new Date().toISOString();
const fromMs = Date.parse(FROM), toMs = Date.parse(TO);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("invalid from/to range");

const V4_BASE = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!KEY) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const v4Headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stamp = (ms) => new Date(ms).toISOString().slice(0, 10);
const output = process.argv[4] || path.resolve("data", "wallet-3048", `trades-${stamp(fromMs)}_${stamp(toMs)}.json`);

async function jsonFetch(url, options = {}, attempt = 0) {
  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (attempt >= 6) throw error;
    await sleep(500 * 2 ** attempt);
    return jsonFetch(url, options, attempt + 1);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    const retryAfter = Number(response.headers.get("retry-after")) * 1000;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * 2 ** attempt);
    return jsonFetch(url, options, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function listMarkets() {
  const markets = [];
  for (let page = 1; ; page++) {
    const url = new URL("markets", `${V4_BASE}/`);
    for (const [key, value] of Object.entries({ coin: "BTC", market_type: "5m", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), page, limit: 500 })) {
      url.searchParams.set(key, String(value));
    }
    const body = await jsonFetch(url, { headers: v4Headers });
    markets.push(...(body.markets || []));
    if (page >= (body.pagination?.totalPages || 1)) break;
  }
  return markets.filter((market) => {
    const start = Date.parse(market.startTime || "");
    return start >= fromMs && start < toMs && market.conditionId;
  }).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

async function queryTrades(markets, takerOnly) {
  const url = new URL("https://data-api.polymarket.com/trades");
  for (const [key, value] of Object.entries({
    user: WALLET_3048,
    market: markets.map((market) => market.conditionId).join(","),
    takerOnly: String(takerOnly),
    limit: 10000,
    offset: 0,
  })) url.searchParams.set(key, String(value));
  const rows = await jsonFetch(url, { headers: { Accept: "application/json" } });
  if (!Array.isArray(rows)) throw new Error("unexpected Data API trade response");
  // A full page might be silently truncated. Recursively split until each query is safely below the cap.
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

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function lane() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      done++;
      if (done % 10 === 0 || done === items.length) {
        console.log(JSON.stringify({ phase: "trade-batches", done, total: items.length }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()));
  return results;
}

const markets = await listMarkets();
console.log(JSON.stringify({ phase: "markets", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), markets: markets.length }));
const batches = [];
for (let index = 0; index < markets.length; index += 25) batches.push(markets.slice(index, index + 25));

const parts = await mapConcurrent(batches, 5, async (batch) => {
  const [all, taker] = await Promise.all([queryTrades(batch, false), queryTrades(batch, true)]);
  return labelTradeRoles(all, taker).map(normalizeTrade);
});
const seen = new Set(), trades = [];
for (const row of parts.flat()) {
  const key = [row.transactionHash, row.asset, row.outcome, row.role, row.timestamp, row.price.toFixed(8), row.size.toFixed(8)].join(":");
  if (!seen.has(key)) { seen.add(key); trades.push(row); }
}
trades.sort((a, b) => a.timestamp - b.timestamp || a.slug.localeCompare(b.slug));

const marketRows = markets.map((market) => ({
  slug: market.slug,
  conditionId: String(market.conditionId).toLowerCase(),
  upToken: String(market.clobTokenUp || ""),
  downToken: String(market.clobTokenDown || ""),
  startTime: market.startTime,
  endTime: market.endTime,
  openBinance: Number(market.binanceSpotPriceStart) || null,
  openChainlink: Number(market.coinPriceStart) || null,
  winner: /^up$/i.test(market.winner || "") ? "Up" : /^down$/i.test(market.winner || "") ? "Down" : null,
  sparse: market.sparseWindow === true || market.isStale === true,
  snapshots: Number(market.snapshotTotal) || 0,
  orderbooksSynced: market.orderbooksSynced === true,
}));

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({
  schema: 1,
  wallet: WALLET_3048,
  from: new Date(fromMs).toISOString(),
  to: new Date(toMs).toISOString(),
  collectedAt: new Date().toISOString(),
  markets: marketRows,
  trades,
}));
const makers = trades.filter((trade) => trade.role === "maker").length;
console.log(JSON.stringify({ phase: "done", output, markets: marketRows.length, trades: trades.length, taker: trades.length - makers, maker: makers }));
