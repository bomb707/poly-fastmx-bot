#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";
import { inferCancelBeforeReplacement } from "./order-fire.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const feedDir = path.resolve(process.argv[3] || path.join(dataDir, "feeds/v4-top"));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const signedByHash = new Map(signed.map((group) => [group.orderHash, group]));
const bySlug = new Map();
for (const row of fires.filter((row) => row.confidence !== "low")) {
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}
const readFeed = (slug) => {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${slug}.json.gz`)))); }
  catch { return null; }
};
const results = [];
let candidates = 0;
for (const [slug, rows] of bySlug) {
  rows.sort((a, b) => a.fireMs - b.fireMs);
  let feed = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], group = signedByHash.get(row.orderHash);
    if (!group?.settlementRoles?.includes("maker")) continue;
    const remainingShares = Math.max(0, Number(group.signedShares) - Number(group.filledShares));
    if (remainingShares < 1) continue;
    const replacement = rows.slice(index + 1).find((next) => next.outcome === row.outcome && next.fireMs - row.fireMs <= 30_000);
    if (!replacement) continue;
    candidates++;
    if (!feed) feed = readFeed(slug);
    if (!feed) continue;
    const inference = inferCancelBeforeReplacement(feed.ticks, { ...row, settlements: group.settlements }, replacement, remainingShares);
    if (!inference) continue;
    results.push({
      slug,
      orderHash: row.orderHash,
      replacementHash: replacement.orderHash,
      outcome: row.outcome,
      oldLimit: row.limitPrice,
      newLimit: replacement.limitPrice,
      signedShares: row.signedShares,
      filledShares: group.filledShares,
      remainingShares,
      fireMs: row.fireMs,
      replacementFireMs: replacement.fireMs,
      ...inference,
    });
  }
}
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const q = (values) => Object.fromEntries([0, .1, .25, .5, .75, .9, .99, 1].map((probability) => [
  `p${Math.round(probability * 100)}`,
  quantile(values.filter(finite), probability),
]));
const highMedium = results.filter((row) => row.confidence !== "low");
const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  candidates,
  inferred: results.length,
  confidence: Object.fromEntries(["high", "medium", "low"].map((confidence) => [confidence, results.filter((row) => row.confidence === confidence).length])),
  highMedium: highMedium.length,
  cancelLifeMs: q(highMedium.map((row) => row.lifeMs)),
  cancelToReplacementMs: q(highMedium.map((row) => row.replacementLagMs)),
  removedVsRemainingRatio: q(highMedium.map((row) => row.depthRemoved / row.remainingShares)),
  priceChange: q(highMedium.map((row) => Number(row.newLimit) - Number(row.oldLimit))),
  sameLimitPct: highMedium.length ? highMedium.filter((row) => Math.abs(Number(row.newLimit) - Number(row.oldLimit)) < .005).length / highMedium.length * 100 : null,
  note: "high/medium requires an old-cap bid-depth removal close to the exact unfilled signed remainder, followed by the next same-side signed order",
};
fs.writeFileSync(path.join(dataDir, "cancel-replacements.json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, summary, rows: results }), { level: 9 }));
fs.writeFileSync(path.join(dataDir, "cancel-replacements-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
