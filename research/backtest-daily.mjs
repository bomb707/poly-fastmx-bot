#!/usr/bin/env node
// FastMX daily replay over coherent BAPI v2 full-L2 order-book frames.
// Uses the registered production strategy, the repository's PM2 simulation
// profile, the normal 520 ms arrival model, and fee-inclusive settlement.
//
// Usage: node research/backtest-daily.mjs <startSlugOrUnix> [latencyList=520] [key=val ...]
//   node research/backtest-daily.mjs 1787356800 520 END=1788480000

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategies/helpme.js";

const require = createRequire(import.meta.url);
const ecosystem = require("../ecosystem.config.cjs");
const pm2App = ecosystem.apps?.find((app) => app?.env?.SHADOW_PARAMS_JSON);
const pm2Profile = JSON.parse(pm2App?.env?.SHADOW_PARAMS_JSON || "{}");
const args = process.argv.slice(2);
const unixPart = (value) => Number(String(value || "").trim().split("-").at(-1));
const start = unixPart(args[0]);
if (!Number.isFinite(start)) {
  console.error("give a start slug (btc-updown-5m-<unix>) or unix timestamp");
  process.exit(1);
}
const latencies = String(args[1] || "520").split(",").map(Number)
  .filter((value) => Number.isFinite(value) && value >= 0);
const overrides = {};
for (const arg of args.slice(2)) {
  const [key, ...rest] = arg.split("=");
  const raw = rest.join("=");
  if (!key || raw === "") continue;
  if (Number.isFinite(Number(raw))) overrides[key] = Number(raw);
  else { try { overrides[key] = JSON.parse(raw); } catch { overrides[key] = raw; } }
}

const windowSec = 300;
const endOverride = unixPart(overrides.END);
delete overrides.END;
// Default to the latest complete UTC day. This prevents a partial current day
// from being compared with complete daily rows.
const end = Number.isFinite(endOverride)
  ? endOverride
  : Math.floor(Date.now() / 86_400_000) * 86_400;
if (end <= start) throw new RangeError("END must be after START");
config.asset = "btc";
config.interval = "5m";
config.backtestApiVersion = "v2";

const slugs = [];
for (let ws = start; ws < end; ws += windowSec) slugs.push(`btc-updown-5m-${ws}`);
console.log("\nFastMX BAPI v2 L2 daily backtest");
console.log(`${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()} (exclusive)`);
console.log(`${slugs.length} requested five-minute windows; source=${config.v2OrderbookApi}`);

const blank = () => ({ windows: 0, activeMarkets: 0, orders: 0, entries: 0,
  hedges: 0, reversals: 0, full: 0, partial: 0, upShares: 0,
  downShares: 0, cost: 0, fees: 0, pnl: 0, wins: 0, losses: 0 });
const add = (total, row) => {
  total.windows++;
  if (row.orders) total.activeMarkets++;
  for (const key of ["orders", "entries", "hedges", "reversals", "full", "partial",
    "upShares", "downShares", "cost", "fees", "pnl"]) total[key] += row[key];
  if (row.pnl > 0) total.wins++;
  else if (row.pnl < 0) total.losses++;
};
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const metrics = (raw) => ({
  ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value)])),
  participationPct: raw.windows ? round(raw.activeMarkets / raw.windows * 100, 3) : null,
  ordersPerActiveMarket: raw.activeMarkets ? round(raw.orders / raw.activeMarkets, 3) : null,
  winRatePct: raw.activeMarkets ? round(raw.wins / raw.activeMarkets * 100, 3) : null,
  roiPct: raw.cost + raw.fees > 0 ? round(raw.pnl / (raw.cost + raw.fees) * 100, 4) : null,
});
const dateOf = (ws) => new Date(ws * 1000).toISOString().slice(0, 10);

const reportStates = latencies.map((latencyMs) => {
  const params = { ...STRAT, ...pm2Profile, ...overrides, LATENCY_MS: latencyMs,
    STRATEGY: "helpme", LIVE_FILLS: false };
  return { latencyMs, params, total: blank(), daily: {}, windows: [] };
});
function replayWindow(data) {
  for (const report of reportStates) {
    const { params } = report;
    const fills = simulateFills({ ticks: data.ticks, openBinance: data.openBinance,
      openPrice: data.openPrice, windowStart: data.ws }, params);
    const position = positionFromFills(fills, data.winSide, data.ticks);
    const row = {
      slug: data.slug,
      day: dateOf(data.ws),
      winner: data.winSide,
      orders: fills.length,
      entries: fills.filter((fill) => fill.leg === "entry").length,
      hedges: fills.filter((fill) => fill.leg === "hedge").length,
      reversals: fills.filter((fill) => fill.leg === "reversal").length,
      full: fills.filter((fill) => fill.status === "full").length,
      partial: fills.filter((fill) => fill.status === "partial").length,
      upShares: position.upShares,
      downShares: position.downShares,
      cost: position.totalCost,
      fees: position.fee,
      pnl: position.realizedPnl ?? 0,
    };
    report.windows.push(row);
    report.daily[row.day] ||= blank();
    add(report.daily[row.day], row);
    add(report.total, row);
  }
}

const queue = [...slugs];
const failures = new Map();
let completed = 0, usableWindows = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason) => failures.set(reason, (failures.get(reason) || 0) + 1);
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const slug = queue.shift();
    try {
      const data = await fetchWindowHistory(slug, { ticksOnly: true });
      if (data?.source !== "v2-orderbook-l2") fail("wrong-source");
      else if (!data.l2Complete) fail("incomplete-l2");
      else if (data.winSide == null) fail("unsettled");
      else if (!(data.openBinance > 0)) fail("missing-binance-open");
      else if (!data.ticks?.some((tick) => tick.bz != null)) fail("missing-binance-ticks");
      else {
        replayWindow({ ...data, ws: unixPart(slug),
          winSide: String(data.winSide).toLowerCase() === "up" ? "Up" : "Down" });
        usableWindows++;
      }
    } catch (error) {
      fail(`fetch:${error?.message || error}`);
    }
    completed++;
    if (completed % 100 === 0 || completed === slugs.length)
      console.log(`  fetched ${completed}/${slugs.length}; usable=${usableWindows}`);
    await sleep(20);
  }
}));
if (!usableWindows) {
  console.error("No complete settled BAPI v2 L2 windows were available.");
  process.exit(2);
}
const reports = reportStates.map((report) => ({
  latencyMs: report.latencyMs,
  params: report.params,
  total: metrics(report.total),
  daily: Object.fromEntries(Object.entries(report.daily).sort(([a], [b]) => a.localeCompare(b))
    .map(([day, raw]) => [day, metrics(raw)])),
  windows: report.windows.sort((a, b) => a.slug.localeCompare(b.slug)),
}));

for (const report of reports) {
  console.log(`\n================ LATENCY ${report.latencyMs}ms ================`);
  console.log("UTC date      used active orders  E/H/R             PnL       ROI     cumulative");
  console.log("-".repeat(88));
  let cumulative = 0;
  for (const [day, row] of Object.entries(report.daily)) {
    cumulative += row.pnl;
    const roles = `${row.entries}/${row.hedges}/${row.reversals}`;
    console.log(`${day}  ${String(row.windows).padStart(4)} ${String(row.activeMarkets).padStart(6)} ${String(row.orders).padStart(6)}  ${roles.padEnd(15)}`
      + `${(row.pnl >= 0 ? "+" : "") + "$" + row.pnl.toFixed(2)}`.padStart(11)
      + `${row.roiPct == null ? "—" : `${row.roiPct.toFixed(2)}%`}`.padStart(10)
      + `${(cumulative >= 0 ? "+" : "") + "$" + cumulative.toFixed(2)}`.padStart(14));
  }
  console.log("-".repeat(88));
  const total = report.total;
  console.log(`TOTAL       ${String(total.windows).padStart(4)} ${String(total.activeMarkets).padStart(6)} ${String(total.orders).padStart(6)}  `
    + `${`${total.entries}/${total.hedges}/${total.reversals}`.padEnd(15)}`
    + `${(total.pnl >= 0 ? "+" : "") + "$" + total.pnl.toFixed(2)}`.padStart(11)
    + `${total.roiPct == null ? "—" : `${total.roiPct.toFixed(2)}%`}`.padStart(10));
}

const outputDir = path.resolve("research/results");
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir,
  `fastmx-daily-bapi-v2-${dateOf(start)}_${dateOf(end - windowSec)}.json`);
const result = { schema: 1, generatedAt: new Date().toISOString(),
  source: "BAPI v2 coherent full-L2 orderbooks downsampled to the live 120 ms cadence",
  range: { start, endExclusive: end, startIso: new Date(start * 1000).toISOString(),
    endExclusiveIso: new Date(end * 1000).toISOString() },
  requestedWindows: slugs.length, usableWindows,
  failures: Object.fromEntries(failures), pm2Profile, overrides, reports };
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n");
console.log(`\nSaved ${outputFile}`);
console.log(`Usable ${usableWindows}/${slugs.length}; failures=${JSON.stringify(result.failures)}`);
