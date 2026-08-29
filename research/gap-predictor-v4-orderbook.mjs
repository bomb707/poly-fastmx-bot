/**
 * Gap Predictor replay against bapi-v4 Binance ticks and full L2 order books.
 *
 * Usage:
 *   node research/gap-predictor-v4-orderbook.mjs [fromIso] [toIso]
 *
 * `fromIso`/`toIso` bound a half-open 24h analysis range by window start.
 * Six earlier usable windows are fetched as causal volatility warm-up.
 */
import {
  STRAT,
  step,
  injectRealFill,
  clearLivePending,
} from "../engine/strategies/gap_predictor.js";
import fs from "node:fs";
import path from "node:path";
import { fillFee } from "../engine/strategy.js";
import { computeIntensity, roundExcursion } from "../engine/intensity.js";

try { process.loadEnvFile?.(new URL("../.env", import.meta.url)); } catch {}

const BASE = String(process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = String(
  process.env.BAPI_V4_KEY ||
  process.env.BAPI_V3_KEY ||
  process.env.BAPI_KEY ||
  process.env.BACKTEST_API_KEY ||
  "",
).trim();
if (!KEY) throw new Error("Set BAPI_V4_KEY, BAPI_V3_KEY, BAPI_KEY, or BACKTEST_API_KEY");

const WINDOW_MS = 300_000;
const WARMUP_ROUNDS = 6;
const DEFAULT_TO_MS = Math.floor((Date.now() - 15 * 60_000) / WINDOW_MS) * WINDOW_MS;
const toMs = process.argv[3] ? Date.parse(process.argv[3]) : DEFAULT_TO_MS;
const fromMs = process.argv[2] ? Date.parse(process.argv[2]) : toMs - 24 * 60 * 60_000;
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  throw new Error("fromIso/toIso must define a valid half-open range");
}
const warmupFromMs = fromMs - WARMUP_ROUNDS * WINDOW_MS;
const OUTPUT = path.resolve(process.env.GAP_V4_OUTPUT || new URL("../data/research/gap-predictor-v4-orderbook.json", import.meta.url).pathname);
const BOOTSTRAP_SAMPLES = Math.max(1000, Number(process.env.GAP_V4_BOOTSTRAP_SAMPLES || 5000));

const headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path, query = {}, attempt = 0) {
  const url = new URL(path, `${BASE}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    if (attempt >= 5) throw error;
    await sleep(600 * 2 ** attempt);
    return getJson(path, query, attempt + 1);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    const retryMs = Number(response.headers.get("retry-after")) * 1000;
    await sleep(Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 600 * 2 ** attempt);
    return getJson(path, query, attempt + 1);
  }
  if (!response.ok) throw new Error(`bapi-v4 ${response.status} ${url.pathname}: ${(await response.text()).slice(0, 180)}`);
  return response.json();
}

async function listMarkets() {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await getJson("markets", {
      coin: "BTC",
      market_type: "5m",
      resolved: "true",
      from: new Date(warmupFromMs).toISOString(),
      to: new Date(toMs + WINDOW_MS).toISOString(),
      page,
      limit: 500,
    });
    out.push(...(body.markets || []));
    if (page >= (body.pagination?.totalPages || 1)) break;
  }
  return out
    .filter((market) => {
      const start = Date.parse(market.startTime || "");
      return start >= warmupFromMs && start < toMs;
    })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

async function fetchWindow(market) {
  const path = `markets/${encodeURIComponent(market.slug)}/snapshots`;
  const body = await getJson(path, {
    page: 1,
    limit: 5000,
    include_orderbook: "true",
  });
  const ticks = [...(body.ticks || [])];
  const totalPages = body.pagination?.totalPages || 1;
  for (let page = 2; page <= totalPages; page++) {
    const next = await getJson(path, {
      page,
      limit: 5000,
      include_orderbook: "true",
    });
    ticks.push(...(next.ticks || []));
  }
  return { market, body: { ...body, ticks } };
}

function bookSide(raw) {
  const asks = (raw?.asks || [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  return { asks, bestAsk: asks[0]?.price ?? null };
}

function normalizeWindow({ market, body }) {
  const startMs = Date.parse(market.startTime || body.startTime || "");
  const ticks = (body.ticks || []).map((raw) => {
    const ms = Date.parse(raw.time || raw.tick_time || "");
    const up = bookSide(raw.orderbookUp || raw.orderbook_up);
    const down = bookSide(raw.orderbookDown || raw.orderbook_down);
    const bz = Number(raw.binanceSpotPrice ?? raw.binance_spot_price);
    return { ms, t: (ms - startMs) / 1000, bz: bz > 0 ? bz : null, up, down };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.up.bestAsk != null && tick.down.bestAsk != null)
    .sort((a, b) => a.ms - b.ms);

  const openBinance = Number(body.binanceSpotPriceStart ?? market.binanceSpotPriceStart);
  return {
    slug: market.slug,
    startMs,
    winner: /^up$/i.test(body.winner || market.winner) ? "Up" : "Down",
    openBinance: openBinance > 0 ? openBinance : ticks.find((tick) => tick.bz != null)?.bz,
    // Trust v4's recorder-level quality flags. A full-L2 join can contain fewer
    // book-bearing rows than raw Binance/CLOB ticks without making it non-causal.
    sparse: body.sparseWindow === true || body.isStale === true || ticks.length < 30,
    ticks,
  };
}

function walkAsks(book, requestedShares, limitPrice) {
  let remaining = requestedShares;
  let filled = 0;
  let cost = 0;
  for (const level of book?.asks || []) {
    if (level.price > limitPrice + 1e-12) break;
    const shares = Math.min(remaining, level.size);
    filled += shares;
    cost += shares * level.price;
    remaining -= shares;
    if (remaining <= 1e-9) break;
  }
  return filled > 1e-9 ? { shares: filled, price: cost / filled, cost } : null;
}

const PARAMS = {
  ...STRAT,
  LIVE_FILLS: true,
  LATENCY_MS: 0,
  MERGE_ON: false,
};

function replayWindow(window, intensity, latencyMs, params = PARAMS) {
  const state = {};
  const fills = [];
  const pending = [];
  let staleSkips = 0;
  let previousMs = null;

  const execute = (order, tick) => {
    const book = order.side === "Up" ? tick.up : tick.down;
    const actual = walkAsks(book, order.shares, order.limitPx ?? params.LIMIT);
    if (!actual) {
      clearLivePending(state, order.oid);
      return;
    }
    injectRealFill(state, {
      leg: order.leg,
      side: order.side,
      shares: actual.shares,
      px: actual.price,
      oid: order.oid,
    });
    if (actual.shares < order.shares - 1e-6) clearLivePending(state, order.oid);
    fills.push({
      ...order,
      decidedMs: order.decidedMs,
      fillMs: order.dueMs,
      requestedShares: order.shares,
      shares: actual.shares,
      effPx: actual.price,
      usdc: actual.cost,
      partial: actual.shares < order.shares - 1e-6,
    });
  };

  for (let index = 0; index < window.ticks.length; index++) {
    const tick = window.ticks[index];
    while (pending.length && pending[0].dueMs <= tick.ms) {
      const order = pending.shift();
      // An order becomes executable at `dueMs`; the first recorded book at or
      // after that instant is the observable arrival book.
      execute(order, tick);
    }

    const gapMs = previousMs == null ? 0 : tick.ms - previousMs;
    previousMs = tick.ms;
    if (gapMs > 6000 || tick.bz == null) {
      staleSkips++;
      continue;
    }

    const generated = step(state, {
      t: tick.t,
      up: { bestAsk: tick.up.bestAsk, bestBid: 1 - tick.down.bestAsk },
      down: { bestAsk: tick.down.bestAsk, bestBid: 1 - tick.up.bestAsk },
      bzGap: tick.bz - window.openBinance,
      bzGapPct: ((tick.bz - window.openBinance) / window.openBinance) * 100,
      intensity,
      winHour: new Date(window.startMs).getUTCHours(),
      winDay: new Date(window.startMs).getUTCDay(),
    }, params, gapMs > 0 ? gapMs : 120, tick.ms);

    for (const order of generated.filter((fill) => fill.leg === "entry" || fill.leg === "hedge")) {
      const queued = { ...order, decidedMs: tick.ms, dueMs: tick.ms + latencyMs };
      if (latencyMs <= 0) execute(queued, tick);
      else pending.push(queued);
    }
  }

  const grossCost = fills.reduce((sum, fill) => sum + fill.usdc, 0);
  const fees = fills.reduce((sum, fill) => sum + fillFee(fill.effPx, fill.shares, true), 0);
  const payout = fills.filter((fill) => fill.side === window.winner).reduce((sum, fill) => sum + fill.shares, 0);
  const pnl = payout - grossCost - fees;
  const entry = fills.find((fill) => fill.leg === "entry") || null;
  return {
    fills,
    entry,
    hedged: fills.some((fill) => fill.leg === "hedge"),
    pnl,
    deployed: grossCost + fees,
    grossCost,
    fees,
    payout,
    staleSkips,
  };
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function bootstrapLower95(values, samples, seed) {
  if (!values.length) return null;
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const totals = new Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)];
    totals[sample] = total;
  }
  totals.sort((a, b) => a - b);
  return round(totals[Math.floor(.025 * (totals.length - 1))]);
}

function maxDrawdown(rows) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const row of rows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function summarizeRows(rows, latencyMs) {
  const sum = (field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const activeRows = rows.filter((row) => row.active);
  const grossProfit = rows.filter((row) => row.pnl > 0).reduce((total, row) => total + row.pnl, 0);
  const grossLoss = -rows.filter((row) => row.pnl < 0).reduce((total, row) => total + row.pnl, 0);
  const dailyMap = new Map();
  for (const row of rows) {
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    const current = dailyMap.get(day) || { windows: 0, active: 0, pnl: 0, deployed: 0, fees: 0 };
    current.windows++;
    current.active += row.active ? 1 : 0;
    current.pnl += row.pnl;
    current.deployed += row.deployed;
    current.fees += row.fees;
    dailyMap.set(day, current);
  }
  const foldCount = 5;
  const span = toMs - fromMs;
  const chronologicalFolds = Array.from({ length: foldCount }, (_, index) => {
    const foldFrom = fromMs + Math.floor(span * index / foldCount);
    const foldTo = index === foldCount - 1 ? toMs : fromMs + Math.floor(span * (index + 1) / foldCount);
    const selected = rows.filter((row) => row.startMs >= foldFrom && row.startMs < foldTo);
    return {
      index: index + 1,
      from: new Date(foldFrom).toISOString(),
      to: new Date(foldTo).toISOString(),
      windows: selected.length,
      active: selected.filter((row) => row.active).length,
      pnl: round(selected.reduce((total, row) => total + row.pnl, 0)),
      deployed: round(selected.reduce((total, row) => total + row.deployed, 0)),
      maxDrawdown: round(maxDrawdown(selected)),
    };
  });
  const deployed = sum("deployed");
  return {
    latencyMs,
    windows: rows.length,
    active: activeRows.length,
    trades: sum("trades"),
    hedged: activeRows.filter((row) => row.hedged).length,
    correct: activeRows.filter((row) => row.entrySide === row.winner).length,
    profitable: activeRows.filter((row) => row.pnl > 0).length,
    partialEntries: sum("partialEntries"),
    partialHedges: sum("partialHedges"),
    grossCost: round(sum("grossCost")),
    fees: round(sum("fees")),
    payout: round(sum("payout")),
    deployed: round(deployed),
    pnl: round(sum("pnl")),
    roiPct: deployed > 0 ? round(sum("pnl") / deployed * 100) : 0,
    entryAccuracyPct: activeRows.length ? round(activeRows.filter((row) => row.entrySide === row.winner).length / activeRows.length * 100) : 0,
    profitablePct: activeRows.length ? round(activeRows.filter((row) => row.pnl > 0).length / activeRows.length * 100) : 0,
    maxDrawdown: round(maxDrawdown(rows)),
    profitFactor: grossLoss > 1e-9 ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    bootstrapWindowLower95: bootstrapLower95(rows.map((row) => row.pnl), BOOTSTRAP_SAMPLES, 0x3048d653 ^ latencyMs),
    profitableDayRate: dailyMap.size ? round([...dailyMap.values()].filter((row) => row.pnl > 0).length / dailyMap.size) : 0,
    daily: Object.fromEntries([...dailyMap].map(([day, row]) => [day, {
      windows: row.windows,
      active: row.active,
      pnl: round(row.pnl),
      deployed: round(row.deployed),
      fees: round(row.fees),
    }])),
    chronologicalFolds,
  };
}

const latencies = String(process.env.GAP_V4_TAKER_LATENCIES || "520")
  .split(",").map((value) => value.trim()).filter(Boolean).map(Number)
  .filter((value) => Number.isFinite(value) && value >= 0);
if (!latencies.length) throw new Error("GAP_V4_TAKER_LATENCIES contains no valid latency");
const policyFile = String(process.env.GAP_V4_POLICIES_FILE || "").trim();
const policyDefs = policyFile ? JSON.parse(fs.readFileSync(path.resolve(policyFile), "utf8")) : [{ name: "source-default" }];
if (!Array.isArray(policyDefs) || !policyDefs.length) throw new Error("GAP_V4_POLICIES_FILE must contain a non-empty array");
const policies = policyDefs.map((policy, index) => {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error(`invalid policy at index ${index}`);
  const name = String(policy.name || `policy-${index + 1}`);
  const { name: _ignored, ...overrides } = policy;
  return { name, params: { ...PARAMS, ...overrides }, overrides };
});
const runs = policies.flatMap((policy) => latencies.map((latencyMs) => ({
  ...policy,
  latencyMs,
  key: `${policy.name}__${latencyMs}ms`,
})));
const windowRows = new Map(runs.map((run) => [run.key, []]));
const markets = await listMarkets();
console.log(JSON.stringify({ phase: "listed", requested: markets.length, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), warmup: WARMUP_ROUNDS, policies: policies.length, runs: runs.length }));
const excursions = [];
const queue = markets.slice();
const promises = new Map();
const lookahead = 6;
const kick = (market) => {
  if (!market || promises.has(market.slug)) return;
  promises.set(market.slug, fetchWindow(market).catch((error) => ({ error, market })));
};
for (let i = 0; i < Math.min(lookahead, queue.length); i++) kick(queue[i]);

let usable = 0;
let sparse = 0;
let failed = 0;
for (let index = 0; index < queue.length; index++) {
  for (let ahead = index; ahead < Math.min(queue.length, index + lookahead); ahead++) kick(queue[ahead]);
  const raw = await promises.get(queue[index].slug);
  promises.delete(queue[index].slug);
  if (raw?.error) failed++;
  else {
    const window = normalizeWindow(raw);
    if (window.sparse || !(window.openBinance > 0) || !window.ticks.length) sparse++;
    else {
      if (excursions.length >= WARMUP_ROUNDS) {
        for (const run of runs) {
          const intensity = computeIntensity(excursions, run.params);
          const result = replayWindow(window, intensity, run.latencyMs, run.params);
          windowRows.get(run.key).push({
            slug: window.slug,
            startMs: window.startMs,
            winner: window.winner,
            active: Boolean(result.entry),
            entrySide: result.entry?.side || null,
            entryDecidedMs: result.entry?.decidedMs ?? null,
            entryFillMs: result.entry?.fillMs ?? null,
            entryPrice: result.entry ? round(result.entry.effPx) : null,
            entryShares: result.entry ? round(result.entry.shares) : 0,
            hedged: result.hedged,
            trades: result.fills.length,
            partialEntries: result.fills.filter((fill) => fill.leg === "entry" && fill.partial).length,
            partialHedges: result.fills.filter((fill) => fill.leg === "hedge" && fill.partial).length,
            grossCost: round(result.grossCost),
            fees: round(result.fees),
            payout: round(result.payout),
            deployed: round(result.deployed),
            pnl: round(result.pnl),
            staleSkips: result.staleSkips,
          });
        }
      }
      excursions.push(roundExcursion(window.ticks.map((tick) => tick.bz), window.openBinance));
      if (excursions.length > WARMUP_ROUNDS) excursions.shift();
      usable++;
    }
  }
  if ((index + 1) % 25 === 0 || index + 1 === queue.length) {
    console.log(JSON.stringify({ phase: "fetch-and-replay", done: index + 1, total: queue.length, usable, sparse, failed }));
  }
}

const results = runs.map((run) => ({
  policy: run.name,
  overrides: run.overrides,
  ...summarizeRows(windowRows.get(run.key), run.latencyMs),
}));
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  phase: "result",
  source: "bapi-v4 Binance + full L2; v4 Chainlink-settled winner",
  methodology: "causal Gap Predictor replay; decisions use Binance spot and contemporaneous CLOB only; every marketable entry/hedge consumes the first full-L2 ask at or after decision plus authoritative 520ms taker latency; partial depth is conserved within each fill; crypto taker fees are charged; outcome is used only at settlement",
  range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  baseParams: {
    size: PARAMS.SIZE,
    volRounds: PARAMS.L_VOL_ROUNDS,
    scaling: PARAMS.L_SCALING,
    edgeBuffer: PARAMS.L_EDGE_BUFFER,
    entryFloor: PARAMS.L_ENTRY_FLOOR,
    entryCeil: PARAMS.L_ENTRY_CEIL,
    skipEndS: PARAMS.L_SKIP_END_S,
    hedgeCap: PARAMS.L_HEDGE_CAP,
    hedgeMinProfit: PARAMS.L_HEDGE_MIN_PROFIT,
    feeBps: 700,
  },
  policies: policies.map((policy) => ({ name: policy.name, overrides: policy.overrides })),
  requested: markets.length,
  usable,
  sparse,
  failed,
  analysisWindows: Math.max(0, usable - WARMUP_ROUNDS),
  results,
  windows: Object.fromEntries(runs.map((run) => [run.key, windowRows.get(run.key)])),
};
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
const { windows: _persistedWindowDetails, ...consoleSummary } = output;
console.log(JSON.stringify({
  ...consoleSummary,
  results: results.map((row) => ({
    policy: row.policy,
    latencyMs: row.latencyMs,
    windows: row.windows,
    active: row.active,
    hedged: row.hedged,
    trades: row.trades,
    pnl: row.pnl,
    roiPct: row.roiPct,
    maxDrawdown: row.maxDrawdown,
    profitFactor: row.profitFactor,
    bootstrapWindowLower95: row.bootstrapWindowLower95,
    profitableDayRate: row.profitableDayRate,
    foldPnls: row.chronologicalFolds.map((fold) => fold.pnl),
  })),
  output: OUTPUT,
}, null, 2));
