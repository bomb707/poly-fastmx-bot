#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const sourceFile = path.resolve(process.argv[3] || path.join(dataDir, "trades-2026-08-14_2026-08-22.json"));
const startMs = Date.parse(process.argv[4] || "2026-08-19T00:00:00Z");
const v2Dir = path.resolve(process.argv[5] || path.join(dataDir, "feeds/v2"));
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const marketBySlug = new Map(source.markets.map((row) => [row.slug, row]));
const fee = (row) => row.role === "taker" ? .07 * Number(row.price) * (1 - Number(row.price)) * Number(row.size) : 0;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const bySlug = new Map();
for (const row of source.trades) {
  const marketMs = Number(row.slug.split("-").at(-1)) * 1000;
  if (marketMs < startMs) continue;
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}

const windows = [];
for (const [slug, rows] of bySlug) {
  rows.sort((a, b) => a.timestamp - b.timestamp || a.outcome.localeCompare(b.outcome));
  const queues = { Up: [], Down: [] };
  let pairedShares = 0, pairedPnl = 0;
  for (const row of rows) {
    const side = row.outcome, opposite = side === "Up" ? "Down" : "Up";
    let left = Number(row.size), effectivePrice = Number(row.price) + fee(row) / Number(row.size);
    while (left > 1e-9 && queues[opposite].length) {
      const lot = queues[opposite][0], take = Math.min(left, lot.shares);
      left -= take; lot.shares -= take; pairedShares += take;
      pairedPnl += take * (1 - effectivePrice - lot.effectivePrice);
      if (lot.shares <= 1e-9) queues[opposite].shift();
    }
    if (left > 1e-9) queues[side].push({ shares: left, effectivePrice });
  }
  const up = queues.Up.reduce((sum, lot) => sum + lot.shares, 0), down = queues.Down.reduce((sum, lot) => sum + lot.shares, 0);
  const residualSide = up >= down ? "Up" : "Down", residualLots = queues[residualSide];
  const residualShares = residualLots.reduce((sum, lot) => sum + lot.shares, 0);
  const residualCost = residualLots.reduce((sum, lot) => sum + lot.shares * lot.effectivePrice, 0);
  const winner = marketBySlug.get(slug)?.winner;
  const residualPayout = winner === residualSide ? residualShares : 0;
  const v2File = path.join(v2Dir, `${slug}.json.gz`);
  let binanceAligned = null, chainlinkAligned = null;
  if (fs.existsSync(v2File)) {
    const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(v2File)));
    const endMs = Number(slug.split("-").at(-1)) * 1000 + 270_000;
    const tick = feed.ticks.filter((row) => row.ms <= endMs).at(-1) || feed.ticks.at(-1);
    const sign = residualSide === "Up" ? 1 : -1;
    if (Number(tick?.bz) > 0 && Number(feed.openBinance) > 0) binanceAligned = (Number(tick.bz) - Number(feed.openBinance)) * sign > 0;
    if (Number(tick?.cl) > 0 && Number(feed.openChainlink) > 0) chainlinkAligned = (Number(tick.cl) - Number(feed.openChainlink)) * sign > 0;
  }
  windows.push({
    slug,
    day: new Date(Number(slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10),
    pairedShares,
    pairedPnl,
    residualSide,
    residualShares,
    residualCost,
    residualAveragePrice: residualShares ? residualCost / residualShares : null,
    residualPayout,
    residualPnl: residualPayout - residualCost,
    residualWon: residualPayout > 0,
    binanceAligned,
    chainlinkAligned,
  });
}

function aggregate(rows) {
  const sum = (field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const pairedShares = sum("pairedShares"), pairedPnl = sum("pairedPnl"), residualShares = sum("residualShares");
  const residualCost = sum("residualCost"), residualPayout = sum("residualPayout"), residualPnl = sum("residualPnl");
  const bz = rows.filter((row) => row.binanceAligned !== null), cl = rows.filter((row) => row.chainlinkAligned !== null);
  return {
    windows: rows.length,
    pairedShares: round(pairedShares, 2),
    pairedPnl: round(pairedPnl, 2),
    pairedEdgeCentsPerSet: pairedShares ? round(pairedPnl / pairedShares * 100, 4) : null,
    residualShares: round(residualShares, 2),
    residualCost: round(residualCost, 2),
    residualAveragePrice: residualShares ? round(residualCost / residualShares, 6) : null,
    residualWinningShares: round(residualPayout, 2),
    residualWeightedWinPct: pct(residualPayout, residualShares),
    residualPnl: round(residualPnl, 2),
    residualBinanceGapAlignedPct: pct(bz.filter((row) => row.binanceAligned).length, bz.length),
    residualChainlinkGapAlignedPct: pct(cl.filter((row) => row.chainlinkAligned).length, cl.length),
    totalPnl: round(pairedPnl + residualPnl, 2),
  };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: "FIFO match opposite-side public fills; taker fee included in lot cost; remaining one-sided lots settle against the winner",
  currentRegime: aggregate(windows),
  byDay: Object.fromEntries([...new Set(windows.map((row) => row.day))].sort().map((day) => [day, aggregate(windows.filter((row) => row.day === day))])),
  windows,
};
fs.writeFileSync(path.join(dataDir, "current-economics.json.gz"), zlib.gzipSync(JSON.stringify(report), { level: 9 }));
const r = report.currentRegime;
const md = `# Current-regime PnL decomposition\n\n` +
`FIFO decomposition of every public fill from Aug 19 onward, including the exact taker fee.\n\n` +
`- Complete sets: ${r.pairedShares.toLocaleString()} shares, $${r.pairedPnl} PnL, ${r.pairedEdgeCentsPerSet} cents/set.\n` +
`- Residual inventory: ${r.residualShares.toLocaleString()} shares at average ${r.residualAveragePrice}, ${r.residualWeightedWinPct}% share-weighted win rate, $${r.residualPnl} PnL.\n` +
`- Residual side follows the t+270 Binance window gap in only ${r.residualBinanceGapAlignedPct}% of windows and Chainlink RTDS gap in ${r.residualChainlinkGapAlignedPct}%. It is a cheap contrarian residual, not a terminal trend bet.\n` +
`- Combined FIFO-attributed PnL: $${r.totalPnl}.\n`;
fs.writeFileSync(path.join(dataDir, "current-economics.md"), md);
console.log(md);
console.log(JSON.stringify({ currentRegime: report.currentRegime, byDay: report.byDay }, null, 2));
