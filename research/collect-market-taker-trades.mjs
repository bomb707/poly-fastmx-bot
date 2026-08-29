#!/usr/bin/env node
/** Collect market-wide taker prints from the public Polymarket Data API. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dedupeExactMarketTrades } from "./market-trade-dedupe.mjs";

const input = path.resolve(process.argv[2]);
const outputDir = path.resolve(process.argv[3]);
const source = JSON.parse(fs.readFileSync(input, "utf8"));
const slugDir = String(process.env.MARKET_TRADES_SLUG_DIR || "").trim();
const allowedSlugs = slugDir
  ? new Set(fs.readdirSync(path.resolve(slugDir)).filter((name) => name.endsWith(".json.gz")).map((name) => name.slice(0, -8)))
  : null;
const markets = (source.markets || []).filter((market) => market.conditionId && market.slug
  && (!allowedSlugs || allowedSlugs.has(market.slug)));
const concurrency = Math.max(1, Number(process.env.MARKET_TRADES_CONCURRENCY || 10));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outputDir, { recursive: true });

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      return response.json();
    } catch (error) {
      last = error;
      await sleep(Math.min(8_000, 300 * 2 ** attempt));
    }
  }
  throw last;
}

let cursor = 0, done = 0, cached = 0, downloaded = 0, duplicatesDropped = 0;
async function lane() {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    const market = markets[index], file = path.join(outputDir, `${market.slug}.json.gz`);
    let currentSchema = 0;
    if (fs.existsSync(file)) {
      try { currentSchema = Number(JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).schema || 0); } catch {}
    }
    if (currentSchema >= 3) cached++;
    else {
      const url = new URL("https://data-api.polymarket.com/trades");
      url.searchParams.set("market", String(market.conditionId));
      url.searchParams.set("takerOnly", "true");
      url.searchParams.set("limit", "10000");
      url.searchParams.set("offset", "0");
      const rows = await getJson(url);
      if (!Array.isArray(rows)) throw new Error(`unexpected response for ${market.slug}`);
      if (rows.length >= 9950) throw new Error(`${market.slug} reached the 10,000-row public trade limit`);
      const startMs = Number(String(market.slug).split("-").at(-1)) * 1000;
      const normalized = rows.map((row) => ({
        // Data API timestamps have one-second precision. Move them to the end
        // of the reported second so the replay never credits a fill early.
        ms: (Number(row.timestamp) + 1) * 1000,
        sourceSide: String(row.side || ""), sourceOutcome: String(row.outcome || ""), sourcePrice: Number(row.price),
        size: Number(row.size), transactionHash: String(row.transactionHash || "").toLowerCase(),
      })).map((row) => row.sourceSide === "SELL"
        ? { ...row, side: "SELL", outcome: row.sourceOutcome, price: row.sourcePrice }
        : { ...row, side: "PAIR_BUY", outcome: row.sourceOutcome === "Up" ? "Down" : "Up", price: 1 - row.sourcePrice })
        .filter((row) => (row.sourceSide === "SELL" || row.sourceSide === "BUY") && (row.outcome === "Up" || row.outcome === "Down")
        && row.price > 0 && row.price < 1 && row.size > 0 && row.ms >= startMs && row.ms < startMs + 305_000)
        .sort((a, b) => a.ms - b.ms || b.price - a.price || a.transactionHash.localeCompare(b.transactionHash));
      const deduped = dedupeExactMarketTrades(normalized);
      duplicatesDropped += deduped.duplicatesDropped;
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ schema: 3, slug: market.slug, conditionId: market.conditionId,
        exactDuplicatesDropped: deduped.duplicatesDropped, trades: deduped.trades }), { level: 6 }));
      downloaded++;
    }
    done++;
    if (done % 25 === 0 || done === markets.length) console.log(JSON.stringify({ done, total: markets.length, cached, downloaded }));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, markets.length) }, lane));
console.log(JSON.stringify({ outputDir, markets: markets.length, cached, downloaded, duplicatesDropped }));
