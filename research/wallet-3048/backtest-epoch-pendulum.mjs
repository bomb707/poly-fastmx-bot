#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const source = JSON.parse(fs.readFileSync(path.join(dataDir, "trades-2026-08-14_2026-08-22.json"), "utf8"));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const fee = (price, shares) => .07 * price * (1 - price) * shares;
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const epochStart = Date.parse("2026-08-21T19:55:00Z");
const epochEnd = Date.parse("2026-08-22T17:00:00Z");

function readFeed(slug) {
  const file = path.join(dataDir, "feeds/v4-top", `${slug}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const v2File = path.join(dataDir, "feeds/v2", `${slug}.json.gz`);
  if (fs.existsSync(v2File)) {
    const rtds = JSON.parse(zlib.gunzipSync(fs.readFileSync(v2File)));
    let cursor = -1, current = null;
    for (const tick of feed.ticks) {
      while (cursor + 1 < rtds.ticks.length && rtds.ticks[cursor + 1].ms <= tick.ms) {
        cursor++;
        if (Number(rtds.ticks[cursor].cl) > 0) current = Number(rtds.ticks[cursor].cl);
      }
      tick.cl = current;
    }
    feed.openChainlink = Number(rtds.openChainlink);
  }
  return feed;
}

const marketRows = source.markets.filter((market) => {
  const start = slugStart(market.slug);
  return market.winner && start >= epochStart && start < epochEnd;
}).sort((a, b) => slugStart(a.slug) - slugStart(b.slug));
console.log(`loading ${marketRows.length} E8 markets, including no-trade controls`);
const feeds = marketRows.map((market) => ({ market, feed: readFeed(market.slug) })).filter((row) => row.feed?.ticks?.length);
const split = Math.floor(feeds.length / 2);
const train = feeds.slice(0, split), holdout = feeds.slice(split);

function priorIndex(ticks, index, lookbackMs) {
  const target = ticks[index].ms - lookbackMs;
  let low = 0, high = index, answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= target) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

function ask(tick, side) {
  const book = side === "Up" ? tick.up : tick.down;
  return Number(book?.asks?.[0]?.price ?? (side === "Up" ? tick.upAsk : tick.dnAsk));
}

function execute(tick, side, requested, limit) {
  const levels = (side === "Up" ? tick.up : tick.down)?.asks || [];
  let left = requested, shares = 0, usd = 0;
  for (const level of levels) {
    const price = Number(level.price), size = Number(level.size);
    if (!(price <= limit + 1e-9) || !(size > 0) || left <= 1e-9) break;
    const take = Math.min(left, size);
    left -= take;
    shares += take;
    usd += take * price;
  }
  return shares > 1e-9 ? { shares, price: usd / shares, partial: left > 1e-9 } : null;
}

function firstLotCost(lots, shares) {
  let left = shares, used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take;
    used += take;
    cost += take * lot.effectivePrice;
    if (left <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? cost / used : null;
}

function addLots(state, side, shares, effectivePrice) {
  const opposite = side === "Up" ? "Down" : "Up";
  let left = shares;
  while (left > 1e-9 && state.lots[opposite].length) {
    const lot = state.lots[opposite][0], take = Math.min(left, lot.shares);
    left -= take;
    lot.shares -= take;
    state.pairedShares += take;
    state.pairedPnl += take * (1 - effectivePrice - lot.effectivePrice);
    if (lot.shares <= 1e-9) state.lots[opposite].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice });
}

function rawScores(feed, index, params) {
  const tick = feed.ticks[index];
  const previous = feed.ticks[priorIndex(feed.ticks, index, params.lookbackMs)];
  const bzMove = Number(tick.bz) > 0 && Number(previous.bz) > 0 ? (Number(tick.bz) - Number(previous.bz)) / Number(previous.bz) * 100 : 0;
  const clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0 ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 : 0;
  const scores = {};
  for (const side of ["Up", "Down"]) {
    const sideSign = side === "Up" ? 1 : -1;
    const now = ask(tick, side), old = ask(previous, side);
    const dip = Number.isFinite(now) && Number.isFinite(old) ? Math.max(-2, Math.min(6, (old - now) / params.clobThreshold)) : 0;
    const bzDip = Math.max(-2, Math.min(6, -bzMove * sideSign / params.bzThreshold));
    const gapContrarian = Math.max(-2, Math.min(6, -clGap * sideSign / params.gapThreshold));
    scores[side] = dip + params.bzWeight * bzDip + params.gapWeight * gapContrarian;
  }
  return scores;
}

function simulate(feed, market, params) {
  const state = {
    up: 0, down: 0, cost: 0, fees: 0, fills: 0, entries: 0, hedges: 0, crosses: 0,
    size90: 0, partials: 0, pairedShares: 0, pairedPnl: 0,
    lots: { Up: [], Down: [] }, previousScore: { Up: 0, Down: 0 }, lastSideMs: { Up: -Infinity, Down: -Infinity },
  };
  const startMs = slugStart(feed.slug);
  for (let index = 0; index < feed.ticks.length; index++) {
    const tick = feed.ticks[index], t = (tick.ms - startMs) / 1000;
    const scores = rawScores(feed, index, params);
    const ranked = ["Up", "Down"].sort((a, b) => scores[b] - scores[a]);
    const imbalance = state.up - state.down;
    const hedgeSide = imbalance > 1e-9 ? "Down" : imbalance < -1e-9 ? "Up" : null;
    let side = ranked[0], requiredScore = 1, pairPriority = false;
    if (hedgeSide && params.pairCap != null) {
      const opposite = hedgeSide === "Up" ? "Down" : "Up";
      const sample = Math.min(30, Math.abs(imbalance));
      const lotCost = firstLotCost(state.lots[opposite], sample);
      const hedgeAsk = ask(tick, hedgeSide);
      const cheap = lotCost != null && Number.isFinite(hedgeAsk) && lotCost + hedgeAsk + fee(hedgeAsk, 1) <= params.pairCap + 1e-9;
      const discountedScore = Math.max(0, 1 - params.pairDiscount);
      if (cheap && scores[hedgeSide] >= discountedScore) {
        side = hedgeSide;
        requiredScore = discountedScore;
        pairPriority = true;
      }
    }
    const score = scores[side];
    const onset = score >= requiredScore && (state.previousScore[side] < requiredScore || scores[side] - state.previousScore[side] >= params.rearmDelta);
    state.previousScore = scores;
    if (t < params.startS || t > params.endS || score < requiredScore) continue;
    if (params.mode === "onset" && !onset) continue;
    if (tick.ms - state.lastSideMs[side] < params.cooldownMs) continue;

    const sideSign = side === "Up" ? 1 : -1;
    const orientedLean = imbalance * sideSign;
    const isHedge = orientedLean < -1e-9;
    if (!isHedge && orientedLean >= params.maxLean - 1e-9) continue;
    const currentAsk = ask(tick, side);
    if (!(currentAsk >= params.minPrice && currentAsk <= params.maxPrice)) continue;

    const requested = (pairPriority && Math.abs(imbalance) >= params.catchupThreshold) || (!pairPriority && score >= params.overThreshold) ? 90 : 30;
    const limit = Math.min(params.maxPrice, currentAsk + params.limitOffset);
    let executionTick = tick;
    if (params.latencyMs > 0) {
      let cursor = index;
      while (cursor + 1 < feed.ticks.length && feed.ticks[cursor].ms < tick.ms + params.latencyMs) cursor++;
      executionTick = feed.ticks[cursor];
    }
    const fill = execute(executionTick, side, requested, limit);
    if (!fill) continue;
    const chargedFee = fee(fill.price, fill.shares);
    const before = state.up - state.down;
    state.cost += fill.price * fill.shares + chargedFee;
    state.fees += chargedFee;
    state.fills++;
    if (isHedge) state.hedges++; else state.entries++;
    if (requested === 90) state.size90++;
    if (fill.partial) state.partials++;
    if (side === "Up") state.up += fill.shares; else state.down += fill.shares;
    const after = state.up - state.down;
    if (Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) state.crosses++;
    addLots(state, side, fill.shares, fill.price + chargedFee / fill.shares);
    state.lastSideMs[side] = tick.ms;
  }
  const payout = market.winner === "Up" ? state.up : state.down;
  return { slug: feed.slug, ...state, payout, pnl: payout - state.cost };
}

function aggregate(results) {
  const sum = (field) => results.reduce((total, row) => total + Number(row[field] || 0), 0);
  const fills = sum("fills"), cost = sum("cost"), pnl = sum("pnl");
  return {
    windows: results.length,
    activeWindows: results.filter((row) => row.fills > 0).length,
    fills,
    entries: sum("entries"),
    hedges: sum("hedges"),
    hedgePct: pct(sum("hedges"), fills),
    crossings: sum("crosses"),
    crossingsPerActiveWindow: round(sum("crosses") / Math.max(1, results.filter((row) => row.fills > 0).length), 3),
    size90: sum("size90"),
    size90Pct: pct(sum("size90"), fills),
    partials: sum("partials"),
    pairedShares: round(sum("pairedShares"), 2),
    pairedPnl: round(sum("pairedPnl"), 2),
    cost: round(cost, 2),
    fees: round(sum("fees"), 2),
    payout: round(sum("payout"), 2),
    pnl: round(pnl, 2),
    roiPct: pct(pnl, cost),
  };
}

const fireBySlug = new Map();
for (const fire of fires.filter((row) => row.confidence !== "low")) {
  if (!fireBySlug.has(fire.slug)) fireBySlug.set(fire.slug, []);
  fireBySlug.get(fire.slug).push(fire);
}

function targetSummary(selected) {
  const slugs = new Set(selected.map((row) => row.feed.slug));
  let orders = 0, hedges = 0, crosses = 0, size90 = 0;
  for (const slug of slugs) {
    let up = 0, down = 0;
    for (const row of [...(fireBySlug.get(slug) || [])].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash))) {
      const before = up - down, sign = row.outcome === "Up" ? 1 : -1;
      if (before * sign < -1e-9) hedges++;
      if (Number(row.signedShares) === 90) size90++;
      orders++;
      if (row.outcome === "Up") up += Number(row.filledShares); else down += Number(row.filledShares);
      const after = up - down;
      if (Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) crosses++;
    }
  }
  let cost = 0, fees = 0, payout = 0;
  const inventory = new Map();
  for (const row of source.trades.filter((trade) => slugs.has(trade.slug))) {
    const chargedFee = row.role === "taker" ? fee(Number(row.price), Number(row.size)) : 0;
    cost += Number(row.price) * Number(row.size) + chargedFee;
    fees += chargedFee;
    const key = `${row.slug}:${row.outcome}`;
    inventory.set(key, (inventory.get(key) || 0) + Number(row.size));
  }
  for (const { market } of selected) payout += inventory.get(`${market.slug}:${market.winner}`) || 0;
  const activeWindows = [...slugs].filter((slug) => (fireBySlug.get(slug) || []).length).length;
  return {
    windows: selected.length,
    activeWindows,
    fills: orders,
    hedges,
    hedgePct: pct(hedges, orders),
    crossings: crosses,
    crossingsPerActiveWindow: round(crosses / Math.max(1, activeWindows), 3),
    size90,
    size90Pct: pct(size90, orders),
    cost: round(cost, 2),
    fees: round(fees, 2),
    payout: round(payout, 2),
    pnl: round(payout - cost, 2),
    roiPct: pct(payout - cost, cost),
  };
}

function evaluate(params, selected) {
  return aggregate(selected.map(({ feed, market }) => simulate(feed, market, params)));
}

function behaviorScore(summary, target) {
  const volume = Math.abs(Math.log(Math.max(1, summary.fills) / Math.max(1, target.fills)));
  const activity = Math.abs(summary.activeWindows / summary.windows - target.activeWindows / target.windows);
  const hedge = Math.abs((summary.hedgePct || 0) - (target.hedgePct || 0)) / 100;
  const crossing = Math.abs((summary.crossingsPerActiveWindow || 0) - (target.crossingsPerActiveWindow || 0)) / 5;
  const size = Math.abs((summary.size90Pct || 0) - (target.size90Pct || 0)) / 100;
  const roi = Math.abs((summary.roiPct || 0) - (target.roiPct || 0)) / 10;
  return volume + activity + hedge + crossing + size + roi;
}

const targetTrain = targetSummary(train), targetHoldout = targetSummary(holdout);
const coarseTrain = train.filter((_, index) => index % 4 === 0);
const targetCoarse = targetSummary(coarseTrain);
const base = {
  startS: 4, endS: 270, minPrice: .12, maxPrice: .89, maxLean: 300,
  overThreshold: 2, limitOffset: 0, latencyMs: 0, pairDiscount: .5,
  bzThreshold: .005, gapThreshold: .05, rearmDelta: .5, catchupThreshold: 120,
};
const weightPresets = [
  { bzWeight: 0, gapWeight: 0 },
  { bzWeight: .5, gapWeight: 0 },
  { bzWeight: 0, gapWeight: .25 },
  { bzWeight: .5, gapWeight: .25 },
];
const candidates = [];
for (const lookbackMs of [1_000, 3_000, 5_000])
  for (const clobThreshold of [.01, .02, .03])
    for (const weights of weightPresets)
      for (const cooldownMs of [500, 1_500, 3_000])
        for (const mode of ["onset", "repeat"])
          for (const pairCap of [null, 1, 1.01]) candidates.push({ ...base, ...weights, lookbackMs, clobThreshold, cooldownMs, mode, pairCap });

console.log(`coarse fitting ${candidates.length} pendulum policies on ${coarseTrain.length} windows`);
const coarse = candidates.map((params) => {
  const summary = evaluate(params, coarseTrain);
  return { params, summary, score: behaviorScore(summary, targetCoarse) };
}).sort((a, b) => a.score - b.score);

const seeds = new Map();
for (const row of coarse.slice(0, 16)) seeds.set(JSON.stringify(row.params), row.params);
for (const row of [...coarse].filter((candidate) => candidate.summary.fills >= targetCoarse.fills * .2 && candidate.summary.fills <= targetCoarse.fills * 2)
  .sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 16)) seeds.set(JSON.stringify(row.params), row.params);

const expanded = [];
for (const seed of seeds.values()) {
  for (const maxLean of [90, 180, 300])
    for (const overThreshold of [1.5, 2, 3])
      for (const pairDiscount of [.25, .5])
        for (const catchupThreshold of [90, 180]) {
          const params = { ...seed, maxLean, overThreshold, pairDiscount, catchupThreshold };
          const summary = evaluate(params, train);
          expanded.push({ params, summary, score: behaviorScore(summary, targetTrain) });
        }
}
expanded.sort((a, b) => a.score - b.score);
const behavior = expanded[0];
const profitable = [...expanded].filter((row) => row.summary.fills >= targetTrain.fills * .2 && row.summary.fills <= targetTrain.fills * 2)
  .sort((a, b) => b.summary.pnl - a.summary.pnl)[0];

const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  epoch: { id: "E8", start: new Date(epochStart).toISOString(), end: new Date(epochEnd).toISOString(), observedModes: [30, 90] },
  methodology: {
    split: `chronological 50/50 split at ${new Date(slugStart(holdout[0].feed.slug)).toISOString()}`,
    model: "buy token-side CLOB dips; optional Binance and RTDS-window-gap terms; 30 normal / 90 strong branch; FIFO inventory, pair-cost hedge discount, exact-ask v4 depth, taker fee",
    limitation: "passive GTC remainder and queue fills are not simulated; all executions are conservatively charged taker fees",
  },
  windows: { total: feeds.length, train: train.length, holdout: holdout.length, coarseTrain: coarseTrain.length },
  target: { train: targetTrain, holdout: targetHoldout },
  behaviorFit: {
    params: behavior.params,
    score: round(behavior.score),
    train: behavior.summary,
    holdout: evaluate(behavior.params, holdout),
    holdoutLatency500ms: evaluate({ ...behavior.params, latencyMs: 500 }, holdout),
  },
  profitFit: {
    params: profitable.params,
    train: profitable.summary,
    holdout: evaluate(profitable.params, holdout),
    holdoutLatency500ms: evaluate({ ...profitable.params, latencyMs: 500 }, holdout),
  },
  topBehavior: expanded.slice(0, 15),
  topProfit: [...expanded].sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 15),
};
fs.writeFileSync(path.join(dataDir, "epoch-pendulum-backtest.json"), JSON.stringify(output, null, 2) + "\n");
const b = output.behaviorFit, p = output.profitFit;
const md = `# E8 pendulum-policy v4 backtest\n\n` +
`The Aug 21 19:55–Aug 22 17:00 30/90 configuration is split chronologically in half. The later half is untouched during fitting and includes target no-trade windows.\n\n` +
`## Behavior fit\n\n` +
`Parameters: \`${JSON.stringify(b.params)}\`.\n\n` +
`- Train: ${b.train.fills} orders, ${b.train.hedgePct}% hedges, ${b.train.crossingsPerActiveWindow} crossings/active window, $${b.train.pnl} PnL (${b.train.roiPct}%).\n` +
`- Holdout: ${b.holdout.fills} orders, ${b.holdout.hedgePct}% hedges, ${b.holdout.crossingsPerActiveWindow} crossings/active window, $${b.holdout.pnl} PnL (${b.holdout.roiPct}%).\n` +
`- Target holdout: ${targetHoldout.fills} inferred orders, ${targetHoldout.hedgePct}% hedges, ${targetHoldout.crossingsPerActiveWindow} crossings/active window, $${targetHoldout.pnl} PnL (${targetHoldout.roiPct}%).\n` +
`- 500 ms latency: $${b.holdoutLatency500ms.pnl} (${b.holdoutLatency500ms.roiPct}%).\n\n` +
`## Profit fit\n\n` +
`Parameters: \`${JSON.stringify(p.params)}\`.\n\n` +
`- Train: ${p.train.fills} orders, $${p.train.pnl} (${p.train.roiPct}%).\n` +
`- Holdout: ${p.holdout.fills} orders, $${p.holdout.pnl} (${p.holdout.roiPct}%).\n` +
`- 500 ms latency: $${p.holdoutLatency500ms.pnl} (${p.holdoutLatency500ms.roiPct}%).\n`;
fs.writeFileSync(path.join(dataDir, "epoch-pendulum-backtest.md"), md);
console.log(md);
console.log(JSON.stringify({ target: output.target, behaviorFit: output.behaviorFit, profitFit: output.profitFit }, null, 2));
