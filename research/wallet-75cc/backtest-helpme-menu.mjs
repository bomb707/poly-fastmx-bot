#!/usr/bin/env node
// Chronological comparison of the original one-shot Helpme action layer with
// target-like pre-signed menu releases. Decisions use only information known at
// the decision tick. Every BUY is a fixed-USD FAK-equivalent order, arrives
// 520ms later, and walks the recorded V2 L2 asks up to its price cap.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dataDir = path.resolve(process.argv[2] || "data/wallet-75cc");
const cohortFile = path.resolve(process.argv[3] || path.join(dataDir, "cohort-2026-08-16_2026-08-26-btc.json"));
const feedDir = path.resolve(process.argv[4] || path.join(dataDir, "feeds/v2-l2"));
const splitMs = Date.parse(process.argv[5] || "2026-08-22T00:00:00Z");
const outputFile = path.resolve(process.argv[6] || path.join(dataDir, "helpme-menu-backtest-btc-aug16-25.json"));
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const markets = cohort.markets.filter((m) => m.winner && m.slug.startsWith("btc-") && fs.existsSync(path.join(feedDir, `${m.slug}.json.gz`)))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug));
const round = (value, digits = 6) => Number.isFinite(+value) ? +Number(value).toFixed(digits) : null;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const opposite = (side) => side === "Up" ? "Down" : "Up";
const book = (tick, side) => side === "Up" ? tick?.up : tick?.down;
const ask = (tick, side) => Number(book(tick, side)?.asks?.[0]?.price);

function atOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1;
  }
  return answer;
}

function walkBudget(levels, budget, cap) {
  let remaining = budget, shares = 0, cost = 0, fee = 0;
  for (const level of levels || []) {
    const price = Number(level.price), available = Number(level.size);
    if (!(price > 0) || price > cap + 1e-9 || !(available > 0) || remaining <= 1e-9) break;
    const take = Math.min(available, remaining / price), usd = take * price;
    shares += take; cost += usd;
    fee += Math.round(.07 * price * (1 - price) * take * 1e5) / 1e5;
    remaining -= usd;
  }
  return { shares, cost, fee, fraction: budget > 0 ? cost / budget : 0 };
}

function blank() {
  return { markets: 0, activeMarkets: 0, orders: 0, correctOrders: 0, shares: 0,
    winningShares: 0, cost: 0, fees: 0, payout: 0, requestedBudget: 0, fillFraction: 0 };
}

const policies = [];
for (const lookbackMs of [3_000, 5_000])
  for (const moveMin of [.01, .03])
    for (const gapMinPct of [.01, .03, .06])
      for (const startS of [5, 30, 60])
        for (const cooldownMs of [2_000, 5_000, 10_000])
          for (const capHeadroom of [0, .01])
            for (const actionMode of ["one30", "menu5", "menu7", "cross7", "residual12"])
              policies.push({
                id: `l${lookbackMs}-m${moveMin}-g${gapMinPct}-s${startS}-c${cooldownMs}-h${capHeadroom}-${actionMode}`,
                lookbackMs, moveMin, gapMinPct, startS, stopS: 285, cooldownMs, capHeadroom,
                actionMode, maxOrders: actionMode === "one30" ? 1 : 7, maxCellUses: 1,
                train: blank(), holdout: blank(), all: blank(), daily: {},
              });

function minimumShares(policy, orientedInventory) {
  if (policy.actionMode === "one30") return orientedInventory < -1e-9 ? 0 : Math.max(0, 30 - orientedInventory);
  if (policy.actionMode === "menu5") return 5;
  if (policy.actionMode === "menu7") return 7;
  if (policy.actionMode === "cross7") return orientedInventory < -1e-9 ? Math.ceil(Math.abs(orientedInventory) + 7) : 7;
  if (policy.actionMode === "residual12") return Math.max(5, Math.ceil(12 - orientedInventory));
  return 0;
}

for (let marketIndex = 0; marketIndex < markets.length; marketIndex++) {
  const market = markets[marketIndex];
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = feed.ticks || [], ws = startMs(market.slug), segment = ws < splitMs ? "train" : "holdout";
  const states = policies.map(() => ({ up: 0, down: 0, orders: 0, lastFireMs: -Infinity, used: new Map(),
    shares: 0, winningShares: 0, correctOrders: 0, cost: 0, fees: 0, requestedBudget: 0, fillFraction: 0 }));
  let lastDecisionMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index], timeS = (tick.ms - ws) / 1_000;
    if (timeS < 5 || timeS > 285 || tick.ms - lastDecisionMs < 250) continue;
    lastDecisionMs = tick.ms;
    const upAsk = ask(tick, "Up"), downAsk = ask(tick, "Down");
    if (!finite(upAsk) || !finite(downAsk) || !(Number(feed.openChainlink) > 0) || !(Number(tick.bz) > 0)) continue;
    const priorByLookback = new Map();
    for (const lookbackMs of [3_000, 5_000]) {
      const priorIndex = atOrBefore(ticks, tick.ms - lookbackMs), prior = ticks[priorIndex];
      const priorUp = ask(prior, "Up"), priorDown = ask(prior, "Down");
      priorByLookback.set(lookbackMs, finite(priorUp) && finite(priorDown)
        ? (upAsk - priorUp) - (downAsk - priorDown) : null);
    }
    const settlementGapPct = (Number(tick.bz) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100;
    for (let policyIndex = 0; policyIndex < policies.length; policyIndex++) {
      const policy = policies[policyIndex], state = states[policyIndex];
      if (timeS < policy.startS || timeS > policy.stopS || state.orders >= policy.maxOrders
        || tick.ms - state.lastFireMs < policy.cooldownMs) continue;
      const differential = priorByLookback.get(policy.lookbackMs);
      if (!finite(differential) || Math.abs(differential) + 1e-9 < policy.moveMin
        || Math.abs(settlementGapPct) + 1e-9 < policy.gapMinPct) continue;
      const side = differential > 0 ? "Up" : "Down";
      if ((settlementGapPct > 0 ? "Up" : "Down") !== side) continue;
      const sideAsk = side === "Up" ? upAsk : downAsk;
      if (sideAsk < .05 - 1e-9 || sideAsk > .98 + 1e-9) continue;
      const cap = Math.min(.99, Math.ceil((sideAsk + policy.capHeadroom - 1e-10) * 100) / 100);
      const cell = `${side}:${cap.toFixed(2)}`;
      if ((state.used.get(cell) || 0) >= policy.maxCellUses) continue;
      const imbalance = state.up - state.down, oriented = imbalance * (side === "Up" ? 1 : -1);
      const requestedShares = minimumShares(policy, oriented);
      if (requestedShares < 5 - 1e-9) continue;
      const fillIndex = atOrBefore(ticks, tick.ms + 520);
      if (fillIndex < 0) continue;
      const budget = cap * requestedShares;
      const fill = walkBudget(book(ticks[fillIndex], side)?.asks, budget, cap);
      state.used.set(cell, (state.used.get(cell) || 0) + 1);
      state.lastFireMs = tick.ms; state.requestedBudget += budget;
      if (!(fill.shares > 0)) continue;
      state.orders++; state.shares += fill.shares; state.cost += fill.cost; state.fees += fill.fee; state.fillFraction += fill.fraction;
      if (side === "Up") state.up += fill.shares; else state.down += fill.shares;
      if (market.winner === side) { state.correctOrders++; state.winningShares += fill.shares; }
    }
  }
  for (let index = 0; index < policies.length; index++) {
    const policy = policies[index], state = states[index], payout = market.winner === "Up" ? state.up : state.down;
    const day = new Date(ws).toISOString().slice(0, 10); policy.daily[day] ||= blank();
    for (const total of [policy[segment], policy.all, policy.daily[day]]) {
      total.markets++; if (state.orders) total.activeMarkets++;
      total.orders += state.orders; total.correctOrders += state.correctOrders; total.shares += state.shares;
      total.winningShares += state.winningShares; total.cost += state.cost; total.fees += state.fees;
      total.payout += payout; total.requestedBudget += state.requestedBudget; total.fillFraction += state.fillFraction;
    }
  }
  if ((marketIndex + 1) % 100 === 0 || marketIndex + 1 === markets.length)
    console.log(JSON.stringify({ phase: "replay", done: marketIndex + 1, total: markets.length }));
}

function metrics(raw) {
  const net = raw.payout - raw.cost - raw.fees;
  return { ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === "number" ? round(value, 4) : value])),
    net: round(net, 4), roiPct: raw.cost + raw.fees > 0 ? round(net / (raw.cost + raw.fees) * 100, 4) : null,
    participationPct: raw.markets ? round(raw.activeMarkets / raw.markets * 100, 3) : null,
    ordersPerActiveMarket: raw.activeMarkets ? round(raw.orders / raw.activeMarkets, 3) : null,
    actionAccuracyPct: raw.orders ? round(raw.correctOrders / raw.orders * 100, 3) : null,
    shareWeightedAccuracyPct: raw.shares ? round(raw.winningShares / raw.shares * 100, 3) : null,
    averageFillFraction: raw.orders ? round(raw.fillFraction / raw.orders, 4) : null };
}

const rows = policies.map((policy) => ({
  config: Object.fromEntries(Object.entries(policy).filter(([key]) => !["train", "holdout", "all", "daily"].includes(key))),
  train: metrics(policy.train), holdout: metrics(policy.holdout), all: metrics(policy.all),
  daily: Object.fromEntries(Object.entries(policy.daily).map(([day, raw]) => [day, metrics(raw)])),
}));
const eligible = rows.filter((row) => row.train.orders >= 300 && row.train.activeMarkets >= 250)
  .sort((a, b) => b.train.net - a.train.net || b.train.roiPct - a.train.roiPct);
const selected = eligible[0] || [...rows].sort((a, b) => b.train.net - a.train.net)[0];
const bestByMode = Object.fromEntries(["one30", "menu5", "menu7", "cross7", "residual12"].map((mode) => {
  const candidates = eligible.filter((row) => row.config.actionMode === mode);
  return [mode, candidates[0] || null];
}));
const report = { schema: 1, generatedAt: new Date().toISOString(), cohortFile, feedDir, split: new Date(splitMs).toISOString(),
  method: "CLOB differential momentum plus Binance-vs-Chainlink-open confirmation; fixed-USD FAK at decision+520ms; select only on pre-split net",
  markets: markets.length, policies: rows.length, selected, bestByMode, topTrain: eligible.slice(0, 30), rows };
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, markets: markets.length, policies: rows.length, selected,
  bestByMode: Object.fromEntries(Object.entries(bestByMode).map(([mode, row]) => [mode, row && { config: row.config, train: row.train, holdout: row.holdout }])) }, null, 2));
