// Accumulate wallet 0x3048 fills over time (/activity caps at 500 recent). Dedups + appends JSONL.
// Usage: node research/wallet-3048-poll.mjs <outfile> [durationSec=1500] [pollSec=20]
import { config } from "../src/config/config.js";
import { getJson } from "../src/util/util.js";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const OUT = process.argv[2]; const DUR = (+process.argv[3] || 1500) * 1000; const POLL = (+process.argv[4] || 20) * 1000;
if (!OUT) { console.log("need outfile"); process.exit(1); }
const W = "0x3048d65321be3497164cdfc2996f94f98a2e7537";
const key = (a) => `${a.transactionHash}:${a.asset}:${a.side}:${a.type}:${a.timestamp}:${a.size}`;
const seen = new Set();
if (existsSync(OUT)) for (const l of readFileSync(OUT, "utf8").split("\n")) { if (!l.trim()) continue; try { seen.add(key(JSON.parse(l))); } catch {} }
const t0 = Date.now(); let added = 0, polls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (Date.now() - t0 < DUR) {
  try {
    const rows = await getJson(`${config.dataApiHost}/activity?user=${W}&limit=500`, 12000);
    let a = 0;
    if (Array.isArray(rows)) for (const r of rows) { const k = key(r); if (!seen.has(k)) { seen.add(k); appendFileSync(OUT, JSON.stringify(r) + "\n"); a++; added++; } }
    polls++;
    if (polls % 5 === 0) console.log(`[poll ${polls}] +${a} new (total unique ${seen.size}, appended ${added}) @ ${new Date().toISOString().slice(11,19)}`);
  } catch (e) { console.log("poll err", e.message.slice(0, 60)); }
  await sleep(POLL);
}
console.log(`DONE: ${seen.size} unique fills accumulated in ${OUT} over ${Math.round((Date.now()-t0)/60000)}min`);
