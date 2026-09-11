// Recover settlement summaries from recorded actual simulation fills. No replay
// or inferred maker fills; only the ordinary live recorder payload directory.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/config/config.js";
import { positionFromFills } from "../engine/simrun.js";
import { createSessionStore } from "../src/sources/session-store.js";

export function sessionFromRecording(record) {
  if (record?.recorder !== "shadow-execution-evidence-v2" || !Array.isArray(record.fills)
    || !["Up", "Down"].includes(record.winSide)
    || record.settlement?.outcome !== record.winSide
    || !Number.isSafeInteger(record.windowStart)) throw new Error("Missing recorded settlement evidence");
  for (const fill of record.fills) {
    if (fill.sell) throw new Error("Sell accounting requires separate recovery");
    if (fill.leg === "merge") continue;
    if (!["Up", "Down"].includes(fill.side)
      || ![fill.shares, fill.usdc, fill.fee].every(Number.isFinite)) throw new Error("Incomplete recorded fill");
  }
  const pos = positionFromFills(record.fills, record.winSide);
  const r2 = (value) => Math.round(value * 100) / 100;
  return {
    slug: record.slug, windowStart: record.windowStart, winSide: record.winSide, status: "resolved",
    ts: Math.floor(record.settlement.recordedAtMs / 1000), source: "recorded-simulation-fills",
    sim: { pnl: r2(pos.realizedPnl), winSh: r2(record.winSide === "Up" ? pos.upShares : pos.downShares),
      upShares: r2(pos.upShares), downShares: r2(pos.downShares), net: pos.upShares > pos.downShares ? "Up" : "Down",
      cost: r2(pos.totalCost), fee: r2(pos.fee), merged: r2(pos.merged), nFills: record.fills.length, cfg: record.cfg },
    bot: null, netMatch: null, pnlErr: null,
  };
}

function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    // Fills and settlement precede the high-volume ticks array. Bound memory
    // and never read the hundreds of MB of ticks to recover a summary.
    let prefix = "";
    const chunk = Buffer.alloc(64 * 1024);
    while (prefix.length < 8 * 1024 * 1024) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      prefix += chunk.toString("utf8", 0, n);
      const boundary = prefix.indexOf(',"ticks":');
      if (boundary >= 0) return JSON.parse(prefix.slice(0, boundary) + "}");
    }
    throw new Error("Recorder header missing or too large");
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const write = process.argv.includes("--write");
  const dir = path.join(config.dataDir, "live-ticks", "payloads");
  const store = createSessionStore(path.join(config.dataDir, "sessions-sim"));
  let recovered = 0, skipped = 0, pnl = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^[a-z]+-updown-(5m|15m)-\d+\.json$/.test(name)) continue;
    try {
      const row = sessionFromRecording(readHeader(path.join(dir, name)));
      if (write) store.write(row);
      recovered++; pnl += row.sim.pnl;
    } catch (error) { skipped++; console.error(`${name}: ${error.message}`); }
  }
  console.log(JSON.stringify({ write, recovered, skipped, recordedPnl: Math.round(pnl * 100) / 100 }));
}
