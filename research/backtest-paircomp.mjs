// research/backtest-paircomp.mjs — offline backtest of any registered strategy over the settled-window disk
// cache (data/wincache), reported with the paired/directional decomposition used in
// TARGET_WALLET_STRATEGY_ANALYSIS.md §4.
//
// Offline by design: it reads the gzipped cache directly rather than going through fetchWindowHistory, so a run
// is byte-reproducible, needs no API quota, and — unlike the dashboard's session backtest — applies NO bankroll
// scaling and NO session circuit breaker. Both of those silently truncate a range (see src/execution/session.js:
// one breach of MAX_SESSION_LOSS freezes the shadow for every remaining window), which makes a dashboard run
// unusable as a measure of strategy edge.
//
// Usage:
//   node research/backtest-paircomp.mjs                             # paircomp, whole cache
//   node research/backtest-paircomp.mjs --strategy=helpme           # compare against the deployed strategy
//   node research/backtest-paircomp.mjs --limit=300 --stride=4      # quick subsample
//   node research/backtest-paircomp.mjs PC_PAIR_PROFIT_TARGET=0.10 PC_MAX_LEAN_SH=20
//   node research/backtest-paircomp.mjs --split                     # chronological fit/holdout halves
//
// Any bare key=value argument is passed through as a strategy parameter override.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { fillFee } from "../engine/fees.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "data", "wincache");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const STRATEGY = flag("strategy", "paircomp");
const LIMIT = Number(flag("limit", Infinity));
const STRIDE = Math.max(1, Number(flag("stride", 1)));
const SPLIT = argv.includes("--split");

const OVERRIDES = {};
for (const a of argv) {
  if (a.startsWith("--")) continue;
  const i = a.indexOf("=");
  if (i <= 0) continue;
  const k = a.slice(0, i), v = a.slice(i + 1);
  OVERRIDES[k] = v === "true" ? true : v === "false" ? false : (isNaN(+v) ? v : +v);
}

// STREAMED, never materialised. A whole window's 50 ms L2 frames are tens of MB inflated; holding 2,300 of
// them at once OOMs a default heap, so each is decoded, replayed, and released before the next is read.
function cacheFiles() {
  if (!fs.existsSync(CACHE)) { console.error(`no window cache at ${CACHE}`); process.exit(1); }
  const all = fs.readdirSync(CACHE).filter((f) => f.endsWith(".gz")).sort();
  const out = [];
  for (let i = 0; i < all.length && out.length < LIMIT; i += STRIDE) out.push(all[i]);
  return out;
}

function loadOne(file) {
  let d;
  try { d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CACHE, file)))); } catch { return null; }
  if (!d?.ticks?.length || d.winSide == null || d.openBinance == null) return null;
  if (!d.ticks.some((t) => t.bz != null)) return null;
  d.windowStart = Number(file.split("_")[0].split("-").pop());
  d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : "Down";
  return d;
}

// Paired / directional split (§4): `m = min(qU, qD)` matched shares pay exactly $m at resolution whatever wins;
// the `qU - qD` remainder is the outright bet. Reporting them separately is the only way to see whether a
// strategy is earning the pair spread or just betting.
function analyse(files, params) {
  const acc = {
    windows: 0, traded: 0, fills: 0, shares: 0, cost: 0, fee: 0, payout: 0,
    makerSh: 0, takerSh: 0, pairSh: 0, pairCost: 0, dirGross: 0,
    seedSh: 0, seedCost: 0, seedWon: 0, compSh: 0, compCost: 0,
    wpnl: [], spend: [],
  };
  for (const file of files) {
    const d = loadOne(file);
    if (!d) continue;
    acc.windows++;
    const fills = simulateFills(d, params);
    if (!fills.length) { acc.wpnl.push(0); continue; }
    acc.traded++; acc.fills += fills.length;

    const pos = positionFromFills(fills, d.winSide, d.ticks);
    acc.cost += pos.totalCost; acc.fee += pos.fee;
    acc.payout += d.winSide === "Up" ? pos.upShares : pos.downShares;
    acc.shares += pos.upShares + pos.downShares;
    acc.wpnl.push(pos.realizedPnl); acc.spend.push(pos.totalCost);

    for (const f of fills) {
      const sh = +f.shares || 0;
      if (f.maker) acc.makerSh += sh; else acc.takerSh += sh;
      if (f.leg === "seed") {
        acc.seedSh += sh; acc.seedCost += +f.usdc || 0;
        if (f.side === d.winSide) acc.seedWon += sh;
      } else if (f.leg === "complement") {
        acc.compSh += sh; acc.compCost += +f.usdc || 0;
      }
    }

    const upCost = fills.filter((f) => f.side === "Up").reduce((t, f) => t + (+f.usdc || 0), 0);
    const dnCost = fills.filter((f) => f.side === "Down").reduce((t, f) => t + (+f.usdc || 0), 0);
    const upAvg = pos.upShares > 0 ? upCost / pos.upShares : 0;
    const dnAvg = pos.downShares > 0 ? dnCost / pos.downShares : 0;
    const m = Math.min(pos.upShares, pos.downShares);
    if (m > 0) { acc.pairSh += m; acc.pairCost += m * (upAvg + dnAvg); }
    const resid = pos.upShares - pos.downShares;
    if (resid > 0) acc.dirGross += d.winSide === "Up" ? resid * (1 - upAvg) : -resid * upAvg;
    else if (resid < 0) acc.dirGross += d.winSide === "Down" ? -resid * (1 - dnAvg) : resid * dnAvg;
    d.ticks = null;                       // release the frames before decoding the next window
  }
  return acc;
}

function report(label, a) {
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const gross = a.payout - a.cost;
  const net = gross - a.fee;
  const pairAvg = a.pairSh ? a.pairCost / a.pairSh : 0;
  const pct = (x, d) => d ? (100 * x / d).toFixed(2) : "0.00";
  console.log(`\n── ${label} ──`);
  console.log(`windows ${a.windows} (traded ${a.traded})   fills ${a.fills}   shares ${a.shares.toFixed(0)}   turnover $${a.cost.toFixed(0)}`);
  console.log(`maker ${pct(a.makerSh, a.makerSh + a.takerSh)}% of shares   taker ${pct(a.takerSh, a.makerSh + a.takerSh)}%`);
  console.log(`GROSS $${gross.toFixed(2)}   fees $${a.fee.toFixed(2)}   NET $${net.toFixed(2)}  (${pct(net, a.cost)}% of turnover, $${(net / (a.windows || 1)).toFixed(3)}/window)`);
  console.log(`  paired      ${a.pairSh.toFixed(0).padStart(8)} sh @ ${pairAvg.toFixed(4)} combined  ->  $${(a.pairSh * (1 - pairAvg)).toFixed(2)} gross`);
  console.log(`  directional ${(a.shares - 2 * a.pairSh).toFixed(0).padStart(8)} sh residual                ->  $${a.dirGross.toFixed(2)} gross`);
  if (a.seedSh) console.log(`  seed legs   ${a.seedSh.toFixed(0).padStart(8)} sh @ ${(a.seedCost / a.seedSh).toFixed(4)}   won ${pct(a.seedWon, a.seedSh)}% of shares`);
  if (a.compSh) console.log(`  complements ${a.compSh.toFixed(0).padStart(8)} sh @ ${(a.compCost / a.compSh).toFixed(4)}`);
  console.log(`per-window pnl: mean $${(net / (a.windows || 1)).toFixed(2)}  p05 $${q(a.wpnl, 0.05).toFixed(2)}  med $${q(a.wpnl, 0.5).toFixed(2)}  p95 $${q(a.wpnl, 0.95).toFixed(2)}  worst $${q(a.wpnl, 0).toFixed(2)}`);
  if (a.spend.length) console.log(`per-window turnover: med $${q(a.spend, 0.5).toFixed(2)}  p95 $${q(a.spend, 0.95).toFixed(2)}  max $${q(a.spend, 1).toFixed(2)}`);
  return net;
}

const files = cacheFiles();
if (!files.length) { console.error("no usable cached windows"); process.exit(1); }
const params = { STRATEGY, ...OVERRIDES };
const wsOf = (f) => Number(f.split("_")[0].split("-").pop());
console.log(`strategy=${STRATEGY}  windows=${files.length}  overrides=${JSON.stringify(OVERRIDES)}`);
console.log(`range ${new Date(wsOf(files[0]) * 1000).toISOString()} .. ${new Date(wsOf(files.at(-1)) * 1000).toISOString()}`);

if (SPLIT) {
  const half = Math.floor(files.length / 2);
  report("FIT (older half)", analyse(files.slice(0, half), params));
  report("HOLDOUT (newer half)", analyse(files.slice(half), params));
} else {
  report(`${STRATEGY} — full cache`, analyse(files, params));
}
