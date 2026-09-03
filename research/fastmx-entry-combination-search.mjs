#!/usr/bin/env node
// Chronological parameter screen for the currently registered FastMX/helpme
// strategy. The direction logic, sizing, execution, and inventory policy stay
// frozen; only existing entry timing/frequency/confirmation parameters vary.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(root, "data/wincache");
const runtimeFile = path.join(root, "data/runtime-config.json");
const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
const deployed = { ...STRAT, ...(runtime.shadowParams || {}) };
const screen = String(process.env.FASTMX_SCREEN || "coarse").toLowerCase();

const START_MS = Date.parse("2026-08-22T00:00:00Z");
const FIT_END_MS = Date.parse("2026-08-28T00:00:00Z");
const VALIDATION_END_MS = Date.parse("2026-08-31T00:00:00Z");
const END_MS = Date.parse("2026-09-03T13:30:00Z");
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  return match ? { name, startMs: Number(match[1]) * 1000 } : null;
}).filter((row) => row && row.startMs >= START_MS && row.startMs < END_MS)
  .sort((left, right) => left.startMs - right.startMs);

const idOf = (p) => [
  `start${p.H_START_S}`,
  `cool${p.H_COOLDOWN_MS}`,
  `midlb${p.H_MID_VELOCITY_LOOKBACK_MS}`,
  `mid${p.H_MID_VELOCITY_MIN}`,
  `bzlb${p.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS}`,
  `bz${p.H_BINANCE_GAP_VELOCITY_MIN}`,
  `open${p.H_BINANCE_GAP_AGREE_ON ? 1 : 0}`,
].join("-");

const variants = [{ id: "current", params: { ...deployed } }];
// The preceding one-variable replay eliminated a higher CLOB threshold as
// harmful and showed that shorter cooldowns mainly preserve over-entry. Keep
// this interaction screen deliberately small to avoid mining 13 days of noise.
if (screen === "chosen") {
  const params = { ...deployed,
    H_START_S: 30, H_COOLDOWN_MS: 7_500,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000,
    H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false,
    H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
  };
  variants.push({ id: idOf(params), params });
} else if (screen === "final") {
  for (const [cooldownMs, binanceLookbackMs, binanceMin, gapAgree] of [
    [5_000, 8_000, 5, false],
    [5_000, 8_000, 10, false],
    [7_500, 8_000, 5, false],
    [7_500, 8_000, 10, false],
    [10_000, 8_000, 5, false],
    [10_000, 8_000, 10, false],
    [5_000, 10_000, 5, false],
    [5_000, 8_000, 5, true],
  ]) {
    const params = { ...deployed,
      H_START_S: 30, H_COOLDOWN_MS: cooldownMs,
      H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: binanceLookbackMs,
      H_BINANCE_GAP_VELOCITY_MIN: binanceMin,
      H_BINANCE_GAP_AGREE_ON: gapAgree,
      H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
      H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
    };
    variants.push({ id: idOf(params), params });
  }
} else if (screen === "refine") {
  for (const [midLookbackMs, binanceLookbackMs] of [
    [2_000, 3_000], [3_000, 2_000], [3_000, 3_000], [5_000, 3_000],
    [3_000, 5_000], [5_000, 5_000], [8_000, 3_000], [3_000, 8_000],
  ]) {
    const params = { ...deployed,
      H_START_S: 30, H_COOLDOWN_MS: 5_000,
      H_MID_VELOCITY_LOOKBACK_MS: midLookbackMs,
      H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: binanceLookbackMs,
      H_BINANCE_GAP_VELOCITY_MIN: 5,
      H_BINANCE_GAP_AGREE_ON: false,
      H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
      H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
    };
    variants.push({ id: idOf(params), params });
  }
} else {
  for (const startS of [0, 30]) {
    for (const cooldownMs of [5_000, 10_000]) {
      for (const midMin of [0.02]) {
        for (const binanceMin of [5, 10]) {
          for (const gapAgree of [false, true]) {
            const params = { ...deployed,
              H_START_S: startS,
              H_COOLDOWN_MS: cooldownMs,
              H_MID_VELOCITY_MIN: midMin,
              H_BINANCE_GAP_VELOCITY_MIN: binanceMin,
              H_BINANCE_GAP_AGREE_ON: gapAgree,
              // Freeze the defining FastMX direction and inventory logic.
              H_CLOB_MID_VELOCITY_ON: true,
              H_BINANCE_GAP_MOMENTUM_ON: true,
              H_BINANCE_TREND_ON: true,
              H_HEDGE_ON: false,
              H_REVERSAL_ON: false,
            };
            variants.push({ id: idOf(params), params });
          }
        }
      }
    }
  }
}

const blank = () => ({ markets: 0, traded: 0, wins: 0, losses: 0,
  directionCorrect: 0, fills: 0, cost: 0, fees: 0, pnl: 0,
  grossProfit: 0, grossLoss: 0, equity: 0, peak: 0, maxDrawdown: 0,
  daily: new Map() });
const states = variants.map(() => ({ fit: blank(), validation: blank(),
  holdout: blank(), preHoldout: blank(), all: blank() }));

function segment(startMs) {
  if (startMs < FIT_END_MS) return "fit";
  if (startMs < VALIDATION_END_MS) return "validation";
  return "holdout";
}

function add(state, row, day) {
  state.markets++;
  if (!row.fills) return;
  state.traded++;
  state.fills += row.fills;
  state.cost += row.cost;
  state.fees += row.fees;
  state.pnl += row.pnl;
  state.directionCorrect += row.directionCorrect ? 1 : 0;
  if (row.pnl > 0) { state.wins++; state.grossProfit += row.pnl; }
  else if (row.pnl < 0) { state.losses++; state.grossLoss += -row.pnl; }
  state.equity += row.pnl;
  state.peak = Math.max(state.peak, state.equity);
  state.maxDrawdown = Math.max(state.maxDrawdown, state.peak - state.equity);
  state.daily.set(day, (state.daily.get(day) || 0) + row.pnl);
}

for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
  const file = files[fileIndex];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const day = new Date(file.startMs).toISOString().slice(0, 10);
  const split = segment(file.startMs);
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const fills = simulateFills({ ...replay, windowStart: file.startMs / 1000 }, variants[variantIndex].params);
    const position = positionFromFills(fills, winner, replay.ticks);
    const row = { fills: fills.length,
      cost: position.totalCost || 0,
      fees: position.fee || 0,
      pnl: position.realizedPnl || 0,
      directionCorrect: fills.length > 0 && fills[0].side === winner };
    const state = states[variantIndex];
    add(state[split], row, day);
    add(state.all, row, day);
    if (split !== "holdout") add(state.preHoldout, row, day);
  }
  if ((fileIndex + 1) % 100 === 0 || fileIndex + 1 === files.length) {
    console.log(`progress ${fileIndex + 1}/${files.length}`);
  }
}

function metrics(raw) {
  const dailyPnls = [...raw.daily.values()];
  return {
    markets: raw.markets,
    traded: raw.traded,
    fills: raw.fills,
    fillsPerTraded: raw.traded ? round(raw.fills / raw.traded, 3) : null,
    wins: raw.wins,
    losses: raw.losses,
    winRatePct: raw.traded ? round(raw.wins / raw.traded * 100, 3) : null,
    directionAccuracyPct: raw.traded ? round(raw.directionCorrect / raw.traded * 100, 3) : null,
    pnl: round(raw.pnl, 2),
    pnlPerTraded: raw.traded ? round(raw.pnl / raw.traded, 4) : null,
    roiPct: raw.cost + raw.fees > 0 ? round(raw.pnl / (raw.cost + raw.fees) * 100, 4) : null,
    profitFactor: raw.grossLoss > 0 ? round(raw.grossProfit / raw.grossLoss, 4) : null,
    maxDrawdown: round(raw.maxDrawdown, 2),
    positiveDays: dailyPnls.filter((pnl) => pnl > 0).length,
    losingDays: dailyPnls.filter((pnl) => pnl < 0).length,
    daily: Object.fromEntries([...raw.daily].map(([day, pnl]) => [day, round(pnl, 2)])),
  };
}

const rows = variants.map((variant, index) => ({
  id: variant.id,
  params: {
    H_START_S: variant.params.H_START_S,
    H_COOLDOWN_MS: variant.params.H_COOLDOWN_MS,
    H_MID_VELOCITY_LOOKBACK_MS: variant.params.H_MID_VELOCITY_LOOKBACK_MS,
    H_MID_VELOCITY_MIN: variant.params.H_MID_VELOCITY_MIN,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: variant.params.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS,
    H_BINANCE_GAP_VELOCITY_MIN: variant.params.H_BINANCE_GAP_VELOCITY_MIN,
    H_BINANCE_GAP_AGREE_ON: variant.params.H_BINANCE_GAP_AGREE_ON,
  },
  fit: metrics(states[index].fit),
  validation: metrics(states[index].validation),
  preHoldout: metrics(states[index].preHoldout),
  holdout: metrics(states[index].holdout),
  all: metrics(states[index].all),
}));

const candidates = rows.filter((row) => row.id !== "current"
  && row.fit.traded >= 500 && row.validation.traded >= 250);
const robust = [...candidates].sort((left, right) => {
  const leftFloor = Math.min(left.fit.profitFactor || 0, left.validation.profitFactor || 0);
  const rightFloor = Math.min(right.fit.profitFactor || 0, right.validation.profitFactor || 0);
  return rightFloor - leftFloor
    || (right.preHoldout.profitFactor || 0) - (left.preHoldout.profitFactor || 0)
    || right.preHoldout.pnl - left.preHoldout.pnl
    || left.preHoldout.fills - right.preHoldout.fills;
});
const bestPrePnl = [...candidates].sort((a, b) => b.preHoldout.pnl - a.preHoldout.pnl);
const bestPrePf = [...candidates].sort((a, b) => (b.preHoldout.profitFactor || 0) - (a.preHoldout.profitFactor || 0));

const metricSummary = ({ daily: _daily, ...rest }) => rest;
const compact = (row) => ({ id: row.id, params: row.params,
  fit: metricSummary(row.fit), validation: metricSummary(row.validation),
  preHoldout: metricSummary(row.preHoldout), holdout: metricSummary(row.holdout),
  all: metricSummary(row.all) });
console.log(JSON.stringify({
  method: "exact registered helpme engine; selection excludes Aug 31-Sep 3 holdout",
  screen,
  range: { start: new Date(START_MS).toISOString(), fitEnd: new Date(FIT_END_MS).toISOString(),
    validationEnd: new Date(VALIDATION_END_MS).toISOString(), end: new Date(END_MS).toISOString(),
    cachedWindows: files.length },
  frozen: {
    direction: "CLOB midpoint velocity AND Binance velocity must qualify and agree",
    trend: "enabled with current 30s/0.05% and 60s/0.075% settings",
    sizing: { H_BASE_ORDER_SH: deployed.H_BASE_ORDER_SH, H_MIN_ORDER_SH: deployed.H_MIN_ORDER_SH },
    execution: { LATENCY_MS: deployed.LATENCY_MS, H_MIN_ASK: deployed.H_MIN_ASK,
      H_MAX_ASK: deployed.H_MAX_ASK, H_CAP_HEADROOM: deployed.H_CAP_HEADROOM },
    inventory: { H_HEDGE_ON: false, H_REVERSAL_ON: false },
  },
  variants: rows.length,
  current: compact(rows[0]),
  robustWinnerDetail: robust[0] || null,
  robustTop: robust.slice(0, 12).map(compact),
  preHoldoutPnlTop: bestPrePnl.slice(0, 8).map(compact),
  preHoldoutProfitFactorTop: bestPrePf.slice(0, 8).map(compact),
}, null, 2));
