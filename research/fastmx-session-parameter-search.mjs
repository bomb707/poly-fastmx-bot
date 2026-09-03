#!/usr/bin/env node
// Session-specific FastMX parameter search with a causal mandatory-entry path.
//
// Selection data ends before the Aug 31 holdout. Each candidate stops normal
// entries at t=239s. If it has not traded, a minimum-risk order retries from
// t=240s through t=299s against the archived arrival-time L2. This makes the
// 100%-participation requirement part of selection rather than a post-hoc
// filter. It does not claim that a live exchange can guarantee a fill.

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
const requestedSession = String(process.env.FASTMX_SESSION || "all").toLowerCase();
const searchStage = String(process.env.FASTMX_SEARCH_STAGE || "entry").toLowerCase();
const topCount = Math.max(1, Math.min(50, Number(process.env.FASTMX_TOP || 15)));

const START_MS = Date.parse("2026-08-22T00:00:00Z");
const FIT_END_MS = Date.parse("2026-08-28T00:00:00Z");
const END_MS = Date.parse("2026-08-31T00:00:00Z");
const FALLBACK_START_S = 240;
const FALLBACK_END_S = 299;
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function sessionOf(startMs) {
  const hour = new Date(startMs).getUTCHours();
  if (hour < 7) return "asia";
  if (hour < 13) return "europe";
  if (hour < 21) return "us";
  return "late-us";
}

const files = fs.readdirSync(cacheDir).map((name) => {
  const match = /^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  if (!match) return null;
  const startMs = Number(match[1]) * 1000;
  return { name, startMs, session: sessionOf(startMs) };
}).filter((row) => row && row.startMs >= START_MS && row.startMs < END_MS
  && (requestedSession === "all" || row.session === requestedSession))
  .sort((left, right) => left.startMs - right.startMs);

const signalProfiles = [
  [3_000, 0.02, 3_000, 5],
  [3_000, 0.02, 5_000, 5],
  [3_000, 0.02, 5_000, 10],
  [3_000, 0.02, 8_000, 5],
  [3_000, 0.02, 8_000, 10],
  [3_000, 0.02, 8_000, 15],
  [3_000, 0.02, 12_000, 10],
  [3_000, 0.02, 12_000, 15],
];

const variants = [];
const variantKeys = ["H_START_S", "H_STOP_S", "H_COOLDOWN_MS",
  "H_MID_VELOCITY_LOOKBACK_MS", "H_MID_VELOCITY_MIN",
  "H_BINANCE_GAP_VELOCITY_LOOKBACK_MS", "H_BINANCE_GAP_VELOCITY_MIN",
  "H_BINANCE_GAP_AGREE_ON", "H_BINANCE_TREND_ON",
  "H_BINANCE_TREND_LOOKBACK_SEC", "H_BINANCE_TREND_MIN_PCT",
  "H_BINANCE_COUNTERTREND_LOOKBACK_SEC", "H_BINANCE_COUNTERTREND_MIN_PCT",
  "H_MIN_ASK", "H_MAX_ASK", "H_CAP_HEADROOM", "H_HEDGE_ON",
  "H_HEDGE_RETAIN_SH", "H_REVERSAL_ON", "H_REVERSAL_RESIDUAL_SH",
  "H_REVERSAL_MAX_IMBALANCE_SH"];
const seenVariants = new Set();
function addVariant(params, label) {
  const key = JSON.stringify(variantKeys.map((name) => params[name]));
  if (seenVariants.has(key)) return;
  seenVariants.add(key);
  variants.push({ id: label, params });
}
function common(overrides) {
  return { ...deployed, H_STOP_S: FALLBACK_START_S - 1,
    H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true, H_HEDGE_ON: false, H_REVERSAL_ON: false,
    ...overrides };
}

const refinedSelected = {
  asia: { H_START_S: 60, H_COOLDOWN_MS: 10_000,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 12_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false, H_BINANCE_TREND_LOOKBACK_SEC: 60,
    H_BINANCE_TREND_MIN_PCT: 0.1 },
  europe: { H_START_S: 60, H_COOLDOWN_MS: 5_000,
    H_MID_VELOCITY_LOOKBACK_MS: 5_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false },
  us: { H_START_S: 60, H_COOLDOWN_MS: 15_000,
    H_MID_VELOCITY_LOOKBACK_MS: 8_000, H_MID_VELOCITY_MIN: 0.03,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: true },
  "late-us": { H_START_S: 60, H_COOLDOWN_MS: 15_000,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_GAP_AGREE_ON: false, H_BINANCE_TREND_LOOKBACK_SEC: 15,
    H_BINANCE_TREND_MIN_PCT: 0.05 },
};

const priceSelected = {
  asia: { ...refinedSelected.asia, H_MIN_ASK: 0.01 },
  europe: { ...refinedSelected.europe, H_MIN_ASK: 0.01 },
  us: { ...refinedSelected.us },
  "late-us": { ...refinedSelected["late-us"], H_CAP_HEADROOM: 0.02 },
};

if (searchStage === "reversal") {
  const selected = priceSelected[requestedSession];
  if (!selected) throw new Error("reversal stage requires a named UTC session");
  const base = common(selected);
  addVariant(base, "reversal-off");
  for (const residual of [4, 7, 10, 15]) {
    for (const maxImbalance of [10, 15, 25, 40, 60]) {
      addVariant({ ...base, H_REVERSAL_ON: true,
        H_REVERSAL_RESIDUAL_SH: residual,
        H_REVERSAL_MAX_IMBALANCE_SH: maxImbalance },
      `reversal-r${residual}-m${maxImbalance}`);
    }
  }
  for (const retain of [1, 4, 7, 10]) {
    addVariant({ ...base, H_HEDGE_ON: true, H_HEDGE_RETAIN_SH: retain },
      `hedge-retain-${retain}`);
  }
  for (const residual of [4, 10]) {
    for (const maxImbalance of [15, 25]) {
      for (const retain of [1, 4]) {
        addVariant({ ...base, H_REVERSAL_ON: true,
          H_REVERSAL_RESIDUAL_SH: residual,
          H_REVERSAL_MAX_IMBALANCE_SH: maxImbalance,
          H_HEDGE_ON: true, H_HEDGE_RETAIN_SH: retain },
        `both-r${residual}-m${maxImbalance}-h${retain}`);
      }
    }
  }
} else if (searchStage === "price") {
  const selected = refinedSelected[requestedSession];
  if (!selected) throw new Error("price stage requires a named UTC session");
  const base = common(selected);
  addVariant(base, "baseline");
  for (const maxAsk of [0.75, 0.8, 0.85, 0.9, 0.95, 0.98]) {
    addVariant({ ...base, H_MAX_ASK: maxAsk }, `max-ask-${maxAsk}`);
  }
  for (const minAsk of [0.01, 0.05, 0.1, 0.15, 0.2]) {
    addVariant({ ...base, H_MIN_ASK: minAsk }, `min-ask-${minAsk}`);
  }
  for (const headroom of [0, 0.01, 0.02, 0.03]) {
    addVariant({ ...base, H_CAP_HEADROOM: headroom }, `headroom-${headroom}`);
  }
} else if (searchStage === "refine") {
  const selected = {
    asia: { H_START_S: 60, H_COOLDOWN_MS: 10_000,
      H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 12_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
      H_BINANCE_GAP_AGREE_ON: false },
    europe: { H_START_S: 60, H_COOLDOWN_MS: 5_000,
      H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
      H_BINANCE_GAP_AGREE_ON: false },
    us: { H_START_S: 60, H_COOLDOWN_MS: 15_000,
      H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
      H_BINANCE_GAP_AGREE_ON: true },
    "late-us": { H_START_S: 60, H_COOLDOWN_MS: 15_000,
      H_MID_VELOCITY_LOOKBACK_MS: 3_000, H_MID_VELOCITY_MIN: 0.02,
      H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5_000, H_BINANCE_GAP_VELOCITY_MIN: 10,
      H_BINANCE_GAP_AGREE_ON: false },
  }[requestedSession];
  if (!selected) throw new Error("refine stage requires FASTMX_SESSION=asia|europe|us|late-us");
  const base = common(selected);
  addVariant(base, "baseline");
  for (const midLookbackMs of [2_000, 3_000, 5_000, 8_000]) {
    for (const midMin of [0.01, 0.02, 0.03, 0.04]) {
      addVariant({ ...base, H_MID_VELOCITY_LOOKBACK_MS: midLookbackMs,
        H_MID_VELOCITY_MIN: midMin }, `mid-${midLookbackMs}-${midMin}`);
    }
  }
  for (const trendLookbackSec of [15, 30, 60, 90]) {
    for (const trendMinPct of [0.025, 0.05, 0.075, 0.1]) {
      addVariant({ ...base, H_BINANCE_TREND_LOOKBACK_SEC: trendLookbackSec,
        H_BINANCE_TREND_MIN_PCT: trendMinPct },
      `trend-${trendLookbackSec}-${trendMinPct}`);
    }
  }
  for (const counterLookbackSec of [30, 45, 60]) {
    for (const counterMinPct of [0.05, 0.075, 0.1, 0.15]) {
      addVariant({ ...base, H_BINANCE_COUNTERTREND_LOOKBACK_SEC: counterLookbackSec,
        H_BINANCE_COUNTERTREND_MIN_PCT: counterMinPct },
      `counter-${counterLookbackSec}-${counterMinPct}`);
    }
  }
  addVariant({ ...base, H_BINANCE_TREND_ON: false }, "trend-off");
} else {
  for (const startS of [0, 30, 60]) {
    for (const cooldownMs of [5_000, 10_000, 15_000]) {
      for (const [midLookbackMs, midMin, binanceLookbackMs, binanceMin] of signalProfiles) {
        for (const gapAgree of [false, true]) {
          const params = common({ H_START_S: startS, H_COOLDOWN_MS: cooldownMs,
            H_MID_VELOCITY_LOOKBACK_MS: midLookbackMs, H_MID_VELOCITY_MIN: midMin,
            H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: binanceLookbackMs,
            H_BINANCE_GAP_VELOCITY_MIN: binanceMin,
            H_BINANCE_GAP_AGREE_ON: gapAgree });
          addVariant(params, `s${startS}-c${cooldownMs}-m${midLookbackMs}x${midMin}`
            + `-b${binanceLookbackMs}x${binanceMin}-g${gapAgree ? 1 : 0}`);
        }
      }
    }
  }
}

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
  const spot = Number(tick?.bz);
  const open = Number(replay?.openBinance);
  const binance = Number.isFinite(spot) && Number.isFinite(open)
    ? (spot >= open ? "Up" : "Down") : null;
  const upAsk = bookAt(tick, "Up").bestAsk;
  const downAsk = bookAt(tick, "Down").bestAsk;
  const cheap = upAsk == null ? "Down" : downAsk == null ? "Up"
    : (upAsk <= downAsk ? "Up" : "Down");
  if (rule === "binance") return binance || clob || cheap;
  if (rule === "agreement") return clob && binance && clob === binance ? clob : cheap;
  if (rule === "cheap") return cheap;
  return clob || binance || cheap;
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
    for (let sideTry = 0; sideTry < 2; sideTry++) {
      if (sideTry) side = side === "Up" ? "Down" : "Up";
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
        kind: "taker", leg: "fallback", role: "fallback",
        reason: `mandatory-240-${rule}`,
        status: match.shares + 1e-9 < requestedShares ? "partial" : "full",
        postOnly: false, orderType: "FAK", limitPx: cap };
    }
  }
  return null;
}

const fallbackRules = ["clob", "binance", "agreement", "cheap"];
const blank = () => ({ markets: 0, traded: 0, fallbackFills: 0,
  fallbackCorrect: 0, wins: 0, losses: 0, fills: 0, pnl: 0, cost: 0,
  grossProfit: 0, grossLoss: 0, equity: 0, peak: 0, maxDrawdown: 0 });
const states = variants.map(() => Object.fromEntries(fallbackRules.map((rule) =>
  [rule, { fit: blank(), validation: blank(), preHoldout: blank() }])));

function add(state, { fills, pos, winner, fallback }) {
  state.markets++;
  if (!fills.length) return;
  const pnl = pos.realizedPnl || 0;
  state.traded++;
  state.fills += fills.length;
  state.pnl += pnl;
  state.cost += (pos.totalCost || 0) + (pos.fee || 0);
  if (fallback) {
    state.fallbackFills++;
    if (fallback.side === winner) state.fallbackCorrect++;
  }
  if (pnl > 0) { state.wins++; state.grossProfit += pnl; }
  else if (pnl < 0) { state.losses++; state.grossLoss += -pnl; }
  state.equity += pnl;
  state.peak = Math.max(state.peak, state.equity);
  state.maxDrawdown = Math.max(state.maxDrawdown, state.peak - state.equity);
}

for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
  const file = files[fileIndex];
  const replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file.name))));
  if (!Array.isArray(replay.ticks) || replay.ticks.length < 2 || !replay.winSide) continue;
  const winner = replay.winSide === "Up" ? "Up" : "Down";
  const segment = file.startMs < FIT_END_MS ? "fit" : "validation";
  const fallbacks = Object.fromEntries(fallbackRules.map((rule) => [rule, mandatoryFill(replay, rule)]));
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const normal = simulateFills({ ...replay, windowStart: file.startMs / 1000 },
      variants[variantIndex].params);
    for (const rule of fallbackRules) {
      const fallback = normal.length ? null : fallbacks[rule];
      const fills = fallback ? [...normal, fallback] : normal;
      const pos = positionFromFills(fills, winner, replay.ticks);
      const row = { fills, pos, winner, fallback };
      add(states[variantIndex][rule][segment], row);
      add(states[variantIndex][rule].preHoldout, row);
    }
  }
  if ((fileIndex + 1) % 50 === 0 || fileIndex + 1 === files.length) {
    console.error(`progress ${requestedSession} ${fileIndex + 1}/${files.length}`);
  }
}

function metrics(raw) {
  return { markets: raw.markets, traded: raw.traded,
    participationPct: raw.markets ? round(raw.traded / raw.markets * 100, 3) : null,
    fills: raw.fills, fallbackFills: raw.fallbackFills,
    fallbackAccuracyPct: raw.fallbackFills
      ? round(raw.fallbackCorrect / raw.fallbackFills * 100, 3) : null,
    wins: raw.wins, losses: raw.losses,
    winRatePct: raw.traded ? round(raw.wins / raw.traded * 100, 3) : null,
    pnl: round(raw.pnl, 2), roiPct: raw.cost ? round(raw.pnl / raw.cost * 100, 4) : null,
    profitFactor: raw.grossLoss ? round(raw.grossProfit / raw.grossLoss, 4) : null,
    maxDrawdown: round(raw.maxDrawdown, 2) };
}

const candidates = [];
for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
  for (const rule of fallbackRules) {
    candidates.push({ id: `${variants[variantIndex].id}-f${rule}`,
      params: Object.fromEntries(variantKeys.map((key) =>
        [key, variants[variantIndex].params[key]])),
      fallbackRule: rule,
      fit: metrics(states[variantIndex][rule].fit),
      validation: metrics(states[variantIndex][rule].validation),
      preHoldout: metrics(states[variantIndex][rule].preHoldout) });
  }
}

const ranked = candidates.filter((row) => row.fit.participationPct === 100
  && row.validation.participationPct === 100).sort((left, right) => {
  const stableLeft = left.fit.pnl > 0 && left.validation.pnl > 0 ? 1 : 0;
  const stableRight = right.fit.pnl > 0 && right.validation.pnl > 0 ? 1 : 0;
  const floorLeft = Math.min(left.fit.profitFactor || 0, left.validation.profitFactor || 0);
  const floorRight = Math.min(right.fit.profitFactor || 0, right.validation.profitFactor || 0);
  return stableRight - stableLeft || floorRight - floorLeft
    || right.preHoldout.pnl - left.preHoldout.pnl
    || left.preHoldout.maxDrawdown - right.preHoldout.maxDrawdown
    || left.preHoldout.fills - right.preHoldout.fills;
});

console.log(JSON.stringify({ method: "exact FastMX engine plus causal mandatory t=240 L2 fallback",
  selectionRange: { start: new Date(START_MS).toISOString(),
    fitEnd: new Date(FIT_END_MS).toISOString(), end: new Date(END_MS).toISOString() },
  session: requestedSession, searchStage, markets: files.length, normalVariants: variants.length,
  candidatesIncludingFallbackRule: candidates.length,
  ranking: "both fit and validation positive, then worst-split profit factor, total PnL, drawdown",
  top: ranked.slice(0, topCount) }, null, 2));
