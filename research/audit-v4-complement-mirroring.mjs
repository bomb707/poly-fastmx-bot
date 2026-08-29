#!/usr/bin/env node
/** Verify that v4 exposes economically equivalent asks/bids as one mirrored queue. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, "data/research/v4-complement-mirroring-audit.json"));
const DIRS = [
  "data/wallet-3048/feeds/v4-e8-l2",
  "data/wallet-3048/feeds/v4-r2-l2",
  "data/wallet-3048-r3/feeds/v4-l2",
  "data/wallet-3048/feeds/v4-l2",
  "data/wallet-3048-r4/feeds/v4-l2",
].map((dir) => path.join(ROOT, dir));

const files = new Map();
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) if (name.endsWith(".json.gz") && !files.has(name)) files.set(name, path.join(dir, name));
}
const levels = (rows) => (rows || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
  .filter((row) => row.price > 0 && row.price < 1 && row.size > 0);

let ticks = 0, totalLevels = 0, priceMirrors = 0, sizeMirrors = 0, malformedFiles = 0;
const mismatches = [];
for (const [name, file] of files) {
  let payload;
  try { payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); }
  catch { malformedFiles++; continue; }
  for (const tick of payload.ticks || []) {
    if (!tick.up || !tick.down) continue;
    ticks++;
    for (const [left, right] of [
      [levels(tick.up.asks), levels(tick.down.bids)],
      [levels(tick.up.bids), levels(tick.down.asks)],
    ]) {
      const complements = new Map(right.map((row) => [(1 - row.price).toFixed(4), row]));
      totalLevels += left.length;
      for (const row of left) {
        const mirror = complements.get(row.price.toFixed(4));
        if (!mirror) {
          if (mismatches.length < 20) mismatches.push({ name, kind: "missing-price", price: row.price, size: row.size });
          continue;
        }
        priceMirrors++;
        if (Math.abs(row.size - mirror.size) <= 1e-6) sizeMirrors++;
        else if (mismatches.length < 20) mismatches.push({ name, kind: "size", price: row.price, size: row.size, mirrorSize: mirror.size });
      }
    }
  }
}

const report = {
  schema: 1, generatedAt: new Date().toISOString(), files: files.size, malformedFiles, ticks, totalLevels,
  priceMirrors, sizeMirrors,
  priceMirrorPct: totalLevels ? 100 * priceMirrors / totalLevels : 0,
  sizeMirrorPct: totalLevels ? 100 * sizeMirrors / totalLevels : 0,
  mismatches,
  passed: malformedFiles === 0 && totalLevels > 0 && priceMirrors === totalLevels && sizeMirrors === totalLevels,
};
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
