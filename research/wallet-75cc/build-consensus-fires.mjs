#!/usr/bin/env node
// Keep only exact orders whose independently inferred native V2 and V4 fire
// intervals agree. This avoids selecting an optimistic transition from either
// source and never uses block/public timestamps as the fire time.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const v2File = path.resolve(process.argv[2] || "data/wallet-75cc/order-fires-v2-l2-aug25.json.gz");
const v4File = path.resolve(process.argv[3] || "data/wallet-75cc/order-fires-v4-l2-aug25.json.gz");
const outputFile = path.resolve(process.argv[4] || "data/wallet-75cc/order-fires-v2-v4-consensus-aug25.json.gz");
const toleranceMs = Number(process.argv[5] || 250);
const read = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const v2 = read(v2File).rows, v4 = read(v4File).rows;
const v4ByHash = new Map(v4.map((row) => [row.orderHash, row]));
const usable = (row) => row && row.confidence !== "low";
const rows = [];
for (const left of v2) {
  const right = v4ByHash.get(left.orderHash);
  if (!usable(left) || !usable(right)) continue;
  const overlapStartMs = Math.max(Number(left.intervalStartMs), Number(right.intervalStartMs));
  const overlapEndMs = Math.min(Number(left.intervalEndMs), Number(right.intervalEndMs));
  const overlapMs = Math.max(0, overlapEndMs - overlapStartMs);
  const fireDeltaMs = Number(left.fireMs) - Number(right.fireMs);
  if (!overlapMs && Math.abs(fireDeltaMs) > toleranceMs) continue;
  const consensusFireMs = overlapMs
    ? Math.round((overlapStartMs + overlapEndMs) / 2)
    : Math.round((Number(left.fireMs) + Number(right.fireMs)) / 2);
  rows.push({
    ...left,
    fireMs: consensusFireMs,
    intervalStartMs: overlapMs ? overlapStartMs : Math.min(Number(left.intervalStartMs), Number(right.intervalStartMs)),
    intervalEndMs: overlapMs ? overlapEndMs : Math.max(Number(left.intervalEndMs), Number(right.intervalEndMs)),
    intervalWidthMs: overlapMs || Math.abs(fireDeltaMs),
    confidence: left.confidence === "high" && right.confidence === "high" ? "high" : "medium",
    consensus: { v2FireMs: left.fireMs, v4FireMs: right.fireMs, fireDeltaMs, overlapMs,
      v2Confidence: left.confidence, v4Confidence: right.confidence, v2Score: left.score, v4Score: right.score },
  });
}
const summary = {
  schema: 1, generatedAt: new Date().toISOString(), inputs: { v2File, v4File }, toleranceMs,
  v2Orders: v2.length, v4Orders: v4.length, consensusOrders: rows.length,
  btcOrders: rows.filter((row) => row.slug.startsWith("btc-")).length,
  definition: "high/medium in both native sources and intervals overlap or absolute fire delta <= tolerance; consensus fire is overlap midpoint or mean fire",
};
fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify({ schema: 1, summary, rows }), { level: 9 }));
fs.writeFileSync(outputFile.replace(/\.json\.gz$/i, "-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
