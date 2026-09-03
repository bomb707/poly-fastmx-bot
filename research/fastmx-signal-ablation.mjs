#!/usr/bin/env node
// FastMX causal entry-source ablation under the clarified economic objective.
// Every mode uses one minimum-10-share primary entry or a minimum-10-share
// fallback. No practical share/payout/cost ceiling binds this research screen;
// position size is held constant so ROI differences come from entry quality,
// price, timing, and fees rather than capital scaling.

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

const modes = Object.freeze({
  clob_only: { clob: true, binance: false, trend: false, gap: false },
  clob_window_gap: { clob: true, binance: false, trend: false, gap: true },
  binance_only: { clob: false, binance: true, trend: false, gap: false },
  binance_trend: { clob: false, binance: true, trend: true, gap: false },
  binance_trend_gap: { clob: false, binance: true, trend: true, gap: true },
  clob_binance_agree: { clob: true, binance: true, trend: false, gap: false },
  clob_binance_trend: { clob: true, binance: true, trend: true, gap: false },
  all_confirmations: { clob: true, binance: true, trend: true, gap: true },
});

function paramsFor(mode) {
  const profiles = Object.fromEntries(Object.entries(STRAT.H_SESSION_PROFILES || {})
    .map(([name, profile]) => [name, { ...profile,
      H_CLOB_MID_VELOCITY_ON: mode.clob,
      H_BINANCE_GAP_MOMENTUM_ON: mode.binance,
      H_BINANCE_TREND_ON: mode.trend,
      H_BINANCE_GAP_AGREE_ON: mode.gap,
      H_REVERSAL_ON: false,
      H_ENTRY_RISK_USD: 1,
      H_PARTICIPATION_RISK_USD: 1,
    }]));
  return { ...STRAT,
    H_SESSION_POLICY_ON: true,
    H_SESSION_PROFILES: profiles,
    H_CLOB_MID_VELOCITY_ON: mode.clob,
    H_BINANCE_GAP_MOMENTUM_ON: mode.binance,
    H_BINANCE_TREND_ON: mode.trend,
    H_BINANCE_GAP_AGREE_ON: mode.gap,
    H_HEDGE_ON: false,
    H_REVERSAL_ON: false,
    H_RESCUE_MAKER_ON: false,
    H_DYNAMIC_SIZE_ON: false,
    H_BASE_ORDER_SH: 10,
    H_MIN_ORDER_SH: 10,
    H_MIN_ORDER_USD: 1,
    H_RISK_LIMITS_ON: true,
    H_MAX_SIGNAL_ORDERS: 1,
    H_MAX_ORDER_SH: 1_000_000,
    H_MAX_GROSS_SH: 1_000_000,
    H_MAX_ROUND_COST_USD: 1_000_000,
    H_MAX_ROUND_WORST_LOSS_USD: 1_000_000,
    H_PARTICIPATION_ON: true,
    H_PARTICIPATION_START_S: 240,
    H_PARTICIPATION_END_S: 299,
    H_PARTICIPATION_RISK_USD: 1,
    H_PARTICIPATION_MAX_ASK: 0.99,
  };
}

const variants = Object.entries(modes).map(([id, mode]) => ({ id, params: paramsFor(mode) }));
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

const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const results = {};
  for (const variant of variants) {
    const fills = simulateFills({ ...replay, windowStart: file.ws }, variant.params);
    const position = positionFromFills(fills, winner, replay.ticks);
    const first = fills[0] || null;
    results[variant.id] = {
      fills: fills.length,
      primary: first?.leg === "entry",
      fallback: first?.leg === "fallback",
      correct: first?.side === winner,
      side: first?.side ?? null,
      decidedT: first?.decidedT ?? first?.tInto ?? null,
      fillT: first?.tInto ?? null,
      price: first?.effPx ?? null,
      shares: first?.shares ?? 0,
      cost: (Number(position.totalCost) || 0) + (Number(position.fee) || 0),
      pnl: Number(position.realizedPnl) || 0,
    };
  }
  rows.push({ startMs: file.startMs, day: new Date(file.startMs).toISOString().slice(0, 10),
    session: sessionOf(file.startMs), split: splitOf(file.startMs), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) console.error(`progress ${index + 1}/${files.length}`);
}

function summarize(input, id, kind = "all") {
  const selected = input.map((row) => ({ row, value: row.results[id] }))
    .filter(({ value }) => kind === "all" ? value.fills > 0
      : kind === "primary" ? value.primary : value.fallback);
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0;
  let correct = 0, decidedT = 0, price = 0, shares = 0, wins = 0, losses = 0;
  for (const { value } of selected) {
    pnl += value.pnl; cost += value.cost; decidedT += value.decidedT || 0;
    price += value.price || 0; shares += value.shares || 0;
    if (value.correct) correct++;
    if (value.pnl > 0) { wins++; grossProfit += value.pnl; }
    else if (value.pnl < 0) { losses++; grossLoss += -value.pnl; }
  }
  return { rounds: input.length, traded: selected.length,
    coveragePct: input.length ? round(selected.length / input.length * 100, 3) : null,
    wins, losses, directionAccuracyPct: selected.length ? round(correct / selected.length * 100, 3) : null,
    averageDecisionS: selected.length ? round(decidedT / selected.length, 3) : null,
    averagePrice: selected.length ? round(price / selected.length, 4) : null,
    averageShares: selected.length ? round(shares / selected.length, 4) : null,
    pnl: round(pnl, 2), cost: round(cost, 2),
    pnlPerRound: input.length ? round(pnl / input.length, 4) : null,
    roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null };
}

function cell(input, id) {
  return { all: summarize(input, id), primary: summarize(input, id, "primary"),
    fallback: summarize(input, id, "fallback") };
}
const segments = { fit: rows.filter((row) => row.split === "fit"),
  validation: rows.filter((row) => row.split === "validation"),
  later: rows.filter((row) => row.split === "later"), all: rows };
const report = {
  method: "registered FastMX causal replay; one minimum-10-share entry; source ablation; effectively unbounded screen ceilings",
  range: { start: new Date(START_MS).toISOString(), fitEnd: new Date(FIT_END_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(), end: new Date(END_MS).toISOString() },
  invariant: { minimumShares: 10, maxSignalOrders: 1, fallbackStartS: 240,
    latencyMs: STRAT.LATENCY_MS, shareAndPayoutCap: null },
  modes,
  segments: Object.fromEntries(Object.entries(segments).map(([name, input]) => [name,
    Object.fromEntries(variants.map(({ id }) => [id, cell(input, id)]))])),
  sessions: Object.fromEntries(["asia", "europe", "us", "late_us"].map((session) => [session,
    Object.fromEntries(Object.entries(segments).map(([segment, input]) => [segment,
      Object.fromEntries(variants.map(({ id }) => [id, cell(input.filter((row) => row.session === session), id)]))]))])),
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "fastmx-signal-ablation-2026-09-03.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ method: report.method, invariant: report.invariant,
  sessions: Object.fromEntries(Object.entries(report.sessions).map(([session, data]) => [session,
    Object.fromEntries(Object.entries(data).map(([segment, cells]) => [segment,
      Object.fromEntries(Object.entries(cells).map(([id, value]) => [id, value.all]))]))])) }, null, 2));

