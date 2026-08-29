const EPS = 1e-9;

export const WALLET_3048 = "0x3048d65321be3497164cdfc2996f94f98a2e7537";

const nkey = (value, digits = 8) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "nan";
};

/** Stable public-trade identity used as a multiset key across takerOnly=false/true queries. */
export function tradeFingerprint(row) {
  return [
    String(row?.transactionHash || "").toLowerCase(),
    String(row?.asset || ""),
    String(row?.side || "").toUpperCase(),
    String(row?.outcome || ""),
    Number(row?.timestamp) || 0,
    nkey(row?.price),
    nkey(row?.size),
  ].join(":");
}

/**
 * Label maker-inclusive public trades by subtracting the taker-only multiset.
 * Duplicate-looking partial fills are retained and consumed one-for-one.
 */
export function labelTradeRoles(allRows, takerRows) {
  const takerCounts = new Map();
  for (const row of takerRows || []) {
    const key = tradeFingerprint(row);
    takerCounts.set(key, (takerCounts.get(key) || 0) + 1);
  }
  return (allRows || []).map((row) => {
    const key = tradeFingerprint(row);
    const count = takerCounts.get(key) || 0;
    if (count > 0) takerCounts.set(key, count - 1);
    return { ...row, role: count > 0 ? "taker" : "maker" };
  });
}

export function normalizeTrade(row) {
  const size = Number(row?.size);
  const price = Number(row?.price);
  return {
    slug: String(row?.slug || ""),
    conditionId: String(row?.conditionId || "").toLowerCase(),
    asset: String(row?.asset || ""),
    outcome: /^up$/i.test(row?.outcome || "") ? "Up" : "Down",
    action: String(row?.side || "BUY").toUpperCase(),
    role: row?.role === "maker" ? "maker" : "taker",
    size: Number.isFinite(size) ? size : 0,
    price: Number.isFinite(price) ? price : 0,
    timestamp: Number(row?.timestamp) || 0,
    transactionHash: String(row?.transactionHash || "").toLowerCase(),
  };
}

/** Aggregate partial rows from one CLOB match/settlement transaction into an observed fill burst. */
export function aggregateFillBursts(rows) {
  const groups = new Map();
  for (const raw of rows || []) {
    const row = normalizeTrade(raw);
    if (row.action !== "BUY" || !(row.size > 0) || !(row.price > 0)) continue;
    const key = [row.slug, row.transactionHash, row.asset, row.outcome, row.role].join(":");
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        slug: row.slug,
        conditionId: row.conditionId,
        transactionHash: row.transactionHash,
        asset: row.asset,
        outcome: row.outcome,
        role: row.role,
        timestamp: row.timestamp,
        components: 0,
        shares: 0,
        usd: 0,
        minPrice: Infinity,
        maxPrice: -Infinity,
        modeledFee: 0,
      };
      groups.set(key, group);
    }
    group.timestamp = Math.min(group.timestamp, row.timestamp);
    group.components++;
    group.shares += row.size;
    group.usd += row.size * row.price;
    group.minPrice = Math.min(group.minPrice, row.price);
    group.maxPrice = Math.max(group.maxPrice, row.price);
    if (row.role === "taker") group.modeledFee += 0.07 * row.price * (1 - row.price) * row.size;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    vwap: group.shares > 0 ? group.usd / group.shares : null,
  })).sort((a, b) => a.timestamp - b.timestamp || a.outcome.localeCompare(b.outcome));
}

export function quantile(values, probability) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const p = Math.max(0, Math.min(1, Number(probability) || 0));
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

export function normalizeBook(raw) {
  const asks = (raw?.asks || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  const bids = (raw?.bids || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => b.price - a.price);
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

export function walkAsks(book, requestedShares, limitPrice = 0.99) {
  let remaining = Math.max(0, Number(requestedShares) || 0);
  let shares = 0, usd = 0, maxPrice = null;
  for (const level of book?.asks || []) {
    if (level.price > limitPrice + EPS || remaining <= EPS) break;
    const take = Math.min(remaining, level.size);
    shares += take;
    usd += take * level.price;
    remaining -= take;
    maxPrice = level.price;
  }
  return { shares, usd, vwap: shares > EPS ? usd / shares : null, maxPrice, complete: remaining <= EPS };
}

function askDepthThrough(book, limitPrice) {
  return (book?.asks || []).reduce((total, level) => level.price <= limitPrice + EPS ? total + level.size : total, 0);
}

export function valueAtOrBefore(ticks, ms, field) {
  let value = null;
  for (const tick of ticks || []) {
    if (tick.ms > ms) break;
    const candidate = Number(tick[field]);
    if (Number.isFinite(candidate) && candidate > 0) value = candidate;
  }
  return value;
}

export function pctMove(current, prior) {
  return Number.isFinite(current) && Number.isFinite(prior) && prior !== 0
    ? (current - prior) / Math.abs(prior) * 100
    : null;
}

/** Spot/orderbook feature vector evaluated at the inferred decision tick. */
export function featuresAt(ticks, index, openBinance, openChainlink, startMs) {
  const tick = ticks[index];
  if (!tick) return null;
  const lookback = (field, seconds) => valueAtOrBefore(ticks, tick.ms - seconds * 1000, field);
  const out = {
    ms: tick.ms,
    tInto: (tick.ms - startMs) / 1000,
    bz: tick.bz,
    cl: tick.cl,
    bzGap: Number.isFinite(tick.bz) && Number.isFinite(openBinance) ? tick.bz - openBinance : null,
    bzGapPct: pctMove(tick.bz, openBinance),
    clGap: Number.isFinite(tick.cl) && Number.isFinite(openChainlink) ? tick.cl - openChainlink : null,
    clGapPct: pctMove(tick.cl, openChainlink),
    spread: Number.isFinite(tick.bz) && Number.isFinite(tick.cl) ? tick.bz - tick.cl : null,
  };
  for (const seconds of [1, 3, 5, 10, 15, 30, 60]) {
    out[`bzMom${seconds}`] = pctMove(tick.bz, lookback("bz", seconds));
    out[`clMom${seconds}`] = pctMove(tick.cl, lookback("cl", seconds));
    const priorUpAsk = lookback("upAsk", seconds);
    const priorDownAsk = lookback("dnAsk", seconds);
    out[`clobMom${seconds}`] = Number.isFinite(tick.upAsk) && Number.isFinite(priorUpAsk)
      ? tick.upAsk - priorUpAsk
      : Number.isFinite(tick.downAsk) && Number.isFinite(priorDownAsk) ? priorDownAsk - tick.downAsk : null;
  }
  return out;
}

/**
 * Infer a marketable order's off-chain fire tick by matching its observed
 * shares/VWAP/max-fill-price to the pre-consumption L2 ask book. The public
 * trade timestamp is only a search anchor, never returned as the decision.
 */
export function inferTakerFire(ticks, burst, { beforeMs = 12_000, afterMs = 2_000 } = {}) {
  const anchorMs = Number(burst.timestamp) * 1000;
  let best = null;
  for (let index = 0; index < (ticks || []).length; index++) {
    const tick = ticks[index];
    if (tick.ms < anchorMs - beforeMs || tick.ms > anchorMs + afterMs) continue;
    const book = burst.outcome === "Up" ? tick.up : tick.down;
    const walked = walkAsks(book, burst.shares, Math.max(0.01, burst.maxPrice));
    const shareMiss = Math.abs(walked.shares - burst.shares) / Math.max(1, burst.shares);
    const vwapMiss = walked.vwap == null ? 1 : Math.abs(walked.vwap - burst.vwap);
    const maxMiss = walked.maxPrice == null ? 1 : Math.abs(walked.maxPrice - burst.maxPrice);
    // A marketable order should be followed by removal of roughly its filled
    // quantity from asks through the observed cap. Restrict this check to the
    // next 1.2s so an older, coincidentally identical book cannot win merely
    // because the public/on-chain match timestamp lags the off-chain fire.
    const beforeDepth = askDepthThrough(book, burst.maxPrice);
    let bestRemoval = 0;
    for (let next = index + 1; next < ticks.length && ticks[next].ms <= tick.ms + 1_200; next++) {
      const nextBook = burst.outcome === "Up" ? ticks[next].up : ticks[next].down;
      bestRemoval = Math.max(bestRemoval, beforeDepth - askDepthThrough(nextBook, burst.maxPrice));
    }
    const consumptionMiss = Math.abs(Math.max(0, bestRemoval) - burst.shares) / Math.max(1, burst.shares);
    const timePenalty = Math.abs(tick.ms - anchorMs) / Math.max(1, beforeMs + afterMs) * 0.002;
    const bookScore = shareMiss * 2 + vwapMiss * 8 + maxMiss * 3;
    const score = bookScore + consumptionMiss * 0.75 + timePenalty;
    if (!best || score < best.score) best = { index, ms: tick.ms, score, bookScore, consumptionMiss, removedShares: bestRemoval, walked };
  }
  if (!best) return null;
  const confidence = best.bookScore <= 0.015 && best.consumptionMiss <= 0.25
    ? "high"
    : best.bookScore <= 0.06 && best.consumptionMiss <= 0.8 ? "medium" : "low";
  return { ...best, confidence, leadMs: anchorMs - best.ms };
}

/** Infer passive placement from the latest material positive bid-depth jump before the first maker fill. */
export function inferMakerPlacement(ticks, burst, { lookbackMs = 180_000 } = {}) {
  const anchorMs = Number(burst.timestamp) * 1000;
  const price = Number(burst.vwap);
  let previousSize = null, best = null;
  for (let index = 0; index < (ticks || []).length; index++) {
    const tick = ticks[index];
    if (tick.ms < anchorMs - lookbackMs || tick.ms > anchorMs) continue;
    const book = burst.outcome === "Up" ? tick.up : tick.down;
    const size = (book?.bids || []).find((level) => Math.abs(level.price - price) < 0.004)?.size || 0;
    if (previousSize != null) {
      const delta = size - previousSize;
      const material = delta >= Math.min(Math.max(5, burst.shares * 0.35), burst.shares);
      if (material) best = { index, ms: tick.ms, depthBefore: previousSize, depthAfter: size, depthAdded: delta };
    }
    previousSize = size;
  }
  if (!best) return null;
  return { ...best, leadMs: anchorMs - best.ms, confidence: best.depthAdded >= burst.shares * 0.8 ? "high" : "medium" };
}

/** Simple inventory-based cycle reconstruction; side flips are hedge candidates, not blindly called entries. */
export function reconstructWindowCycles(bursts) {
  let up = 0, down = 0, cycle = 0;
  return (bursts || []).map((burst, index) => {
    const before = { up, down };
    const wasFlat = Math.min(up, down) <= EPS && Math.max(up, down) <= EPS;
    const priorLean = up > down + EPS ? "Up" : down > up + EPS ? "Down" : null;
    const hedgeCandidate = priorLean && priorLean !== burst.outcome;
    if (wasFlat || (!priorLean && index > 0)) cycle++;
    if (burst.outcome === "Up") up += burst.shares; else down += burst.shares;
    const pairedBefore = Math.min(before.up, before.down), pairedAfter = Math.min(up, down);
    return {
      ...burst,
      cycle: Math.max(1, cycle),
      inferredLeg: hedgeCandidate && pairedAfter > pairedBefore + EPS ? "hedge" : "entry/topup",
      before,
      after: { up, down },
      pairedAdded: Math.max(0, pairedAfter - pairedBefore),
      overbuyShares: hedgeCandidate ? Math.max(0, burst.shares - Math.abs(before.up - before.down)) : 0,
    };
  });
}
