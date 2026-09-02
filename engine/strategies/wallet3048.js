// Public-data reconstruction of wallet 0x3048...e7537 described in
// TARGET_WALLET_STRATEGY_ANALYSIS.md.
//
// This is an implementable reconstruction, not a claim that the wallet's
// private coefficients or cancel state were recovered. Every unidentified
// threshold is an explicit parameter below so forward tests remain auditable.

import { fillFee } from "../fees.js";

export const NAME = "wallet3048";
export const LABEL = "Target wallet 3048 · latency-aware inventory";

export const STRAT = {
  STRATEGY: NAME,
  W3048_SPEC_VERSION: 5,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  LIVE_FILLS: false,
  LIMIT: 0.99,
  MAX_SESSION_LOSS: 25,

  W3048_ON: true,
  W3048_START_S: 4,
  W3048_STOP_S: 270,
  W3048_MIN_PRICE: 0.01,
  W3048_MAX_PRICE: 0.99,
  W3048_TICK: 0.01,
  W3048_PREPARE_LEAD_MS: 90000,
  W3048_COOLDOWN_MS: 250,
  W3048_MAX_ACTIONS: 120,
  W3048_MAX_PENDING: 4,
  W3048_DEPTH_STALE_MS: 1000,
  W3048_REST_TIMEOUT_MS: 10000,
  W3048_RESERVOIR_TIMEOUT_MS: 30000,
  W3048_SIM_TOUCH_MS: 1000,
  W3048_SIM_TOUCH_FILL_PCT: 30,
  W3048_CROSS_HEADROOM_TICKS: 1,
  W3048_CANCEL_CAP_SLACK_TICKS: 0,
  W3048_CANCEL_REVERSAL_MIN_ABS: 0.00002,

  // Fast Binance information is the primary initial release. These CLOB
  // branches provide secondary fill-probability evidence for later taker
  // attempts; a patient below-ask rung may rest without a prior depth drop.
  W3048_RELEASE_GATE: true,
  W3048_EXECUTABLE_RUN_MS: 525,
  W3048_RELEASE_ASK1_MAX: 100,
  W3048_RELEASE_ASK3_MAX: 410,
  W3048_RELEASE_DEPLETION1_MAX: -110,
  W3048_PRESSURE_ASK3_MAX: 800,
  W3048_PRESSURE_IMBALANCE_MIN: 0.20,
  W3048_PRESSURE_DEPLETION1_MAX: -300,
  W3048_BBA_MOVE_MIN: 0.01,
  W3048_LIQUIDITY_RANK_CAP: 2,
  W3048_FILL_PROB_WEIGHT: 0.015,
  W3048_PAIR_VALUE_WEIGHT_START: 0.35,
  W3048_PAIR_VALUE_WEIGHT_END: 1.25,
  W3048_RISK_RELIEF_WEIGHT_START: 0.05,
  W3048_RISK_RELIEF_WEIGHT_END: 0.70,
  W3048_SAME_SIDE_EXTRA_EDGE: 0.015,
  W3048_LOSS_CAP_EXTRA_EDGE: 0.020,
  W3048_SAME_SIDE_REPRICE: 0.01,
  W3048_SAME_SIDE_RETRY_MS: 750,

  // The only parent sizes observed in the attached decoded sample.
  W3048_SMALL_SIZE: 50,
  W3048_LARGE_SIZE: 150,
  W3048_LARGE_EDGE: 0.035,
  W3048_LARGE_MIN_DEPTH: 150,

  // Target-like parent topology: 50 shares express the active directional
  // view; a 150-share complement may rest below the ask as an inventory
  // reservoir. The reservoir is accepted only when a hypothetical full fill
  // improves both absolute lean and the settlement floor at its signed limit.
  W3048_RESERVOIR_MIN_LEAN: 75,
  W3048_RESERVOIR_MIN_PAIR_EDGE: 0.020,

  // The public wallet does not require the corresponding token to remain
  // down/flat for every entry. Keep the strict lag release, but also admit an
  // independently undervalued first 50-share rung and momentum continuation.
  W3048_INITIAL_VALUE_EDGE: 0.025,
  W3048_INITIAL_MAX_PRICE: 0.55,
  // The broad continuation overlay is implemented but disabled by default:
  // it lost money in both chronological replay partitions. Strict lag entries,
  // pair completion, and risk-reducing complements remain active.
  W3048_DIRECTIONAL_OVERLAY_ON: false,
  W3048_OVERLAY_MIN_EXPECTED_EDGE: 0.025,
  W3048_STRONG_OVERLAY_MIN_PEAK_FLOOR: 10,

  // A 150-share parent is exceptional. It is permitted only for a fully
  // executable strong catch-up, a fully profitable 150-share FIFO pair, or a
  // risk-reducing inventory emergency. Since a fixed 150-share complement can
  // reduce absolute lean only above 75 shares, that is the mathematical floor;
  // projected lean and worst-case PnL must still improve after the full order.
  W3048_EMERGENCY_MIN_LEAN: 75,
  W3048_EMERGENCY_MIN_RISK_ADJUSTED_EDGE: 0,

  // Fixed causal standardization scales for the report's probability model.
  W3048_MOMENTUM_LOOKBACK_MS: 2500,
  W3048_MOMENTUM_MIN_ABS: 0.000075,
  W3048_POLY_LOOKBACK_MS: 2500,
  W3048_POLY_LAG_MAX_MOVE: 0,
  W3048_STRONG_MOMENTUM_MIN_ABS: 0.00010,
  W3048_STRONG_LATEST_UPDATE_MIN_ABS: 0,
  W3048_VOL_LOOKBACK_MS: 30000,
  W3048_MOMENTUM_SCALE: 0.00010,
  W3048_LATEST_UPDATE_SCALE: 0.00005,
  W3048_RELATIVE_LEAD_SCALE: 0.00050,
  W3048_CHAINLINK_DISTANCE_SCALE: 0.00100,
  W3048_VOL_SCALE: 0.00030,
  W3048_BETA0: 0,
  W3048_BETA_MARKET_LOGIT: 1,
  W3048_BETA_MOMENTUM: 0.40,
  W3048_BETA_LATEST_UPDATE: 0.05,
  W3048_BETA_RELATIVE_LEAD: 0.05,
  W3048_BETA_CHAINLINK_DISTANCE: 0.10,
  W3048_BETA_CLOB: 0.20,
  W3048_BETA_VOLATILITY: 0,
  W3048_BETA_TIME_CHAINLINK: 0.20,

  // Fair-value and lot-aware pair caps are enforced economic limits. An
  // above-$1 complement remains possible only through the separately scored
  // signal-supported loss-cap branch.
  W3048_EDGE_BUFFER: 0.005,
  W3048_MIN_EXPECTED_EDGE_START: 0.0025,
  W3048_MIN_EXPECTED_EDGE_END: 0.010,
  W3048_MAKER_EDGE_DISCOUNT: 0.0025,
  W3048_PAIR_PROFIT_TARGET: 0.060,
  W3048_INVENTORY_PENALTY_MAX: 0.04,

  // Projected full-parent risk limits tighten into the final active minute.
  W3048_MAX_LEAN_START: 500,
  W3048_MAX_LEAN_END: 350,
  W3048_LOSS_LIMIT_START: 250,
  W3048_LOSS_LIMIT_END: 150,
  W3048_MAX_WINDOW_SPEND: 650,

  // Directional residuals may temporarily spend payout already accumulated,
  // but cannot erase an unbounded amount of it. Complement repairs that raise
  // the floor are naturally admitted by the same projected-state check.
  W3048_FLOOR_DRAWDOWN_START: 100,
  W3048_FLOOR_DRAWDOWN_END: 60,
};

const EPS = 1e-9;
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const opposite = (side) => side === "Up" ? "Down" : "Up";
const sideSign = (side) => side === "Up" ? 1 : -1;
const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
const logit = (p) => Math.log(clamp(Number(p), 0.01, 0.99) / (1 - clamp(Number(p), 0.01, 0.99)));
const z = (value, scale) => clamp(Number(value) / Math.max(EPS, Number(scale)), -4, 4);

function rows(levels, ascending) {
  return (Array.isArray(levels) ? levels : []).map((row) => ({
    price: Number(Array.isArray(row) ? row[0] : row?.price),
    size: Number(Array.isArray(row) ? row[1] : row?.size),
  })).filter((row) => finite(row.price) && finite(row.size) && row.size > 0)
    .sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
}

function bookSnapshot(book) {
  const asks = rows(book?.asks, true);
  const bids = rows(book?.bids, false);
  const ask = finite(book?.bestAsk) ? Number(book.bestAsk) : asks[0]?.price;
  const bid = finite(book?.bestBid) ? Number(book.bestBid) : bids[0]?.price;
  if (!finite(ask) || !finite(bid)) return null;
  const ask1 = asks[0]?.size ?? 0;
  const bid1 = bids[0]?.size ?? 0;
  const micro = ask1 + bid1 > EPS
    ? (bid1 * ask + ask1 * bid) / (bid1 + ask1)
    : (ask + bid) / 2;
  const askDepth1 = asks[0]?.size ?? 0;
  const bidDepth1 = bids[0]?.size ?? 0;
  const askDepth3 = asks.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
  const bidDepth3 = bids.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
  return {
    ask, bid, mid: (ask + bid) / 2, micro, asks, bids,
    hasL2: book?.depthKnown === true || (asks.length >= 3 && bids.length >= 3),
    askDepth1, bidDepth1, askDepth3, bidDepth3,
    depthImbalance: (bidDepth3 - askDepth3) / Math.max(EPS, bidDepth3 + askDepth3),
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(EPS, bidDepth1 + askDepth1),
    micropriceBias: micro - (ask + bid) / 2,
  };
}

function depthThrough(asks, cap) {
  return asks.reduce((sum, row) => row.price <= cap + EPS ? sum + row.size : sum, 0);
}

function observationAt(history, targetMs) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ms <= targetMs) return history[i];
  }
  return null;
}

function floorTick(value, tick) {
  const t = Math.max(EPS, Number(tick));
  return +(Math.floor((Number(value) + EPS) / t) * t).toFixed(6);
}

function interpolate(start, end, progress) {
  return Number(start) + (Number(end) - Number(start)) * clamp(progress, 0, 1);
}

function init(state, P = STRAT) {
  state.placedThisTick = [];
  state.orders ||= [];
  state.seq ||= 0;
  if (!state.wallet3048) {
    const prices = [];
    for (let px = Number(P.W3048_MIN_PRICE); px <= Number(P.W3048_MAX_PRICE) + EPS;
      px += Number(P.W3048_TICK)) prices.push(+px.toFixed(2));
    state.wallet3048 = {
      up: 0,
      down: 0,
      cost: 0,
      fees: 0,
      peakWorstCase: 0,
      lots: { Up: [], Down: [] },
      history: [],
      polyHistory: [],
      bookTrace: { Up: [], Down: [] },
      askRun: { Up: null, Down: null },
      fillCursor: 0,
      lastActionMs: -Infinity,
      lastFiredSide: null,
      lastFired: { Up: null, Down: null },
      actions: 0,
      pending: new Map(),
      // Simulation representation of the T-90 signed menu. The live platform
      // remains code-locked to simulation, so no private signature is created.
      preparedMenu: { leadMs: Number(P.W3048_PREPARE_LEAD_MS),
        sizes: [Number(P.W3048_SMALL_SIZE), Number(P.W3048_LARGE_SIZE)],
        prices, orderType: "GTC", postOnly: false },
    };
  }
  syncRecordedFills(state, state.wallet3048);
  return state.wallet3048;
}

function applyFill(model, side, shares, price, taker = true) {
  const qty = Number(shares);
  const px = Number(price);
  if (!(qty > EPS) || !finite(px)) return;
  const other = opposite(side);
  let left = qty;
  while (left > EPS && model.lots[other].length) {
    const lot = model.lots[other][0];
    const take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    if (lot.shares <= EPS) model.lots[other].shift();
  }
  const feePerShare = taker ? fillFee(px, 1, true) : 0;
  if (left > EPS) model.lots[side].push({ shares: left, effectivePrice: px + feePerShare });
  if (side === "Up") model.up += qty; else model.down += qty;
  model.cost += qty * px;
  model.fees += qty * feePerShare;
  model.peakWorstCase = Math.max(Number(model.peakWorstCase) || 0,
    Math.min(model.up, model.down) - model.cost - model.fees);
}

function syncRecordedFills(state, model) {
  const fills = Array.isArray(state.fills) ? state.fills : [];
  // A restored window can replace its fill array. Rebuild rather than silently
  // skipping inventory if the cursor is no longer valid.
  if (model.fillCursor > fills.length) {
    model.up = 0; model.down = 0; model.cost = 0; model.fees = 0; model.peakWorstCase = 0;
    model.lots = { Up: [], Down: [] }; model.fillCursor = 0;
  }
  while (model.fillCursor < fills.length) {
    const fill = fills[model.fillCursor++];
    if (fill?.leg === "merge" || !["Up", "Down"].includes(fill?.side)) continue;
    applyFill(model, fill.side, Number(fill.shares), Number(fill.effPx), fill.maker !== true);
  }
}

function firstLotCost(lots, shares) {
  let left = Number(shares), used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take; used += take; cost += take * lot.effectivePrice;
    if (left <= EPS) break;
  }
  return used >= Number(shares) - EPS && used > EPS ? cost / used : null;
}

function traceAt(trace, targetMs) {
  for (let i = trace.length - 1; i >= 0; i--) if (trace[i].ms <= targetMs) return trace[i];
  return null;
}

function releaseFeatures(model, side, book, clockMs, P) {
  const trace = model.bookTrace[side];
  const previous = trace.at(-1);
  if (!model.askRun[side] || Math.abs(model.askRun[side].ask - book.ask) > Number(P.W3048_TICK) / 2) {
    model.askRun[side] = { ask: book.ask, sinceMs: clockMs };
  }
  const row = { ms: clockMs, ask: book.ask, bid: book.bid, askDepth3: book.askDepth3 };
  if (previous?.ms === clockMs) trace[trace.length - 1] = row; else trace.push(row);
  while (trace.length && trace[0].ms < clockMs - 31_000) trace.shift();
  const prior1 = traceAt(trace, clockMs - 1_000);
  const depletion1 = prior1 ? book.askDepth3 - prior1.askDepth3 : 0;
  const askMove1 = prior1 ? book.ask - prior1.ask : 0;
  const bidMove1 = prior1 ? book.bid - prior1.bid : 0;
  const executableRunMs = Math.max(0, clockMs - model.askRun[side].sinceMs);

  const representative = book.hasL2
    && executableRunMs >= Number(P.W3048_EXECUTABLE_RUN_MS)
    && book.askDepth1 <= Number(P.W3048_RELEASE_ASK1_MAX)
    && book.askDepth3 <= Number(P.W3048_RELEASE_ASK3_MAX)
    && depletion1 <= Number(P.W3048_RELEASE_DEPLETION1_MAX);
  const pressure = book.hasL2
    && book.askDepth3 <= Number(P.W3048_PRESSURE_ASK3_MAX)
    && book.depthImbalance >= Number(P.W3048_PRESSURE_IMBALANCE_MIN)
    && depletion1 <= Number(P.W3048_PRESSURE_DEPLETION1_MAX);
  // Persisted live tick files contain BBA rather than L2. Keep their fallback
  // causal and narrower than firing repeatedly on every stable quote.
  const bbaPressure = !book.hasL2
    && executableRunMs >= Number(P.W3048_EXECUTABLE_RUN_MS)
    && (askMove1 <= -Number(P.W3048_BBA_MOVE_MIN) + EPS
      || bidMove1 >= Number(P.W3048_BBA_MOVE_MIN) - EPS);
  const passes = P.W3048_RELEASE_GATE === false || representative || pressure || bbaPressure;
  const spread = Math.max(Number(P.W3048_TICK), book.ask - book.bid);
  const liquidityScore = book.hasL2
    ? (Number(P.W3048_RELEASE_ASK3_MAX) - book.askDepth3) / Math.max(1, Number(P.W3048_RELEASE_ASK3_MAX))
      + 2 * book.depthImbalance
      - depletion1 / Math.max(1, Math.abs(Number(P.W3048_PRESSURE_DEPLETION1_MAX)))
      + book.micropriceBias / spread
    : (-askMove1 + bidMove1) / Math.max(EPS, Number(P.W3048_BBA_MOVE_MIN));
  return { passes, representative, pressure, bbaPressure, executableRunMs, depletion1,
    askMove1, bidMove1, liquidityScore };
}

function realizedVol(history, lookbackMs) {
  const cutoff = history.at(-1)?.ms - Number(lookbackMs);
  const points = history.filter((row) => row.ms >= cutoff && row.bz > 0);
  if (points.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < points.length; i++) returns.push(Math.log(points[i].bz / points[i - 1].bz));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
}

export function buildFeatures(model, tk, P, clockMs, upBook = bookSnapshot(tk?.up), downBook = bookSnapshot(tk?.down)) {
  if (!upBook || !downBook || !(Number(tk?.bzPrice) > 0) || !(Number(tk?.openBinance) > 0)) return null;
  // The Binance websocket can be unchanged across many faster CLOB messages.
  // Keep the upstream timestamp and distinct price updates so CLOB heartbeats
  // cannot manufacture a momentum observation.
  const sourceMs = finite(tk?.binanceAtMs) ? Math.min(clockMs, Number(tk.binanceAtMs)) : clockMs;
  const current = { ms: sourceMs, bz: Number(tk.bzPrice),
    cl: Number(tk?.clPrice) > 0 ? Number(tk.clPrice) : null };
  const last = model.history.at(-1);
  if (!last || last.ms !== current.ms || last.bz !== current.bz) model.history.push(current);
  while (model.history.length && model.history[0].ms < sourceMs - Math.max(60000, Number(P.W3048_VOL_LOOKBACK_MS))) {
    model.history.shift();
  }
  const prior = observationAt(model.history, sourceMs - Number(P.W3048_MOMENTUM_LOOKBACK_MS));
  let priorDistinct = null;
  for (let i = model.history.length - 2; i >= 0; i--) {
    if (Math.abs(model.history[i].bz - current.bz) > EPS) { priorDistinct = model.history[i]; break; }
  }
  const momentumFast = prior?.bz > 0 ? Math.log(current.bz / prior.bz) : 0;
  const latestUpdate = priorDistinct?.bz > 0 ? Math.log(current.bz / priorDistinct.bz) : 0;
  // Direction is deliberately the full 2.5-second move. A last-tick bounce
  // may confirm persistence, but it cannot replace a flat/opposing 2.5s trend.
  const momentumSignal = momentumFast;
  const binanceDisplacement = Math.log(current.bz / Number(tk.openBinance));
  const chainlinkDisplacement = current.cl > 0 && Number(tk?.openChainlink) > 0
    ? Math.log(current.cl / Number(tk.openChainlink)) : 0;
  const relativeLead = binanceDisplacement - chainlinkDisplacement;
  const upMicroProbability = clamp(upBook.micro / Math.max(EPS, upBook.micro + downBook.micro), 0.01, 0.99);
  const clobDepthSignal = clamp((upBook.depthImbalance - downBook.depthImbalance) / 2, -1, 1);
  model.polyHistory ||= [];
  const polyCurrent = { ms: clockMs, up: upBook.micro, down: downBook.micro };
  const lastPoly = model.polyHistory.at(-1);
  if (!lastPoly || lastPoly.ms !== clockMs || lastPoly.up !== polyCurrent.up
    || lastPoly.down !== polyCurrent.down) model.polyHistory.push(polyCurrent);
  while (model.polyHistory.length && model.polyHistory[0].ms < clockMs - 60_000) {
    model.polyHistory.shift();
  }
  const polyPrior = observationAt(model.polyHistory,
    clockMs - Number(P.W3048_POLY_LOOKBACK_MS));
  const polyUpMove = polyPrior ? upBook.micro - polyPrior.up : null;
  const polyDownMove = polyPrior ? downBook.micro - polyPrior.down : null;
  const direction = Math.abs(momentumSignal) >= Number(P.W3048_MOMENTUM_MIN_ABS)
    ? (momentumSignal > 0 ? "Up" : "Down") : null;
  const directionPolyMove = direction === "Up" ? polyUpMove
    : direction === "Down" ? polyDownMove : null;
  const lagAligned = direction != null && directionPolyMove != null
    && directionPolyMove <= Number(P.W3048_POLY_LAG_MAX_MOVE) + EPS;
  const latestAligned = direction != null
    && Math.abs(latestUpdate) >= Number(P.W3048_STRONG_LATEST_UPDATE_MIN_ABS) - EPS
    && Math.sign(latestUpdate) === sideSign(direction);
  const strongCatchup = lagAligned
    && Math.abs(momentumSignal) >= Number(P.W3048_STRONG_MOMENTUM_MIN_ABS) - EPS
    && latestAligned;
  return {
    momentumFast,
    // Backward-compatible diagnostic key; the value follows the implemented
    // operator policy's full 2.5-second Binance catch-up horizon.
    momentum5s: momentumFast,
    latestUpdate,
    momentumSignal,
    binanceDisplacement,
    chainlinkDisplacement,
    relativeLead,
    clobUpProbability: upMicroProbability,
    clobDepthSignal,
    polyUpMove,
    polyDownMove,
    lagDirection: lagAligned ? direction : null,
    lagAligned,
    latestAligned,
    strongCatchup,
    volatility: realizedVol(model.history, P.W3048_VOL_LOOKBACK_MS),
    timeProgress: clamp(Number(tk.t) / Math.max(1, Number(P.W3048_STOP_S)), 0, 1),
  };
}

export function fairProbability(features, P = STRAT) {
  if (!features) return null;
  const chainZ = z(features.chainlinkDisplacement, P.W3048_CHAINLINK_DISTANCE_SCALE);
  const score = Number(P.W3048_BETA0)
    + Number(P.W3048_BETA_MARKET_LOGIT) * logit(features.clobUpProbability)
    + Number(P.W3048_BETA_MOMENTUM) * z(features.momentumFast, P.W3048_MOMENTUM_SCALE)
    + Number(P.W3048_BETA_LATEST_UPDATE) * z(features.latestUpdate, P.W3048_LATEST_UPDATE_SCALE)
    + Number(P.W3048_BETA_RELATIVE_LEAD) * z(features.relativeLead, P.W3048_RELATIVE_LEAD_SCALE)
    + Number(P.W3048_BETA_CHAINLINK_DISTANCE) * chainZ
    + Number(P.W3048_BETA_CLOB) * features.clobDepthSignal
    + Number(P.W3048_BETA_VOLATILITY) * z(features.volatility, P.W3048_VOL_SCALE)
    + Number(P.W3048_BETA_TIME_CHAINLINK) * features.timeProgress * chainZ;
  return clamp(sigmoid(score), 0.01, 0.99);
}

function pendingReservations(state) {
  const out = { Up: 0, Down: 0, UpCost: 0, DownCost: 0, cost: 0, count: 0 };
  for (const pending of (state.pendingFills || [])) {
    const rec = pending?.rec;
    if (!rec || !["Up", "Down"].includes(rec.side)) continue;
    const shares = pending.phase === "resting" ? Number(pending.remaining)
      : Number(rec.requestedShares ?? rec.shares);
    if (!(shares > EPS)) continue;
    const px = Number(rec.limitPx);
    if (!finite(px)) continue;
    const reservationCost = shares * (px + fillFee(px, 1, true));
    out[rec.side] += shares;
    out[`${rec.side}Cost`] += reservationCost;
    out.cost += reservationCost;
    out.count++;
  }
  return out;
}

// Resting-maker simulation accrues queue-credit fills before the execution
// harness flushes one aggregated fill record. Those shares are already filled,
// so decisions must treat them as confirmed inventory rather than making them
// disappear between `remaining` and the recorded-fill ledger.
function decisionInventory(model, state) {
  const view = { ...model, lots: {
    Up: model.lots.Up.map((lot) => ({ ...lot })),
    Down: model.lots.Down.map((lot) => ({ ...lot })),
  } };
  for (const pending of (state.pendingFills || [])) {
    if (pending?.phase !== "resting") continue;
    const rec = pending.rec;
    const shares = Number(pending.makerShares);
    const price = Number(rec?.limitPx);
    if (!(shares > EPS) || !finite(price) || !["Up", "Down"].includes(rec?.side)) continue;
    applyFill(view, rec.side, shares, price, false);
  }
  return view;
}

function riskCheck(model, state, side, size, cap, P, progress) {
  const reserved = pendingReservations(state);
  const feePerShare = fillFee(cap, 1, true);
  // Pending GTC orders are optional future fills, not guaranteed hedges. Test
  // all fill/no-fill corners so an unfilled complement cannot authorize a new
  // directional order that would breach risk by itself.
  const beforeUp = model.up;
  const beforeDown = model.down;
  const beforeCost = model.cost + model.fees;
  const beforeWorstCase = Math.min(beforeUp, beforeDown) - beforeCost;
  const beforeLean = Math.abs(beforeUp - beforeDown);
  const baseUp = model.up + (side === "Up" ? size : 0);
  const baseDown = model.down + (side === "Down" ? size : 0);
  const baseCost = model.cost + model.fees + size * (cap + feePerShare);
  const scenarios = [];
  for (const takeUp of [false, true]) for (const takeDown of [false, true]) {
    const nextUp = baseUp + (takeUp ? reserved.Up : 0);
    const nextDown = baseDown + (takeDown ? reserved.Down : 0);
    const nextCost = baseCost + (takeUp ? reserved.UpCost : 0) + (takeDown ? reserved.DownCost : 0);
    scenarios.push({ nextUp, nextDown, nextCost,
      worstCase: Math.min(nextUp, nextDown) - nextCost,
      lean: Math.abs(nextUp - nextDown) });
  }
  const worstCase = Math.min(...scenarios.map((row) => row.worstCase));
  const lean = Math.max(...scenarios.map((row) => row.lean));
  const leanLimit = interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress);
  const lossLimit = interpolate(P.W3048_LOSS_LIMIT_START, P.W3048_LOSS_LIMIT_END, progress);
  const spend = model.cost + reserved.cost + size * cap;
  const spendLimit = Number(P.W3048_MAX_WINDOW_SPEND);
  const peakWorstCase = Math.max(Number(model.peakWorstCase) || 0, beforeWorstCase);
  const floorDrawdownLimit = interpolate(P.W3048_FLOOR_DRAWDOWN_START,
    P.W3048_FLOOR_DRAWDOWN_END, progress);
  const floorBudgetPass = worstCase >= peakWorstCase - floorDrawdownLimit - EPS;
  return { passes: lean <= leanLimit + EPS && worstCase >= -lossLimit - EPS
      && spend <= spendLimit + EPS && floorBudgetPass,
    worstCase, lean, leanLimit, lossLimit, spend, spendLimit, reserved,
    beforeUp, beforeDown, beforeCost, beforeWorstCase, beforeLean, scenarios,
    peakWorstCase, floorDrawdownLimit, floorBudgetPass };
}

function economicCaps(model, side, book, fair, size, P, progress) {
  const imbalance = model.up - model.down;
  const oriented = imbalance * sideSign(side);
  const isComplement = oriented < -EPS;
  const feeAtAsk = fillFee(book.ask, 1, true);
  const leanScale = Math.max(1, interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress));
  const inventoryPenalty = oriented > 0
    ? Number(P.W3048_INVENTORY_PENALTY_MAX) * clamp(oriented / leanScale, 0, 1)
    : 0;
  const signalCapMaker = fair - Number(P.W3048_EDGE_BUFFER) - inventoryPenalty;
  const signalCapTaker = signalCapMaker - feeAtAsk;
  let pairCapMaker = null;
  let oppositeCost = null;
  let matchedShares = 0;
  if (isComplement) {
    matchedShares = Math.min(size, Math.abs(imbalance));
    oppositeCost = firstLotCost(model.lots[opposite(side)], matchedShares);
    if (oppositeCost != null) {
      pairCapMaker = 1 - oppositeCost - Number(P.W3048_PAIR_PROFIT_TARGET);
    }
  }
  // Cheap pair completion uses the lot-aware pair cap. If the ask is above
  // that cap, it is a distinct loss-cap repair and must stand on signal/risk
  // economics instead of pretending the marginal pair is profitable.
  const pairCapTaker = pairCapMaker == null ? null : pairCapMaker - feeAtAsk;
  const pairingIntended = isComplement && pairCapMaker != null && book.ask <= pairCapMaker + EPS;
  const takerEconomicCap = pairingIntended ? Math.min(signalCapTaker, pairCapTaker) : signalCapTaker;
  const makerEconomicCap = pairingIntended ? Math.min(signalCapMaker, pairCapMaker) : signalCapMaker;
  const configuredMax = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? P.W3048_MAX_PRICE));
  const crossCeiling = book.ask + Number(P.W3048_CROSS_HEADROOM_TICKS) * Number(P.W3048_TICK);
  const canTake = takerEconomicCap >= book.ask - EPS;
  const economicCap = canTake ? takerEconomicCap : makerEconomicCap;
  const roleCeiling = canTake ? crossCeiling : book.ask - Number(P.W3048_TICK);
  const cap = floorTick(Math.min(configuredMax, economicCap, roleCeiling), P.W3048_TICK);
  const marketable = cap >= book.ask - EPS;
  const expectedPx = marketable ? book.ask : cap;
  const feePerShare = marketable ? fillFee(expectedPx, 1, true) : 0;
  const signalCap = marketable ? signalCapTaker : signalCapMaker;
  const pairCap = marketable ? pairCapTaker : pairCapMaker;
  return { imbalance, oriented, isComplement, matchedShares,
    matchedFraction: matchedShares / Math.max(EPS, size), inventoryPenalty, signalCap, pairCap,
    signalCapMaker, signalCapTaker, pairCapMaker, pairCapTaker,
    oppositeCost, pairingIntended, economicCap, cap, marketable, expectedPx, feePerShare };
}

function candidateFor(model, state, side, book, release, fair, features, P, progress, clockMs,
  momentumAligned, lagAligned) {
  const lastFired = model.lastFired[side];
  if (model.lastFiredSide === side && lastFired
    && clockMs - lastFired.ms < Number(P.W3048_SAME_SIDE_RETRY_MS)
    && Math.abs(book.ask - lastFired.ask) < Number(P.W3048_SAME_SIDE_REPRICE) - EPS) return null;
  const small = Number(P.W3048_SMALL_SIZE);
  const large = Number(P.W3048_LARGE_SIZE);
  const reservedSameSide = pendingReservations(state)[side];
  const evaluate = (size, mode = "ordinary") => {
    let caps = economicCaps(model, side, book, fair, size, P, progress);
    // A pending order on the complement side already owns this repair job.
    // Do not submit another standard/reservoir parent against the same confirmed
    // shortage; its full fill would turn a small hedge into an opposite lean.
    if (caps.isComplement && reservedSameSide >= Math.abs(caps.imbalance) - EPS) return null;
    if (mode === "reservoir") {
      if (!caps.isComplement || caps.pairCapMaker == null) return null;
      const configuredMax = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? P.W3048_MAX_PRICE));
      const passiveCeiling = book.ask - Number(P.W3048_TICK);
      const cap = floorTick(Math.min(configuredMax, caps.signalCapMaker,
        caps.pairCapMaker, passiveCeiling), P.W3048_TICK);
      if (cap < Number(P.W3048_MIN_PRICE) - EPS) return null;
      const matchedShares = Math.min(size, Math.abs(caps.imbalance));
      caps = { ...caps, cap, marketable: false, expectedPx: cap, feePerShare: 0,
        signalCap: caps.signalCapMaker, pairCap: caps.pairCapMaker,
        economicCap: Math.min(caps.signalCapMaker, caps.pairCapMaker),
        pairingIntended: true, matchedShares,
        matchedFraction: matchedShares / Math.max(EPS, size) };
    }
    if (caps.cap < Number(P.W3048_MIN_PRICE) - EPS || caps.cap > Number(P.W3048_MAX_PRICE) + EPS) return null;
    const visibleDepth = depthThrough(book.asks, caps.cap);
    const risk = riskCheck(model, state, side, size, caps.cap, P, progress);
    if (!risk.passes) return null;
    const expectedEdge = fair - caps.expectedPx - caps.feePerShare;
    const pairEdge = caps.oppositeCost == null ? -Infinity
      : 1 - caps.oppositeCost - caps.expectedPx - caps.feePerShare;
    const worstCaseImprovement = risk.worstCase - risk.beforeWorstCase;
    const riskReliefPerShare = Math.max(0, worstCaseImprovement / size);
    const riskWeight = interpolate(P.W3048_RISK_RELIEF_WEIGHT_START,
      P.W3048_RISK_RELIEF_WEIGHT_END, progress);
    const riskAdjustedEdge = expectedEdge + riskWeight * riskReliefPerShare;
    const minEdge = Math.max(0, interpolate(P.W3048_MIN_EXPECTED_EDGE_START,
      P.W3048_MIN_EXPECTED_EDGE_END, progress)
      - (caps.marketable ? 0 : Number(P.W3048_MAKER_EDGE_DISCOUNT)));
    const hasPosition = model.up + model.down > EPS;
    const sameSideMinimum = minEdge + (hasPosition && !caps.isComplement
      ? Number(P.W3048_SAME_SIDE_EXTRA_EDGE) : 0);
    const complementMinimum = minEdge + (caps.pairingIntended
      ? 0 : Number(P.W3048_LOSS_CAP_EXTRA_EDGE));
    const ordinaryEconomicPass = caps.isComplement
      ? (caps.pairingIntended ? pairEdge >= complementMinimum - EPS
        : riskAdjustedEdge >= complementMinimum - EPS)
      : expectedEdge >= sameSideMinimum - EPS;
    const emergencyGeometry = size === large && caps.isComplement && !caps.pairingIntended && caps.marketable
      && risk.beforeLean >= Math.max(Number(P.W3048_EMERGENCY_MIN_LEAN), large / 2) - EPS
      && risk.lean < risk.beforeLean - EPS
      && worstCaseImprovement > EPS;
    const emergencyPass = emergencyGeometry
      && riskAdjustedEdge >= Number(P.W3048_EMERGENCY_MIN_RISK_ADJUSTED_EDGE) - EPS;
    const reservoirGeometry = mode === "reservoir" && caps.isComplement
      && risk.beforeLean >= Math.max(Number(P.W3048_RESERVOIR_MIN_LEAN), size / 2) - EPS
      && risk.lean < risk.beforeLean - EPS
      && worstCaseImprovement > EPS;
    const reservoirPass = reservoirGeometry
      && pairEdge >= Number(P.W3048_RESERVOIR_MIN_PAIR_EDGE) - EPS;
    if (!ordinaryEconomicPass && !emergencyPass && !reservoirPass) return null;
    const pairCost = caps.oppositeCost == null ? null
      : caps.oppositeCost + caps.expectedPx + caps.feePerShare;
    const pairWeight = interpolate(P.W3048_PAIR_VALUE_WEIGHT_START,
      P.W3048_PAIR_VALUE_WEIGHT_END, progress);
    const liquidityRank = clamp(release.liquidityScore,
      -Number(P.W3048_LIQUIDITY_RANK_CAP), Number(P.W3048_LIQUIDITY_RANK_CAP));
    const utility = expectedEdge - caps.inventoryPenalty
      + pairWeight * Math.max(0, pairEdge) * caps.matchedFraction
      + riskWeight * riskReliefPerShare
      + Number(P.W3048_FILL_PROB_WEIGHT) * liquidityRank;
    return { side, size, fair, ask: book.ask, ...caps, pairCost, expectedEdge,
      pairEdge, riskAdjustedEdge, minEdge, utility, worstCaseImprovement,
      ordinaryEconomicPass, emergencyGeometry, emergencyPass,
      reservoirGeometry, reservoirPass,
      visibleDepth, risk, release };
  };

  const largeCandidate = evaluate(large);
  const largeDeepEnough = largeCandidate?.marketable
    && largeCandidate.visibleDepth >= Number(P.W3048_LARGE_MIN_DEPTH) - EPS;
  // Emergency correction is allowed to bypass the ordinary microstructure
  // release gate because waiting preserves the risk it is intended to remove.
  if (largeCandidate?.emergencyPass && largeDeepEnough) {
    return { ...largeCandidate, sizeMode: "inventory-emergency" };
  }
  const reservoirCandidate = evaluate(large, "reservoir");
  const ordinary = evaluate(small);
  if (!ordinary) {
    return reservoirCandidate?.reservoirPass
      ? { ...reservoirCandidate, sizeMode: "passive-reservoir" } : null;
  }
  const hasPosition = model.up + model.down > EPS;
  const overlayPass = !hasPosition || ordinary.isComplement || (P.W3048_DIRECTIONAL_OVERLAY_ON === true
    && momentumAligned
    && ordinary.expectedEdge >= Number(P.W3048_OVERLAY_MIN_EXPECTED_EDGE) - EPS);
  if (!overlayPass) return null;
  // A fast Binance move precedes the wallet's taker fill and the resulting L2
  // depth drop. Requiring that drop first would be a causal inversion. Stable
  // taker attempts still need fast-side alignment; below-ask maker intents can
  // rest patiently on their economic cap.
  if (!release.passes && ordinary.marketable && !momentumAligned) return null;
  // The 150 template is not a generic edge multiplier. It has two additional
  // non-emergency uses: completing 150 profitable FIFO pairs in one executable
  // action, or exploiting a strong, persistent 2.5s Binance/Poly catch-up.
  const strength = Math.max(ordinary.expectedEdge,
    Number.isFinite(ordinary.pairEdge) ? ordinary.pairEdge : -Infinity);
  const strongEnough = strength >= Number(P.W3048_LARGE_EDGE) - EPS;
  const profitableLargePair = largeDeepEnough && largeCandidate?.pairingIntended
    && largeCandidate.matchedShares >= large - EPS
    && largeCandidate.pairEdge >= largeCandidate.minEdge - EPS;
  if (profitableLargePair) return { ...largeCandidate, sizeMode: "large-pair-completion" };
  if (reservoirCandidate?.reservoirPass) {
    return { ...reservoirCandidate, sizeMode: "passive-reservoir" };
  }
  const strongCatchup = hasPosition && largeDeepEnough && !largeCandidate?.isComplement
    && lagAligned && features.strongCatchup && strongEnough;
  if (strongCatchup) return { ...largeCandidate, sizeMode: "strong-catchup" };
  const strongOverlay = P.W3048_DIRECTIONAL_OVERLAY_ON === true
    && hasPosition && largeDeepEnough && !largeCandidate?.isComplement
    && momentumAligned
    && largeCandidate.risk.peakWorstCase >= Number(P.W3048_STRONG_OVERLAY_MIN_PEAK_FLOOR) - EPS
    && Math.abs(features.momentumSignal) >= Number(P.W3048_STRONG_MOMENTUM_MIN_ABS) - EPS
    && strongEnough;
  if (strongOverlay) return { ...largeCandidate, sizeMode: "strong-overlay" };
  return { ...ordinary, sizeMode: "standard" };
}

// Re-evaluate an already-resting GTC against the same current economic cap
// used for new orders. This models the report's keep/cancel/reprice rule; it
// deliberately does not infer unavailable historical CLOB cancellation data.
export function shouldCancelResting(state, rec, tk, P = STRAT,
  clockMs = Number(tk?.t) * 1000) {
  if (!rec || !["Up", "Down"].includes(rec.side)) return { cancel: false };
  if (Number(tk?.t) >= Number(P.W3048_STOP_S)) return { cancel: true, reason: "final-30s-cutoff" };
  const model = init(state, P);
  const upBook = bookSnapshot(tk?.up), downBook = bookSnapshot(tk?.down);
  if (!upBook || !downBook) return { cancel: false, reason: "no-book" };
  const features = buildFeatures(model, tk, P, clockMs, upBook, downBook);
  if (!features) return { cancel: false, reason: "no-features" };
  const fastMagnitude = Math.abs(features.momentumSignal);
  const fastSide = fastMagnitude >= Number(P.W3048_CANCEL_REVERSAL_MIN_ABS)
    ? (features.momentumSignal > 0 ? "Up" : "Down") : null;
  const directionalIntent = rec.reason === "w3048-initial-catchup"
    || rec.reason === "w3048-initial-value"
    || rec.reason === "w3048-strong-catchup"
    || rec.reason === "w3048-strong-overlay"
    || rec.reason === "w3048-directional-reinforcement";
  if (directionalIntent && fastSide && fastSide !== rec.side) {
    return { cancel: true, reason: "fast-signal-reversed" };
  }
  const fairUp = fairProbability(features, P);
  const sideBook = rec.side === "Up" ? upBook : downBook;
  const fair = rec.side === "Up" ? fairUp : 1 - fairUp;
  const progress = clamp((Number(tk.t) - Number(P.W3048_START_S))
    / Math.max(1, Number(P.W3048_STOP_S) - Number(P.W3048_START_S)), 0, 1);
  const size = Math.max(EPS, Number(rec.requestedShares ?? rec.shares));
  const caps = economicCaps(model, rec.side, sideBook, fair, size, P, progress);
  const slack = Number(P.W3048_CANCEL_CAP_SLACK_TICKS) * Number(P.W3048_TICK);
  const orderPx = Number(rec.limitPx);
  const cancel = !finite(caps.cap) || caps.cap < Number(P.W3048_MIN_PRICE) - EPS
    || orderPx > caps.cap + slack + EPS;
  return { cancel, reason: cancel ? "economic-cap-moved" : "within-economic-cap",
    currentCap: caps.cap, signalCap: caps.signalCap, pairCap: caps.pairCap };
}

export function validateParams(P = STRAT) {
  if (!(Number(P.W3048_SMALL_SIZE) > 0) || !(Number(P.W3048_LARGE_SIZE) >= Number(P.W3048_SMALL_SIZE))) {
    throw new Error("wallet3048 sizes must be positive and large >= small");
  }
  if (!(Number(P.W3048_START_S) >= 0) || !(Number(P.W3048_STOP_S) > Number(P.W3048_START_S))
    || Number(P.W3048_STOP_S) > Number(P.WINDOW_SEC || 300)) {
    throw new Error("wallet3048 active time range is invalid");
  }
  if (!(Number(P.W3048_MOMENTUM_LOOKBACK_MS) >= 1000)
    || !(Number(P.W3048_MOMENTUM_LOOKBACK_MS) <= 5000)) {
    throw new Error("wallet3048 Binance catch-up lookback must be between 1000ms and 5000ms");
  }
  if (!(Number(P.W3048_POLY_LOOKBACK_MS) >= 1000)
    || !(Number(P.W3048_POLY_LOOKBACK_MS) <= 5000)) {
    throw new Error("wallet3048 Polymarket lag lookback must be between 1000ms and 5000ms");
  }
  if (!(Number(P.W3048_STRONG_MOMENTUM_MIN_ABS) >= Number(P.W3048_MOMENTUM_MIN_ABS))) {
    throw new Error("wallet3048 strong momentum threshold must be >= normal threshold");
  }
  if (!(Number(P.W3048_EMERGENCY_MIN_LEAN) >= Number(P.W3048_LARGE_SIZE) / 2)) {
    throw new Error("wallet3048 emergency lean floor must be >= half the large order");
  }
  if (!(Number(P.W3048_RESERVOIR_MIN_LEAN) >= Number(P.W3048_LARGE_SIZE) / 2)) {
    throw new Error("wallet3048 reservoir lean floor must be >= half the large order");
  }
  if (!(Number(P.W3048_FLOOR_DRAWDOWN_START) >= 0)
    || !(Number(P.W3048_FLOOR_DRAWDOWN_END) >= 0)) {
    throw new Error("wallet3048 floor drawdown budgets must be non-negative");
  }
  if (!(Number(P.W3048_MAX_PENDING) >= 1)) throw new Error("wallet3048 max pending must be >= 1");
  return true;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = Number(tk?.t) * 1000) {
  const model = init(state, P);
  if (!P.W3048_ON) { state.gateReason = "w3048-off"; return []; }
  if (!tk?.up || !tk?.down) { state.gateReason = "w3048-no-book"; return []; }
  const upBook = bookSnapshot(tk.up), downBook = bookSnapshot(tk.down);
  if (!upBook || !downBook) { state.gateReason = "w3048-no-bba"; return []; }
  const depthTimes = [tk.up.depthTs, tk.down.depthTs].filter(finite).map(Number);
  if (depthTimes.length && clockMs - Math.min(...depthTimes) > Number(P.W3048_DEPTH_STALE_MS)) {
    state.gateReason = "w3048-stale-depth"; return [];
  }
  const features = buildFeatures(model, tk, P, clockMs, upBook, downBook);
  if (!features) { state.gateReason = "w3048-features"; return []; }
  // Update the release traces on every eligible book update, including while
  // an earlier GTC is cooling down or awaiting its fill/cancel response.
  const upRelease = releaseFeatures(model, "Up", upBook, clockMs, P);
  const downRelease = releaseFeatures(model, "Down", downBook, clockMs, P);
  // Warm the full 2.5-second Binance and Polymarket histories before entries
  // are enabled. Otherwise a T+4 start could not evaluate the intended lag.
  const latestDecisionS = Number(P.W3048_STOP_S) - Math.max(0, Number(P.LATENCY_MS) || 0) / 1000;
  if (Number(tk.t) < Number(P.W3048_START_S) || Number(tk.t) >= latestDecisionS) {
    state.gateReason = "w3048-time"; return [];
  }
  if (model.actions >= Number(P.W3048_MAX_ACTIONS)) { state.gateReason = "w3048-action-cap"; return []; }
  if (clockMs - model.lastActionMs < Number(P.W3048_COOLDOWN_MS)) { state.gateReason = "w3048-cooldown"; return []; }
  const pendingCount = Math.max(model.pending.size, pendingReservations(state).count);
  if (pendingCount >= Number(P.W3048_MAX_PENDING)) { state.gateReason = "w3048-pending-cap"; return []; }
  const fairUp = fairProbability(features, P);
  const progress = clamp((Number(tk.t) - Number(P.W3048_START_S))
    / Math.max(1, Number(P.W3048_STOP_S) - Number(P.W3048_START_S)), 0, 1);
  const inventory = decisionInventory(model, state);
  const hasPosition = inventory.up + inventory.down > EPS;
  if (!hasPosition && pendingCount > 0) {
    state.gateReason = "w3048-await-initial-fill";
    return [];
  }
  const fastMagnitude = Math.abs(features.momentumSignal);
  const momentumDirection = fastMagnitude >= Number(P.W3048_MOMENTUM_MIN_ABS)
    ? (features.momentumSignal > 0 ? "Up" : "Down") : null;
  const lagDirection = features.lagDirection;
  if (!hasPosition && (features.polyUpMove == null || features.polyDownMove == null)) {
    state.gateReason = "w3048-wait-lag-history";
    return [];
  }
  let candidates = [
    candidateFor(inventory, state, "Up", upBook, upRelease, fairUp, features, P, progress, clockMs,
      momentumDirection === "Up", lagDirection === "Up"),
    candidateFor(inventory, state, "Down", downBook, downRelease, 1 - fairUp, features, P, progress, clockMs,
      momentumDirection === "Down", lagDirection === "Down"),
  ].filter(Boolean);
  if (!hasPosition) {
    candidates = candidates.filter((candidate) => candidate.side === lagDirection
      || (candidate.expectedPx <= Number(P.W3048_INITIAL_MAX_PRICE) + EPS
        && candidate.expectedEdge >= Number(P.W3048_INITIAL_VALUE_EDGE) - EPS));
  }
  candidates.sort((a, b) => b.utility - a.utility || b.expectedEdge - a.expectedEdge
    || a.cap - b.cap || a.side.localeCompare(b.side));
  const chosen = candidates[0];
  if (!chosen) {
    state.gateReason = !hasPosition && !lagDirection
      ? (momentumDirection ? "w3048-wait-value-or-lag" : "w3048-wait-initial-value")
      : "w3048-no-economic-candidate";
    return [];
  }

  const oid = ++state.seq;
  const leg = chosen.isComplement ? "hedge" : "entry";
  const reason = chosen.sizeMode === "passive-reservoir" ? "w3048-passive-reservoir"
    : chosen.sizeMode === "inventory-emergency" ? "w3048-inventory-emergency"
    : chosen.sizeMode === "large-pair-completion" ? "w3048-large-pair-completion"
      : chosen.sizeMode === "strong-catchup" ? "w3048-strong-catchup"
        : chosen.sizeMode === "strong-overlay" ? "w3048-strong-overlay"
          : !hasPosition
            ? (chosen.side === lagDirection ? "w3048-initial-catchup" : "w3048-initial-value")
          : chosen.isComplement && chosen.pairingIntended ? "w3048-pair-completion"
            : chosen.isComplement ? "w3048-loss-cap-repair" : "w3048-directional-reinforcement";
  const rec = {
    tInto: Number(tk.t),
    side: chosen.side,
    shares: chosen.size,
    requestedShares: chosen.size,
    effPx: chosen.expectedPx,
    usdc: +(chosen.expectedPx * chosen.size).toFixed(4),
    exec: "marketable",
    limitPx: chosen.cap,
    kind: "gtc",
    orderType: "GTC",
    liveOrderType: "GTC",
    restTimeoutMs: chosen.sizeMode === "passive-reservoir"
      ? Number(P.W3048_RESERVOIR_TIMEOUT_MS) : Number(P.W3048_REST_TIMEOUT_MS),
    leg,
    reason,
    status: "open",
    oid,
    postOnly: false,
    prepared: true,
    preparedLeadMs: model.preparedMenu.leadMs,
    signal: {
      fairUp: +fairUp.toFixed(6),
      fairSide: +chosen.fair.toFixed(6),
      momentumFast: +features.momentumFast.toFixed(8),
      momentumLookbackMs: Number(P.W3048_MOMENTUM_LOOKBACK_MS),
      momentum5s: +features.momentum5s.toFixed(8),
      latestBinanceUpdate: +features.latestUpdate.toFixed(8),
      relativeLead: +features.relativeLead.toFixed(8),
      chainlinkDistance: +features.chainlinkDisplacement.toFixed(8),
      clobUpProbability: +features.clobUpProbability.toFixed(6),
      volatility: +features.volatility.toFixed(8),
      polyLookbackMs: Number(P.W3048_POLY_LOOKBACK_MS),
      polyUpMove: features.polyUpMove == null ? null : +features.polyUpMove.toFixed(6),
      polyDownMove: features.polyDownMove == null ? null : +features.polyDownMove.toFixed(6),
      lagDirection: features.lagDirection,
      strongCatchup: features.strongCatchup,
      momentumDirection,
      signalCap: +chosen.signalCap.toFixed(6),
      economicCap: +chosen.economicCap.toFixed(6),
      pairCap: chosen.pairCap == null ? null : +chosen.pairCap.toFixed(6),
      pairCost: chosen.pairCost == null ? null : +chosen.pairCost.toFixed(6),
      expectedEdge: +chosen.expectedEdge.toFixed(6),
      riskAdjustedEdge: +chosen.riskAdjustedEdge.toFixed(6),
      minimumEdge: +chosen.minEdge.toFixed(6),
      expectedRole: chosen.marketable ? "taker" : "maker",
      pairingIntended: chosen.pairingIntended,
      matchedShares: +chosen.matchedShares.toFixed(4),
      sizeMode: chosen.sizeMode,
      visibleDepth: +chosen.visibleDepth.toFixed(4),
      releaseMode: chosen.release.representative ? "thin-depletion"
        : chosen.release.pressure ? "depth-pressure"
          : chosen.release.bbaPressure ? "bba-pressure" : "disabled",
      executableRunMs: +chosen.release.executableRunMs.toFixed(1),
      askDepth1: +((chosen.side === "Up" ? upBook : downBook).askDepth1).toFixed(4),
      askDepth3: +((chosen.side === "Up" ? upBook : downBook).askDepth3).toFixed(4),
      depthImbalance: +((chosen.side === "Up" ? upBook : downBook).depthImbalance).toFixed(6),
      depletion1: +chosen.release.depletion1.toFixed(4),
      worstCaseImprovement: +chosen.worstCaseImprovement.toFixed(4),
      projectedWorstCase: +chosen.risk.worstCase.toFixed(4),
      projectedLean: +chosen.risk.lean.toFixed(4),
      priorLean: +chosen.risk.beforeLean.toFixed(4),
      peakWorstCase: +chosen.risk.peakWorstCase.toFixed(4),
      floorDrawdownLimit: +chosen.risk.floorDrawdownLimit.toFixed(4),
    },
  };
  model.lastActionMs = clockMs;
  model.lastFiredSide = chosen.side;
  model.lastFired[chosen.side] = { ms: clockMs, ask: chosen.ask };
  model.actions++;
  if (P.LIVE_FILLS) model.pending.set(oid, { requested: chosen.size, filled: 0 });
  state.orders.push({ oid, side: chosen.side, limit: chosen.cap, kind: leg,
    budgetUsd: +(chosen.cap * chosen.size).toFixed(4), filledUsd: 0, placedT: Number(tk.t) });
  state.placedThisTick.push({ oid, side: chosen.side, limit: chosen.cap, shares: chosen.size,
    leg, postOnly: false, orderType: "GTC", prepared: true });
  state.gateReason = reason;
  return [rec];
}

export function injectRealFill(state, fill) {
  const model = init(state);
  const shares = Number(fill?.shares);
  if (!(shares > EPS) || !finite(fill?.px) || !["Up", "Down"].includes(fill?.side)) return;
  applyFill(model, fill.side, shares, Number(fill.px), fill.maker !== true);
  const pending = model.pending.get(fill.oid);
  if (pending) {
    pending.filled += shares;
    if (pending.filled >= pending.requested - EPS) model.pending.delete(fill.oid);
  }
}

export function clearLivePending(state, oid) {
  state.wallet3048?.pending?.delete(oid);
}

export function applyManualHedge(state, side, shares, price) {
  const model = init(state);
  applyFill(model, side, Number(shares), Number(price), true);
  return Number(shares) || 0;
}

export function passesGate() { return true; }
