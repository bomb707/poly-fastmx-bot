#!/usr/bin/env node
// Session-by-session capital-target screen for the active FastMX policy.
// Direction logic and hard limits remain frozen. Each session is independently
// ranked before the Aug 31 holdout, then its sealed holdout is reported.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const outputDir = path.join(root, "data/research");
const startMs = Date.parse("2026-08-22T00:00:00Z");
const fitEndMs = Date.parse("2026-08-28T00:00:00Z");
const validationEndMs = Date.parse("2026-08-31T00:00:00Z");
const endMs = Date.parse("2026-09-03T13:30:00Z");
const sessions = ["asia", "europe", "us", "late_us"];
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const variants = [];
for (const entryRisk of [2, 4, 7, 10]) {
  for (const fallbackRisk of [1, 2, 4]) {
    const id = `entry${entryRisk}-fallback${fallbackRisk}`;
    const sessionProfiles = Object.fromEntries(Object.entries(STRAT.H_SESSION_PROFILES || {})
      .map(([name, profile]) => [name, { ...profile,
        H_ENTRY_RISK_USD: entryRisk,
        H_REVERSAL_RISK_USD: entryRisk,
        H_PARTICIPATION_RISK_USD: fallbackRisk,
      }]));
    variants.push({ id, entryRisk, fallbackRisk, params: {
      ...STRAT,
      H_SESSION_PROFILES: sessionProfiles,
      H_ENTRY_RISK_USD: entryRisk,
      H_REVERSAL_RISK_USD: entryRisk,
      H_PARTICIPATION_RISK_USD: fallbackRisk,
    } });
  }
}

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  const ws = match ? Number(match[1]) : null;
  return ws != null ? { name, ws, startMs: ws * 1000 } : null;
}).filter((row) => row && row.startMs >= startMs && row.startMs < endMs)
  .sort((a, b) => a.startMs - b.startMs);

function sessionOf(ms) {
  const hour = new Date(ms).getUTCHours();
  return hour < 7 ? "asia" : hour < 13 ? "europe" : hour < 21 ? "us" : "late_us";
}

function splitOf(ms) {
  return ms < fitEndMs ? "fit" : ms < validationEndMs ? "validation" : "holdout";
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
    results[variant.id] = { pnl: Number(position.realizedPnl) || 0,
      cost: (Number(position.totalCost) || 0) + (Number(position.fee) || 0),
      fills: fills.length, fallback: fills.filter((fill) => fill.leg === "fallback").length,
      reversal: fills.filter((fill) => fill.leg === "reversal").length };
  }
  rows.push({ startMs: file.startMs, session: sessionOf(file.startMs), split: splitOf(file.startMs), results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) console.error(`progress ${index + 1}/${files.length}`);
}

function summarize(input, id) {
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0, fills = 0, traded = 0;
  let fallback = 0, reversal = 0, equity = 0, peak = 0, maxDrawdown = 0, wins = 0, losses = 0;
  for (const row of input) {
    const value = row.results[id];
    if (value.fills) traded++;
    fills += value.fills; fallback += value.fallback; reversal += value.reversal;
    pnl += value.pnl; cost += value.cost;
    if (value.pnl > 0) { wins++; grossProfit += value.pnl; }
    else if (value.pnl < 0) { losses++; grossLoss += -value.pnl; }
    equity += value.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return { markets: input.length, traded, participationPct: input.length ? round(traded / input.length * 100, 3) : null,
    fills, fallback, reversal, wins, losses, pnl: round(pnl, 2), cost: round(cost, 2),
    costPerRound: input.length ? round(cost / input.length, 4) : null,
    pnlPerRound: input.length ? round(pnl / input.length, 4) : null,
    roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2) };
}

const bySession = {};
const selected = {};
for (const session of sessions) {
  const sessionRows = rows.filter((row) => row.session === session);
  const cells = variants.map((variant) => ({ id: variant.id,
    entryRisk: variant.entryRisk, fallbackRisk: variant.fallbackRisk,
    fit: summarize(sessionRows.filter((row) => row.split === "fit"), variant.id),
    validation: summarize(sessionRows.filter((row) => row.split === "validation"), variant.id),
    preHoldout: summarize(sessionRows.filter((row) => row.split !== "holdout"), variant.id),
    holdout: summarize(sessionRows.filter((row) => row.split === "holdout"), variant.id),
    all: summarize(sessionRows, variant.id),
  }));
  // Require complete participation. Prefer a candidate positive in both fit
  // and validation; rank by the weaker segment's ROI, then pre-holdout PnL.
  const eligible = cells.filter((cell) => cell.fit.participationPct === 100
    && cell.validation.participationPct === 100);
  const stable = eligible.filter((cell) => cell.fit.pnl > 0 && cell.validation.pnl > 0);
  const pool = stable.length ? stable : eligible;
  pool.sort((a, b) => Math.min(b.fit.roiPct, b.validation.roiPct)
    - Math.min(a.fit.roiPct, a.validation.roiPct)
    || b.preHoldout.pnl - a.preHoldout.pnl
    || b.preHoldout.costPerRound - a.preHoldout.costPerRound);
  selected[session] = pool[0]?.id || null;
  bySession[session] = cells;
}

function combined(input) {
  const synthetic = input.map((row) => ({ results: { selected: row.results[selected[row.session]] } }));
  return summarize(synthetic, "selected");
}

const report = {
  method: "coherent BAPI v2 L2 120ms; active FastMX direction/risk logic frozen; per-session sizing selected before holdout",
  range: { start: new Date(startMs).toISOString(), fitEnd: new Date(fitEndMs).toISOString(),
    validationEnd: new Date(validationEndMs).toISOString(), end: new Date(endMs).toISOString() },
  fixedRisk: { maxOrderShares: STRAT.H_MAX_ORDER_SH, maxGrossShares: STRAT.H_MAX_GROSS_SH,
    maxRoundCostUsd: STRAT.H_MAX_ROUND_COST_USD, maxWorstLossUsd: STRAT.H_MAX_ROUND_WORST_LOSS_USD,
    maxSignalOrders: STRAT.H_MAX_SIGNAL_ORDERS },
  selected,
  selectedCombined: {
    fit: combined(rows.filter((row) => row.split === "fit")),
    validation: combined(rows.filter((row) => row.split === "validation")),
    preHoldout: combined(rows.filter((row) => row.split !== "holdout")),
    holdout: combined(rows.filter((row) => row.split === "holdout")),
    all: combined(rows),
  },
  bySession,
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "fastmx-session-sizing-search-2026-09-03.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report,
  bySession: Object.fromEntries(sessions.map((session) => [session,
    bySession[session].sort((a, b) => b.preHoldout.pnl - a.preHoldout.pnl)])) }, null, 2));
