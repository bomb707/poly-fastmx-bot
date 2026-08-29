#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { discover, load, executeAtLimit } from './backtest-participation-floor.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.resolve(process.argv[4] || path.join(ROOT, 'data/research/wallet3048-participation-residual-screen.json'));
const LATENCY_MS = 520;
const REST_TIMEOUT_MS = 3_000;
const ATTEMPTS = 3;
const MIN_PRICE = .12;
const MAX_PRICE = .89;
const LIMIT_OFFSET = .02;
const BASE_SHARES = 5;
const MIN_ORDER_USD = 1;
const EPS = 1e-9;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const logit = (probability) => {
  const p = clamp(Number(probability), 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
};
const logistic = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));
const normalCdf = (value) => {
  const z = Math.abs(Number(value)) / Math.sqrt(2);
  const t = 1 / (1 + .3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - .284496736) * t + .254829592) * t * Math.exp(-z * z);
  return .5 * (1 + (value < 0 ? -erf : erf));
};

function firstIndexAt(ticks, targetMs, from = 0) {
  let low = from;
  let high = ticks.length - 1;
  let answer = ticks.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms >= targetMs) {
      answer = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  return answer;
}

function realizedVolPctPerSqrtS(ticks, index, lookbackMs = 60_000) {
  const fromMs = ticks[index].ms - lookbackMs;
  let previous = null;
  let sumSquares = 0;
  let count = 0;
  for (let cursor = index; cursor >= 0 && ticks[cursor].ms >= fromMs; cursor--) {
    const tick = ticks[cursor];
    if (!(tick.cl > 0)) continue;
    if (!previous) {
      previous = tick;
      continue;
    }
    if (tick.cl === previous.cl) continue;
    const dt = Math.max(.001, (previous.ms - tick.ms) / 1000);
    const movePct = (previous.cl - tick.cl) / tick.cl * 100;
    const normalized = movePct / Math.sqrt(dt);
    sumSquares += normalized * normalized;
    count++;
    previous = tick;
  }
  return count ? Math.sqrt(sumSquares / count) : 0;
}

function snapshot(feed, startS, attempt) {
  const targetMs = feed.startMs + startS * 1000 + attempt * (LATENCY_MS + REST_TIMEOUT_MS);
  const decisionIndex = firstIndexAt(feed.ticks, targetMs);
  if (decisionIndex >= feed.ticks.length) return null;
  const decision = feed.ticks[decisionIndex];
  if (decision.ms >= feed.startMs + 285_000) return null;
  const arrivalIndex = firstIndexAt(feed.ticks, decision.ms + LATENCY_MS, decisionIndex);
  if (arrivalIndex >= feed.ticks.length) return null;
  const arrival = feed.ticks[arrivalIndex];
  const upMid = (decision.up.bestAsk + decision.up.bestBid) / 2;
  const downMid = (decision.down.bestAsk + decision.down.bestBid) / 2;
  return {
    decision,
    arrival,
    t: (decision.ms - feed.startMs) / 1000,
    clGapPct: (decision.cl - feed.openChainlink) / feed.openChainlink * 100,
    bzGapPct: (decision.bz - feed.openBinance) / feed.openBinance * 100,
    sigma: realizedVolPctPerSqrtS(feed.ticks, decisionIndex),
    marketUp: clamp((upMid + 1 - downMid) / 2, .01, .99),
  };
}

function tradeSnapshot(feed, snap, params) {
  const spotGapPct = .7 * snap.clGapPct + .3 * snap.bzGapPct;
  const sigma = Math.max(params.volFloor, snap.sigma);
  const remainingS = Math.max(1, 300 - snap.t);
  const brownianUp = normalCdf(spotGapPct / (sigma * Math.sqrt(remainingS)));
  const fairUp = logistic(params.spotWeight * logit(brownianUp) + params.marketWeight * logit(snap.marketUp));
  const choices = [
    { side: 'Up', ask: snap.decision.up.bestAsk, fair: fairUp, book: snap.arrival.up },
    { side: 'Down', ask: snap.decision.down.bestAsk, fair: 1 - fairUp, book: snap.arrival.down },
  ].filter((choice) => choice.ask >= MIN_PRICE && choice.ask <= MAX_PRICE)
    .map((choice) => ({
      ...choice,
      expectedEdge: choice.fair - choice.ask - .07 * choice.ask * (1 - choice.ask),
    }))
    .sort((a, b) => b.expectedEdge - a.expectedEdge || b.fair - a.fair || a.ask - b.ask);
  const choice = choices[0];
  if (!choice) return null;
  const shares = Math.max(BASE_SHARES, Math.ceil(MIN_ORDER_USD / choice.ask));
  const limit = Math.round(Math.min(MAX_PRICE, choice.ask + LIMIT_OFFSET) * 100) / 100;
  const execution = executeAtLimit(choice.book, shares, limit);
  if (!execution) return null;
  const payout = feed.winner === choice.side ? execution.shares : 0;
  return {
    side: choice.side,
    shares: execution.shares,
    spend: execution.cost,
    fees: execution.fees,
    payout,
    pnl: payout - execution.cost - execution.fees,
    expectedEdge: choice.expectedEdge,
    fair: choice.fair,
    decisionAsk: choice.ask,
    averagePrice: execution.averagePrice,
  };
}

function runPolicy(feed, snapshots, params) {
  for (const snap of snapshots) {
    if (!snap) continue;
    const trade = tradeSnapshot(feed, snap, params);
    if (trade) return trade;
  }
  return null;
}

function blankStats() {
  return { windows: 0, active: 0, spend: 0, fees: 0, payout: 0, pnl: 0, wins: 0, daily: {} };
}

function add(stats, day, trade) {
  stats.windows++;
  const daily = stats.daily[day] || (stats.daily[day] = { windows: 0, active: 0, spend: 0, fees: 0, payout: 0, pnl: 0, wins: 0 });
  daily.windows++;
  if (!trade) return;
  stats.active++;
  daily.active++;
  for (const field of ['spend', 'fees', 'payout', 'pnl']) {
    stats[field] += trade[field];
    daily[field] += trade[field];
  }
  if (trade.pnl > 0) {
    stats.wins++;
    daily.wins++;
  }
}

function finish(stats) {
  const row = {
    windows: stats.windows,
    activeWindows: stats.active,
    coveragePct: stats.windows ? round(100 * stats.active / stats.windows, 3) : null,
    grossBuySpend: round(stats.spend),
    fees: round(stats.fees),
    payout: round(stats.payout),
    pnl: round(stats.pnl),
    roiPct: stats.spend ? round(100 * stats.pnl / stats.spend, 3) : null,
    winRatePct: stats.active ? round(100 * stats.wins / stats.active, 3) : null,
    positiveDays: Object.values(stats.daily).filter((day) => day.pnl > 0).length,
    days: Object.keys(stats.daily).length,
    daily: {},
  };
  for (const [day, value] of Object.entries(stats.daily)) {
    row.daily[day] = {
      windows: value.windows,
      activeWindows: value.active,
      coveragePct: value.windows ? round(100 * value.active / value.windows, 3) : null,
      grossBuySpend: round(value.spend),
      fees: round(value.fees),
      payout: round(value.payout),
      pnl: round(value.pnl),
      roiPct: value.spend ? round(100 * value.pnl / value.spend, 3) : null,
      winRatePct: value.active ? round(100 * value.wins / value.active, 3) : null,
    };
  }
  return row;
}

const candidates = [];
for (const startS of [5, 15, 30, 45, 60, 90, 120, 150, 180, 210, 240]) {
  for (const spotWeight of [.5, .7, 1, 1.3]) {
    for (const marketWeight of [0, .1, .25, .5, .75, 1]) {
      for (const volFloor of [.004, .006, .008, .01, .015, .02]) {
        candidates.push({
          name: `s${startS}_sw${spotWeight}_mw${marketWeight}_vf${volFloor}`,
          startS,
          spotWeight,
          marketWeight,
          volFloor,
          train: blankStats(),
          holdout: blankStats(),
          full: blankStats(),
        });
      }
    }
  }
}

const discovered = discover();
let loaded = 0;
let failed = 0;
let firstLoaded = null;
let lastLoaded = null;
console.log(`screening ${candidates.length} causal one-trade policies on ${discovered.length} discovered windows`);
for (let index = 0; index < discovered.length; index++) {
  const feed = load(discovered[index]);
  if (!feed) {
    failed++;
    continue;
  }
  loaded++;
  firstLoaded ||= new Date(feed.startMs).toISOString();
  lastLoaded = new Date(feed.startMs).toISOString();
  const day = new Date(feed.startMs).toISOString().slice(0, 10);
  const fold = day <= '2026-08-20' ? 'train' : 'holdout';
  const byStart = new Map();
  for (const startS of new Set(candidates.map((candidate) => candidate.startS))) {
    byStart.set(startS, Array.from({ length: ATTEMPTS }, (_, attempt) => snapshot(feed, startS, attempt)));
  }
  for (const candidate of candidates) {
    const trade = runPolicy(feed, byStart.get(candidate.startS), candidate);
    add(candidate[fold], day, trade);
    add(candidate.full, day, trade);
  }
  if ((index + 1) % 100 === 0) console.log(`screened ${index + 1}/${discovered.length}`);
}

const evaluated = candidates.map((candidate) => ({
  params: {
    startS: candidate.startS,
    spotWeight: candidate.spotWeight,
    marketWeight: candidate.marketWeight,
    volFloor: candidate.volFloor,
    latencyMs: LATENCY_MS,
    attempts: ATTEMPTS,
    restTimeoutMs: REST_TIMEOUT_MS,
    minPrice: MIN_PRICE,
    maxPrice: MAX_PRICE,
    limitOffset: LIMIT_OFFSET,
    baseShares: BASE_SHARES,
    minOrderUsd: MIN_ORDER_USD,
  },
  train: finish(candidate.train),
  holdout: finish(candidate.holdout),
  full: finish(candidate.full),
}));

const trainQualified = evaluated.filter((row) => row.train.coveragePct >= 99.5)
  .sort((a, b) => b.train.pnl - a.train.pnl || b.train.positiveDays - a.train.positiveDays || b.train.coveragePct - a.train.coveragePct);
const selected = trainQualified[0] || null;
const robustPositive = trainQualified.filter((row) => row.train.pnl > 0 && row.holdout.pnl > 0 && row.full.pnl > 0)
  .sort((a, b) => b.holdout.pnl - a.holdout.pnl || b.train.pnl - a.train.pnl);

const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: {
    requestedFrom: new Date(Date.parse(process.argv[2] || '2026-08-16T00:00:00Z')).toISOString(),
    requestedTo: new Date(Date.parse(process.argv[3] || '2026-08-25T23:59:59Z')).toISOString(),
    firstLoaded,
    lastLoaded,
    discovered: discovered.length,
    loaded,
    failed,
  },
  methodology: 'One minimum-size marketable GTC per window. Side maximizes fee-adjusted expected value from a Brownian terminal probability using 70% Chainlink TWAP-60 gap and 30% Binance gap, logit-combined with causal CLOB midpoint. Fill requires executable V4 L2 at first snapshot after 520ms within decision ask +2c, capped at 0.89; up to three attempts. Candidate selection uses Aug16-20 only; Aug21+ is untouched holdout.',
  candidateCount: evaluated.length,
  selectedByTrainOnly: selected,
  positiveTrainAndHoldoutCount: robustPositive.length,
  topRobustPositive: robustPositive.slice(0, 20),
  topTrain: trainQualified.slice(0, 20),
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  range: output.range,
  candidateCount: output.candidateCount,
  selectedByTrainOnly: selected,
  positiveTrainAndHoldoutCount: robustPositive.length,
  bestRobustPositive: robustPositive[0] || null,
}, null, 2));
console.log(`wrote ${OUTPUT}`);
