#!/usr/bin/env node
// Causal loss-round audit for the active FastMX policy on coherent BAPI v2 L2
// replays. Outcome labels are used only after simulation to classify results.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const outputDir = path.join(root, "data/research");
const startMs = Date.parse("2026-08-22T00:00:00Z");
const endMs = Date.parse("2026-09-03T13:30:00Z");
const fitEndMs = Date.parse("2026-08-28T00:00:00Z");
const validationEndMs = Date.parse("2026-08-31T00:00:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

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

function classifyLoss({ first, fills, winner }) {
  const initialCorrect = first.side === winner;
  const midpoint = Number(first.signal?.midpoint);
  const marketSide = Number.isFinite(midpoint) ? (midpoint >= 0.5 ? "Up" : "Down") : null;
  const laterWinnerFill = fills.slice(1).some((fill) => fill.side === winner);
  const laterLoserFill = fills.slice(1).some((fill) => fill.side !== winner);
  const badReversal = fills.slice(1).some((fill) => fill.leg === "reversal" && fill.side !== winner);
  if (initialCorrect) {
    if (badReversal) return { cause: "false-reversal-after-correct-entry", marketSide };
    if (laterLoserFill) return { cause: "opposite-buy-after-correct-entry", marketSide };
    return { cause: "correct-direction-but-negative-economics", marketSide };
  }
  if (laterWinnerFill) return { cause: "wrong-initial-corrected-but-still-loss", marketSide };
  if (first.leg === "fallback") {
    return { cause: marketSide === first.side
      ? "fallback-followed-market-then-outcome-reversed" : "fallback-direction-wrong", marketSide };
  }
  return { cause: marketSide === first.side
    ? "initial-market-direction-later-reversed" : "initial-signal-wrong-vs-market", marketSide };
}

const rows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const fills = simulateFills({ ...replay, windowStart: file.ws }, STRAT);
  const position = positionFromFills(fills, winner, replay.ticks);
  const first = fills[0] || null;
  const pnl = Number(position.realizedPnl) || 0;
  const cost = (Number(position.totalCost) || 0) + (Number(position.fee) || 0);
  const base = {
    slug: `btc-updown-5m-${file.ws}`,
    start: new Date(file.startMs).toISOString(),
    day: new Date(file.startMs).toISOString().slice(0, 10),
    split: splitOf(file.startMs), session: sessionOf(file.startMs), winner,
    pnl: round(pnl), cost: round(cost), fills: fills.length,
    fallbackFills: fills.filter((fill) => fill.leg === "fallback").length,
    reversalFills: fills.filter((fill) => fill.leg === "reversal").length,
    firstSide: first?.side ?? null, firstLeg: first?.leg ?? null,
    firstDecidedT: round(first?.decidedT ?? first?.tInto), firstFillT: round(first?.tInto),
    firstPrice: round(first?.effPx), firstMidpoint: round(first?.signal?.midpoint),
    firstMidVelocity: round(first?.signal?.midVelocity),
    firstBinanceVelocity: round(first?.signal?.binanceGapVelocity),
    firstTrendPct: round(first?.signal?.binanceTrendPct),
    initialCorrect: !!first && first.side === winner,
    finalLeader: position.upShares > position.downShares ? "Up"
      : position.downShares > position.upShares ? "Down" : "Flat",
    upShares: round(position.upShares), downShares: round(position.downShares),
  };
  if (pnl < -1e-9 && first) Object.assign(base, classifyLoss({ first, fills, winner }));
  rows.push(base);
  if ((index + 1) % 250 === 0 || index + 1 === files.length) {
    console.error(`progress ${index + 1}/${files.length}`);
  }
}

function summarize(input) {
  const traded = input.filter((row) => row.fills > 0);
  const losses = traded.filter((row) => row.pnl < 0);
  const causes = {};
  for (const row of losses) {
    const item = causes[row.cause] ||= { rounds: 0, pnl: 0, cost: 0 };
    item.rounds++; item.pnl += row.pnl; item.cost += row.cost;
  }
  for (const item of Object.values(causes)) {
    item.pnl = round(item.pnl, 2); item.cost = round(item.cost, 2);
    item.averageLoss = round(item.pnl / item.rounds, 4);
  }
  return {
    markets: input.length, traded: traded.length,
    wins: traded.filter((row) => row.pnl > 0).length,
    losses: losses.length,
    initialCorrect: traded.filter((row) => row.initialCorrect).length,
    initialAccuracyPct: traded.length
      ? round(traded.filter((row) => row.initialCorrect).length / traded.length * 100, 3) : null,
    pnl: round(traded.reduce((sum, row) => sum + row.pnl, 0), 2),
    cost: round(traded.reduce((sum, row) => sum + row.cost, 0), 2),
    lossPnl: round(losses.reduce((sum, row) => sum + row.pnl, 0), 2),
    causes,
  };
}

const losses = rows.filter((row) => row.pnl < 0);
const report = {
  method: "active FastMX policy; coherent BAPI v2 L2 at 120ms; causal decisions; outcome-only classification",
  range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  all: summarize(rows),
  splits: Object.fromEntries(["fit", "validation", "holdout"].map((split) =>
    [split, summarize(rows.filter((row) => row.split === split))])),
  sessions: Object.fromEntries(["asia", "europe", "us", "late_us"].map((session) =>
    [session, summarize(rows.filter((row) => row.session === session))])),
  days: Object.fromEntries([...new Set(rows.map((row) => row.day))].map((day) =>
    [day, summarize(rows.filter((row) => row.day === day))])),
  worstLosses: [...losses].sort((a, b) => a.pnl - b.pnl).slice(0, 50),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "fastmx-loss-causes-2026-09-03.json"),
  JSON.stringify({ ...report, rounds: rows, losses }, null, 2));
const csvColumns = ["start", "slug", "session", "winner", "pnl", "cost", "cause",
  "firstSide", "firstLeg", "firstDecidedT", "firstFillT", "firstPrice", "firstMidpoint",
  "firstMidVelocity", "firstBinanceVelocity", "firstTrendPct", "finalLeader", "upShares", "downShares",
  "fills", "fallbackFills", "reversalFills"];
const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
fs.writeFileSync(path.join(outputDir, "fastmx-loss-rounds-2026-09-03.csv"),
  `${csvColumns.join(",")}\n${losses.map((row) => csvColumns.map((key) => quote(row[key])).join(",")).join("\n")}\n`);
console.log(JSON.stringify(report, null, 2));
