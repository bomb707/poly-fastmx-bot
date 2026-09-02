#!/usr/bin/env node
// Populate the same settled, coherent V2 L2 cache consumed by live backview and
// strategy replay. Only windows reaching the runtime completeness gate are
// retained by src/sources/history.js.
import { config } from "../../src/config/config.js";
import { fetchWindowHistory, hasCompleteV2Coverage } from "../../src/sources/history.js";

const from = Date.parse(process.argv[2] || "2026-08-20T00:00:00Z") / 1_000;
const to = Date.parse(process.argv[3] || "2026-08-27T00:00:00Z") / 1_000;
const prefix = String(process.argv[4] || "btc-updown-5m");
const concurrency = Math.max(1, Math.min(16, Number(process.env.W75CC_V2_CONCURRENCY || 6)));
if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new Error("invalid from/to range");

config.winCache = true;
const queue = [];
for (let windowStart = Math.ceil(from / 300) * 300; windowStart < to; windowStart += 300) {
  queue.push({ windowStart, slug: `${prefix}-${windowStart}` });
}
let cursor = 0, done = 0, complete = 0, incomplete = 0, failed = 0;
const errors = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (true) {
    const index = cursor++;
    if (index >= queue.length) return;
    const item = queue[index];
    try {
      const data = await fetchWindowHistory(item.slug, { ticksOnly: true });
      if (data?.winSide && hasCompleteV2Coverage(data)) complete++;
      else incomplete++;
    } catch (error) {
      failed++;
      if (errors.length < 100) errors.push({ slug: item.slug, error: String(error?.message || error) });
    }
    done++;
    if (done % 50 === 0 || done === queue.length) {
      console.log(JSON.stringify({ phase: "v2-cache", done, total: queue.length, complete, incomplete, failed }));
    }
  }
}));

console.log(JSON.stringify({ schema: 1, from: new Date(from * 1_000).toISOString(),
  to: new Date(to * 1_000).toISOString(), prefix, concurrency,
  windows: queue.length, complete, incomplete, failed, errors }, null, 2));
if (failed) process.exitCode = 2;
