#!/usr/bin/env node
// Chronological evaluation of the implemented FastMX session/risk/reversal/
// passive-rescue policy. Candidate selection uses Aug 22-30; Aug 31-Sep 3 is
// reported as a sealed holdout and is never used to rank candidates.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const runtime = JSON.parse(fs.readFileSync(path.join(root, "data/runtime-config.json"), "utf8"));
const deployed = { ...STRAT, ...(runtime.shadowParams || {}),
  H_SESSION_POLICY_ON: false, H_DYNAMIC_SIZE_ON: false,
  H_RISK_LIMITS_ON: false, H_PARTICIPATION_ON: false,
  H_RESCUE_MAKER_ON: false };

const START_MS = Date.parse("2026-08-22T00:00:00Z");
const VALIDATION_END_MS = Date.parse("2026-08-31T00:00:00Z");
const END_MS = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function complete({ entryRisk, worstLoss, maxOrders, participationStart = 240,
  reversalConfirm = 3000, reversalEconomic = true,
  reversalMinEdge = -0.03, reversalMaxLockedLoss = 2, rescue = true }) {
  const sessionProfiles = Object.fromEntries(Object.entries(deployed.H_SESSION_PROFILES || {})
    .map(([name, profile]) => [name, profile.H_REVERSAL_ON ? { ...profile,
      H_REVERSAL_CONFIRM_MS: reversalConfirm,
      H_REVERSAL_ECONOMIC_GATE_ON: reversalEconomic } : { ...profile }]));
  return { ...deployed,
    H_SESSION_POLICY_ON: true,
    H_SESSION_PROFILES: sessionProfiles,
    H_DYNAMIC_SIZE_ON: true,
    H_ENTRY_RISK_USD: entryRisk,
    H_RISK_LIMITS_ON: true,
    H_MAX_ORDER_SH: 100,
    H_MAX_GROSS_SH: 500,
    H_MAX_ROUND_COST_USD: 250,
    H_MAX_ROUND_WORST_LOSS_USD: worstLoss,
    H_MAX_SIGNAL_ORDERS: maxOrders,
    H_PARTICIPATION_ON: true,
    H_PARTICIPATION_START_S: participationStart,
    H_PARTICIPATION_END_S: 299,
    H_PARTICIPATION_RETRY_MS: 1000,
    H_PARTICIPATION_RISK_USD: 1,
    H_PARTICIPATION_MAX_ASK: 0.99,
    H_REVERSAL_DYNAMIC_SIZE_ON: true,
    H_REVERSAL_RISK_USD: entryRisk,
    H_REVERSAL_ECONOMIC_GATE_ON: reversalEconomic,
    H_REVERSAL_MIN_PAIR_EDGE: reversalMinEdge,
    H_REVERSAL_MAX_LOCKED_LOSS_USD: reversalMaxLockedLoss,
    H_RESCUE_MAKER_ON: rescue,
    H_RESCUE_START_S: 270,
    H_RESCUE_END_S: 299,
    H_RESCUE_PRICE_HIGH: 0.02,
    H_RESCUE_PRICE_LOW: 0.01,
    H_RESCUE_TOTAL_RISK_USD: 2,
    H_RESCUE_RETAIN_SH: 25,
    H_RESCUE_REQUIRE_BOTH: true,
  };
}

const candidates = {
  current: deployed,
  conservative_p60: complete({ entryRisk: 2, worstLoss: 10, maxOrders: 4, participationStart: 60 }),
  conservative_p90: complete({ entryRisk: 2, worstLoss: 10, maxOrders: 4, participationStart: 90 }),
  p60_reversal_1s: complete({ entryRisk: 2, worstLoss: 10, maxOrders: 4,
    participationStart: 60, reversalConfirm: 1000, reversalEconomic: false }),
  p90_reversal_1s: complete({ entryRisk: 2, worstLoss: 10, maxOrders: 4,
    participationStart: 90, reversalConfirm: 1000, reversalEconomic: false }),
  balanced_p60: complete({ entryRisk: 4, worstLoss: 25, maxOrders: 4,
    participationStart: 60, reversalConfirm: 1000, reversalEconomic: false }),
};

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  const startMs = match ? Number(match[1]) * 1000 : null;
  return startMs != null ? { name, startMs, ws: startMs / 1000 } : null;
}).filter((row) => row && row.startMs >= START_MS && row.startMs < END_MS)
  .sort((a, b) => a.startMs - b.startMs);

function sessionOf(ms) {
  const hour = new Date(ms).getUTCHours();
  return hour < 7 ? "Asia 00-07" : hour < 13 ? "Europe 07-13"
    : hour < 21 ? "US 13-21" : "late-US 21-24";
}

const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const results = {};
  for (const [name, params] of Object.entries(candidates)) {
    const fills = simulateFills({ ...replay, windowStart: file.ws }, params);
    results[name] = { fills, position: positionFromFills(fills, winner, replay.ticks) };
  }
  rows.push({ startMs: file.startMs,
    day: new Date(file.startMs).toISOString().slice(0, 10),
    session: sessionOf(file.startMs), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) {
    console.error(`progress ${index + 1}/${files.length}`);
  }
}

function summarize(input, mode) {
  let pnl = 0, cost = 0, grossProfit = 0, grossLoss = 0;
  let equity = 0, peak = 0, maxDrawdown = 0;
  let fills = 0, traded = 0, fallback = 0, rescueFills = 0, reversalFills = 0;
  let wins = 0, losses = 0;
  for (const row of input) {
    const value = row.results[mode];
    const p = value.position.realizedPnl || 0;
    const active = value.fills.length > 0;
    if (active) traded++;
    fills += value.fills.length;
    fallback += value.fills.filter((fill) => fill.leg === "fallback").length;
    rescueFills += value.fills.filter((fill) => fill.leg === "rescue").length;
    reversalFills += value.fills.filter((fill) => fill.leg === "reversal").length;
    if (active && p > 0) wins++; else if (active && p < 0) losses++;
    pnl += p;
    cost += (value.position.totalCost || 0) + (value.position.fee || 0);
    if (p > 0) grossProfit += p; else if (p < 0) grossLoss += -p;
    equity += p; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return { markets: input.length, traded,
    participationPct: input.length ? round(traded / input.length * 100, 3) : null,
    fills, fallbackFills: fallback, rescueFills, reversalFills,
    wins, losses, pnl: round(pnl, 2),
    roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2), cost: round(cost, 2) };
}

const fitValidation = rows.filter((row) => row.startMs < VALIDATION_END_MS);
const holdout = rows.filter((row) => row.startMs >= VALIDATION_END_MS);
const rank = Object.keys(candidates).filter((name) => name !== "current")
  .map((name) => ({ name, ...summarize(fitValidation, name) }))
  .sort((a, b) => b.pnl - a.pnl);
const selected = rank[0]?.name || null;
const modeNames = Object.keys(candidates);
const summaries = (input) => Object.fromEntries(modeNames.map((name) => [name, summarize(input, name)]));

console.log(JSON.stringify({
  method: "exact registered FastMX replay; candidate ranking ends before sealed holdout",
  range: { start: new Date(START_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(),
    end: new Date(END_MS).toISOString() },
  selectedOnPreHoldout: selected,
  rankingPreHoldout: rank,
  all: summaries(rows),
  preHoldout: summaries(fitValidation),
  holdout: summaries(holdout),
  selectedSessions: selected ? Object.fromEntries(
    ["Asia 00-07", "Europe 07-13", "US 13-21", "late-US 21-24"].map((session) =>
      [session, summarize(rows.filter((row) => row.session === session), selected)])) : {},
  selectedDaily: selected ? Object.fromEntries([...new Set(rows.map((row) => row.day))].map((day) =>
    [day, summarize(rows.filter((row) => row.day === day), selected)])) : {},
  selectedParams: selected ? candidates[selected] : null,
}, null, 2));
