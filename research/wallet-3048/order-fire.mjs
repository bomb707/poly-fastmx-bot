import { walkAsks } from "./core.mjs";

const EPS = 0.00011;
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

function levelSize(levels, price) {
  return (levels || []).reduce((sum, level) => Math.abs(Number(level.price) - price) <= EPS ? sum + Number(level.size || 0) : sum, 0);
}

export function inferCancelBeforeReplacement(rawTicks, order, replacement, remainingShares, {
  maxLifeMs = 30_000,
  replacementSlackMs = 750,
} = {}) {
  if (!rawTicks?.length || !order?.settlements?.length || !replacement || !(remainingShares > 0)) return null;
  const outcome = order.outcome || order.settlements[0].outcome;
  const price = Number(order.limitPrice);
  const startMs = Number(order.fireMs) + 1;
  const endMs = Math.min(Number(order.fireMs) + maxLifeMs, Number(replacement.fireMs) + replacementSlackMs);
  let best = null;
  for (let index = 0; index + 1 < rawTicks.length; index++) {
    const before = synthesizeBinaryBooks(rawTicks[index]), after = synthesizeBinaryBooks(rawTicks[index + 1]);
    if (after.ms < startMs || after.ms > endMs || after.ms - before.ms > 3_500) continue;
    const beforeBook = outcome === "Up" ? before.up : before.down;
    const afterBook = outcome === "Up" ? after.up : after.down;
    const depthRemoved = Math.max(0, levelSize(beforeBook.bids, price) - levelSize(afterBook.bids, price));
    if (depthRemoved <= 0) continue;
    const amountMiss = Math.abs(depthRemoved - remainingShares) / Math.max(1, remainingShares);
    const replacementLagMs = Number(replacement.fireMs) - after.ms;
    const timePenalty = replacementLagMs >= -replacementSlackMs && replacementLagMs <= 5_000
      ? Math.abs(replacementLagMs) / 5_000 * .08
      : .08 + Math.min(.5, Math.abs(replacementLagMs) / Math.max(1, maxLifeMs) * .2);
    const score = amountMiss + timePenalty;
    const candidate = {
      index,
      cancelMs: after.ms,
      intervalStartMs: before.ms,
      intervalEndMs: after.ms,
      intervalWidthMs: after.ms - before.ms,
      depthBefore: levelSize(beforeBook.bids, price),
      depthAfter: levelSize(afterBook.bids, price),
      depthRemoved,
      remainingShares,
      amountMiss,
      replacementLagMs,
      lifeMs: after.ms - Number(order.fireMs),
      score,
    };
    if (!best || candidate.score < best.score) best = candidate;
  }
  if (!best) return null;
  const confidence = best.amountMiss <= .15 && best.replacementLagMs >= -replacementSlackMs && best.replacementLagMs <= 5_000
    ? "high"
    : best.amountMiss <= .4 && best.replacementLagMs >= -replacementSlackMs && best.replacementLagMs <= 10_000 ? "medium" : "low";
  return { ...best, confidence };
}

function depthThrough(levels, price) {
  return (levels || []).reduce((sum, level) => Number(level.price) <= price + EPS ? sum + Number(level.size || 0) : sum, 0);
}

/** Add the economically equivalent bids derived from the opposite outcome's asks. */
export function synthesizeBinaryBooks(tick) {
  const upAsks = tick?.up?.asks || [], downAsks = tick?.down?.asks || [];
  return {
    ...tick,
    up: {
      ...(tick.up || {}),
      asks: upAsks,
      bids: tick?.up?.bids?.length ? tick.up.bids : downAsks.map((level) => ({ price: 1 - Number(level.price), size: Number(level.size) })).sort((a, b) => b.price - a.price),
    },
    down: {
      ...(tick.down || {}),
      asks: downAsks,
      bids: tick?.down?.bids?.length ? tick.down.bids : upAsks.map((level) => ({ price: 1 - Number(level.price), size: Number(level.size) })).sort((a, b) => b.price - a.price),
    },
  };
}

function publicExecution(group) {
  const taker = (group.settlements || []).filter((settlement) => settlement.role === "taker");
  const maker = (group.settlements || []).filter((settlement) => settlement.role === "maker");
  const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const takerShares = sum(taker, "shares"), takerUsd = sum(taker, "usd"), makerShares = sum(maker, "shares");
  return {
    takerShares,
    takerUsd,
    takerVwap: takerShares > 0 ? takerUsd / takerShares : null,
    makerShares,
    // A later maker fill proves that some portion rested. For taker-only
    // partial orders, zero remainder would falsely assume GTC rather than FAK.
    expectedRest: makerShares > 0 ? Math.max(0, Number(group.signedShares) - takerShares) : null,
  };
}

/**
 * Infer one signed BUY order's submission interval from consecutive v4 L2 states.
 * Public timestamps are search anchors only. The returned fire interval is the
 * snapshot interval in which asks disappeared and/or signed-size bid depth appeared.
 */
export function inferGroupedOrderFire(rawTicks, group, {
  beforeMs = 12_000,
  afterMs = 1_500,
  maxSnapshotGapMs = 3_500,
  constructionSlackMs = 250,
} = {}) {
  if (!rawTicks?.length || !group?.settlements?.length || !group.isBuy) return null;
  const ticks = rawTicks.map(synthesizeBinaryBooks);
  const outcome = group.settlements[0].outcome;
  const price = Number(group.limitPrice), signedShares = Number(group.signedShares);
  const anchorMs = Number(group.firstPublicTs) * 1000;
  // clob-client-v2 puts Date.now() into the signed EIP-712 order. It is not
  // submit/fire time, but an order cannot exist before construction. Use it
  // only as a causal lower bound (with clock slack); v4 depth still selects the
  // actual fire interval.
  const constructedMs = finite(group.signedTimestampMs) ? Number(group.signedTimestampMs) : null;
  if (!finite(price) || !finite(signedShares) || !finite(anchorMs)) return null;
  const execution = publicExecution(group);
  let best = null;

  for (let index = 0; index + 1 < ticks.length; index++) {
    const before = ticks[index], after = ticks[index + 1];
    if (after.ms < anchorMs - beforeMs || before.ms > anchorMs + afterMs) continue;
    if (constructedMs != null && after.ms < constructedMs - constructionSlackMs) continue;
    const widthMs = after.ms - before.ms;
    if (!(widthMs >= 0) || widthMs > maxSnapshotGapMs) continue;
    const beforeBook = outcome === "Up" ? before.up : before.down;
    const afterBook = outcome === "Up" ? after.up : after.down;
    const askRemoved = Math.max(0, depthThrough(beforeBook.asks, price) - depthThrough(afterBook.asks, price));
    const bidAdded = Math.max(0, levelSize(afterBook.bids, price) - levelSize(beforeBook.bids, price));

    let bookScore = 0, walked = null, removalUnder = null, removalExcess = null;
    if (execution.takerShares > 0) {
      walked = walkAsks(beforeBook, execution.takerShares, price);
      const shareMiss = Math.abs(walked.shares - execution.takerShares) / Math.max(1, execution.takerShares);
      const vwapMiss = walked.vwap == null ? 1 : Math.abs(walked.vwap - execution.takerVwap);
      const maxMiss = walked.maxPrice == null ? 1 : Math.max(0, walked.maxPrice - price);
      bookScore = shareMiss * 2 + vwapMiss * 8 + maxMiss * 3;
      removalUnder = Math.max(0, execution.takerShares - askRemoved) / Math.max(1, execution.takerShares);
      removalExcess = Math.max(0, askRemoved - execution.takerShares) / Math.max(1, execution.takerShares);
    }

    let restMiss = null;
    if (execution.expectedRest != null) {
      // Immediate matching can consume part of the remainder before the next
      // snapshot; compare both the theoretical remainder and the maker-filled
      // residual that was eventually observable.
      const targets = [execution.expectedRest, execution.makerShares].filter((value) => value > 0);
      restMiss = targets.length
        ? Math.min(...targets.map((target) => Math.abs(bidAdded - target) / Math.max(1, target)))
        : (bidAdded > 1 ? 1 : 0);
    } else if (execution.takerShares <= 0) {
      restMiss = Math.abs(bidAdded - signedShares) / Math.max(1, signedShares);
    }

    const hasTaker = execution.takerShares > 0;
    const hasPassive = execution.expectedRest != null || !hasTaker;
    const eventMagnitude = askRemoved + bidAdded;
    if (eventMagnitude <= 0) continue;
    const timePenalty = Math.abs(anchorMs - after.ms) / Math.max(1, beforeMs + afterMs) * 0.002;
    const score = bookScore
      + (hasTaker ? (removalUnder + Math.min(5, removalExcess) * 0.08) : 0)
      + (hasPassive ? (restMiss ?? 1) * 0.7 : 0)
      + timePenalty;
    const candidate = {
      index,
      intervalStartMs: before.ms,
      intervalEndMs: after.ms,
      fireMs: after.ms,
      intervalWidthMs: widthMs,
      leadMs: anchorMs - after.ms,
      score,
      bookScore,
      removalUnder,
      removalExcess,
      restMiss,
      askRemoved,
      bidAdded,
      beforeBestAsk: beforeBook.asks?.[0]?.price ?? null,
      beforeBestBid: beforeBook.bids?.[0]?.price ?? null,
      walked,
    };
    if (!best || candidate.score < best.score) best = candidate;
  }
  if (!best) return null;
  const takerGood = execution.takerShares <= 0 || (best.bookScore <= 0.025 && (best.removalUnder ?? 0) <= 0.35);
  const passiveGood = execution.expectedRest == null && execution.takerShares > 0 || (best.restMiss ?? 0) <= 0.3;
  const takerOkay = execution.takerShares <= 0 || (best.bookScore <= 0.08 && (best.removalUnder ?? 0) <= 0.8);
  const passiveOkay = execution.expectedRest == null && execution.takerShares > 0 || (best.restMiss ?? 0) <= 0.75;
  const confidence = takerGood && passiveGood ? "high" : takerOkay && passiveOkay ? "medium" : "low";
  const method = execution.takerShares > 0 && execution.expectedRest != null
    ? "take+rest"
    : execution.takerShares > 0 ? "take" : "rest";
  return { ...best, confidence, method, ...execution };
}

/** Top-of-book features at or immediately before an independently inferred fire time. */
export function featuresAtFire(ticks, fireMs, group, openBinance, openChainlink) {
  const indexAtOrBefore = (ms) => {
    let low = 0, high = (ticks || []).length - 1, answer = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return answer;
  };
  const index = indexAtOrBefore(fireMs);
  if (index < 0) return null;
  const tick = ticks[index], outcome = group.settlements[0].outcome;
  const valueBefore = (field, ms) => {
    let cursor = indexAtOrBefore(ms);
    while (cursor >= 0) {
      const value = ticks[cursor][field];
      if (finite(value)) return Number(value);
      cursor--;
    }
    return null;
  };
  const pct = (now, prior) => finite(now) && finite(prior) && prior !== 0 ? (Number(now) - Number(prior)) / Math.abs(Number(prior)) * 100 : null;
  const feature = {
    ms: tick.ms,
    tInto: (fireMs - Number(group.settlements[0].slug.split("-").at(-1)) * 1000) / 1000,
    outcome,
    sideSign: outcome === "Up" ? 1 : -1,
    bz: finite(tick.bz) ? Number(tick.bz) : null,
    cl: finite(tick.cl) ? Number(tick.cl) : null,
    bzGapPct: pct(tick.bz, openBinance),
    clGapPct: pct(tick.cl, openChainlink),
    upAsk: finite(tick.upAsk) ? Number(tick.upAsk) : tick.up?.asks?.[0]?.price ?? null,
    downAsk: finite(tick.downAsk) ? Number(tick.downAsk) : finite(tick.dnAsk) ? Number(tick.dnAsk) : tick.down?.asks?.[0]?.price ?? null,
  };
  for (const seconds of [1, 3, 5, 10, 15, 30, 60]) {
    feature[`bzMom${seconds}`] = pct(tick.bz, valueBefore("bz", fireMs - seconds * 1000));
    feature[`clMom${seconds}`] = pct(tick.cl, valueBefore("cl", fireMs - seconds * 1000));
  }
  feature.sideAsk = outcome === "Up" ? feature.upAsk : feature.downAsk;
  feature.pairAsk = finite(feature.upAsk) && finite(feature.downAsk) ? feature.upAsk + feature.downAsk : null;
  feature.limitVsAsk = finite(feature.sideAsk) ? Number(group.limitPrice) - feature.sideAsk : null;
  feature.bzClSpreadPct = finite(tick.bz) && finite(tick.cl) && Number(tick.cl) !== 0
    ? (Number(tick.bz) - Number(tick.cl)) / Math.abs(Number(tick.cl)) * 100 : null;
  feature.clobUpProxy = finite(feature.upAsk) && finite(feature.downAsk)
    ? (feature.upAsk + (1 - feature.downAsk)) / 2 : null;
  for (const seconds of [1, 3, 5, 10, 15, 30, 60]) {
    const priorUp = valueBefore("upAsk", fireMs - seconds * 1000);
    const priorDown = valueBefore("dnAsk", fireMs - seconds * 1000);
    feature[`upAskMove${seconds}`] = finite(feature.upAsk) && finite(priorUp) ? feature.upAsk - priorUp : null;
    feature[`downAskMove${seconds}`] = finite(feature.downAsk) && finite(priorDown) ? feature.downAsk - priorDown : null;
    feature[`sideAskMove${seconds}`] = outcome === "Up" ? feature[`upAskMove${seconds}`] : feature[`downAskMove${seconds}`];
    const priorProxy = finite(priorUp) && finite(priorDown) ? (priorUp + (1 - priorDown)) / 2 : null;
    feature[`clobUpMove${seconds}`] = finite(feature.clobUpProxy) && finite(priorProxy) ? feature.clobUpProxy - priorProxy : null;
  }
  return feature;
}
