#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const source = JSON.parse(fs.readFileSync(path.join(dataDir, "trades-2026-08-14_2026-08-22.json"), "utf8"));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const marketBySlug = new Map(source.markets.map((row) => [row.slug, row]));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const fee = (price, shares) => .07 * price * (1 - price) * shares;
const dayOfSlug = (slug) => new Date(Number(slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10);

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

const markets = source.markets.filter((market) => market.winner && dayOfSlug(market.slug) >= "2026-08-19")
  .sort((a, b) => a.slug.localeCompare(b.slug));
console.log(`loading ${markets.length} current-regime v4 windows, including no-trade controls`);
const feeds = markets.map((market) => ({ market, feed: readFeed(market.slug) })).filter((row) => row.feed?.ticks?.length);

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

function clobUp(tick) {
  const up = ask(tick, "Up"), down = ask(tick, "Down");
  return Number.isFinite(up) && Number.isFinite(down) ? (up + 1 - down) / 2 : null;
}

function executionAt(tick, side, requested, limit) {
  const levels = (side === "Up" ? tick.up : tick.down)?.asks || [];
  let left = requested, shares = 0, usd = 0;
  for (const level of levels) {
    const price = Number(level.price), size = Number(level.size);
    if (!(price <= limit + 1e-9) || !(size > 0) || left <= 1e-9) break;
    const take = Math.min(left, size);
    left -= take; shares += take; usd += take * price;
  }
  return shares > 1e-9 ? { shares, price: usd / shares, partial: left > 1e-9 } : null;
}

function signalAt(feed, index, params) {
  const ticks = feed.ticks;
  const previous = ticks[priorIndex(ticks, index, params.lookbackMs)];
  const tick = ticks[index];
  const bzMove = Number(tick.bz) > 0 && Number(previous?.bz) > 0 ? (Number(tick.bz) - Number(previous.bz)) / Number(previous.bz) * 100 : 0;
  const nowClob = clobUp(tick), oldClob = clobUp(previous);
  const clobMove = Number.isFinite(nowClob) && Number.isFinite(oldClob) ? nowClob - oldClob : 0;
  if (params.source === "bz") return params.bzThreshold > 0 ? bzMove / params.bzThreshold : 0;
  if (params.source === "clob") return params.clobThreshold > 0 ? clobMove / params.clobThreshold : 0;
  const fast = (bzMove / params.bzThreshold + clobMove / params.clobThreshold) / 2;
  if (params.source === "combo") return fast;
  const bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0 ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 / params.gapThreshold : 0;
  const clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0 ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 / params.gapThreshold : 0;
  return fast - params.gapWeight * (bzGap + clGap) / 2;
}

function firstLotCost(lots, shares) {
  let left = shares, usd = 0, used = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    left -= take; used += take; usd += take * lot.effectivePrice;
    if (left <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? usd / used : null;
}

function pairLots(state, side, shares, effectivePrice) {
  const opposite = side === "Up" ? "Down" : "Up";
  let left = shares;
  while (left > 1e-9 && state.lots[opposite].length) {
    const lot = state.lots[opposite][0], take = Math.min(left, lot.shares);
    left -= take; lot.shares -= take; state.pairedShares += take;
    if (lot.shares <= 1e-9) state.lots[opposite].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice });
}

function simulate(feed, market, params) {
  const ticks = feed.ticks, startMs = Number(feed.slug.split("-").at(-1)) * 1000;
  const state = { up: 0, down: 0, cost: 0, fees: 0, fills: 0, entries: 0, hedges: 0, overbuys: 0, partials: 0, pairedShares: 0, lastDecisionMs: -Infinity, previousSignal: 0, lots: { Up: [], Down: [] } };
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index], t = (tick.ms - startMs) / 1000;
    const signal = signalAt(feed, index, params);
    const signalSide = signal > 0 ? "Up" : signal < 0 ? "Down" : null;
    const onset = Math.abs(signal) >= 1 && (Math.abs(state.previousSignal) < 1 || Math.sign(state.previousSignal) !== Math.sign(signal));
    state.previousSignal = signal;
    if (t < params.startS || t > params.endS || tick.ms - state.lastDecisionMs < params.cooldownMs) continue;

    const imbalance = state.up - state.down;
    const impulse = params.mode === "repeat" ? Math.abs(signal) >= 1 : onset;
    let side = null, shares = params.baseSize, reason = null;
    if (params.pairCap != null && Math.abs(imbalance) > 1e-9) {
      const hedgeSide = imbalance > 0 ? "Down" : "Up", entrySide = imbalance > 0 ? "Up" : "Down";
      const hedgeShares = Math.min(params.baseSize, Math.abs(imbalance));
      const price = ask(tick, hedgeSide), priorCost = firstLotCost(state.lots[entrySide], hedgeShares);
      if (Number.isFinite(price) && priorCost != null && priorCost + price + fee(price, 1) <= params.pairCap + 1e-9) {
        const strongReversal = signalSide === hedgeSide && impulse && Math.abs(signal) >= params.overbuyMultiple;
        side = hedgeSide;
        shares = strongReversal ? Math.min(params.overbuySize, Math.abs(imbalance) + params.baseSize) : hedgeShares;
        reason = strongReversal && shares > Math.abs(imbalance) + 1e-9 ? "pair-overbuy" : "pair-hedge";
      }
    }
    if (!side && signalSide && impulse) {
      side = signalSide;
      const orientedLean = (side === "Up" ? 1 : -1) * imbalance;
      if (orientedLean >= params.maxLean - 1e-9) continue;
      if (orientedLean < 0 && !params.allowUneconomicReversal) continue;
      if (orientedLean < 0 && Math.abs(signal) >= params.overbuyMultiple) {
        shares = Math.min(params.overbuySize, Math.abs(imbalance) + params.baseSize);
        reason = "reversal-overbuy";
      } else reason = orientedLean < 0 ? "reversal-hedge" : "momentum-entry";
    }
    if (!side || !(shares > 0)) continue;

    let executionTick = tick;
    if (params.latencyMs > 0) {
      let cursor = index;
      while (cursor + 1 < ticks.length && ticks[cursor].ms < tick.ms + params.latencyMs) cursor++;
      executionTick = ticks[cursor];
    }
    const currentAsk = ask(executionTick, side);
    if (!(currentAsk >= params.minPrice && currentAsk <= params.maxPrice)) continue;
    const limit = Math.min(params.maxPrice, currentAsk + params.limitOffset);
    const execution = executionAt(executionTick, side, shares, limit);
    if (!execution) continue;
    const chargedFee = fee(execution.price, execution.shares);
    state.cost += execution.price * execution.shares + chargedFee;
    state.fees += chargedFee;
    state.fills++;
    if (reason === "momentum-entry") state.entries++;
    else state.hedges++;
    if (reason === "reversal-overbuy" || reason === "pair-overbuy") state.overbuys++;
    if (execution.partial) state.partials++;
    if (side === "Up") state.up += execution.shares; else state.down += execution.shares;
    pairLots(state, side, execution.shares, execution.price + chargedFee / execution.shares);
    state.lastDecisionMs = tick.ms;
  }
  const payout = market.winner === "Up" ? state.up : state.down;
  return { slug: feed.slug, day: dayOfSlug(feed.slug), ...state, payout, pnl: payout - state.cost };
}

function aggregate(results) {
  const sum = (field) => results.reduce((total, row) => total + Number(row[field] || 0), 0);
  const cost = sum("cost"), pnl = sum("pnl"), fills = sum("fills");
  return {
    windows: results.length,
    activeWindows: results.filter((row) => row.fills > 0).length,
    fills, entries: sum("entries"), hedges: sum("hedges"), hedgePct: pct(sum("hedges"), fills), overbuys: sum("overbuys"), partials: sum("partials"),
    pairedShares: round(sum("pairedShares"), 2), up: round(sum("up"), 2), down: round(sum("down"), 2),
    cost: round(cost, 2), fees: round(sum("fees"), 2), payout: round(sum("payout"), 2), pnl: round(pnl, 2), roiPct: pct(pnl, cost),
  };
}

const fireBySlug = new Map();
for (const row of fires.filter((row) => row.confidence !== "low" && dayOfSlug(row.slug) >= "2026-08-19")) {
  if (!fireBySlug.has(row.slug)) fireBySlug.set(row.slug, []);
  fireBySlug.get(row.slug).push(row);
}
function targetSummary(selected) {
  const slugs = new Set(selected.map((row) => row.feed.slug));
  let orders = 0, hedges = 0;
  for (const slug of slugs) {
    const rows = (fireBySlug.get(slug) || []).sort((a, b) => a.fireMs - b.fireMs);
    let up = 0, down = 0;
    for (const row of rows) {
      const sideSign = row.outcome === "Up" ? 1 : -1, imbalance = up - down;
      if (Math.abs(imbalance) > 1e-9 && imbalance * sideSign < 0) hedges++;
      orders++;
      if (row.outcome === "Up") up += row.filledShares; else down += row.filledShares;
    }
  }
  const trades = source.trades.filter((row) => slugs.has(row.slug));
  let cost = 0, fees = 0, payout = 0;
  const inventory = new Map();
  for (const row of trades) {
    const charged = row.role === "taker" ? fee(row.price, row.size) : 0;
    cost += row.price * row.size + charged; fees += charged;
    const key = `${row.slug}:${row.outcome}`;
    inventory.set(key, (inventory.get(key) || 0) + row.size);
  }
  for (const { market } of selected) payout += inventory.get(`${market.slug}:${market.winner}`) || 0;
  return { windows: selected.length, activeWindows: [...slugs].filter((slug) => (fireBySlug.get(slug) || []).length).length, orders, hedges, hedgePct: pct(hedges, orders), cost: round(cost, 2), fees: round(fees, 2), payout: round(payout, 2), pnl: round(payout - cost, 2), roiPct: pct(payout - cost, cost) };
}

const train = feeds.filter((row) => row.market.startTime.slice(0, 10) === "2026-08-19" || row.market.startTime.slice(0, 10) === "2026-08-20");
const holdout = feeds.filter((row) => row.market.startTime.slice(0, 10) === "2026-08-21" || row.market.startTime.slice(0, 10) === "2026-08-22");
const coarseTrain = train.filter((_, index) => index % 6 === 0);
const targetTrain = targetSummary(train), targetCoarse = targetSummary(coarseTrain), targetHoldout = targetSummary(holdout);

const base = { baseSize: 30, overbuySize: 30, overbuyMultiple: 2, startS: 4, endS: 270, minPrice: .12, maxPrice: .89, maxLean: 300, latencyMs: 0, gapThreshold: .05 };
const candidates = [];
for (const sourceName of ["bz", "clob", "combo", "reversion"])
  for (const lookbackMs of [1_000, 3_000, 5_000])
    for (const thresholdIndex of [0, 1, 2, 3])
      for (const mode of ["onset", "repeat"])
        for (const cooldownMs of [500, 1_500, 3_000])
          for (const pairCap of [null, .99, 1, 1.01])
            for (const limitOffset of [0, .01])
              for (const allowUneconomicReversal of [true, false]) candidates.push({
              ...base, source: sourceName, lookbackMs, mode, cooldownMs, pairCap, limitOffset,
              allowUneconomicReversal,
              bzThreshold: [.003, .005, .01, .02][thresholdIndex],
              clobThreshold: [.01, .02, .03, .05][thresholdIndex],
              gapWeight: [.25, .5, 1, 2][thresholdIndex],
            });

function fitScore(summary, target) {
  const volume = Math.abs(Math.log(Math.max(1, summary.fills) / Math.max(1, target.orders)));
  const activity = Math.abs(summary.activeWindows / summary.windows - target.activeWindows / target.windows);
  const hedge = Math.abs((summary.hedgePct || 0) - (target.hedgePct || 0)) / 100;
  const roi = Math.abs((summary.roiPct || 0) - (target.roiPct || 0)) / 10;
  return volume + activity + hedge + roi;
}

console.log(`coarse fitting ${candidates.length} policies on ${coarseTrain.length} windows`);
const coarse = [];
for (let index = 0; index < candidates.length; index++) {
  const params = candidates[index], summary = aggregate(coarseTrain.map(({ feed, market }) => simulate(feed, market, params)));
  coarse.push({ params, summary, score: fitScore(summary, targetCoarse) });
  if ((index + 1) % 250 === 0) console.log(`coarse ${index + 1}/${candidates.length}`);
}
coarse.sort((a, b) => a.score - b.score);

const expanded = [];
const seedMap = new Map();
for (const candidate of coarse.slice(0, 32)) seedMap.set(JSON.stringify(candidate.params), candidate);
for (const candidate of [...coarse].filter((row) => row.summary.fills >= targetCoarse.orders * .2).sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 32)) {
  seedMap.set(JSON.stringify(candidate.params), candidate);
}
for (const candidate of seedMap.values()) {
  for (const maxLean of [90, 180, 300]) for (const overbuySize of [30, 90]) for (const overbuyMultiple of [1.5, 2]) {
    const params = { ...candidate.params, maxLean, overbuySize, overbuyMultiple };
    const summary = aggregate(train.map(({ feed, market }) => simulate(feed, market, params)));
    expanded.push({ params, summary, score: fitScore(summary, targetTrain) });
  }
}
expanded.sort((a, b) => a.score - b.score);
const chosen = expanded[0];
const profitable = [...expanded].filter((row) => row.summary.fills >= targetTrain.orders * .2).sort((a, b) => b.summary.pnl - a.summary.pnl)[0];

function evaluate(params, selected) { return aggregate(selected.map(({ feed, market }) => simulate(feed, market, params))); }
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: {
    train: "Aug 19-20 current regime; coarse search on every sixth train window, refit top policies on every train window",
    holdout: "Aug 21-22 untouched, including settled windows where the target placed no order",
    execution: "v4 include_orderbook=true asks, depth walked to signed-style cap, GTC/postOnly=false immediate portion; unfilled remainder conservatively canceled; exact crypto taker fee curve",
    state: "30-share momentum entry; FIFO complement hedge when fee-inclusive pair cost is below cap; optional 90-share reversal overbuy; price band 0.12-0.89",
  },
  windows: { train: train.length, holdout: holdout.length, coarseTrain: coarseTrain.length },
  target: { train: targetTrain, holdout: targetHoldout },
  behaviorFit: {
    params: chosen.params,
    score: round(chosen.score),
    train: chosen.summary,
    holdout: evaluate(chosen.params, holdout),
    holdoutLatency500ms: evaluate({ ...chosen.params, latencyMs: 500 }, holdout),
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

fs.writeFileSync(path.join(dataDir, "state-machine-backtest.json"), JSON.stringify(output, null, 2) + "\n");
const b = output.behaviorFit, p = output.profitFit;
const md = `# Current-regime state-machine backtest\n\n` +
`Train: Aug 19–20. Untouched holdout: Aug 21–22, including no-trade control windows. Every execution walks v4 order-book asks and charges the exact taker fee curve.\n\n` +
`## Behavior-fit policy\n\n` +
`Parameters: \`${JSON.stringify(b.params)}\`.\n\n` +
`- Train: ${b.train.fills} orders, $${b.train.pnl} PnL, ${b.train.roiPct}% ROI. Target: ${targetTrain.orders} orders, $${targetTrain.pnl}, ${targetTrain.roiPct}% ROI.\n` +
`- Holdout: ${b.holdout.fills} orders, $${b.holdout.pnl} PnL, ${b.holdout.roiPct}% ROI. Target: ${targetHoldout.orders} orders, $${targetHoldout.pnl}, ${targetHoldout.roiPct}% ROI.\n` +
`- Holdout with 500 ms latency: $${b.holdoutLatency500ms.pnl}, ${b.holdoutLatency500ms.roiPct}% ROI.\n\n` +
`## Profit-fit policy\n\n` +
`Parameters: \`${JSON.stringify(p.params)}\`.\n\n` +
`- Train: $${p.train.pnl}, ${p.train.roiPct}% ROI.\n` +
`- Holdout: $${p.holdout.pnl}, ${p.holdout.roiPct}% ROI.\n` +
`- Holdout with 500 ms latency: $${p.holdoutLatency500ms.pnl}, ${p.holdoutLatency500ms.roiPct}% ROI.\n`;
fs.writeFileSync(path.join(dataDir, "state-machine-backtest.md"), md);
console.log(md);
console.log(JSON.stringify({ target: output.target, behaviorFit: output.behaviorFit, profitFit: output.profitFit }, null, 2));
