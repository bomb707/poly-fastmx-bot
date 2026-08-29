#!/usr/bin/env node
/** Verify a wallet-research market cohort against Gamma's canonical slug data. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048-r5/trades.json"));
const outDir = path.resolve(process.argv[3] || path.dirname(input));
const cacheDir = path.resolve(process.argv[4] || path.join(root, "data/gamma-btc-5m"));
const base = String(process.env.GAMMA_HOST || "https://gamma-api.polymarket.com").replace(/\/+$/, "");
const concurrency = Math.max(1, Number(process.env.W3048_GAMMA_CONCURRENCY || 20));
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

const source = JSON.parse(fs.readFileSync(input, "utf8"));
const markets = source.markets || [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parseArray = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
};

async function fetchJson(url) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        const retryAfter = Number(response.headers.get("retry-after")) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(5_000, 200 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < 6) await sleep(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
  throw last;
}

function normalize(raw, slug) {
  const outcomes = parseArray(raw?.outcomes).map(String);
  const prices = parseArray(raw?.outcomePrices).map(Number);
  const tokens = parseArray(raw?.clobTokenIds).map(String);
  const byOutcome = Object.fromEntries(outcomes.map((outcome, index) => [outcome.toLowerCase(), {
    token: tokens[index] || null,
    price: Number.isFinite(prices[index]) ? prices[index] : null,
  }]));
  let winner = null;
  if (prices.length === outcomes.length && prices.length) {
    const index = prices.indexOf(Math.max(...prices));
    if (prices[index] >= .99 && /^(up|down)$/i.test(outcomes[index] || "")) winner = outcomes[index][0].toUpperCase() + outcomes[index].slice(1).toLowerCase();
  }
  return {
    slug,
    conditionId: raw?.conditionId ? String(raw.conditionId).toLowerCase() : null,
    closed: raw?.closed === true,
    acceptingOrders: raw?.acceptingOrders === true,
    winner,
    upToken: byOutcome.up?.token || null,
    downToken: byOutcome.down?.token || null,
    outcomePrices: prices,
    endDate: raw?.endDate || null,
  };
}

async function gamma(market) {
  const file = path.join(cacheDir, `${market.slug}.json.gz`);
  if (fs.existsSync(file)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const raw = await fetchJson(`${base}/markets/slug/${encodeURIComponent(market.slug)}`);
  const value = normalize(raw, market.slug);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(value), { level: 6 }));
  return value;
}

const rows = new Array(markets.length);
let cursor = 0, done = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, markets.length)) }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= markets.length) return;
    const market = markets[index];
    try {
      const canonical = await gamma(market);
      const conditionAgreement = String(market.conditionId || "").toLowerCase() === canonical.conditionId;
      const winnerAgreement = !market.winner || !canonical.winner || market.winner === canonical.winner;
      const tokenAgreement = (!market.upToken || !canonical.upToken || String(market.upToken) === canonical.upToken)
        && (!market.downToken || !canonical.downToken || String(market.downToken) === canonical.downToken);
      rows[index] = { slug: market.slug, status: canonical.closed && canonical.winner ? "verified" : "unresolved",
        sourceWinner: market.winner || null, ...canonical, conditionAgreement, winnerAgreement, tokenAgreement };
    } catch (error) {
      rows[index] = { slug: market.slug, status: "error", error: String(error?.message || error) };
    }
    done++;
    if (done % 50 === 0 || done === markets.length) console.log(JSON.stringify({ phase: "gamma", done, total: markets.length }));
  }
}));

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: input,
  endpoint: `${base}/markets/slug/{slug}`,
  markets: rows.length,
  verified: rows.filter((row) => row.status === "verified").length,
  unresolved: rows.filter((row) => row.status === "unresolved").length,
  errors: rows.filter((row) => row.status === "error").length,
  conditionDisagreements: rows.filter((row) => row.status !== "error" && !row.conditionAgreement).length,
  winnerDisagreements: rows.filter((row) => row.status !== "error" && !row.winnerAgreement).length,
  tokenDisagreements: rows.filter((row) => row.status !== "error" && !row.tokenAgreement).length,
};
fs.writeFileSync(path.join(outDir, "gamma-verification.json"), JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
if (summary.errors || summary.conditionDisagreements || summary.winnerDisagreements || summary.tokenDisagreements) process.exitCode = 2;
