#!/usr/bin/env node
// Session-stratified, paired evaluation of FastMX opposite-side controls on
// top of the selected entry-frequency profile. Uses the registered strategy
// and exact replay engine; no production behavior is changed.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const runtime = JSON.parse(fs.readFileSync(path.join(root, "data/runtime-config.json"), "utf8"));
const deployed = { ...STRAT, ...(runtime.shadowParams || {}) };
const startMs = Date.parse("2026-08-22T00:00:00Z");
const endMs = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const selectedEntry = { ...deployed,
  H_START_S: 30, H_COOLDOWN_MS: 7_500,
  H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
  H_BINANCE_GAP_AGREE_ON: false,
  H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
};

const modes = {
  current: deployed,
  entrySelected: selectedEntry,
  reversal_r4_m25: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 4, H_REVERSAL_MAX_IMBALANCE_SH: 25 },
  reversal_r10_m25: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 10, H_REVERSAL_MAX_IMBALANCE_SH: 25 },
  reversal_r4_m50: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 4, H_REVERSAL_MAX_IMBALANCE_SH: 50 },
  reversal_r10_m50: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 10, H_REVERSAL_MAX_IMBALANCE_SH: 50 },
  reversal_r4_m100: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 4, H_REVERSAL_MAX_IMBALANCE_SH: 100 },
  reversal_r10_m100: { ...selectedEntry, H_REVERSAL_ON: true,
    H_REVERSAL_RESIDUAL_SH: 10, H_REVERSAL_MAX_IMBALANCE_SH: 100 },
  hedge_retain1: { ...selectedEntry, H_HEDGE_ON: true, H_HEDGE_RETAIN_SH: 1 },
  hedge_retain4: { ...selectedEntry, H_HEDGE_ON: true, H_HEDGE_RETAIN_SH: 4 },
  hedge_and_reversal: { ...selectedEntry, H_HEDGE_ON: true, H_HEDGE_RETAIN_SH: 1,
    H_REVERSAL_ON: true, H_REVERSAL_RESIDUAL_SH: 4, H_REVERSAL_MAX_IMBALANCE_SH: 50 },
};

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  return match ? { name, ws: Number(match[1]), startMs: Number(match[1]) * 1000 } : null;
}).filter((row) => row && row.startMs >= startMs && row.startMs < endMs)
  .sort((a, b) => a.startMs - b.startMs);

function utcSession(ws) {
  const hour = new Date(ws * 1000).getUTCHours();
  if (hour < 7) return "Asia 00-07";
  if (hour < 13) return "Europe 07-13";
  if (hour < 21) return "US 13-21";
  return "late-US 21-24";
}

const windows = [];
for (let index = 0; index < files.length; index++) {
  const file = files[index];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const results = {};
  for (const [name, params] of Object.entries(modes)) {
    const fills = simulateFills({ ...replay, windowStart: file.ws }, params);
    const position = positionFromFills(fills, winner, replay.ticks);
    const firstSide = fills[0]?.side || null;
    const oppositeFills = firstSide == null ? [] : fills.filter((fill) => fill.side !== firstSide);
    results[name] = {
      pnl: position.realizedPnl || 0,
      cost: position.totalCost || 0,
      fees: position.fee || 0,
      fills: fills.length,
      entries: fills.filter((fill) => fill.leg === "entry").length,
      hedges: fills.filter((fill) => fill.leg === "hedge").length,
      reversals: fills.filter((fill) => fill.leg === "reversal").length,
      firstSide, firstCorrect: firstSide != null && firstSide === winner,
      oppositeFills: oppositeFills.length,
      oppositeCorrect: oppositeFills.filter((fill) => fill.side === winner).length,
    };
  }
  windows.push({ slug: file.name.split("_v2")[0], ws: file.ws,
    day: new Date(file.startMs).toISOString().slice(0, 10),
    session: utcSession(file.ws), winner, results });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) console.log(`progress ${index + 1}/${files.length}`);
}

function summarize(rows, mode) {
  const values = rows.map((row) => row.results[mode]);
  const traded = values.filter((row) => row.fills > 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  let grossProfit = 0, grossLoss = 0;
  for (const row of values) {
    equity += row.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossProfit += row.pnl; else if (row.pnl < 0) grossLoss += -row.pnl;
  }
  const pnl = values.reduce((sum, row) => sum + row.pnl, 0);
  const cost = values.reduce((sum, row) => sum + row.cost + row.fees, 0);
  const firstCorrect = traded.filter((row) => row.firstCorrect);
  const firstWrong = traded.filter((row) => !row.firstCorrect);
  return { markets: rows.length, traded: traded.length,
    participationPct: rows.length ? round(traded.length / rows.length * 100, 3) : null,
    fills: values.reduce((sum, row) => sum + row.fills, 0),
    entries: values.reduce((sum, row) => sum + row.entries, 0),
    hedges: values.reduce((sum, row) => sum + row.hedges, 0),
    reversals: values.reduce((sum, row) => sum + row.reversals, 0),
    oppositeFills: values.reduce((sum, row) => sum + row.oppositeFills, 0),
    oppositeCorrectPct: values.reduce((sum, row) => sum + row.oppositeFills, 0)
      ? round(values.reduce((sum, row) => sum + row.oppositeCorrect, 0)
        / values.reduce((sum, row) => sum + row.oppositeFills, 0) * 100, 3) : null,
    wins: traded.filter((row) => row.pnl > 0).length,
    losses: traded.filter((row) => row.pnl < 0).length,
    firstCorrect: firstCorrect.length, firstWrong: firstWrong.length,
    firstAccuracyPct: traded.length ? round(firstCorrect.length / traded.length * 100, 3) : null,
    firstCorrectPnl: round(firstCorrect.reduce((sum, row) => sum + row.pnl, 0), 2),
    firstWrongPnl: round(firstWrong.reduce((sum, row) => sum + row.pnl, 0), 2),
    pnl: round(pnl, 2), roiPct: cost ? round(pnl / cost * 100, 4) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : null,
    maxDrawdown: round(maxDrawdown, 2) };
}

function paired(rows, mode) {
  let baseProfit = 0, newOnBaseProfit = 0, baseLoss = 0, newOnBaseLoss = 0;
  let improvedLossRounds = 0, worsenedLossRounds = 0, rescuedToProfit = 0;
  let better = 0, worse = 0, equal = 0;
  for (const row of rows) {
    const base = row.results.entrySelected.pnl, value = row.results[mode].pnl;
    if (base > 0) { baseProfit += base; newOnBaseProfit += value; }
    if (base < 0) {
      baseLoss += base; newOnBaseLoss += value;
      if (value > base + 1e-9) improvedLossRounds++;
      else if (value < base - 1e-9) worsenedLossRounds++;
      if (value > 0) rescuedToProfit++;
    }
    if (value > base + 1e-9) better++;
    else if (value < base - 1e-9) worse++;
    else equal++;
  }
  return { pnlDelta: round(rows.reduce((sum, row) => sum
      + row.results[mode].pnl - row.results.entrySelected.pnl, 0), 2),
    baseProfit: round(baseProfit, 2), newOnBaseProfit: round(newOnBaseProfit, 2),
    profitRetentionPct: baseProfit ? round(newOnBaseProfit / baseProfit * 100, 3) : null,
    baseLoss: round(baseLoss, 2), newOnBaseLoss: round(newOnBaseLoss, 2),
    lossReduction: round(newOnBaseLoss - baseLoss, 2),
    improvedLossRounds, worsenedLossRounds, rescuedToProfit, better, worse, equal };
}

const sessionNames = ["Asia 00-07", "Europe 07-13", "US 13-21", "late-US 21-24"];
const summary = Object.fromEntries(Object.keys(modes).map((mode) => [mode, summarize(windows, mode)]));
const sessions = Object.fromEntries(sessionNames.map((session) => [session,
  Object.fromEntries(Object.keys(modes).map((mode) =>
    [mode, summarize(windows.filter((row) => row.session === session), mode)]))]));
const pairedResults = Object.fromEntries(Object.keys(modes).filter((mode) => mode !== "entrySelected" && mode !== "current")
  .map((mode) => [mode, paired(windows, mode)]));

console.log(JSON.stringify({ method: "exact helpme/simrun paired replay", windows: windows.length,
  range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  configs: Object.fromEntries(Object.entries(modes).map(([name, p]) => [name, {
    hedge: p.H_HEDGE_ON, hedgeRetain: p.H_HEDGE_RETAIN_SH,
    reversal: p.H_REVERSAL_ON, reversalResidual: p.H_REVERSAL_RESIDUAL_SH,
    reversalMaxImbalance: p.H_REVERSAL_MAX_IMBALANCE_SH,
  }])), summary, sessions, paired: pairedResults }, null, 2));
