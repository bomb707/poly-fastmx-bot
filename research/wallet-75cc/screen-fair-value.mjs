#!/usr/bin/env node
// Causal BTC fair-value screen. Resolution is used only after the simulated
// trade to score PnL. Decisions use the latest book/spot observation available
// at that instant; fills walk full depth at the latest snapshot before the
// configured 520 ms arrival.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const cohortFile = path.resolve(process.argv[2] || "data/wallet-75cc/cohort-2026-08-16_2026-08-26-btc.json");
const bookDir = path.resolve(process.argv[3] || "data/wallet-75cc/feeds/v2-l2");
const spotDir = path.resolve(process.argv[4] || bookDir);
const splitMs = Date.parse(process.argv[5] || "2026-08-22T00:00:00Z");
const outputFile = path.resolve(process.argv[6] || "data/wallet-75cc/fair-value-screen.json");
const fixedResultFile = process.argv[7] ? path.resolve(process.argv[7]) : null;
const latencyMs = Math.max(0, Number(process.env.W75CC_TAKER_LATENCY_MS || 520));
const baseShares = Math.max(1, Number(process.env.W75CC_FAIR_BASE_SHARES || 7));
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const logit = (probability) => { const p = clamp(probability, 1e-6, 1 - 1e-6); return Math.log(p / (1 - p)); };
const logistic = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));
function normalCdf(value) {
  const sign = value < 0 ? -1 : 1, z = Math.abs(value) / Math.sqrt(2), t = 1 / (1 + .3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z);
  return .5 * (1 + sign * erf);
}
function indexAtOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1; }
  return answer;
}
const normalizeLevels = (rows, asks) => (rows || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
  .filter((row) => row.price > 0 && row.price < 1 && row.size > 0).sort((a, b) => asks ? a.price - b.price : b.price - a.price);
function normalizeBook(raw) {
  const asks = normalizeLevels(raw?.asks, true), bids = normalizeLevels(raw?.bids, false);
  return asks.length && bids.length ? { asks, bids, bestAsk: asks[0].price, bestBid: bids[0].price } : null;
}
function readGzip(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); }
function loadFeed(market) {
  const bookFile = path.join(bookDir, `${market.slug}.json.gz`), spotFile = path.join(spotDir, `${market.slug}.json.gz`);
  if (!fs.existsSync(bookFile) || !fs.existsSync(spotFile)) return null;
  const raw = readGzip(bookFile), spotRaw = path.resolve(bookFile) === path.resolve(spotFile) ? raw : readGzip(spotFile);
  const spotTicks = (spotRaw.ticks || []).map((tick) => ({ ms: Number(tick.ms), bz: Number(tick.bz), cl: Number(tick.cl) }))
    .filter((tick) => Number.isFinite(tick.ms)).sort((a, b) => a.ms - b.ms);
  let cursor = -1, bz = null, cl = null;
  const ticks = [];
  for (const tick of raw.ticks || []) {
    const ms = Number(tick.ms ?? Date.parse(tick.time || ""));
    if (!Number.isFinite(ms)) continue;
    while (cursor + 1 < spotTicks.length && spotTicks[cursor + 1].ms <= ms) {
      const spot = spotTicks[++cursor];
      if (spot.bz > 0) bz = spot.bz;
      if (spot.cl > 0) cl = spot.cl;
    }
    if (Number(tick.bz) > 0) bz = Number(tick.bz);
    if (Number(tick.cl) > 0) cl = Number(tick.cl);
    const up = normalizeBook(tick.up), down = normalizeBook(tick.down);
    if (up && down && bz > 0 && cl > 0) ticks.push({ ms, bz, cl, up, down });
  }
  const openBinance = Number(spotRaw.openBinance ?? raw.openBinance ?? market.openBinance);
  const openChainlink = Number(spotRaw.openChainlink ?? raw.openChainlink ?? market.openChainlink);
  return ticks.length && openBinance > 0 && openChainlink > 0 ? {
    slug: market.slug, startMs: startMs(market.slug), winner: market.winner, openBinance, openChainlink, ticks,
  } : null;
}
function realizedVol(ticks, index, field, lookbackMs = 60_000) {
  let prior = null, sum = 0, count = 0;
  const from = ticks[index].ms - lookbackMs;
  for (let cursor = index; cursor >= 0 && ticks[cursor].ms >= from; cursor--) {
    const value = Number(ticks[cursor][field]);
    if (!(value > 0)) continue;
    if (!prior) { prior = { ms: ticks[cursor].ms, value }; continue; }
    if (value === prior.value) continue;
    const dt = Math.max(.001, (prior.ms - ticks[cursor].ms) / 1000);
    const changePct = (prior.value - value) / value * 100;
    sum += changePct * changePct / dt; count++; prior = { ms: ticks[cursor].ms, value };
  }
  return count ? Math.sqrt(sum / count) : 0;
}
function snapshot(feed, atS) {
  const decisionMs = feed.startMs + atS * 1000, index = indexAtOrBefore(feed.ticks, decisionMs);
  if (index < 0) return null;
  const arrivalIndex = indexAtOrBefore(feed.ticks, feed.ticks[index].ms + latencyMs - 1);
  if (arrivalIndex < index) return null;
  const tick = feed.ticks[index], upMid = (tick.up.bestAsk + tick.up.bestBid) / 2, downMid = (tick.down.bestAsk + tick.down.bestBid) / 2;
  return {
    t: (tick.ms - feed.startMs) / 1000,
    tick,
    arrival: feed.ticks[arrivalIndex],
    bzGap: (tick.bz - feed.openBinance) / feed.openBinance * 100,
    clGap: (tick.cl - feed.openChainlink) / feed.openChainlink * 100,
    sigmaBz: realizedVol(feed.ticks, index, "bz"),
    sigmaCl: realizedVol(feed.ticks, index, "cl"),
    marketUp: clamp((upMid + 1 - downMid) / 2, .01, .99),
  };
}
function fee(price, shares) { return Math.round(.07 * price * (1 - price) * shares * 1e5) / 1e5; }
function execute(levels, budget, cap) {
  let left = budget, shares = 0, cost = 0, fees = 0;
  for (const level of levels || []) {
    if (level.price > cap + 1e-9 || left <= 1e-9) break;
    const take = Math.min(level.size, left / level.price), usd = take * level.price;
    shares += take; cost += usd; fees += fee(level.price, take); left -= usd;
  }
  return shares > 0 ? { shares, cost, fees } : null;
}
function trade(feed, snap, params) {
  if (!snap) return null;
  const spotGap = params.clWeight * snap.clGap + (1 - params.clWeight) * snap.bzGap;
  const sigmaRaw = params.clWeight * snap.sigmaCl + (1 - params.clWeight) * snap.sigmaBz;
  const sigma = Math.max(params.volFloor, sigmaRaw), remainingS = Math.max(1, 300 - snap.t);
  const brownianUp = normalCdf(spotGap / (sigma * Math.sqrt(remainingS)));
  const fairUp = logistic(params.spotWeight * logit(brownianUp) + params.marketWeight * logit(snap.marketUp));
  const choices = [
    { side: "Up", fair: fairUp, book: snap.tick.up, arrival: snap.arrival.up },
    { side: "Down", fair: 1 - fairUp, book: snap.tick.down, arrival: snap.arrival.down },
  ].map((choice) => {
    const ask = choice.book.bestAsk;
    return { ...choice, ask, edge: choice.fair - ask - .07 * ask * (1 - ask) };
  }).filter((choice) => choice.ask >= params.minAsk && choice.ask <= params.maxAsk)
    .sort((a, b) => b.edge - a.edge || b.fair - a.fair);
  const choice = choices[0];
  if (!choice || choice.edge + 1e-12 < params.edgeMin) return null;
  const cap = Math.min(.99, Math.ceil((choice.ask + params.capHeadroom - 1e-10) * 100) / 100);
  const fill = execute(choice.arrival.asks, cap * baseShares, cap);
  if (!fill) return null;
  const payout = feed.winner === choice.side ? fill.shares : 0;
  return { ...fill, payout, pnl: payout - fill.cost - fill.fees, correct: Number(feed.winner === choice.side), edge: choice.edge };
}
function blank() { return { windows: 0, active: 0, correct: 0, shares: 0, cost: 0, fees: 0, payout: 0, pnl: 0 }; }
function add(stats, result) {
  stats.windows++;
  if (!result) return;
  stats.active++; stats.correct += result.correct; stats.shares += result.shares; stats.cost += result.cost; stats.fees += result.fees; stats.payout += result.payout; stats.pnl += result.pnl;
}
function metrics(raw) { return { ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value, 4)])), coveragePct: round(100 * raw.active / Math.max(1, raw.windows), 3), accuracyPct: round(100 * raw.correct / Math.max(1, raw.active), 3), roiPct: round(100 * raw.pnl / Math.max(1e-9, raw.cost + raw.fees), 4) }; }

function buildPolicies() {
  if (fixedResultFile) {
    const prior = JSON.parse(fs.readFileSync(fixedResultFile, "utf8"));
    if (!prior.selected?.params) throw new Error("fixed result has no selected.params");
    return [{ params: prior.selected.params, train: blank(), holdout: blank(), all: blank(), daily: {} }];
  }
  const rows = [];
  for (const atS of [10, 30, 60, 90, 120, 150, 180, 210, 240])
    for (const spotWeight of [.5, .75, 1, 1.25])
      for (const marketWeight of [0, .25, .5, .75, 1])
        for (const volFloor of [.003, .005, .008, .012, .02])
          for (const clWeight of [0, .5, 1])
            for (const edgeMin of [0, .01, .02, .03, .05]) {
              const params = { atS, spotWeight, marketWeight, volFloor, clWeight, edgeMin, capHeadroom: .01, minAsk: .12, maxAsk: .89, latencyMs, baseShares };
              rows.push({ params, train: blank(), holdout: blank(), all: blank(), daily: {} });
            }
  return rows;
}
const policies = buildPolicies();
const markets = cohort.markets.filter((market) => market.slug.startsWith("btc-") && market.winner)
  .filter((market) => fs.existsSync(path.join(bookDir, `${market.slug}.json.gz`)) && fs.existsSync(path.join(spotDir, `${market.slug}.json.gz`)))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug));
const startTimes = [...new Set(policies.map((policy) => policy.params.atS))];
for (let index = 0; index < markets.length; index++) {
  const feed = loadFeed(markets[index]);
  if (!feed) continue;
  const snaps = new Map(startTimes.map((atS) => [atS, snapshot(feed, atS)]));
  const segment = feed.startMs < splitMs ? "train" : "holdout", day = new Date(feed.startMs).toISOString().slice(0, 10);
  for (const policy of policies) {
    const result = trade(feed, snaps.get(policy.params.atS), policy.params);
    policy.daily[day] ||= blank();
    add(policy[segment], result); add(policy.all, result); add(policy.daily[day], result);
  }
  if ((index + 1) % 100 === 0 || index + 1 === markets.length) console.log(JSON.stringify({ phase: "fair-value", done: index + 1, total: markets.length }));
}
const rows = policies.map((policy) => ({ params: policy.params, train: metrics(policy.train), holdout: metrics(policy.holdout), all: metrics(policy.all), daily: Object.fromEntries(Object.entries(policy.daily).map(([day, raw]) => [day, metrics(raw)])) }));
const eligible = rows.filter((row) => row.train.coveragePct >= 50)
  .sort((a, b) => b.train.pnl - a.train.pnl || b.train.roiPct - a.train.roiPct || b.train.coveragePct - a.train.coveragePct);
const selected = eligible[0] || [...rows].sort((a, b) => b.train.pnl - a.train.pnl)[0];
const report = {
  schema: 1, generatedAt: new Date().toISOString(), cohortFile, bookDir, spotDir, fixedResultFile,
  causality: { split: new Date(splitMs).toISOString(), latencyMs, resolutionUsedOnlyForPnl: true, arrivalBook: "latest snapshot strictly before decision+latency", fee: "round(0.07*p*(1-p)*shares,5) per level" },
  markets: markets.length, policies: rows.length, selected,
  topTrain: eligible.slice(0, 50).map((row) => ({ params: row.params, train: row.train, holdout: row.holdout, daily: row.daily })),
};
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, markets: markets.length, policies: rows.length, selected, top: report.topTrain.slice(0, 10).map((row) => ({ params: row.params, train: row.train, holdout: row.holdout })) }, null, 2));
