#!/usr/bin/env node
// Frozen four-session FastMX policy evaluation. Entry, execution-price, forced
// participation, and reversal choices were selected on Aug 22-30 only. This
// script evaluates them chronologically through the Aug 31-Sep 3 holdout.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { walkVisibleAsks } from "../engine/fillsim.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const runtime = JSON.parse(fs.readFileSync(path.join(root, "data/runtime-config.json"), "utf8"));
const deployed = { ...STRAT, ...(runtime.shadowParams || {}) };
const START_MS = Date.parse("2026-08-22T00:00:00Z");
const FIT_END_MS = Date.parse("2026-08-28T00:00:00Z");
const VALIDATION_END_MS = Date.parse("2026-08-31T00:00:00Z");
const END_MS = Date.parse("2026-09-03T13:30:00Z");
const FALLBACK_START_S = 240, FALLBACK_END_S = 299;
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function sessionOf(startMs) {
  const hour = new Date(startMs).getUTCHours();
  if (hour < 7) return "Asia 00-07";
  if (hour < 13) return "Europe 07-13";
  if (hour < 21) return "US 13-21";
  return "late-US 21-24";
}
function splitOf(startMs) {
  if (startMs < FIT_END_MS) return "fit";
  if (startMs < VALIDATION_END_MS) return "validation";
  return "holdout";
}

const common = { ...deployed, H_STOP_S: 239,
  H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false };
const policies = {
  "Asia 00-07": { fallbackRule: "clob", params: { ...common,
    H_START_S: 60, H_COOLDOWN_MS: 10_000,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 12_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false, H_BINANCE_TREND_LOOKBACK_SEC: 60,
    H_BINANCE_TREND_MIN_PCT: 0.1, H_MIN_ASK: 0.01 } },
  "Europe 07-13": { fallbackRule: "clob", params: { ...common,
    H_START_S: 60, H_COOLDOWN_MS: 5_000,
    H_MID_VELOCITY_LOOKBACK_MS: 5_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false, H_MIN_ASK: 0.01,
    H_REVERSAL_ON: true, H_REVERSAL_RESIDUAL_SH: 15,
    H_REVERSAL_MAX_IMBALANCE_SH: 40 } },
  "US 13-21": { fallbackRule: "cheap", params: { ...common,
    H_START_S: 60, H_COOLDOWN_MS: 15_000,
    H_MID_VELOCITY_LOOKBACK_MS: 8_000, H_MID_VELOCITY_MIN: 0.03,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: true } },
  "late-US 21-24": { fallbackRule: "cheap", params: { ...common,
    H_START_S: 60, H_COOLDOWN_MS: 15_000,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false, H_BINANCE_TREND_LOOKBACK_SEC: 15,
    H_BINANCE_TREND_MIN_PCT: 0.05, H_CAP_HEADROOM: 0.02,
    H_REVERSAL_ON: true, H_REVERSAL_RESIDUAL_SH: 15,
    H_REVERSAL_MAX_IMBALANCE_SH: 15 } },
};

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  const startMs = match ? Number(match[1]) * 1000 : null;
  return startMs != null ? { name, startMs } : null;
}).filter((row) => row && row.startMs >= START_MS && row.startMs < END_MS)
  .sort((left, right) => left.startMs - right.startMs);

function levels(book) {
  return (book?.asks || []).map((row) => [
    Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((left, right) => left[0] - right[0]);
}
function bookAt(tick, side) {
  const nested = side === "Up" ? tick?.up : tick?.down;
  const asks = levels(nested);
  return { asks, bestAsk: Number(nested?.bestAsk) || asks[0]?.[0] || null };
}
function midpoint(tick) {
  const bid = Number(tick?.up?.bestBid ?? tick?.upBid);
  const ask = Number(tick?.up?.bestAsk ?? tick?.upAsk);
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
}
function preferredSide(rule, tick, replay) {
  const mid = midpoint(tick);
  const clob = mid == null ? null : (mid >= 0.5 ? "Up" : "Down");
  const spot = Number(tick?.bz), open = Number(replay?.openBinance);
  const binance = Number.isFinite(spot) && Number.isFinite(open)
    ? (spot >= open ? "Up" : "Down") : null;
  const upAsk = bookAt(tick, "Up").bestAsk, downAsk = bookAt(tick, "Down").bestAsk;
  const cheap = upAsk == null ? "Down" : downAsk == null ? "Up"
    : (upAsk <= downAsk ? "Up" : "Down");
  return rule === "cheap" ? cheap : (clob || binance || cheap);
}
function mandatoryFill(replay, rule) {
  const ticks = replay.ticks || [];
  let lastAttemptMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index];
    if (tick.t < FALLBACK_START_S || tick.t > FALLBACK_END_S
      || tick.ms - lastAttemptMs < 1_000) continue;
    lastAttemptMs = tick.ms;
    let side = preferredSide(rule, tick, replay);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) side = side === "Up" ? "Down" : "Up";
      const ask = bookAt(tick, side).bestAsk;
      if (!(ask > 0) || ask > 0.99) continue;
      const cap = Math.min(0.99, Math.ceil((ask + 0.01 - 1e-9) * 100) / 100);
      const requestedShares = Math.max(4, Math.ceil((1 / ask) * 10_000) / 10_000);
      const dueMs = tick.ms + 520;
      let arrivalIndex = index;
      while (arrivalIndex + 1 < ticks.length && ticks[arrivalIndex + 1].ms <= dueMs) arrivalIndex++;
      const match = walkVisibleAsks(bookAt(ticks[arrivalIndex], side), requestedShares, cap,
        { allowBbaFallback: false });
      if (!(match.shares > 0)) continue;
      return { tInto: tick.t + 0.52, decidedT: tick.t, placedT: tick.t,
        side, shares: round(match.shares), minimumShares: round(requestedShares),
        effPx: round(match.avgPx), usdc: round(match.cost), exec: "marketable",
        kind: "taker", leg: "fallback", role: "fallback", reason: `mandatory-240-${rule}`,
        status: match.shares + 1e-9 < requestedShares ? "partial" : "full",
        postOnly: false, orderType: "FAK", limitPx: cap };
    }
  }
  return null;
}

function result(fills, winner, replay, fallback = null) {
  const pos = positionFromFills(fills, winner, replay.ticks);
  const firstSide = fills[0]?.side || null;
  return { fills, fallback, pos, firstSide, firstCorrect: firstSide === winner,
    reversals: fills.filter((fill) => fill.leg === "reversal").length,
    oppositeFills: firstSide == null ? 0 : fills.filter((fill) => fill.side !== firstSide).length,
    oppositeCorrect: firstSide == null ? 0
      : fills.filter((fill) => fill.side !== firstSide && fill.side === winner).length };
}

const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const session = sessionOf(file.startMs), policy = policies[session];
  const currentFills = simulateFills({ ...replay, windowStart: file.startMs / 1000 }, deployed);
  const riskNormal = simulateFills({ ...replay, windowStart: file.startMs / 1000 }, policy.params);
  const entryNormal = simulateFills({ ...replay, windowStart: file.startMs / 1000 },
    { ...policy.params, H_REVERSAL_ON: false, H_HEDGE_ON: false });
  const fallback = riskNormal.length ? null : mandatoryFill(replay, policy.fallbackRule);
  const entryFallback = entryNormal.length ? null : mandatoryFill(replay, policy.fallbackRule);
  rows.push({ slug: file.name.split("_v2")[0], startMs: file.startMs,
    day: new Date(file.startMs).toISOString().slice(0, 10), session,
    split: splitOf(file.startMs), winner,
    results: {
      current: result(currentFills, winner, replay),
      entryNoFallback: result(entryNormal, winner, replay),
      entry: result(entryFallback ? [...entryNormal, entryFallback] : entryNormal,
        winner, replay, entryFallback),
      policyNoFallback: result(riskNormal, winner, replay),
      policy: result(fallback ? [...riskNormal, fallback] : riskNormal, winner, replay, fallback),
    } });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) {
    console.error(`progress ${index + 1}/${files.length}`);
  }
}

function summary(inputRows, mode) {
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0, equity = 0, peak = 0, maxDrawdown = 0;
  const active = [];
  for (const row of inputRows) {
    const value = row.results[mode], p = value.pos.realizedPnl || 0;
    pnl += p; cost += (value.pos.totalCost || 0) + (value.pos.fee || 0);
    if (value.fills.length) active.push({ row, value });
    if (p > 0) grossProfit += p; else if (p < 0) grossLoss += -p;
    equity += p; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const fallbacks = active.filter(({ value }) => value.fallback);
  const oppositeFills = active.reduce((sum, { value }) => sum + value.oppositeFills, 0);
  return { markets: inputRows.length, traded: active.length,
    participationPct: inputRows.length ? round(active.length / inputRows.length * 100, 3) : null,
    fills: active.reduce((sum, { value }) => sum + value.fills.length, 0),
    fallbackFills: fallbacks.length,
    fallbackAccuracyPct: fallbacks.length ? round(fallbacks.filter(({ row, value }) =>
      value.fallback.side === row.winner).length / fallbacks.length * 100, 3) : null,
    fallbackPartials: fallbacks.filter(({ value }) => value.fallback.status === "partial").length,
    reversals: active.reduce((sum, { value }) => sum + value.reversals, 0),
    oppositeFills, oppositeAccuracyPct: oppositeFills ? round(active.reduce((sum, { value }) =>
      sum + value.oppositeCorrect, 0) / oppositeFills * 100, 3) : null,
    wins: active.filter(({ value }) => value.pos.realizedPnl > 0).length,
    losses: active.filter(({ value }) => value.pos.realizedPnl < 0).length,
    firstDirectionAccuracyPct: active.length ? round(active.filter(({ value }) =>
      value.firstCorrect).length / active.length * 100, 3) : null,
    pnl: round(pnl, 2), roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2) };
}

function paired(inputRows, baseMode, mode) {
  let baseProfit = 0, newProfit = 0, baseLoss = 0, newLoss = 0;
  let improvedLossRounds = 0, worsenedLossRounds = 0, rescuedToProfit = 0;
  for (const row of inputRows) {
    const base = row.results[baseMode].pos.realizedPnl || 0;
    const value = row.results[mode].pos.realizedPnl || 0;
    if (base > 0) { baseProfit += base; newProfit += value; }
    if (base < 0) {
      baseLoss += base; newLoss += value;
      if (value > base + 1e-9) improvedLossRounds++;
      else if (value < base - 1e-9) worsenedLossRounds++;
      if (value > 0) rescuedToProfit++;
    }
  }
  return { pnlDelta: round(inputRows.reduce((sum, row) => sum
      + (row.results[mode].pos.realizedPnl || 0)
      - (row.results[baseMode].pos.realizedPnl || 0), 0), 2),
    profitRetentionPct: baseProfit ? round(newProfit / baseProfit * 100, 3) : null,
    lossReduction: round(newLoss - baseLoss, 2),
    improvedLossRounds, worsenedLossRounds, rescuedToProfit };
}

const modes = ["current", "entryNoFallback", "entry", "policyNoFallback", "policy"];
const summarizeModes = (inputRows) => Object.fromEntries(modes.map((mode) =>
  [mode, summary(inputRows, mode)]));
const compactParams = Object.fromEntries(Object.entries(policies).map(([session, policy]) =>
  [session, { fallbackRule: policy.fallbackRule,
    params: Object.fromEntries(Object.entries(policy.params).filter(([key]) => key.startsWith("H_"))) }]));

console.log(JSON.stringify({ method: "frozen session policy; exact FastMX replay and arrival-time L2 fallback",
  range: { start: new Date(START_MS).toISOString(), fitEnd: new Date(FIT_END_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(), end: new Date(END_MS).toISOString() },
  policies: compactParams,
  all: summarizeModes(rows),
  splits: Object.fromEntries(["fit", "validation", "holdout"].map((split) =>
    [split, summarizeModes(rows.filter((row) => row.split === split))])),
  sessions: Object.fromEntries(Object.keys(policies).map((session) =>
    [session, summarizeModes(rows.filter((row) => row.session === session))])),
  paired: {
    reversalVsEntry: paired(rows, "entry", "policy"),
    fallbackVsNoFallback: paired(rows, "policyNoFallback", "policy"),
    policyVsCurrent: paired(rows, "current", "policy"),
  },
  daily: Object.fromEntries([...new Set(rows.map((row) => row.day))].map((day) =>
    [day, summary(rows.filter((row) => row.day === day), "policy")])),
}, null, 2));
