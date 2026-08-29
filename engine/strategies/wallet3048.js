// Public-data reconstruction of wallet 0x3048...e7537 described in
// TARGET_WALLET_STRATEGY_ANALYSIS.md.
//
// This is an implementable reconstruction, not a claim that the wallet's
// private coefficients or cancel state were recovered. Every unidentified
// threshold is an explicit parameter below so forward tests remain auditable.

import { fillFee } from "../fees.js";

export const NAME = "wallet3048";
export const LABEL = "Target wallet 3048 · CLOB release/cycle";

export const STRAT = {
  STRATEGY: NAME,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  LIVE_FILLS: false,
  LIMIT: 0.89,
  MAX_SESSION_LOSS: 25,

  W3048_ON: true,
  W3048_START_S: 4,
  W3048_STOP_S: 270,
  W3048_MIN_PRICE: 0.12,
  W3048_MAX_PRICE: 0.89,
  W3048_TICK: 0.01,
  W3048_COOLDOWN_MS: 3000,
  W3048_MAX_ACTIONS: 60,
  W3048_DEPTH_STALE_MS: 1000,
  W3048_REST_TIMEOUT_MS: 3000,
  W3048_SIM_TOUCH_MS: 1000,
  W3048_SIM_TOUCH_FILL_PCT: 10,

  // The immediate release clock is CLOB L2 pressure. These are the
  // representative and transparent branches documented by the repository's
  // capital-independent reconstruction.
  W3048_RELEASE_GATE: true,
  W3048_EXECUTABLE_RUN_MS: 525,
  W3048_RELEASE_ASK1_MAX: 100,
  W3048_RELEASE_ASK3_MAX: 410,
  W3048_RELEASE_DEPLETION1_MAX: -110,
  W3048_PRESSURE_ASK3_MAX: 800,
  W3048_PRESSURE_IMBALANCE_MIN: 0.20,
  W3048_PRESSURE_DEPLETION1_MAX: -300,
  W3048_BBA_MOVE_MIN: 0.01,
  W3048_LIQUIDITY_RANK_CAP: 1.5,
  W3048_PRICE_RANK_WEIGHT: 1.5,
  W3048_FAIR_RANK_WEIGHT: 0.5,
  W3048_REPAIR_RANK_WEIGHT: 0.15,
  W3048_CHEAP_PAIR_RANK_BONUS: 0.10,
  W3048_SAME_SIDE_REPRICE: 0.05,
  W3048_SAME_SIDE_RETRY_MS: 12000,

  // The only parent sizes observed in the attached decoded sample.
  W3048_SMALL_SIZE: 50,
  W3048_LARGE_SIZE: 150,
  W3048_LARGE_EDGE: 0.035,
  W3048_LARGE_MIN_DEPTH: 150,

  // Fixed causal standardization scales for the report's probability model.
  W3048_MOMENTUM_LOOKBACK_MS: 5000,
  W3048_VOL_LOOKBACK_MS: 30000,
  W3048_MOMENTUM_SCALE: 0.00020,
  W3048_RELATIVE_LEAD_SCALE: 0.00050,
  W3048_CHAINLINK_DISTANCE_SCALE: 0.00100,
  W3048_CLOB_SCALE: 0.05,
  W3048_VOL_SCALE: 0.00030,
  W3048_BETA0: 0,
  W3048_BETA_MOMENTUM: 0.85,
  W3048_BETA_RELATIVE_LEAD: 0.65,
  W3048_BETA_CHAINLINK_DISTANCE: 0.35,
  W3048_BETA_CLOB: 0.65,
  W3048_BETA_VOLATILITY: 0,
  W3048_BETA_TIME_CHAINLINK: 0.20,

  // Spot/fair-value inputs are secondary ranking context. Observed submitted
  // caps are exact current asks; FIFO pair economics are diagnostic/ranking
  // inputs rather than a universal hard veto.
  W3048_EDGE_BUFFER: 0.0125,
  W3048_MIN_EXPECTED_EDGE: 0.0025,
  W3048_PAIR_PROFIT_TARGET: 0.005,
  W3048_INVENTORY_PENALTY_MAX: 0.04,

  // Projected full-parent risk limits tighten into the final active minute.
  W3048_MAX_LEAN_START: 500,
  W3048_MAX_LEAN_END: 450,
  W3048_LOSS_LIMIT_START: 200,
  W3048_LOSS_LIMIT_END: 150,
  W3048_MAX_WINDOW_SPEND: 400,
  W3048_CHEAP_OVERLAY_MAX_PRICE: 0.20,
  W3048_CHEAP_OVERLAY_BUDGET: 200,
};

const EPS = 1e-9;
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const opposite = (side) => side === "Up" ? "Down" : "Up";
const sideSign = (side) => side === "Up" ? 1 : -1;
const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
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

function ceilTick(value, tick) {
  const t = Math.max(EPS, Number(tick));
  return +(Math.ceil((Number(value) - EPS) / t) * t).toFixed(6);
}

function interpolate(start, end, progress) {
  return Number(start) + (Number(end) - Number(start)) * clamp(progress, 0, 1);
}

function init(state) {
  state.placedThisTick = [];
  state.orders ||= [];
  state.seq ||= 0;
  if (!state.wallet3048) {
    const prices = [];
    for (let px = 0.12; px <= 0.890001; px += 0.01) prices.push(+px.toFixed(2));
    state.wallet3048 = {
      up: 0,
      down: 0,
      cost: 0,
      fees: 0,
      lots: { Up: [], Down: [] },
      history: [],
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
      preparedMenu: { leadMs: 90000, sizes: [50, 150], prices, orderType: "GTC", postOnly: false },
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
}

function syncRecordedFills(state, model) {
  const fills = Array.isArray(state.fills) ? state.fills : [];
  // A restored window can replace its fill array. Rebuild rather than silently
  // skipping inventory if the cursor is no longer valid.
  if (model.fillCursor > fills.length) {
    model.up = 0; model.down = 0; model.cost = 0; model.fees = 0;
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
  if (!upBook || !downBook || !(Number(tk?.bzPrice) > 0) || !(Number(tk?.clPrice) > 0)
    || !(Number(tk?.openBinance) > 0) || !(Number(tk?.openChainlink) > 0)) return null;
  const current = { ms: clockMs, bz: Number(tk.bzPrice), cl: Number(tk.clPrice) };
  if (!model.history.length || model.history.at(-1).ms !== clockMs) model.history.push(current);
  while (model.history.length && model.history[0].ms < clockMs - Math.max(60000, Number(P.W3048_VOL_LOOKBACK_MS))) {
    model.history.shift();
  }
  const prior = observationAt(model.history, clockMs - Number(P.W3048_MOMENTUM_LOOKBACK_MS));
  const priorBz = prior?.bz > 0 ? prior.bz : Number(tk.openBinance);
  const momentum5s = Math.log(current.bz / priorBz);
  const binanceDisplacement = Math.log(current.bz / Number(tk.openBinance));
  const chainlinkDisplacement = Math.log(current.cl / Number(tk.openChainlink));
  const relativeLead = binanceDisplacement - chainlinkDisplacement;
  const upMicroProbability = clamp(upBook.micro / Math.max(EPS, upBook.micro + downBook.micro), 0.01, 0.99);
  return {
    momentum5s,
    binanceDisplacement,
    chainlinkDisplacement,
    relativeLead,
    clobUpProbability: upMicroProbability,
    volatility: realizedVol(model.history, P.W3048_VOL_LOOKBACK_MS),
    timeProgress: clamp(Number(tk.t) / Math.max(1, Number(P.W3048_STOP_S)), 0, 1),
  };
}

export function fairProbability(features, P = STRAT) {
  if (!features) return null;
  const clobCentered = features.clobUpProbability - 0.5;
  const chainZ = z(features.chainlinkDisplacement, P.W3048_CHAINLINK_DISTANCE_SCALE);
  const score = Number(P.W3048_BETA0)
    + Number(P.W3048_BETA_MOMENTUM) * z(features.momentum5s, P.W3048_MOMENTUM_SCALE)
    + Number(P.W3048_BETA_RELATIVE_LEAD) * z(features.relativeLead, P.W3048_RELATIVE_LEAD_SCALE)
    + Number(P.W3048_BETA_CHAINLINK_DISTANCE) * chainZ
    + Number(P.W3048_BETA_CLOB) * z(clobCentered, P.W3048_CLOB_SCALE)
    + Number(P.W3048_BETA_VOLATILITY) * z(features.volatility, P.W3048_VOL_SCALE)
    + Number(P.W3048_BETA_TIME_CHAINLINK) * features.timeProgress * chainZ;
  return clamp(sigmoid(score), 0.01, 0.99);
}

function riskCheck(model, side, size, cap, P, progress) {
  const feePerShare = fillFee(cap, 1, true);
  const nextUp = model.up + (side === "Up" ? size : 0);
  const nextDown = model.down + (side === "Down" ? size : 0);
  const nextCost = model.cost + model.fees + size * (cap + feePerShare);
  const worstCase = Math.min(nextUp, nextDown) - nextCost;
  const lean = Math.abs(nextUp - nextDown);
  const leanLimit = interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress);
  const lossLimit = interpolate(P.W3048_LOSS_LIMIT_START, P.W3048_LOSS_LIMIT_END, progress);
  const spend = model.cost + size * cap;
  const spendLimit = Number(P.W3048_MAX_WINDOW_SPEND)
    + (cap <= Number(P.W3048_CHEAP_OVERLAY_MAX_PRICE) + EPS
      ? Number(P.W3048_CHEAP_OVERLAY_BUDGET) : 0);
  return { passes: lean <= leanLimit + EPS && worstCase >= -lossLimit - EPS
      && spend <= spendLimit + EPS,
    worstCase, lean, leanLimit, lossLimit, spend, spendLimit };
}

function candidateFor(model, side, book, release, fair, P, progress, clockMs) {
  if (!release.passes) return null;
  const lastFired = model.lastFired[side];
  if (model.lastFiredSide === side && lastFired
    && clockMs - lastFired.ms < Number(P.W3048_SAME_SIDE_RETRY_MS)
    && Math.abs(book.ask - lastFired.ask) < Number(P.W3048_SAME_SIDE_REPRICE) - EPS) return null;
  const imbalance = model.up - model.down;
  const oriented = imbalance * sideSign(side);
  const feeAtAsk = fillFee(book.ask, 1, true);
  const leanScale = Math.max(1, interpolate(P.W3048_MAX_LEAN_START, P.W3048_MAX_LEAN_END, progress));
  const inventoryPenalty = oriented > 0
    ? Number(P.W3048_INVENTORY_PENALTY_MAX) * clamp(oriented / leanScale, 0, 1)
    : 0;
  const signalCap = fair - Number(P.W3048_EDGE_BUFFER) - feeAtAsk - inventoryPenalty;
  const maxPrice = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? P.W3048_MAX_PRICE));
  // The public exact-order reconstruction shows an exact-ask signed cell in
  // the large majority of releases. Never chase beyond that selected cell.
  const cap = ceilTick(book.ask, P.W3048_TICK);
  if (cap < Number(P.W3048_MIN_PRICE) - EPS || cap > maxPrice + EPS) return null;

  const small = Number(P.W3048_SMALL_SIZE);
  const large = Number(P.W3048_LARGE_SIZE);
  const isComplement = oriented < -EPS;
  // The large branch is primarily a cheap-side repair/catch-up action. Making
  // every strong release 150 shares caused the clone's first fill and most
  // expensive-side fills to be triple-sized, unlike the public wallet.
  const cheapRepair = isComplement && cap <= 0.50 + EPS && Math.abs(imbalance) >= small - EPS;
  const deepRepair = isComplement && Math.abs(imbalance) >= 4 * small - EPS;
  const lateCheapSweep = progress >= 0.45 && cap <= 0.20 + EPS;
  let size = cheapRepair || deepRepair || lateCheapSweep ? large : small;

  let pairCap = null;
  let oppositeCost = null;
  if (isComplement) {
    const matched = Math.min(size, Math.abs(imbalance));
    oppositeCost = firstLotCost(model.lots[opposite(side)], matched);
    if (oppositeCost != null) pairCap = 1 - oppositeCost - Number(P.W3048_PAIR_PROFIT_TARGET) - feeAtAsk;
  }

  let risk = riskCheck(model, side, size, cap, P, progress);
  if (!risk.passes && size === large) {
    size = small;
    if (isComplement) {
      const matched = Math.min(size, Math.abs(imbalance));
      oppositeCost = firstLotCost(model.lots[opposite(side)], matched);
      pairCap = oppositeCost == null ? null
        : 1 - oppositeCost - Number(P.W3048_PAIR_PROFIT_TARGET) - feeAtAsk;
    }
    risk = riskCheck(model, side, size, cap, P, progress);
  }
  if (!risk.passes) return null;

  const expectedEdge = fair - cap - fillFee(cap, 1, true);
  const pairEdge = pairCap == null ? 0 : Math.max(0, 1 - oppositeCost - cap - fillFee(cap, 1, true));
  const beforeWorst = Math.min(model.up, model.down) - model.cost - model.fees;
  const worstCaseImprovement = risk.worstCase - beforeWorst;
  const pairCost = oppositeCost == null ? null : oppositeCost + cap + fillFee(cap, 1, true);
  // CLOB pressure selects the branch. Fair value is a bounded tie-breaker;
  // pairing and repair bonuses rank candidates but never impose the disproven
  // universal sub-$1 pair constraint.
  const repairRank = isComplement
    ? clamp(Math.abs(imbalance) / Math.max(EPS, small), 0, 3) * Number(P.W3048_REPAIR_RANK_WEIGHT)
    : 0;
  const liquidityRank = clamp(release.liquidityScore,
    -Number(P.W3048_LIQUIDITY_RANK_CAP), Number(P.W3048_LIQUIDITY_RANK_CAP));
  const utility = liquidityRank
    + (0.5 - cap) * Number(P.W3048_PRICE_RANK_WEIGHT)
    + clamp(expectedEdge, -0.25, 0.25) * Number(P.W3048_FAIR_RANK_WEIGHT)
    + repairRank
    + (pairCost != null && pairCost <= 1 + EPS ? Number(P.W3048_CHEAP_PAIR_RANK_BONUS) : 0);
  return { side, size, fair, cap, ask: book.ask, signalCap, pairCap, oppositeCost,
    pairCost, isComplement, expectedEdge, pairEdge, utility, worstCaseImprovement,
    visibleDepth: depthThrough(book.asks, cap), risk, release };
}

export function validateParams(P = STRAT) {
  if (!(Number(P.W3048_SMALL_SIZE) > 0) || !(Number(P.W3048_LARGE_SIZE) >= Number(P.W3048_SMALL_SIZE))) {
    throw new Error("wallet3048 sizes must be positive and large >= small");
  }
  if (!(Number(P.W3048_START_S) >= 0) || !(Number(P.W3048_STOP_S) > Number(P.W3048_START_S))
    || Number(P.W3048_STOP_S) > Number(P.WINDOW_SEC || 300)) {
    throw new Error("wallet3048 active time range is invalid");
  }
  return true;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = Number(tk?.t) * 1000) {
  const model = init(state);
  if (!P.W3048_ON) { state.gateReason = "w3048-off"; return []; }
  if (!tk?.up || !tk?.down) { state.gateReason = "w3048-no-book"; return []; }
  if (Number(tk.t) < Number(P.W3048_START_S) || Number(tk.t) > Number(P.W3048_STOP_S)) {
    state.gateReason = "w3048-time"; return [];
  }
  if (model.actions >= Number(P.W3048_MAX_ACTIONS)) { state.gateReason = "w3048-action-cap"; return []; }

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
  if (clockMs - model.lastActionMs < Number(P.W3048_COOLDOWN_MS)) { state.gateReason = "w3048-cooldown"; return []; }
  if (model.pending.size || state.pendingFills?.length) { state.gateReason = "w3048-pending"; return []; }
  const fairUp = fairProbability(features, P);
  const progress = clamp((Number(tk.t) - Number(P.W3048_START_S))
    / Math.max(1, Number(P.W3048_STOP_S) - Number(P.W3048_START_S)), 0, 1);
  const candidates = [
    candidateFor(model, "Up", upBook, upRelease, fairUp, P, progress, clockMs),
    candidateFor(model, "Down", downBook, downRelease, 1 - fairUp, P, progress, clockMs),
  ].filter(Boolean).sort((a, b) => b.utility - a.utility || b.expectedEdge - a.expectedEdge
    || a.cap - b.cap || a.side.localeCompare(b.side));
  const chosen = candidates[0];
  if (!chosen) { state.gateReason = "w3048-no-release"; return []; }

  const oid = ++state.seq;
  const leg = chosen.isComplement ? "hedge" : "entry";
  const reason = model.up + model.down <= EPS ? "w3048-initial-release"
    : chosen.isComplement ? "w3048-inventory-repair" : "w3048-cycle-entry";
  const rec = {
    tInto: Number(tk.t),
    side: chosen.side,
    shares: chosen.size,
    requestedShares: chosen.size,
    effPx: chosen.ask,
    usdc: +(chosen.ask * chosen.size).toFixed(4),
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
    signal: {
      fairUp: +fairUp.toFixed(6),
      fairSide: +chosen.fair.toFixed(6),
      momentum5s: +features.momentum5s.toFixed(8),
      relativeLead: +features.relativeLead.toFixed(8),
      chainlinkDistance: +features.chainlinkDisplacement.toFixed(8),
      clobUpProbability: +features.clobUpProbability.toFixed(6),
      volatility: +features.volatility.toFixed(8),
      signalCap: +chosen.signalCap.toFixed(6),
      pairCap: chosen.pairCap == null ? null : +chosen.pairCap.toFixed(6),
      pairCost: chosen.pairCost == null ? null : +chosen.pairCost.toFixed(6),
      expectedEdge: +chosen.expectedEdge.toFixed(6),
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
