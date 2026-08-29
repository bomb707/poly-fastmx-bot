#!/usr/bin/env node
// Download v4 full-L2 windows once, retain only enough top ask depth for
// reproducible 30-share execution replay. This avoids mistaking v4 priceUp /
// priceDown (midpoint-style values) for executable asks.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}
const ROOT = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-3048"));
const tradesFile = path.resolve(process.argv[3] || path.join(dataDir, "trades-2026-08-14_2026-08-22.json"));
const raw = JSON.parse(fs.readFileSync(tradesFile, "utf8"));
// Include settled no-trade controls too. Restricting replay to windows where
// the target wallet happened to trade leaks its private activity decision into
// every strategy backtest and inflates precision/PnL.
const markets = raw.markets.filter((market) => market.winner).sort((a, b) => a.slug.localeCompare(b.slug));
const BASE = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!KEY) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const outputDir = path.join(dataDir, "feeds/v4-top");
fs.mkdirSync(outputDir, { recursive: true });
const concurrency = Math.max(1, Number(process.env.W3048_TOP_CONCURRENCY || 20));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 100)}`);
      return await response.json();
    } catch (error) {
      last = error;
      await sleep(Math.min(3000, 200 * 2 ** attempt));
    }
  }
  throw last;
}

function topAsks(book, targetDepth = 300, maxLevels = 20) {
  const levels = (book?.asks || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0).sort((a, b) => a.price - b.price);
  const out = []; let depth = 0;
  for (const level of levels) {
    out.push(level); depth += level.size;
    if ((depth >= targetDepth && out.length >= 3) || out.length >= maxLevels) break;
  }
  return out;
}

function cachePath(slug) { return path.join(outputDir, `${slug}.json.gz`); }
async function collect(market) {
  const file = cachePath(market.slug);
  if (fs.existsSync(file)) return "cached";
  const fullCache = path.join(dataDir, "feeds/v4-l2", `${market.slug}.json.gz`);
  if (fs.existsSync(fullCache)) {
    const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(fullCache)));
    const feed = {
      ...full,
      ticks: full.ticks.map((tick) => {
        const upAsks = topAsks(tick.up);
        const downAsks = topAsks(tick.down);
        return { ms: tick.ms, bz: tick.bz, cl: null, upAsk: upAsks[0]?.price ?? null, dnAsk: downAsks[0]?.price ?? null, up: { asks: upAsks }, down: { asks: downAsks } };
      }),
    };
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(feed), { level: 5 }));
    return "downloaded";
  }
  const url = `${BASE}/markets/${encodeURIComponent(market.slug)}/snapshots?page=1&limit=5000&include_orderbook=true`;
  const body = await getJson(url);
  const feed = {
    slug: market.slug,
    openBinance: Number(body.binanceSpotPriceStart ?? market.openBinance),
    openChainlink: Number(body.coinPriceStart ?? market.openChainlink),
    winner: body.winner ?? market.winner,
    ticks: (body.ticks || []).map((tick) => {
      const upAsks = topAsks(tick.orderbookUp);
      const downAsks = topAsks(tick.orderbookDown);
      return {
        ms: new Date(tick.time).getTime(),
        bz: tick.binanceSpotPrice == null ? null : Number(tick.binanceSpotPrice),
        cl: null,
        upAsk: upAsks[0]?.price ?? null,
        dnAsk: downAsks[0]?.price ?? null,
        up: { asks: upAsks },
        down: { asks: downAsks },
      };
    }),
  };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(feed), { level: 5 }));
  return "downloaded";
}

let cursor = 0, done = 0, cached = 0, downloaded = 0;
async function lane() {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    const status = await collect(markets[index]);
    if (status === "cached") cached++; else downloaded++;
    done++;
    if (done % 25 === 0 || done === markets.length) console.log(JSON.stringify({ done, total: markets.length, cached, downloaded }));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, markets.length) }, lane));
console.log(JSON.stringify({ outputDir, markets: markets.length, cached, downloaded }));
