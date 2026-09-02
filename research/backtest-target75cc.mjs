#!/usr/bin/env node
// Compare the evidence-backed target75cc inventory policy with the fixed-size
// Helpme baseline on the same cached, causal V2 L2 windows.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { positionFromFills, simulateFills } from "../engine/simrun.js";
import { STRAT as HELPME } from "../engine/strategies/helpme.js";
import { STRAT as TARGET } from "../engine/strategies/target75cc.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.resolve(process.argv[4] || path.join(root, "data/wincache"));
const start = Date.parse(process.argv[2] || "2026-08-20T00:00:00Z") / 1000;
const end = Date.parse(process.argv[3] || "2026-08-27T00:00:00Z") / 1000;
if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
  throw new Error("usage: node research/backtest-target75cc.mjs [start-ISO] [end-ISO] [cache-dir]");
}

const cooldownMs = Math.max(0, Number(process.env.TARGET_COOLDOWN_MS || 4000));
const common = {
  LATENCY_MS: 520,
  H_START_S: 0,
  H_STOP_S: 285,
  H_CLOB_MID_VELOCITY_ON: true,
  H_MID_VELOCITY_LOOKBACK_MS: 2000,
  H_MID_VELOCITY_MIN: 0.02,
  H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 3000,
  H_BINANCE_GAP_VELOCITY_MIN: 5,
  H_BINANCE_TREND_ON: true,
  H_BINANCE_TREND_LOOKBACK_SEC: 30,
  H_BINANCE_TREND_MIN_PCT: 0.05,
  H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60,
  H_BINANCE_COUNTERTREND_MIN_PCT: 0.075,
  H_BINANCE_GAP_AGREE_ON: false,
  H_COOLDOWN_MS: cooldownMs,
};
const policies = {
  helpme: { ...HELPME, ...common, STRATEGY: "helpme",
    H_HEDGE_ON: false, H_REVERSAL_ON: false, H_BASE_ORDER_SH: 7,
    H_MIN_ORDER_SH: 4, H_MIN_DEPTH_SH: 4 },
  target75cc: { ...TARGET, STRATEGY: "target75cc", T_COOLDOWN_MS: cooldownMs },
};

const exactFireFile = process.env.TARGET_EXACT_FIRE_FILE
  ? path.resolve(process.env.TARGET_EXACT_FIRE_FILE)
  : null;
const exact = exactFireFile && fs.existsSync(exactFireFile)
  ? JSON.parse(zlib.gunzipSync(fs.readFileSync(exactFireFile))) : null;
const observedActions = new Map();
for (const action of exact?.actions || []) {
  const rows = observedActions.get(action.slug) || [];
  rows.push(action); observedActions.set(action.slug, rows);
}

const files = fs.readdirSync(cacheDir).map((file) => {
  const match = file.match(/^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/);
  return match ? { file, windowStart: Number(match[1]) } : null;
}).filter((row) => row && row.windowStart >= start && row.windowStart < end)
  .sort((a, b) => a.windowStart - b.windowStart);

const actorNames = [...(exact ? ["observedTarget"] : []), ...Object.keys(policies)];
const stats = Object.fromEntries(actorNames.map((name) => [name, {
  markets: 0, tradedMarkets: 0, positiveMarkets: 0, pnl: 0, equity: 0,
  peak: 0, maxDrawdown: 0, worstMarket: Infinity, fills: 0,
  bothSideMarkets: 0, roles: {}, sizes: [],
}]));
let invalid = 0;
const perMarket = [];

function addResult(row, fills, position, pnl) {
  row.markets++;
  row.tradedMarkets += Number(fills.length > 0);
  row.positiveMarkets += Number(pnl > 0);
  row.pnl += pnl;
  row.equity += pnl;
  row.peak = Math.max(row.peak, row.equity);
  row.maxDrawdown = Math.max(row.maxDrawdown, row.peak - row.equity);
  row.worstMarket = Math.min(row.worstMarket, pnl);
  row.fills += fills.length;
  row.bothSideMarkets += Number(fills.some((fill) => fill.side === "Up")
    && fills.some((fill) => fill.side === "Down"));
  for (const fill of fills) {
    const role = fill.role || fill.leg || "entry";
    row.roles[role] = (row.roles[role] || 0) + 1;
    row.sizes.push(Number(fill.minimumShares ?? fill.requestedShares ?? fill.shares));
  }
  return { pnl, fills: fills.length, upShares: position.upShares, downShares: position.downShares,
    cost: position.totalCost, fees: position.fee };
}

for (const { file, windowStart } of files) {
  let data;
  try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file)))); }
  catch { invalid++; continue; }
  if (!data.winSide || !Array.isArray(data.ticks) || data.ticks.length < 2) { invalid++; continue; }
  data.windowStart = windowStart;
  data.slug = `btc-updown-5m-${windowStart}`;
  const marketResult = { slug: data.slug, windowStart, winner: data.winSide, actors: {} };
  if (exact) {
    const fills = (observedActions.get(data.slug) || []).map((action) => ({
      side: action.outcome,
      kind: "taker",
      exec: "marketable",
      role: action.transition,
      leg: action.transition,
      shares: Number(action.filledShares),
      minimumShares: Number(action.signedShares),
      usdc: Number(action.filledUsd),
      effPx: Number(action.filledUsd) / Number(action.filledShares),
    }));
    const position = positionFromFills(fills, data.winSide, data.ticks);
    marketResult.actors.observedTarget = addResult(stats.observedTarget, fills, position,
      Number(position.realizedPnl || 0));
  }
  for (const [name, params] of Object.entries(policies)) {
    const fills = simulateFills(data, params);
    const position = positionFromFills(fills, data.winSide, data.ticks);
    const pnl = Number(position.realizedPnl || 0), row = stats[name];
    marketResult.actors[name] = addResult(row, fills, position, pnl);
  }
  perMarket.push(marketResult);
}

function quantile(values, p) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  return rows.length ? rows[Math.floor((rows.length - 1) * p)] : null;
}
function round(value, digits = 2) { return +Number(value).toFixed(digits); }
  for (const row of Object.values(stats)) {
  const opposite = Number(row.roles.hedge || 0) + Number(row.roles.repair || 0)
    + Number(row.roles.reversal || 0);
  row.pnl = round(row.pnl);
  row.maxDrawdown = round(row.maxDrawdown);
  row.worstMarket = round(row.worstMarket);
  row.winRatePct = round(100 * row.positiveMarkets / Math.max(1, row.markets));
  row.actionsPerTradedMarket = round(row.fills / Math.max(1, row.tradedMarkets));
  row.bothSideMarketPct = round(100 * row.bothSideMarkets / Math.max(1, row.tradedMarkets));
  row.oppositeActionPct = round(100 * opposite / Math.max(1, row.fills));
  row.size = { p10: quantile(row.sizes, 0.1), p50: quantile(row.sizes, 0.5),
    p90: quantile(row.sizes, 0.9), max: quantile(row.sizes, 1) };
  delete row.sizes;
  delete row.equity;
  delete row.peak;
}

function sessionOf(windowStart) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    hour: "numeric", hourCycle: "h23" }).format(new Date(windowStart * 1_000)));
  return hour < 6 ? "Early Morning" : hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
}
function grouped(rows, keyOf) {
  const groups = new Map();
  for (const market of rows) {
    const key = keyOf(market), actors = groups.get(key) || Object.fromEntries(actorNames.map((name) => [name, {
      markets: 0, tradedMarkets: 0, fills: 0, pnl: 0, cost: 0, fees: 0, positiveMarkets: 0,
    }]));
    for (const name of actorNames) {
      const value = market.actors[name]; if (!value) continue;
      const actor = actors[name]; actor.markets++; actor.tradedMarkets += Number(value.fills > 0);
      actor.fills += value.fills; actor.pnl += value.pnl; actor.cost += value.cost; actor.fees += value.fees;
      actor.positiveMarkets += Number(value.pnl > 0);
    }
    groups.set(key, actors);
  }
  return Object.fromEntries([...groups].map(([key, actors]) => [key, Object.fromEntries(Object.entries(actors)
    .map(([name, row]) => [name, { ...Object.fromEntries(Object.entries(row).map(([field, value]) =>
      [field, round(value, 4)])), winRatePct: round(100 * row.positiveMarkets / Math.max(1, row.markets), 3),
      averagePnlPerMarket: round(row.pnl / Math.max(1, row.markets), 4) }]))]));
}
function correlation(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const lm = left.reduce((a, b) => a + b, 0) / left.length;
  const rm = right.reduce((a, b) => a + b, 0) / right.length;
  let covariance = 0, lv = 0, rv = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] - lm, b = right[index] - rm;
    covariance += a * b; lv += a * a; rv += b * b;
  }
  return lv > 0 && rv > 0 ? covariance / Math.sqrt(lv * rv) : null;
}
const comparable = exact ? perMarket.filter((row) => row.actors.observedTarget && row.actors.target75cc) : [];
const comparison = exact ? {
  markets: comparable.length,
  pnlCorrelation: round(correlation(comparable.map((row) => row.actors.observedTarget.pnl),
    comparable.map((row) => row.actors.target75cc.pnl)), 6),
  botMinusTargetPnl: round(comparable.reduce((sum, row) => sum
    + row.actors.target75cc.pnl - row.actors.observedTarget.pnl, 0), 4),
  meanAbsoluteMarketPnlDifference: round(comparable.reduce((sum, row) => sum
    + Math.abs(row.actors.target75cc.pnl - row.actors.observedTarget.pnl), 0) / Math.max(1, comparable.length), 4),
} : null;

console.log(JSON.stringify({
  schema: 1,
  range: { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() },
  cache: { expectedWindows: Math.round((end - start) / 300), files: files.length,
    valid: files.length - invalid, invalid, coveragePct: round(100 * (files.length - invalid) / Math.max(1, (end - start) / 300)) },
  methodology: "Same causal V2 L2 windows, 520ms latency, visible-depth fixed-USD FAK fills and fees. target75cc uses its autonomous two-sided cap menu; Helpme is the legacy fixed-size momentum baseline.",
  cooldownMs,
  stats,
  comparison,
  daily: grouped(perMarket, (row) => new Date(row.windowStart * 1_000).toISOString().slice(0, 10)),
  sessionsEt: grouped(perMarket, (row) => sessionOf(row.windowStart)),
  perMarket,
  caveat: "Historical cache coverage is reported above. The target75cc release model is an observable imitation with weak exact event parity, not private-wallet source-code recovery or a profitability claim.",
}, null, 2));
