#!/usr/bin/env node
// Daily/session audit of the reviewed FastMX strategy on coherent BAPI-v2 L2.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const outputDir = path.join(root, "data/research");
const START_MS = Date.parse("2026-08-22T00:00:00Z");
const FIT_END_MS = Date.parse("2026-08-28T00:00:00Z");
const VALIDATION_END_MS = Date.parse("2026-08-31T00:00:00Z");
const END_MS = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function withoutProfileReversals(params) {
  return { ...params, H_REVERSAL_ON: false, H_RESCUE_MAKER_ON: false,
    H_SESSION_PROFILES: Object.fromEntries(Object.entries(params.H_SESSION_PROFILES || {})
      .map(([name, profile]) => [name, { ...profile, H_REVERSAL_ON: false }])) };
}

function profilesWith(params, overrides) {
  return Object.fromEntries(Object.entries(params.H_SESSION_PROFILES || {})
    .map(([name, profile]) => [name, { ...profile, ...overrides }]));
}

const variants = Object.freeze({
  min10_one_entry: { ...STRAT, H_BASE_ORDER_SH: 10, H_MIN_ORDER_SH: 10,
    H_MAX_ENTRY_ORDERS: 1 },
  min10_two_entries: { ...STRAT, H_BASE_ORDER_SH: 10, H_MIN_ORDER_SH: 10,
    H_MAX_ENTRY_ORDERS: 2 },
  min10_repeated_entries: { ...STRAT, H_BASE_ORDER_SH: 10, H_MIN_ORDER_SH: 10,
    H_MAX_ENTRY_ORDERS: null },
  return_efficiency_unbounded: { ...STRAT, H_DYNAMIC_SIZE_ON: true,
    H_BASE_ORDER_SH: 10, H_MIN_ORDER_SH: 10, H_MAX_ENTRY_ORDERS: 1,
    H_ENTRY_SIZE_MODE: "return-efficiency", H_MAX_ORDER_SH: null,
    H_MAX_GROSS_SH: null, H_MAX_ROUND_COST_USD: null,
    H_MAX_ROUND_WORST_LOSS_USD: null },
  prior_validated: STRAT,
});

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  const startMs = match ? Number(match[1]) * 1000 : null;
  return startMs == null ? null : { name, startMs, ws: startMs / 1000 };
}).filter((row) => row && row.startMs >= START_MS && row.startMs < END_MS)
  .sort((a, b) => a.startMs - b.startMs);

function sessionOf(startMs) {
  const hour = new Date(startMs).getUTCHours();
  return hour < 7 ? "asia" : hour < 13 ? "europe" : hour < 21 ? "us" : "late_us";
}
function splitOf(startMs) {
  return startMs < FIT_END_MS ? "fit" : startMs < VALIDATION_END_MS ? "validation" : "later";
}
function lossCause(value, winner) {
  const first = value.fills[0];
  if (!first) return "untraded";
  const winnerFills = value.fills.filter((fill) => fill.side === winner);
  const loserFills = value.fills.filter((fill) => fill.side && fill.side !== winner);
  if (first.leg === "fallback") {
    if (first.side !== winner && winnerFills.length) return "wrong-fallback-correction-insufficient";
    if (first.side !== winner) return "wrong-fallback-uncorrected";
    if (loserFills.length) return "correct-fallback-false-reversal";
    return "correct-fallback-overpayment-or-fees";
  }
  if (first.side !== winner && winnerFills.length) return "wrong-entry-correction-insufficient";
  if (first.side !== winner) return "wrong-entry-uncorrected";
  if (loserFills.some((fill) => fill.leg === "reversal")) return "correct-entry-false-reversal";
  if (loserFills.length) return "correct-entry-opposite-buy";
  return "correct-entry-overpayment-or-fees";
}

const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const results = {};
  for (const [id, params] of Object.entries(variants)) {
    const fills = simulateFills({ ...replay, windowStart: file.ws }, params);
    const position = positionFromFills(fills, winner, replay.ticks);
    const first = fills[0] || null;
    results[id] = { fills, firstLeg: first?.leg ?? null, firstSide: first?.side ?? null,
      firstPrice: first?.effPx ?? null, firstShares: first?.shares ?? 0,
      firstDecisionS: first?.decidedT ?? first?.tInto ?? null,
      initialCorrect: first?.side === winner,
      cost: (Number(position.totalCost) || 0) + (Number(position.fee) || 0),
      pnl: Number(position.realizedPnl) || 0 };
    results[id].lossCause = results[id].pnl < 0 ? lossCause(results[id], winner) : null;
  }
  rows.push({ startMs: file.startMs, iso: new Date(file.startMs).toISOString(),
    day: new Date(file.startMs).toISOString().slice(0, 10), session: sessionOf(file.startMs),
    split: splitOf(file.startMs), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) {
    console.error(`progress ${index + 1}/${files.length}`);
  }
}

function summarize(input, id) {
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0, peak = 0, curve = 0, maxDrawdown = 0;
  let wins = 0, losses = 0, flats = 0, traded = 0, fills = 0, correct = 0;
  let firstPrice = 0, firstShares = 0, decisionS = 0, maxLoss = 0, maxCost = 0;
  const causes = {};
  for (const row of input) {
    const value = row.results[id];
    pnl += value.pnl; cost += value.cost; curve += value.pnl; peak = Math.max(peak, curve);
    maxDrawdown = Math.max(maxDrawdown, peak - curve); maxLoss = Math.min(maxLoss, value.pnl);
    maxCost = Math.max(maxCost, value.cost); fills += value.fills.length;
    if (value.fills.length) {
      traded++; correct += value.initialCorrect ? 1 : 0; firstPrice += value.firstPrice || 0;
      firstShares += value.firstShares || 0; decisionS += value.firstDecisionS || 0;
    }
    if (value.pnl > 0) { wins++; grossProfit += value.pnl; }
    else if (value.pnl < 0) { losses++; grossLoss += -value.pnl;
      causes[value.lossCause] = causes[value.lossCause] || { rounds: 0, pnl: 0 };
      causes[value.lossCause].rounds++;
      causes[value.lossCause].pnl += value.pnl;
    } else flats++;
  }
  return { rounds: input.length, traded, coveragePct: input.length ? round(traded / input.length * 100, 3) : null,
    fills, wins, losses, flats, pnl: round(pnl, 2), cost: round(cost, 2),
    roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2), maxRoundLoss: round(maxLoss, 2), maxRoundCost: round(maxCost, 2),
    averageCostPerRound: input.length ? round(cost / input.length, 4) : null,
    initialAccuracyPct: traded ? round(correct / traded * 100, 3) : null,
    averageFirstPrice: traded ? round(firstPrice / traded, 4) : null,
    averageFirstShares: traded ? round(firstShares / traded, 4) : null,
    averageDecisionS: traded ? round(decisionS / traded, 3) : null,
    lossCauses: Object.fromEntries(Object.entries(causes)
      .map(([cause, value]) => [cause, { rounds: value.rounds, pnl: round(value.pnl, 2) }])) };
}

function grouped(key, id) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([value, input]) => [value, summarize(input, id)]));
}

function groupedSessionSplit(id) {
  const groups = new Map();
  for (const row of rows) {
    const value = `${row.session}:${row.split}`;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([value, input]) => [value, summarize(input, id)]));
}

const report = {
  method: "registered FastMX strategy; coherent BAPI-v2 L2 at native ~120ms cadence; 520ms taker arrival; visible depth; configured fees",
  range: { start: new Date(START_MS).toISOString(), fitEnd: new Date(FIT_END_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(), end: new Date(END_MS).toISOString() },
  variants: Object.keys(variants),
  summary: Object.fromEntries(Object.keys(variants).map((id) => [id, summarize(rows, id)])),
  bySplit: Object.fromEntries(Object.keys(variants).map((id) => [id, grouped("split", id)])),
  bySession: Object.fromEntries(Object.keys(variants).map((id) => [id, grouped("session", id)])),
  bySessionSplit: Object.fromEntries(Object.keys(variants).map((id) => [id, groupedSessionSplit(id)])),
  daily: Object.fromEntries(Object.keys(variants).map((id) => [id, grouped("day", id)])),
  lossRounds: rows.filter((row) => row.results.min10_repeated_entries.pnl < 0).map((row) => ({
    iso: row.iso, session: row.session, winner: row.winner,
    pnl: round(row.results.min10_repeated_entries.pnl, 4),
    cost: round(row.results.min10_repeated_entries.cost, 4),
    firstLeg: row.results.min10_repeated_entries.firstLeg,
    firstSide: row.results.min10_repeated_entries.firstSide,
    firstPrice: row.results.min10_repeated_entries.firstPrice,
    firstShares: row.results.min10_repeated_entries.firstShares,
    cause: row.results.min10_repeated_entries.lossCause,
  })),
};

fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "fastmx-reviewed-strategy-backtest-2026-09-03.json");
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, method: report.method, summary: report.summary,
  bySplit: report.bySplit.min10_repeated_entries,
  bySession: report.bySession.min10_repeated_entries,
  daily: report.daily.min10_repeated_entries }, null, 2));
