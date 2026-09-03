#!/usr/bin/env node
// FastMX session-specific entry-economics screen.
//
// Signal sources come from the preceding causal ablation. This script changes
// one axis at a time while holding every primary order at the 10-share minimum:
//   FASTMX_SCREEN=price      -> maximum entry ask
//   FASTMX_SCREEN=start      -> earliest entry second
//   FASTMX_SCREEN=threshold  -> velocity threshold scale
//   FASTMX_SCREEN=lookback   -> velocity lookback scale
// Results separate primary signals from the mandatory late fallback so weak
// signal coverage cannot masquerade as entry quality.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const outputDir = path.join(root, "data/research");
const axis = String(process.env.FASTMX_SCREEN || "price").toLowerCase();
const START_MS = Date.parse("2026-08-22T00:00:00Z");
const FIT_END_MS = Date.parse("2026-08-28T00:00:00Z");
const VALIDATION_END_MS = Date.parse("2026-08-31T00:00:00Z");
const END_MS = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const selectedSources = Object.freeze({
  asia: Object.freeze({ clob: true, binance: false, trend: false, gap: false }),
  europe: Object.freeze({ clob: true, binance: true, trend: true, gap: true }),
  us: Object.freeze({ clob: true, binance: true, trend: true, gap: true }),
  late_us: Object.freeze({ clob: false, binance: true, trend: false, gap: false }),
});

// Chosen without the Aug 31-Sep 3 "later" segment: Asia/Europe maximize the
// fit+validation primary result at 0.65; US and late-US retain 0.98 because it
// is the only/strongest profitable fit+validation ceiling. The price screen
// itself overrides these values with its tested common ceiling.
const selectedMaxAsk = Object.freeze({ asia: 0.65, europe: 0.65, us: 0.98, late_us: 0.98 });
const selectedStartS = Object.freeze({ asia: 60, europe: 60, us: 60, late_us: 30 });
const selectedThresholdScale = Object.freeze({ asia: 0.75, europe: 1, us: 0.5, late_us: 1 });
const selectedLookbackScale = Object.freeze({ asia: 1.5, europe: 0.75, us: 0.75, late_us: 1.5 });
const selectedFallbackRule = Object.freeze({ asia: "cheap", europe: "clob", us: "clob", late_us: "binance" });
const selectedFallbackStartS = Object.freeze({ asia: 120, europe: 90, us: 60, late_us: 90 });

function scaleFinite(value, scale, minimum) {
  return Math.max(minimum, Math.round(Number(value) * scale));
}

function profileFor(name, change = {}) {
  const current = STRAT.H_SESSION_PROFILES[name] || {};
  const source = selectedSources[name];
  const thresholdScale = Number(change.thresholdScale) || selectedThresholdScale[name];
  const lookbackScale = Number(change.lookbackScale) || selectedLookbackScale[name];
  const fallbackStartS = Number(change.fallbackStartS) || selectedFallbackStartS[name];
  return { ...current,
    H_START_S: change.startS ?? selectedStartS[name],
    H_STOP_S: fallbackStartS - 1,
    H_CLOB_MID_VELOCITY_ON: source.clob,
    H_BINANCE_GAP_MOMENTUM_ON: source.binance,
    H_BINANCE_TREND_ON: source.trend,
    H_BINANCE_GAP_AGREE_ON: source.gap,
    H_MID_VELOCITY_LOOKBACK_MS: scaleFinite(current.H_MID_VELOCITY_LOOKBACK_MS,
      lookbackScale, 1_000),
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: scaleFinite(
      current.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS, lookbackScale, 1_000),
    H_MID_VELOCITY_MIN: Number(current.H_MID_VELOCITY_MIN) * thresholdScale,
    H_BINANCE_GAP_VELOCITY_MIN: Number(current.H_BINANCE_GAP_VELOCITY_MIN) * thresholdScale,
    H_MAX_ASK: change.maxAsk ?? selectedMaxAsk[name],
    H_REVERSAL_ON: false,
    H_ENTRY_RISK_USD: 0,
    H_PARTICIPATION_RISK_USD: 0,
    H_PARTICIPATION_SIDE: change.fallbackRule || selectedFallbackRule[name],
    H_PARTICIPATION_START_S: fallbackStartS,
  };
}

function paramsFor(change) {
  const profiles = Object.fromEntries(Object.keys(selectedSources)
    .map((name) => [name, profileFor(name, change)]));
  return { ...STRAT,
    H_SESSION_POLICY_ON: true,
    H_SESSION_PROFILES: profiles,
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
    H_PARTICIPATION_START_S: change.fallbackStartS ?? 240,
    H_PARTICIPATION_END_S: 299,
    H_PARTICIPATION_RISK_USD: 0,
    H_PARTICIPATION_MAX_ASK: 0.99,
  };
}

const changes = axis === "final" ? [{ id: "selected" }] : axis === "start" ? [0, 30, 60, 90, 120].map((startS) => ({
  id: `start-${startS}`, startS,
})) : axis === "threshold" ? [0.5, 0.75, 1, 1.5, 2].map((thresholdScale) => ({
  id: `threshold-${thresholdScale}`, thresholdScale,
})) : axis === "lookback" ? [0.5, 0.75, 1, 1.5, 2].map((lookbackScale) => ({
  id: `lookback-${lookbackScale}`, lookbackScale,
})) : axis === "fallback-rule" ? ["clob", "binance", "cheap", "consensus"].map((fallbackRule) => ({
  id: `fallback-rule-${fallbackRule}`, fallbackRule,
})) : axis === "fallback-time" ? [60, 90, 120, 150].map((fallbackStartS) => ({
  id: `fallback-time-${fallbackStartS}`, fallbackStartS,
})) : [0.55, 0.60, 0.65, 0.70, 0.75, 0.85, 0.98].map((maxAsk) => ({
  id: `max-ask-${maxAsk}`, maxAsk,
}));
const variants = changes.map((change) => ({ ...change, params: paramsFor(change) }));

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
      price: first?.effPx ?? null,
      shares: first?.shares ?? 0,
      cost: (Number(position.totalCost) || 0) + (Number(position.fee) || 0),
      pnl: Number(position.realizedPnl) || 0,
    };
  }
  rows.push({ startMs: file.startMs,
    day: new Date(file.startMs).toISOString().slice(0, 10),
    session: sessionOf(file.startMs), split: splitOf(file.startMs), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) {
    console.error(`progress ${index + 1}/${files.length}`);
  }
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
    untraded: input.length - selected.length,
    coveragePct: input.length ? round(selected.length / input.length * 100, 3) : null,
    wins, losses,
    directionAccuracyPct: selected.length ? round(correct / selected.length * 100, 3) : null,
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
  method: "registered FastMX causal replay; selected source subset by UTC session; one 10-share entry; one-factor economic screen",
  axis,
  range: { start: new Date(START_MS).toISOString(), fitEnd: new Date(FIT_END_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(), end: new Date(END_MS).toISOString() },
  invariant: { selectedSources, selectedMaxAsk, selectedStartS, selectedThresholdScale,
    selectedLookbackScale, selectedFallbackRule, selectedFallbackStartS,
    minimumShares: 10, maxSignalOrders: 1,
    fallbackStartS: "session-specific", primarySizeRule: "exactly 10 requested shares",
    fallbackSizeRule: "exactly 10 requested shares", latencyMs: STRAT.LATENCY_MS,
    payoutCap: null },
  variants: Object.fromEntries(variants.map(({ id, params: _params, ...change }) => [id, change])),
  sessions: Object.fromEntries(Object.keys(selectedSources).map((session) => [session,
    Object.fromEntries(Object.entries(segments).map(([segment, input]) => [segment,
      Object.fromEntries(variants.map(({ id }) => [id,
        cell(input.filter((row) => row.session === session), id)]))]))])),
};
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `fastmx-entry-economics-${axis}-2026-09-03.json`);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ axis, outputPath, invariant: report.invariant,
  sessions: Object.fromEntries(Object.entries(report.sessions).map(([session, data]) => [session,
    Object.fromEntries(Object.entries(data).map(([segment, cells]) => [segment,
      Object.fromEntries(Object.entries(cells).map(([id, value]) => [id, value]))]))])) }, null, 2));
