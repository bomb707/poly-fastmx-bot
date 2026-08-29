#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const source = JSON.parse(fs.readFileSync(path.join(dataDir, "trades-2026-08-14_2026-08-22.json"), "utf8"));
const fireData = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz"))));
const v2Dir = path.join(dataDir, "feeds/v2");
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const dayOfSlug = (slug) => new Date(Number(slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10);
const pct = (n, d) => d ? +(n / d * 100).toFixed(3) : null;

// Inventory-label exact orders. Low-confidence rows remain in the state update,
// but only high/medium entry orders become positive signal events.
const rowsBySlug = new Map();
for (const row of fireData.rows) {
  if (!rowsBySlug.has(row.slug)) rowsBySlug.set(row.slug, []);
  rowsBySlug.get(row.slug).push(row);
}
const entriesBySlug = new Map(), entryRows = [];
for (const [slug, rows] of rowsBySlug) {
  rows.sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  let up = 0, down = 0;
  const entries = [];
  for (const row of rows) {
    const shares = Number(row.filledShares) || 0;
    const oppositeInventory = row.outcome === "Up" ? down : up;
    const sameInventory = row.outcome === "Up" ? up : down;
    const hedgeShares = Math.min(shares, Math.max(0, oppositeInventory - sameInventory));
    const entryShares = Math.max(0, shares - hedgeShares);
    if (row.confidence !== "low" && entryShares > 1e-8) {
      const labeled = { ...row, entryShares };
      entryRows.push(labeled);
      entries.push({ ms: row.fireMs, side: row.outcome, row: labeled });
    }
    if (row.outcome === "Up") up += shares; else down += shares;
  }
  // One trigger can submit several orders inside the same recorder interval.
  const clustered = [];
  for (const event of entries) {
    const previous = clustered.at(-1);
    if (previous && previous.side === event.side && event.ms - previous.ms <= 300) {
      previous.ms = Math.min(previous.ms, event.ms);
      previous.orders++;
    } else clustered.push({ ms: event.ms, side: event.side, orders: 1 });
  }
  entriesBySlug.set(slug, clustered);
}

function readFeed(slug) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(v2Dir, `${slug}.json.gz`)))); }
  catch { return null; }
}
function downsample(ticks, bucketMs = 200) {
  const out = [];
  let bucket = null, last = null;
  for (const tick of ticks || []) {
    const next = Math.floor(Number(tick.ms) / bucketMs);
    if (bucket != null && next !== bucket && last) out.push(last);
    bucket = next;
    last = tick;
  }
  if (last) out.push(last);
  return out;
}
function signalSeries(feed, sourceName) {
  const out = [];
  for (const tick of downsample(feed.ticks)) {
    let value = null;
    if (sourceName === "clob" && finite(tick.upAsk) && finite(tick.dnAsk)) value = (Number(tick.upAsk) + 1 - Number(tick.dnAsk)) / 2;
    if (sourceName === "binance" && finite(tick.bz) && finite(feed.openBinance) && Number(feed.openBinance) !== 0) value = (Number(tick.bz) / Number(feed.openBinance) - 1) * 100;
    if (sourceName === "chainlink" && finite(tick.cl) && finite(feed.openChainlink) && Number(feed.openChainlink) !== 0) value = (Number(tick.cl) / Number(feed.openChainlink) - 1) * 100;
    if (finite(value)) out.push({ ms: Number(tick.ms), value });
  }
  return out;
}
function velocity(series, lookbackS) {
  const out = [];
  let lag = 0;
  for (let index = 0; index < series.length; index++) {
    const target = series[index].ms - lookbackS * 1000;
    if (series[0].ms > target) continue;
    while (lag + 1 < series.length && series[lag + 1].ms <= target) lag++;
    out.push({ ms: series[index].ms, v: series[index].value - series[lag].value });
  }
  return out;
}
function makeMarks(vel, threshold, mode, cooldownMs) {
  const marks = [];
  let activeSign = 0, lastMark = -Infinity;
  for (const point of vel) {
    const sign = point.v > 0 ? 1 : point.v < 0 ? -1 : 0;
    const active = sign !== 0 && Math.abs(point.v) >= threshold;
    if (!active) { activeSign = 0; continue; }
    const onset = activeSign !== sign;
    if ((onset || mode === "repeat") && point.ms - lastMark >= cooldownMs) {
      marks.push({ ms: point.ms, side: sign > 0 ? "Up" : "Down" });
      lastMark = point.ms;
    }
    activeSign = sign;
  }
  return marks;
}
function directedMatches(marks, events, toleranceMs = 750) {
  let matched = 0;
  for (const side of ["Up", "Down"]) {
    const m = marks.filter((row) => row.side === side), e = events.filter((row) => row.side === side);
    let i = 0, j = 0;
    while (i < m.length && j < e.length) {
      if (m[i].ms < e[j].ms - toleranceMs) i++;
      else if (e[j].ms < m[i].ms - toleranceMs) j++;
      else { matched++; i++; j++; }
    }
  }
  return matched;
}

const marketRows = source.markets.map((market) => ({ ...market, day: dayOfSlug(market.slug) }));
const currentTrain = marketRows.filter((market) => market.day === "2026-08-19" || market.day === "2026-08-20");
const currentHoldout = marketRows.filter((market) => market.day === "2026-08-21" || market.day === "2026-08-22");
const feeds = new Map();
for (const market of [...currentTrain, ...currentHoldout]) {
  const feed = readFeed(market.slug);
  if (feed) feeds.set(market.slug, feed);
}
const seriesCache = new Map(), velocityCache = new Map();
function getVelocity(slug, sourceName, lookbackS) {
  const key = `${slug}|${sourceName}|${lookbackS}`;
  if (velocityCache.has(key)) return velocityCache.get(key);
  const sourceKey = `${slug}|${sourceName}`;
  let series = seriesCache.get(sourceKey);
  if (!series) { series = signalSeries(feeds.get(slug), sourceName); seriesCache.set(sourceKey, series); }
  const result = velocity(series, lookbackS);
  velocityCache.set(key, result);
  return result;
}
function evaluateMomentum(config, markets) {
  let marks = 0, events = 0, matched = 0;
  for (const market of markets) {
    if (!feeds.has(market.slug)) continue;
    const actual = entriesBySlug.get(market.slug) || [];
    const predicted = makeMarks(getVelocity(market.slug, config.source, config.lookbackS), config.threshold, config.mode, config.cooldownS * 1000);
    marks += predicted.length;
    events += actual.length;
    matched += directedMatches(predicted, actual);
  }
  const precision = marks ? matched / marks : 0, recall = events ? matched / events : 0;
  return { ...config, marks, events, matched, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

const sampleTrain = currentTrain.filter((_, index) => index % 4 === 0);
const grid = [];
for (const sourceName of ["clob", "binance", "chainlink"]) {
  const thresholds = sourceName === "clob" ? [.005, .01, .02, .03, .05, .08, .12] : [.0005, .001, .002, .003, .005, .008, .012];
  for (const lookbackS of [1, 3, 5, 10, 15]) for (const threshold of thresholds) {
    for (const mode of ["onset", "repeat"]) for (const cooldownS of [.5, 2, 5]) {
      grid.push(evaluateMomentum({ source: sourceName, lookbackS, threshold, mode, cooldownS }, sampleTrain));
    }
  }
}
grid.sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
const finalists = [];
const seen = new Set();
for (const candidate of grid) {
  const key = [candidate.source, candidate.lookbackS, candidate.threshold, candidate.mode, candidate.cooldownS].join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  const train = evaluateMomentum(candidate, currentTrain);
  const holdout = evaluateMomentum(candidate, currentHoldout);
  finalists.push({ config: candidate, train, holdout, holdoutF1: holdout.f1 });
  if (finalists.length >= 30) break;
}
finalists.sort((a, b) => b.holdoutF1 - a.holdoutF1 || b.train.f1 - a.train.f1);

// Interpretable side equation at actual entry fires. Standardized logistic
// regression is fit on Aug 19-20 and frozen for the Aug 21-22 holdout.
const featureNames = [
  "clobUpMove1", "clobUpMove3", "clobUpMove5", "clobUpMove10", "clobUpMove15",
  "bzMom1", "bzMom3", "bzMom5", "bzMom10", "bzMom15",
  "clMom1", "clMom3", "clMom5", "clMom10", "clMom15",
  "bzGapPct", "clGapPct", "bzClSpreadPct", "clobUpProxy", "tInto",
];
function examples(days) {
  return entryRows.filter((row) => days.includes(dayOfSlug(row.slug)) && row.v2Feature).map((row) => ({
    y: row.outcome === "Up" ? 1 : 0,
    x: featureNames.map((name) => finite(row.v2Feature[name]) ? Number(row.v2Feature[name]) : 0),
  }));
}
const sideTrain = examples(["2026-08-19", "2026-08-20"]), sideHoldout = examples(["2026-08-21", "2026-08-22"]);
const means = featureNames.map((_, index) => sideTrain.reduce((sum, row) => sum + row.x[index], 0) / Math.max(1, sideTrain.length));
const scales = featureNames.map((_, index) => Math.sqrt(sideTrain.reduce((sum, row) => sum + (row.x[index] - means[index]) ** 2, 0) / Math.max(1, sideTrain.length)) || 1);
const standardized = (row) => row.x.map((value, index) => (value - means[index]) / scales[index]);
let weights = Array(featureNames.length + 1).fill(0);
for (let epoch = 0; epoch < 100; epoch++) {
  const gradient = Array(weights.length).fill(0);
  for (const row of sideTrain) {
    const x = standardized(row);
    let score = weights[0];
    for (let index = 0; index < x.length; index++) score += weights[index + 1] * x[index];
    const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score))));
    const error = probability - row.y;
    gradient[0] += error;
    for (let index = 0; index < x.length; index++) gradient[index + 1] += error * x[index];
  }
  const rate = .4 / Math.sqrt(epoch + 1), l2 = .002;
  for (let index = 0; index < weights.length; index++) {
    const penalty = index === 0 ? 0 : l2 * weights[index];
    weights[index] -= rate * (gradient[index] / Math.max(1, sideTrain.length) + penalty);
  }
}
function evaluateSide(rows) {
  const scored = rows.map((row) => {
    const x = standardized(row);
    let score = weights[0];
    for (let index = 0; index < x.length; index++) score += weights[index + 1] * x[index];
    return { y: row.y, p: 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score)))) };
  });
  const accuracy = scored.filter((row) => (row.p >= .5 ? 1 : 0) === row.y).length / Math.max(1, scored.length);
  const sorted = scored.sort((a, b) => a.p - b.p);
  let negatives = 0, positives = 0, rankSum = 0;
  for (let index = 0; index < sorted.length; index++) {
    if (sorted[index].y) { positives++; rankSum += index + 1; } else negatives++;
  }
  const auc = positives && negatives ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : null;
  return { n: scored.length, accuracy, auc };
}
const coefficients = featureNames.map((name, index) => ({
  feature: name,
  standardizedWeight: weights[index + 1],
  rawWeight: weights[index + 1] / scales[index],
  mean: means[index],
  scale: scales[index],
})).sort((a, b) => Math.abs(b.standardizedWeight) - Math.abs(a.standardizedWeight));

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  definition: "entry/top-up events only; exact fire intervals; features evaluated before the book transition",
  currentRegime: { trainDays: ["2026-08-19", "2026-08-20"], holdoutDays: ["2026-08-21", "2026-08-22"] },
  events: { totalEntryOrders: entryRows.length, trainClusters: currentTrain.reduce((sum, market) => sum + (entriesBySlug.get(market.slug)?.length || 0), 0), holdoutClusters: currentHoldout.reduce((sum, market) => sum + (entriesBySlug.get(market.slug)?.length || 0), 0) },
  momentumGrid: {
    sampleTrainWindows: sampleTrain.length,
    trainWindows: currentTrain.length,
    holdoutWindows: currentHoldout.length,
    bestByHoldout: finalists.slice(0, 15).map((row) => ({
      config: row.config,
      train: { precisionPct: pct(row.train.matched, row.train.marks), recallPct: pct(row.train.matched, row.train.events), f1: +row.train.f1.toFixed(4), marks: row.train.marks, events: row.train.events, matched: row.train.matched },
      holdout: { precisionPct: pct(row.holdout.matched, row.holdout.marks), recallPct: pct(row.holdout.matched, row.holdout.events), f1: +row.holdout.f1.toFixed(4), marks: row.holdout.marks, events: row.holdout.events, matched: row.holdout.matched },
    })),
  },
  entrySideEquation: {
    formula: "P(Up entry)=sigmoid(intercept + sum(standardizedWeight * z(feature)))",
    intercept: weights[0],
    train: evaluateSide(sideTrain),
    holdout: evaluateSide(sideHoldout),
    coefficients,
  },
};
fs.writeFileSync(path.join(dataDir, "entry-signal-fit.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
