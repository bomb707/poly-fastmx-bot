#!/usr/bin/env node
// Historical, causal audit of BTC dollar-gap persistence for Polymarket BTC 5m.
// Resolution is used only as the later label. Each observation uses the latest
// coherent snapshot at or before a fixed checkpoint in the five-minute window.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fillFee } from "../../engine/fees.js";

const root = path.resolve(import.meta.dirname, "../..");
const startMs = Date.parse(process.argv[2] || "2026-08-14T00:00:00Z");
const endMs = Date.parse(process.argv[3] || "2026-09-03T12:00:00Z");
const cacheDir = path.resolve(process.argv[4] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[5]
  || path.join(root, "research/wallet-75cc/results/session-dollar-gap-reversal-2026-09-03.json"));
if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) {
  throw new Error("usage: node analyze-session-dollar-gap-reversal.mjs [start-ISO] [end-ISO] [cache-dir] [output-json]");
}

const CHECKPOINTS_S = [60, 120, 180, 240, 270];
const GAP_BUCKETS = [[0, 10], [10, 20], [20, 50], [50, 100], [100, 150], [150, Infinity]];
const SESSION_BINS = [
  { id: "utc00_04", start: 0, end: 4, label: "Asia morning / US evening" },
  { id: "utc04_08", start: 4, end: 8, label: "Asia afternoon / US midnight" },
  { id: "utc08_12", start: 8, end: 12, label: "Europe morning / US premarket" },
  { id: "utc12_16", start: 12, end: 16, label: "US morning" },
  { id: "utc16_20", start: 16, end: 20, label: "US afternoon" },
  { id: "utc20_24", start: 20, end: 24, label: "US evening / Asia open" },
];
const SPLIT_MS = Date.parse("2026-08-27T00:00:00Z");
const finite = (input) => input != null && input !== "" && Number.isFinite(Number(input));
const round = (input, digits = 4) => finite(input) ? +Number(input).toFixed(digits) : null;
const sideFor = (gap) => Number(gap) >= 0 ? "Up" : "Down";
const bucketFor = (gap) => GAP_BUCKETS.find(([low, high]) => Math.abs(gap) >= low && Math.abs(gap) < high);
const bucketId = ([low, high]) => `${low}-${Number.isFinite(high) ? high : "plus"}`;
const sessionFor = (windowMs) => {
  const hour = new Date(windowMs).getUTCHours();
  return SESSION_BINS.find((session) => hour >= session.start && hour < session.end);
};
const midpoint = (tick, side) => {
  const book = side === "Up" ? tick?.up : tick?.down;
  const ask = Number(book?.bestAsk ?? (side === "Up" ? tick?.upAsk : tick?.dnAsk));
  const bid = Number(book?.bestBid ?? (side === "Up" ? tick?.upBid : tick?.dnBid));
  return ask > 0 && bid > 0 ? (ask + bid) / 2 : null;
};
const askFor = (tick, side) => Number(side === "Up"
  ? tick?.up?.bestAsk ?? tick?.upAsk : tick?.down?.bestAsk ?? tick?.dnAsk);

function latestAtOrBefore(ticks, checkpointS) {
  let answer = null;
  for (const tick of ticks) {
    if (Number(tick.t) <= checkpointS + 1e-9) answer = tick;
    else break;
  }
  return answer && checkpointS - Number(answer.t) <= 2.5 ? answer : null;
}

function activityRange30(ticks, checkpointS) {
  const mids = ticks.filter((tick) => Number(tick.t) >= checkpointS - 30
    && Number(tick.t) <= checkpointS).map((tick) => midpoint(tick, "Up")).filter(finite).map(Number);
  return mids.length >= 2 ? Math.max(...mids) - Math.min(...mids) : null;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return [null, null];
  const p = successes / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [round(100 * Math.max(0, center - margin), 2), round(100 * Math.min(1, center + margin), 2)];
}

function summarize(selected, gapField) {
  const valid = selected.filter((row) => finite(row[gapField]) && bucketFor(row[gapField]));
  let correct = 0, priced = 0, askSum = 0, pnl = 0, agreement = 0;
  for (const row of valid) {
    const side = sideFor(row[gapField]), won = side === row.winner;
    correct += Number(won);
    agreement += Number(side === sideFor(row.twapGapUsd));
    const ask = askFor(row.tick, side);
    if (ask > 0 && ask < 1) {
      priced++; askSum += ask;
      pnl += Number(won) - ask - fillFee(ask, 1, true);
    }
  }
  const reversals = valid.length - correct, interval = wilson(reversals, valid.length);
  return {
    observations: valid.length,
    correctPct: round(100 * correct / Math.max(1, valid.length), 2),
    reversalPct: round(100 * reversals / Math.max(1, valid.length), 2),
    reversalWilson95Pct: interval,
    twapDirectionAgreementPct: round(100 * agreement / Math.max(1, valid.length), 2),
    pricedObservations: priced,
    averageLeaderAsk: round(askSum / Math.max(1, priced), 4),
    realizedPnlPerShare: round(pnl / Math.max(1, priced), 4),
  };
}

function byBuckets(selected, gapField) {
  return Object.fromEntries(GAP_BUCKETS.map((bucket) => [bucketId(bucket),
    summarize(selected.filter((row) => bucketFor(row[gapField]) === bucket), gapField)]));
}

const files = fs.readdirSync(cacheDir).map((file) => {
  const match = file.match(/^btc-updown-5m-(\d+)_v2-l2-120-coherent\.json\.gz$/);
  return match ? { file, windowMs: Number(match[1]) * 1_000 } : null;
}).filter((row) => row && row.windowMs >= startMs && row.windowMs < endMs)
  .sort((left, right) => left.windowMs - right.windowMs);

const rows = [];
let invalid = 0, resolutionMismatches = 0;
for (const { file, windowMs } of files) {
  let feed;
  try { feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, file)))); }
  catch { invalid++; continue; }
  const openBinance = Number(feed.openBinance), openChainlink = Number(feed.openPrice ?? feed.openChainlink);
  const ticks = Array.isArray(feed.ticks) ? feed.ticks : [];
  if (!['Up', 'Down'].includes(feed.winSide) || !(openBinance > 0 && openChainlink > 0) || ticks.length < 2) {
    invalid++; continue;
  }
  if (finite(feed.finalPrice) && sideFor(Number(feed.finalPrice) - openChainlink) !== feed.winSide) {
    resolutionMismatches++;
  }
  const session = sessionFor(windowMs);
  for (const checkpointS of CHECKPOINTS_S) {
    const tick = latestAtOrBefore(ticks, checkpointS);
    if (!tick || !(Number(tick.bz) > 0 && Number(tick.cl) > 0)) continue;
    rows.push({
      slug: file.replace(/_v2-l2-120-coherent\.json\.gz$/, ""),
      windowMs,
      day: new Date(windowMs).toISOString().slice(0, 10),
      checkpointS,
      secondsLeft: 300 - checkpointS,
      segment: windowMs < SPLIT_MS ? "early" : "late",
      sessionId: session.id,
      sessionLabel: session.label,
      winner: feed.winSide,
      binanceOwnGapUsd: Number(tick.bz) - openBinance,
      settlementReferenceGapUsd: Number(tick.bz) - openChainlink,
      twapGapUsd: Number(tick.cl) - openChainlink,
      clobRange30: activityRange30(ticks, checkpointS),
      tick,
    });
  }
}

const activityMedian = [...rows].map((row) => row.clobRange30).filter(finite).sort((a, b) => a - b);
const medianActivity = activityMedian[Math.floor(activityMedian.length / 2)] ?? null;
for (const row of rows) row.activity = row.clobRange30 >= medianActivity ? "high" : "low";

const definitions = {
  binanceOwnGapUsd: "Binance snapshot minus Binance boundary open",
  settlementReferenceGapUsd: "Binance snapshot minus Chainlink TWAP-60 opening reference",
  twapGapUsd: "current Chainlink TWAP-60 stream value minus its opening reference",
  reversal: "the side implied by the causal gap at the checkpoint differs from the eventual market winner",
  activity: `high/low split of trailing-30s Up-token midpoint range at the sample median ${round(medianActivity, 4)}`,
};
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() },
  source: cacheDir,
  files: { considered: files.length, invalid, usable: new Set(rows.map((row) => row.slug)).size },
  checkpointsS: CHECKPOINTS_S,
  observations: rows.length,
  resolutionMismatches,
  definitions,
  overallByCheckpoint: Object.fromEntries(CHECKPOINTS_S.map((checkpoint) => [checkpoint, {
    binanceOwnOpen: byBuckets(rows.filter((row) => row.checkpointS === checkpoint), "binanceOwnGapUsd"),
    settlementReferenceOpen: byBuckets(rows.filter((row) => row.checkpointS === checkpoint), "settlementReferenceGapUsd"),
    chainlinkTwap: byBuckets(rows.filter((row) => row.checkpointS === checkpoint), "twapGapUsd"),
  }])),
  sessionAt180: Object.fromEntries(SESSION_BINS.map((session) => [session.id, {
    label: session.label,
    settlementReferenceOpen: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.sessionId === session.id), "settlementReferenceGapUsd"),
    chainlinkTwap: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.sessionId === session.id), "twapGapUsd"),
  }])),
  stabilityAt180: Object.fromEntries(["early", "late"].map((segment) => [segment, {
    range: segment === "early" ? "before 2026-08-27" : "2026-08-27 onward",
    settlementReferenceOpen: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.segment === segment), "settlementReferenceGapUsd"),
    chainlinkTwap: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.segment === segment), "twapGapUsd"),
  }])),
  activityAt180: Object.fromEntries(["low", "high"].map((activity) => [activity, {
    settlementReferenceOpen: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.activity === activity), "settlementReferenceGapUsd"),
    chainlinkTwap: byBuckets(rows.filter((row) => row.checkpointS === 180
      && row.activity === activity), "twapGapUsd"),
  }])),
  agreementAt180: Object.fromEntries(["agree", "disagree"].map((agreement) => [agreement, {
    settlementReferenceOpen: byBuckets(rows.filter((row) => row.checkpointS === 180
      && (sideFor(row.settlementReferenceGapUsd) === sideFor(row.twapGapUsd)) === (agreement === "agree")),
    "settlementReferenceGapUsd"),
  }])),
  dailyAt180: Object.fromEntries([...new Set(rows.map((row) => row.day))].map((day) => [day, {
    gap50To100: summarize(rows.filter((row) => row.checkpointS === 180 && row.day === day
      && Math.abs(row.settlementReferenceGapUsd) >= 50
      && Math.abs(row.settlementReferenceGapUsd) < 100), "settlementReferenceGapUsd"),
    gap100Plus: summarize(rows.filter((row) => row.checkpointS === 180 && row.day === day
      && Math.abs(row.settlementReferenceGapUsd) >= 100), "settlementReferenceGapUsd"),
  }])),
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, range: report.range, files: report.files,
  observations: report.observations, resolutionMismatches,
  at180SettlementGap: report.overallByCheckpoint[180].settlementReferenceOpen,
  at180TwapGap: report.overallByCheckpoint[180].chainlinkTwap }, null, 2));
