#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../.env")); } catch {}
const root = path.resolve(import.meta.dirname, "..");
const fromMs = Date.parse(process.argv[2] || "2026-08-16T00:00:00Z");
const requestedToMs = Date.parse(process.argv[3] || new Date().toISOString());
const output = path.resolve(process.argv[4] || path.join(root, "data/research/strict-maker-all-markets.json"));
if (!Number.isFinite(fromMs) || !Number.isFinite(requestedToMs) || requestedToMs <= fromMs) throw new Error("invalid from/to range");
const base = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const key = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!key) throw new Error("BAPI_V4_KEY / BAPI_KEY / BACKTEST_API_KEY is required");
const headers = { Accept: "application/json", "X-API-Key": key, Authorization: `Bearer ${key}` };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await sleep(Math.min(8_000, 250 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < 6) await sleep(Math.min(8_000, 250 * 2 ** attempt));
    }
  }
  throw last;
}

const markets = [];
for (let page = 1; ; page++) {
  const url = new URL("markets", `${base}/`);
  for (const [name, value] of Object.entries({
    coin: "BTC", market_type: "5m", resolved: "true",
    from: new Date(fromMs).toISOString(), to: new Date(requestedToMs).toISOString(), page, limit: 500,
  })) url.searchParams.set(name, String(value));
  const body = await getJson(url);
  markets.push(...(body.markets || []));
  if (page >= Number(body.pagination?.totalPages || 1)) break;
}

const rows = markets.map((market) => ({
  slug: String(market.slug || ""),
  conditionId: String(market.conditionId || "").toLowerCase(),
  upToken: String(market.clobTokenUp || ""),
  downToken: String(market.clobTokenDown || ""),
  startTime: market.startTime,
  endTime: market.endTime,
  openBinance: Number(market.binanceSpotPriceStart) || null,
  openChainlinkProvider: Number(market.coinPriceStart) || null,
  winner: /^up$/i.test(market.winner || "") ? "Up" : /^down$/i.test(market.winner || "") ? "Down" : null,
  snapshotTotal: Number(market.snapshotTotal) || 0,
  orderbooksSynced: market.orderbooksSynced === true,
  sparseWindow: market.sparseWindow === true,
  isStale: market.isStale === true,
})).filter((market) => {
  const start = Date.parse(market.startTime || "");
  const end = Date.parse(market.endTime || "");
  return start >= fromMs && start < requestedToMs && end <= requestedToMs && market.slug && market.winner;
}).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

const starts = new Set(rows.map((row) => Date.parse(row.startTime)));
const missingCadence = [];
if (rows.length) for (let ms = Date.parse(rows[0].startTime); ms <= Date.parse(rows.at(-1).startTime); ms += 300_000) {
  if (!starts.has(ms)) missingCadence.push(`btc-updown-5m-${Math.floor(ms / 1000)}`);
}
const duplicateSlugs = rows.map((row) => row.slug).filter((slug, index, all) => all.indexOf(slug) !== index);
const invalidIdentity = rows.filter((row) => !/^0x[0-9a-f]{64}$/.test(row.conditionId)
  || !/^\d+$/.test(row.upToken) || !/^\d+$/.test(row.downToken)).map((row) => row.slug);
const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: `${base}/markets`,
  range: {
    requestedFrom: new Date(fromMs).toISOString(),
    requestedTo: new Date(requestedToMs).toISOString(),
    first: rows[0]?.startTime || null,
    last: rows.at(-1)?.startTime || null,
    markets: rows.length,
  },
  audit: {
    contiguousFiveMinuteCadence: missingCadence.length === 0,
    missingCadence,
    duplicateSlugs,
    invalidIdentity,
    sparseWindows: rows.filter((row) => row.sparseWindow).length,
    staleWindows: rows.filter((row) => row.isStale).length,
    unsyncedOrderbooks: rows.filter((row) => !row.orderbooksSynced).length,
  },
  slugs: rows.map((row) => row.slug),
  markets: rows,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output, range: result.range, audit: result.audit }, null, 2));
if (missingCadence.length || duplicateSlugs.length || invalidIdentity.length) process.exitCode = 2;
