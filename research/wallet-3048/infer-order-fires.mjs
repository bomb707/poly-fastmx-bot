#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";
import { featuresAtFire, inferGroupedOrderFire } from "./order-fire.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const ordersFile = path.resolve(process.argv[3] || path.join(dataDir, "signed-orders.json.gz"));
const topDir = path.resolve(process.argv[4] || path.join(dataDir, "feeds/v4-top"));
const v2Dir = path.resolve(process.argv[5] || path.join(dataDir, "feeds/v2"));
const outputStem = String(process.argv[6] || "order-fires").replace(/[^a-zA-Z0-9._-]/g, "");
const orderbookSource = String(process.argv[7] || "v4");
const slugPrefix = String(process.env.W3048_SLUG_PREFIX || "").trim().toLowerCase();
const outputFile = path.join(dataDir, `${outputStem}.json.gz`);
const summaryFile = path.join(dataDir, `${outputStem}-summary.json`);
const orders = JSON.parse(zlib.gunzipSync(fs.readFileSync(ordersFile))).groups;
const bySlug = new Map();
for (const group of orders) {
  const slug = group.settlements[0]?.slug;
  if (!slug) continue;
  if (slugPrefix && !slug.toLowerCase().startsWith(slugPrefix)) continue;
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(group);
}
function readGzip(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); }
function readOptional(dir, slug) { try { return readGzip(path.join(dir, `${slug}.json.gz`)); } catch { return null; } }
const rows = [];
let windows = 0;
for (const slug of [...bySlug.keys()].sort()) {
  const feed = readOptional(topDir, slug);
  if (!feed) continue;
  windows++;
  const v2 = readOptional(v2Dir, slug);
  for (const group of bySlug.get(slug)) {
    const inference = inferGroupedOrderFire(feed.ticks, group);
    if (!inference) continue;
    // Causal feature snapshot: last observation at/before the START of the
    // inferred transition. The interval-end book can already contain our order.
    const feature = featuresAtFire(feed.ticks, inference.intervalStartMs, group, feed.openBinance, feed.openChainlink);
    const v2Feature = v2 ? featuresAtFire(v2.ticks, inference.intervalStartMs, group, v2.openBinance, v2.openChainlink) : null;
    rows.push({
      orderHash: group.orderHash,
      slug,
      outcome: group.settlements[0].outcome,
      limitPrice: group.limitPrice,
      signedShares: group.signedShares,
      signedBudgetUsd: group.signedBudgetUsd,
      signedTimestampMs: group.signedTimestampMs,
      firstPublicTs: group.firstPublicTs,
      lastPublicTs: group.lastPublicTs,
      settlementRoles: group.settlementRoles,
      settlements: group.settlements.length,
      filledShares: group.filledShares,
      ...inference,
      feature,
      v2Feature,
    });
  }
  if (windows % 250 === 0) console.log(`order-fire inference: ${windows}/${bySlug.size} windows, ${rows.length} orders`);
}

const nums = (selector, filter = () => true) => rows.filter(filter).map(selector).filter(Number.isFinite);
const qs = (values) => Object.fromEntries([[0, 0], [.1, .1], [.25, .25], [.5, .5], [.75, .75], [.9, .9], [.99, .99], [1, 1]]
  .map(([name, probability]) => [`p${Math.round(name * 100)}`, quantile(values, probability)]));
const countBy = (selector) => {
  const result = {};
  for (const row of rows) { const key = selector(row); result[key] = (result[key] || 0) + 1; }
  return result;
};
const highMedium = (row) => row.confidence !== "low";
const clusters = [];
for (const [slug, slugRows] of [...rows.reduce((map, row) => {
  if (!map.has(row.slug)) map.set(row.slug, []);
  map.get(row.slug).push(row);
  return map;
}, new Map())]) {
  const sorted = slugRows.filter(highMedium).sort((a, b) => a.fireMs - b.fireMs);
  let cluster = null;
  for (const row of sorted) {
    if (!cluster || row.fireMs - cluster.lastMs > 300) {
      cluster = { slug, firstMs: row.fireMs, lastMs: row.fireMs, orders: [] };
      clusters.push(cluster);
    }
    cluster.lastMs = row.fireMs;
    cluster.orders.push(row.orderHash);
  }
}
const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  orderbookSource,
  slugPrefix: slugPrefix || null,
  sourceOrders: orders.length,
  sourceWindows: bySlug.size,
  v4Windows: windows,
  inferredOrders: rows.length,
  confidence: countBy((row) => row.confidence),
  method: countBy((row) => row.method),
  highMediumOrders: rows.filter(highMedium).length,
  leadMsHighMedium: qs(nums((row) => row.leadMs, highMedium)),
  intervalWidthMsHighMedium: qs(nums((row) => row.intervalWidthMs, highMedium)),
  scoreHighMedium: qs(nums((row) => row.score, highMedium)),
  fireClusters300ms: clusters.length,
  ordersPerFireCluster: qs(clusters.map((cluster) => cluster.orders.length)),
  multiOrderFireClusters: clusters.filter((cluster) => cluster.orders.length > 1).length,
  signedTimestampErrorMs: qs(nums((row) => row.fireMs - row.signedTimestampMs, highMedium)),
  v2FeatureOrders: rows.filter((row) => row.v2Feature).length,
  note: `fireMs is selected from a ${orderbookSource} order-book transition; signedTimestampMs is only a causal construction lower bound with 250ms clock slack, and on-chain block time is never used`,
  featureNote: "feature/v2Feature are evaluated at intervalStartMs, before the inferred order-book transition",
};
fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify({ schema: 1, summary, rows }), { level: 9 }));
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outputFile}`);
