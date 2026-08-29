// Public-data reconstruction of wallet 0x3048…e7537.
//
// This is deliberately isolated from Lockstep's Binance/Chainlink spot feeds.
// The reconstructed release rule is driven by the live CLOB L2 ladder:
//   - same-side ask depth is thin/depleting;
//   - bid/ask depth imbalance and microprice support that side;
//   - a GTC buy is submitted at the exact decision ask with postOnly=false;
//   - opposite inventory is preferred when the fee-inclusive pair cost <= 1.
// It reproduces observable mechanics, not private configuration or queue state.

import { fillFee } from '../fees.js';

export const NAME = 'wallet3048';
export const LABEL = 'Wallet 3048 (Research)';

export const STRAT = {
  STRATEGY: NAME,
  SIZE: 25,
  LIMIT: 0.89,
  LATENCY_MS: 520,
  WINDOW_SEC: 300,
  LIVE_FILLS: false,

  W3048_ON: true,
  W3048_RELEASE_ON: true,
  W3048_MIN_PRICE: 0.12,
  W3048_MAX_PRICE: 0.89,
  W3048_START_S: 4,
  W3048_STOP_S: 270,
  W3048_COOLDOWN_MS: 1500,
  W3048_DEPTH_STALE_MS: 1000,
  W3048_DEPTH1_MAX: 100,
  W3048_DEPTH3_MAX: 650,
  W3048_DEPLETION1_MAX: -150,
  W3048_TOP_IMBALANCE_MIN: 0.5,
  W3048_DEPTH3_IMBALANCE_MIN: 0.2,
  W3048_MICROPRICE_BIAS_MIN: 0.0025,
  W3048_PAIR_CAP: 1.0,
  W3048_MAX_LEAN_MULT: 6,
  W3048_LARGE_MULT: 3,
  W3048_MAX_ACTIONS: 60,
  W3048_SPOT_TIE_WEIGHT: 0.05,

  // Participation floor. The strict public L2 release tree above keeps
  // priority. If it has not produced inventory, submit a minimum-size
  // marketable GTC on the best causal side so every eligible five-minute
  // market receives an order attempt. A stale/unfilled order must be canceled
  // by the normal reconciler before another attempt is allowed.
  W3048_PARTICIPATE_EVERY_MARKET: true,
  W3048_PARTICIPATION_START_S: 30,
  W3048_PARTICIPATION_SIZE: 5,
  W3048_PARTICIPATION_MAX_ATTEMPTS: 3,
  W3048_PARTICIPATION_LIMIT_OFFSET: 0.02,
  W3048_PARTICIPATION_SPOT_SCALE_PCT: 0.05,
  W3048_PARTICIPATION_SPOT_WEIGHT: 0.7,
  W3048_PARTICIPATION_MARKET_WEIGHT: 0.3,
};

const EPS = 1e-9;
const opposite = (side) => side === 'Up' ? 'Down' : 'Up';
const sign = (side) => side === 'Up' ? 1 : -1;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function rows(levels) {
  return (Array.isArray(levels) ? levels : []).map((row) => ({
    price: Number(Array.isArray(row) ? row[0] : row?.price),
    size: Number(Array.isArray(row) ? row[1] : row?.size),
  })).filter((row) => finite(row.price) && finite(row.size) && row.size > 0);
}

function depth(levels, count) {
  return levels.slice(0, count).reduce((sum, row) => sum + row.size, 0);
}

function init(state) {
  if (state.placedThisTick) state.placedThisTick.length = 0; else state.placedThisTick = [];
  state.orders ||= [];
  state.seq ||= 0;
  if (!state.wallet3048) {
    state.wallet3048 = {
      up: 0,
      down: 0,
      lots: { Up: [], Down: [] },
      trace: { Up: [], Down: [] },
      lastActionMs: -Infinity,
      actions: 0,
      participationAttempts: 0,
      pending: new Map(),
    };
  }
  return state.wallet3048;
}

function traceFeature(model, side, book, nowMs) {
  const asks = rows(book?.asks);
  const bids = rows(book?.bids);
  if (asks.length < 3 || bids.length < 3) return null;
  const ask = Number(book.bestAsk ?? asks[0].price);
  const bid = Number(book.bestBid ?? bids[0].price);
  if (!finite(ask) || !finite(bid)) return null;
  const askDepth1 = depth(asks, 1);
  const bidDepth1 = depth(bids, 1);
  const askDepth3 = depth(asks, 3);
  const bidDepth3 = depth(bids, 3);
  const history = model.trace[side];
  let prior = null;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].ms <= nowMs - 1000) { prior = history[index]; break; }
  }
  const feature = {
    ms: nowMs,
    side,
    ask,
    bid,
    askDepth1,
    bidDepth1,
    askDepth3,
    bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(EPS, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(EPS, bidDepth3 + askDepth3),
    micropriceBias: (bidDepth1 * ask + askDepth1 * bid) / Math.max(EPS, bidDepth1 + askDepth1) - (ask + bid) / 2,
    askDepth3Change1: prior ? askDepth3 - prior.askDepth3 : null,
  };
  if (!history.length || history.at(-1).ms !== nowMs) history.push(feature);
  while (history.length && history[0].ms < nowMs - 5000) history.shift();
  return feature;
}

// Transparent approximation of the source-stable v2/v4 fire tree. A strict
// conjunction defines eligibility; score only ranks simultaneous Up/Down cells.
export function releaseCandidate(feature, P) {
  if (!feature || !finite(feature.askDepth3Change1)) return null;
  const thin = feature.askDepth3 <= Number(P.W3048_DEPTH3_MAX)
    && feature.askDepth1 <= Number(P.W3048_DEPTH1_MAX);
  const supported = feature.topDepthImbalance >= Number(P.W3048_TOP_IMBALANCE_MIN)
    && feature.depth3Imbalance >= Number(P.W3048_DEPTH3_IMBALANCE_MIN);
  const releasing = feature.askDepth3Change1 <= Number(P.W3048_DEPLETION1_MAX)
    || feature.micropriceBias >= Number(P.W3048_MICROPRICE_BIAS_MIN);
  if (!thin || !supported || !releasing) return null;
  const score =
    (Number(P.W3048_DEPTH3_MAX) - feature.askDepth3) / Math.max(1, Number(P.W3048_DEPTH3_MAX))
    + (Number(P.W3048_DEPTH1_MAX) - feature.askDepth1) / Math.max(1, Number(P.W3048_DEPTH1_MAX))
    + feature.topDepthImbalance
    + feature.depth3Imbalance
    + clamp(-feature.askDepth3Change1 / 300, -1, 2)
    + clamp(feature.micropriceBias / 0.005, -1, 1);
  return { ...feature, score };
}

function firstLotCost(lots, shares) {
  let left = shares;
  let cost = 0;
  let used = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take;
    used += take;
    cost += take * lot.effectivePrice;
    if (left <= EPS) break;
  }
  return used >= shares - EPS ? cost / used : null;
}

function applyFill(model, side, shares, price, taker = true) {
  const other = opposite(side);
  let left = Number(shares);
  while (left > EPS && model.lots[other].length) {
    const lot = model.lots[other][0];
    const take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    if (lot.shares <= EPS) model.lots[other].shift();
  }
  if (left > EPS) {
    const feePerShare = taker ? fillFee(price, 1, true) : 0;
    model.lots[side].push({ shares: left, effectivePrice: Number(price) + feePerShare });
  }
  if (side === 'Up') model.up += Number(shares); else model.down += Number(shares);
}

function spotTie(side, tk, P) {
  const observations = [tk.bzGapPct, tk.clGapPct].filter(finite).map(Number);
  if (!observations.length) return 0;
  const mean = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  return Number(P.W3048_SPOT_TIE_WEIGHT || 0) * sign(side) * clamp(mean / 0.02, -1, 1);
}

function topOfBook(book) {
  const asks = rows(book?.asks);
  const bids = rows(book?.bids);
  const ask = finite(book?.bestAsk) ? Number(book.bestAsk) : asks[0]?.price;
  const bid = finite(book?.bestBid) ? Number(book.bestBid) : bids[0]?.price;
  return { ask, bid };
}

// Causal fallback side selection for the participation floor. Spot direction
// uses the unchanged Binance and Chainlink window-open gaps. The CLOB term is
// the current side midpoint (or the binary-complement midpoint reconstructed
// from both asks when a bid is temporarily unavailable).
export function participationCandidate(tk, P) {
  const up = topOfBook(tk?.up), down = topOfBook(tk?.down);
  const upAsk = up.ask, downAsk = down.ask;
  if (!finite(upAsk) || !finite(downAsk)) return null;
  const upMid = finite(up.bid) ? (upAsk + up.bid) / 2 : (upAsk + 1 - downAsk) / 2;
  const downMid = finite(down.bid) ? (downAsk + down.bid) / 2 : (downAsk + 1 - upAsk) / 2;
  const gaps = [tk?.bzGapPct, tk?.clGapPct].filter(finite).map(Number);
  const meanGap = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const scale = Math.max(EPS, Number(P.W3048_PARTICIPATION_SPOT_SCALE_PCT || .05));
  const spot = clamp(meanGap / scale, -1, 1);
  const spotWeight = Math.max(0, Number(P.W3048_PARTICIPATION_SPOT_WEIGHT || 0));
  const marketWeight = Math.max(0, Number(P.W3048_PARTICIPATION_MARKET_WEIGHT || 0));
  const minPrice = Number(P.W3048_MIN_PRICE);
  const maxPrice = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? .89));
  const candidates = [
    { side: 'Up', ask: upAsk, mid: upMid, score: spotWeight * spot + marketWeight * (upMid - .5) * 2 },
    { side: 'Down', ask: downAsk, mid: downMid, score: -spotWeight * spot + marketWeight * (downMid - .5) * 2 },
  ].filter((candidate) => candidate.ask >= minPrice && candidate.ask <= maxPrice);
  candidates.sort((a, b) => b.score - a.score || b.mid - a.mid || a.ask - b.ask || a.side.localeCompare(b.side));
  return candidates[0] || null;
}

export function step(state, tk, P, _dtMs = 120, clockMs = tk.t * 1000) {
  const model = init(state);
  if (!P.W3048_ON) { state.gateReason = 'w3048-off'; return []; }
  if (!tk.up || !tk.down) { state.gateReason = 'w3048-no-book'; return []; }
  if (tk.t < Number(P.W3048_START_S) || tk.t > Number(P.W3048_STOP_S)) {
    state.gateReason = 'w3048-time'; return [];
  }
  if (model.actions >= Number(P.W3048_MAX_ACTIONS)) { state.gateReason = 'w3048-action-cap'; return []; }
  if (clockMs - model.lastActionMs < Number(P.W3048_COOLDOWN_MS)) { state.gateReason = 'w3048-cooldown'; return []; }
  if (model.pending.size) { state.gateReason = 'w3048-pending'; return []; }
  const depthAge = Math.max(clockMs - Number(tk.up.depthTs || 0), clockMs - Number(tk.down.depthTs || 0));
  // The reconstructed release tree depends on the full L2 ladder and therefore
  // remains fail-closed when depth is stale. The every-market participation
  // floor only needs the current top of book supplied by the triggering BBA
  // update, so stale L2 must not suppress that bounded fallback.
  const depthFresh = finite(tk.up.depthTs) && finite(tk.down.depthTs)
    && depthAge <= Number(P.W3048_DEPTH_STALE_MS);

  const base = Math.max(1, Number(P.SIZE || 25));
  const imbalance = model.up - model.down;
  const candidates = [];
  const releaseEnabled = P.W3048_RELEASE_ON !== false;
  for (const [side, book] of releaseEnabled && depthFresh ? [['Up', tk.up], ['Down', tk.down]] : []) {
    const feature = traceFeature(model, side, book, clockMs);
    const release = releaseCandidate(feature, P);
    if (!release) continue;
    const minPrice = Number(P.W3048_MIN_PRICE);
    const maxPrice = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? 0.89));
    if (release.ask < minPrice || release.ask > maxPrice) continue;
    const oriented = imbalance * sign(side);
    const isHedge = oriented < -EPS;
    let pairCost = null;
    if (isHedge) {
      const lotCost = firstLotCost(model.lots[opposite(side)], Math.min(base, Math.abs(imbalance)));
      pairCost = lotCost == null ? null : lotCost + release.ask + fillFee(release.ask, 1, true);
      if (pairCost == null || pairCost > Number(P.W3048_PAIR_CAP) + EPS) continue;
    } else if (oriented >= base * Number(P.W3048_MAX_LEAN_MULT) - EPS) continue;
    candidates.push({ side, release, isHedge, pairCost, score: release.score + spotTie(side, tk, P) + (isHedge ? 2 : 0) });
  }
  let chosen = null;
  let participationFloor = false;
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.release.ask - b.release.ask);
    chosen = candidates[0];
  } else {
    const participate = P.W3048_PARTICIPATE_EVERY_MARKET === true;
    const participationStart = Math.max(Number(P.W3048_START_S), Number(P.W3048_PARTICIPATION_START_S || 0));
    const maxAttempts = Math.max(1, Math.floor(Number(P.W3048_PARTICIPATION_MAX_ATTEMPTS || 1)));
    const hasInventory = model.up + model.down > EPS;
    if (!participate || tk.t < participationStart || hasInventory || model.participationAttempts >= maxAttempts) {
      state.gateReason = 'w3048-no-release'; return [];
    }
    const floor = participationCandidate(tk, P);
    if (!floor) { state.gateReason = 'w3048-participation-price'; return []; }
    chosen = { side: floor.side, release: { ask: floor.ask }, isHedge: false, pairCost: null, score: floor.score };
    participationFloor = true;
  }
  let requested = participationFloor
    ? Math.max(1, Number(P.W3048_PARTICIPATION_SIZE || 1))
    : base;
  if (chosen.isHedge && Math.abs(imbalance) >= base * Number(P.W3048_LARGE_MULT) - EPS) {
    requested = Math.min(Math.abs(imbalance), base * Number(P.W3048_LARGE_MULT));
  }
  const oid = ++state.seq;
  const price = chosen.release.ask;
  const maxPrice = Math.min(Number(P.W3048_MAX_PRICE), Number(P.LIMIT ?? .89));
  const rawOrderLimit = participationFloor
    ? Math.min(maxPrice, price + Math.max(0, Number(P.W3048_PARTICIPATION_LIMIT_OFFSET || 0)))
    : price;
  const orderLimit = Math.round(rawOrderLimit * 100) / 100;
  const rec = {
    tInto: tk.t,
    side: chosen.side,
    shares: requested,
    effPx: price,
    usdc: +(price * requested).toFixed(4),
    exec: 'marketable',
    limitPx: orderLimit,
    kind: 'gtc',
    leg: chosen.isHedge ? 'hedge' : 'entry',
    reason: chosen.isHedge ? 'w3048-pair-hedge' : (participationFloor ? 'w3048-participation-floor' : 'w3048-l2-release'),
    status: 'full',
    oid,
    postOnly: false,
    releaseScore: +chosen.score.toFixed(6),
    pairCost: chosen.pairCost == null ? null : +chosen.pairCost.toFixed(6),
    participationFloor,
  };
  model.lastActionMs = clockMs;
  model.actions++;
  if (participationFloor) model.participationAttempts++;
  if (P.LIVE_FILLS) model.pending.set(oid, { side: chosen.side, requested, filled: 0 });
  else applyFill(model, chosen.side, requested, price, true);
  state.orders.push({ oid, side: chosen.side, limit: orderLimit, kind: rec.leg, budgetUsd: rec.usdc, filledUsd: P.LIVE_FILLS ? 0 : rec.usdc, placedT: tk.t });
  state.placedThisTick.push({ oid, side: chosen.side, limit: orderLimit, shares: requested, leg: rec.leg, postOnly: false });
  state.gateReason = chosen.isHedge ? 'w3048-hedge' : 'w3048-entry';
  return [rec];
}

export function injectRealFill(state, fill) {
  const model = init(state);
  const shares = Number(fill?.shares);
  const price = Number(fill?.px);
  if (!(shares > 0) || !finite(price)) return;
  applyFill(model, fill.side, shares, price, true);
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
