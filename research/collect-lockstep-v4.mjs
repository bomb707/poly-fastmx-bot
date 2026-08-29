#!/usr/bin/env node
/** Download a compact, reusable bapi-v4 full-orderbook research cache. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../.env")); } catch {}
const ROOT = path.resolve(import.meta.dirname, "..");
const FROM_MS = Date.parse(process.argv[2] || "2026-06-22T00:00:00Z");
const TO_MS = Date.parse(process.argv[3] || "2026-08-14T00:00:00Z");
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");
const BASE = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!KEY) throw new Error("Set BAPI_V4_KEY, BAPI_V3_KEY, BAPI_KEY, or BACKTEST_API_KEY");
const OUT = path.resolve(process.env.LOCKSTEP_V4_CACHE || path.join(ROOT, "data/lockstep-v4-top"));
const CONCURRENCY = Math.max(1, Number(process.env.LOCKSTEP_V4_CONCURRENCY || 16));
const headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(OUT, { recursive: true });

async function getJson(pathname, query = {}) {
  const url = new URL(pathname, `${BASE}/`);
  for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        const retry = Number(response.headers.get("retry-after")) * 1000;
        await sleep(Number.isFinite(retry) && retry > 0 ? retry : Math.min(8_000, 300 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 140)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < 6) await sleep(Math.min(8_000, 300 * 2 ** attempt));
    }
  }
  throw last;
}

async function listMarkets() {
  const markets = [];
  for (let page = 1; ; page++) {
    const body = await getJson("markets", {
      coin: "BTC",
      market_type: "5m",
      resolved: "true",
      from: new Date(FROM_MS).toISOString(),
      to: new Date(TO_MS).toISOString(),
      page,
      limit: 500,
    });
    markets.push(...(body.markets || []));
    if (page >= Number(body.pagination?.totalPages || 1)) break;
  }
  return markets.filter((market) => {
    const start = Date.parse(market.startTime || "");
    return start >= FROM_MS && start < TO_MS;
  }).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

function top(raw, targetDepth = 80, maxLevels = 12) {
  const rows = (raw?.asks || []).map((level) => [Number(level.price), Number(level.size)])
    .filter((level) => level[0] >= .01 && level[0] <= .99 && level[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let depth = 0;
  for (const [price, size] of rows) {
    out.push(price, size);
    depth += size;
    if ((depth >= targetDepth && out.length >= 6) || out.length >= maxLevels * 2) break;
  }
  return out;
}

function compactTicks(rawTicks, startMs) {
  const out = [];
  let pending = null, bucket = null, prior = null;
  for (const raw of rawTicks) {
    const ms = Date.parse(raw.time || raw.tick_time || "");
    const bz = Number(raw.binanceSpotPrice ?? raw.binance_spot_price);
    const up = top(raw.orderbookUp || raw.orderbook_up);
    const down = top(raw.orderbookDown || raw.orderbook_down);
    if (!Number.isFinite(ms) || !Number.isFinite(bz) || !up.length || !down.length) continue;
    const tick = { ms, bz, up, down };
    const nextBucket = Math.floor((ms - startMs) / 120);
    const changed = !prior || bz !== prior.bz || up[0] !== prior.up[0] || down[0] !== prior.down[0];
    if (bucket != null && nextBucket !== bucket && pending) { out.push(pending); pending = null; }
    if (changed) { if (pending) out.push(pending); out.push(tick); }
    else pending = tick;
    bucket = nextBucket;
    prior = tick;
  }
  if (pending) out.push(pending);
  return out;
}

async function fetchMarket(market) {
  const pathname = `markets/${encodeURIComponent(market.slug)}/snapshots`;
  const first = await getJson(pathname, { page: 1, limit: 5000, include_orderbook: "true" });
  const rawTicks = [...(first.ticks || [])];
  for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page++) {
    const body = await getJson(pathname, { page, limit: 5000, include_orderbook: "true" });
    rawTicks.push(...(body.ticks || []));
  }
  const startMs = Date.parse(market.startTime || first.startTime || "");
  return {
    slug: market.slug,
    openBinance: Number(first.binanceSpotPriceStart ?? market.binanceSpotPriceStart),
    openChainlink: Number(first.coinPriceStart ?? market.coinPriceStart),
    winner: first.winner ?? market.winner,
    sparseWindow: first.sparseWindow === true,
    isStale: first.isStale === true,
    ticks: compactTicks(rawTicks, startMs),
  };
}

const markets = await listMarkets();
console.log(JSON.stringify({ phase: "listed", markets: markets.length, from: new Date(FROM_MS).toISOString(), to: new Date(TO_MS).toISOString(), out: OUT, concurrency: CONCURRENCY }));
let cursor = 0, done = 0, cached = 0, downloaded = 0, failed = 0;
const errors = [];
async function lane() {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    const market = markets[index];
    const file = path.join(OUT, `${market.slug}.json.gz`);
    if (fs.existsSync(file)) cached++;
    else {
      try {
        const feed = await fetchMarket(market);
        fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(feed), { level: 5 }));
        downloaded++;
      } catch (error) {
        failed++;
        if (errors.length < 20) errors.push({ slug: market.slug, error: String(error?.message || error) });
      }
    }
    done++;
    if (done % 100 === 0 || done === markets.length) console.log(JSON.stringify({ phase: "download", done, total: markets.length, cached, downloaded, failed }));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, markets.length)) }, lane));
console.log(JSON.stringify({ phase: "complete", markets: markets.length, cached, downloaded, failed, errors }));
