#!/usr/bin/env node
// Causal replay of a capital-scaled reconstruction of the target's taker
// ladder. Decisions use only the current/prior book and spot ticks; execution
// walks the book 520 ms later and pays the documented crypto taker fee.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const cohortFile = path.resolve(process.argv[2] || "data/wallet-75cc/cohort.json");
const feedDir = path.resolve(process.argv[3] || "data/wallet-75cc/feeds/v2-l2");
const splitMs = Date.parse(process.argv[4] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[5] || "data/wallet-75cc/reconstructed-backtest.json");
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const markets = cohort.markets.filter((market) => market.winner && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((a, b) => Number(a.slug.split("-").at(-1)) - Number(b.slug.split("-").at(-1)) || a.slug.localeCompare(b.slug));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;

const policies = [];
for (const askMove5 of [0, .01, .03])
  for (const bidMove3 of [0, .01])
    for (const bzMove1 of [0, .001, .003])
      for (const capHeadroom of [.01, .03])
        for (const cooldownMs of [3_000, 5_000, 10_000]) policies.push({
          id: `a${askMove5}-b${bidMove3}-z${bzMove1}-h${capHeadroom}-c${cooldownMs}`,
          askMove5, bidMove3, bzMove1, capHeadroom, cooldownMs,
          baseSharesAtLimit: 5, reversalResidualShares: 7, maxSharesAtLimit: 227,
          minAsk: .05, maxAsk: .98,
          train: blank(), holdout: blank(), all: blank(),
        });

function blank() { return { markets: 0, activeMarkets: 0, orders: 0, shares: 0, cost: 0, fees: 0, payout: 0, filledBudgets: 0, requestedBudget: 0 }; }
function atOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1; }
  return answer;
}
const book = (tick, side) => side === "Up" ? tick?.up : tick?.down;
const bestAsk = (tick, side) => Number(book(tick, side)?.asks?.[0]?.price);
const bestBid = (tick, side) => Number(book(tick, side)?.bids?.[0]?.price);
function walkBudget(levels, budget, cap) {
  let remaining = budget, shares = 0, cost = 0, fee = 0;
  for (const level of levels || []) {
    const price = Number(level.price), available = Number(level.size);
    if (!(price > 0) || price > cap + .00011 || !(available > 0) || remaining <= 1e-9) break;
    const take = Math.min(available, remaining / price);
    const usd = take * price;
    shares += take; cost += usd; fee += .07 * price * (1 - price) * take; remaining -= usd;
  }
  return { shares, cost, fee, spentFraction: budget > 0 ? cost / budget : 0 };
}

function feature(ticks, index, side) {
  const tick = ticks[index], ask = bestAsk(tick, side), bid = bestBid(tick, side);
  if (!finite(ask) || !finite(bid)) return null;
  const prior1 = ticks[atOrBefore(ticks, tick.ms - 1_000)];
  const prior3 = ticks[atOrBefore(ticks, tick.ms - 3_000)];
  const prior5 = ticks[atOrBefore(ticks, tick.ms - 5_000)];
  const sign = side === "Up" ? 1 : -1;
  const bz1 = Number(tick.bz) > 0 && Number(prior1?.bz) > 0 ? (Number(tick.bz) - Number(prior1.bz)) / Number(prior1.bz) * 100 * sign : null;
  return {
    side, ask, bid,
    askMove5: finite(bestAsk(prior5, side)) ? ask - bestAsk(prior5, side) : null,
    bidMove3: finite(bestBid(prior3, side)) ? bid - bestBid(prior3, side) : null,
    bzMove1: bz1,
  };
}

for (let marketIndex = 0; marketIndex < markets.length; marketIndex++) {
  const market = markets[marketIndex];
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = feed.ticks || [], startMs = Number(market.slug.split("-").at(-1)) * 1000;
  const segment = startMs < splitMs ? "train" : "holdout";
  const states = policies.map(() => ({ lastFireMs: -Infinity, used: new Set(), up: 0, down: 0, orders: 0, shares: 0, cost: 0, fees: 0, requestedBudget: 0, filledBudgets: 0 }));
  let lastSampleMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index], timeS = (tick.ms - startMs) / 1000;
    if (timeS < 5 || timeS > 295 || tick.ms - lastSampleMs < 250) continue;
    lastSampleMs = tick.ms;
    const choices = [feature(ticks, index, "Up"), feature(ticks, index, "Down")].filter(Boolean);
    if (!choices.length) continue;
    for (let policyIndex = 0; policyIndex < policies.length; policyIndex++) {
      const policy = policies[policyIndex], state = states[policyIndex];
      if (tick.ms - state.lastFireMs < policy.cooldownMs) continue;
      const eligible = choices.filter((candidate) => candidate.ask >= policy.minAsk && candidate.ask <= policy.maxAsk
        && candidate.askMove5 > policy.askMove5 + 1e-12
        && candidate.bidMove3 > policy.bidMove3 + 1e-12
        && candidate.bzMove1 > policy.bzMove1 + 1e-12);
      if (!eligible.length) continue;
      eligible.sort((a, b) => (b.askMove5 + b.bidMove3 + b.bzMove1 * 5) - (a.askMove5 + a.bidMove3 + a.bzMove1 * 5));
      const chosen = eligible[0];
      const cap = Math.min(.99, Math.ceil((chosen.ask + policy.capHeadroom - 1e-10) * 100) / 100);
      const cell = `${chosen.side}:${cap.toFixed(2)}`;
      if (state.used.has(cell)) continue;
      const fillIndex = atOrBefore(ticks, tick.ms + 520);
      if (fillIndex < 0) continue;
      const imbalance = state.up - state.down;
      const orientedInventory = imbalance * (chosen.side === "Up" ? 1 : -1);
      // Exact fills show that reversal orders usually remove the obsolete lean
      // and cross balance into a new ~7-share predicted-side residual.
      const minimumSharesAtLimit = Math.min(policy.maxSharesAtLimit, Math.ceil(orientedInventory < 0
        ? Math.abs(imbalance) + policy.reversalResidualShares
        : policy.baseSharesAtLimit));
      const requestedBudget = cap * minimumSharesAtLimit;
      const fill = walkBudget(book(ticks[fillIndex], chosen.side)?.asks, requestedBudget, cap);
      state.used.add(cell);
      state.lastFireMs = tick.ms;
      state.requestedBudget += requestedBudget;
      if (!(fill.shares > 0)) continue;
      state.orders++; state.shares += fill.shares; state.cost += fill.cost; state.fees += fill.fee; state.filledBudgets += fill.spentFraction;
      if (chosen.side === "Up") state.up += fill.shares; else state.down += fill.shares;
    }
  }
  for (let index = 0; index < policies.length; index++) {
    const policy = policies[index], state = states[index], payout = market.winner === "Up" ? state.up : state.down;
    for (const key of [segment, "all"]) {
      const total = policy[key]; total.markets++; if (state.orders) total.activeMarkets++;
      total.orders += state.orders; total.shares += state.shares; total.cost += state.cost; total.fees += state.fees;
      total.payout += payout; total.requestedBudget += state.requestedBudget; total.filledBudgets += state.filledBudgets;
    }
  }
  if ((marketIndex + 1) % 50 === 0 || marketIndex + 1 === markets.length) console.log(JSON.stringify({ phase: "replay", done: marketIndex + 1, total: markets.length }));
}

function metrics(raw) {
  const net = raw.payout - raw.cost - raw.fees;
  return {
    ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === "number" ? round(value, 4) : value])),
    net: round(net, 4), roiPct: raw.cost + raw.fees > 0 ? round(net / (raw.cost + raw.fees) * 100, 4) : null,
    participationPct: raw.markets ? round(raw.activeMarkets / raw.markets * 100, 3) : null,
    averageFillFraction: raw.orders ? round(raw.filledBudgets / raw.orders, 4) : null,
  };
}
const rows = policies.map((policy) => ({
  config: Object.fromEntries(Object.entries(policy).filter(([key]) => !["train", "holdout", "all"].includes(key))),
  train: metrics(policy.train), holdout: metrics(policy.holdout), all: metrics(policy.all),
}));
const eligible = rows.filter((row) => row.train.orders >= 250 && row.train.activeMarkets >= 100)
  .sort((a, b) => b.train.net - a.train.net || b.train.roiPct - a.train.roiPct);
const selected = eligible[0] || rows.sort((a, b) => b.train.net - a.train.net)[0];
const report = {
  schema: 1, generatedAt: new Date().toISOString(), cohortFile, feedDir,
  causality: { decisionStepMs: 250, takerLatencyMs: 520, fee: "0.07 * price * (1-price) * shares", selection: "maximum training net among policies with >=250 orders and >=100 active train markets" },
  split: new Date(splitMs).toISOString(), markets: markets.length, policies: rows.length,
  selected, topTrain: eligible.slice(0, 20), rows,
};
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, selected, topTrainHoldout: eligible.slice(0, 10).map((row) => ({ id: row.config.id, trainNet: row.train.net, trainRoi: row.train.roiPct, holdoutNet: row.holdout.net, holdoutRoi: row.holdout.roiPct, holdoutOrders: row.holdout.orders })) }, null, 2));
