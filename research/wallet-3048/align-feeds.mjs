#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { aggregateFillBursts, featuresAt, inferMakerPlacement, inferTakerFire, normalizeBook } from "./core.mjs";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}
const ROOT = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-3048/trades-2026-08-14_2026-08-22.json"));
const outDir = path.resolve(process.argv[3] || path.join(ROOT, "data/wallet-3048"));
const V2 = String(process.env.BACKTEST_API || "https://bapi-v2.polywinbot.com").replace(/\/+$/, "");
const V4 = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!KEY) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const v2PerDay = Math.max(0, Number(process.env.W3048_V2_PER_DAY || 24));
const l2PerDay = Math.max(0, Number(process.env.W3048_L2_PER_DAY || 8));
const concurrency = Math.max(1, Number(process.env.W3048_CONCURRENCY || 10));
const data = JSON.parse(fs.readFileSync(input, "utf8"));
const bursts = aggregateFillBursts(data.trades);
const burstsBySlug = new Map();
for (const burst of bursts) {
  if (!burstsBySlug.has(burst.slug)) burstsBySlug.set(burst.slug, []);
  burstsBySlug.get(burst.slug).push(burst);
}
const markets = data.markets.filter((market) => burstsBySlug.has(market.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
const feedDir = path.join(outDir, "feeds");
fs.mkdirSync(path.join(feedDir, "v4"), { recursive: true });
fs.mkdirSync(path.join(feedDir, "v2"), { recursive: true });
fs.mkdirSync(path.join(feedDir, "v4-l2"), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url, attempts = 5) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(Math.min(2000, 150 * 2 ** attempt));
    }
  }
  throw new Error(`${new URL(url).pathname}: ${last?.message || last}`);
}

function cachePath(version, slug) { return path.join(feedDir, version, `${slug}.json.gz`); }
function cacheRead(version, slug) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath(version, slug)))); } catch { return null; }
}
function cacheWrite(version, slug, value) {
  fs.writeFileSync(cachePath(version, slug), zlib.gzipSync(JSON.stringify(value), { level: 6 }));
}

async function fetchV4(market) {
  const cached = cacheRead("v4", market.slug);
  if (cached) return cached;
  const url = `${V4}/markets/${encodeURIComponent(market.slug)}/snapshots?page=1&limit=5000&include_orderbook=false`;
  const raw = await getJson(url);
  const compact = {
    slug: market.slug,
    openBinance: Number(raw.binanceSpotPriceStart ?? market.openBinance),
    openChainlink: Number(raw.coinPriceStart ?? market.openChainlink),
    winner: raw.winner ?? market.winner,
    ticks: (raw.ticks || []).map((tick) => ({
      ms: new Date(tick.time).getTime(),
      bz: tick.binanceSpotPrice == null ? null : Number(tick.binanceSpotPrice),
      cl: null,
      upAsk: tick.priceUp == null ? null : Number(tick.priceUp),
      dnAsk: tick.priceDown == null ? null : Number(tick.priceDown),
    })),
  };
  cacheWrite("v4", market.slug, compact);
  return compact;
}

async function fetchV2(market) {
  const cached = cacheRead("v2", market.slug);
  if (cached) return cached;
  let page = 1, head = null;
  const ticks = [];
  do {
    const raw = await getJson(`${V2}/snapshot-ticks?slug=${encodeURIComponent(market.slug)}&page=${page}&limit=5000`);
    if (!head) head = raw;
    for (const tick of raw.ticks || []) ticks.push({
      ms: Number(tick.capturedAtMs),
      bz: tick.binancePrice == null ? null : Number(tick.binancePrice),
      cl: tick.chainlinkPrice == null ? null : Number(tick.chainlinkPrice),
      upAsk: tick.upBestAsk == null ? null : Number(tick.upBestAsk),
      dnAsk: tick.downBestAsk == null ? null : Number(tick.downBestAsk),
    });
    if (page >= Number(raw.pagination?.totalPages || 1)) break;
    page++;
  } while (page < 10);
  const compact = {
    slug: market.slug,
    openBinance: Number(head?.openBinancePrice ?? market.openBinance),
    openChainlink: Number(head?.openPrice ?? market.openChainlink),
    winner: head?.winSide ?? market.winner,
    ticks,
  };
  cacheWrite("v2", market.slug, compact);
  return compact;
}

async function fetchV4L2(market) {
  const cached = cacheRead("v4-l2", market.slug);
  if (cached) return cached;
  const raw = await getJson(`${V4}/markets/${encodeURIComponent(market.slug)}/snapshots?page=1&limit=5000&include_orderbook=true`);
  const compact = {
    slug: market.slug,
    openBinance: Number(raw.binanceSpotPriceStart ?? market.openBinance),
    openChainlink: Number(raw.coinPriceStart ?? market.openChainlink),
    winner: raw.winner ?? market.winner,
    ticks: (raw.ticks || []).map((tick) => ({
      ms: new Date(tick.time).getTime(),
      bz: tick.binanceSpotPrice == null ? null : Number(tick.binanceSpotPrice),
      cl: null,
      upAsk: tick.priceUp == null ? null : Number(tick.priceUp),
      dnAsk: tick.priceDown == null ? null : Number(tick.priceDown),
      up: normalizeBook(tick.orderbookUp),
      down: normalizeBook(tick.orderbookDown),
    })),
  };
  cacheWrite("v4-l2", market.slug, compact);
  return compact;
}

function sampleByDay(rows, perDay) {
  if (perDay <= 0) return [];
  const groups = new Map();
  for (const row of rows) {
    const day = new Date(Number(row.slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(row);
  }
  const selected = [];
  for (const group of groups.values()) {
    const count = Math.min(perDay, group.length);
    for (let i = 0; i < count; i++) selected.push(group[Math.min(group.length - 1, Math.floor((i + .5) * group.length / count))]);
  }
  return selected;
}

async function pool(rows, worker, label) {
  let cursor = 0, done = 0;
  const results = new Array(rows.length);
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      results[index] = await worker(rows[index], index);
      done++;
      if (done % 50 === 0 || done === rows.length) console.log(`${label}: ${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, run));
  return results;
}

function indexAtOrBefore(ticks, ms) {
  let lo = 0, hi = ticks.length - 1, answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].ms <= ms) { answer = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return answer;
}
function alignedFeature(feed, burst, atMs = burst.timestamp * 1000 + 999) {
  const index = indexAtOrBefore(feed.ticks, atMs);
  if (index < 0) return null;
  const ws = Number(burst.slug.split("-").at(-1));
  const feature = featuresAt(feed.ticks, index, feed.openBinance, feed.openChainlink, ws * 1000);
  const tick = feed.ticks[index];
  return {
    ...feature,
    upAsk: tick.upAsk,
    downAsk: tick.dnAsk,
    sideAsk: burst.outcome === "Up" ? tick.upAsk : tick.dnAsk,
    askDistance: (burst.outcome === "Up" ? tick.upAsk : tick.dnAsk) == null ? null : burst.vwap - (burst.outcome === "Up" ? tick.upAsk : tick.dnAsk),
  };
}

console.log(`v4 compact: ${markets.length} traded windows`);
const v4Feeds = await pool(markets, fetchV4, "v4");
const v4BySlug = new Map(v4Feeds.map((feed) => [feed.slug, feed]));
const v2Markets = sampleByDay(markets, v2PerDay);
console.log(`v2 Chainlink stratified sample: ${v2Markets.length} windows (${v2PerDay}/day max)`);
const v2Feeds = await pool(v2Markets, fetchV2, "v2");
const v2BySlug = new Map(v2Feeds.map((feed) => [feed.slug, feed]));

const aligned = bursts.map((burst) => ({
  key: burst.key,
  slug: burst.slug,
  timestamp: burst.timestamp,
  outcome: burst.outcome,
  role: burst.role,
  shares: burst.shares,
  vwap: burst.vwap,
  maxPrice: burst.maxPrice,
  v4: alignedFeature(v4BySlug.get(burst.slug), burst),
  v2: v2BySlug.has(burst.slug) ? alignedFeature(v2BySlug.get(burst.slug), burst) : null,
}));
const alignedByKey = new Map(aligned.map((row) => [row.key, row]));

const l2Markets = sampleByDay(markets, l2PerDay);
console.log(`v4 full-L2 inference sample: ${l2Markets.length} windows (${l2PerDay}/day max)`);
await pool(l2Markets, async (market) => {
  const feed = await fetchV4L2(market);
  for (const burst of burstsBySlug.get(market.slug) || []) {
    const row = alignedByKey.get(burst.key);
    if (!row) continue;
    if (burst.role === "taker") {
      const inference = inferTakerFire(feed.ticks, burst);
      if (inference) {
        const tick = feed.ticks[inference.index];
        const book = burst.outcome === "Up" ? tick.up : tick.down;
        row.fire = {
          kind: "taker",
          ms: inference.ms,
          leadMs: inference.leadMs,
          score: inference.score,
          bookScore: inference.bookScore,
          consumptionMiss: inference.consumptionMiss,
          removedShares: inference.removedShares,
          confidence: inference.confidence,
          walked: inference.walked,
          bestAsk: book.bestAsk,
          bestBid: book.bestBid,
          feature: alignedFeature(feed, burst, inference.ms),
          v2Feature: v2BySlug.has(burst.slug) ? alignedFeature(v2BySlug.get(burst.slug), burst, inference.ms) : null,
        };
      }
    } else {
      const inference = inferMakerPlacement(feed.ticks, burst);
      if (inference) row.fire = {
        kind: "maker",
        ...inference,
        feature: alignedFeature(feed, burst, inference.ms),
        v2Feature: v2BySlug.has(burst.slug) ? alignedFeature(v2BySlug.get(burst.slug), burst, inference.ms) : null,
      };
    }
  }
}, "v4-l2");

const output = {
  schema: 1,
  source: { input, wallet: data.wallet, from: data.from, to: data.to },
  sampling: { allV4Windows: markets.length, v2Windows: v2Markets.map((m) => m.slug), l2Windows: l2Markets.map((m) => m.slug) },
  rows: aligned,
};
const outputPath = path.join(outDir, "signal-alignment.json.gz");
fs.writeFileSync(outputPath, zlib.gzipSync(JSON.stringify(output), { level: 7 }));
console.log(JSON.stringify({ outputPath, rows: aligned.length, v2Rows: aligned.filter((r) => r.v2).length, inferredFireRows: aligned.filter((r) => r.fire).length }));
