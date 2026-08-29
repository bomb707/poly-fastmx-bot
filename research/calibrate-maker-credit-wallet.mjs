#!/usr/bin/env node
/**
 * Conditional maker-credit calibration from wallet 0x3048...7537.
 *
 * Only independently inferred, high/medium-confidence, maker-only resting
 * orders are eligible. Target fills are taken from the public Data API and
 * matched to exact transaction/outcome/cent. Market-wide taker prints provide
 * the exact-price denominator. Same-price overlapping target orders are
 * excluded so one public print is not reused across calibration observations.
 *
 * This can validate capture conditional on a publicly observed fill. It cannot
 * reveal unfilled/cancelled private orders, so it deliberately never claims an
 * unconditional fill probability or stable profitability.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./wallet-3048/core.mjs";
import { synthesizeBinaryBooks } from "./wallet-3048/order-fire.mjs";
import {
  bootstrapRatioLower95,
  captureMetrics,
  exactCent,
  exactPriceVolume,
  groupTargetMakerFills,
  markOverlappingIntervals,
  targetMakerFillKey,
} from "./maker-credit-calibration-model.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, "data/research/wallet-maker-credit-calibration.json"));
const DATASETS = [
  { name: "r1", root: path.join(ROOT, "data/wallet-3048"), trades: path.join(ROOT, "data/wallet-3048/trades-2026-08-14_2026-08-22.json") },
  { name: "r2", root: path.join(ROOT, "data/wallet-3048-r2"), trades: path.join(ROOT, "data/wallet-3048/trades-2026-08-22T17_2026-08-24.json") },
  { name: "r3", root: path.join(ROOT, "data/wallet-3048-r3"), trades: path.join(ROOT, "data/wallet-3048-r3/trades.json") },
  { name: "r5", root: path.join(ROOT, "data/wallet-3048-r5"), trades: path.join(ROOT, "data/wallet-3048-r5/trades.json") },
  { name: "r6", root: path.join(ROOT, "data/wallet-3048-r6"), trades: path.join(ROOT, "data/wallet-3048-r6/trades.json") },
];
const L2_DIRS = [
  path.join(ROOT, "data/wallet-3048/feeds/v4-e8-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-r2-l2"),
  path.join(ROOT, "data/wallet-3048-r3/feeds/v4-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-l2"),
  path.join(ROOT, "data/wallet-3048-r4/feeds/v4-l2"),
  path.join(ROOT, "data/wallet-3048-r5/feeds/v4-l2"),
  path.join(ROOT, "data/wallet-3048-r6/feeds/v4-l2"),
];
const TRADE_DIRS = [
  path.join(ROOT, "data/wallet-3048/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r3/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r4/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r5/feeds/market-trades"),
  path.join(ROOT, "data/wallet-3048-r6/feeds/market-trades"),
];
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const round = (value, digits = 6) => value == null || !Number.isFinite(value) ? null : +value.toFixed(digits);
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const q = (rows, field) => Object.fromEntries([["p05", .05], ["p10", .1], ["p25", .25], ["p50", .5], ["p75", .75], ["p90", .9], ["p95", .95]]
  .map(([name, probability]) => [name, round(quantile(rows.map((row) => row[field]), probability))]));

function fileIndex(dirs) {
  const index = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".json.gz") && !index.has(name.slice(0, -8)))
      index.set(name.slice(0, -8), path.join(dir, name));
  }
  return index;
}

function levelSize(levels, price) {
  return (levels || []).reduce((total, level) => total
    + (Math.abs(Number(level.price) - Number(price)) < .005 ? Number(level.size || 0) : 0), 0);
}

function indexAtOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(ticks[middle].ms) <= ms) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

const targetRows = [], fires = [];
for (const dataset of DATASETS) {
  const fireFile = path.join(dataset.root, "order-fires.json.gz");
  const signedFile = path.join(dataset.root, "signed-orders.json.gz");
  if (!fs.existsSync(dataset.trades) || !fs.existsSync(fireFile) || !fs.existsSync(signedFile)) continue;
  targetRows.push(...JSON.parse(fs.readFileSync(dataset.trades, "utf8")).trades);
  const signedByHash = new Map(readGzip(signedFile).groups.map((row) => [row.orderHash, row]));
  fires.push(...readGzip(fireFile).rows.map((row) => ({ ...row, dataset: dataset.name,
    settlementDetails: signedByHash.get(row.orderHash)?.settlements || [] })));
}
const targetFills = groupTargetMakerFills(targetRows);
const eligibleFires = fires.filter((row) => row.method === "rest" && row.confidence !== "low"
  && Number(row.signedShares) >= 5 && Number(row.limitPrice) >= .12 && Number(row.limitPrice) <= .89);

// A target public row is clean only if exactly one eligible signed order in
// that settlement transaction can own the same outcome/cent fill.
const candidatesByFill = new Map();
for (const fire of eligibleFires) {
  for (const settlement of fire.settlementDetails || []) {
    if (settlement.role !== "maker" || !settlement.txHash) continue;
    const key = targetMakerFillKey({ slug: fire.slug, transactionHash: settlement.txHash,
      outcome: fire.outcome, price: fire.limitPrice });
    if (!targetFills.has(key)) continue;
    if (!candidatesByFill.has(key)) candidatesByFill.set(key, new Set());
    candidatesByFill.get(key).add(fire.orderHash);
  }
}

const fillKeysByOrder = new Map();
for (const [key, hashes] of candidatesByFill) if (hashes.size === 1) {
  const hash = [...hashes][0];
  if (!fillKeysByOrder.has(hash)) fillKeysByOrder.set(hash, []);
  fillKeysByOrder.get(hash).push(key);
}
const l2Files = fileIndex(L2_DIRS), tradeFiles = fileIndex(TRADE_DIRS);
const prelim = [], exclusions = new Map();
const exclude = (reason) => exclusions.set(reason, (exclusions.get(reason) || 0) + 1);
const bySlug = new Map();
for (const fire of eligibleFires) {
  if (!bySlug.has(fire.slug)) bySlug.set(fire.slug, []);
  bySlug.get(fire.slug).push(fire);
}

let processedSlugs = 0;
for (const [slug, slugFires] of bySlug) {
  const l2File = l2Files.get(slug), tradeFile = tradeFiles.get(slug);
  if (!l2File || !tradeFile) { for (const fire of slugFires) exclude("missing_l2_or_market_trades"); continue; }
  let l2, market;
  try { l2 = readGzip(l2File); market = readGzip(tradeFile); }
  catch { for (const fire of slugFires) exclude("malformed_feed"); continue; }
  const ticks = (l2.ticks || []).sort((a, b) => Number(a.ms) - Number(b.ms));
  for (const fire of slugFires) {
    const keys = fillKeysByOrder.get(fire.orderHash) || [];
    const expectedMakerTxs = new Set((fire.settlementDetails || []).filter((row) => row.role === "maker").map((row) => String(row.txHash).toLowerCase()));
    const fills = keys.map((key) => targetFills.get(key)).filter(Boolean);
    const assignedTxs = new Set(fills.map((fill) => fill.transactionHash));
    if (!fills.length || [...expectedMakerTxs].some((tx) => !assignedTxs.has(tx))) { exclude("missing_or_ambiguous_target_fill"); continue; }
    const targetShares = sum(fills, "shares");
    if (targetShares > Number(fire.signedShares) + 1e-6) { exclude("target_fill_exceeds_signed_capacity"); continue; }
    const fromMs = Number(fire.intervalEndMs), toMs = Math.max(...fills.map((fill) => (Number(fill.timestamp) + 1) * 1000));
    if (!(toMs >= fromMs)) { exclude("fill_precedes_inferred_arrival"); continue; }
    const index = indexAtOrBefore(ticks, Number(fire.intervalStartMs));
    if (index < 0) { exclude("missing_prearrival_book"); continue; }
    const book = synthesizeBinaryBooks(ticks[index]);
    const side = fire.outcome === "Up" ? book.up : book.down;
    const queueAhead = levelSize(side?.bids, Number(fire.limitPrice));
    const exactVolume = exactPriceVolume(market.trades, { outcome: fire.outcome, price: fire.limitPrice, fromMs, toMs });
    const metrics = captureMetrics({ targetShares, exactVolume, queueAhead });
    if (!metrics || !metrics.volumeConsistent) { exclude("market_volume_inconsistent"); continue; }
    prelim.push({
      orderHash: fire.orderHash, dataset: fire.dataset, slug, day: new Date(Number(slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10),
      outcome: fire.outcome, price: Number(exactCent(fire.limitPrice)), signedShares: Number(fire.signedShares),
      fromMs, toMs, lifeMs: toMs - fromMs, fireIntervalWidthMs: Number(fire.intervalWidthMs),
      targetFillTransactions: fills.length, ...metrics,
    });
  }
  processedSlugs++;
  if (processedSlugs % 100 === 0) console.error(JSON.stringify({ processedSlugs, totalSlugs: bySlug.size, candidates: prelim.length }));
}

const marked = markOverlappingIntervals(prelim);
const isolated = marked.filter((row) => !row.overlapsTargetOrder);
const queueConsistent = isolated.filter((row) => row.queueConsistent && row.postQueueCapture <= 1 + 1e-6);
const summarize = (rows) => {
  const targetShares = sum(rows, "targetShares"), exactVolume = sum(rows, "exactVolume"), postQueueVolume = sum(rows, "postQueueVolume");
  return {
    orders: rows.length,
    windows: new Set(rows.map((row) => row.slug)).size,
    utcDays: [...new Set(rows.map((row) => row.day))].sort(),
    targetShares: round(targetShares), exactPriceMarketVolume: round(exactVolume), postQueueMarketVolume: round(postQueueVolume),
    weightedRawCapture: exactVolume > 0 ? round(targetShares / exactVolume) : null,
    weightedPostQueueCapture: postQueueVolume > 0 ? round(targetShares / postQueueVolume) : null,
    windowClusterBootstrapRawLower95: round(bootstrapRatioLower95(rows, "targetShares", "exactVolume")),
    windowClusterBootstrapPostQueueLower95: round(bootstrapRatioLower95(rows, "targetShares", "postQueueVolume")),
    rawCaptureQuantiles: q(rows, "rawCapture"),
    postQueueCaptureQuantiles: q(rows.filter((row) => row.postQueueCapture != null), "postQueueCapture"),
    ordersRawCaptureAtLeast10Pct: rows.filter((row) => row.rawCapture >= .1).length,
    ordersRawCaptureAtLeast10PctRate: pct(rows.filter((row) => row.rawCapture >= .1).length, rows.length),
  };
};
const byDay = [...new Set(isolated.map((row) => row.day))].sort().map((day) => ({ day, ...summarize(isolated.filter((row) => row.day === day)) }));
const byDayQueueConsistent = [...new Set(queueConsistent.map((row) => row.day))].sort()
  .map((day) => ({ day, ...summarize(queueConsistent.filter((row) => row.day === day)) }));
const calibrationDates = [...new Set(queueConsistent.map((row) => row.day))].sort();
const chronologicalCalibrationFolds = Array.from({ length: 3 }, (_, index) => {
  const dates = calibrationDates.slice(Math.floor(index * calibrationDates.length / 3),
    Math.floor((index + 1) * calibrationDates.length / 3));
  return { index: index + 1, from: dates[0] || null, to: dates.at(-1) || null,
    ...summarize(queueConsistent.filter((row) => dates.includes(row.day))) };
});
const conditional = summarize(isolated), postQueue = summarize(queueConsistent);
const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  wallet: "0x3048d65321be3497164cdfc2996f94f98a2e7537",
  methodology: "conditional capture audit: high/medium v4-inferred maker-only resting orders; exact public target maker fill transaction/outcome/cent; exact normalized market-wide taker volume from inferred arrival through last fill; same-price overlapping target order lifetimes excluded; pre-arrival v4 queue reported separately",
  source: { datasets: DATASETS.map((row) => row.name), targetTradeRows: targetRows.length, inferredOrders: fires.length,
    eligibleRestOrders: eligibleFires.length, l2Windows: l2Files.size, marketTradeWindows: tradeFiles.size },
  exclusions: Object.fromEntries([...exclusions].sort()),
  matchedBeforeOverlapFilter: prelim.length,
  overlappingOrdersExcluded: marked.filter((row) => row.overlapsTargetOrder).length,
  conditionalIsolated: conditional,
  queueConsistentIsolated: postQueue,
  byDay,
  byDayQueueConsistent,
  chronologicalCalibrationFolds,
  assessment: {
    conditionalCaptureSupports10Pct: queueConsistent.length >= 1_000
      && postQueue.windowClusterBootstrapRawLower95 >= .1
      && chronologicalCalibrationFolds.every((fold) => fold.weightedRawCapture >= .1),
    unconditionalMakerCreditConfirmed: false,
    stableProfitConfirmed: false,
    reason: "public data reveals fills but not the wallet's unfilled/cancelled private orders; conditional capture cannot identify unconditional placement-to-fill probability",
  },
  observations: isolated,
};
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output: OUTPUT, source: result.source, exclusions: result.exclusions,
  matchedBeforeOverlapFilter: result.matchedBeforeOverlapFilter, overlappingOrdersExcluded: result.overlappingOrdersExcluded,
  conditionalIsolated: result.conditionalIsolated, queueConsistentIsolated: result.queueConsistentIsolated,
  assessment: result.assessment }, null, 2));
