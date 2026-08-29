#!/usr/bin/env node
/**
 * Paired replay of the deployed Lockstep profile on bapi-v2 and bapi-v4
 * full-depth orderbooks, with every analysis window verified against
 * Gamma market metadata. Emits JSON, per-window CSV, daily CSV and Markdown.
 *
 * Usage:
 *   node research/lockstep-v2-v4-paired-backtest.mjs \
 *     2026-08-16T00:00:00Z 2026-08-24T12:30:00Z [output-directory]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  STRAT,
  clearLivePending,
  fillFee,
  injectRealFill,
  stepSignalHedge,
} from "../engine/strategy.js";
import { computeIntensity, roundExcursion } from "../engine/intensity.js";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../.env")); } catch {}

const ROOT = path.resolve(import.meta.dirname, "..");
const WINDOW_MS = 300_000;
const WARMUP_ROUNDS = 6;
const FROM_MS = Date.parse(process.argv[2] || "2026-08-16T00:00:00Z");
const defaultTo = Math.floor((Date.now() - 15 * 60_000) / WINDOW_MS) * WINDOW_MS;
const TO_MS = process.argv[3] ? Date.parse(process.argv[3]) : defaultTo;
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");
const RANGE_TAG = `${new Date(FROM_MS).toISOString().slice(0, 10)}_${new Date(TO_MS).toISOString().replaceAll(":", "-")}`;
const OUT_DIR = path.resolve(process.argv[4] || path.join(ROOT, "data/research", `lockstep-v2-v4-${RANGE_TAG}`));
const V2_CACHE = path.join(ROOT, "data/lockstep-v2-orderbooks");
const V4_CACHE = path.join(ROOT, "data/lockstep-v4-top");
const GAMMA_CACHE = path.join(ROOT, "data/gamma-btc-5m");
for (const dir of [OUT_DIR, V2_CACHE, V4_CACHE, GAMMA_CACHE]) fs.mkdirSync(dir, { recursive: true });

const V2_BASE = String(process.env.BACKTEST_API || "https://bapi-v2.polywinbot.com").replace(/\/+$/, "");
const V4_BASE = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const GAMMA_BASE = String(process.env.GAMMA_HOST || "https://gamma-api.polymarket.com").replace(/\/+$/, "");
const KEY = String(process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || "").trim();
if (!KEY) throw new Error("missing bapi API key");
const BAPI_HEADERS = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const MAKER_LATENCY_MS = Math.max(0, Number(process.env.LOCKSTEP_MAKER_LATENCY_MS || 130));
const TAKER_LATENCY_MS = Math.max(0, Number(process.env.LOCKSTEP_TAKER_LATENCY_MS || 520));
const REST_TIMEOUT_MS = 10_000;
const runtimeConfigFile = path.join(ROOT, "data/runtime-config.json");
const runtimeConfig = fs.existsSync(runtimeConfigFile) ? JSON.parse(fs.readFileSync(runtimeConfigFile, "utf8")) : {};
const deployed = runtimeConfig.shadowParams && typeof runtimeConfig.shadowParams === "object"
  ? runtimeConfig.shadowParams
  : {};
const paramsOverrideFile = String(process.env.LOCKSTEP_PARAMS_FILE || "").trim();
const paramsOverride = paramsOverrideFile
  ? JSON.parse(fs.readFileSync(path.resolve(paramsOverrideFile), "utf8"))
  : {};
const PARAMS = Object.freeze({
  ...STRAT,
  ...deployed,
  ...paramsOverride,
  STRATEGY: "lockstep",
  WINDOW_SEC: 300,
  LATENCY_MS: TAKER_LATENCY_MS,
  LIVE_FILLS: true,
  // This report evaluates the paper profile's decision window. LIVE_FILLS is
  // used only to inject depth-aware fills, not to pull the close cutoff early.
  L_LIVE_CLOSE_MARGIN_S: 0,
  MERGE_ON: false,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 6) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);
const slugStart = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
const gzipRead = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const gzipWrite = (file, value) => fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(value), { level: 6 }));

async function fetchJson(url, { headers = {}, attempts = 7 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get("retry-after")) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(8_000, 250 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 180)}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt + 1 < attempts) await sleep(Math.min(8_000, 250 * 2 ** attempt));
    }
  }
  throw last;
}

async function mapConcurrent(items, concurrency, worker, label) {
  const output = new Array(items.length);
  let cursor = 0, done = 0;
  async function lane() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { output[index] = await worker(items[index], index); }
      catch (error) { output[index] = { error: String(error?.message || error) }; }
      done++;
      if (done % 100 === 0 || done === items.length) console.log(JSON.stringify({ phase: label, done, total: items.length }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, lane));
  return output;
}

async function listMarkets() {
  const markets = [];
  const warmupFrom = FROM_MS - WARMUP_ROUNDS * WINDOW_MS;
  for (let page = 1; ; page++) {
    const url = new URL("markets", `${V4_BASE}/`);
    for (const [key, value] of Object.entries({
      coin: "BTC",
      market_type: "5m",
      resolved: "true",
      from: iso(warmupFrom),
      to: iso(TO_MS),
      page,
      limit: 500,
    })) url.searchParams.set(key, String(value));
    const body = await fetchJson(url, { headers: BAPI_HEADERS });
    markets.push(...(body.markets || []));
    if (page >= Number(body.pagination?.totalPages || 1)) break;
  }
  const unique = new Map();
  for (const market of markets) {
    const startMs = Date.parse(market.startTime || "") || slugStart(market.slug);
    if (startMs >= warmupFrom && startMs < TO_MS && market.slug) unique.set(market.slug, { ...market, startMs });
  }
  return [...unique.values()].sort((a, b) => a.startMs - b.startMs);
}

const V2_SOURCE_DIRS = [
  V2_CACHE,
  path.join(ROOT, "data/wallet-3048-v2-native-aug16/feeds/v2-l2"),
  path.join(ROOT, "data/wallet-3048-r5/feeds/v2-l2"),
  path.join(ROOT, "data/passive-maker-forward-v15/feeds/v2-l2"),
  path.join(ROOT, "data/passive-maker-forward-v14/feeds/v2-l2"),
  path.join(ROOT, "data/passive-maker-forward-v13b/feeds/v2-l2"),
];

function firstExisting(dirs, slug) {
  for (const dir of dirs) {
    const file = path.join(dir, `${slug}.json.gz`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function fetchV2(market) {
  const frames = [];
  let head = null;
  for (let page = 1; ; page++) {
    const url = new URL("orderbooks", `${V2_BASE}/`);
    for (const [key, value] of Object.entries({ slug: market.slug, page, limit: 2000 })) url.searchParams.set(key, String(value));
    const body = await fetchJson(url, { headers: BAPI_HEADERS });
    if (!head) head = body;
    for (const frame of body.frames || []) frames.push({
      ms: Number(frame.capturedAtMs),
      bz: Number(frame.binanceAggPrice ?? frame.binancePrice) || null,
      cl: Number(frame.twapPrice ?? frame.chainlinkPrice) || null,
      up: compactLevels(frame.orderbookUp),
      down: compactLevels(frame.orderbookDown),
    });
    if (page >= Number(body.pagination?.totalPages || 1)) break;
  }
  const value = {
    slug: market.slug,
    source: `${V2_BASE}/orderbooks`,
    frameIntervalMs: Number(head?.frameIntervalMs) || 50,
    openBinance: Number(head?.openBinancePrice ?? market.binanceSpotPriceStart) || frames.find((frame) => frame.bz)?.bz || null,
    openChainlink: Number(head?.openPrice ?? market.coinPriceStart) || frames.find((frame) => frame.cl)?.cl || null,
    winner: head?.winSide ?? market.winner ?? null,
    ticks: frames,
  };
  gzipWrite(path.join(V2_CACHE, `${market.slug}.json.gz`), value);
  return value;
}

async function ensureV2(market) {
  const file = firstExisting(V2_SOURCE_DIRS, market.slug);
  if (file) return { value: gzipRead(file), file, cached: true };
  const value = await fetchV2(market);
  return { value, file: path.join(V2_CACHE, `${market.slug}.json.gz`), cached: false };
}

function normalizeLevels(raw) {
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) {
    const levels = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const price = Number(raw[index]), size = Number(raw[index + 1]);
      if (price > 0 && price < 1 && size > 0) levels.push({ price, size });
    }
    return levels.sort((a, b) => a.price - b.price);
  }
  const asks = raw?.asks || raw?.upAsks || raw?.downAsks || [];
  return asks.map((level) => ({
    price: Number(level.price ?? level[0]),
    size: Number(level.size ?? level[1]),
  })).filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function compactLevels(raw, targetDepth = 100, maxLevels = 20) {
  const output = [];
  let depth = 0;
  for (const level of normalizeLevels(raw)) {
    output.push(level.price, level.size);
    depth += level.size;
    if (depth >= targetDepth || output.length >= maxLevels * 2) break;
  }
  return output;
}

async function fetchV4(market) {
  const urlFor = (page) => {
    const url = new URL(`markets/${encodeURIComponent(market.slug)}/snapshots`, `${V4_BASE}/`);
    for (const [key, value] of Object.entries({ page, limit: 5000, include_orderbook: "true" })) url.searchParams.set(key, String(value));
    return url;
  };
  const head = await fetchJson(urlFor(1), { headers: BAPI_HEADERS });
  const rawTicks = [...(head.ticks || [])];
  for (let page = 2; page <= Number(head.pagination?.totalPages || 1); page++) {
    const body = await fetchJson(urlFor(page), { headers: BAPI_HEADERS });
    rawTicks.push(...(body.ticks || []));
  }
  const value = {
    slug: market.slug,
    openBinance: Number(head.binanceSpotPriceStart ?? market.binanceSpotPriceStart) || null,
    openChainlink: Number(head.coinPriceStart ?? market.coinPriceStart) || null,
    winner: head.winner ?? market.winner ?? null,
    sparseWindow: head.sparseWindow === true,
    isStale: head.isStale === true,
    ticks: rawTicks.map((tick) => ({
      ms: Date.parse(tick.time || tick.tick_time || ""),
      bz: Number(tick.binanceSpotPrice ?? tick.binance_spot_price) || null,
      up: compactLevels(tick.orderbookUp || tick.orderbook_up),
      down: compactLevels(tick.orderbookDown || tick.orderbook_down),
    })),
  };
  gzipWrite(path.join(V4_CACHE, `${market.slug}.json.gz`), value);
  return value;
}

async function ensureV4(market) {
  const file = path.join(V4_CACHE, `${market.slug}.json.gz`);
  if (fs.existsSync(file)) return { value: gzipRead(file), file, cached: true };
  const value = await fetchV4(market);
  return { value, file, cached: false };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function normalizeGamma(raw, slug) {
  const outcomes = parseJsonArray(raw?.outcomes).map(String);
  const prices = parseJsonArray(raw?.outcomePrices).map(Number);
  const parsedTokens = parseJsonArray(raw?.clobTokenIds ?? raw?.tokens).map(String);
  const tokens = parsedTokens.length >= 2
    ? parsedTokens
    : [raw?.upToken, raw?.downToken].filter(Boolean).map(String);
  const winnerIndex = prices.findIndex((price) => price >= .999);
  const explicitWinner = /^up$/i.test(raw?.winner || "") ? "Up"
    : /^down$/i.test(raw?.winner || "") ? "Down"
      : null;
  const winner = explicitWinner || (winnerIndex >= 0 ? outcomes[winnerIndex] : null);
  return {
    slug,
    id: raw?.id == null ? null : String(raw.id),
    conditionId: raw?.conditionId ? String(raw.conditionId).toLowerCase() : null,
    closed: raw?.closed === true,
    acceptingOrders: raw?.acceptingOrders === true,
    outcomes,
    outcomePrices: prices,
    tokens,
    winner: /^up$/i.test(winner || "") ? "Up" : /^down$/i.test(winner || "") ? "Down" : null,
    endDate: raw?.endDate || null,
  };
}

async function ensureGamma(market) {
  const file = path.join(GAMMA_CACHE, `${market.slug}.json.gz`);
  if (fs.existsSync(file)) {
    const value = normalizeGamma(gzipRead(file), market.slug);
    if (value.winner && value.conditionId && value.tokens.length >= 2) {
      return { value, file, cached: true };
    }
  }
  const url = new URL(`markets/slug/${encodeURIComponent(market.slug)}`, `${GAMMA_BASE}/`);
  const raw = await fetchJson(url, { attempts: 8 });
  const value = normalizeGamma(raw, market.slug);
  gzipWrite(file, value);
  return { value, file, cached: false };
}

function normalizeV2(raw, startMs) {
  const ticks = (raw?.ticks || []).map((tick) => {
    const ms = Number(tick.ms ?? tick.capturedAtMs);
    const upAsks = normalizeLevels(tick.up || tick.orderbookUp || { asks: tick.upAsks });
    const downAsks = normalizeLevels(tick.down || tick.orderbookDown || { asks: tick.downAsks });
    const bz = Number(tick.bz ?? tick.binancePrice);
    return {
      ms,
      t: (ms - startMs) / 1000,
      bz: bz > 0 ? bz : null,
      up: { asks: upAsks, bestAsk: upAsks[0]?.price ?? null },
      down: { asks: downAsks, bestAsk: downAsks[0]?.price ?? null },
    };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.ms >= startMs - 2_000 && tick.ms < startMs + WINDOW_MS + 2_000
    && tick.up.bestAsk != null && tick.down.bestAsk != null).sort((a, b) => a.ms - b.ms);
  const openBinance = Number(raw?.openBinance ?? raw?.openBinancePrice);
  return {
    source: "v2",
    openBinance: openBinance > 0 ? openBinance : ticks.find((tick) => tick.bz)?.bz,
    sourceWinner: /^up$/i.test(raw?.winner || raw?.winSide || "") ? "Up" : /^down$/i.test(raw?.winner || raw?.winSide || "") ? "Down" : null,
    ticks,
    quality: ticks.length > 20 && openBinance > 0 ? "ok" : ticks.length <= 20 ? "sparse" : "missing-open",
  };
}

function normalizeV4(raw, startMs) {
  const ticks = (raw?.ticks || []).map((tick) => {
    const ms = Number(tick.ms ?? Date.parse(tick.time || tick.tick_time || ""));
    const upAsks = normalizeLevels(tick.up || tick.orderbookUp || { asks: tick.upAsks });
    const downAsks = normalizeLevels(tick.down || tick.orderbookDown || { asks: tick.downAsks });
    const bz = Number(tick.bz ?? tick.binanceSpotPrice ?? tick.binance_spot_price);
    return {
      ms,
      t: (ms - startMs) / 1000,
      bz: bz > 0 ? bz : null,
      up: { asks: upAsks, bestAsk: upAsks[0]?.price ?? null },
      down: { asks: downAsks, bestAsk: downAsks[0]?.price ?? null },
    };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.ms >= startMs - 2_000 && tick.ms < startMs + WINDOW_MS + 2_000
    && tick.up.bestAsk != null && tick.down.bestAsk != null).sort((a, b) => a.ms - b.ms);
  const openBinance = Number(raw?.openBinance ?? raw?.binanceSpotPriceStart);
  const flagged = raw?.sparseWindow === true || raw?.isStale === true;
  return {
    source: "v4",
    openBinance: openBinance > 0 ? openBinance : ticks.find((tick) => tick.bz)?.bz,
    sourceWinner: /^up$/i.test(raw?.winner || "") ? "Up" : /^down$/i.test(raw?.winner || "") ? "Down" : null,
    ticks,
    quality: flagged ? "api-quality-flag" : ticks.length < 30 ? "sparse" : openBinance > 0 ? "ok" : "missing-open",
  };
}

function walkAsks(book, requestedShares, limitPrice, depthAware) {
  if (!(requestedShares > 0)) return null;
  if (!depthAware) {
    const ask = Number(book?.bestAsk);
    return ask > 0 && ask <= limitPrice + 1e-12
      ? { shares: requestedShares, cost: requestedShares * ask, price: ask }
      : null;
  }
  let remaining = requestedShares, shares = 0, cost = 0;
  for (const level of book?.asks || []) {
    if (level.price > limitPrice + 1e-12) break;
    const take = Math.min(remaining, level.size);
    shares += take;
    cost += take * level.price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  return shares > 1e-9 ? { shares, cost, price: cost / shares } : null;
}

function replayWindow(feed, winner, intensity, depthAware) {
  const state = {};
  const fills = [];
  const arriving = [];
  const activeTakers = [];
  const activeMakers = [];
  let previousMs = null;
  let staleSkips = 0;
  let postOnlyRejects = 0;
  let depthShortfallShares = 0;
  const addFill = ({ order, shares, price, fillMs, maker }) => {
    if (!(shares > 0 && price > 0)) return;
    injectRealFill(state, { leg: order.leg, side: order.side, shares, px: price, oid: order.oid });
    fills.push({
      leg: order.leg,
      side: order.side,
      oid: order.oid,
      maker,
      decisionMs: order.decisionMs,
      arrivalMs: order.arrivalMs,
      fillMs,
      requestedShares: order.requestedShares,
      shares,
      price,
      cost: shares * price,
      fee: fillFee(price, shares, !maker),
      limitPrice: order.limitPrice,
    });
  };

  const processArrivals = (tick) => {
    for (let index = arriving.length - 1; index >= 0; index--) {
      const order = arriving[index];
      if (order.arrivalMs > tick.ms) continue;
      arriving.splice(index, 1);
      const book = order.side === "Up" ? tick.up : tick.down;
      if (order.maker) {
        // A post-only order that already crosses at queue arrival is rejected.
        if (book.bestAsk <= order.limitPrice + 1e-12) {
          postOnlyRejects++;
          clearLivePending(state, order.oid);
        } else {
          activeMakers.push({ ...order, filled: 0, lastMs: tick.ms });
        }
      } else {
        activeTakers.push({ ...order, remaining: order.requestedShares, deadlineMs: order.arrivalMs + REST_TIMEOUT_MS });
      }
    }
  };

  const processTakers = (tick) => {
    for (let index = activeTakers.length - 1; index >= 0; index--) {
      const order = activeTakers[index];
      const book = order.side === "Up" ? tick.up : tick.down;
      const actual = walkAsks(book, order.remaining, order.limitPrice, depthAware);
      if (actual) {
        addFill({ order, shares: actual.shares, price: actual.price, fillMs: tick.ms, maker: false });
        order.remaining -= actual.shares;
      }
      if (order.remaining <= 1e-6 || tick.ms >= order.deadlineMs) {
        if (order.remaining > 1e-6) depthShortfallShares += order.remaining;
        clearLivePending(state, order.oid);
        activeTakers.splice(index, 1);
      }
    }
  };

  const processMakers = (tick) => {
    for (let index = activeMakers.length - 1; index >= 0; index--) {
      const order = activeMakers[index];
      const book = order.side === "Up" ? tick.up : tick.down;
      const ask = Number(book.bestAsk);
      const dtMs = Math.max(0, tick.ms - order.lastMs);
      order.lastMs = tick.ms;
      // A zero fill percentage is the strict no-maker-credit stress: even a
      // crossed snapshot cannot prove our private queue position filled.
      if (Number(PARAMS.L_SIM_FILL_PCT ?? 100) <= 0) continue;
      let targetFilled = order.filled;
      if (ask < order.limitPrice - 1e-12) targetFilled = order.requestedShares;
      else if (Math.abs(ask - order.limitPrice) <= 1e-12) {
        const fraction = Math.max(0, Math.min(1, Number(PARAMS.L_SIM_FILL_PCT ?? 100) / 100));
        const touchMs = Math.max(10, Number(PARAMS.L_SIM_TOUCH_MS || 250));
        targetFilled = Math.min(order.requestedShares, order.filled + fraction * dtMs / touchMs * order.requestedShares);
      }
      const delta = targetFilled - order.filled;
      if (delta > 1e-9) {
        addFill({ order, shares: delta, price: order.limitPrice, fillMs: tick.ms, maker: true });
        order.filled = targetFilled;
      }
      if (order.filled >= order.requestedShares - 1e-6) activeMakers.splice(index, 1);
    }
  };

  for (const tick of feed.ticks) {
    const gapMs = previousMs == null ? 0 : tick.ms - previousMs;
    previousMs = tick.ms;
    processArrivals(tick);
    processTakers(tick);
    processMakers(tick);
    if (gapMs > 6_000 || tick.bz == null) { staleSkips++; continue; }
    const generated = stepSignalHedge(state, {
      t: tick.t,
      up: { bestAsk: tick.up.bestAsk, bestBid: 1 - tick.down.bestAsk },
      down: { bestAsk: tick.down.bestAsk, bestBid: 1 - tick.up.bestAsk },
      bzGap: tick.bz - feed.openBinance,
      bzGapPct: (tick.bz - feed.openBinance) / feed.openBinance * 100,
      intensity,
      winHour: new Date(tick.ms - tick.t * 1000).getUTCHours(),
      winDay: new Date(tick.ms - tick.t * 1000).getUTCDay(),
    }, PARAMS, gapMs > 0 ? gapMs : 120, tick.ms);
    for (const order of generated.filter((row) => row.leg === "entry" || row.leg === "hedge")) {
      const maker = order.postOnly === true || order.exec === "maker" || order.maker === true;
      arriving.push({
        ...order,
        maker,
        decisionMs: tick.ms,
        arrivalMs: tick.ms + (maker ? MAKER_LATENCY_MS : TAKER_LATENCY_MS),
        requestedShares: Number(order.shares),
        limitPrice: Number(order.limitPx ?? PARAMS.LIMIT),
      });
      arriving.sort((a, b) => a.arrivalMs - b.arrivalMs);
    }
  }

  for (const order of [...arriving, ...activeTakers, ...activeMakers]) clearLivePending(state, order.oid);
  const cost = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const fees = fills.reduce((sum, fill) => sum + fill.fee, 0);
  const payout = fills.filter((fill) => fill.side === winner).reduce((sum, fill) => sum + fill.shares, 0);
  const entryFills = fills.filter((fill) => fill.leg === "entry");
  const hedgeFills = fills.filter((fill) => fill.leg === "hedge");
  const entryShares = entryFills.reduce((sum, fill) => sum + fill.shares, 0);
  const hedgeShares = hedgeFills.reduce((sum, fill) => sum + fill.shares, 0);
  const weightedPrice = (rows) => {
    const shares = rows.reduce((sum, row) => sum + row.shares, 0);
    return shares > 0 ? rows.reduce((sum, row) => sum + row.cost, 0) / shares : null;
  };
  return {
    active: entryShares > 1e-9,
    entrySide: entryFills[0]?.side || null,
    entryDecisionMs: entryFills[0]?.decisionMs ?? null,
    entryFillMs: entryFills[0]?.fillMs ?? null,
    entryShares: round(entryShares),
    entryPrice: round(weightedPrice(entryFills)),
    hedgeShares: round(hedgeShares),
    hedgePrice: round(weightedPrice(hedgeFills)),
    hedged: hedgeShares > 1e-9,
    fullyHedged: entryShares > 0 && hedgeShares >= entryShares - 1e-6,
    makerHedgeShares: round(hedgeFills.filter((fill) => fill.maker).reduce((sum, fill) => sum + fill.shares, 0)),
    trades: fills.length,
    cost: round(cost),
    fees: round(fees),
    payout: round(payout),
    deployed: round(cost + fees),
    pnl: round(payout - cost - fees),
    staleSkips,
    postOnlyRejects,
    depthShortfallShares: round(depthShortfallShares),
    fills: fills.map((fill) => ({ ...fill, price: round(fill.price), cost: round(fill.cost), fee: round(fill.fee), shares: round(fill.shares) })),
  };
}

function emptyResult(status) {
  return {
    status,
    ticks: 0,
    firstTickMs: null,
    lastTickMs: null,
    active: false,
    entrySide: null,
    entryDecisionMs: null,
    entryFillMs: null,
    entryShares: 0,
    entryPrice: null,
    hedgeShares: 0,
    hedgePrice: null,
    hedged: false,
    fullyHedged: false,
    makerHedgeShares: 0,
    trades: 0,
    cost: 0,
    fees: 0,
    payout: 0,
    deployed: 0,
    pnl: 0,
    staleSkips: 0,
    postOnlyRejects: 0,
    depthShortfallShares: 0,
    fills: [],
  };
}

function maxDrawdown(rows, field) {
  let equity = 0, peak = 0, drawdown = 0;
  for (const row of rows) {
    equity += Number(row[field] || 0);
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return round(drawdown);
}

function sourceSummary(rows, key) {
  const values = rows.map((row) => row[key]).filter((row) => row.status === "ok");
  const active = values.filter((row) => row.active);
  const sum = (field) => values.reduce((total, row) => total + Number(row[field] || 0), 0);
  const grossProfit = values.filter((row) => row.pnl > 0).reduce((total, row) => total + row.pnl, 0);
  const grossLoss = -values.filter((row) => row.pnl < 0).reduce((total, row) => total + row.pnl, 0);
  const deployedTotal = sum("deployed"), pnl = sum("pnl");
  return {
    usableWindows: values.length,
    activeWindows: active.length,
    trades: sum("trades"),
    fullHedges: active.filter((row) => row.fullyHedged).length,
    correctEntries: active.filter((row) => row.entrySide === row.winner).length,
    profitableWindows: active.filter((row) => row.pnl > 0).length,
    deployed: round(deployedTotal),
    fees: round(sum("fees")),
    pnl: round(pnl),
    roiPct: deployedTotal > 0 ? round(pnl / deployedTotal * 100) : 0,
    pnlPerActive: active.length ? round(pnl / active.length) : 0,
    entryAccuracyPct: active.length ? round(active.filter((row) => row.entrySide === row.winner).length / active.length * 100) : 0,
    maxDrawdown: maxDrawdown(rows, `${key}Pnl`),
    profitFactor: grossLoss > 1e-9 ? round(grossProfit / grossLoss) : grossProfit > 0 ? "Infinity" : 0,
    depthShortfallShares: round(sum("depthShortfallShares")),
    postOnlyRejects: sum("postOnlyRejects"),
  };
}

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows, fields) {
  const lines = [fields.join(",")];
  for (const row of rows) lines.push(fields.map((field) => csvEscape(row[field])).join(","));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

const markets = await listMarkets();
const analysisMarkets = markets.filter((market) => market.startMs >= FROM_MS && market.startMs < TO_MS);
console.log(JSON.stringify({ phase: "listed", markets: markets.length, analysisMarkets: analysisMarkets.length, from: iso(FROM_MS), to: iso(TO_MS) }));

const gammaRows = await mapConcurrent(analysisMarkets, 20, ensureGamma, "gamma");
const gammaBySlug = new Map();
for (let index = 0; index < analysisMarkets.length; index++) {
  const result = gammaRows[index];
  if (result && !result.error) gammaBySlug.set(analysisMarkets[index].slug, result.value);
}

const buffers = { v2: [], v4: [] };
const windowRows = [];
let feedsProcessed = 0;
for (const market of markets) {
  const [v2Attempt, v4Attempt] = await Promise.allSettled([ensureV2(market), ensureV4(market)]);
  const feedRow = {
    v2: v2Attempt.status === "fulfilled" ? v2Attempt.value : { error: String(v2Attempt.reason?.message || v2Attempt.reason) },
    v4: v4Attempt.status === "fulfilled" ? v4Attempt.value : { error: String(v4Attempt.reason?.message || v4Attempt.reason) },
  };
  let v2Feed = null, v4Feed = null;
  try { if (feedRow?.v2?.value) v2Feed = normalizeV2(feedRow.v2.value, market.startMs); } catch {}
  try { if (feedRow?.v4?.value) v4Feed = normalizeV4(feedRow.v4.value, market.startMs); } catch {}
  const gamma = gammaBySlug.get(market.slug) || null;
  const inRange = market.startMs >= FROM_MS && market.startMs < TO_MS;
  const winner = gamma?.winner || null;
  const row = inRange ? {
    slug: market.slug,
    startMs: market.startMs,
    startUtc: iso(market.startMs),
    day: dayOf(market.startMs),
    gammaStatus: gamma?.winner && gamma?.conditionId && gamma?.tokens?.length >= 2 ? "ok" : gamma ? "unresolved" : "missing",
    conditionId: gamma?.conditionId || null,
    upToken: gamma?.tokens?.[0] || null,
    downToken: gamma?.tokens?.[1] || null,
    winner,
    v2Winner: v2Feed?.sourceWinner || null,
    v4Winner: v4Feed?.sourceWinner || null,
    winnerAgreement: Boolean(winner && (!v2Feed?.sourceWinner || v2Feed.sourceWinner === winner)
      && (!v4Feed?.sourceWinner || v4Feed.sourceWinner === winner)),
    v2: emptyResult(v2Feed?.quality || (feedRow?.v2?.error ? "fetch-error" : "missing")),
    v4: emptyResult(v4Feed?.quality || (feedRow?.v4?.error ? "fetch-error" : "missing")),
  } : null;

  for (const [key, feed, depthAware] of [["v2", v2Feed, true], ["v4", v4Feed, true]]) {
    const ready = buffers[key].length >= WARMUP_ROUNDS;
    if (row && feed?.quality === "ok" && winner && ready) {
      const intensity = computeIntensity(buffers[key], PARAMS);
      const result = replayWindow(feed, winner, intensity, depthAware);
      row[key] = {
        status: "ok",
        ticks: feed.ticks.length,
        firstTickMs: feed.ticks[0]?.ms ?? null,
        lastTickMs: feed.ticks.at(-1)?.ms ?? null,
        winner,
        intensity: round(intensity),
        ...result,
      };
    } else if (row) {
      row[key].ticks = feed?.ticks?.length || 0;
      row[key].firstTickMs = feed?.ticks?.[0]?.ms ?? null;
      row[key].lastTickMs = feed?.ticks?.at(-1)?.ms ?? null;
      row[key].status = !winner ? `gamma-${row.gammaStatus}` : feed?.quality !== "ok" ? (feed?.quality || "missing") : "warmup-unavailable";
      row[key].winner = winner;
    }
    if (feed?.quality === "ok") {
      buffers[key].push(roundExcursion(feed.ticks.map((tick) => tick.bz).filter((value) => value > 0), feed.openBinance));
      if (buffers[key].length > WARMUP_ROUNDS) buffers[key].shift();
    }
  }
  if (row) {
    row.v2Pnl = row.v2.pnl;
    row.v4Pnl = row.v4.pnl;
    row.pnlDeltaV4MinusV2 = row.v2.status === "ok" && row.v4.status === "ok" ? round(row.v4.pnl - row.v2.pnl) : null;
    windowRows.push(row);
  }
  feedsProcessed++;
  if (feedsProcessed % 100 === 0 || feedsProcessed === markets.length) {
    console.log(JSON.stringify({ phase: "feed-replay", done: feedsProcessed, total: markets.length }));
  }
}

const dailyMap = new Map();
for (const row of windowRows) {
  const day = dailyMap.get(row.day) || {
    day: row.day,
    expectedWindows: 0,
    gammaVerified: 0,
    pairedUsable: 0,
    v2Usable: 0,
    v2Active: 0,
    v2Trades: 0,
    v2Deployed: 0,
    v2Fees: 0,
    v2Pnl: 0,
    v4Usable: 0,
    v4Active: 0,
    v4Trades: 0,
    v4Deployed: 0,
    v4Fees: 0,
    v4Pnl: 0,
    pairedV2Pnl: 0,
    pairedV4Pnl: 0,
    pnlDeltaV4MinusV2: 0,
  };
  day.expectedWindows++;
  if (row.gammaStatus === "ok") day.gammaVerified++;
  if (row.v2.status === "ok") {
    day.v2Usable++;
    day.v2Active += row.v2.active ? 1 : 0;
    day.v2Trades += row.v2.trades;
    day.v2Deployed += row.v2.deployed;
    day.v2Fees += row.v2.fees;
    day.v2Pnl += row.v2.pnl;
  }
  if (row.v4.status === "ok") {
    day.v4Usable++;
    day.v4Active += row.v4.active ? 1 : 0;
    day.v4Trades += row.v4.trades;
    day.v4Deployed += row.v4.deployed;
    day.v4Fees += row.v4.fees;
    day.v4Pnl += row.v4.pnl;
  }
  if (row.v2.status === "ok" && row.v4.status === "ok") {
    day.pairedUsable++;
    day.pairedV2Pnl += row.v2.pnl;
    day.pairedV4Pnl += row.v4.pnl;
    day.pnlDeltaV4MinusV2 += row.v4.pnl - row.v2.pnl;
  }
  dailyMap.set(row.day, day);
}
const daily = [...dailyMap.values()].map((row) => ({
  ...row,
  v2Deployed: round(row.v2Deployed),
  v2Fees: round(row.v2Fees),
  v2Pnl: round(row.v2Pnl),
  v4Deployed: round(row.v4Deployed),
  v4Fees: round(row.v4Fees),
  v4Pnl: round(row.v4Pnl),
  pairedV2Pnl: round(row.pairedV2Pnl),
  pairedV4Pnl: round(row.pairedV4Pnl),
  pnlDeltaV4MinusV2: round(row.pnlDeltaV4MinusV2),
}));

const v2Summary = sourceSummary(windowRows, "v2");
const v4Summary = sourceSummary(windowRows, "v4");
const pairedRows = windowRows.filter((row) => row.v2.status === "ok" && row.v4.status === "ok");
const pairedV2Pnl = pairedRows.reduce((sum, row) => sum + row.v2.pnl, 0);
const pairedV4Pnl = pairedRows.reduce((sum, row) => sum + row.v4.pnl, 0);
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: { from: iso(FROM_MS), to: iso(TO_MS), halfOpen: true, expectedWindows: Math.floor((TO_MS - FROM_MS) / WINDOW_MS) },
  source: {
    v2: `${V2_BASE}/orderbooks (full depth)`,
    v4: `${V4_BASE}/markets/{slug}/snapshots?include_orderbook=true (depth)`,
    gamma: `${GAMMA_BASE}/markets/slug/{slug}`,
  },
  methodology: {
    strategy: "exact deployed Lockstep stepSignalHedge code; current runtime-config profile frozen at report start",
    signal: "Binance spot versus Binance aggTrade window open, causal six-completed-window volatility intensity",
    outcome: "Gamma outcomePrices winner; v2/v4 winners retained only for agreement audit",
    v2Execution: "marketable GTC walks recorded native v2 ask depth up to the strategy limit; unmatched remainder may execute on later books for at most 10 seconds",
    v4Execution: "marketable GTC walks recorded asks up to the strategy limit; unmatched remainder may execute on later books for at most 10 seconds",
    makerExecution: "post-only arrival after 130ms; crossing arrivals reject; resting fill uses the deployed 250ms/100%-at-touch model because snapshots do not reveal private queue position",
    takerExecution: "decision-to-fill/arrival latency 520ms; symmetric crypto taker fee curve charged; maker fills fee-free",
    exclusions: "quality-flagged/sparse/missing-open feeds and Gamma-unresolved windows remain explicit rows with zero reported PnL",
  },
  params: PARAMS,
  coverage: {
    requestedWindows: windowRows.length,
    gammaVerified: windowRows.filter((row) => row.gammaStatus === "ok").length,
    winnerDisagreements: windowRows.filter((row) => row.gammaStatus === "ok" && !row.winnerAgreement).length,
    v2Usable: v2Summary.usableWindows,
    v4Usable: v4Summary.usableWindows,
    pairedUsable: pairedRows.length,
  },
  summary: {
    v2: v2Summary,
    v4: v4Summary,
    sourceTotalPnlDeltaV4MinusV2: round(v4Summary.pnl - v2Summary.pnl),
    paired: {
      windows: pairedRows.length,
      v2Pnl: round(pairedV2Pnl),
      v4Pnl: round(pairedV4Pnl),
      pnlDeltaV4MinusV2: round(pairedV4Pnl - pairedV2Pnl),
    },
  },
  daily,
  windows: windowRows,
};

const jsonFile = path.join(OUT_DIR, "report.json");
const windowsCsv = path.join(OUT_DIR, "windows.csv");
const dailyCsv = path.join(OUT_DIR, "daily.csv");
const markdownFile = path.join(OUT_DIR, "REPORT.md");
fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2) + "\n");

const flatWindows = windowRows.map((row) => ({
  slug: row.slug,
  startUtc: row.startUtc,
  day: row.day,
  gammaStatus: row.gammaStatus,
  conditionId: row.conditionId,
  upToken: row.upToken,
  downToken: row.downToken,
  winner: row.winner,
  v2Winner: row.v2Winner,
  v4Winner: row.v4Winner,
  winnerAgreement: row.winnerAgreement,
  v2Status: row.v2.status,
  v2Ticks: row.v2.ticks,
  v2FirstTickUtc: row.v2.firstTickMs ? iso(row.v2.firstTickMs) : null,
  v2LastTickUtc: row.v2.lastTickMs ? iso(row.v2.lastTickMs) : null,
  v2Intensity: row.v2.intensity,
  v2Active: row.v2.active,
  v2EntrySide: row.v2.entrySide,
  v2EntryDecisionUtc: row.v2.entryDecisionMs ? iso(row.v2.entryDecisionMs) : null,
  v2EntryFillUtc: row.v2.entryFillMs ? iso(row.v2.entryFillMs) : null,
  v2EntryShares: row.v2.entryShares,
  v2EntryPrice: row.v2.entryPrice,
  v2HedgeShares: row.v2.hedgeShares,
  v2HedgePrice: row.v2.hedgePrice,
  v2FullyHedged: row.v2.fullyHedged,
  v2Trades: row.v2.trades,
  v2Deployed: row.v2.deployed,
  v2Fees: row.v2.fees,
  v2Pnl: row.v2.pnl,
  v4Status: row.v4.status,
  v4Ticks: row.v4.ticks,
  v4FirstTickUtc: row.v4.firstTickMs ? iso(row.v4.firstTickMs) : null,
  v4LastTickUtc: row.v4.lastTickMs ? iso(row.v4.lastTickMs) : null,
  v4Intensity: row.v4.intensity,
  v4Active: row.v4.active,
  v4EntrySide: row.v4.entrySide,
  v4EntryDecisionUtc: row.v4.entryDecisionMs ? iso(row.v4.entryDecisionMs) : null,
  v4EntryFillUtc: row.v4.entryFillMs ? iso(row.v4.entryFillMs) : null,
  v4EntryShares: row.v4.entryShares,
  v4EntryPrice: row.v4.entryPrice,
  v4HedgeShares: row.v4.hedgeShares,
  v4HedgePrice: row.v4.hedgePrice,
  v4FullyHedged: row.v4.fullyHedged,
  v4Trades: row.v4.trades,
  v4Deployed: row.v4.deployed,
  v4Fees: row.v4.fees,
  v4DepthShortfallShares: row.v4.depthShortfallShares,
  v4Pnl: row.v4.pnl,
  pnlDeltaV4MinusV2: row.pnlDeltaV4MinusV2,
}));
writeCsv(windowsCsv, flatWindows, Object.keys(flatWindows[0] || {}));
writeCsv(dailyCsv, daily, Object.keys(daily[0] || {}));

const dailyLines = daily.map((row) => `| ${row.day} | ${row.expectedWindows} | ${row.v2Usable} | $${row.v2Pnl.toFixed(2)} | ${row.v4Usable} | $${row.v4Pnl.toFixed(2)} | ${row.pairedUsable} | $${row.pairedV2Pnl.toFixed(2)} | $${row.pairedV4Pnl.toFixed(2)} | $${row.pnlDeltaV4MinusV2.toFixed(2)} |`);
const verdict = v4Summary.pnl > 0 && v4Summary.profitFactor !== "Infinity" && Number(v4Summary.profitFactor) > 1
  ? "The requested v4 sample is positive, but this alone does not establish stable or guaranteed profitability."
  : "The requested v4 sample does not pass a positive stable-profit gate. The bot must remain in simulation.";
const markdown = `# Lockstep paired v2/v4 backtest\n\n` +
`Generated: ${output.generatedAt}\n\n` +
`Range: **${output.range.from} to ${output.range.to}** (half-open, UTC)  \n` +
`Profile: deployed Lockstep, ${PARAMS.SIZE} shares, maker ${MAKER_LATENCY_MS}ms, taker ${TAKER_LATENCY_MS}ms.\n\n` +
`## Coverage\n\n` +
`- Requested windows: ${output.coverage.requestedWindows}\n` +
`- Gamma verified: ${output.coverage.gammaVerified}\n` +
`- Paired usable: ${output.coverage.pairedUsable}\n` +
`- Winner disagreements: ${output.coverage.winnerDisagreements}\n\n` +
`## Totals\n\n` +
`| source | usable | active | trades | deployed | fees | pnl | ROI | max drawdown | profit factor |\n` +
`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
`| v2 depth | ${v2Summary.usableWindows} | ${v2Summary.activeWindows} | ${v2Summary.trades} | $${v2Summary.deployed.toFixed(2)} | $${v2Summary.fees.toFixed(2)} | $${v2Summary.pnl.toFixed(2)} | ${v2Summary.roiPct.toFixed(3)}% | $${v2Summary.maxDrawdown.toFixed(2)} | ${v2Summary.profitFactor} |\n` +
`| v4 depth | ${v4Summary.usableWindows} | ${v4Summary.activeWindows} | ${v4Summary.trades} | $${v4Summary.deployed.toFixed(2)} | $${v4Summary.fees.toFixed(2)} | $${v4Summary.pnl.toFixed(2)} | ${v4Summary.roiPct.toFixed(3)}% | $${v4Summary.maxDrawdown.toFixed(2)} | ${v4Summary.profitFactor} |\n\n` +
`On the same ${output.summary.paired.windows} usable windows, v2 PnL was **$${output.summary.paired.v2Pnl.toFixed(2)}** and v4 PnL was **$${output.summary.paired.v4Pnl.toFixed(2)}** (v4 − v2: **$${output.summary.paired.pnlDeltaV4MinusV2.toFixed(2)}**).\n\n` +
`## Daily\n\n` +
`| UTC day | expected | v2 usable | v2 pnl | v4 usable | v4 pnl | paired | paired v2 | paired v4 | paired v4−v2 |\n` +
`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${dailyLines.join("\n")}\n\n` +
`## Interpretation\n\n${verdict}\n\n` +
`Both v2 and v4 walk recorded ask depth. Maker fills remain a queue-model estimate because public snapshots do not reveal private queue position; crossing post-only arrivals are rejected. Some event streams stop updating before 300 seconds when the executable book ceases changing, so the CSV includes first/last tick timestamps for audit. Every requested window, including unavailable and no-trade windows, is retained in [windows.csv](./windows.csv).\n`;
fs.writeFileSync(markdownFile, markdown);

const manifest = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: output.range,
  files: [
    path.relative(ROOT, new URL(import.meta.url).pathname),
    path.relative(ROOT, runtimeConfigFile),
    ...(paramsOverrideFile ? [path.relative(ROOT, path.resolve(paramsOverrideFile))] : []),
    path.relative(ROOT, jsonFile),
    path.relative(ROOT, windowsCsv),
    path.relative(ROOT, dailyCsv),
    path.relative(ROOT, markdownFile),
  ].map((relative) => {
    const file = path.join(ROOT, relative);
    return { path: relative, bytes: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  }),
};
fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ phase: "complete", output: OUT_DIR, coverage: output.coverage, summary: output.summary }, null, 2));
