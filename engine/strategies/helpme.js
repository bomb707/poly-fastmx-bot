// FastMX — CLOB-mid and Binance-gap velocity signals with the Binance
// rolling-trend regime and inventory-aware opposite-signal handling.
//
// Each enabled fast signal must clear its own absolute threshold. When both are
// enabled they must agree on direction. Binance gap velocity is the raw-dollar
// dev-tool definition:
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
// A distinct qualifying signal snapshot emits one order once the configured
// cooldown allows. A signal aligned with flat/current inventory is an entry.
// An opposing signal can be handled in two independently-toggleable ways:
//   - partial hedge: buy at most the imbalance minus a retained old-side lead;
//   - reversal: on strong CLOB + Binance + trend confirmation, buy through
//     balance and leave a configured residual on the newly predicted side.
// Repeated feed heartbeats with identical signal inputs are de-duplicated.

import { midOf } from "../momentum.js";
import { fillFee } from "../fees.js";
import { FASTMX_SESSION_PROFILES, resolveFastMxSessionParams } from "./fastmx-session-policy.js";

export const NAME = "helpme";
export const LABEL = "FastMX · dual momentum + Binance trend regime";

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
  H_SESSION_POLICY_ON: true,
  H_SESSION_PROFILES: FASTMX_SESSION_PROFILES,
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
  // Backtest default OFF: the paired Aug 16-25 replay found partial hedging
  // degraded both fit and holdout PnL. The UI keeps it independently opt-in.
  H_HEDGE_ON: false,
  // Share-denominated hedges preserve this old-side lead even when execution
  // receives price improvement.
  H_HEDGE_RETAIN_SH: 1,
  // Global fallback is off; the validated Europe and late-US session profiles
  // selectively enable persistent reversals.
  H_REVERSAL_ON: false,
  // Target extraction: median post-cross residual=10.44sh and p90 old
  // imbalance among crosses=25.35sh.
  H_REVERSAL_RESIDUAL_SH: 10,
  H_REVERSAL_MAX_IMBALANCE_SH: 25,
  H_REVERSAL_CONFIRM_MS: 1000,
  H_REVERSAL_DYNAMIC_SIZE_ON: true,
  H_REVERSAL_RISK_USD: 2,
  H_REVERSAL_ECONOMIC_GATE_ON: false,
  H_REVERSAL_MIN_PAIR_EDGE: -0.03,
  H_REVERSAL_MAX_LOCKED_LOSS_USD: 2,
  H_MIN_ASK: 0.05,
  H_MAX_ASK: 0.98,
  H_CAP_HEADROOM: 0.01,
  H_LIVE_ORDER_TYPE: "GTC",
  H_MIN_DEPTH_SH: 4,
  H_BASE_ORDER_SH: 7,
  H_MIN_ORDER_SH: 4,
  H_MIN_ORDER_USD: 1,
  // Return-efficiency sizing uses the user's economic anchor: 60 shares at
  // $0.60. Gross win ROI is (1-price)/price, so lower-priced qualifying
  // entries receive more shares and high-priced entries fall back toward the
  // configured minimum (10 in the reviewed candidate). This has no payout
  // target; visible depth is the final execution bound. The legacy risk-usd
  // mode remains available explicitly.
  // Price-only return scaling failed the complete replay and is therefore not
  // active by default. It remains available for a future probability/edge
  // gate; the deployed mode retains fixed-expenditure sizing.
  H_DYNAMIC_SIZE_ON: true,
  H_ENTRY_SIZE_MODE: "risk-usd",
  H_RETURN_REFERENCE_PRICE: 0.60,
  H_RETURN_REFERENCE_SH: 60,
  H_RETURN_SIZE_SCALE: 1,
  H_ENTRY_RISK_USD: 2,
  H_RISK_LIMITS_ON: true,
  H_MAX_ORDER_SH: 100,
  H_MAX_GROSS_SH: 500,
  H_MAX_ROUND_COST_USD: 250,
  H_MAX_ROUND_WORST_LOSS_USD: 10,
  // Optional cap for ordinary same-side entries. Null preserves the validated
  // policy; 1 and 2 were tested but failed the later-period return screen.
  H_MAX_ENTRY_ORDERS: null,
  H_MAX_SIGNAL_ORDERS: 4,
  // If normal signals never fill, begin minimum-risk marketable attempts late
  // in the round. This guarantees a causal attempt/retry policy; no software
  // can guarantee a venue fill when liquidity or connectivity is absent.
  H_PARTICIPATION_ON: true,
  H_PARTICIPATION_START_S: 90,
  H_PARTICIPATION_END_S: 299,
  H_PARTICIPATION_RETRY_MS: 1000,
  H_PARTICIPATION_RISK_USD: 1,
  H_PARTICIPATION_MAX_ASK: 0.99,
  H_PARTICIPATION_SIDE: "clob",
  // End-game reversal insurance. Both limits are submitted while still below
  // the ask, so post-only protects them from ever becoming takers.
  H_RESCUE_MAKER_ON: true,
  H_RESCUE_START_S: 270,
  H_RESCUE_END_S: 299,
  H_RESCUE_PRICE_HIGH: 0.02,
  H_RESCUE_PRICE_LOW: 0.01,
  H_RESCUE_TOTAL_RISK_USD: 2,
  H_RESCUE_RETAIN_SH: 25,
  H_RESCUE_REQUIRE_BOTH: true,
  H_RESCUE_MAKER_LATENCY_MS: 130,
  H_RESCUE_SIM_FILL_PCT: 100,
  H_RESCUE_SIM_TOUCH_MS: 250,
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
  const toggles = signalToggles({ ...STRAT, ...(P || {}) });
  if (!toggles.clobMid && !toggles.binanceGap) {
    throw new RangeError("at least one FastMX fast-momentum toggle must be enabled");
  }
  if (toggles.binanceTrend && !toggles.binanceGap) {
    throw new RangeError("the poly-mom Binance trend regime requires Binance gap momentum");
  }
  const sizeMode = String(P.H_ENTRY_SIZE_MODE || "risk-usd").toLowerCase();
  if (enabled(P.H_DYNAMIC_SIZE_ON, false) && sizeMode === "return-efficiency") {
    const referencePrice = finite(P.H_RETURN_REFERENCE_PRICE);
    if (!(referencePrice > 0 && referencePrice < 1)) {
      throw new RangeError("return-efficiency sizing requires 0 < H_RETURN_REFERENCE_PRICE < 1");
    }
    if (!(finite(P.H_RETURN_REFERENCE_SH) > 0)) {
      throw new RangeError("return-efficiency sizing requires H_RETURN_REFERENCE_SH > 0");
    }
  } else if (enabled(P.H_DYNAMIC_SIZE_ON, false) && !(finite(P.H_ENTRY_RISK_USD) > 0)) {
    throw new RangeError("risk-usd FastMX sizing requires H_ENTRY_RISK_USD > 0");
  }
  if (enabled(P.H_RESCUE_MAKER_ON, false)) {
    const high = finite(P.H_RESCUE_PRICE_HIGH), low = finite(P.H_RESCUE_PRICE_LOW);
    if (!(high > 0 && high < 1 && low > 0 && low <= high)) {
      throw new RangeError("rescue maker prices must satisfy 0 < low <= high < 1");
    }
    const levels = high === low ? 1 : 2;
    const minUsd = Math.max(0, finite(P.H_MIN_ORDER_USD) ?? 1);
    if (enabled(P.H_RESCUE_REQUIRE_BOTH, true)
      && (finite(P.H_RESCUE_TOTAL_RISK_USD) ?? 0) + EPS < levels * minUsd) {
      throw new RangeError("rescue total risk must fund the venue minimum at every required level");
    }
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

function effectiveShares(state) {
  let up = +state.upShares || 0;
  let down = +state.downShares || 0;
  for (const p of (state.pendingFills || [])) {
    const r = p?.rec;
    if (!r) continue;
    const shares = finite(r.minimumShares) ?? (+r.shares || 0);
    if (r.side === "Up") up += shares;
    else if (r.side === "Down") down += shares;
  }
  for (const p of (state.restingMakers || [])) {
    const r = p?.rec;
    if (!r) continue;
    const shares = Math.max(0, (+p.target || +r.shares || 0) - (+p.filled || 0));
    if (r.side === "Up") up += shares;
    else if (r.side === "Down") down += shares;
  }
  return { up, down, net: up - down };
}

function effectivePosition(state) {
  let up = +state.upShares || 0, down = +state.downShares || 0;
  let cost = +state.cost || ((+state.upCost || 0) + (+state.downCost || 0));
  let fee = +state.fee || 0;
  for (const pending of (state.pendingFills || [])) {
    const rec = pending?.rec;
    if (!rec) continue;
    const shares = finite(rec.minimumShares) ?? (+rec.shares || 0);
    const px = finite(rec.limitPx) ?? finite(rec.effPx) ?? 0;
    const orderCost = rec.budgetUsd != null ? (+rec.budgetUsd || 0) : shares * px;
    if (rec.side === "Up") up += shares; else if (rec.side === "Down") down += shares;
    cost += orderCost;
    if (rec.kind !== "maker" && !rec.maker) fee += fillFee(px, shares, true);
  }
  for (const pending of (state.restingMakers || [])) {
    const rec = pending?.rec;
    if (!rec) continue;
    const shares = Math.max(0, (+pending.target || +rec.shares || 0) - (+pending.filled || 0));
    const px = finite(rec.limitPx) ?? finite(rec.effPx) ?? 0;
    if (rec.side === "Up") up += shares; else if (rec.side === "Down") down += shares;
    cost += shares * px;
  }
  return { up, down, cost, fee, gross: up + down,
    ifUp: up - cost - fee, ifDown: down - cost - fee };
}

function projectedPosition(position, side, shares, price, taker = true) {
  const fee = taker ? fillFee(price, shares, true) : 0;
  const next = { ...position, cost: position.cost + shares * price,
    fee: position.fee + fee, gross: position.gross + shares };
  if (side === "Up") next.up += shares; else next.down += shares;
  next.ifUp = next.up - next.cost - next.fee;
  next.ifDown = next.down - next.cost - next.fee;
  next.worstLoss = Math.max(0, -Math.min(next.ifUp, next.ifDown));
  return next;
}

function floor4(value) {
  return Math.floor((Math.max(0, +value || 0) + EPS) * 1e4) / 1e4;
}

function minimumSharesAt(price, P) {
  const minShares = Math.max(1, finite(P.H_MIN_ORDER_SH) ?? 1);
  const minUsd = Math.max(0, finite(P.H_MIN_ORDER_USD) ?? 1);
  return Math.max(minShares, price > 0 ? Math.ceil((minUsd / price - EPS) * 100) / 100 : Infinity);
}

export function returnEfficiencyShares(price, P = STRAT) {
  const px = finite(price);
  const minShares = Math.max(1, finite(P.H_MIN_ORDER_SH) ?? 1);
  const referencePrice = finite(P.H_RETURN_REFERENCE_PRICE);
  const referenceShares = Math.max(minShares, finite(P.H_RETURN_REFERENCE_SH) ?? minShares);
  const scale = Math.max(0, finite(P.H_RETURN_SIZE_SCALE) ?? 1);
  if (!(px > 0 && px < 1) || !(referencePrice > 0 && referencePrice < 1)
    || scale <= 0) return minShares;
  const roi = (1 - px) / px;
  const referenceRoi = (1 - referencePrice) / referencePrice;
  return Math.max(minShares, referenceShares * scale * roi / referenceRoi);
}

function participationSides(rule, tk, momentum) {
  const midpoint = momentum?.midpoint ?? finite(midOf(tk.up));
  const clob = midpoint == null ? null : (midpoint >= 0.5 ? "Up" : "Down");
  const spot = finite(tk.bzPrice), open = finite(tk.openBinance);
  const binance = spot == null || open == null ? null : (spot >= open ? "Up" : "Down");
  const upAsk = finite(tk.up?.bestAsk), downAsk = finite(tk.down?.bestAsk);
  const cheap = upAsk == null ? "Down" : downAsk == null ? "Up"
    : (upAsk <= downAsk ? "Up" : "Down");
  const preferred = rule === "cheap" ? cheap
    : rule === "binance" ? (binance || clob || cheap)
      : rule === "consensus" && clob && binance && clob === binance ? clob
        : (clob || binance || cheap);
  return [preferred, preferred === "Up" ? "Down" : "Up"];
}

function boundedOrderShares(state, side, desiredShares, price, P, { taker = true } = {}) {
  const position = effectivePosition(state);
  if (!enabled(P.H_RISK_LIMITS_ON, false)) {
    return { shares: floor4(Math.max(0, desiredShares)), position };
  }
  const maxOrder = Math.max(0, finite(P.H_MAX_ORDER_SH) ?? Infinity);
  const grossRoom = Math.max(0, (finite(P.H_MAX_GROSS_SH) ?? Infinity) - position.gross);
  const costRoom = Math.max(0, (finite(P.H_MAX_ROUND_COST_USD) ?? Infinity) - position.cost);
  let shares = Math.min(Math.max(0, desiredShares), maxOrder, grossRoom,
    price > 0 ? costRoom / price : 0);
  const maxWorstLoss = finite(P.H_MAX_ROUND_WORST_LOSS_USD) ?? Infinity;
  if (Number.isFinite(maxWorstLoss)
    && projectedPosition(position, side, shares, price, taker).worstLoss > maxWorstLoss + EPS) {
    // Opposite-side buys can first improve and later worsen the settlement
    // floor, so feasibility is V-shaped rather than always monotone. Locate
    // the highest feasible interval, then refine its upper boundary.
    const desired = shares, slices = 256;
    let best = -1, firstFailAbove = desired;
    for (let i = 0; i <= slices; i++) {
      const candidate = desired * i / slices;
      if (projectedPosition(position, side, candidate, price, taker).worstLoss <= maxWorstLoss + EPS) {
        best = candidate;
      } else if (best >= 0) {
        firstFailAbove = candidate;
        break;
      }
    }
    if (best < 0) shares = 0;
    else {
      let low = best, high = firstFailAbove;
      for (let i = 0; i < 40; i++) {
        const mid = (low + high) / 2;
        if (projectedPosition(position, side, mid, price, taker).worstLoss <= maxWorstLoss + EPS) low = mid;
        else high = mid;
      }
      shares = low;
    }
  }
  return { shares: floor4(shares), position };
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

function signalEventKey(signal, side, toggles) {
  return JSON.stringify([
    side,
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
    orderType: fixedUsd ? "FAK" : "GTC",
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
      capDepth: round4(quote.available),
    },
  };
  model.lastOrderMs = clockMs;
  model.orderCount++;
  if (leg === "entry" || leg === "hedge" || leg === "reversal" || leg === "fallback") {
    model.signalOrderCount = (+model.signalOrderCount || 0) + 1;
  }
  if (leg === "entry") model.entryOrderCount = (+model.entryOrderCount || 0) + 1;
  state.orders = state.orders || [];
  state.orders.push({ oid, side, limit: cap, kind: leg, budgetUsd, filledUsd: 0, placedT: tk.t });
  state.placedThisTick.push({ oid, side, shares: rec.shares, minimumShares: rec.minimumShares,
    budgetUsd, limitPx: cap, leg, role, reason, postOnly: false });
  return rec;
}

function makeMakerOrder(state, model, tk, clockMs, {
  side, shares, limit, reason, signal, expireT, makerLatencyMs = 130,
}) {
  const oid = state.seq = (+state.seq || 0) + 1;
  const rec = {
    tInto: tk.t,
    placedT: tk.t,
    side,
    shares: round4(shares),
    minimumShares: round4(shares),
    budgetUsd: null,
    amountMode: "shares",
    effPx: round4(limit),
    usdc: round4(limit * shares),
    exec: "maker",
    limitPx: round4(limit),
    kind: "maker",
    leg: "rescue",
    role: "rescue",
    reason,
    status: "resting",
    postOnly: true,
    maker: true,
    orderType: "GTC",
    liveOrderType: "GTC",
    expireT,
    restTimeoutMs: Math.max(0, (expireT - tk.t) * 1000),
    oid,
    signal: {
      midpoint: round4(signal.midpoint),
      midVelocity: round4(signal.midVelocity),
      binancePrice: round4(signal.binancePrice),
      binanceGapVelocity: round4(signal.binanceGapVelocity),
      binanceWindowGap: round4(signal.binanceWindowGap),
      binanceTrendPct: round4(signal.binanceTrendPct),
    },
  };
  model.lastOrderMs = clockMs;
  model.orderCount++;
  state.orders = state.orders || [];
  state.orders.push({ oid, side, limit, kind: "rescue", budgetUsd: null,
    filledUsd: 0, placedT: tk.t, expireS: Math.max(0, expireT - tk.t) });
  state.restingMakers = state.restingMakers || [];
  state.restingMakers.push({ rec, target: rec.shares, filled: 0,
    placedMs: clockMs, expireT,
    activeAfterT: tk.t + Math.max(0, finite(makerLatencyMs) ?? 130) / 1000,
    activated: false });
  state.placedThisTick.push({ oid, side, shares: rec.shares,
    minimumShares: rec.minimumShares, budgetUsd: null, limitPx: limit,
    leg: "rescue", role: "rescue", reason, postOnly: true,
    expireT, restTimeoutMs: rec.restTimeoutMs });
  return rec;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = tk.t * 1000) {
  state.placedThisTick = [];
  const sessionResolution = resolveFastMxSessionParams(P, tk);
  P = sessionResolution.params;
  const model = state.helpme || (state.helpme = { history: [], historyHead: 0,
    binanceHistory: [], binanceHistoryHead: 0,
    lastSignalKey: null, lastOrderMs: -Infinity, orderCount: 0 });
  model.history ||= [];
  model.historyHead ||= 0;
  model.binanceHistory ||= [];
  model.binanceHistoryHead ||= 0;
  if (!Number.isFinite(model.lastOrderMs)) model.lastOrderMs = -Infinity;
  model.orderCount ||= 0;
  model.signalOrderCount ||= 0;

  const midLookbackMs = Math.max(1000, +P.H_MID_VELOCITY_LOOKBACK_MS || 3000);
  const binanceLookbackMs = Math.max(1000, +P.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS || 3000);
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
  };
  const inv = effectiveShares(state);
  const baseStatus = {
    t: tk.t,
    utcSession: sessionResolution.session,
    sessionPolicyApplied: sessionResolution.applied,
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
    upShares: inv.up,
    downShares: inv.down,
    net: inv.net,
    orders: model.orderCount,
    signalOrders: model.signalOrderCount,
  };

  if (P.H_ON === false) return resetSignal(state, model, { ...baseStatus, gate: "disabled" });

  const rescueOn = enabled(P.H_RESCUE_MAKER_ON, false);
  const rescueStart = Math.max(0, finite(P.H_RESCUE_START_S) ?? 270);
  const rescueEnd = Math.min(+P.WINDOW_SEC || 300,
    Math.max(rescueStart, finite(P.H_RESCUE_END_S) ?? 299));
  if (rescueOn && tk.t >= rescueStart && tk.t <= rescueEnd) {
    const position = effectivePosition(state);
    const net = position.up - position.down;
    const predictedWinner = Math.abs(net) > EPS
      ? (net > 0 ? "Up" : "Down") : model.lastConfirmedSide;
    if (predictedWinner) {
      const rescueSide = predictedWinner === "Up" ? "Down" : "Up";
      const winnerAsk = finite((predictedWinner === "Up" ? tk.up : tk.down)?.bestAsk);
      const rescueAsk = finite((rescueSide === "Up" ? tk.up : tk.down)?.bestAsk);
      const high = Math.max(0.01, Math.min(0.99,
        finite(P.H_RESCUE_PRICE_HIGH) ?? 0.02));
      const low = Math.max(0.01, Math.min(high,
        finite(P.H_RESCUE_PRICE_LOW) ?? 0.01));
      const prices = [...new Set([high, low])].sort((a, b) => b - a);
      const totalRiskUsd = Math.max(0, finite(P.H_RESCUE_TOTAL_RISK_USD) ?? 2);
      const perLevelRisk = totalRiskUsd / prices.length;
      const retain = Math.max(0, finite(P.H_RESCUE_RETAIN_SH) ?? 25);
      const planned = prices.filter((price) => {
        const key = `${rescueSide}:${price.toFixed(4)}`;
        return !model.rescuePlaced?.[key] && rescueAsk != null && rescueAsk > price + EPS;
      }).map((price) => ({ price, shares: Math.max(minimumSharesAt(price, P),
        perLevelRisk > 0 ? perLevelRisk / price : 0) }));
      const requireBoth = enabled(P.H_RESCUE_REQUIRE_BOTH, true);
      const allLevelsAvailable = planned.length === prices.length;
      const totalShares = planned.reduce((sum, row) => sum + row.shares, 0);
      const dominantLead = Math.abs(net);
      let riskFeasible = planned.length > 0 && dominantLead - totalShares >= retain - EPS;
      let trial = position;
      for (const row of planned) {
        if (row.shares > (finite(P.H_MAX_ORDER_SH) ?? Infinity) + EPS) riskFeasible = false;
        trial = projectedPosition(trial, rescueSide, row.shares, row.price, false);
      }
      const maxGross = finite(P.H_MAX_GROSS_SH) ?? Infinity;
      const maxCost = finite(P.H_MAX_ROUND_COST_USD) ?? Infinity;
      const maxWorst = finite(P.H_MAX_ROUND_WORST_LOSS_USD) ?? Infinity;
      if (trial.gross > maxGross + EPS || trial.cost > maxCost + EPS
        || trial.worstLoss > maxWorst + EPS) riskFeasible = false;
      if ((!requireBoth || allLevelsAvailable) && riskFeasible
        && rescueAsk < winnerAsk - EPS) {
        const out = [];
        model.rescuePlaced ||= {};
        for (const row of planned) {
          const rec = makeMakerOrder(state, model, tk, clockMs, {
            side: rescueSide, shares: row.shares, limit: row.price,
            reason: `end-rescue-maker-${row.price.toFixed(2)}`,
            signal, expireT: rescueEnd,
            makerLatencyMs: P.H_RESCUE_MAKER_LATENCY_MS,
          });
          model.rescuePlaced[`${rescueSide}:${row.price.toFixed(4)}`] = true;
          out.push(rec);
        }
        setStatus(state, { ...baseStatus, gate: "rescue-maker-placed",
          side: rescueSide, predictedWinner, rescueAsk, winnerAsk,
          rescueLevels: planned.map((row) => ({ price: row.price, shares: round4(row.shares) })),
          retainedLeadAfterAllFills: dominantLead - totalShares,
          projectedIfUp: trial.ifUp, projectedIfDown: trial.ifDown });
        return out;
      }
    }
  }

  const participationOn = enabled(P.H_PARTICIPATION_ON, false);
  const participationStart = Math.max(0, finite(P.H_PARTICIPATION_START_S) ?? 240);
  const participationEnd = Math.min(+P.WINDOW_SEC || 300,
    Math.max(participationStart, finite(P.H_PARTICIPATION_END_S) ?? 299));
  const participationRetryMs = Math.max(0, finite(P.H_PARTICIPATION_RETRY_MS) ?? 1000);
  const effectiveNow = effectivePosition(state);
  if (participationOn && effectiveNow.gross <= EPS
    && tk.t >= participationStart && tk.t <= participationEnd
    && clockMs - (finite(model.lastParticipationAttemptMs) ?? -Infinity) >= participationRetryMs) {
    model.lastParticipationAttemptMs = clockMs;
    const maxAsk = Math.max(0.01, Math.min(0.99,
      finite(P.H_PARTICIPATION_MAX_ASK) ?? 0.99));
    for (const fallbackSide of participationSides(P.H_PARTICIPATION_SIDE, tk, momentum)) {
      const fallbackBook = fallbackSide === "Up" ? tk.up : tk.down;
      const ask = finite(fallbackBook?.bestAsk);
      if (!(ask > 0) || ask > maxAsk + EPS) continue;
      const cap = Math.min(maxAsk, ceilCent(ask + Math.max(0, +P.H_CAP_HEADROOM || 0)));
      const quote = { ask, cap, available: cappedDepth(levels(fallbackBook?.asks, true), cap) };
      const riskUsd = Math.max(0, finite(P.H_PARTICIPATION_RISK_USD) ?? 1);
      const wanted = Math.max(minimumSharesAt(ask, P), cap > 0 ? riskUsd / cap : 0);
      const bounded = boundedOrderShares(state, fallbackSide, wanted, cap, P, { taker: true });
      const shares = Math.min(floor4(wanted), bounded.shares, quote.available);
      if (shares + EPS < minimumSharesAt(ask, P)) continue;
      const rec = makeOrder(state, model, tk, clockMs, { side: fallbackSide,
        minimumShares: shares, ask, cap, reason: `mandatory-participation-${P.H_PARTICIPATION_SIDE || "clob"}`,
        signal, quote, liveOrderType: P.H_LIVE_ORDER_TYPE,
        leg: "fallback", role: "fallback", amountMode: "shares" });
      setStatus(state, { ...baseStatus, gate: "fallback-fired", side: fallbackSide,
        role: "fallback", ask, cap, minimumShares: shares,
        participationStart, participationEnd });
      return [rec];
    }
    setStatus(state, { ...baseStatus, gate: "fallback-no-liquidity",
      participationStart, participationEnd });
    return [];
  }
  if (tk.t < (+P.H_START_S || 0)) return resetSignal(state, model, { ...baseStatus, gate: "wait-open" });
  if (tk.t > (+P.H_STOP_S || P.WINDOW_SEC || 300)) return resetSignal(state, model, { ...baseStatus, gate: "end-cutoff" });
  if (!toggles.clobMid && !toggles.binanceGap) {
    return resetSignal(state, model, { ...baseStatus, gate: "signal-toggle-required" });
  }
  if (toggles.binanceTrend && !toggles.binanceGap) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-trend-needs-binance-momentum" });
  }
  if (toggles.clobMid && midVelocity == null) {
    return resetSignal(state, model, { ...baseStatus, gate: "clob-mid-warmup" });
  }
  if (toggles.clobMid && !velocityDir) {
    return resetSignal(state, model, { ...baseStatus, gate: "clob-mid-velocity" });
  }
  if (toggles.binanceGap && binanceGapVelocity == null) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-warmup" });
  }
  if (toggles.binanceGap && !binanceDir) {
    return resetSignal(state, model, { ...baseStatus, gate: "binance-gap-velocity" });
  }
  const enabledDirections = [toggles.clobMid ? velocityDir : null,
    toggles.binanceGap ? binanceDir : null].filter(Boolean);
  const side = enabledDirections[0];
  if (!enabledDirections.every((direction) => direction === side)) {
    return resetSignal(state, model, { ...baseStatus, gate: "momentum-disagreement" });
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
  model.lastConfirmedSide = side;

  const cooldownMs = Math.max(0, +P.H_COOLDOWN_MS || 0);
  if (clockMs - model.lastOrderMs < cooldownMs) {
    setStatus(state, { ...baseStatus, gate: "cooldown", side,
      cooldownMs, cooldownRemainingMs: cooldownMs - (clockMs - model.lastOrderMs) });
    return [];
  }

  const eventKey = signalEventKey(signal, side, toggles);
  if (model.lastSignalKey === eventKey) {
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

  const dynamicSizeOn = enabled(P.H_DYNAMIC_SIZE_ON, false);
  const entrySizeMode = String(P.H_ENTRY_SIZE_MODE || "risk-usd").toLowerCase();
  const entryRiskUsd = Math.max(0, finite(P.H_ENTRY_RISK_USD) ?? 4);
  const staticBaseShares = Math.max(minOrder, +P.H_BASE_ORDER_SH || +P.SIZE || 7);
  const desiredBaseShares = dynamicSizeOn && quote.cap > 0
    ? (entrySizeMode === "return-efficiency"
      ? returnEfficiencyShares(quote.cap, P)
      : entryRiskUsd / quote.cap)
    : staticBaseShares;
  const baseShares = Math.max(minOrder, floor4(desiredBaseShares));
  const orientedNet = side === "Up" ? inv.net : -inv.net;
  const oppositeSignal = orientedNet < -EPS;
  const oldImbalance = oppositeSignal ? Math.abs(orientedNet) : 0;
  const reversalResidual = Math.max(minOrder,
    enabled(P.H_REVERSAL_DYNAMIC_SIZE_ON, false) && quote.cap > 0
      ? (finite(P.H_REVERSAL_RISK_USD) ?? 4) / quote.cap
      : (finite(P.H_REVERSAL_RESIDUAL_SH) ?? 10));
  const reversalMaxImbalance = Math.max(0,
    finite(P.H_REVERSAL_MAX_IMBALANCE_SH) ?? 25);
  // A reversal is intentionally stricter than an ordinary entry: both raw
  // momentum sources, the strong trailing trend, and spot-vs-window-open must
  // all point to the new side. This remains true even if ordinary entries use
  // only one source or have window-gap agreement disabled.
  const reversalSnapshotConfirmed = velocityDir === side
    && binanceDir === side
    && trendRegime.strongTrend
    && trendRegime.trendDirection === side
    && binanceWindowGapDir === side;
  if (oppositeSignal && reversalSnapshotConfirmed) {
    if (model.reversalCandidateSide !== side) {
      model.reversalCandidateSide = side;
      model.reversalCandidateSinceMs = clockMs;
    }
  } else {
    model.reversalCandidateSide = null;
    model.reversalCandidateSinceMs = null;
  }
  const reversalConfirmMs = Math.max(0, finite(P.H_REVERSAL_CONFIRM_MS) ?? 0);
  const reversalConfirmedMs = model.reversalCandidateSide === side
    && Number.isFinite(model.reversalCandidateSinceMs)
    ? Math.max(0, clockMs - model.reversalCandidateSinceMs) : 0;
  const reversalConfirmed = reversalSnapshotConfirmed
    && reversalConfirmedMs + EPS >= reversalConfirmMs;

  const oldSide = side === "Up" ? "Down" : "Up";
  const oldShares = oldSide === "Up" ? (+state.upShares || 0) : (+state.downShares || 0);
  const oldCost = oldSide === "Up" ? (+state.upCost || 0) : (+state.downCost || 0);
  const allocatedOldFee = (+state.fee || 0) * (oldShares / Math.max(EPS,
    (+state.upShares || 0) + (+state.downShares || 0)));
  const oldUnitCost = oldShares > EPS ? (oldCost + allocatedOldFee) / oldShares : null;
  const pairEdge = oldUnitCost == null ? null
    : 1 - oldUnitCost - quote.cap - fillFee(quote.cap, 1, true);
  const lockedLossUsd = pairEdge == null ? Infinity
    : Math.max(0, -pairEdge) * oldImbalance;
  const minPairEdge = finite(P.H_REVERSAL_MIN_PAIR_EDGE) ?? -Infinity;
  const maxLockedLossUsd = finite(P.H_REVERSAL_MAX_LOCKED_LOSS_USD) ?? Infinity;
  const reversalEconomic = !enabled(P.H_REVERSAL_ECONOMIC_GATE_ON, false)
    || (pairEdge != null && pairEdge + EPS >= minPairEdge
      && lockedLossUsd <= maxLockedLossUsd + EPS);

  let leg = "entry", role = "entry", amountMode = "usd";
  let shares = baseShares;
  let reason = toggles.clobMid && toggles.binanceGap ? "dual-velocity-entry"
    : toggles.clobMid ? "clob-mid-velocity-entry" : "binance-gap-momentum-entry";

  if (oppositeSignal) {
    if (reversalOn && reversalConfirmed && reversalEconomic
      && oldImbalance <= reversalMaxImbalance + EPS) {
      // Exact-share intent: planned post-fill oriented inventory is the new
      // residual and cannot expand merely because execution improves in price.
      shares = oldImbalance + reversalResidual;
      leg = role = "reversal";
      amountMode = "shares";
      reason = "persistent-economic-inventory-reversal";
    } else if (hedgeOn) {
      const retain = Math.max(EPS, finite(P.H_HEDGE_RETAIN_SH) ?? 1);
      // Q <= old imbalance - retained lead, so the pre-existing inventory side
      // remains the majority after any complete partial-hedge fill.
      shares = Math.min(baseShares, oldImbalance - retain, quote.available);
      if (shares + EPS < minOrder) {
        setStatus(state, { ...baseStatus, gate: "hedge-retained-majority", side,
          oldImbalance, retainedLeadShares: retain,
          maximumHedgeShares: Math.max(0, oldImbalance - retain) });
        return [];
      }
      leg = role = "hedge";
      amountMode = "shares";
      reason = reversalOn && reversalConfirmed && reversalEconomic
        ? "reversal-imbalance-limit-partial-hedge"
        : "opposite-signal-partial-hedge";
    } else {
      const gate = reversalOn && reversalConfirmed && !reversalEconomic
        ? "reversal-economics" : reversalOn ? "reversal-confirmation" : "opposite-signal-disabled";
      setStatus(state, { ...baseStatus, gate, side, oldImbalance,
        reversalSnapshotConfirmed, reversalConfirmed, reversalConfirmedMs,
        reversalConfirmMs, reversalEconomic, pairEdge, lockedLossUsd,
        minPairEdge, maxLockedLossUsd, reversalMaxImbalance });
      return [];
    }
  }

  const maxEntryOrders = Math.max(1, Math.floor(finite(P.H_MAX_ENTRY_ORDERS) ?? Infinity));
  if (enabled(P.H_RISK_LIMITS_ON, false) && leg === "entry"
    && (+model.entryOrderCount || 0) >= maxEntryOrders) {
    setStatus(state, { ...baseStatus, gate: "entry-count-risk", side, role,
      entryOrders: +model.entryOrderCount || 0, maxEntryOrders });
    return [];
  }
  const maxSignalOrders = Math.max(1, Math.floor(finite(P.H_MAX_SIGNAL_ORDERS) ?? Infinity));
  if (enabled(P.H_RISK_LIMITS_ON, false) && model.signalOrderCount >= maxSignalOrders) {
    setStatus(state, { ...baseStatus, gate: "order-count-risk", side, role,
      signalOrders: model.signalOrderCount, maxSignalOrders });
    return [];
  }

  // Dynamic-size entries and all inventory-control orders use exact shares.
  // This prevents price improvement from silently exceeding gross exposure.
  if (dynamicSizeOn && leg === "entry") amountMode = "shares";
  const bounded = boundedOrderShares(state, side, shares, quote.cap, P, { taker: true });
  shares = Math.min(shares, bounded.shares, quote.available);
  const venueMinShares = minimumSharesAt(quote.cap, P);
  if (shares + EPS < Math.max(minOrder, venueMinShares)) {
    const projected = projectedPosition(bounded.position, side, Math.max(0, shares), quote.cap, true);
    setStatus(state, { ...baseStatus, gate: "risk-size", side, role,
      requestedShares: baseShares, allowedShares: shares,
      minimumShares: Math.max(minOrder, venueMinShares),
      projectedWorstLoss: projected.worstLoss,
      maxWorstLoss: finite(P.H_MAX_ROUND_WORST_LOSS_USD),
      maxGrossShares: finite(P.H_MAX_GROSS_SH),
      maxRoundCostUsd: finite(P.H_MAX_ROUND_COST_USD) });
    return [];
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
  if (amountMode === "shares" && shares * quote.cap + EPS < Math.max(0, finite(P.H_MIN_ORDER_USD) ?? 1)) {
    setStatus(state, { ...baseStatus, gate: "inventory-order-min-notional", side,
      role, requestedShares: shares, ask: quote.ask,
      notionalUsd: shares * quote.ask });
    return [];
  }

  const rec = makeOrder(state, model, tk, clockMs, { side, minimumShares: shares,
    ask: quote.ask, cap: quote.cap, reason, signal, quote,
    liveOrderType: P.H_LIVE_ORDER_TYPE, leg, role, amountMode });
  model.lastSignalKey = eventKey;
  setStatus(state, { ...baseStatus, gate: "fired", side, role,
    ask: quote.ask, cap: quote.cap, minimumShares: shares,
    budgetUsd: rec.budgetUsd, capDepth: quote.available,
    oldImbalance, reversalConfirmed,
    reversalSnapshotConfirmed, reversalConfirmedMs, reversalConfirmMs,
    reversalEconomic, pairEdge, lockedLossUsd,
    plannedPostOrientedShares: oppositeSignal
      ? (leg === "reversal" ? reversalResidual : oldImbalance - shares)
      : orientedNet + shares });
  return [rec];
}

export function injectRealFill(state, fill) {
  if (!state || !fill || fill.oid == null || !Array.isArray(state.restingMakers)) return;
  const pending = state.restingMakers.find((row) => row?.rec?.oid === fill.oid);
  if (!pending) return;
  pending.filled = Math.min(+pending.target || 0,
    (+pending.filled || 0) + Math.max(0, +fill.shares || 0));
  if (pending.filled + EPS >= (+pending.target || 0)) {
    state.restingMakers = state.restingMakers.filter((row) => row !== pending);
  }
}

export function clearLivePending(state, oid) {
  if (!state || oid == null) return;
  if (Array.isArray(state.restingMakers)) {
    const pending = state.restingMakers.find((row) => row?.rec?.oid === oid);
    if (pending?.rec && state.helpme?.rescuePlaced) {
      delete state.helpme.rescuePlaced[`${pending.rec.side}:${Number(pending.rec.limitPx).toFixed(4)}`];
    }
    state.restingMakers = state.restingMakers.filter((row) => row?.rec?.oid !== oid);
  }
}
