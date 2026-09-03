#!/usr/bin/env node
// Evaluate a session-gated strict reversal policy plus a causal mandatory
// minimum-risk fallback after the normal strategy cutoff. Research only.

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
const startMs = Date.parse("2026-08-22T00:00:00Z");
const fitEndMs = Date.parse("2026-08-28T00:00:00Z");
const validationEndMs = Date.parse("2026-08-31T00:00:00Z");
const endMs = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const entryParams = { ...deployed,
  H_START_S: 30, H_COOLDOWN_MS: 7_500,
  H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
  H_BINANCE_GAP_AGREE_ON: false,
  H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
};
const reversalParams = { ...entryParams, H_REVERSAL_ON: true,
  H_REVERSAL_RESIDUAL_SH: 10, H_REVERSAL_MAX_IMBALANCE_SH: 25 };

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  return match ? { name, ws: Number(match[1]), ms: Number(match[1]) * 1000 } : null;
}).filter((row) => row && row.ms >= startMs && row.ms < endMs)
  .sort((a, b) => a.ms - b.ms);

function sessionOf(ws) {
  const hour = new Date(ws * 1000).getUTCHours();
  return hour < 7 ? "Asia 00-07" : hour < 13 ? "Europe 07-13"
    : hour < 21 ? "US 13-21" : "late-US 21-24";
}
function splitOf(ms) {
  return ms < fitEndMs ? "fit" : ms < validationEndMs ? "validation" : "holdout";
}
function levels(book) {
  return (book?.asks || []).map((row) => [Number(Array.isArray(row) ? row[0] : row?.price),
    Number(Array.isArray(row) ? row[1] : row?.size)])
    .filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((a, b) => a[0] - b[0]);
}
function book(tick, side) {
  const nested = side === "Up" ? tick?.up : tick?.down;
  const asks = levels(nested);
  return { asks, bestAsk: nested?.bestAsk ?? asks[0]?.[0] ?? null };
}
function midpoint(tick) {
  const bid = Number(tick?.up?.bestBid ?? tick?.upBid);
  const ask = Number(tick?.up?.bestAsk ?? tick?.upAsk);
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
}
function fallbackSide(rule, tick, replay) {
  const mid = midpoint(tick);
  const clob = mid == null ? null : (mid >= 0.5 ? "Up" : "Down");
  const bz = Number(tick?.bz), open = Number(replay?.openBinance);
  const binance = Number.isFinite(bz) && Number.isFinite(open) ? (bz >= open ? "Up" : "Down") : null;
  const upAsk = book(tick, "Up").bestAsk, downAsk = book(tick, "Down").bestAsk;
  const cheap = upAsk == null ? "Down" : downAsk == null ? "Up" : (upAsk <= downAsk ? "Up" : "Down");
  if (rule === "binance") return binance || clob || cheap;
  if (rule === "cheap") return cheap;
  if (rule === "consensus-risk") return clob && binance && clob === binance ? clob : cheap;
  return clob || binance || cheap;
}

// Retry after the normal 285-second cutoff. This cannot change earlier strategy
// decisions. Exact shares start at four and increase only to satisfy $1 minimum
// notional; attempts never pay above 0.99.
function mandatoryFallback(replay, rule) {
  const ticks = replay.ticks || [];
  let lastAttemptMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index];
    if (!(tick.t > 285) || tick.t > 295 || tick.ms - lastAttemptMs < 1_000) continue;
    lastAttemptMs = tick.ms;
    let side = fallbackSide(rule, tick, replay);
    for (let sideTry = 0; sideTry < 2; sideTry++) {
      if (sideTry) side = side === "Up" ? "Down" : "Up";
      const decisionBook = book(tick, side), ask = decisionBook.bestAsk;
      if (!(ask > 0) || ask > 0.99) continue;
      const cap = Math.min(0.99, Math.ceil((ask + 0.01 - 1e-9) * 100) / 100);
      const requestedShares = Math.max(4, Math.ceil((1 / ask) * 10_000) / 10_000);
      let arrivalIndex = index;
      const dueMs = tick.ms + 520;
      while (arrivalIndex + 1 < ticks.length && ticks[arrivalIndex + 1].ms <= dueMs) arrivalIndex++;
      const match = walkVisibleAsks(book(ticks[arrivalIndex], side), requestedShares, cap,
        { allowBbaFallback: false });
      if (!(match.shares > 0)) continue;
      return { tInto: dueMs / 1000 - Number(replay.ticks[0].ms) / 1000 + Number(replay.ticks[0].t || 0),
        decidedT: tick.t, placedT: tick.t, side, shares: round(match.shares),
        minimumShares: round(requestedShares), effPx: round(match.avgPx), usdc: round(match.cost),
        exec: "marketable", kind: "taker", leg: "fallback", role: "fallback",
        reason: `mandatory-${rule}`, status: match.shares + 1e-9 < requestedShares ? "partial" : "full",
        postOnly: false, orderType: "FAK", limitPx: cap };
    }
  }
  return null;
}

const rules = ["clob", "binance", "consensus-risk", "cheap"];
const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const entry = simulateFills({ ...replay, windowStart: file.ws }, entryParams);
  const reversal = simulateFills({ ...replay, windowStart: file.ws }, reversalParams);
  const session = sessionOf(file.ws);
  const hybrid = session === "US 13-21" ? entry : reversal;
  const results = {};
  for (const [name, fills] of Object.entries({ entry, reversal, hybrid })) {
    results[name] = { fills, pos: positionFromFills(fills, winner, replay.ticks) };
  }
  for (const rule of rules) {
    const fallback = hybrid.length ? null : mandatoryFallback(replay, rule);
    const fills = fallback ? [...hybrid, fallback] : hybrid;
    results[`hybridFallback_${rule}`] = { fills,
      fallback, pos: positionFromFills(fills, winner, replay.ticks) };
  }
  rows.push({ slug: file.name.split("_v2")[0], day: new Date(file.ms).toISOString().slice(0, 10),
    session, split: splitOf(file.ms), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) console.log(`progress ${index + 1}/${files.length}`);
}

const modeNames = ["entry", "reversal", "hybrid", ...rules.map((rule) => `hybridFallback_${rule}`)];
function summary(inputRows, mode) {
  const data = inputRows.map((row) => ({ row, value: row.results[mode] }));
  const active = data.filter(({ value }) => value.fills.length);
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0, equity = 0, peak = 0, maxDrawdown = 0;
  for (const { value } of data) {
    const p = value.pos.realizedPnl || 0;
    pnl += p; cost += (value.pos.totalCost || 0) + (value.pos.fee || 0);
    if (p > 0) grossProfit += p; else if (p < 0) grossLoss += -p;
    equity += p; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const firstCorrect = active.filter(({ row, value }) => value.fills[0]?.side === row.winner).length;
  const fallbacks = data.filter(({ value }) => value.fallback);
  return { markets: data.length, traded: active.length,
    participationPct: data.length ? round(active.length / data.length * 100, 3) : null,
    fills: data.reduce((sum, { value }) => sum + value.fills.length, 0),
    fallbackFills: fallbacks.length,
    fallbackAccuracyPct: fallbacks.length
      ? round(fallbacks.filter(({ row, value }) => value.fallback.side === row.winner).length / fallbacks.length * 100, 3) : null,
    wins: active.filter(({ value }) => value.pos.realizedPnl > 0).length,
    losses: active.filter(({ value }) => value.pos.realizedPnl < 0).length,
    firstAccuracyPct: active.length ? round(firstCorrect / active.length * 100, 3) : null,
    pnl: round(pnl, 2), roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2) };
}
function paired(inputRows, mode, baseline = "entry") {
  let baseProfit = 0, modeProfitRounds = 0, baseLoss = 0, modeLossRounds = 0;
  for (const row of inputRows) {
    const b = row.results[baseline].pos.realizedPnl || 0;
    const p = row.results[mode].pos.realizedPnl || 0;
    if (b > 0) { baseProfit += b; modeProfitRounds += p; }
    if (b < 0) { baseLoss += b; modeLossRounds += p; }
  }
  return { pnlDelta: round(inputRows.reduce((sum, row) => sum
      + (row.results[mode].pos.realizedPnl || 0) - (row.results[baseline].pos.realizedPnl || 0), 0), 2),
    profitRetentionPct: baseProfit ? round(modeProfitRounds / baseProfit * 100, 3) : null,
    lossReduction: round(modeLossRounds - baseLoss, 2) };
}

const segments = { fit: rows.filter((row) => row.split === "fit"),
  validation: rows.filter((row) => row.split === "validation"),
  holdout: rows.filter((row) => row.split === "holdout"), all: rows };
const report = { method: "exact entry/reversal replay plus causal post-cutoff L2 fallback",
  params: { entry: entryParams, reversal: reversalParams,
    hybrid: "strict reversal in Asia/Europe/late-US; entry-only in US 13-21" },
  segments: Object.fromEntries(Object.entries(segments).map(([name, segmentRows]) => [name, {
    modes: Object.fromEntries(modeNames.map((mode) => [mode, summary(segmentRows, mode)])),
    paired: Object.fromEntries(modeNames.filter((mode) => mode !== "entry")
      .map((mode) => [mode, paired(segmentRows, mode)])),
  }])),
  sessions: Object.fromEntries(["Asia 00-07", "Europe 07-13", "US 13-21", "late-US 21-24"]
    .map((session) => [session, Object.fromEntries(modeNames.map((mode) =>
      [mode, summary(rows.filter((row) => row.session === session), mode)]))])),
  daily: Object.fromEntries([...new Set(rows.map((row) => row.day))].map((day) => [day,
    Object.fromEntries(modeNames.map((mode) => [mode, summary(rows.filter((row) => row.day === day), mode)]))])),
};
console.log(JSON.stringify(report, null, 2));
