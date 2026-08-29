#!/usr/bin/env node

import { createGunzip } from 'node:zlib';
import { createReadStream, writeFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.argv[2] || 'data/wallet-3048-r5');
const v2Path = path.resolve(process.argv[3] || path.join(dataDir, 'order-fires-v2.json.gz'));
const v4Path = path.resolve(process.argv[4] || path.join(dataDir, 'order-fires.json.gz'));
const outputStem = path.resolve(process.argv[5] || path.join(dataDir, 'fire-source-comparison'));

function readGzipJson(file) {
  return new Promise((resolve, reject) => {
    let raw = '';
    createReadStream(file)
      .pipe(createGunzip())
      .on('data', (chunk) => { raw += chunk; })
      .on('error', reject)
      .on('end', () => resolve(JSON.parse(raw)));
  });
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function stats(values) {
  const clean = values.filter(Number.isFinite);
  return {
    n: clean.length,
    p0: quantile(clean, 0),
    p10: quantile(clean, 0.1),
    p25: quantile(clean, 0.25),
    p50: quantile(clean, 0.5),
    p75: quantile(clean, 0.75),
    p90: quantile(clean, 0.9),
    p95: quantile(clean, 0.95),
    p99: quantile(clean, 0.99),
    p100: quantile(clean, 1),
  };
}

function pct(n, d) {
  return d ? Number((100 * n / d).toFixed(3)) : null;
}

function highMedium(row) {
  return row?.confidence === 'high' || row?.confidence === 'medium';
}

const [v2Document, v4Document] = await Promise.all([readGzipJson(v2Path), readGzipJson(v4Path)]);
const v2Rows = v2Document.rows || v2Document;
const v4Rows = v4Document.rows || v4Document;
const v2ByHash = new Map(v2Rows.map((row) => [row.orderHash, row]));
const v4ByHash = new Map(v4Rows.map((row) => [row.orderHash, row]));
const hashes = [...new Set([...v2ByHash.keys(), ...v4ByHash.keys()])];

const joined = [];
for (const orderHash of hashes) {
  const v2 = v2ByHash.get(orderHash);
  const v4 = v4ByHash.get(orderHash);
  if (!v2 || !v4) continue;
  const deltaMs = v2.fireMs - v4.fireMs;
  const overlapMs = Math.max(0, Math.min(v2.intervalEndMs, v4.intervalEndMs)
    - Math.max(v2.intervalStartMs, v4.intervalStartMs));
  joined.push({
    orderHash,
    slug: v2.slug,
    outcome: v2.outcome,
    limitPrice: v2.limitPrice,
    signedShares: v2.signedShares,
    v2Confidence: v2.confidence,
    v4Confidence: v4.confidence,
    v2Method: v2.method,
    v4Method: v4.method,
    v2FireMs: v2.fireMs,
    v4FireMs: v4.fireMs,
    deltaMs,
    absoluteDeltaMs: Math.abs(deltaMs),
    intervalOverlapMs: overlapMs,
    intervalsOverlap: overlapMs > 0,
    sameMethod: v2.method === v4.method,
    sameBeforeBestAsk: v2.beforeBestAsk === v4.beforeBestAsk,
    bothHighMedium: highMedium(v2) && highMedium(v4),
  });
}

const bothHm = joined.filter((row) => row.bothHighMedium);
const consensus250 = bothHm.filter((row) => row.intervalsOverlap || row.absoluteDeltaMs <= 250);
const consensus500 = bothHm.filter((row) => row.intervalsOverlap || row.absoluteDeltaMs <= 500);
const within = (rows, ms) => rows.filter((row) => row.absoluteDeltaMs <= ms).length;

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  inputs: { v2: v2Path, v4: v4Path },
  v2Orders: v2Rows.length,
  v4Orders: v4Rows.length,
  joinedOrders: joined.length,
  missingFromV2: hashes.filter((hash) => !v2ByHash.has(hash)).length,
  missingFromV4: hashes.filter((hash) => !v4ByHash.has(hash)).length,
  allJoined: {
    fireDeltaV2MinusV4Ms: stats(joined.map((row) => row.deltaMs)),
    absoluteFireDeltaMs: stats(joined.map((row) => row.absoluteDeltaMs)),
    within50Ms: pct(within(joined, 50), joined.length),
    within100Ms: pct(within(joined, 100), joined.length),
    within250Ms: pct(within(joined, 250), joined.length),
    within500Ms: pct(within(joined, 500), joined.length),
    within1000Ms: pct(within(joined, 1000), joined.length),
    intervalsOverlap: pct(joined.filter((row) => row.intervalsOverlap).length, joined.length),
    methodAgreement: pct(joined.filter((row) => row.sameMethod).length, joined.length),
    beforeBestAskAgreement: pct(joined.filter((row) => row.sameBeforeBestAsk).length, joined.length),
  },
  bothHighMedium: {
    orders: bothHm.length,
    shareOfJoinedPct: pct(bothHm.length, joined.length),
    fireDeltaV2MinusV4Ms: stats(bothHm.map((row) => row.deltaMs)),
    absoluteFireDeltaMs: stats(bothHm.map((row) => row.absoluteDeltaMs)),
    within50Ms: pct(within(bothHm, 50), bothHm.length),
    within100Ms: pct(within(bothHm, 100), bothHm.length),
    within250Ms: pct(within(bothHm, 250), bothHm.length),
    within500Ms: pct(within(bothHm, 500), bothHm.length),
    within1000Ms: pct(within(bothHm, 1000), bothHm.length),
    intervalsOverlap: pct(bothHm.filter((row) => row.intervalsOverlap).length, bothHm.length),
    methodAgreement: pct(bothHm.filter((row) => row.sameMethod).length, bothHm.length),
    beforeBestAskAgreement: pct(bothHm.filter((row) => row.sameBeforeBestAsk).length, bothHm.length),
  },
  conservativeConsensus: {
    within250MsOrIntervalOverlap: consensus250.length,
    within250MsOrIntervalOverlapPct: pct(consensus250.length, bothHm.length),
    within500MsOrIntervalOverlap: consensus500.length,
    within500MsOrIntervalOverlapPct: pct(consensus500.length, bothHm.length),
  },
  interpretation: [
    'Both sources are native order-book histories; neither source is relabeled as a top-of-book control.',
    'On-chain timestamps are excluded from fire-time inference.',
    'A source-consensus event requires high/medium confidence in both feeds plus interval overlap or a bounded fire-time difference.',
  ],
};

writeFileSync(`${outputStem}.json`, `${JSON.stringify({ summary, rows: joined }, null, 2)}\n`);
const hm = summary.bothHighMedium;
const md = `# v2 versus v4 order-fire inference\n\n`
  + `Generated: ${summary.generatedAt}\n\n`
  + `- v2 inferred orders: **${summary.v2Orders}**\n`
  + `- v4 inferred orders: **${summary.v4Orders}**\n`
  + `- joined signed orders: **${summary.joinedOrders}**\n`
  + `- high/medium in both sources: **${hm.orders}** (${hm.shareOfJoinedPct}%)\n`
  + `- median v2 - v4 fire time: **${hm.fireDeltaV2MinusV4Ms.p50} ms**\n`
  + `- median absolute fire difference: **${hm.absoluteFireDeltaMs.p50} ms**\n`
  + `- within 100 / 250 / 500 ms: **${hm.within100Ms}% / ${hm.within250Ms}% / ${hm.within500Ms}%**\n`
  + `- execution-method agreement: **${hm.methodAgreement}%**\n`
  + `- pre-fire best-ask agreement: **${hm.beforeBestAskAgreement}%**\n`
  + `- conservative 250 ms consensus events: **${summary.conservativeConsensus.within250MsOrIntervalOverlap}** (${summary.conservativeConsensus.within250MsOrIntervalOverlapPct}% of dual-confidence events)\n\n`
  + `The comparison uses the same exact signed order hash in both histories. On-chain placement time is not used.\n`;
writeFileSync(`${outputStem}.md`, md);

console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outputStem}.json and ${outputStem}.md`);
