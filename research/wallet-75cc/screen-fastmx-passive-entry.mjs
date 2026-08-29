#!/usr/bin/env node
// Conservative passive-entry study for FastMX. Direction comes only from the
// existing CLOB-mid and Binance-gap velocities. A maker fill is credited only
// after the recorded ask trades strictly through our resting buy limit; a mere
// touch receives zero fill credit.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { positionFromFills } from "../../engine/simrun.js";
import { getStrategy } from "../../engine/strategies/index.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const dataRoot = path.resolve(process.argv[2] || "data/wallet-75cc");
const resultRoot = path.resolve(process.argv[3] || "research/wallet-75cc/results");
const fitEndMs = Date.parse(process.argv[4] || "2026-08-21T00:00:00Z");
const evaluationEndMs = Date.parse(process.argv[5] || "2026-08-22T00:00:00Z");
const screenKind = process.argv[6] || "screen";
const evaluationStartMs = Date.parse(process.argv[7] || "1970-01-01T00:00:00Z");
const cohortFile = path.join(dataRoot, "cohort-2026-08-16_2026-08-26-btc.json");
const feedDir = path.join(dataRoot, "feeds/v2-l2");
const outputJson = path.join(resultRoot, `fastmx-passive-${screenKind}-2026-08-27.json`);
const EPS = 1e-9;
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const baseSignal = { ...STRAT, H_CLOB_MID_VELOCITY_ON: true,
  H_BINANCE_GAP_MOMENTUM_ON: true, H_HEDGING_ON: false,
  H_MAX_GROSS_SH: 14, H_MAX_ORDER_SH: 7, H_BASE_ORDER_SH: 7,
  H_CROSS_RESIDUAL_SH: 0 };
const cfg = (name, p = {}, maker = {}) => ({ name,
  params: { ...baseSignal, H_MAX_ORDERS: 1, ...p },
  maker: { arrivalMs: 130, cancelLatencyMs: 500, ttlMs: 1500,
    offsetCents: 1, cancelMode: "opposite", ...maker } });
const screenModes = [
  cfg("default_o1_t750", {}, { ttlMs: 750 }),
  cfg("default_o1_t1500"),
  cfg("default_o1_t3000", {}, { ttlMs: 3000 }),
  cfg("default_o2_t1500", { H_MAX_ORDERS: 2 }),
  cfg("default_o1_t1500_cancelInvalid", {}, { cancelMode: "invalid" }),
  cfg("default_o1_t1500_offset2", {}, { offsetCents: 2 }),
  cfg("value50_85_o1_t1500", { H_MIN_ASK: .50, H_MAX_ASK: .85 }),
  cfg("value50_85_o2_t1500", { H_MIN_ASK: .50, H_MAX_ASK: .85, H_MAX_ORDERS: 2 }),
  cfg("bz12_o1_t1500", { H_BINANCE_GAP_VELOCITY_MIN: 12 }),
  cfg("bz20_o1_t1500", { H_BINANCE_GAP_VELOCITY_MIN: 20 }),
  cfg("mid12_bz30_o1_t1500", { H_MID_VELOCITY_MIN: .12, H_BINANCE_GAP_VELOCITY_MIN: 30 }),
  cfg("mid12_bz30_value50_80_o1_t1500", { H_MID_VELOCITY_MIN: .12,
    H_BINANCE_GAP_VELOCITY_MIN: 30, H_MIN_ASK: .50, H_MAX_ASK: .80 }),
];
// Frozen after the pre-holdout screen. The two variants differ only in the
// maker placement delay stress; the 130 ms row is the primary.
const holdoutModes = [
  cfg("frozenMaker130", { H_MIN_ASK: .50, H_MAX_ASK: .85 }, { ttlMs: 1500 }),
  cfg("frozenMaker200", { H_MIN_ASK: .50, H_MAX_ASK: .85 }, { ttlMs: 1500, arrivalMs: 200 }),
];
const modes = screenKind === "holdout" ? holdoutModes : screenModes;

const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const markets = cohort.markets.filter((market) => market.winner && market.slug.startsWith("btc-")
  && startMs(market.slug) >= evaluationStartMs && startMs(market.slug) < evaluationEndMs
  && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((left, right) => startMs(left.slug) - startMs(right.slug));

function levels(rows, ascending) {
  return (Array.isArray(rows) ? rows : []).map((row) => [
    Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    .sort((left, right) => ascending ? left[0] - right[0] : right[0] - left[0]);
}

function nestedBook(raw) {
  const asks = levels(raw?.asks, true), bids = levels(raw?.bids, false);
  return { asks, bids, bestAsk: asks[0]?.[0] ?? null, bestBid: bids[0]?.[0] ?? null };
}

function qualifiedSide(status, params) {
  const clobOn = params.H_CLOB_MID_VELOCITY_ON !== false;
  const binanceOn = params.H_BINANCE_GAP_MOMENTUM_ON !== false;
  if (clobOn && !status?.velocityDir) return null;
  if (binanceOn && !status?.binanceDir) return null;
  if (clobOn && binanceOn && status.velocityDir !== status.binanceDir) return null;
  return clobOn ? status.velocityDir : status.binanceDir;
}

function floorCent(value) {
  return Math.floor((value + EPS) * 100) / 100;
}

function simulateMaker(feed, market, ws, spec) {
  const strat = getStrategy("helpme"), P = spec.params, M = spec.maker;
  const ticks = (feed.ticks || []).map((tick) => {
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    return { t: (tick.ms - ws) / 1000, ms: tick.ms, bz: tick.bz, cl: tick.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid,
      up, down };
  }).filter((tick) => tick.upAsk != null && tick.dnAsk != null);
  const state = { pendingFills: [] }, pending = [], fills = [];
  let arrivals = 0, postOnlyRejects = 0, expiries = 0, signalCancels = 0, tradeThroughFills = 0;
  let previousMs = null;
  const applyFill = (fill) => {
    state.upShares = +state.upShares || 0; state.downShares = +state.downShares || 0;
    state.upCost = +state.upCost || 0; state.downCost = +state.downCost || 0;
    state.cost = +state.cost || 0;
    if (fill.side === "Up") { state.upShares += fill.shares; state.upCost += fill.usdc; }
    else { state.downShares += fill.shares; state.downCost += fill.usdc; }
    state.cost += fill.usdc; fills.push(fill);
  };

  for (const tick of ticks) {
    // Process order lifecycle before observing this tick's new signal. A fill
    // visible on this frame beats a cancellation decided from the same frame.
    for (let index = pending.length - 1; index >= 0; index--) {
      const order = pending[index], book = order.side === "Up" ? tick.up : tick.down;
      if (!order.active && tick.ms + EPS >= order.arrivalMs) {
        arrivals++;
        if (book.bestAsk == null || book.bestAsk <= order.limit + EPS) {
          postOnlyRejects++; pending.splice(index, 1); continue;
        }
        order.active = true;
      }
      if (!order.active) continue;
      const terminalMs = Math.min(order.expiresMs, order.cancelAtMs ?? Infinity);
      if (tick.ms + EPS >= terminalMs) {
        if (order.cancelAtMs != null && order.cancelAtMs <= order.expiresMs) signalCancels++;
        else expiries++;
        pending.splice(index, 1); continue;
      }
      // Strict trade-through: an ask below our live resting bid implies the
      // higher-priced buy was consumed first. Exact touch receives no credit.
      if (book.bestAsk != null && book.bestAsk < order.limit - EPS) {
        const shares = order.rec.minimumShares ?? order.rec.shares;
        const fill = { ...order.rec, decidedT: order.rec.tInto,
          placedT: (order.arrivalMs - ws) / 1000, tInto: tick.t,
          shares, requestedShares: shares, minimumShares: shares,
          effPx: order.limit, usdc: round(order.limit * shares),
          amountMode: "shares", budgetUsd: undefined,
          exec: "maker", kind: "maker", taker: false, status: "full", maker: true };
        applyFill(fill); tradeThroughFills++; pending.splice(index, 1);
      }
    }
    state.pendingFills = pending.map((order) => ({ rec: order.rec }));

    const stale = previousMs != null && tick.ms - previousMs > 6000;
    previousMs = tick.ms;
    if (stale) continue;
    const got = strat.step(state, { t: tick.t, up: tick.up, down: tick.down,
      bzPrice: tick.bz, clPrice: tick.cl, openBinance: feed.openBinance,
      openChainlink: feed.openChainlink }, P, 120, tick.ms);
    for (const rec of got) {
      const book = rec.side === "Up" ? tick.up : tick.down;
      if (book.bestAsk == null) continue;
      const limit = floorCent(book.bestAsk - Math.max(1, M.offsetCents) / 100);
      if (!(limit > 0 && limit < book.bestAsk - EPS)) continue;
      pending.push({ rec, side: rec.side, limit, active: false,
        arrivalMs: tick.ms + M.arrivalMs,
        expiresMs: tick.ms + M.arrivalMs + M.ttlMs, cancelAtMs: null });
    }
    const currentSide = qualifiedSide(state.helpmeStatus, P);
    for (const order of pending) {
      if (order.cancelAtMs != null) continue;
      const invalid = M.cancelMode === "invalid"
        ? currentSide !== order.side
        : currentSide != null && currentSide !== order.side;
      if (invalid) order.cancelAtMs = tick.ms + M.cancelLatencyMs;
    }
  }
  state.pendingFills = [];
  const pos = positionFromFills(fills, market.winner, ticks);
  const winnerShares = market.winner === "Up" ? pos.upShares : pos.downShares;
  const loserShares = market.winner === "Up" ? pos.downShares : pos.upShares;
  return { orders: fills.length, decisions: state.helpme?.orderCount || 0,
    arrivals, postOnlyRejects, expiries, signalCancels, tradeThroughFills,
    cost: pos.totalCost, fees: pos.fee, pnl: pos.realizedPnl,
    winnerMinusLoserShares: winnerShares - loserShares };
}

function summarize(rows) {
  let active = 0, decisions = 0, orders = 0, arrivals = 0, rejects = 0, expiries = 0, cancels = 0;
  let cost = 0, fees = 0, pnl = 0, wins = 0, equity = 0, peak = 0, maxDrawdown = 0;
  const daily = new Map();
  for (const row of rows) {
    if (row.orders > 0) active++;
    decisions += row.decisions; orders += row.orders; arrivals += row.arrivals;
    rejects += row.postOnlyRejects; expiries += row.expiries; cancels += row.signalCancels;
    cost += row.cost; fees += row.fees; pnl += row.pnl; if (row.pnl > 0) wins++;
    equity += row.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    daily.set(row.day, (daily.get(row.day) || 0) + row.pnl);
  }
  const dailyPnls = [...daily.values()];
  return { markets: rows.length, decisions, makerFills: orders, activeMarkets: active,
    decisionFillPct: decisions ? round(orders / decisions * 100, 3) : null,
    arrivals, postOnlyRejects: rejects, expiries, signalCancels: cancels,
    cost: round(cost), fees: round(fees), pnl: round(pnl),
    roiPct: cost + fees ? round(pnl / (cost + fees) * 100, 3) : null,
    winRatePct: active ? round(wins / active * 100, 3) : null,
    maxDrawdown: round(maxDrawdown),
    profitableDays: dailyPnls.filter((value) => value > 0).length,
    losingDays: dailyPnls.filter((value) => value < 0).length,
    worstDayPnl: dailyPnls.length ? round(Math.min(...dailyPnls)) : null,
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])) };
}

const windows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  windows.push({ startMs: ws, day: new Date(ws).toISOString().slice(0, 10),
    results: Object.fromEntries(modes.map((spec) => [spec.name, simulateMaker(feed, market, ws, spec)])) });
  if ((index + 1) % 50 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: `passive-${screenKind}`, done: index + 1, total: markets.length }));
  }
}

const splits = { fit: windows.filter((row) => row.startMs < fitEndMs),
  validation: windows.filter((row) => row.startMs >= fitEndMs), all: windows };
const report = { schema: 1, generatedAt: new Date().toISOString(),
  method: "same dual velocities; post-only arrival; strict ask trade-through fill; touch credit zero; maker fee/rebate zero",
  screenKind, fitEnd: new Date(fitEndMs).toISOString(), evaluationEnd: new Date(evaluationEndMs).toISOString(),
  configs: Object.fromEntries(modes.map((spec) => [spec.name, spec])),
  results: Object.fromEntries(Object.entries(splits).map(([split, rows]) => [split,
    Object.fromEntries(modes.map((spec) => [spec.name,
      summarize(rows.map((row) => ({ ...row.results[spec.name], day: row.day })))]))])),
  caveat: "Trade-through is conservative but historical maker queue position remains unobservable; forward paper validation is required.",
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputJson, results: report.results }, null, 2));
