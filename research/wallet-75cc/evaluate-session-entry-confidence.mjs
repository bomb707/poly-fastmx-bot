#!/usr/bin/env node

// Evaluate a fixed UTC-session minimum entry-probability schedule without using
// holdout or OOS outcomes for selection. The release cutoff remains frozen at
// 0.900. The source is the same settled BAPI v2 coherent L2 cache used by the
// target75cc controlled backtest.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { positionFromFills, simulateFills } from "../../engine/simrun.js";
import { STRAT as TARGET } from "../../engine/strategies/target75cc.js";
import { ENTRY_CONFIDENCE_SESSIONS, SESSION_ENTRY_MIN_PROBABILITY
} from "../../engine/strategies/target75cc-session-policy.js";

const root = path.resolve(import.meta.dirname, "../..");
const cacheDir = path.resolve(process.argv[2] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[3]
  || path.join(root, "research/wallet-75cc/results/session-entry-confidence-2026-09-02.json"));
const reportFile = outputFile.replace(/\.json$/i, ".md");

const ranges = Object.freeze({
  train: [Date.parse("2026-08-20T00:00:00Z") / 1_000, Date.parse("2026-08-25T00:00:00Z") / 1_000],
  validation: [Date.parse("2026-08-25T00:00:00Z") / 1_000, Date.parse("2026-08-26T00:00:00Z") / 1_000],
  holdout: [Date.parse("2026-08-26T00:00:00Z") / 1_000, Date.parse("2026-08-27T00:00:00Z") / 1_000],
  oos: [Date.parse("2026-08-27T00:00:00Z") / 1_000, Date.parse("2026-09-02T04:00:00Z") / 1_000],
});

export const SESSION_POLICY = ENTRY_CONFIDENCE_SESSIONS;

const thresholds = Object.freeze([.50, .525, .55, .575, .60, .625, .65, .675, .70, .725, .75]);
const baselineThreshold = .50;
const round = (value, digits = 4) => +Number(value).toFixed(digits);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function sessionFor(windowStart) {
  const hour = new Date(Number(windowStart) * 1_000).getUTCHours();
  return SESSION_POLICY.find((session) => hour >= session.startHour && hour < session.endHour)?.id;
}

function segmentFor(windowStart) {
  return Object.entries(ranges).find(([, [start, end]]) => windowStart >= start && windowStart < end)?.[0] || null;
}

function emptyStats() {
  return { markets: 0, tradedMarkets: 0, fills: 0, pnl: 0, profit: 0, loss: 0,
    positiveMarkets: 0, negativeMarkets: 0, fees: 0, invested: 0, equity: 0,
    peak: 0, maxDrawdown: 0, worstMarket: Infinity, bestMarket: -Infinity };
}

function add(stats, result) {
  stats.markets++;
  stats.tradedMarkets += Number(result.nFills > 0);
  stats.fills += result.nFills;
  stats.pnl += result.pnl;
  stats.profit += Math.max(0, result.pnl);
  stats.loss += Math.min(0, result.pnl);
  stats.positiveMarkets += Number(result.pnl > 0);
  stats.negativeMarkets += Number(result.pnl < 0);
  stats.fees += result.fees;
  stats.invested += result.invested;
  stats.equity += result.pnl;
  stats.peak = Math.max(stats.peak, stats.equity);
  stats.maxDrawdown = Math.max(stats.maxDrawdown, stats.peak - stats.equity);
  stats.worstMarket = Math.min(stats.worstMarket, result.pnl);
  stats.bestMarket = Math.max(stats.bestMarket, result.pnl);
}

function finish(stats) {
  return {
    markets: stats.markets,
    tradedMarkets: stats.tradedMarkets,
    participationPct: round(100 * stats.tradedMarkets / Math.max(1, stats.markets), 3),
    fills: stats.fills,
    pnl: round(stats.pnl),
    pnlPerMarket: round(stats.pnl / Math.max(1, stats.markets), 5),
    tradedWinRatePct: round(100 * stats.positiveMarkets / Math.max(1,
      stats.positiveMarkets + stats.negativeMarkets), 3),
    profitFactor: stats.loss < 0 ? round(stats.profit / -stats.loss, 4) : null,
    fees: round(stats.fees),
    invested: round(stats.invested),
    maxDrawdown: round(stats.maxDrawdown),
    worstMarket: stats.markets ? round(stats.worstMarket) : null,
    bestMarket: stats.markets ? round(stats.bestMarket) : null,
  };
}

function loadWindows() {
  const [first] = ranges.train, [, last] = ranges.oos;
  return fs.readdirSync(cacheDir).map((file) => {
    const match = file.match(/^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/);
    return match ? { file, windowStart: Number(match[1]) } : null;
  }).filter((row) => row && row.windowStart >= first && row.windowStart < last)
    .sort((left, right) => left.windowStart - right.windowStart);
}

const files = loadWindows();
const results = [];
let invalid = 0;
for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
  const { file, windowStart } = files[fileIndex];
  let data;
  try { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file)))); }
  catch { invalid++; continue; }
  if (!data.winSide || !Array.isArray(data.ticks) || data.ticks.length < 2) { invalid++; continue; }
  const segment = segmentFor(windowStart), session = sessionFor(windowStart);
  if (!segment || !session) continue;
  data.windowStart = windowStart;
  for (const threshold of thresholds) {
    const fills = simulateFills(data, { ...TARGET, STRATEGY: "target75cc",
      T_RELEASE_THRESHOLD: .90, T_REGIME_ON: true,
      T_REGIME_SESSION_ON: false,
      T_REGIME_MIN_PROBABILITY: threshold });
    const position = positionFromFills(fills, data.winSide, data.ticks);
    results.push({ windowStart, segment, session, threshold,
      pnl: Number(position.realizedPnl || 0), nFills: fills.length,
      fees: Number(position.fee || 0), invested: Number(position.totalCost || 0) });
  }
  if ((fileIndex + 1) % 100 === 0 || fileIndex + 1 === files.length) {
    console.log(JSON.stringify({ phase: "replay", done: fileIndex + 1, total: files.length }));
  }
}

function summarize(filter) {
  const stats = emptyStats();
  for (const result of results) if (filter(result)) add(stats, result);
  return finish(stats);
}

const tuning = {};
const selected = {};
for (const session of SESSION_POLICY) {
  const candidates = thresholds.map((threshold) => ({ threshold,
    train: summarize((row) => row.segment === "train" && row.session === session.id && row.threshold === threshold),
    validation: summarize((row) => row.segment === "validation" && row.session === session.id && row.threshold === threshold),
  }));
  const baseline = candidates.find((row) => row.threshold === baselineThreshold);
  const eligible = candidates.filter((row) => row.train.pnl >= baseline.train.pnl
    && row.validation.pnl >= baseline.validation.pnl);
  eligible.sort((left, right) => (right.train.pnl + right.validation.pnl)
    - (left.train.pnl + left.validation.pnl)
    || Math.abs(left.threshold - baselineThreshold) - Math.abs(right.threshold - baselineThreshold)
    || right.threshold - left.threshold);
  const winner = eligible[0] || baseline;
  selected[session.id] = winner.threshold;
  tuning[session.id] = { ...session, baselineThreshold, selectedThreshold: winner.threshold,
    selectionRule: "Maximize train+validation PnL among entry-probability thresholds that do not underperform 0.500 in either split.",
    candidates };
}

function scheduleSummary(segment, schedule) {
  return summarize((row) => row.segment === segment && row.threshold === schedule[row.session]);
}

const globalSchedule = Object.fromEntries(SESSION_POLICY.map((session) => [session.id, baselineThreshold]));
const evaluation = Object.fromEntries(Object.keys(ranges).map((segment) => [segment, {
  global0500: scheduleSummary(segment, globalSchedule),
  selectedSessionPolicy: scheduleSummary(segment, selected),
  bySession: Object.fromEntries(SESSION_POLICY.map((session) => [session.id, {
    global0500: summarize((row) => row.segment === segment && row.session === session.id
      && row.threshold === baselineThreshold),
    selected: summarize((row) => row.segment === segment && row.session === session.id
      && row.threshold === selected[session.id]),
  }])),
}]));

const promotion = {
  runtimeScheduleMatchesSelection: SESSION_POLICY.every((session) =>
    selected[session.id] === SESSION_ENTRY_MIN_PROBABILITY[session.id]),
  holdoutPnlNotWorse: evaluation.holdout.selectedSessionPolicy.pnl >= evaluation.holdout.global0500.pnl,
  holdoutDrawdownNotWorse: evaluation.holdout.selectedSessionPolicy.maxDrawdown
    <= evaluation.holdout.global0500.maxDrawdown,
  oosPnlNotWorse: evaluation.oos.selectedSessionPolicy.pnl >= evaluation.oos.global0500.pnl,
  oosPositive: evaluation.oos.selectedSessionPolicy.pnl > 0,
  oosProfitFactorAboveOne: Number(evaluation.oos.selectedSessionPolicy.profitFactor) > 1,
};
promotion.passed = Object.values(promotion).every(Boolean);

const sourceNames = files.map((row) => row.file).join("\n");
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: "Settled BAPI v2 coherent L2 cache, 120ms last-frame sampling",
  sourceManifestSha256: sha256(sourceNames),
  cache: { directory: cacheDir, files: files.length, valid: files.length - invalid, invalid },
  ranges: Object.fromEntries(Object.entries(ranges).map(([key, [start, end]]) => [key,
    { start: new Date(start * 1_000).toISOString(), end: new Date(end * 1_000).toISOString(),
      expectedWindows: (end - start) / 300 }])),
  methodology: {
    sessions: SESSION_POLICY,
    entryProbabilityThresholds: thresholds,
    baselineEntryProbability: baselineThreshold,
    frozenReleaseThreshold: .90,
    latencyMs: TARGET.LATENCY_MS,
    fillModel: "Visible-depth fixed-USDC FAK at decision + 520ms; modeled taker fee",
    selection: "Session entry-probability thresholds use train and validation only. Holdout and OOS are evaluation-only.",
    timezone: "UTC; fixed bins avoid daylight-saving drift",
  },
  selectedEntryProbabilityThresholds: selected,
  tuning,
  evaluation,
  promotion,
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");

const tableRows = Object.entries(evaluation).map(([segment, row]) =>
  `| ${segment} | ${row.global0500.pnl.toFixed(2)} | ${row.selectedSessionPolicy.pnl.toFixed(2)} | ${row.global0500.maxDrawdown.toFixed(2)} | ${row.selectedSessionPolicy.maxDrawdown.toFixed(2)} | ${row.global0500.fills} | ${row.selectedSessionPolicy.fills} |`);
const scheduleRows = SESSION_POLICY.map((session) =>
  `| ${session.startHour.toString().padStart(2, "0")}:00–${session.endHour.toString().padStart(2, "0")}:00 | ${session.label} | ${selected[session.id].toFixed(3)} |`);
function expectedSessionWindows(segment, sessionId) {
  const [start, end] = ranges[segment];
  let count = 0;
  for (let windowStart = start; windowStart < end; windowStart += 300) {
    if (sessionFor(windowStart) === sessionId) count++;
  }
  return count;
}
const coverageRows = Object.entries(evaluation).flatMap(([segment, row]) => {
  return SESSION_POLICY.map((session) => {
    const expected = expectedSessionWindows(segment, session.id);
    const actual = row.bySession[session.id].global0500.markets;
    return `| ${segment} | ${session.startHour.toString().padStart(2, "0")}:00–${session.endHour.toString().padStart(2, "0")}:00 | ${actual} / ${expected} | ${(100 * actual / expected).toFixed(1)}% |`;
  });
});
const markdown = `# Session-specific entry-confidence evaluation — 2026-09-02

The policy was selected only from the Aug 20–24 train and Aug 25 validation splits. Aug 26 holdout and Aug 27–Sep 2 partial OOS were not used to choose cutoffs.

## Selected UTC schedule

| UTC hours | Market-session label | Minimum entry probability |
|---|---|---:|
${scheduleRows.join("\n")}

## Frozen evaluation

| Split | Global 0.500 PnL | Session PnL | Global drawdown | Session drawdown | Global fills | Session fills |
|---|---:|---:|---:|---:|---:|---:|
${tableRows.join("\n")}

Research evaluation checks: **${promotion.passed ? "PASS" : "FAIL"}**

Criteria: the runtime schedule must equal the train+validation selection; holdout PnL and drawdown cannot worsen; OOS PnL cannot worsen; OOS PnL must be positive; OOS profit factor must exceed one. These checks do not authorize live execution.

Partial-OOS settlement drawdown increased from ${evaluation.oos.global0500.maxDrawdown.toFixed(2)} to ${evaluation.oos.selectedSessionPolicy.maxDrawdown.toFixed(2)}. This was not a declared selection criterion and is reported as a risk caveat.

## Coherent-L2 coverage by split and UTC bin

| Split | UTC hours | Complete / expected | Coverage |
|---|---|---:|---:|
${coverageRows.join("\n")}

The Aug 26 holdout has only 1 of 48 complete windows in 04:00–08:00 UTC. A BAPI refetch returned 47 incomplete windows and zero request failures, so evidence for that session depends more heavily on train, validation, and untouched partial OOS than on the one-day holdout.

The release cutoff stays fixed at 0.900. This changes only the trend/noise model's minimum predicted win probability for entry by UTC session. The nonnegative after-fee edge gate, model coefficients, residual and cross trees, fees, latency, cooldown, and one-use-per-cell policy remain fixed.
`;
fs.writeFileSync(reportFile, markdown);
console.log(JSON.stringify({ outputFile, reportFile, selected, evaluation, promotion }, null, 2));
