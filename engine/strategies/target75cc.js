// Evidence-backed target-wallet policy for 0x75cc…3ce1.
//
// The public data identifies a two-sided menu of pre-signed BUY cells, dynamic
// post-action residual sizing, and partial-reduction versus inventory-cross
// behavior. The release model below imitates observable behavior only; private
// wallet code and private order-construction state are not observable.

import { CROSS_TREE, MODEL_META, RESIDUAL_TREE } from "./target75cc-model.js";
import { RELEASE_META, RELEASE_MODEL, RELEASE_POLICY } from "./target75cc-release-model.js";
import { evaluateRegime, REGIME_POLICY } from "./target75cc-regime.js";

export const NAME = "target75cc";
export const LABEL = "FastMX · wallet-75cc logic";

export const STRAT = {
  STRATEGY: NAME,
  SIZE: 0,
  LIMIT: 0.99,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  LIVE_FILLS: false,
  FEE_BPS: 700,
  FEE_USE_MIN: false,
  FEE_ALL_FILLS: false,
  T_START_S: 4,
  T_STOP_S: 286,
  T_RELEASE_THRESHOLD: RELEASE_POLICY.threshold,
  T_DECISION_STEP_MS: 250,
  T_COOLDOWN_MS: RELEASE_POLICY.cooldownMs,
  T_MAX_CELL_USES: RELEASE_POLICY.maxCellUses,
  T_RESIDUAL_SCALE: 1,
  T_CROSS_THRESHOLD: MODEL_META.crossThreshold,
  T_MIN_ORDER_SH: 5,
  T_MAX_ORDER_SH: 227,
  T_MAX_GROSS_SH: 300,
  T_REGIME_ON: true,
  T_REGIME_DIAGNOSTICS: false,
  T_REGIME_MIN_PROBABILITY: REGIME_POLICY.minimumProbability,
  T_REGIME_MIN_EDGE: REGIME_POLICY.minimumEdge,
  T_REGIME_REVERSAL_MIN_PROBABILITY: REGIME_POLICY.reversalMinimumProbability,
  T_REGIME_CONFIRMED_REVERSAL_PROBABILITY: REGIME_POLICY.confirmedReversalProbability,
  T_REGIME_PULLBACK_MIN_PROBABILITY: REGIME_POLICY.pullbackMinimumProbability,
  T_REGIME_DOMINANT_THRESHOLD: REGIME_POLICY.dominantThreshold,
  T_REGIME_SHORT_THRESHOLD: REGIME_POLICY.shortCounterThreshold,
  T_REGIME_CONFIDENCE_SIZING: true,
  T_REGIME_SIZE_FLOOR: REGIME_POLICY.confidenceScaleFloor,
  T_REGIME_SIZE_CEILING: REGIME_POLICY.confidenceScaleCeiling,
  T_LIVE_ORDER_TYPE: "FAK",
  MAX_SESSION_LOSS: 25,
};

const EPS = 1e-9;
const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const number = (value, fallback = null) => finite(value) ? Number(value) : fallback;
const round4 = (value) => Math.round(Number(value) * 1e4) / 1e4;
const otherSide = (side) => side === "Up" ? "Down" : "Up";

function predict(tree, features) {
  let node = tree;
  while (Array.isArray(node)) {
    const [field, threshold, left, right] = node;
    node = Number(features[field]) <= threshold ? left : right;
  }
  return Number(node);
}

function levels(rows, ascending) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => [
    number(Array.isArray(row) ? row[0] : row?.price),
    number(Array.isArray(row) ? row[1] : row?.size),
  ]).filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((a, b) => ascending ? a[0] - b[0] : b[0] - a[0]);
}

function sideSnapshot(book) {
  const asks = levels(book?.asks, true), bids = levels(book?.bids, false);
  const ask = number(book?.bestAsk, asks[0]?.[0] ?? null);
  const bid = number(book?.bestBid, bids[0]?.[0] ?? null);
  const askDepth1 = asks[0]?.[1] ?? 0, bidDepth1 = bids[0]?.[1] ?? 0;
  const askDepth3 = asks.slice(0, 3).reduce((sum, row) => sum + row[1], 0);
  const bidDepth3 = bids.slice(0, 3).reduce((sum, row) => sum + row[1], 0);
  return { ask, bid, askDepth1, bidDepth1, askDepth3, bidDepth3 };
}

function pushFeatureSnapshot(model, tk, clockMs) {
  const snapshot = {
    ms: clockMs,
    bz: number(tk.bzPrice),
    cl: number(tk.clPrice),
    Up: sideSnapshot(tk.up),
    Down: sideSnapshot(tk.down),
  };
  const history = model.featureHistory;
  if (history.length && history.at(-1).ms === clockMs) history[history.length - 1] = snapshot;
  else history.push(snapshot);
  while (history.length > 2 && history[1].ms < clockMs - 65_000) history.shift();
  return snapshot;
}

function priorAt(history, targetMs) {
  let lo = 0, hi = history.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].ms <= targetMs) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found >= 0 ? history[found] : null;
}

function addFilledLot(model, fill) {
  if (!fill || fill.leg === "merge" || !["Up", "Down"].includes(fill.side)) return;
  let shares = number(fill.shares, 0);
  if (!(shares > 0)) return;
  const oppositeLots = model.lots[otherSide(fill.side)];
  while (shares > EPS && oppositeLots.length) {
    const take = Math.min(shares, oppositeLots[0].shares);
    shares -= take;
    oppositeLots[0].shares -= take;
    if (oppositeLots[0].shares <= EPS) oppositeLots.shift();
  }
  if (shares <= EPS) return;
  const price = number(fill.effPx, number(fill.usdc, 0) / number(fill.shares, 1));
  const feePerShare = price > 0 && price < 1 ? 0.07 * price * (1 - price) : 0;
  model.lots[fill.side].push({ shares, effectivePrice: price + feePerShare });
}

function eventClockMs(state, relativeSeconds, clockMs) {
  const seconds = number(relativeSeconds);
  if (seconds == null) return null;
  const windowStart = number(state.windowStart);
  return clockMs > 1e11 && windowStart != null
    ? (windowStart + seconds) * 1_000
    : seconds * 1_000;
}

function rememberDecision(model, state, event, clockMs) {
  if (!event || !["Up", "Down"].includes(event.side)) return;
  const eventMs = eventClockMs(state,
    number(event.decidedT, number(event.placedT, number(event.tInto))), clockMs);
  if (eventMs == null) return;
  model.lastFireMs = Math.max(model.lastFireMs, eventMs);
  model.lastSideFireMs[event.side] = Math.max(model.lastSideFireMs[event.side], eventMs);
}

function syncPersistedActivity(state, model, clockMs) {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  while (model.processedOrders < orders.length) {
    rememberDecision(model, state, orders[model.processedOrders++], clockMs);
  }
  const fills = Array.isArray(state.fills) ? state.fills : [];
  while (model.processedFills < fills.length) {
    const fill = fills[model.processedFills++];
    addFilledLot(model, fill);
    rememberDecision(model, state, fill, clockMs);
  }
}

function firstLotCost(lots, shares) {
  let left = Math.max(0, shares), cost = 0, used = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    cost += take * lot.effectivePrice;
    used += take;
    left -= take;
    if (left <= EPS) break;
  }
  return used > EPS ? cost / used : null;
}

function effectiveInventory(state) {
  let up = number(state.upShares, 0), down = number(state.downShares, 0);
  for (const pending of (state.pendingFills || [])) {
    const rec = pending?.rec;
    if (!rec) continue;
    const shares = number(rec.minimumShares, number(rec.shares, 0));
    if (rec.side === "Up") up += shares;
    else if (rec.side === "Down") down += shares;
  }
  return { up, down, net: up - down, gross: up + down };
}

function targetFeatures(state, model, tk, current, side, clockMs) {
  const sign = side === "Up" ? 1 : -1;
  const book = current[side], opposite = current[otherSide(side)];
  const inventory = effectiveInventory(state);
  const orientedInventory = inventory.net * sign;
  const prior1 = priorAt(model.featureHistory, clockMs - 1_000);
  const prior5 = priorAt(model.featureHistory, clockMs - 5_000);
  const prior10 = priorAt(model.featureHistory, clockMs - 10_000);
  const oldLotCost = orientedInventory < -EPS
    ? firstLotCost(model.lots[otherSide(side)], Math.min(30, Math.abs(orientedInventory))) : null;
  const feePerShare = book.ask > 0 && book.ask < 1 ? 0.07 * book.ask * (1 - book.ask) : 0;
  return {
    timeS: number(tk.t, 0),
    ask: book.ask,
    spread: finite(book.ask) && finite(book.bid) ? book.ask - book.bid : null,
    pairAsk: finite(book.ask) && finite(opposite.ask) ? book.ask + opposite.ask : null,
    askDepth1: book.askDepth1,
    bidDepth1: book.bidDepth1,
    askDepth3: book.askDepth3,
    bidDepth3: book.bidDepth3,
    topDepthImbalance: (book.bidDepth1 - book.askDepth1)
      / Math.max(EPS, book.bidDepth1 + book.askDepth1),
    topAskShareOfDepth3: book.askDepth1 / Math.max(EPS, book.askDepth3),
    askDepth3Change1: prior1 ? book.askDepth3 - prior1[side].askDepth3 : null,
    bidDepth3Change5: prior5 ? book.bidDepth3 - prior5[side].bidDepth3 : null,
    sideBidMove10: prior10 && finite(prior10[side].bid) ? book.bid - prior10[side].bid : null,
    bzMove10: prior10?.bz > 0 && current.bz > 0
      ? (current.bz - prior10.bz) / prior10.bz * 100 * sign : null,
    clGap: current.cl > 0 && number(tk.openChainlink) > 0
      ? (current.cl - Number(tk.openChainlink)) / Number(tk.openChainlink) * 100 * sign : null,
    absoluteInventory: Math.abs(inventory.net),
    orientedInventory,
    isHedge: orientedInventory < -EPS ? 1 : 0,
    fifoPairCost: oldLotCost == null ? null : oldLotCost + book.ask + feePerShare,
    sinceLastFireS: Number.isFinite(model.lastFireMs) ? (clockMs - model.lastFireMs) / 1_000 : 300,
    sinceSameSideFireS: Number.isFinite(model.lastSideFireMs[side])
      ? (clockMs - model.lastSideFireMs[side]) / 1_000 : 300,
    inventory,
  };
}

const capFeatureIndex = new Map(RELEASE_MODEL.featureNames.map((name, index) => [name, index]));
function releaseScore(raw) {
  let logit = number(RELEASE_MODEL.intercept, 0);
  for (const [name, index] of capFeatureIndex) {
    const value = number(raw[name], 0);
    const mean = number(RELEASE_MODEL.normalization.mean[index], 0);
    const scale = Math.max(EPS, number(RELEASE_MODEL.normalization.scale[index], 1));
    logit += number(RELEASE_MODEL.weights[index], 0) * (value - mean) / scale;
  }
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}

const pctMove = (current, prior) => current > 0 && prior > 0
  ? (current - prior) / prior * 100 : 0;
const basisPct = (snapshot) => snapshot?.bz > 0 && snapshot?.cl > 0
  ? (snapshot.bz - snapshot.cl) / snapshot.cl * 100 : 0;
function releaseFeatures(state, model, tk, current, side, cap, clockMs) {
  const sign = side === "Up" ? 1 : -1, book = current[side], other = current[otherSide(side)];
  const inventory = effectiveInventory(state), orientedInventory = inventory.net * sign;
  const raw = {
    timeFraction: number(tk.t, 0) / 300,
    ask: book.ask,
    cap,
    capHeadroom: cap - book.ask,
    exactCap: Number(Math.abs(cap - book.ask) < .005),
    spread: book.ask - book.bid,
    pairAsk: book.ask + other.ask,
    askDepth1: book.askDepth1,
    askDepth3: book.askDepth3,
    bidDepth1: book.bidDepth1,
    bidDepth3: book.bidDepth3,
    topDepthImbalance: (book.bidDepth1 - book.askDepth1) / Math.max(EPS, book.bidDepth1 + book.askDepth1),
    depth3Imbalance: (book.bidDepth3 - book.askDepth3) / Math.max(EPS, book.bidDepth3 + book.askDepth3),
    micropriceBias: (book.bidDepth1 * book.ask + book.askDepth1 * book.bid)
      / Math.max(EPS, book.bidDepth1 + book.askDepth1) - (book.ask + book.bid) / 2,
    // These six fields have zero weights in the frozen observable model. They
    // remain populated for schema/audit parity with its research artifact.
    executableRunLog: 0,
    sinceLastFireLog: Math.log1p(Math.min(300, Number.isFinite(model.lastFireMs)
      ? Math.max(0, (clockMs - model.lastFireMs) / 1_000) : 300)),
    sinceSameSideFireLog: Math.log1p(Math.min(300, Number.isFinite(model.lastSideFireMs[side])
      ? Math.max(0, (clockMs - model.lastSideFireMs[side]) / 1_000) : 300)),
    absoluteInventoryLog: Math.log1p(Math.abs(inventory.net)),
    orientedInventory,
    oppositeInventory: Math.max(0, -orientedInventory),
    binanceGap: current.bz > 0 && number(tk.openBinance) > 0
      ? pctMove(current.bz, Number(tk.openBinance)) * sign : 0,
    twapGap: current.cl > 0 && number(tk.openChainlink) > 0
      ? pctMove(current.cl, Number(tk.openChainlink)) * sign : 0,
    binanceTwapBasis: basisPct(current) * sign,
  };
  for (const lookbackMs of [1_000, 3_000, 5_000, 15_000, 30_000, 60_000]) {
    const prior = priorAt(model.featureHistory, clockMs - lookbackMs);
    raw[`askMove${lookbackMs}`] = prior && finite(prior[side].ask) ? book.ask - prior[side].ask : 0;
    raw[`bidMove${lookbackMs}`] = prior && finite(prior[side].bid) ? book.bid - prior[side].bid : 0;
    raw[`binanceMove${lookbackMs}`] = prior ? pctMove(current.bz, prior.bz) * sign : 0;
    raw[`twapMove${lookbackMs}`] = prior ? pctMove(current.cl, prior.cl) * sign : 0;
    raw[`basisMove${lookbackMs}`] = prior ? (basisPct(current) - basisPct(prior)) * sign : 0;
    if (lookbackMs <= 5_000) {
      raw[`askDepth3Change${lookbackMs}`] = prior ? book.askDepth3 - prior[side].askDepth3 : 0;
      raw[`bidDepth3Change${lookbackMs}`] = prior ? book.bidDepth3 - prior[side].bidDepth3 : 0;
    }
  }
  return raw;
}

function ceilCent(price) { return Math.ceil((price - EPS) * 100) / 100; }
function availableDepth(book, cap) {
  return levels(book?.asks, true).filter(([price]) => price <= cap + EPS)
    .reduce((sum, [, size]) => sum + size, 0);
}
function nextMenuCap(model, side, ask, maxUses, limit) {
  for (let cents = Math.round(ceilCent(ask) * 100); cents <= Math.round(limit * 100); cents++) {
    if ((model.cellUses.get(`${side}:${cents}`) || 0) < maxUses) return cents / 100;
  }
  return null;
}

function releaseCandidate(state, model, tk, current, P, clockMs) {
  const candidates = [];
  const maxUses = Math.max(1, Math.round(number(P.T_MAX_CELL_USES, RELEASE_POLICY.maxCellUses)));
  const limit = Math.min(.99, Math.max(.01, number(P.LIMIT, .99)));
  for (const side of ["Up", "Down"]) {
    const book = current[side];
    if (!(book.ask > 0 && book.bid > 0 && current[otherSide(side)].ask > 0)) continue;
    const cap = nextMenuCap(model, side, book.ask, maxUses, limit);
    if (cap == null) continue;
    const raw = releaseFeatures(state, model, tk, current, side, cap, clockMs);
    candidates.push({ side, cap, ask: book.ask, score: releaseScore(raw), raw,
      available: availableDepth(tk[side.toLowerCase()], cap), cell: `${side}:${Math.round(cap * 100)}` });
  }
  candidates.sort((a, b) => b.score - a.score || a.cap - b.cap || a.side.localeCompare(b.side));
  return candidates[0] || null;
}

function setStatus(state, candidateStatus, values) {
  const inventory = effectiveInventory(state);
  const status = { ...(candidateStatus || {}), strategy: NAME, ...values,
    upShares: inventory.up, downShares: inventory.down, net: inventory.net };
  state.strategyStatus = status;
  state.gateReason = status.gate;
}

function modelState(state) {
  return state.target75cc || (state.target75cc = {
    featureHistory: [],
    lots: { Up: [], Down: [] },
    processedOrders: 0,
    processedFills: 0,
    lastFireMs: -Infinity,
    lastSideFireMs: { Up: -Infinity, Down: -Infinity },
    lastDecisionMs: -Infinity,
    cellUses: new Map(),
    orderCount: 0,
  });
}

export function validateParams(P = STRAT) {
  const min = number(P.T_MIN_ORDER_SH, 5), max = number(P.T_MAX_ORDER_SH, 227);
  if (!(min > 0 && max >= min)) throw new RangeError("target order bounds require 0 < min <= max");
  if (!(number(P.T_MAX_GROSS_SH, 300) >= min)) throw new RangeError("target gross-share cap is below minimum order");
  if (!(number(P.T_RESIDUAL_SCALE, 1) > 0)) throw new RangeError("target residual scale must be positive");
  if (!(number(P.T_CROSS_THRESHOLD, MODEL_META.crossThreshold) >= 0
    && number(P.T_CROSS_THRESHOLD, MODEL_META.crossThreshold) <= 1)) {
    throw new RangeError("target cross threshold must be between zero and one");
  }
  if (!(number(P.T_RELEASE_THRESHOLD, RELEASE_POLICY.threshold) >= 0
    && number(P.T_RELEASE_THRESHOLD, RELEASE_POLICY.threshold) <= 1)) {
    throw new RangeError("target release threshold must be between zero and one");
  }
  if (!(number(P.T_STOP_S, 286) > number(P.T_START_S, 4))) {
    throw new RangeError("target active interval requires stop > start");
  }
  for (const [name, fallback] of [["T_REGIME_MIN_PROBABILITY", .5],
    ["T_REGIME_REVERSAL_MIN_PROBABILITY", .5],
    ["T_REGIME_CONFIRMED_REVERSAL_PROBABILITY", .7],
    ["T_REGIME_PULLBACK_MIN_PROBABILITY", .5]]) {
    if (!(number(P[name], fallback) >= 0 && number(P[name], fallback) <= 1)) {
      throw new RangeError(`${name} must be between zero and one`);
    }
  }
  if (!(number(P.T_REGIME_SIZE_FLOOR, .5) > 0
    && number(P.T_REGIME_SIZE_CEILING, 1.5) >= number(P.T_REGIME_SIZE_FLOOR, .5))) {
    throw new RangeError("target regime size bounds require 0 < floor <= ceiling");
  }
  return true;
}

export function step(state, tk, P = STRAT, dtMs = 120, clockMs = tk.t * 1000) {
  const model = modelState(state);
  model.cellUses ||= new Map();
  if (!Number.isFinite(model.lastDecisionMs)) model.lastDecisionMs = -Infinity;
  syncPersistedActivity(state, model, clockMs);
  const current = pushFeatureSnapshot(model, tk, clockMs);
  state.placedThisTick = [];

  const startS = number(P.T_START_S, 4), stopS = number(P.T_STOP_S, 286);
  if (number(tk.t, 0) < startS || number(tk.t, 0) > stopS) {
    setStatus(state, null, { gate: "target-outside-active-window", startS, stopS });
    return [];
  }
  const decisionStepMs = Math.max(50, number(P.T_DECISION_STEP_MS, 250));
  if (clockMs - model.lastDecisionMs < decisionStepMs) {
    setStatus(state, null, { gate: "target-decision-cadence", decisionStepMs });
    return [];
  }
  model.lastDecisionMs = clockMs;
  const cooldownMs = Math.max(0, number(P.T_COOLDOWN_MS, RELEASE_POLICY.cooldownMs));
  if (clockMs - model.lastFireMs < cooldownMs) {
    setStatus(state, null, {
      gate: "target-cooldown", cooldownMs,
      cooldownRemainingMs: cooldownMs - (clockMs - model.lastFireMs),
    });
    return [];
  }

  const candidate = releaseCandidate(state, model, tk, current, P, clockMs);
  const releaseThreshold = number(P.T_RELEASE_THRESHOLD, RELEASE_POLICY.threshold);
  if (!candidate || candidate.score < releaseThreshold) {
    setStatus(state, null, {
      gate: !candidate ? "target-no-menu-cell" : "target-release-below-threshold",
      releaseScore: candidate?.score ?? null,
      releaseThreshold,
      candidateSide: candidate?.side ?? null,
      candidateCap: candidate?.cap ?? null,
    });
    return [];
  }

  const regime = (P.T_REGIME_ON || P.T_REGIME_DIAGNOSTICS) ? evaluateRegime({ history: model.featureHistory, current, tk,
    side: candidate.side, clockMs, P }) : null;
  if (P.T_REGIME_ON && (!regime || !regime.allowed)) {
    setStatus(state, null, {
      gate: !regime ? "target-regime-unavailable" : "target-regime-rejected",
      side: candidate.side,
      releaseScore: candidate.score,
      releaseThreshold,
      regimeClass: regime?.classification ?? null,
      sideProbability: regime?.sideProbability ?? null,
      expectedEdge: regime?.expectedEdge ?? null,
      noiseProbability: regime?.noiseProbability ?? null,
      reversalProbability: regime?.reversalProbability ?? null,
      dominantScore: regime?.dominantScore ?? null,
      shortScore: regime?.shortScore ?? null,
    });
    return [];
  }

  const side = candidate.side;
  const features = targetFeatures(state, model, tk, current, side, clockMs);
  const residualScale = number(P.T_RESIDUAL_SCALE, 1);
  const basePredictedResidual = Math.max(0, predict(RESIDUAL_TREE, features) * residualScale);
  const confidenceSizeScale = P.T_REGIME_ON ? number(regime?.sizeScale, 1) : 1;
  const predictedResidual = Math.max(0, Math.round(basePredictedResidual * confidenceSizeScale));
  const oppositeSignal = features.orientedInventory < -EPS;
  const crossScore = oppositeSignal ? predict(CROSS_TREE, features) : null;
  const crosses = oppositeSignal
    && crossScore >= number(P.T_CROSS_THRESHOLD, MODEL_META.crossThreshold);
  const desiredOrientedShares = oppositeSignal && !crosses ? -predictedResidual : predictedResidual;
  const rawShares = Math.ceil(desiredOrientedShares - features.orientedInventory - EPS);
  const minOrder = Math.max(1, number(P.T_MIN_ORDER_SH, 5));
  const maxOrder = Math.max(minOrder, number(P.T_MAX_ORDER_SH, 227));
  const grossRoom = Math.max(0, number(P.T_MAX_GROSS_SH, 300) - features.inventory.gross);
  const shares = Math.min(maxOrder, grossRoom, rawShares);
  const role = !oppositeSignal ? (Math.abs(features.orientedInventory) <= EPS ? "entry" : "topup")
    : crosses ? "reversal" : "hedge";

  if (!(shares >= minOrder)) {
    setStatus(state, null, {
      gate: grossRoom < minOrder ? "target-gross-cap" : "target-residual-satisfied",
      side, role, predictedResidual, desiredOrientedShares,
      orientedInventory: features.orientedInventory, rawShares, grossRoom, crossScore,
      upShares: features.inventory.up, downShares: features.inventory.down,
      net: features.inventory.net,
    });
    return [];
  }

  const oid = state.seq = (number(state.seq, 0) + 1);
  const budgetUsd = round4(candidate.cap * shares);
  const leg = role === "entry" || role === "topup" ? "entry" : role;
  const rec = {
    tInto: tk.t,
    side,
    effPx: round4(candidate.ask),
    exec: "marketable",
    limitPx: round4(candidate.cap),
    kind: "taker",
    status: "full",
    postOnly: false,
    orderType: "FAK",
    liveOrderType: String(P.T_LIVE_ORDER_TYPE || "FAK").toUpperCase(),
    oid,
    shares: round4(shares),
    minimumShares: round4(shares),
    budgetUsd,
    amountMode: "usd",
    usdc: budgetUsd,
    leg,
    role,
    reason: `target75cc-${role}-residual`,
    signal: {
      releaseModelSha256: RELEASE_META.modelSha256,
      releaseScore: round4(candidate.score),
      releaseThreshold,
      capDepth: round4(candidate.available),
      menuCell: candidate.cell,
      regimeModelSha256: regime?.modelSha256 ?? null,
      regimeClass: regime?.classification ?? null,
      sideProbability: regime == null ? null : round4(regime.sideProbability),
      expectedEdge: regime == null ? null : round4(regime.expectedEdge),
      noiseProbability: regime == null ? null : round4(regime.noiseProbability),
      reversalProbability: regime == null ? null : round4(regime.reversalProbability),
      dominantScore: regime == null ? null : round4(regime.dominantScore),
      shortScore: regime == null ? null : round4(regime.shortScore),
      confidence: regime == null ? null : round4(regime.confidence),
      confidenceSizeScale: round4(confidenceSizeScale),
    },
    model: {
      residualSha256: MODEL_META.residualSha256,
      crossSha256: MODEL_META.crossSha256,
      predictedResidual,
      basePredictedResidual: round4(basePredictedResidual),
      desiredOrientedShares,
      orientedInventory: round4(features.orientedInventory),
      absoluteInventory: round4(features.absoluteInventory),
      crossScore: crossScore == null ? null : round4(crossScore),
      crossThreshold: number(P.T_CROSS_THRESHOLD, MODEL_META.crossThreshold),
      rawShares,
      cappedShares: shares,
      features: Object.fromEntries(Object.entries(features)
        .filter(([key]) => key !== "inventory")
        .map(([key, value]) => [key, finite(value) ? round4(value) : value])),
      regimeFeatures: regime ? Object.fromEntries(Object.entries(regime.features)
        .map(([key, value]) => [key, finite(value) ? round4(value) : value])) : null,
    },
  };
  model.cellUses.set(candidate.cell, (model.cellUses.get(candidate.cell) || 0) + 1);
  model.lastFireMs = clockMs;
  model.lastSideFireMs[side] = clockMs;
  model.orderCount++;
  state.orders = state.orders || [];
  state.orders.push({ oid, side, limit: rec.limitPx, kind: leg,
    budgetUsd, filledUsd: 0, placedT: tk.t });
  state.placedThisTick = [{ oid, side, shares: rec.shares,
    minimumShares: rec.minimumShares, budgetUsd, limitPx: rec.limitPx,
    leg, role, reason: rec.reason }];
  setStatus(state, null, {
    gate: "fired", side, role, minimumShares: shares, budgetUsd,
    releaseScore: candidate.score, releaseThreshold, menuCell: candidate.cell,
    predictedResidual, desiredOrientedShares,
    orientedInventory: features.orientedInventory,
    crossScore, crossThreshold: number(P.T_CROSS_THRESHOLD, MODEL_META.crossThreshold),
    regimeClass: regime?.classification ?? null,
    sideProbability: regime?.sideProbability ?? null,
    expectedEdge: regime?.expectedEdge ?? null,
    confidenceSizeScale,
    upShares: features.inventory.up, downShares: features.inventory.down,
    net: features.inventory.net,
    modelOrderCount: model.orderCount,
  });
  return [rec];
}

export function clearLivePending() {}
