// FastMX — target-derived scored direction with explicit release hysteresis,
// the Binance rolling-trend regime, and role-aware inventory handling.
//
// The default policy weights current CLOB level, five-second CLOB impulse, and
// five-second Binance impulse. The legacy strict dual-threshold selector stays
// available when H_TARGET_DIRECTION_ON is disabled. Binance gap velocity is
// the raw-dollar dev-tool definition:
//   (priceNow - windowOpen) - (pricePrior - windowOpen)
// = priceNow - pricePrior.
//
// The trend toggle is a regime filter, not a third direction source:
//   100 * (current Binance spot - spot N seconds earlier) / prior spot.
// A normal/range or trend-following fast signal is unchanged. When a Binance
// signal opposes a strong trailing trend, both its fast move and a sustained
// countertrend move must clear the configured countertrend percentage.
//
// H_BINANCE_GAP_AGREE_ON is the poly-mom-bot agreement rule. When enabled,
// the selected velocity direction must also match Binance spot versus the
// current five-minute window open. This is independent of whether Binance
// velocity itself is enabled as a signal source.
//
// A qualified impulse emits once and re-arms only across the exit band, on an
// opposite direction, or after a material same-side top-up step. A signal
// aligned with flat/current inventory is an entry. An opposing signal can be
// handled in two independently-toggleable ways:
//   - partial hedge: reduce the imbalance without worsening worst-case loss;
//   - reversal: after persistent CLOB + Binance + trend confirmation, buy
//     through balance only when pair economics and projected risk allow it.
// Repeated feed heartbeats with identical signal inputs are de-duplicated.

import { midOf } from "../momentum.js";
import { fillFee } from "../fees.js";
import { targetWalletRoleShares } from "./fastmx-target-sizing.js";
import {
  evaluateDirectionScore,
  evaluateRelease,
  markReleaseFired,
  observeReleaseBand,
} from "./fastmx-signal-policy.js";

export const NAME = "helpme";
export const LABEL = "FastMX · scored direction + role-aware inventory";

export const STRAT = {
  STRATEGY: NAME,
  SIZE: 7,
  LIMIT: 0.98,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  LIVE_FILLS: false,
  FEE_BPS: 700,
  FEE_USE_MIN: false,
  FEE_ALL_FILLS: false,

  H_ON: true,
  H_START_S: 0,
  H_STOP_S: 285,
  H_CLOB_MID_VELOCITY_ON: true,
  H_MID_VELOCITY_LOOKBACK_MS: 3000,
  H_MID_VELOCITY_MIN: 0.02,
  H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 3000,
  H_BINANCE_GAP_VELOCITY_MIN: 5,
  H_BINANCE_TREND_ON: true,
  H_BINANCE_TREND_LOOKBACK_SEC: 30,
  H_BINANCE_TREND_MIN_PCT: 0.05,
  H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60,
  H_BINANCE_COUNTERTREND_MIN_PCT: 0.075,
  H_BINANCE_GAP_AGREE_ON: false,
  // Target-derived direction selector. The public evidence supports a
  // five-second weighted CLOB-level/CLOB-impulse/Binance-impulse score, with
  // an abstention band, more strongly than the old strict dual threshold.
  H_TARGET_DIRECTION_ON: true,
  H_DIRECTION_LOOKBACK_MS: 5000,
  H_DIRECTION_LEVEL_SCALE: 0.05,
  H_DIRECTION_CLOB_SCALE: 0.05,
  H_DIRECTION_BINANCE_SCALE: 10,
  H_DIRECTION_LEVEL_WEIGHT: 0.2,
  H_DIRECTION_CLOB_WEIGHT: 0.3,
  H_DIRECTION_BINANCE_WEIGHT: 0.5,
  H_DIRECTION_ENTER_SCORE: 0.35,
  H_DIRECTION_EXIT_SCORE: 0.15,
  // One release per impulse. Same-side adds need either a reset below the exit
  // band or a material score/price step after their own cooldown.
  H_SIGNAL_HYSTERESIS_ON: true,
  H_FIRST_ENTRY_EARLIEST_S: 15,
  H_FIRST_ENTRY_CONFIRM_MS: 360,
  H_TOPUP_CONFIRM_MS: 360,
  H_TOPUP_COOLDOWN_MS: 8000,
  H_TOPUP_SCORE_STEP: 0.2,
  H_TOPUP_PRICE_STEP: 0.05,
  H_HEDGE_CONFIRM_MS: 600,
  H_HEDGE_COOLDOWN_MS: 6000,
  H_HEDGE_SCORE_MIN: 0.6,
  H_HEDGE_MIN_PAIR_EDGE: -0.03,
  H_REVERSAL_SCORE_MIN: 0.95,
  H_REVERSAL_COOLDOWN_MS: 3000,
  H_HEDGE_RETAIN_MAX_SH: 8,
  H_MAX_ACTIONS_PER_WINDOW: 7,
  // Adaptive inventory control: an opposing qualified signal may immediately
  // reduce the old-side lead, but it cannot cross inventory without the stricter
  // persistent reversal confirmation below.
  H_HEDGE_ON: true,
  // Share-denominated hedges preserve this old-side lead even when execution
  // receives price improvement.
  H_HEDGE_RETAIN_SH: 1,
  H_REVERSAL_ON: true,
  H_REVERSAL_RESIDUAL_SH: 4,
  H_REVERSAL_CONFIRM_MS: 1000,
  H_OPPOSITE_CANDIDATE_RESET_MS: 3000,
  H_REVERSAL_MIN_PAIR_EDGE: -0.1,
  H_REVERSAL_MAX_WORST_LOSS_USD: 10,
  H_REVERSAL_MAX_ORDER_SH: 50,
  H_MIN_ASK: 0.05,
  H_MAX_ASK: 0.98,
  H_CAP_HEADROOM: 0.01,
  H_LIVE_ORDER_TYPE: "GTC",
  H_MIN_DEPTH_SH: 4,
  H_BASE_ORDER_SH: 7,
  H_MIN_ORDER_SH: 4,
  // Preserve 7 shares as the capital anchor, but reshape each qualifying BUY
  // using the target wallet's signed cap→integer-share menu.
  H_TARGET_SIZE_ON: false,
  H_TARGET_SIZE_SCALE: 1,
  H_TARGET_SIZE_MAX_SH: 50,
  H_TARGET_TOPUP_MIN_SCALE: 0.65,
  // Keep the independently-gated reversal residual unchanged unless this is
  // explicitly enabled after a paired replay.
  H_TARGET_REVERSAL_SIZE_ON: false,
  H_COOLDOWN_MS: 1000,
  MAX_SESSION_LOSS: 25,
};

const EPS = 1e-9;
const finite = (v) => (v == null || v === "") ? null : (Number.isFinite(+v) ? +v : null);
const round4 = (v) => { const n = finite(v); return n == null ? null : Math.round(n * 1e4) / 1e4; };
const enabled = (v, fallback = true) => {
  if (v == null || v === "") return fallback;
  return !(v === false || v === 0 || v === "0" || String(v).toLowerCase() === "false");
};

export function signalToggles(P = STRAT) {
  return {
    clobMid: enabled(P.H_CLOB_MID_VELOCITY_ON),
    binanceGap: enabled(P.H_BINANCE_GAP_MOMENTUM_ON),
    binanceTrend: enabled(P.H_BINANCE_TREND_ON),
  };
}

export function validateParams(P = STRAT) {
  const merged = { ...STRAT, ...(P || {}) };
  const toggles = signalToggles(merged);
  if (!toggles.clobMid && !toggles.binanceGap) {
    throw new RangeError("at least one FastMX fast-momentum toggle must be enabled");
  }
  if (toggles.binanceTrend && !toggles.binanceGap) {
    throw new RangeError("the poly-mom Binance trend regime requires Binance gap momentum");
  }
  if (enabled(merged.H_TARGET_DIRECTION_ON, true)) {
    const enter = finite(merged.H_DIRECTION_ENTER_SCORE);
    const exit = finite(merged.H_DIRECTION_EXIT_SCORE);
    const weights = [toggles.clobMid ? finite(merged.H_DIRECTION_LEVEL_WEIGHT) : 0,
      toggles.clobMid ? finite(merged.H_DIRECTION_CLOB_WEIGHT) : 0,
      toggles.binanceGap ? finite(merged.H_DIRECTION_BINANCE_WEIGHT) : 0];
    if (!(finite(merged.H_DIRECTION_LOOKBACK_MS) >= 1000)) {
      throw new RangeError("target direction lookback must be at least 1000 ms");
    }
    if (!(enter > 0 && enter <= 1) || !(exit >= 0 && exit < enter)) {
      throw new RangeError("target direction scores require 0 <= exit < enter <= 1");
    }
    if (!weights.some((weight) => weight > 0)) {
      throw new RangeError("target direction requires a positive enabled component weight");
    }
    if (toggles.clobMid && (!(finite(merged.H_DIRECTION_LEVEL_SCALE) > 0)
        || !(finite(merged.H_DIRECTION_CLOB_SCALE) > 0))
        || toggles.binanceGap && !(finite(merged.H_DIRECTION_BINANCE_SCALE) > 0)) {
      throw new RangeError("target direction component scales must be positive");
    }
    if (!(finite(merged.H_MAX_ACTIONS_PER_WINDOW) >= 1)) {
      throw new RangeError("target direction action cap must be at least one");
    }
  }
  if (enabled(merged.H_TARGET_SIZE_ON, false)
      && (!(finite(merged.H_TARGET_SIZE_SCALE) > 0)
        || !(finite(merged.H_TARGET_SIZE_MAX_SH) >= finite(merged.H_MIN_ORDER_SH)))) {
    throw new RangeError("target sizing requires positive scale and max shares >= minimum order");
  }
  return true;
}

function levels(rows, ascending) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const p = finite(Array.isArray(row) ? row[0] : row?.price);
    const s = finite(Array.isArray(row) ? row[1] : row?.size);
    if (p != null && s != null && p > 0 && p < 1 && s > 0) out.push([p, s]);
  }
  return out.sort((a, b) => ascending ? a[0] - b[0] : b[0] - a[0]);
}

function cappedDepth(asks, cap) {
  let shares = 0;
  for (const [px, size] of asks) {
    if (px > cap + EPS) break;
    shares += size;
  }
  return shares;
}

function ceilCent(px) {
  return Math.ceil((px - EPS) * 100) / 100;
}

function executionQuote(book, P) {
  const asks = levels(book?.asks, true);
  const ask = finite(book?.bestAsk) ?? asks[0]?.[0] ?? null;
  const limit = Math.min(+P.LIMIT || 0.99, +P.H_MAX_ASK || 0.99);
  const cap = ask == null ? null
    : Math.min(limit, ceilCent(ask + Math.max(0, +P.H_CAP_HEADROOM || 0)));
  return { ask, cap, available: cap == null ? 0 : cappedDepth(asks, cap) };
}

function effectivePosition(state, P) {
  let up = +state.upShares || 0;
  let down = +state.downShares || 0;
  let upCost = +state.upCost || 0;
  let downCost = +state.downCost || 0;
  let fee = +state.fee || 0;
  for (const pending of (state.pendingFills || [])) {
    const rec = pending?.rec;
    if (!rec) continue;
    const shares = finite(rec.minimumShares) ?? (+rec.shares || 0);
    const cap = finite(rec.limitPx) ?? finite(rec.effPx) ?? 0;
    const cost = finite(rec.budgetUsd) ?? cap * shares;
    if (rec.side === "Up") { up += shares; upCost += cost; }
    else if (rec.side === "Down") { down += shares; downCost += cost; }
    fee += fillFee(cap, shares, true, P);
  }
  const cost = upCost + downCost;
  const ifUp = up - cost - fee;
  const ifDown = down - cost - fee;
  return { up, down, net: up - down, gross: up + down, upCost, downCost,
    cost, fee, ifUp, ifDown, worstLoss: Math.max(0, -Math.min(ifUp, ifDown)) };
}

function projectedPosition(position, side, shares, cap, P) {
  const cost = cap * shares;
  const fee = fillFee(cap, shares, true, P);
  const up = position.up + (side === "Up" ? shares : 0);
  const down = position.down + (side === "Down" ? shares : 0);
  const totalCost = position.cost + cost;
  const totalFee = position.fee + fee;
  const ifUp = up - totalCost - totalFee;
  const ifDown = down - totalCost - totalFee;
  return { up, down, net: up - down, gross: up + down,
    cost: totalCost, fee: totalFee, ifUp, ifDown,
    worstLoss: Math.max(0, -Math.min(ifUp, ifDown)) };
}

function pruneHistory(model, key, headKey, keepAfter) {
  const history = model[key];
  let head = model[headKey] || 0;
  while (head + 1 < history.length - 1 && history[head + 1].ms < keepAfter) head++;
  if (head > 4096 && head > history.length / 2) {
    history.splice(0, head); head = 0;
  }
  model[headKey] = head;
}

function pushHistory(model, tk, clockMs, midKeepMs, binanceKeepMs) {
  const midpoint = finite(midOf(tk.up));
  const previousMid = model.history.at(-1);
  if (midpoint != null && (!previousMid || previousMid.midpoint !== midpoint)) {
    model.history.push({ ms: clockMs, midpoint });
  }

  const binancePrice = finite(tk.bzPrice);
  const feedAtMs = finite(tk.binanceAtMs);
  const observedAtMs = feedAtMs ?? clockMs;
  const previousBinance = model.binanceHistory.at(-1);
  // Live supplies the Binance receive timestamp, so repeated CLOB evaluations
  // cannot manufacture extra Binance observations. Historical snapshots lack
  // that timestamp and are therefore collapsed by price transition.
  const isNewBinanceFrame = feedAtMs != null
    ? (!previousBinance || observedAtMs > previousBinance.ms)
    : (!previousBinance || previousBinance.binancePrice !== binancePrice);
  if (binancePrice != null && isNewBinanceFrame) {
    model.binanceHistory.push({ ms: observedAtMs, binancePrice });
  }

  pruneHistory(model, "history", "historyHead",
    clockMs - Math.max(20000, midKeepMs * 3));
  pruneHistory(model, "binanceHistory", "binanceHistoryHead",
    observedAtMs - Math.max(20000, binanceKeepMs + 5000));
}

function priorAt(history, targetMs, start = 0) {
  let lo = Math.max(0, start), hi = history.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].ms <= targetMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 ? history[found] : null;
}

function priorAtFresh(history, targetMs, start = 0, maxLagMs = Infinity) {
  const prior = priorAt(history, targetMs, start);
  if (!prior) return null;
  const lagMs = targetMs - prior.ms;
  return lagMs >= 0 && lagMs <= maxLagMs ? prior : null;
}

function velocity(model, tk, clockMs, midLookbackMs, binanceLookbackMs,
  trendLookbackMs, countertrendLookbackMs) {
  const midPrior = priorAt(model.history, clockMs - midLookbackMs, model.historyHead || 0);
  const binanceAtMs = finite(tk.binanceAtMs) ?? clockMs;
  const binancePrior = priorAt(model.binanceHistory, binanceAtMs - binanceLookbackMs,
    model.binanceHistoryHead || 0);
  const countertrendPrior = priorAtFresh(model.binanceHistory,
    binanceAtMs - countertrendLookbackMs, model.binanceHistoryHead || 0, 5000);
  const trendPrior = priorAtFresh(model.binanceHistory,
    binanceAtMs - trendLookbackMs, model.binanceHistoryHead || 0, 5000);
  const midpoint = finite(midOf(tk.up)), binancePrice = finite(tk.bzPrice);
  const midVelocity = midpoint != null && midPrior?.midpoint != null
    ? midpoint - midPrior.midpoint : null;
  const binanceGapVelocity = binancePrice != null && binancePrior?.binancePrice != null
    ? binancePrice - binancePrior.binancePrice : null;
  const binanceFastMomentumPct = binancePrice != null && binancePrior?.binancePrice > 0
    ? (binancePrice - binancePrior.binancePrice) / binancePrior.binancePrice * 100 : null;
  const binanceCountertrendMomentumPct = binancePrice != null && countertrendPrior?.binancePrice > 0
    ? (binancePrice - countertrendPrior.binancePrice) / countertrendPrior.binancePrice * 100 : null;
  return { midpoint, priorMidpoint: midPrior?.midpoint ?? null, midVelocity,
    binancePrice, priorBinancePrice: binancePrior?.binancePrice ?? null,
    binanceGapVelocity, midPriorMs: midPrior?.ms ?? null,
    binancePriorMs: binancePrior?.ms ?? null, binanceFastMomentumPct,
    binanceCountertrendPriorPrice: countertrendPrior?.binancePrice ?? null,
    binanceCountertrendPriorMs: countertrendPrior?.ms ?? null,
    binanceCountertrendMomentumPct,
    binanceTrendPriorPrice: trendPrior?.binancePrice ?? null,
    binanceTrendPriorMs: trendPrior?.ms ?? null };
}

const directionOf = (value) => Number(value) >= 0 ? "Up" : "Down";

// Momentum-regime evaluator. Only trend/countertrend confirmation is used;
// FastMX does not import dynamic clocks, price-cap, hedge, or reversal modules.
export function evaluateBinanceTrendRegime({
  enabled: regimeEnabled = false,
  currentWindowOpen,
  trendReferenceOpen,
  trendThresholdPct = 0.05,
  fastMomentumPct,
  fastThresholdPct = 0,
  countertrendMomentumPct,
  countertrendThresholdPct = 0.075,
} = {}) {
  // Number(null) is 0, which previously made missing momentum appear to be an
  // Up/flat observation in diagnostics. Preserve missing data as null so the
  // regime can never manufacture a direction from an absent feed value.
  const fast = finite(fastMomentumPct);
  const fastThreshold = finite(fastThresholdPct) ?? 0;
  const currentOpen = finite(currentWindowOpen);
  const referenceOpen = finite(trendReferenceOpen);
  const trendThreshold = finite(trendThresholdPct) ?? 0.05;
  const counterMomentum = finite(countertrendMomentumPct);
  const counterThreshold = finite(countertrendThresholdPct) ?? 0.075;
  const fastDirection = Number.isFinite(fast) ? directionOf(fast) : null;
  const trendAvailable = currentOpen > 0 && referenceOpen > 0;
  const trendPct = trendAvailable ? (currentOpen - referenceOpen) / referenceOpen * 100 : null;
  const strongTrend = regimeEnabled === true
    && Number.isFinite(trendPct)
    && Math.abs(trendPct) >= trendThreshold;
  const trendDirection = strongTrend ? directionOf(trendPct) : null;
  const countertrend = strongTrend && fastDirection !== null && fastDirection !== trendDirection;
  const useCountertrendConfirmation = countertrend;
  const countertrendConfirmed = !useCountertrendConfirmation || (
    Number.isFinite(fast)
    && Math.abs(fast) >= counterThreshold
    && Number.isFinite(counterMomentum)
    && Math.abs(counterMomentum) >= counterThreshold
    && directionOf(counterMomentum) === fastDirection
  );
  const effectiveMomentumPct = useCountertrendConfirmation ? counterMomentum : fast;
  const effectiveThresholdPct = useCountertrendConfirmation ? counterThreshold : fastThreshold;

  return {
    enabled: regimeEnabled === true,
    trendAvailable,
    trendPct,
    trendThresholdPct: trendThreshold,
    strongTrend,
    trendDirection,
    fastDirection,
    fastMomentumPct: Number.isFinite(fast) ? fast : null,
    countertrendMomentumPct: Number.isFinite(counterMomentum) ? counterMomentum : null,
    countertrend,
    useCountertrendConfirmation,
    countertrendConfirmed,
    effectiveMomentumPct: Number.isFinite(effectiveMomentumPct) ? effectiveMomentumPct : null,
    effectiveThresholdPct,
    passes: countertrendConfirmed,
  };
}

function setStatus(state, values) {
  state.helpmeStatus = { ...(state.helpmeStatus || {}), ...values };
  state.gateReason = values.gate;
}

function resetSignal(state, model, values) {
  model.lastSignalKey = null;
  setStatus(state, values);
  return [];
}

function signalEventKey(signal, side, toggles, oppositePhase = null) {
  return JSON.stringify([
    side,
    oppositePhase,
    toggles.clobMid ? signal.midpoint : null,
    toggles.clobMid ? signal.midPriorMs : null,
    toggles.binanceGap ? signal.binancePrice : null,
    toggles.binanceGap ? signal.binancePriorMs : null,
    toggles.binanceTrend ? signal.binancePrice : null,
    toggles.binanceTrend ? signal.binanceCountertrendPriorMs : null,
    toggles.binanceTrend ? signal.binanceTrendReferenceMs : null,
  ]);
}

function makeOrder(state, model, tk, clockMs, {
  side, minimumShares, ask, cap, reason, signal, quote, liveOrderType,
  leg = "entry", role = leg, amountMode = "usd",
}) {
  const oid = state.seq = (+state.seq || 0) + 1;
  const fixedUsd = amountMode === "usd";
  const budgetUsd = fixedUsd ? round4(cap * minimumShares) : null;
  // Immediate BUYs are fixed-USDC on the venue and can receive more shares at
  // a better price. Inventory-control orders therefore force exact-share GTC
  // transport (the router cancels any remainder immediately).
  liveOrderType = !fixedUsd ? "GTC"
    : (String(liveOrderType || "GTC").toUpperCase() === "FAK" ? "FAK" : "GTC");
  const rec = {
    tInto: tk.t,
    side,
    shares: round4(minimumShares),
    minimumShares: round4(minimumShares),
    budgetUsd,
    amountMode: fixedUsd ? "usd" : "shares",
    effPx: round4(ask),
    usdc: fixedUsd ? budgetUsd : round4(ask * minimumShares),
    exec: "marketable",
    limitPx: round4(cap),
    kind: "taker",
    leg,
    role,
    reason,
    status: "full",
    postOnly: false,
    orderType: "FAK",
    liveOrderType,
    oid,
    signal: {
      clobMidVelocityOn: signal.clobMidVelocityOn,
      binanceGapMomentumOn: signal.binanceGapMomentumOn,
      binanceTrendOn: signal.binanceTrendOn,
      binanceGapAgreeOn: signal.binanceGapAgreeOn,
      hedgeOn: signal.hedgeOn,
      reversalOn: signal.reversalOn,
      midpoint: round4(signal.midpoint),
      priorMidpoint: round4(signal.priorMidpoint),
      midVelocity: round4(signal.midVelocity),
      binancePrice: round4(signal.binancePrice),
      priorBinancePrice: round4(signal.priorBinancePrice),
      binanceGapVelocity: round4(signal.binanceGapVelocity),
      binanceWindowOpen: round4(signal.binanceWindowOpen),
      binanceWindowGap: round4(signal.binanceWindowGap),
      binanceWindowGapDir: signal.binanceWindowGapDir,
      binanceTrendReferencePrice: round4(signal.binanceTrendReferencePrice),
      binanceTrendReferenceMs: signal.binanceTrendReferenceMs,
      binanceTrendPct: round4(signal.binanceTrendPct),
      binanceTrendDir: signal.binanceTrendDir,
      binanceTrendLookbackSec: signal.binanceTrendLookbackSec,
      binanceTrendMinPct: round4(signal.binanceTrendMinPct),
      binanceTrendAvailable: signal.binanceTrendAvailable,
      binanceStrongTrend: signal.binanceStrongTrend,
      binanceCountertrend: signal.binanceCountertrend,
      binanceCountertrendConfirmed: signal.binanceCountertrendConfirmed,
      binanceFastMomentumPct: round4(signal.binanceFastMomentumPct),
      binanceFastThresholdPct: round4(signal.binanceFastThresholdPct),
      binanceCountertrendPriorPrice: round4(signal.binanceCountertrendPriorPrice),
      binanceCountertrendPriorMs: signal.binanceCountertrendPriorMs,
      binanceCountertrendMomentumPct: round4(signal.binanceCountertrendMomentumPct),
      binanceCountertrendLookbackSec: signal.binanceCountertrendLookbackSec,
      binanceCountertrendMinPct: round4(signal.binanceCountertrendMinPct),
      midLookbackMs: signal.midLookbackMs,
      binanceLookbackMs: signal.binanceLookbackMs,
      velocityMin: round4(signal.velocityMin),
      binanceGapVelocityMin: round4(signal.binanceGapVelocityMin),
      targetDirectionOn: signal.targetDirectionOn,
      directionScore: round4(signal.directionScore),
      directionConfidence: round4(signal.directionConfidence),
      directionRawSide: signal.directionRawSide,
      directionEnterScore: round4(signal.directionEnterScore),
      directionExitScore: round4(signal.directionExitScore),
      directionComponents: signal.directionComponents,
      capDepth: round4(quote.available),
    },
  };
  model.lastOrderMs = clockMs;
  model.orderCount++;
  state.orders = state.orders || [];
  state.orders.push({ oid, side, limit: cap, kind: leg, budgetUsd, filledUsd: 0, placedT: tk.t });
  state.placedThisTick = [{ oid, side, shares: rec.shares, minimumShares: rec.minimumShares,
    budgetUsd, limitPx: cap, leg, role, reason }];
  return rec;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = tk.t * 1000) {
  state.placedThisTick = [];
  const model = state.helpme || (state.helpme = { history: [], historyHead: 0,
    binanceHistory: [], binanceHistoryHead: 0,
    lastSignalKey: null, lastOrderMs: -Infinity, orderCount: 0 });
  model.history ||= [];
  model.historyHead ||= 0;
  model.binanceHistory ||= [];
  model.binanceHistoryHead ||= 0;
  if (!Number.isFinite(model.lastOrderMs)) model.lastOrderMs = -Infinity;
  model.orderCount ||= 0;

  const targetDirectionOn = enabled(P.H_TARGET_DIRECTION_ON, true);
  const signalHysteresisOn = targetDirectionOn && enabled(P.H_SIGNAL_HYSTERESIS_ON, true);
  const targetLookbackMs = Math.max(1000, finite(P.H_DIRECTION_LOOKBACK_MS) ?? 5000);
  const midLookbackMs = targetDirectionOn ? targetLookbackMs
    : Math.max(1000, +P.H_MID_VELOCITY_LOOKBACK_MS || 3000);
  const binanceLookbackMs = targetDirectionOn ? targetLookbackMs
    : Math.max(1000, +P.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS || 3000);
  const binanceCountertrendLookbackSec = Math.max(1, Math.min(60,
    finite(P.H_BINANCE_COUNTERTREND_LOOKBACK_SEC) ?? 60));
  const binanceTrendLookbackSec = Math.max(1, Math.min(300,
    Math.round(finite(P.H_BINANCE_TREND_LOOKBACK_SEC) ?? 30)));
  const trendLookbackMs = binanceTrendLookbackSec * 1000;
  const countertrendLookbackMs = binanceCountertrendLookbackSec * 1000;
  pushHistory(model, tk, clockMs, midLookbackMs,
    Math.max(binanceLookbackMs, trendLookbackMs, countertrendLookbackMs));
  const momentum = velocity(model, tk, clockMs, midLookbackMs,
    binanceLookbackMs, trendLookbackMs, countertrendLookbackMs);

  const velocityMin = Math.max(EPS, +P.H_MID_VELOCITY_MIN || 0);
  const midVelocity = momentum.midVelocity;
  const velocityDir = midVelocity == null || Math.abs(midVelocity) + EPS < velocityMin
    ? null : (midVelocity > 0 ? "Up" : "Down");
  const binanceGapVelocityMin = Math.max(EPS, finite(P.H_BINANCE_GAP_VELOCITY_MIN) ?? 5);
  const binanceGapVelocity = momentum.binanceGapVelocity;
  const binanceDir = binanceGapVelocity == null
    || Math.abs(binanceGapVelocity) + EPS < binanceGapVelocityMin
    ? null : (binanceGapVelocity > 0 ? "Up" : "Down");
  const toggles = signalToggles(P);
  const binanceGapAgreeOn = enabled(P.H_BINANCE_GAP_AGREE_ON);
  const hedgeOn = enabled(P.H_HEDGE_ON, false);
  const reversalOn = enabled(P.H_REVERSAL_ON, false);
  const binanceWindowOpen = finite(tk.openBinance);
  const binanceWindowGap = finite(tk.bzGap) ?? (
    momentum.binancePrice != null && binanceWindowOpen != null
      ? momentum.binancePrice - binanceWindowOpen : null);
  // Match poly-mom-bot exactly: a price equal to the open is the Up gap side.
  const binanceWindowGapDir = binanceWindowGap == null ? null
    : (binanceWindowGap >= 0 ? "Up" : "Down");
  const binanceTrendMinPct = Math.max(0.001, finite(P.H_BINANCE_TREND_MIN_PCT) ?? 0.05);
  const binanceCountertrendMinPct = Math.max(0.001,
    finite(P.H_BINANCE_COUNTERTREND_MIN_PCT) ?? 0.075);
  const binanceFastThresholdPct = momentum.priorBinancePrice > 0
    ? binanceGapVelocityMin / momentum.priorBinancePrice * 100 : null;
  const binanceTrendReferencePrice = momentum.binanceTrendPriorPrice;
  const trendRegime = evaluateBinanceTrendRegime({
    enabled: toggles.binanceTrend,
    currentWindowOpen: momentum.binancePrice,
    trendReferenceOpen: binanceTrendReferencePrice,
    trendThresholdPct: binanceTrendMinPct,
    fastMomentumPct: momentum.binanceFastMomentumPct,
    fastThresholdPct: binanceFastThresholdPct ?? 0,
    countertrendMomentumPct: momentum.binanceCountertrendMomentumPct,
    countertrendThresholdPct: binanceCountertrendMinPct,
  });
  const binanceTrendPct = trendRegime.trendPct;
  const binanceTrendDir = trendRegime.trendDirection;
  const targetDirection = evaluateDirectionScore({
    midpoint: momentum.midpoint,
    midVelocity,
    binanceVelocity: binanceGapVelocity,
    clobLevelOn: toggles.clobMid,
    clobVelocityOn: toggles.clobMid,
    binanceVelocityOn: toggles.binanceGap,
    levelScale: P.H_DIRECTION_LEVEL_SCALE,
    clobScale: P.H_DIRECTION_CLOB_SCALE,
    binanceScale: P.H_DIRECTION_BINANCE_SCALE,
    levelWeight: P.H_DIRECTION_LEVEL_WEIGHT,
    clobWeight: P.H_DIRECTION_CLOB_WEIGHT,
    binanceWeight: P.H_DIRECTION_BINANCE_WEIGHT,
    enterScore: P.H_DIRECTION_ENTER_SCORE,
    exitScore: P.H_DIRECTION_EXIT_SCORE,
  });
  const signal = {
    clobMidVelocityOn: toggles.clobMid,
    binanceGapMomentumOn: toggles.binanceGap,
    binanceTrendOn: toggles.binanceTrend,
    binanceGapAgreeOn,
    hedgeOn,
    reversalOn,
    midpoint: momentum.midpoint,
    priorMidpoint: momentum.priorMidpoint,
    midVelocity,
    midPriorMs: momentum.midPriorMs,
    binancePrice: momentum.binancePrice,
    priorBinancePrice: momentum.priorBinancePrice,
    binanceGapVelocity,
    binancePriorMs: momentum.binancePriorMs,
    binanceWindowOpen,
    binanceWindowGap,
    binanceWindowGapDir,
    binanceTrendReferencePrice,
    binanceTrendReferenceMs: momentum.binanceTrendPriorMs,
    binanceTrendPct,
    binanceTrendDir,
    binanceTrendLookbackSec,
    binanceTrendMinPct,
    binanceTrendAvailable: trendRegime.trendAvailable,
    binanceStrongTrend: trendRegime.strongTrend,
    binanceCountertrend: trendRegime.countertrend,
    binanceCountertrendConfirmed: trendRegime.countertrendConfirmed,
    binanceFastMomentumPct: momentum.binanceFastMomentumPct,
    binanceFastThresholdPct,
    binanceCountertrendPriorPrice: momentum.binanceCountertrendPriorPrice,
    binanceCountertrendPriorMs: momentum.binanceCountertrendPriorMs,
    binanceCountertrendMomentumPct: momentum.binanceCountertrendMomentumPct,
    binanceCountertrendLookbackSec,
    binanceCountertrendMinPct,
    midLookbackMs,
    binanceLookbackMs,
    velocityMin,
    binanceGapVelocityMin,
    targetDirectionOn,
    directionScore: targetDirection.score,
    directionConfidence: targetDirection.confidence,
    directionRawSide: targetDirection.rawSide,
    directionEnterScore: targetDirection.enterScore,
    directionExitScore: targetDirection.exitScore,
    directionComponents: targetDirection.components,
  };
  const inv = effectivePosition(state, P);
  const baseStatus = {
    t: tk.t,
    midpoint: momentum.midpoint ?? finite(midOf(tk.up)),
    clobMidVelocityOn: toggles.clobMid,
    binanceGapMomentumOn: toggles.binanceGap,
    binanceTrendOn: toggles.binanceTrend,
    binanceGapAgreeOn,
    hedgeOn,
    reversalOn,
    midVelocity,
    velocityDir,
    binanceGapVelocity,
    binanceDir,
    binanceWindowOpen,
    binanceWindowGap,
    binanceWindowGapDir,
    binanceTrendReferencePrice,
    binanceTrendReferenceMs: momentum.binanceTrendPriorMs,
    binanceTrendPct,
    binanceTrendDir,
    binanceTrendLookbackSec,
    binanceTrendMinPct,
    binanceTrendAvailable: trendRegime.trendAvailable,
    binanceStrongTrend: trendRegime.strongTrend,
    binanceCountertrend: trendRegime.countertrend,
    binanceCountertrendConfirmed: trendRegime.countertrendConfirmed,
    binanceFastMomentumPct: momentum.binanceFastMomentumPct,
    binanceFastThresholdPct,
    binanceCountertrendPriorPrice: momentum.binanceCountertrendPriorPrice,
    binanceCountertrendPriorMs: momentum.binanceCountertrendPriorMs,
    binanceCountertrendMomentumPct: momentum.binanceCountertrendMomentumPct,
    binanceCountertrendLookbackSec,
    binanceCountertrendMinPct,
    midLookbackMs,
    binanceLookbackMs,
    velocityMin,
    binanceGapVelocityMin,
    targetDirectionOn,
    signalHysteresisOn,
    directionScore: targetDirection.score,
    directionConfidence: targetDirection.confidence,
    directionRawSide: targetDirection.rawSide,
    directionEnterScore: targetDirection.enterScore,
    directionExitScore: targetDirection.exitScore,
    directionComponents: targetDirection.components,
    upShares: inv.up,
    downShares: inv.down,
    net: inv.net,
    orders: model.orderCount,
    oppositeCandidateSide: model.oppositeCandidateSide || null,
    oppositeCandidateSinceMs: model.oppositeCandidateSinceMs ?? null,
  };

  if (P.H_ON === false) return resetSignal(state, model, { ...baseStatus, gate: "disabled" });
  if (tk.t < (+P.H_START_S || 0)) return resetSignal(state, model, { ...baseStatus, gate: "wait-open" });
  if (tk.t > (+P.H_STOP_S || P.WINDOW_SEC || 300)) return resetSignal(state, model, { ...baseStatus, gate: "end-cutoff" });
  if (!toggles.clobMid && !toggles.binanceGap) {
    return resetSignal(state, model, { ...baseStatus, gate: "signal-toggle-required" });
  }
  if (toggles.binanceTrend && !toggles.binanceGap) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-trend-needs-binance-momentum" });
  }
  if (toggles.clobMid && midVelocity == null) {
    if (signalHysteresisOn) observeReleaseBand(model, targetDirection);
    return resetSignal(state, model, { ...baseStatus, gate: "clob-mid-warmup" });
  }
  if (toggles.binanceGap && binanceGapVelocity == null) {
    if (signalHysteresisOn) observeReleaseBand(model, targetDirection);
    return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-warmup" });
  }
  let side = null;
  if (targetDirectionOn) {
    observeReleaseBand(model, targetDirection);
    if (!targetDirection.qualified || !targetDirection.side) {
      return resetSignal(state, model, { ...baseStatus,
        gate: targetDirection.released ? "direction-score-rearmed" : "direction-score" });
    }
    side = targetDirection.side;
  } else {
    if (toggles.clobMid && !velocityDir) {
      return resetSignal(state, model, { ...baseStatus, gate: "clob-mid-velocity" });
    }
    if (toggles.binanceGap && !binanceDir) {
      return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-velocity" });
    }
    const enabledDirections = [toggles.clobMid ? velocityDir : null,
      toggles.binanceGap ? binanceDir : null].filter(Boolean);
    side = enabledDirections[0];
    if (!enabledDirections.every((direction) => direction === side)) {
      return resetSignal(state, model, { ...baseStatus, gate: "momentum-disagreement" });
    }
  }
  // poly-mom semantics: unavailable or weak trend history leaves the fast
  // signal unchanged. Only an opposing signal in a strong trend is gated.
  if (toggles.binanceTrend && !trendRegime.passes) {
    const gate = momentum.binanceCountertrendMomentumPct == null
      ? "binance-countertrend-warmup" : "binance-countertrend-confirmation";
    return resetSignal(state, model, { ...baseStatus, gate, side });
  }
  if (binanceGapAgreeOn && binanceWindowGapDir == null) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-agree-warmup", side });
  }
  if (binanceGapAgreeOn && binanceWindowGapDir !== side) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-disagreement", side });
  }

  const orientedNet = side === "Up" ? inv.net : -inv.net;
  const oppositeSignal = orientedNet < -EPS;
  const oldImbalance = oppositeSignal ? Math.abs(orientedNet) : 0;
  const candidateResetMs = Math.max(0,
    finite(P.H_OPPOSITE_CANDIDATE_RESET_MS) ?? 3000);
  // Candidate state advances before cooldown/de-duplication: persistence is a
  // property of qualified market observations, not of how often orders release.
  if (oppositeSignal) {
    if (model.oppositeCandidateSide !== side) {
      model.oppositeCandidateSide = side;
      model.oppositeCandidateSinceMs = clockMs;
    }
    model.oppositeCandidateLastSeenMs = clockMs;
  } else if (model.oppositeCandidateSide) {
    const candidateAgeMs = clockMs
      - (finite(model.oppositeCandidateLastSeenMs) ?? -Infinity);
    if (side !== model.oppositeCandidateSide && candidateAgeMs < candidateResetMs) {
      setStatus(state, { ...baseStatus, gate: "opposite-candidate-pending", side,
        oppositeCandidateSide: model.oppositeCandidateSide,
        oppositeCandidateAgeMs: candidateAgeMs,
        oppositeCandidateResetMs: candidateResetMs });
      return [];
    }
    model.oppositeCandidateSide = null;
    model.oppositeCandidateSinceMs = null;
    model.oppositeCandidateLastSeenMs = null;
  }
  baseStatus.oppositeCandidateSide = model.oppositeCandidateSide || null;
  baseStatus.oppositeCandidateSinceMs = model.oppositeCandidateSinceMs ?? null;
  baseStatus.oppositeCandidateAgeMs = model.oppositeCandidateSide
    ? Math.max(0, clockMs - (finite(model.oppositeCandidateSinceMs) ?? clockMs)) : null;
  const reversalConfirmMs = Math.max(0,
    finite(P.H_REVERSAL_CONFIRM_MS) ?? 1000);
  const reversalConfirmedMs = oppositeSignal
    && model.oppositeCandidateSide === side
    && Number.isFinite(model.oppositeCandidateSinceMs)
    ? Math.max(0, clockMs - model.oppositeCandidateSinceMs) : 0;
  const oppositePhase = oppositeSignal
    ? (reversalConfirmedMs + EPS >= reversalConfirmMs ? "confirmed" : "pending")
    : null;

  const firstEntry = model.orderCount === 0 && inv.gross <= EPS;
  const reversalScoreMin = Math.max(targetDirection.enterScore,
    finite(P.H_REVERSAL_SCORE_MIN) ?? 0.95);
  const strongOpposite = oppositeSignal && targetDirectionOn
    && targetDirection.confidence + EPS >= reversalScoreMin;
  const hedgeScoreMin = Math.max(targetDirection.enterScore,
    finite(P.H_HEDGE_SCORE_MIN) ?? 0.6);
  const qualifiedHedge = !targetDirectionOn
    || targetDirection.confidence + EPS >= hedgeScoreMin;
  const releaseRole = oppositeSignal
    ? (reversalOn && strongOpposite ? "reversal" : "hedge")
    : (firstEntry ? "first-entry" : "topup");
  const roleConfirmMs = releaseRole === "first-entry"
    ? Math.max(0, finite(P.H_FIRST_ENTRY_CONFIRM_MS) ?? 360)
    : releaseRole === "topup" ? Math.max(0, finite(P.H_TOPUP_CONFIRM_MS) ?? 360)
      : releaseRole === "hedge" ? Math.max(0, finite(P.H_HEDGE_CONFIRM_MS) ?? 600)
        : reversalConfirmMs;
  const roleCooldownMs = releaseRole === "topup"
    ? Math.max(0, finite(P.H_TOPUP_COOLDOWN_MS) ?? 8000)
    : releaseRole === "hedge" ? Math.max(0, finite(P.H_HEDGE_COOLDOWN_MS) ?? 6000)
      : releaseRole === "reversal" ? Math.max(0, finite(P.H_REVERSAL_COOLDOWN_MS) ?? 3000)
        : 0;
  baseStatus.releaseRole = releaseRole;
  baseStatus.roleConfirmMs = roleConfirmMs;
  baseStatus.roleCooldownMs = roleCooldownMs;
  baseStatus.hedgeScoreMin = hedgeScoreMin;

  if (signalHysteresisOn && oppositeSignal && !qualifiedHedge) {
    return resetSignal(state, model, { ...baseStatus, gate: "opposite-score", side });
  }

  if (signalHysteresisOn && firstEntry
      && tk.t + EPS < Math.max(0, finite(P.H_FIRST_ENTRY_EARLIEST_S) ?? 15)) {
    return resetSignal(state, model, { ...baseStatus, gate: "first-entry-earliest" });
  }
  const maxActions = Math.max(1, Math.round(finite(P.H_MAX_ACTIONS_PER_WINDOW) ?? 7));
  if (signalHysteresisOn && model.orderCount >= maxActions) {
    return resetSignal(state, model, { ...baseStatus, gate: "window-action-cap", maxActions });
  }

  const cooldownMs = Math.max(0, +P.H_COOLDOWN_MS || 0);
  if (clockMs - model.lastOrderMs < cooldownMs) {
    setStatus(state, { ...baseStatus, gate: "cooldown", side,
      cooldownMs, cooldownRemainingMs: cooldownMs - (clockMs - model.lastOrderMs) });
    return [];
  }

  const eventKey = signalHysteresisOn ? null
    : signalEventKey(signal, side, toggles, oppositePhase);
  if (signalHysteresisOn) {
    const release = evaluateRelease(model, { direction: targetDirection,
      role: releaseRole, clockMs, midpoint: momentum.midpoint,
      confirmMs: roleConfirmMs, roleCooldownMs,
      topupScoreStep: P.H_TOPUP_SCORE_STEP,
      topupPriceStep: P.H_TOPUP_PRICE_STEP });
    if (!release.eligible) {
      setStatus(state, { ...baseStatus, gate: release.gate, side,
        releaseConfirmedMs: release.confirmedMs ?? null,
        releaseRemainingMs: release.remainingMs ?? null });
      return [];
    }
  } else if (model.lastSignalKey === eventKey) {
    setStatus(state, { ...baseStatus, gate: "signal-already-entered", side });
    return [];
  }

  const quote = executionQuote(side === "Up" ? tk.up : tk.down, P);
  const minAsk = Math.max(0.01, +P.H_MIN_ASK || 0.01);
  const maxAsk = Math.min(+P.LIMIT || 0.99, +P.H_MAX_ASK || 0.99);
  if (quote.ask == null || quote.ask < minAsk - EPS || quote.ask > maxAsk + EPS || quote.cap == null) {
    setStatus(state, { ...baseStatus, gate: "ask-range", side }); return [];
  }
  const minOrder = Math.max(1, +P.H_MIN_ORDER_SH || 1);
  const minDepth = Math.max(+P.H_MIN_DEPTH_SH || 0, minOrder);
  if (quote.available + EPS < minDepth) {
    setStatus(state, { ...baseStatus, gate: "depth", side, cap: quote.cap,
      capDepth: quote.available }); return [];
  }

  const staticBaseShares = Math.max(minOrder, +P.H_BASE_ORDER_SH || +P.SIZE || 7);
  const targetSizeOn = enabled(P.H_TARGET_SIZE_ON, false);
  const targetSizeMax = Math.max(minOrder,
    finite(P.H_TARGET_SIZE_MAX_SH) ?? 50);
  const targetSizedShares = targetWalletRoleShares(quote.cap, {
    role: releaseRole,
    confidence: targetDirection.confidence,
    enterScore: targetDirection.enterScore,
    topupMinScale: P.H_TARGET_TOPUP_MIN_SCALE,
    baseShares: staticBaseShares,
    minShares: minOrder,
    maxShares: targetSizeMax,
    scale: finite(P.H_TARGET_SIZE_SCALE) ?? 1,
  });
  const entrySizedRole = releaseRole === "first-entry" || releaseRole === "topup";
  const baseShares = targetSizeOn && entrySizedRole ? targetSizedShares : staticBaseShares;
  const staticReversalResidual = Math.max(minOrder,
    finite(P.H_REVERSAL_RESIDUAL_SH) ?? 4);
  const reversalResidual = targetSizeOn && enabled(P.H_TARGET_REVERSAL_SIZE_ON, false)
    ? targetSizedShares : staticReversalResidual;
  // A reversal is intentionally stricter than an ordinary entry: both raw
  // momentum sources, the strong trailing trend, and spot-vs-window-open must
  // all point to the new side. This remains true even if ordinary entries use
  // only one source or have window-gap agreement disabled.
  const sideSign = side === "Up" ? 1 : -1;
  const scoreSnapshotConfirmed = targetDirectionOn
    && targetDirection.confidence + EPS >= reversalScoreMin
    && (targetDirection.components.level ?? 0) * sideSign > 0
    && ((targetDirection.components.clob ?? 0) * sideSign > 0
      || (targetDirection.components.binance ?? 0) * sideSign > 0);
  const reversalSnapshotConfirmed = targetDirectionOn ? scoreSnapshotConfirmed
    : velocityDir === side
      && binanceDir === side
      && trendRegime.strongTrend
      && trendRegime.trendDirection === side
      && binanceWindowGapDir === side;
  const reversalConfirmed = reversalSnapshotConfirmed
    && reversalConfirmedMs + EPS >= reversalConfirmMs;

  const oldSide = side === "Up" ? "Down" : "Up";
  const oldShares = oldSide === "Up" ? inv.up : inv.down;
  const oldCost = oldSide === "Up" ? inv.upCost : inv.downCost;
  const allocatedOldFee = inv.gross > EPS ? inv.fee * oldShares / inv.gross : 0;
  const oldUnitCost = oldShares > EPS ? (oldCost + allocatedOldFee) / oldShares : null;
  const pairEdge = oldUnitCost == null ? null
    : 1 - oldUnitCost - quote.cap - fillFee(quote.cap, 1, true, P);
  const minPairEdge = finite(P.H_REVERSAL_MIN_PAIR_EDGE) ?? -0.1;
  const hedgeMinPairEdge = finite(P.H_HEDGE_MIN_PAIR_EDGE) ?? -0.03;
  const hedgeEconomic = !targetDirectionOn
    || (pairEdge != null && pairEdge + EPS >= hedgeMinPairEdge);
  const maxWorstLoss = Math.max(0,
    finite(P.H_REVERSAL_MAX_WORST_LOSS_USD) ?? 10);
  const maxReversalOrder = Math.max(minOrder,
    finite(P.H_REVERSAL_MAX_ORDER_SH) ?? 50);
  const desiredReversalShares = oldImbalance + reversalResidual;
  const reversalProjection = projectedPosition(inv, side,
    desiredReversalShares, quote.cap, P);
  const reversalEconomic = pairEdge != null && pairEdge + EPS >= minPairEdge;
  const reversalRiskAllowed = reversalProjection.worstLoss <= maxWorstLoss + EPS
    || reversalProjection.worstLoss + EPS < inv.worstLoss;
  const reversalSizeAllowed = desiredReversalShares <= maxReversalOrder + EPS;
  const reversalDepthAllowed = desiredReversalShares <= quote.available + EPS;

  let leg = "entry", role = signalHysteresisOn ? releaseRole : "entry", amountMode = "usd";
  let shares = baseShares;
  let reason = targetDirectionOn ? `target-score-${role}`
    : toggles.clobMid && toggles.binanceGap ? "dual-velocity-entry"
    : toggles.clobMid ? "clob-mid-velocity-entry" : "binance-gap-momentum-entry";

  if (oppositeSignal) {
    if (reversalOn && reversalConfirmed && reversalEconomic
      && reversalRiskAllowed && reversalSizeAllowed && reversalDepthAllowed) {
      // Exact-share intent: planned post-fill oriented inventory is the new
      // residual and cannot expand merely because execution improves in price.
      shares = desiredReversalShares;
      leg = role = "reversal";
      amountMode = "shares";
      reason = "strong-confirmed-inventory-reversal";
    } else if (hedgeOn) {
      const minRetain = Math.max(EPS, finite(P.H_HEDGE_RETAIN_SH) ?? 1);
      const maxRetain = Math.max(minRetain,
        finite(P.H_HEDGE_RETAIN_MAX_SH) ?? minRetain);
      const strength = targetDirectionOn
        ? Math.max(0, Math.min(1, (targetDirection.confidence - targetDirection.enterScore)
          / Math.max(EPS, reversalScoreMin - targetDirection.enterScore)))
        : 1;
      const retain = targetDirectionOn
        ? Math.max(minRetain, Math.ceil(maxRetain - strength * (maxRetain - minRetain)))
        : minRetain;
      // Q <= old imbalance - retained lead, so the pre-existing inventory side
      // remains the majority after any complete partial-hedge fill.
      shares = Math.min(staticBaseShares, oldImbalance - retain, quote.available,
        maxReversalOrder);
      if (shares + EPS < minOrder) {
        setStatus(state, { ...baseStatus, gate: "hedge-retained-majority", side,
          oldImbalance, retainedLeadShares: retain,
          maximumHedgeShares: Math.max(0, oldImbalance - retain) });
        return [];
      }
      if (!hedgeEconomic) {
        setStatus(state, { ...baseStatus, gate: "hedge-economics", side,
          oldImbalance, pairEdge, hedgeMinPairEdge });
        return [];
      }
      const hedgeProjection = projectedPosition(inv, side, shares, quote.cap, P);
      if (hedgeProjection.worstLoss > inv.worstLoss + EPS) {
        setStatus(state, { ...baseStatus, gate: "hedge-risk", side,
          oldImbalance, currentWorstLoss: inv.worstLoss,
          projectedWorstLoss: hedgeProjection.worstLoss });
        return [];
      }
      leg = role = "hedge";
      amountMode = "shares";
      reason = reversalOn && reversalConfirmed
        ? "reversal-risk-bounded-partial-hedge"
        : "opposite-signal-partial-hedge";
    } else {
      const gate = reversalOn ? (!reversalConfirmed ? "reversal-confirmation"
        : !reversalEconomic ? "reversal-economics"
          : !reversalRiskAllowed ? "reversal-risk"
            : !reversalSizeAllowed ? "reversal-order-cap"
              : !reversalDepthAllowed ? "reversal-depth"
              : "reversal-disabled") : "opposite-signal-disabled";
      setStatus(state, { ...baseStatus, gate, side, oldImbalance,
        reversalConfirmed, reversalConfirmedMs, reversalConfirmMs,
        pairEdge, minPairEdge, currentWorstLoss: inv.worstLoss,
        projectedWorstLoss: reversalProjection.worstLoss, maxWorstLoss,
        desiredReversalShares, maxReversalOrder, reversalDepthAllowed });
      return [];
    }
  }

  // A crossing needs enough decision-time depth for its whole exact-share
  // intent. Arrival-book deterioration can still yield a partial FAK and is
  // reported honestly by the fill status.
  if (leg === "reversal" && quote.available + EPS < shares) {
    setStatus(state, { ...baseStatus, gate: "reversal-depth", side,
      oldImbalance, requestedShares: shares, cap: quote.cap,
      capDepth: quote.available });
    return [];
  }
  if (amountMode === "shares" && shares * quote.ask + EPS < 1) {
    setStatus(state, { ...baseStatus, gate: "inventory-order-min-notional", side,
      role, requestedShares: shares, ask: quote.ask,
      notionalUsd: shares * quote.ask });
    return [];
  }

  const rec = makeOrder(state, model, tk, clockMs, { side, minimumShares: shares,
    ask: quote.ask, cap: quote.cap, reason, signal, quote,
    liveOrderType: P.H_LIVE_ORDER_TYPE, leg, role, amountMode });
  model.lastSignalKey = eventKey;
  if (signalHysteresisOn) markReleaseFired(model, { role, side, clockMs,
    confidence: targetDirection.confidence, midpoint: momentum.midpoint });
  if (leg === "reversal") {
    model.oppositeCandidateSide = null;
    model.oppositeCandidateSinceMs = null;
    model.oppositeCandidateLastSeenMs = null;
  }
  setStatus(state, { ...baseStatus, gate: "fired", side, role,
    ask: quote.ask, cap: quote.cap, minimumShares: shares,
    budgetUsd: rec.budgetUsd, capDepth: quote.available,
    targetSizeOn, staticBaseShares, targetSizedShares,
    oldImbalance, reversalConfirmed, reversalConfirmedMs, reversalConfirmMs,
    pairEdge, minPairEdge, currentWorstLoss: inv.worstLoss,
    hedgeMinPairEdge, hedgeEconomic,
    projectedWorstLoss: leg === "reversal" ? reversalProjection.worstLoss : null,
    oppositeCandidateSide: leg === "reversal" ? null : model.oppositeCandidateSide,
    plannedPostOrientedShares: oppositeSignal
      ? (leg === "reversal" ? reversalResidual : oldImbalance - shares)
      : orientedNet + shares });
  return [rec];
}

export function clearLivePending() {}
