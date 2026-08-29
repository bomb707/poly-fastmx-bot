#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  STRAT,
  step,
  injectRealFill,
  clearLivePending,
} from '../../engine/strategies/wallet3048.js';
import { fillFee } from '../../engine/fees.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FROM_MS = Date.parse(process.argv[2] || '2026-08-16T00:00:00Z');
const TO_MS = Date.parse(process.argv[3] || '2026-08-25T23:59:59Z');
const OUTPUT = path.resolve(process.argv[4] || path.join(ROOT, 'data/research/wallet3048-participation-floor.json'));
const TAKER_LATENCY_MS = 520;
const REST_TIMEOUT_MS = 3_000;

if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) {
  throw new Error('invalid from/to range');
}

const L2_DIRS = [
  'data/wallet-3048/feeds/v4-post-twap-full-l2',
  'data/wallet-3048/feeds/v4-current-policy-l2',
  'data/wallet-3048/feeds/v4-e8-l2',
  'data/wallet-3048/feeds/v4-r2-l2',
  'data/wallet-3048-r3/feeds/v4-l2',
  'data/wallet-3048-r4/feeds/v4-l2',
].map((value) => path.join(ROOT, value));

const V2_DIRS = [
  'data/wallet-3048/feeds/v2',
  'data/wallet-3048-r3/feeds/v2',
  'data/wallet-3048-r4/feeds/v2',
].map((value) => path.join(ROOT, value));

const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const startOf = (slug) => Number(String(slug).split('-').at(-1)) * 1000;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function discover() {
  const l2 = new Map();
  const v2 = new Map();
  for (const directory of L2_DIRS) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json.gz')) continue;
      const slug = name.slice(0, -8);
      const startMs = startOf(slug);
      if (startMs >= FROM_MS && startMs < TO_MS && !l2.has(slug)) l2.set(slug, path.join(directory, name));
    }
  }
  for (const directory of V2_DIRS) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json.gz')) continue;
      const slug = name.slice(0, -8);
      if (l2.has(slug) && !v2.has(slug)) v2.set(slug, path.join(directory, name));
    }
  }
  return [...l2].map(([slug, l2File]) => ({ slug, l2File, v2File: v2.get(slug) }))
    .filter((row) => row.v2File)
    .sort((a, b) => startOf(a.slug) - startOf(b.slug));
}

function normalizeRows(rows, direction) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    price: Number(Array.isArray(row) ? row[0] : row?.price),
    size: Number(Array.isArray(row) ? row[1] : row?.size),
  })).filter((row) => row.price >= .01 && row.price <= .99 && row.size > 0)
    .sort((a, b) => direction * (a.price - b.price));
}

function normalizeBook(rawBook) {
  if (!rawBook) return null;
  const asks = normalizeRows(rawBook.asks, 1);
  const bids = normalizeRows(rawBook.bids, -1);
  if (!asks.length || !bids.length) return null;
  return {
    asks,
    bids,
    bestAsk: asks[0].price,
    bestBid: bids[0].price,
  };
}

function load(meta) {
  const raw = readGzip(meta.l2File);
  const v2 = readGzip(meta.v2File);
  const winner = /^up$/i.test(raw.winner) ? 'Up' : /^down$/i.test(raw.winner) ? 'Down' : null;
  const openBinance = Number(v2.openBinance || raw.openBinance);
  const openChainlink = Number(v2.openChainlink || raw.openChainlink);
  if (!winner || !(openBinance > 0) || !(openChainlink > 0)) return null;
  const spotTicks = (v2.ticks || []).map((tick) => ({
    ms: Number(tick.ms),
    bz: Number(tick.bz),
    cl: Number(tick.cl),
  })).filter((tick) => finite(tick.ms)).sort((a, b) => a.ms - b.ms);
  let cursor = -1;
  let bz = null;
  let cl = null;
  const ticks = [];
  for (const rawTick of raw.ticks || []) {
    const ms = Number(rawTick.ms ?? Date.parse(rawTick.time || ''));
    if (!finite(ms)) continue;
    while (cursor + 1 < spotTicks.length && spotTicks[cursor + 1].ms <= ms) {
      const spot = spotTicks[++cursor];
      if (spot.bz > 0) bz = spot.bz;
      if (spot.cl > 0) cl = spot.cl;
    }
    if (Number(rawTick.bz) > 0) bz = Number(rawTick.bz);
    if (Number(rawTick.cl) > 0) cl = Number(rawTick.cl);
    const up = normalizeBook(rawTick.up);
    const down = normalizeBook(rawTick.down);
    if (!up || !down || !(bz > 0) || !(cl > 0)) continue;
    up.depthTs = ms;
    down.depthTs = ms;
    ticks.push({ ms, bz, cl, up, down });
  }
  return ticks.length > 20 ? {
    slug: meta.slug,
    startMs: startOf(meta.slug),
    winner,
    openBinance,
    openChainlink,
    ticks,
  } : null;
}

function executeAtLimit(book, requested, limit) {
  let left = requested;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  for (const level of book.asks) {
    if (level.price > limit + 1e-9 || left <= 1e-9) break;
    const take = Math.min(left, level.size);
    left -= take;
    shares += take;
    cost += take * level.price;
    fees += fillFee(level.price, take, true);
  }
  return shares > 1e-9 ? { shares, cost, fees, averagePrice: cost / shares, partial: left > 1e-9 } : null;
}

function simulate(feed, policy) {
  const params = {
    ...STRAT,
    ...policy,
    LIVE_FILLS: true,
    LATENCY_MS: TAKER_LATENCY_MS,
  };
  const state = {};
  const pending = [];
  const fills = [];
  let attempts = 0;
  let participationAttempts = 0;
  let rejectedAtArrival = 0;
  let firstDecisionMs = null;

  for (const tick of feed.ticks) {
    for (let index = pending.length - 1; index >= 0; index--) {
      const order = pending[index];
      if (tick.ms < order.arrivalMs) continue;
      if (!order.arrivalChecked) {
        order.arrivalChecked = true;
        const book = order.rec.side === 'Up' ? tick.up : tick.down;
        const fill = executeAtLimit(book, order.rec.shares, order.rec.limitPx);
        if (fill) {
          injectRealFill(state, {
            oid: order.rec.oid,
            side: order.rec.side,
            shares: fill.shares,
            px: fill.averagePrice,
          });
          fills.push({
            side: order.rec.side,
            shares: fill.shares,
            cost: fill.cost,
            fees: fill.fees,
            price: fill.averagePrice,
            reason: order.rec.reason,
            decisionMs: order.decisionMs,
            fillMs: tick.ms,
            limit: order.rec.limitPx,
            partial: fill.partial,
          });
          if (fill.partial) clearLivePending(state, order.rec.oid);
          pending.splice(index, 1);
          continue;
        }
        rejectedAtArrival++;
      }
      if (tick.ms >= order.cancelMs) {
        clearLivePending(state, order.rec.oid);
        pending.splice(index, 1);
      }
    }

    const t = (tick.ms - feed.startMs) / 1000;
    const beforeSeq = state.seq || 0;
    const decisions = step(state, {
      t,
      up: tick.up,
      down: tick.down,
      bzGapPct: (tick.bz - feed.openBinance) / feed.openBinance * 100,
      clGapPct: (tick.cl - feed.openChainlink) / feed.openChainlink * 100,
    }, params, 120, tick.ms);
    if ((state.seq || 0) < beforeSeq) throw new Error(`${feed.slug}: sequence regressed`);
    for (const rec of decisions) {
      attempts++;
      if (firstDecisionMs == null) firstDecisionMs = tick.ms;
      if (rec.participationFloor) participationAttempts++;
      pending.push({
        rec,
        decisionMs: tick.ms,
        arrivalMs: tick.ms + TAKER_LATENCY_MS,
        cancelMs: tick.ms + TAKER_LATENCY_MS + REST_TIMEOUT_MS,
        arrivalChecked: false,
      });
    }
  }
  for (const order of pending) clearLivePending(state, order.rec.oid);

  const up = fills.filter((fill) => fill.side === 'Up').reduce((sum, fill) => sum + fill.shares, 0);
  const down = fills.filter((fill) => fill.side === 'Down').reduce((sum, fill) => sum + fill.shares, 0);
  const grossBuySpend = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const fees = fills.reduce((sum, fill) => sum + fill.fees, 0);
  const payout = feed.winner === 'Up' ? up : down;
  return {
    slug: feed.slug,
    startUtc: new Date(feed.startMs).toISOString(),
    day: new Date(feed.startMs).toISOString().slice(0, 10),
    winner: feed.winner,
    attempts,
    participationAttempts,
    fills: fills.length,
    active: fills.length > 0,
    rejectedAtArrival,
    up: round(up),
    down: round(down),
    grossBuySpend: round(grossBuySpend),
    fees: round(fees),
    payout: round(payout),
    pnl: round(payout - grossBuySpend - fees),
    firstDecisionS: firstDecisionMs == null ? null : round((firstDecisionMs - feed.startMs) / 1000, 3),
    fillDetail: fills,
  };
}

function aggregate(windows) {
  const sum = (field) => windows.reduce((total, row) => total + Number(row[field] || 0), 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of windows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const grossBuySpend = sum('grossBuySpend');
  const pnl = sum('pnl');
  return {
    windows: windows.length,
    attemptedWindows: windows.filter((row) => row.attempts > 0).length,
    activeWindows: windows.filter((row) => row.active).length,
    attemptCoveragePct: windows.length ? round(100 * windows.filter((row) => row.attempts > 0).length / windows.length, 3) : null,
    activeCoveragePct: windows.length ? round(100 * windows.filter((row) => row.active).length / windows.length, 3) : null,
    attempts: sum('attempts'),
    participationAttempts: sum('participationAttempts'),
    fills: sum('fills'),
    rejectedAtArrival: sum('rejectedAtArrival'),
    grossBuySpend: round(grossBuySpend),
    fees: round(sum('fees')),
    payout: round(sum('payout')),
    pnl: round(pnl),
    roiPct: grossBuySpend ? round(100 * pnl / grossBuySpend, 3) : null,
    maxDrawdown: round(maxDrawdown),
  };
}

function daily(windows) {
  const days = new Map();
  for (const window of windows) {
    if (!days.has(window.day)) days.set(window.day, []);
    days.get(window.day).push(window);
  }
  return Object.fromEntries([...days].map(([day, rows]) => [day, aggregate(rows)]));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
const discovered = discover();
console.log(`discovered ${discovered.length} source-aligned V4-L2 + V2-RTDS windows`);
let failed = 0;
const policies = {
  baseline_release_only: { W3048_PARTICIPATE_EVERY_MARKET: false },
  participation_floor: { W3048_PARTICIPATE_EVERY_MARKET: true },
  participation_floor_only: {
    W3048_PARTICIPATE_EVERY_MARKET: true,
    W3048_DEPTH1_MAX: -1,
    W3048_DEPTH3_MAX: -1,
    W3048_MAX_ACTIONS: 3,
    W3048_MAX_LEAN_MULT: 1,
  },
};
const windowsByPolicy = Object.fromEntries(Object.keys(policies).map((name) => [name, []]));
let loaded = 0;
let firstLoadedMs = null;
let lastLoadedMs = null;
for (let index = 0; index < discovered.length; index++) {
  const feed = load(discovered[index]);
  if (!feed) {
    failed++;
  } else {
    loaded++;
    if (firstLoadedMs == null) firstLoadedMs = feed.startMs;
    lastLoadedMs = feed.startMs;
    for (const [name, policy] of Object.entries(policies)) {
      windowsByPolicy[name].push(simulate(feed, policy));
    }
  }
  if ((index + 1) % 100 === 0) console.log(`replayed ${index + 1}/${discovered.length}`);
}

const results = {};
for (const [name, policy] of Object.entries(policies)) {
  const windows = windowsByPolicy[name];
  results[name] = { policy: { ...STRAT, ...policy, LIVE_FILLS: true, LATENCY_MS: TAKER_LATENCY_MS }, summary: aggregate(windows), daily: daily(windows), windows };
  console.log(name, results[name].summary);
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
const payload = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: {
    requestedFrom: new Date(FROM_MS).toISOString(),
    requestedTo: new Date(TO_MS).toISOString(),
    firstLoaded: firstLoadedMs == null ? null : new Date(firstLoadedMs).toISOString(),
    lastLoaded: lastLoadedMs == null ? null : new Date(lastLoadedMs).toISOString(),
    discovered: discovered.length,
    loaded,
    failed,
  },
  methodology: 'Exact wallet3048 decision engine on causal V4 L2 plus V2 Binance/Chainlink RTDS; marketable GTC walks the first L2 snapshot at/after 520ms arrival up to the submitted limit; a non-marketable arrival receives no fill credit and is canceled after 3s; settlement winner is used only for PnL.',
  results,
};
fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${OUTPUT}`);
}

export { discover, load, executeAtLimit };
