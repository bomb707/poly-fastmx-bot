#!/usr/bin/env node
// Fit the three explicitly approved FastMX direction signals against one exact
// trailing day of target-wallet BTC actions. The three signals are:
//   1. Up-token CLOB midpoint movement over a causal millisecond lookback;
//   2. raw-dollar Binance movement over a causal millisecond lookback;
//   3. the poly-mom trailing trend formula: current five-minute Binance open
//      versus the Binance open N minutes earlier.
//
// Binance window-gap agreement is reported as the already-approved optional
// toggle. No inventory, hedge, reversal, price-band, or release-time feature is
// used. Candidate selection sees only the first twelve hours; the final twelve
// hours remain an untouched chronological check.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc/last24h-2026-08-27");
const feedDir = path.join(dataDir, "feeds-v2-l2");
const pairFile = path.join(dataDir, "side-choice-samples-last24h.json.gz");
const actionFile = path.join(dataDir, "fire-actions-public.json.gz");
const resultDir = path.join(root, "research/wallet-75cc/results");
const outputJson = path.join(resultDir, "three-signal-last24h-2026-08-27.json");
const outputMd = path.join(resultDir, "three-signal-last24h-2026-08-27.md");
const rangeStart = Date.parse("2026-08-26T11:25:00Z");
const fitEnd = Date.parse("2026-08-26T19:25:00Z");
const selectionEnd = Date.parse("2026-08-26T23:25:00Z");
const rangeEnd = Date.parse("2026-08-27T11:25:00Z");

const clobLookbacksMs = [3000, 5000];
const binanceLookbacksMs = [3000, 5000];
const trendLookbacksMin = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const clobThresholds = [0, .01, .02, .03, .04, .05, .06, .08, .1, .12, .15];
const binanceThresholdsUsd = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
const trendThresholdsPct = [0, .005, .01, .02, .03, .05, .075, .1, .15, .2, .3];

function readGzip(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}
function finite(value) {
  return value != null && value !== "" && Number.isFinite(Number(value));
}
function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function startMs(slug) {
  return Number(String(slug).split("-").at(-1)) * 1000;
}
function indexAtOrBefore(rows, targetMs) {
  let low = 0, high = rows.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(rows[middle].ms) <= targetMs) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}
function top(book, side) {
  const rows = book?.[side];
  if (!Array.isArray(rows) || !rows.length) return null;
  const values = rows.map((row) => Number(row?.price ?? row?.[0])).filter(Number.isFinite);
  if (!values.length) return null;
  return side === "asks" ? Math.min(...values) : Math.max(...values);
}
function midpoint(tick) {
  const ask = top(tick?.up, "asks"), bid = top(tick?.up, "bids");
  return finite(ask) && finite(bid) ? (ask + bid) / 2 : null;
}
function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return { low: null, high: null };
  const p = successes / total, zz = z * z;
  const center = (p + zz / (2 * total)) / (1 + zz / total);
  const spread = z * Math.sqrt((p * (1 - p) + zz / (4 * total)) / total) / (1 + zz / total);
  return { low: center - spread, high: center + spread };
}

const actionGroups = new Map();
for (const action of readGzip(actionFile).rows) {
  const rows = actionGroups.get(action.slug) || [];
  rows.push(action);
  actionGroups.set(action.slug, rows);
}
for (const rows of actionGroups.values()) rows.sort((a, b) => a.fireMs - b.fireMs);

const pairs = readGzip(pairFile).pairs
  .filter((pair) => pair.ms >= rangeStart && pair.ms < rangeEnd);
const neededSlugs = new Set(pairs.map((pair) => pair.slug));
for (const pair of pairs) {
  for (const minutes of trendLookbacksMin) {
    const priorStart = startMs(pair.slug) - minutes * 60_000;
    neededSlugs.add(`btc-updown-5m-${Math.floor(priorStart / 1000)}`);
  }
}

const openByStart = new Map();
let missingFeeds = 0;
for (const slug of neededSlugs) {
  const file = path.join(feedDir, `${slug}.json.gz`);
  if (!fs.existsSync(file)) { missingFeeds++; continue; }
  const feed = readGzip(file);
  const open = finite(feed.openBinance)
    ? Number(feed.openBinance) : Number((feed.ticks || []).find((tick) => finite(tick.bz))?.bz);
  if (finite(open)) openByStart.set(startMs(slug), open);
}

const rows = [];
let missingActionSide = 0, missingCurrentFeed = 0;
const pairsBySlug = new Map();
for (const pair of pairs) {
  const selected = pairsBySlug.get(pair.slug) || [];
  selected.push(pair);
  pairsBySlug.set(pair.slug, selected);
}
for (const [slug, selectedPairs] of pairsBySlug) {
  const file = path.join(feedDir, `${slug}.json.gz`);
  if (!fs.existsSync(file)) { missingCurrentFeed += selectedPairs.length; continue; }
  const feed = readGzip(file);
  feed.ticks = (feed.ticks || []).filter((tick) => finite(tick.ms));
  if (!feed.ticks.length) { missingCurrentFeed += selectedPairs.length; continue; }
  for (const pair of selectedPairs) {
    const actionIndex = Number(String(pair.id).split(":").at(-1));
    const action = actionGroups.get(pair.slug)?.[actionIndex];
    const side = action?.outcome === "Down" ? "Down" : action?.outcome === "Up" ? "Up" : null;
    if (!side) { missingActionSide++; continue; }
    const currentIndex = indexAtOrBefore(feed.ticks, pair.ms);
    const current = feed.ticks[currentIndex];
    if (!current) continue;
    const sign = side === "Up" ? 1 : -1;
    const clob = {}, binance = {}, trend = {};
    const currentMid = midpoint(current), currentBz = finite(current.bz) ? Number(current.bz) : null;
    for (const lookbackMs of clobLookbacksMs) {
      const prior = feed.ticks[indexAtOrBefore(feed.ticks, pair.ms - lookbackMs)];
      const priorMid = midpoint(prior);
      clob[lookbackMs] = finite(currentMid) && finite(priorMid)
        ? (currentMid - priorMid) * sign : null;
    }
    for (const lookbackMs of binanceLookbacksMs) {
      const prior = feed.ticks[indexAtOrBefore(feed.ticks, pair.ms - lookbackMs)];
      const priorBz = finite(prior?.bz) ? Number(prior.bz) : null;
      binance[lookbackMs] = finite(currentBz) && finite(priorBz)
        ? (currentBz - priorBz) * sign : null;
    }
    const currentOpen = openByStart.get(startMs(pair.slug));
    for (const minutes of trendLookbacksMin) {
      const referenceOpen = openByStart.get(startMs(pair.slug) - minutes * 60_000);
      trend[minutes] = finite(currentOpen) && finite(referenceOpen) && referenceOpen > 0
        ? ((currentOpen - referenceOpen) / referenceOpen * 100) * sign : null;
    }
    const gapAgree = finite(currentBz) && finite(currentOpen)
      ? (currentBz - currentOpen) * sign >= 0 : null;
    rows.push({ ms: pair.ms, side, role: pair.role, clob, binance, trend, gapAgree });
  }
}

const splits = {
  fit: rows.filter((row) => row.ms < fitEnd),
  selection: rows.filter((row) => row.ms >= fitEnd && row.ms < selectionEnd),
  holdout: rows.filter((row) => row.ms >= selectionEnd),
  fullDay: rows,
};

function classify(row, config) {
  const values = [row.clob[config.clobLookbackMs], row.binance[config.binanceLookbackMs],
    row.trend[config.trendLookbackMin]];
  if (values.some((value) => !finite(value))) return null;
  if (Math.abs(values[0]) + 1e-12 < config.clobVelocityMin) return null;
  if (Math.abs(values[1]) + 1e-12 < config.binanceVelocityMinUsd) return null;
  if (Math.abs(values[2]) + 1e-12 < config.trendThresholdPct) return null;
  const directions = values.map(Math.sign);
  if (directions.includes(0) || !directions.every((direction) => direction === directions[0])) return null;
  if (config.binanceGapAgreeOn && row.gapAgree !== (directions[0] > 0)) return null;
  return directions[0] > 0;
}

function metrics(selectedRows, config, detailed = true) {
  let actions = 0, successes = 0;
  const byRole = {};
  for (const row of selectedRows) {
    const correct = classify(row, config);
    if (correct == null) continue;
    actions++;
    if (correct) successes++;
    if (detailed) {
      const role = byRole[row.role] ||= { actions: 0, successes: 0 };
      role.actions++;
      if (correct) role.successes++;
    }
  }
  for (const role of Object.values(byRole)) {
    role.precision = round(role.successes / role.actions);
    delete role.successes;
  }
  const interval = wilson(successes, actions);
  return { actions, successes, errors: actions - successes,
    coverage: round(actions / Math.max(1, selectedRows.length)),
    precision: actions ? round(successes / actions) : null,
    wilson95Low: round(interval.low), wilson95High: round(interval.high),
    ...(detailed ? { byRole } : {}) };
}

const candidates = [];
for (const clobLookbackMs of clobLookbacksMs)
  for (const clobVelocityMin of clobThresholds)
    for (const binanceLookbackMs of binanceLookbacksMs)
      for (const binanceVelocityMinUsd of binanceThresholdsUsd)
        for (const trendLookbackMin of trendLookbacksMin)
          for (const trendThresholdPct of trendThresholdsPct)
            for (const binanceGapAgreeOn of [false, true]) {
              const config = { clobLookbackMs, clobVelocityMin, binanceLookbackMs,
                binanceVelocityMinUsd, trendLookbackMin, trendThresholdPct, binanceGapAgreeOn };
              const fit = metrics(splits.fit, config, false);
              const selection = metrics(splits.selection, config, false);
              if (fit.actions < 60 || selection.actions < 30) continue;
              candidates.push({ config, fit, selection,
                robustPrecision: Math.min(fit.precision, selection.precision),
                robustWilson: Math.min(fit.wilson95Low, selection.wilson95Low) });
            }

// Rank without observing the final twelve hours. Confidence comes first, then
// the worst chronological point precision, then useful action coverage.
candidates.sort((a, b) => b.robustWilson - a.robustWilson
  || b.robustPrecision - a.robustPrecision
  || (b.fit.actions + b.selection.actions) - (a.fit.actions + a.selection.actions));
const selected = candidates[0];
if (!selected) throw new Error("no three-signal candidate met the chronological sample floors");
const selectedClob3 = candidates.find((candidate) => candidate.config.clobLookbackMs === 3000);
if (!selectedClob3) throw new Error("no three-signal candidate met the sample floors with the required 3000 ms CLOB lookback");

function evaluate(config) {
  return Object.fromEntries(Object.entries(splits).map(([name, selectedRows]) => [name, metrics(selectedRows, config)]));
}
const selectedResult = { config: selected.config, ...evaluate(selected.config) };
const selectedClob3Result = { config: selectedClob3.config, ...evaluate(selectedClob3.config) };
const defaults = {
  clobLookbackMs: 3000, clobVelocityMin: .08,
  binanceLookbackMs: 3000, binanceVelocityMinUsd: 6,
  trendLookbackMin: 30, trendThresholdPct: .05, binanceGapAgreeOn: true,
};
const defaultResult = { config: defaults, ...evaluate(defaults) };
const noGapAgreement = { ...selected.config, binanceGapAgreeOn: false };
const selectedNoGapResult = { config: noGapAgreement, ...evaluate(noGapAgreement) };
const leaderboard = candidates.slice(0, 25).map((candidate) => ({
  config: candidate.config, robustPrecision: candidate.robustPrecision,
  robustWilson: candidate.robustWilson, fit: candidate.fit, selection: candidate.selection,
  holdout: metrics(splits.holdout, candidate.config), fullDay: metrics(splits.fullDay, candidate.config),
}));

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  range: { start: new Date(rangeStart).toISOString(), fitEnd: new Date(fitEnd).toISOString(),
    selectionEnd: new Date(selectionEnd).toISOString(), end: new Date(rangeEnd).toISOString() },
  methodology: "First 8h fit + next 4h selection; final 12h untouched. Rank by worst fit/selection Wilson-95 lower bound. Direction precision is measured at target action times and is not release-time precision or profitability.",
  formula: {
    clob: "Up midpoint(t)-Up midpoint(t-lookback); Down is the negative orientation",
    binance: "Binance spot(t)-Binance spot(t-lookback), raw USD",
    trend: "100*(current five-minute Binance open-open N minutes earlier)/prior open",
    agreement: "all three enabled signal directions clear thresholds and agree",
    binanceGapAgree: "optional existing toggle: selected direction also matches spot versus current window open",
  },
  dataQuality: { sourcePairs: pairs.length, usableRows: rows.length, missingFeeds,
    missingCurrentFeed, missingActionSide, splitRows: Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, v.length])) },
  selected: selectedResult,
  selectedClob3: selectedClob3Result,
  selectedWithoutGapAgreement: selectedNoGapResult,
  polyMomDefaults: defaultResult,
  leaderboard,
  caveat: "This is an in-day signal-direction imitation audit. It does not prove stable earnings, execution quality, event-time recall, or future performance.",
};

const pct = (value) => value == null ? "n/a" : `${round(value * 100, 2)}%`;
const metricLine = (label, value) => `- ${label}: ${value.actions} actions, ${pct(value.coverage)} target-action coverage, ${pct(value.precision)} direction match, Wilson-95 lower ${pct(value.wilson95Low)}.`;
const configLine = (config) => `CLOB ${config.clobLookbackMs} ms ≥ ${config.clobVelocityMin}; Binance ${config.binanceLookbackMs} ms ≥ $${config.binanceVelocityMinUsd}; trend ${config.trendLookbackMin} min ≥ ${config.trendThresholdPct}%; Binance window-gap agreement ${config.binanceGapAgreeOn ? "ON" : "OFF"}`;
let markdown = "# FastMX three-signal trailing-day fit\n\n";
markdown += `Target: \`${report.target}\`. Exact UTC range: ${report.range.start} through ${report.range.end}.\n\n`;
markdown += "## Chronologically selected config\n\n" + configLine(selectedResult.config) + "\n\n";
markdown += metricLine("Fit (first 8h)", selectedResult.fit) + "\n";
markdown += metricLine("Selection (next 4h)", selectedResult.selection) + "\n";
markdown += metricLine("Untouched holdout (final 12h)", selectedResult.holdout) + "\n";
markdown += metricLine("Full trailing day", selectedResult.fullDay) + "\n\n";
markdown += "## Required 3000 ms CLOB lookback\n\n" + configLine(selectedClob3Result.config) + "\n\n";
markdown += metricLine("Fit (first 8h)", selectedClob3Result.fit) + "\n";
markdown += metricLine("Selection (next 4h)", selectedClob3Result.selection) + "\n";
markdown += metricLine("Untouched holdout (final 12h)", selectedClob3Result.holdout) + "\n";
markdown += metricLine("Full trailing day", selectedClob3Result.fullDay) + "\n\n";
markdown += "## Same three signals without window-gap agreement\n\n" + configLine(selectedNoGapResult.config) + "\n\n";
markdown += metricLine("Untouched holdout", selectedNoGapResult.holdout) + "\n";
markdown += metricLine("Full trailing day", selectedNoGapResult.fullDay) + "\n\n";
markdown += "## Reference defaults\n\n" + configLine(defaultResult.config) + "\n\n";
markdown += metricLine("Untouched holdout", defaultResult.holdout) + "\n";
markdown += metricLine("Full trailing day", defaultResult.fullDay) + "\n\n";
markdown += `Caveat: ${report.caveat}\n`;

fs.mkdirSync(resultDir, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputMd, markdown);
console.log(markdown);
console.log(JSON.stringify({ outputJson, dataQuality: report.dataQuality,
  topFive: leaderboard.slice(0, 5).map(({ config, fit, selection, holdout, fullDay }) => ({ config, fit, selection, holdout, fullDay })) }, null, 2));
