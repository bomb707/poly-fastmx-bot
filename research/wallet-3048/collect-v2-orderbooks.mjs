#!/usr/bin/env node
/**
 * Collect bapi-v2's native 50 ms full order-book frames.
 *
 * Route: GET /orderbooks?slug&page&limit
 * The compact cache preserves executable asks/bids and both independent spot
 * observations while trimming distant levels that cannot affect this wallet's
 * 25/75-share orders or its depth-3 release features.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}
const root = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048-r5/trades.json"));
const outDir = path.resolve(process.argv[3] || path.join(path.dirname(input), "feeds/v2-l2"));
const base = String(process.env.BAPI_V2_BASE || process.env.BACKTEST_API || "https://bapi-v2.polywinbot.com").replace(/\/+$/, "");
const pageLimit = Math.max(100, Math.min(5_000, Number(process.env.W3048_V2_L2_PAGE_LIMIT || 2_000)));
const concurrency = Math.max(1, Number(process.env.W3048_V2_L2_CONCURRENCY || 3));
const maxLevels = Math.max(3, Number(process.env.W3048_V2_L2_LEVELS || 20));
const fromMs = Date.parse(String(process.env.W3048_V2_L2_FROM || ""));
const toMs = Date.parse(String(process.env.W3048_V2_L2_TO || ""));
const source = JSON.parse(fs.readFileSync(input, "utf8"));
const marketStartMs = (market) => {
  const timestamp = Number(String(market?.slug || "").split("-").at(-1));
  return Number.isFinite(timestamp) ? timestamp * 1000 : Date.parse(String(market?.startTime || ""));
};
const markets = (source.markets || []).filter((market) => {
  if (!market.winner) return false;
  const startMs = marketStartMs(market);
  return (!Number.isFinite(fromMs) || startMs >= fromMs)
    && (!Number.isFinite(toMs) || startMs < toMs);
}).sort((a, b) => a.slug.localeCompare(b.slug));
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await sleep(Math.min(8_000, 300 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < 6) await sleep(Math.min(8_000, 300 * 2 ** attempt));
    }
  }
  throw last;
}

function levels(raw, side) {
  return (raw || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => side === "asks" ? a.price - b.price : b.price - a.price)
    .slice(0, maxLevels);
}

function book(raw) {
  return { asks: levels(raw?.asks, "asks"), bids: levels(raw?.bids, "bids") };
}

async function collect(market) {
  const file = path.join(outDir, `${market.slug}.json.gz`);
  if (fs.existsSync(file)) return "cached";
  const frames = [];
  let head = null;
  for (let page = 1; ; page++) {
    const url = new URL("orderbooks", `${base}/`);
    url.searchParams.set("slug", market.slug);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(pageLimit));
    const body = await getJson(url);
    if (!head) head = body;
    for (const frame of body.frames || []) frames.push({
      ms: Number(frame.capturedAtMs),
      bz: Number(frame.binanceAggPrice ?? frame.binancePrice) || null,
      cl: Number(frame.twapPrice ?? frame.chainlinkPrice) || null,
      up: book(frame.orderbookUp),
      down: book(frame.orderbookDown),
    });
    if (page >= Number(body.pagination?.totalPages || 1)) break;
  }
  const compact = {
    schema: 1,
    source: `${base}/orderbooks`,
    frameIntervalMs: Number(head?.frameIntervalMs) || 50,
    slug: market.slug,
    openBinance: Number(market.openBinance) || frames.find((frame) => frame.bz)?.bz || null,
    openChainlink: Number(market.openChainlink) || frames.find((frame) => frame.cl)?.cl || null,
    winner: market.winner,
    upToken: head?.upTokenId ? String(head.upTokenId) : market.upToken || null,
    downToken: head?.downTokenId ? String(head.downTokenId) : market.downToken || null,
    ticks: frames.filter((frame) => Number.isFinite(frame.ms) && frame.up.asks.length && frame.down.asks.length),
  };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(compact), { level: 5 }));
  return "downloaded";
}

let cursor = 0, done = 0, cached = 0, downloaded = 0, failed = 0;
const errors = [];
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, markets.length)) }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    try {
      const result = await collect(markets[index]);
      if (result === "cached") cached++; else downloaded++;
    } catch (error) {
      failed++;
      errors.push({ slug: markets[index].slug, error: String(error?.message || error) });
    }
    done++;
    if (done % 10 === 0 || done === markets.length) console.log(JSON.stringify({ phase: "v2-orderbooks", done, total: markets.length, cached, downloaded, failed }));
  }
}));
const summary = { schema: 1, generatedAt: new Date().toISOString(), input, outDir, markets: markets.length,
  range: {
    from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
    to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null,
  },
  frameIntervalMs: 50, maxLevels, cached, downloaded, failed, errors };
fs.writeFileSync(path.join(path.dirname(outDir), "v2-orderbooks-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
if (failed) process.exitCode = 2;
