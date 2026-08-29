#!/usr/bin/env node
/** Convert existing v4 full-depth caches to the compact Lockstep format. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const FROM_MS = Date.parse(process.argv[2] || "2026-08-14T00:00:00Z");
const TO_MS = Date.parse(process.argv[3] || "2026-08-25T00:00:00Z");
const OUT = path.resolve(process.env.LOCKSTEP_V4_CACHE || path.join(ROOT, "data/lockstep-v4-top"));
const SOURCES = String(process.env.LOCKSTEP_V4_SOURCE_DIRS || [
  path.join(ROOT, "data/wallet-3048/feeds/v4-top"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-r2-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-e8-l2"),
  path.join(ROOT, "data/wallet-3048/feeds/v4-l2"),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");
fs.mkdirSync(OUT, { recursive: true });
const slugStart = (slug) => Number(String(slug).split("-").at(-1)) * 1000;

function top(raw, targetDepth = 80, maxLevels = 12) {
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) return raw.slice(0, maxLevels * 2).map(Number);
  const rows = (raw?.asks || []).map((level) => [Number(level.price), Number(level.size)])
    .filter((level) => level[0] >= .01 && level[0] <= .99 && level[1] > 0).sort((a, b) => a[0] - b[0]);
  const out = [];
  let depth = 0;
  for (const [price, size] of rows) {
    out.push(price, size);
    depth += size;
    if ((depth >= targetDepth && out.length >= 6) || out.length >= maxLevels * 2) break;
  }
  return out;
}
function compact(raw) {
  const startMs = slugStart(raw.slug);
  const ticks = [];
  let pending = null, bucket = null, prior = null;
  for (const source of raw.ticks || []) {
    const ms = Number(source.ms ?? Date.parse(source.time || ""));
    const bz = Number(source.bz ?? source.binanceSpotPrice);
    const up = top(source.up || { asks: source.upAsks });
    const down = top(source.down || { asks: source.downAsks });
    if (!Number.isFinite(ms) || !Number.isFinite(bz) || !up.length || !down.length) continue;
    const tick = { ms, bz, up, down };
    const nextBucket = Math.floor((ms - startMs) / 120);
    const changed = !prior || bz !== prior.bz || up[0] !== prior.up[0] || down[0] !== prior.down[0];
    if (bucket != null && nextBucket !== bucket && pending) { ticks.push(pending); pending = null; }
    if (changed) { if (pending) ticks.push(pending); ticks.push(tick); }
    else pending = tick;
    bucket = nextBucket;
    prior = tick;
  }
  if (pending) ticks.push(pending);
  return { slug: raw.slug, openBinance: Number(raw.openBinance ?? raw.binanceSpotPriceStart), openChainlink: Number(raw.openChainlink ?? raw.coinPriceStart), winner: raw.winner, ticks };
}

const files = new Map();
for (const dir of SOURCES) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json.gz")) continue;
    const slug = name.slice(0, -8), start = slugStart(slug);
    if (start >= FROM_MS && start < TO_MS && !files.has(slug)) files.set(slug, path.join(dir, name));
  }
}
let done = 0, written = 0, cached = 0, failed = 0;
for (const [slug, source] of files) {
  const target = path.join(OUT, `${slug}.json.gz`);
  if (fs.existsSync(target)) cached++;
  else {
    try {
      const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(source)));
      fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(compact(raw)), { level: 5 }));
      written++;
    } catch { failed++; }
  }
  done++;
  if (done % 250 === 0 || done === files.size) console.log(JSON.stringify({ done, total: files.size, written, cached, failed }));
}
