#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../.env")); } catch {}
const root = path.resolve(import.meta.dirname, "..");
const manifestFile = path.resolve(process.argv[2] || path.join(root, "data/research/strict-maker-all-markets.json"));
const outRoot = path.resolve(process.argv[3] || path.join(root, "data/research/strict-maker-all-market-feeds"));
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const markets = (manifest.markets || []).map((market) => ({
  ...market,
  openChainlink: market.openChainlinkProvider,
}));
if (!markets.length) throw new Error("manifest contains no markets");

const existing = {
  v2L2: [
    "data/wallet-3048-v2-native-aug16/feeds/v2-l2", "data/passive-maker-forward-v15/feeds/v2-l2",
    "data/wallet-3048-r5/feeds/v2-l2", "data/wallet-3048-r6/feeds/v2-l2", "data/wallet-3048-r7/feeds/v2-l2",
    "data/lockstep-v2-orderbooks", path.relative(root, path.join(outRoot, "v2-l2")),
  ],
  v4L2: [
    "data/wallet-3048/feeds/v4-post-twap-full-l2", "data/wallet-3048/feeds/v4-current-policy-l2",
    "data/wallet-3048/feeds/v4-e8-l2", "data/wallet-3048/feeds/v4-r2-l2", "data/wallet-3048-r3/feeds/v4-l2",
    "data/wallet-3048/feeds/v4-l2", "data/wallet-3048-r4/feeds/v4-l2", "data/passive-maker-forward-v15/feeds/v4-l2",
    "data/wallet-3048-r5/feeds/v4-l2", "data/wallet-3048-r6/feeds/v4-l2", "data/wallet-3048-r7/feeds/v4-l2",
    "data/lockstep-v4-top", path.relative(root, path.join(outRoot, "v4-l2")),
  ],
  controls: [
    "data/wallet-3048/feeds/v2", "data/wallet-3048-r3/feeds/v2", "data/wallet-3048-r4/feeds/v2",
    "data/wallet-3048-r5/feeds/v2", "data/passive-maker-forward-v15/feeds/v2", path.relative(root, path.join(outRoot, "v2")),
  ],
  trades: [
    "data/wallet-3048/feeds/market-trades", "data/wallet-3048-r3/feeds/market-trades",
    "data/wallet-3048-r4/feeds/market-trades", "data/wallet-3048-r5/feeds/market-trades",
    "data/passive-maker-forward-v15/feeds/market-trades", "data/wallet-3048-r6/feeds/market-trades",
    path.relative(root, path.join(outRoot, "market-trades")),
  ],
};
for (const key of Object.keys(existing)) existing[key] = existing[key].map((dir) => path.resolve(root, dir));
for (const dir of [outRoot, path.join(outRoot, "v2-l2"), path.join(outRoot, "v4-l2"), path.join(outRoot, "v2"), path.join(outRoot, "market-trades")])
  fs.mkdirSync(dir, { recursive: true });

function present(dirs, slug) {
  return dirs.some((dir) => fs.existsSync(path.join(dir, `${slug}.json.gz`)));
}
const missing = Object.fromEntries(Object.entries(existing).map(([key, dirs]) => [key,
  markets.filter((market) => !present(dirs, market.slug))]));
console.log(JSON.stringify({ phase: "strict-feed-gaps", markets: markets.length,
  missing: Object.fromEntries(Object.entries(missing).map(([key, rows]) => [key, rows.length])) }));

function writeMini(name, rows) {
  const file = path.join(outRoot, `${name}-manifest.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, markets: rows }, null, 2) + "\n");
  return file;
}
function run(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root, env: { ...process.env, ...env }, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${script} killed by ${signal}`))
      : code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

const jobs = [];
if (missing.v2L2.length) jobs.push(run("research/wallet-3048/collect-v2-orderbooks.mjs", [
  writeMini("missing-v2-l2", missing.v2L2), path.join(outRoot, "v2-l2"),
], { W3048_V2_L2_CONCURRENCY: "3" }));
if (missing.controls.length) jobs.push(run("research/wallet-3048/collect-v2-controls.mjs", [
  writeMini("missing-controls", missing.controls), path.join(outRoot, "v2"),
]));
if (missing.trades.length) jobs.push(run("research/collect-market-taker-trades.mjs", [
  writeMini("missing-trades", missing.trades), path.join(outRoot, "market-trades"),
]));

const v4Base = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const key = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
const headers = { Accept: "application/json", "X-API-Key": key, Authorization: `Bearer ${key}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
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
const levels = (rows, direction) => (rows || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
  .filter((row) => row.price > 0 && row.price < 1 && row.size > 0)
  .sort((a, b) => direction * (a.price - b.price));
async function collectV4(market) {
  const ticks = [];
  let head;
  for (let page = 1; ; page++) {
    const url = new URL(`markets/${encodeURIComponent(market.slug)}/snapshots`, `${v4Base}/`);
    for (const [name, value] of Object.entries({ page, limit: 5000, include_orderbook: "true" })) url.searchParams.set(name, String(value));
    const body = await getJson(url);
    if (!head) head = body;
    for (const tick of body.ticks || []) ticks.push({
      ms: Date.parse(tick.time || tick.tick_time || ""),
      bz: Number(tick.binanceSpotPrice ?? tick.binance_spot_price) || null,
      cl: null,
      up: { asks: levels(tick.orderbookUp?.asks || tick.orderbook_up?.asks, 1), bids: levels(tick.orderbookUp?.bids || tick.orderbook_up?.bids, -1) },
      down: { asks: levels(tick.orderbookDown?.asks || tick.orderbook_down?.asks, 1), bids: levels(tick.orderbookDown?.bids || tick.orderbook_down?.bids, -1) },
    });
    if (page >= Number(body.pagination?.totalPages || 1)) break;
  }
  const compact = {
    schema: 1, source: `${v4Base}/markets/{slug}/snapshots`, slug: market.slug,
    openBinance: Number(head?.binanceSpotPriceStart) || market.openBinance,
    openChainlink: Number(head?.coinPriceStart) || market.openChainlinkProvider,
    winner: head?.winner || market.winner,
    sparseWindow: head?.sparseWindow === true,
    isStale: head?.isStale === true,
    upToken: market.upToken,
    downToken: market.downToken,
    ticks: ticks.filter((tick) => Number.isFinite(tick.ms) && tick.up.asks.length && tick.down.asks.length),
  };
  fs.writeFileSync(path.join(outRoot, "v4-l2", `${market.slug}.json.gz`), zlib.gzipSync(JSON.stringify(compact), { level: 5 }));
}
if (missing.v4L2.length) jobs.push((async () => {
  let cursor = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.v4L2.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= missing.v4L2.length) return;
      await collectV4(missing.v4L2[index]);
      done++;
      console.log(JSON.stringify({ phase: "strict-missing-v4", done, total: missing.v4L2.length }));
    }
  }));
})());

await Promise.all(jobs);
const remaining = Object.fromEntries(Object.entries(existing).map(([name, dirs]) => [name,
  markets.filter((market) => !present(dirs, market.slug)).map((market) => market.slug)]));
const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  manifest: manifestFile,
  markets: markets.length,
  initiallyMissing: Object.fromEntries(Object.entries(missing).map(([name, rows]) => [name, rows.length])),
  remaining,
  passed: Object.values(remaining).every((rows) => rows.length === 0),
};
fs.writeFileSync(path.join(outRoot, "coverage.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 2;
