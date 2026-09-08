// Public-data reconstruction of wallet 0x3048...e7537 described in
// TARGET_WALLET_STRATEGY_ANALYSIS.md.
//
// This is an implementable reconstruction, not a claim that the wallet's
// private coefficients or cancel state were recovered. Every unidentified
// threshold is an explicit parameter below so forward tests remain auditable.

import { fillFee } from "../fees.js";
import { walkVisibleAsks, takeReservationSlices } from "../fillsim.js";

export const NAME = "wallet3048";
export const LABEL = "Target wallet 3048 · latency-aware inventory";
export const MODEL_PROVENANCE = Object.freeze({
  target: "heuristic settlement-fair-value reconstruction",
  fittedToSettlementOutcomes: false,
  fittedToWalletSideChoices: false,
  coefficients: "assigned from public-data analysis; not statistically calibrated",
});

export const STRAT = {
  STRATEGY: NAME,
  W3048_SPEC_VERSION: 3,
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
  W3048_MAX_PENDING: 2,
  W3048_DEPTH_STALE_MS: 1000,
  W3048_BINANCE_STALE_MS: 1000,
  W3048_CHAINLINK_STALE_MS: 90000,
  W3048_IMPULSE_TTL_MS: 750,
  W3048_REQUIRE_SOURCE_TIMESTAMPS: true,
  W3048_MAKER_EXECUTION_POLICY: "strict-no-maker",
  // Legacy snapshots only. "zero" historically still credited book-cross
  // inference, so loaders must never describe it as strict no-maker.
  W3048_MAKER_FILL_ASSUMPTION: "zero",
  W3048_MAKER_QUEUE_ALLOCATION: "none",
  W3048_REST_TIMEOUT_MS: 10000,
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
  W3048_LARGE_MIN_DEPTH: 100,
  W3048_SIZE_MODE: "fixed",
  W3048_INCREMENTAL_MIN_SIZE: 5,
  W3048_INCREMENTAL_STEP: 5,
  W3048_INCREMENTAL_MAX_SIZE: 150,
  W3048_FLAT_BOTH_SIDES_ABLATION: false,

  // Fixed causal standardization scales for the report's probability model.
  W3048_MOMENTUM_LOOKBACK_MS: 500,
  W3048_MOMENTUM_MIN_ABS: 0,
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
};

const EPS = 1e-9;
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const opposite = (side) => side === "Up" ? "Down" : "Up";
const sideSign = (side) => side === "Up" ? 1 : -1;
const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
const logit = (p) => Math.log(clamp(Number(p), 0.01, 0.99) / (1 - clamp(Number(p), 0.01, 0.99)));
const z = (value, scale) => clamp(Number(value) / Math.max(EPS, Number(scale)), -4, 4);

export function sourceAgeMs(clockMs, sourceMs) {
  if (!finite(sourceMs)) return null;
  const age = Number(clockMs) - Number(sourceMs);
  if (!Number.isFinite(age) || age < -1) return Infinity;
  return Math.max(0, age);
}

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
    const recovery = state.wallet3048Recovery;
    const prices = [];
    for (let px = Number(P.W3048_MIN_PRICE); px <= Number(P.W3048_MAX_PRICE) + EPS;
      px += Number(P.W3048_TICK)) prices.push(+px.toFixed(2));
    state.wallet3048 = {
      up: 0,
      down: 0,
      cost: 0,
      fees: 0,
      lots: { Up: [], Down: [] },
      nextLotSeq: 0,
      history: [],
      bookTrace: { Up: [], Down: [] },
      askRun: { Up: null, Down: null },
      fillCursor: 0,
      lastActionMs: Number.isFinite(recovery?.lastActionMs) ? recovery.lastActionMs : -Infinity,
      lastFiredSide: null,
      lastFired: { Up: null, Down: null },
      actions: Number.isFinite(recovery?.actions) ? recovery.actions : 0,
      pending: new Map(),
      // Simulation representation of the T-90 signed menu. The live platform
      // remains code-locked to simulation, so no private signature is created.
      preparedMenu: { leadMs: Number(P.W3048_PREPARE_LEAD_MS),
        sizes: [Number(P.W3048_SMALL_SIZE), Number(P.W3048_LARGE_SIZE)],
        prices, orderType: "GTC", postOnly: false },
    };
    delete state.wallet3048Recovery;
  }
  syncRecordedFills(state, state.wallet3048);
  return state.wallet3048;
}

function allocateAmount(rows, total, key, fallback) {
  const weights = rows.map((row) => finite(row?.[key]) ? Number(row[key]) : fallback(row));
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  let used = 0;
  return rows.map((_, index) => {
    const value = index === rows.length - 1 ? Number(total) - used
      : Number(total) * Math.max(0, weights[index]) / Math.max(EPS, weightTotal);
    used += value;
    return value;
  });
}

function recordedSegments(fill, qty, usdc, fee) {
  let left = qty;
  const rows = [];
  for (const level of Array.isArray(fill?.levels) ? fill.levels : []) {
    const shares = Math.min(left, Math.max(0, Number(level?.shares) || 0));
    if (!(shares > EPS)) continue;
    rows.push({ ...level, shares, price: finite(level?.price) ? Number(level.price) : Number(fill.effPx) });
    left -= shares;
    if (left <= EPS) break;
  }
  if (left > EPS) rows.push({ shares: left, price: Number(fill.effPx) });
  const costs = allocateAmount(rows, usdc, "usdc", (row) => row.price * row.shares);
  const fees = allocateAmount(rows, fee, "fee", (row) => fillFee(row.price, row.shares, fill.maker !== true));
  return rows.map((row, index) => ({ ...row, usdc: costs[index], fee: fees[index] }));
}

function consumeLot(lots, lotId, shares) {
  const lot = lots.find((candidate) => String(candidate.lotId) === String(lotId));
  if (!lot) return 0;
  const take = Math.min(Math.max(0, Number(shares) || 0), lot.shares);
  lot.shares -= take;
  if (lot.shares <= EPS) lots.splice(lots.indexOf(lot), 1);
  return take;
}

function consumeFifo(lots, shares) {
  let left = Math.max(0, Number(shares) || 0), used = 0;
  while (left > EPS && lots.length) {
    const take = Math.min(left, lots[0].shares);
    lots[0].shares -= take;
    left -= take;
    used += take;
    if (lots[0].shares <= EPS) lots.shift();
  }
  return used;
}

function discardSegmentShares(segments, shares) {
  let left = Math.max(0, Number(shares) || 0);
  while (left > EPS && segments.length) {
    const row = segments[0];
    const take = Math.min(left, row.shares);
    const ratio = take / row.shares;
    row.shares -= take;
    row.usdc *= 1 - ratio;
    row.fee *= 1 - ratio;
    left -= take;
    if (row.shares <= EPS) segments.shift();
  }
}

function applyFill(model, fill) {
  const side = fill?.side;
  const qty = Number(fill?.shares);
  const px = Number(fill?.effPx);
  if (!(qty > EPS) || !finite(px) || !["Up", "Down"].includes(side)) return;
  const usdc = finite(fill.usdc) ? Number(fill.usdc) : qty * px;
  const fee = finite(fill.fee) ? Number(fill.fee) : fillFee(px, qty, fill.maker !== true);
  const segments = recordedSegments(fill, qty, usdc, fee);
  const otherLots = model.lots[opposite(side)];
  let paired = 0;
  if (Array.isArray(fill.pairReservation)) {
    for (const slice of fill.pairReservation) {
      const need = Math.min(qty - paired, Math.max(0, Number(slice?.shares) || 0));
      if (!(need > EPS)) break;
      paired += consumeLot(otherLots, slice.lotId, need);
    }
  } else {
    paired = consumeFifo(otherLots, qty);
  }
  discardSegmentShares(segments, paired);
  const baseId = String(fill.fillId ?? `${fill.oid ?? "fill"}:${model.fillCursor}`);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!(segment.shares > EPS)) continue;
    model.lots[side].push({ lotId: `${baseId}:${index}:${++model.nextLotSeq}`,
      shares: segment.shares, effectivePrice: (segment.usdc + segment.fee) / segment.shares,
      sourceFillId: fill.fillId ?? null });
  }
  if (side === "Up") model.up += qty; else model.down += qty;
  model.cost += usdc;
  model.fees += fee;
}

function syncRecordedFills(state, model) {
  const fills = Array.isArray(state.fills) ? state.fills : [];
  // A restored window can replace its fill array. Rebuild rather than silently
  // skipping inventory if the cursor is no longer valid.
  if (model.fillCursor > fills.length) {
    model.up = 0; model.down = 0; model.cost = 0; model.fees = 0;
    model.lots = { Up: [], Down: [] }; model.fillCursor = 0; model.nextLotSeq = 0;
  }
  while (model.fillCursor < fills.length) {
    const fill = fills[model.fillCursor++];
    if (fill?.leg === "merge" || !["Up", "Down"].includes(fill?.side)) continue;
    applyFill(model, fill);
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

function reserveFromLots(lots, shares, reserved, preferred = null) {
  let left = Math.max(0, Number(shares) || 0);
  const slices = [];
  const takeLot = (lot, requested) => {
    const already = reserved.get(String(lot.lotId)) || 0;
    const available = Math.max(0, lot.shares - already);
    const take = Math.min(left, available, Math.max(0, Number(requested) || 0));
    if (!(take > EPS)) return;
    slices.push({ lotId: lot.lotId, shares: take, effectivePrice: lot.effectivePrice });
    reserved.set(String(lot.lotId), already + take);
    left -= take;
  };
  for (const wanted of Array.isArray(preferred) ? preferred : []) {
    const lot = lots.find((candidate) => String(candidate.lotId) === String(wanted.lotId));
    if (lot) takeLot(lot, wanted.shares);
  }
  for (const lot of lots) {
    if (left <= EPS) break;
    takeLot(lot, left);
  }
  return slices;
}

function candidateLotReservation(model, state, side, shares, options = {}) {
  const lots = model.lots[opposite(side)] || [];
  const reserved = new Map();
  for (const pending of state.pendingFills || []) {
    const rec = pending?.intent || pending?.rec;
    if (!rec || rec.side !== side || String(rec.oid) === String(options.excludeOid)) continue;
    const quantity = pending.phase === "resting" ? Number(pending.remaining)
      : Number(rec.requestedShares ?? rec.shares);
    if (!(quantity > EPS)) continue;
    const preferred = pending.reservationRemaining ?? rec.pairReservation;
    reserveFromLots(lots, quantity, reserved, preferred);
  }
  return reserveFromLots(lots, shares, reserved, options.preferredReservation);
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

export function realizedVol(history, lookbackMs, sampleMs = 1000) {
  const end = history.at(-1)?.ms;
  if (!finite(end)) return 0;
  const start = Number(end) - Number(lookbackMs);
  const sampled = [];
  for (let at = start; at <= Number(end) + EPS; at += Math.max(1, Number(sampleMs))) {
    const observation = observationAt(history, at);
    if (observation?.bz > 0) sampled.push(observation.bz);
  }
  const last = history.at(-1)?.bz;
  if (last > 0 && sampled.at(-1) !== last) sampled.push(last);
  if (sampled.length < 2) return 0;
  let variance = 0;
  for (let i = 1; i < sampled.length; i++) variance += Math.log(sampled[i] / sampled[i - 1]) ** 2;
  return Math.sqrt(variance);
}

export function buildFeatures(model, tk, P, clockMs, upBook = bookSnapshot(tk?.up), downBook = bookSnapshot(tk?.down)) {
  if (!upBook || !downBook || !(Number(tk?.bzPrice) > 0) || !(Number(tk?.openBinance) > 0)) return null;
  // The Binance websocket can be unchanged across many faster CLOB messages.
  // Keep the upstream timestamp and distinct price updates so CLOB heartbeats
  // cannot manufacture a momentum observation.
  const binanceAgeMs = sourceAgeMs(clockMs, tk?.binanceAtMs);
  const binanceFresh = binanceAgeMs == null
    ? P.W3048_REQUIRE_SOURCE_TIMESTAMPS !== true
    : binanceAgeMs <= Number(P.W3048_BINANCE_STALE_MS);
  const sourceMs = finite(tk?.binanceAtMs) ? Number(tk.binanceAtMs) : clockMs;
  const current = { ms: sourceMs, bz: Number(tk.bzPrice),
    cl: Number(tk?.clPrice) > 0 ? Number(tk.clPrice) : null };
  const last = model.history.at(-1);
  if (binanceFresh && (!last || (current.ms >= last.ms
    && (last.ms !== current.ms || last.bz !== current.bz)))) model.history.push(current);
  while (model.history.length && model.history[0].ms < sourceMs - Math.max(60000, Number(P.W3048_VOL_LOOKBACK_MS))) {
    model.history.shift();
  }
  const prior = observationAt(model.history, sourceMs - Number(P.W3048_MOMENTUM_LOOKBACK_MS));
  let priorDistinct = null;
  for (let i = model.history.length - 2; i >= 0; i--) {
    if (Math.abs(model.history[i].bz - current.bz) > EPS) { priorDistinct = model.history[i]; break; }
  }
  const impulseFresh = priorDistinct?.bz > 0
    && sourceMs - priorDistinct.ms <= Number(P.W3048_IMPULSE_TTL_MS);
  const momentumFast = binanceFresh && prior?.bz > 0 ? Math.log(current.bz / prior.bz) : 0;
  const latestUpdate = binanceFresh && impulseFresh ? Math.log(current.bz / priorDistinct.bz) : 0;
  const momentumSignal = Math.abs(momentumFast) > EPS ? momentumFast : latestUpdate;
  const binanceDisplacement = Math.log(current.bz / Number(tk.openBinance));
  const chainlinkDisplacement = current.cl > 0 && Number(tk?.openChainlink) > 0
    ? Math.log(current.cl / Number(tk.openChainlink)) : 0;
  const relativeLead = binanceDisplacement - chainlinkDisplacement;
  const upMicroProbability = clamp(upBook.micro / Math.max(EPS, upBook.micro + downBook.micro), 0.01, 0.99);
  const clobDepthSignal = clamp((upBook.depthImbalance - downBook.depthImbalance) / 2, -1, 1);
  return {
    momentumFast,
    // Backward-compatible diagnostic key; the value now follows the corrected
    // strictly pre-fill 0.5-second measurement from the updated report.
    momentum5s: momentumFast,
    latestUpdate,
    momentumSignal,
    binanceDisplacement,
    chainlinkDisplacement,
    relativeLead,
    clobUpProbability: upMicroProbability,
    clobDepthSignal,
    volatility: realizedVol(model.history, P.W3048_VOL_LOOKBACK_MS),
    timeProgress: clamp(Number(tk.t) / Math.max(1, Number(P.W3048_STOP_S)), 0, 1),
    binanceAgeMs,
    binanceFresh,
    chainlinkAgeMs: sourceAgeMs(clockMs, tk?.chainlinkAtMs),
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
  const out = { Up: 0, Down: 0, cost: 0, count: 0, orders: [] };
  for (const pending of (state.pendingFills || [])) {
    const rec = pending?.rec;
    if (!rec || !["Up", "Down"].includes(rec.side)) continue;
    const shares = pending.phase === "resting" ? Number(pending.remaining)
      : Number(rec.requestedShares ?? rec.shares);
    if (!(shares > EPS)) continue;
    const px = Number(rec.limitPx);
    if (!finite(px)) continue;
    const maker = pending.phase === "resting";
    const costPerShare = px + fillFee(px, 1, !maker);
    out[rec.side] += shares;
    out.cost += shares * costPerShare;
    out.count++;
    out.orders.push({ side: rec.side, shares, price: px,
      feePerShare: fillFee(px, 1, !maker), costPerShare, oid: rec.oid ?? null });
  }
  return out;
}

export function evaluateRiskScenarios(model, state, side, size, cap, P, progress) {
  const reserved = pendingReservations(state);
  const feePerShare = fillFee(cap, 1, true);
  const leanLimit = interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress);
  const lossLimit = interpolate(P.W3048_LOSS_LIMIT_START, P.W3048_LOSS_LIMIT_END, progress);
  const spendLimit = Number(P.W3048_MAX_WINDOW_SPEND);
  const metrics = (orders, includeProposed) => {
    let up = model.up, down = model.down;
    let totalCost = model.cost + model.fees;
    let spend = model.cost;
    for (const order of orders) {
      if (order.side === "Up") up += order.shares; else down += order.shares;
      totalCost += order.shares * order.costPerShare;
      spend += order.shares * order.price;
    }
    if (includeProposed) {
      if (side === "Up") up += size; else down += size;
      totalCost += size * (cap + feePerShare);
      spend += size * cap;
    }
    return { up, down, worstCase: Math.min(up, down) - totalCost,
      lean: Math.abs(up - down), spend };
  };
  const scenarios = [];
  const count = reserved.orders.length;
  for (let mask = 0; mask < 2 ** count; mask++) {
    const filled = reserved.orders.filter((_, index) => mask & (1 << index));
    const before = metrics(filled, false);
    const after = metrics(filled, true);
    const beforeWithin = before.lean <= leanLimit + EPS && before.worstCase >= -lossLimit - EPS
      && before.spend <= spendLimit + EPS;
    const afterWithin = after.lean <= leanLimit + EPS && after.worstCase >= -lossLimit - EPS
      && after.spend <= spendLimit + EPS;
    const boundedRepair = !beforeWithin && after.spend <= spendLimit + EPS
      && after.lean <= before.lean + EPS && after.worstCase >= before.worstCase - EPS;
    scenarios.push({ mask, filledOids: filled.map((order) => order.oid), before, after,
      afterWithin, boundedRepair, passes: afterWithin || boundedRepair });
  }
  const worstCase = Math.min(...scenarios.map((scenario) => scenario.after.worstCase));
  const lean = Math.max(...scenarios.map((scenario) => scenario.after.lean));
  const spend = Math.max(...scenarios.map((scenario) => scenario.after.spend));
  return { passes: scenarios.every((scenario) => scenario.passes), worstCase, lean,
    leanLimit, lossLimit, spend, spendLimit, reserved, scenarios };
}

const riskCheck = evaluateRiskScenarios;

export function economicCaps(model, state, side, book, fair, size, P, progress, options = {}) {
  const imbalance = model.up - model.down;
  const oriented = imbalance * sideSign(side);
  const isComplement = oriented < -EPS;
  const confirmedMatchable = isComplement ? Math.abs(imbalance) : 0;
  const requestedMatch = Math.min(size, confirmedMatchable);
  const pairReservation = isComplement
    ? candidateLotReservation(model, state, side, requestedMatch, options) : [];
  const matchedShares = pairReservation.reduce((sum, slice) => sum + slice.shares, 0);
  const directionalShares = size - matchedShares;
  const feeAtAsk = fillFee(book.ask, 1, true);
  const leanScale = Math.max(1, interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress));
  const inventoryPenalty = oriented > 0
    ? Number(P.W3048_INVENTORY_PENALTY_MAX) * clamp(oriented / leanScale, 0, 1)
    : 0;
  const signalCapMaker = fair - Number(P.W3048_EDGE_BUFFER) - inventoryPenalty;
  const signalCapTaker = signalCapMaker - feeAtAsk;
  let pairCapMaker = null;
  let oppositeCost = null;
  if (isComplement && matchedShares > EPS) {
    oppositeCost = firstLotCost(pairReservation, matchedShares);
    if (oppositeCost != null) {
      pairCapMaker = 1 - oppositeCost - Number(P.W3048_PAIR_PROFIT_TARGET);
    }
  }
  // Cheap pair completion uses the lot-aware pair cap. If the ask is above
  // that cap, it is a distinct loss-cap repair and must stand on signal/risk
  // economics instead of pretending the marginal pair is profitable.
  const pairCapTaker = pairCapMaker == null ? null : pairCapMaker - feeAtAsk;
  const pairingIntended = matchedShares > EPS && pairCapMaker != null && book.ask <= pairCapMaker + EPS;
  const takerEconomicCap = pairingIntended ? Math.min(signalCapTaker, pairCapTaker) : signalCapTaker;
  const makerEconomicCap = pairingIntended ? Math.min(signalCapMaker, pairCapMaker) : signalCapMaker;
  const configuredMax = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? P.W3048_MAX_PRICE));
  const crossCeiling = book.ask + Number(P.W3048_CROSS_HEADROOM_TICKS) * Number(P.W3048_TICK);
  const canTake = takerEconomicCap >= book.ask - EPS;
  const economicCap = canTake ? takerEconomicCap : makerEconomicCap;
  const roleCeiling = canTake ? crossCeiling : book.ask - Number(P.W3048_TICK);
  const cap = floorTick(Math.min(configuredMax, economicCap, roleCeiling), P.W3048_TICK);
  const execution = walkVisibleAsks(book, size, cap, { allowBbaFallback: false });
  const immediateShares = execution.shares;
  const restingShares = Math.max(0, size - immediateShares);
  const immediateFees = execution.levels.reduce((sum, level) =>
    sum + fillFee(level.price, level.shares, true), 0);
  const projectedCost = execution.cost + restingShares * cap;
  const expectedPx = size > EPS ? projectedCost / size : cap;
  const feePerShare = size > EPS ? immediateFees / size : 0;
  const marketable = immediateShares > EPS;
  const signalCap = marketable ? signalCapTaker : signalCapMaker;
  const pairCap = marketable ? pairCapTaker : pairCapMaker;
  return { imbalance, oriented, isComplement, inventoryPenalty, signalCap, pairCap,
    signalCapMaker, signalCapTaker, pairCapMaker, pairCapTaker,
    oppositeCost, pairingIntended, economicCap, cap, marketable, expectedPx, feePerShare,
    pairReservation, matchedShares, directionalShares, immediateShares, restingShares,
    immediateVwap: execution.avgPx, immediateCost: execution.cost, immediateFees };
}

function candidateFor(model, state, side, book, release, fair, P, progress, clockMs, fastAligned) {
  const lastFired = model.lastFired[side];
  if (model.lastFiredSide === side && lastFired
    && clockMs - lastFired.ms < Number(P.W3048_SAME_SIDE_RETRY_MS)
    && Math.abs(book.ask - lastFired.ask) < Number(P.W3048_SAME_SIDE_REPRICE) - EPS) return null;
  const small = Number(P.W3048_SMALL_SIZE);
  const large = Number(P.W3048_LARGE_SIZE);
  const evaluate = (size) => {
    const caps = economicCaps(model, state, side, book, fair, size, P, progress);
    if (caps.cap < Number(P.W3048_MIN_PRICE) - EPS || caps.cap > Number(P.W3048_MAX_PRICE) + EPS) return null;
    const visibleDepth = depthThrough(book.asks, caps.cap);
    const risk = riskCheck(model, state, side, size, caps.cap, P, progress);
    if (!risk.passes) return null;
    const expectedEdge = fair - caps.expectedPx - caps.feePerShare;
    const pairEdge = caps.oppositeCost == null ? -Infinity
      : 1 - caps.oppositeCost - caps.expectedPx - caps.feePerShare;
    const beforeWorst = Math.min(...risk.scenarios.map((scenario) => scenario.before.worstCase));
    const worstCaseImprovement = risk.worstCase - beforeWorst;
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
    const directionalRemainderPass = caps.directionalShares <= EPS
      || expectedEdge >= sameSideMinimum - EPS;
    const economicPass = caps.isComplement
      ? (caps.pairingIntended ? pairEdge >= complementMinimum - EPS && directionalRemainderPass
        : riskAdjustedEdge >= complementMinimum - EPS && directionalRemainderPass)
      : expectedEdge >= sameSideMinimum - EPS;
    if (!economicPass) return null;
    const pairCost = caps.oppositeCost == null ? null
      : caps.oppositeCost + caps.expectedPx + caps.feePerShare;
    const pairWeight = interpolate(P.W3048_PAIR_VALUE_WEIGHT_START,
      P.W3048_PAIR_VALUE_WEIGHT_END, progress);
    const liquidityRank = clamp(release.liquidityScore,
      -Number(P.W3048_LIQUIDITY_RANK_CAP), Number(P.W3048_LIQUIDITY_RANK_CAP));
    const directionalAttributedShares = caps.pairingIntended ? caps.directionalShares : size;
    const directionalExpectedPnl = expectedEdge * directionalAttributedShares;
    const pairExpectedPnl = caps.pairingIntended ? pairEdge * caps.matchedShares : 0;
    const expectedPnlSacrifice = caps.isComplement && !caps.pairingIntended
      ? Math.max(0, -directionalExpectedPnl) : 0;
    const utility = directionalExpectedPnl / size - caps.inventoryPenalty
      + pairWeight * Math.max(0, pairExpectedPnl) / size
      + riskWeight * riskReliefPerShare
      + Number(P.W3048_FILL_PROB_WEIGHT) * liquidityRank;
    return { side, size, fair, ask: book.ask, ...caps, pairCost, expectedEdge,
      pairEdge, riskAdjustedEdge, minEdge, utility, worstCaseImprovement,
      directionalExpectedPnl, pairExpectedPnl, expectedPnlSacrifice,
      visibleDepth, risk, release };
  };

  if (String(P.W3048_SIZE_MODE) === "incremental") {
    const minimum = Math.max(EPS, Number(P.W3048_INCREMENTAL_MIN_SIZE));
    const step = Math.max(EPS, Number(P.W3048_INCREMENTAL_STEP));
    const maximum = Math.max(minimum, Number(P.W3048_INCREMENTAL_MAX_SIZE));
    let best = null;
    for (let size = minimum; size <= maximum + EPS; size += step) {
      const candidate = evaluate(+size.toFixed(6));
      if (!candidate) continue;
      if (model.up + model.down > EPS && !candidate.isComplement && !fastAligned) continue;
      if (!release.passes && candidate.marketable && !fastAligned) continue;
      candidate.totalUtility = candidate.utility * candidate.size;
      if (!best || candidate.totalUtility > best.totalUtility + EPS) best = candidate;
    }
    return best;
  }
  const ordinary = evaluate(small);
  if (!ordinary) return null;
  if (model.up + model.down > EPS && !ordinary.isComplement && !fastAligned) return null;
  // A fast Binance move precedes the wallet's taker fill and the resulting L2
  // depth drop. Requiring that drop first would be a causal inversion. Stable
  // taker attempts still need fast-side alignment; below-ask maker intents can
  // rest patiently on their economic cap.
  if (!release.passes && ordinary.marketable && !fastAligned) return null;
  // Parent-template selection is based on cents/share edge and executable
  // depth. Risk relief can authorize an otherwise expensive 50-share repair,
  // but must not by itself triple that repair to 150 shares.
  const strength = Math.max(ordinary.expectedEdge,
    Number.isFinite(ordinary.pairEdge) ? ordinary.pairEdge : -Infinity);
  const strongEnough = strength >= Number(P.W3048_LARGE_EDGE) - EPS;
  const depthCapacity = ordinary.marketable ? ordinary.visibleDepth : book.bidDepth3;
  const deepEnough = depthCapacity >= Number(P.W3048_LARGE_MIN_DEPTH) - EPS;
  if (strongEnough && deepEnough) return evaluate(large) || ordinary;
  return ordinary;
}

// Re-evaluate an already-resting GTC against the same current economic cap
// used for new orders. This models the report's keep/cancel/reprice rule; it
// deliberately does not infer unavailable historical CLOB cancellation data.
export function shouldCancelResting(state, rec, tk, P = STRAT,
  clockMs = Number(tk?.t) * 1000, options = {}) {
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
  const directionalIntent = rec.reason === "w3048-initial-release"
    || rec.reason === "w3048-directional-reinforcement";
  if (directionalIntent && fastSide && fastSide !== rec.side) {
    return { cancel: true, reason: "fast-signal-reversed" };
  }
  const fairUp = fairProbability(features, P);
  const sideBook = rec.side === "Up" ? upBook : downBook;
  const fair = rec.side === "Up" ? fairUp : 1 - fairUp;
  const progress = clamp((Number(tk.t) - Number(P.W3048_START_S))
    / Math.max(1, Number(P.W3048_STOP_S) - Number(P.W3048_START_S)), 0, 1);
  const size = Math.max(EPS, Number(options.remainingShares ?? rec.requestedShares ?? rec.shares));
  const caps = economicCaps(model, state, rec.side, sideBook, fair, size, P, progress,
    { excludeOid: options.excludeOid ?? rec.oid,
      preferredReservation: options.pairReservation ?? rec.pairReservation });
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
  if (!(Number(P.W3048_MOMENTUM_LOOKBACK_MS) >= 250)
    || !(Number(P.W3048_MOMENTUM_LOOKBACK_MS) <= 1000)) {
    throw new Error("wallet3048 fast Binance lookback must be between 250ms and 1000ms");
  }
  if (!(Number(P.W3048_MAX_PENDING) >= 1)) throw new Error("wallet3048 max pending must be >= 1");
  if (!Number.isFinite(Number(P.W3048_BINANCE_STALE_MS)) || Number(P.W3048_BINANCE_STALE_MS) < 0) {
    throw new Error("wallet3048 Binance freshness threshold must be non-negative");
  }
  if (!Number.isFinite(Number(P.W3048_IMPULSE_TTL_MS)) || Number(P.W3048_IMPULSE_TTL_MS) < 0) {
    throw new Error("wallet3048 impulse TTL must be non-negative");
  }
  if (!["strict-no-maker", "book-cross-inference", "observed-flow-estimate", "optimistic-touch"]
    .includes(String(P.W3048_MAKER_EXECUTION_POLICY))) {
    throw new Error("wallet3048 maker execution policy is invalid");
  }
  if (!["none", "front-of-queue"].includes(String(P.W3048_MAKER_QUEUE_ALLOCATION))) {
    throw new Error("wallet3048 maker queue allocation must be none or front-of-queue");
  }
  if (String(P.W3048_MAKER_EXECUTION_POLICY) === "observed-flow-estimate"
    && String(P.W3048_MAKER_QUEUE_ALLOCATION) !== "front-of-queue") {
    throw new Error("wallet3048 observed-flow maker estimates require an explicit front-of-queue assumption");
  }
  if (!["fixed", "incremental"].includes(String(P.W3048_SIZE_MODE))) {
    throw new Error("wallet3048 size mode must be fixed or incremental");
  }
  if (!(Number(P.W3048_INCREMENTAL_MIN_SIZE) > 0)
    || !(Number(P.W3048_INCREMENTAL_STEP) > 0)
    || Number(P.W3048_INCREMENTAL_MAX_SIZE) < Number(P.W3048_INCREMENTAL_MIN_SIZE)) {
    throw new Error("wallet3048 incremental size bounds are invalid");
  }
  return true;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = Number(tk?.t) * 1000) {
  const model = init(state, P);
  if (!P.W3048_ON) { state.gateReason = "w3048-off"; return []; }
  if (!tk?.up || !tk?.down) { state.gateReason = "w3048-no-book"; return []; }
  const latestDecisionS = Number(P.W3048_STOP_S) - Math.max(0, Number(P.LATENCY_MS) || 0) / 1000;
  if (Number(tk.t) < Number(P.W3048_START_S) || Number(tk.t) >= latestDecisionS) {
    state.gateReason = "w3048-time"; return [];
  }
  if (model.actions >= Number(P.W3048_MAX_ACTIONS)) { state.gateReason = "w3048-action-cap"; return []; }

  const requireSourceTime = P.W3048_REQUIRE_SOURCE_TIMESTAMPS === true;
  const freshness = [
    ["binance", tk.binanceAtMs, P.W3048_BINANCE_STALE_MS],
    ["chainlink", tk.chainlinkAtMs, P.W3048_CHAINLINK_STALE_MS],
    ["up-depth", tk.up.depthTs, P.W3048_DEPTH_STALE_MS],
    ["down-depth", tk.down.depthTs, P.W3048_DEPTH_STALE_MS],
  ];
  for (const [label, timestamp, maximum] of freshness) {
    const age = sourceAgeMs(clockMs, timestamp);
    if (age == null && requireSourceTime) { state.gateReason = `w3048-missing-${label}-time`; return []; }
    if (age != null && age > Number(maximum)) { state.gateReason = `w3048-stale-${label}`; return []; }
  }

  const upBook = bookSnapshot(tk.up), downBook = bookSnapshot(tk.down);
  if (!upBook || !downBook) { state.gateReason = "w3048-no-bba"; return []; }
  const features = buildFeatures(model, tk, P, clockMs, upBook, downBook);
  if (!features) { state.gateReason = "w3048-features"; return []; }
  // Update the release traces on every eligible book update, including while
  // an earlier GTC is cooling down or awaiting its fill/cancel response.
  const upRelease = releaseFeatures(model, "Up", upBook, clockMs, P);
  const downRelease = releaseFeatures(model, "Down", downBook, clockMs, P);
  if (clockMs - model.lastActionMs < Number(P.W3048_COOLDOWN_MS)) { state.gateReason = "w3048-cooldown"; return []; }
  const pendingCount = Math.max(model.pending.size, pendingReservations(state).count);
  if (pendingCount >= Number(P.W3048_MAX_PENDING)) { state.gateReason = "w3048-pending-cap"; return []; }
  const fairUp = fairProbability(features, P);
  const progress = clamp((Number(tk.t) - Number(P.W3048_START_S))
    / Math.max(1, Number(P.W3048_STOP_S) - Number(P.W3048_START_S)), 0, 1);
  const hasPosition = model.up + model.down > EPS;
  const fastMagnitude = Math.abs(features.momentumSignal);
  const fastDirection = fastMagnitude > EPS
    && fastMagnitude >= Number(P.W3048_MOMENTUM_MIN_ABS)
    ? (features.momentumSignal > 0 ? "Up" : "Down") : null;
  if (!hasPosition && !fastDirection) { state.gateReason = "w3048-wait-fast-binance"; return []; }
  const candidates = [
    (!hasPosition && P.W3048_FLAT_BOTH_SIDES_ABLATION !== true && fastDirection !== "Up") ? null
      : candidateFor(model, state, "Up", upBook, upRelease, fairUp, P, progress, clockMs,
        fastDirection === "Up"),
    (!hasPosition && P.W3048_FLAT_BOTH_SIDES_ABLATION !== true && fastDirection !== "Down") ? null
      : candidateFor(model, state, "Down", downBook, downRelease, 1 - fairUp, P, progress, clockMs,
        fastDirection === "Down"),
  ].filter(Boolean).sort((a, b) => b.utility - a.utility || b.expectedEdge - a.expectedEdge
    || a.cap - b.cap || a.side.localeCompare(b.side));
  const chosen = candidates[0];
  if (!chosen || chosen.utility <= EPS) { state.gateReason = "w3048-no-economic-candidate"; return []; }

  const oid = ++state.seq;
  const leg = chosen.isComplement ? "hedge" : "entry";
  const reason = model.up + model.down <= EPS ? "w3048-initial-release"
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
    restTimeoutMs: Number(P.W3048_REST_TIMEOUT_MS),
    leg,
    reason,
    status: "open",
    oid,
    postOnly: false,
    prepared: true,
    preparedLeadMs: model.preparedMenu.leadMs,
    pairReservation: chosen.pairReservation.map((slice) => ({ ...slice })),
    signal: {
      fairUp: +fairUp.toFixed(6),
      fairSide: +chosen.fair.toFixed(6),
      momentumFast: +features.momentumFast.toFixed(8),
      momentum5s: +features.momentum5s.toFixed(8),
      latestBinanceUpdate: +features.latestUpdate.toFixed(8),
      relativeLead: +features.relativeLead.toFixed(8),
      chainlinkDistance: +features.chainlinkDisplacement.toFixed(8),
      clobUpProbability: +features.clobUpProbability.toFixed(6),
      volatility: +features.volatility.toFixed(8),
      signalCap: +chosen.signalCap.toFixed(6),
      economicCap: +chosen.economicCap.toFixed(6),
      pairCap: chosen.pairCap == null ? null : +chosen.pairCap.toFixed(6),
      pairCost: chosen.pairCost == null ? null : +chosen.pairCost.toFixed(6),
      expectedEdge: +chosen.expectedEdge.toFixed(6),
      directionalExpectedPnl: +chosen.directionalExpectedPnl.toFixed(6),
      pairExpectedPnl: +chosen.pairExpectedPnl.toFixed(6),
      expectedPnlSacrifice: +chosen.expectedPnlSacrifice.toFixed(6),
      riskAdjustedEdge: +chosen.riskAdjustedEdge.toFixed(6),
      minimumEdge: +chosen.minEdge.toFixed(6),
      expectedRole: chosen.marketable ? "taker" : "maker",
      immediateShares: +chosen.immediateShares.toFixed(4),
      restingShares: +chosen.restingShares.toFixed(4),
      immediateVwap: chosen.immediateVwap == null ? null : +chosen.immediateVwap.toFixed(6),
      matchedShares: +chosen.matchedShares.toFixed(4),
      directionalShares: +chosen.directionalShares.toFixed(4),
      pairingIntended: chosen.pairingIntended,
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
      riskScenarios: chosen.risk.scenarios.length,
      scenarioLimitViolations: chosen.risk.scenarios.filter((scenario) => !scenario.afterWithin).length,
      boundedRepairScenarios: chosen.risk.scenarios.filter((scenario) => scenario.boundedRepair).length,
    },
  };
  model.lastActionMs = clockMs;
  model.lastFiredSide = chosen.side;
  model.lastFired[chosen.side] = { ms: clockMs, ask: chosen.ask };
  model.actions++;
  if (P.LIVE_FILLS) model.pending.set(oid, { requested: chosen.size, filled: 0,
    reservationRemaining: chosen.pairReservation.map((slice) => ({ ...slice })) });
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
  const pending = model.pending.get(fill.oid);
  const pairReservation = pending
    ? takeReservationSlices(pending.reservationRemaining, shares) : undefined;
  applyFill(model, { ...fill, effPx: Number(fill.px), usdc: finite(fill.usdc)
    ? Number(fill.usdc) : shares * Number(fill.px),
    fee: finite(fill.fee) ? Number(fill.fee) : fillFee(Number(fill.px), shares, fill.maker !== true),
    pairReservation });
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
  applyFill(model, { side, shares: Number(shares), effPx: Number(price),
    usdc: Number(shares) * Number(price), fee: fillFee(Number(price), Number(shares), true) });
  return Number(shares) || 0;
}

export function passesGate() { return true; }
