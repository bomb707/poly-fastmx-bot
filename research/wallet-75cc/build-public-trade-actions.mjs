#!/usr/bin/env node
// Build coarse action groups from the public Data API when fresh signed-order
// inference is not yet available. Public timestamps have one-second resolution,
// so this dataset is suitable for forward direction checks, not release timing.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const input = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
if (!input || !output) throw new Error("usage: build-public-trade-actions.mjs INPUT.json OUTPUT.json.gz");
const source = JSON.parse(fs.readFileSync(input, "utf8"));
const grouped = new Map();
for (const trade of source.trades || []) {
  if (String(trade.action).toUpperCase() !== "BUY") continue;
  const fireMs = Number(trade.timestamp) * 1000;
  const key = [trade.slug, trade.outcome, fireMs].join(":");
  let row = grouped.get(key);
  if (!row) {
    row = { slug: trade.slug, outcome: trade.outcome, fireMs,
      intervalStartMs: fireMs, intervalEndMs: fireMs, exactOrders: 0,
      orderHashes: [], signedSizes: [], signedShares: 0, filledShares: 0,
      weightedCost: 0, methods: ["public-data-api"], contains90: false,
      containsLarge: false, role: "unknown", decisionMs: fireMs - 520,
      decisionLatencyMs: 520, beforeImbalance: null, afterImbalance: null };
    grouped.set(key, row);
  }
  row.exactOrders++;
  row.orderHashes.push(String(trade.transactionHash || ""));
  row.signedSizes.push(Number(trade.size));
  row.signedShares += Number(trade.size);
  row.filledShares += Number(trade.size);
  row.weightedCost += Number(trade.size) * Number(trade.price);
}
const rows = [...grouped.values()].sort((a, b) => a.fireMs - b.fireMs || a.slug.localeCompare(b.slug));
for (const row of rows) {
  row.effectivePrice = row.filledShares > 0 ? row.weightedCost / row.filledShares : null;
  delete row.weightedCost;
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, zlib.gzipSync(JSON.stringify({ schema: 1,
  orderbookSource: "public Data API second-resolution trade time", rows }), { level: 9 }));
console.log(JSON.stringify({ input, output, trades: source.trades?.length || 0, actions: rows.length,
  markets: new Set(rows.map((row) => row.slug)).size }));
