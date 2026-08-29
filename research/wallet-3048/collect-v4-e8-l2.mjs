#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { normalizeBook } from "./core.mjs";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}
const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const sourceFile = path.resolve(process.argv[3] || path.join(dataDir, "trades-2026-08-14_2026-08-22.json"));
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const startMs = Date.parse(process.argv[4] || "2026-08-21T19:55:00Z");
const endMs = Date.parse(process.argv[5] || "2026-08-22T17:00:00Z");
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("invalid start/end range");
const markets = source.markets.filter((market) => {
  const start = Number(market.slug.split("-").at(-1)) * 1000;
  return market.winner && start >= startMs && start < endMs;
}).sort((a, b) => a.slug.localeCompare(b.slug));
const base = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const key = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!key) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const headers = { Accept: "application/json", "X-API-Key": key, Authorization: `Bearer ${key}` };
const outputDir = path.resolve(process.argv[6] || path.join(dataDir, "feeds/v4-e8-l2"));
fs.mkdirSync(outputDir, { recursive: true });
const concurrency = Math.max(1, Number(process.env.W3048_E8_L2_CONCURRENCY || 16));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
      return await response.json();
    } catch (error) {
      last = error;
      await sleep(Math.min(4_000, 250 * 2 ** attempt));
    }
  }
  throw last;
}

function trimBook(raw, maxLevels = 20) {
  const book = normalizeBook(raw);
  return { asks: book.asks.slice(0, maxLevels), bids: book.bids.slice(0, maxLevels) };
}

let cursor = 0, done = 0, cached = 0, downloaded = 0;
async function lane() {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    const market = markets[index];
    const file = path.join(outputDir, `${market.slug}.json.gz`);
    if (fs.existsSync(file)) cached++;
    else {
      const raw = await getJson(`${base}/markets/${encodeURIComponent(market.slug)}/snapshots?page=1&limit=5000&include_orderbook=true`);
      const feed = {
        slug: market.slug,
        openBinance: Number(raw.binanceSpotPriceStart ?? market.openBinance),
        openChainlink: Number(raw.coinPriceStart ?? market.openChainlink),
        winner: raw.winner ?? market.winner,
        ticks: (raw.ticks || []).map((tick) => ({
          ms: new Date(tick.time).getTime(),
          bz: tick.binanceSpotPrice == null ? null : Number(tick.binanceSpotPrice),
          up: trimBook(tick.orderbookUp),
          down: trimBook(tick.orderbookDown),
        })),
      };
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(feed), { level: 5 }));
      downloaded++;
    }
    done++;
    if (done % 25 === 0 || done === markets.length) console.log(JSON.stringify({ done, total: markets.length, cached, downloaded }));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, markets.length) }, lane));
console.log(JSON.stringify({ outputDir, markets: markets.length, cached, downloaded }));
