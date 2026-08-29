// research/lockstep-backtest.mjs — CROSS-ROUND backtest for the LOCKSTEP strategy.
//
// The one thing a per-window backtest can't do: Lockstep's signal depends on the LAST 6 COMPLETED rounds'
// volatility. This driver fetches consecutive windows in time order, maintains the rolling excursion buffer,
// stamps each window's INTENSITY (from the rounds BEFORE it — the active round is excluded), replays the live
// engine (simulateFills → stepSignalHedge), settles (positionFromFills), and reports PnL after latency + fees.
//
// Usage:  node research/lockstep-backtest.mjs [days=7] [market=btc_5m] [latencyMs=500] [key=val ...]
//   extra key=val pairs override STRAT (e.g. L_VOL_MODE=smooth L_SCALING=sqrt L_HEDGE_EXEC=maker SIZE=50)
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 7;
const MARKET = (A[1] || "btc_5m");
const LAT = A[2] != null && !isNaN(+A[2]) ? +A[2] : 500;
const OVER = {};   // STRAT overrides from key=val args
for (const a of A.slice(3)) { const [k, v] = a.split("="); if (k && v != null) OVER[k] = isNaN(+v) ? v : +v; }

const [asset, interval] = MARKET.split("_");
const WIN = interval === "15m" ? 900 : 300;
config.asset = asset; config.interval = interval;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch consecutive windows ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push({ ws, slug: `${asset}-updown-${interval}-${ws}` });
console.log(`\nLockstep backtest — ${asset} ${interval}, ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
if (Object.keys(OVER).length) console.log("overrides:", OVER);

const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const { ws, slug } = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length && d?.winSide != null && d?.openBinance != null && d.ticks.some((t) => t.bz != null)) {
        d._ws = ws; d.windowStart = ws;
        d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : String(d.winSide).toLowerCase() === "down" ? "Down" : d.winSide;
        raw.push(d);
      }
    } catch {}
    if (++done % 1000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(30);
  }
}));
raw.sort((a, b) => a._ws - b._ws);
console.log(`usable windows: ${raw.length}\n`);
if (!raw.length) { console.log("no windows — is the backtest API (port 3841) up and does it have data for this range?"); process.exit(0); }

// ── run one config across all windows, cross-round intensity buffer ──
function run(P) {
  const buf = makeIntensityBuffer(Math.max(12, (+P.L_VOL_ROUNDS || 6) + 4));
  let pnl = 0, nLock = 0, nHedge = 0, wins = 0, losses = 0, hedged = 0, nakedWin = 0, nakedLoss = 0, fired = 0, warmup = 0;
  let pnlHedged = 0, pnlNaked = 0;   // PnL split: locked $1-sets (arb) vs unhedged winner legs (directional)
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+P.L_VOL_ROUNDS || 6);
    d.intensity = ready ? computeIntensity(buf.ex, P) : null;
    if (ready) {
      const fills = simulateFills(d, P);
      const locks = fills.filter((f) => f.leg === "entry");
      const hedges = fills.filter((f) => f.leg === "hedge");
      if (locks.length) {
        fired++; nLock += locks.length; nHedge += hedges.length;
        const pos = positionFromFills(fills, d.winSide, d.ticks);
        const p = pos.realizedPnl ?? 0;
        pnl += p;
        if (p > 0) wins++; else if (p < 0) losses++;
        if (hedges.length) { hedged++; pnlHedged += p; }
        else { pnlNaked += p; (locks[0].side === d.winSide) ? nakedWin++ : nakedLoss++; }   // unhedged winner: did the leader hold?
      }
    } else warmup++;
    // push THIS round's excursion for FUTURE rounds (active round excluded from its own estimate)
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  return { pnl, nLock, nHedge, wins, losses, hedged, nakedWin, nakedLoss, fired, warmup, pnlHedged, pnlNaked };
}

function report(label, P) {
  const r = run(P);
  const wr = (r.wins + r.losses) ? (100 * r.wins / (r.wins + r.losses)) : 0;
  const nakedWR = (r.nakedWin + r.nakedLoss) ? (100 * r.nakedWin / (r.nakedWin + r.nakedLoss)) : 0;
  const perWin = r.fired ? r.pnl / r.fired : 0;
  console.log(
    `${label.padEnd(28)} pnl $${r.pnl.toFixed(2).padStart(9)}  fire ${String(r.fired).padStart(4)}  ` +
    `$/fire ${perWin.toFixed(3).padStart(7)}  WR ${wr.toFixed(1).padStart(5)}%  ` +
    `arb $${r.pnlHedged.toFixed(0).padStart(6)}  dir $${r.pnlNaked.toFixed(0).padStart(6)}  ` +
    `nakedWR ${nakedWR.toFixed(0).padStart(3)}%`
  );
  return r;
}

const base = { ...STRAT, ...OVER, WINDOW_SEC: WIN, LATENCY_MS: LAT, MERGE_ON: false };
console.log("config                            pnl       fire   $/fire   WR      arb $     dir $   nakedWR");
console.log("-".repeat(104));
// The edge is the ARB (hedged $1-sets); the naked directional leg is a drag. Sweep the two levers that fight it:
//   (a) raise the lock bar so un-hedgeable (uncertain) rounds are rarer/higher-WR — edge buffer, √ scaling.
//   (b) force-hedge the naked leg before close (L_END_HEDGE_S) — convert a directional gamble into a completed set.
report("linear baseline", base);
report("√ scaling", { ...base, L_SCALING: "sqrt" });
console.log("-- √ + edge buffer --");
for (const eb of [3, 5, 8, 12, 18]) report(`√ + edgeBuf $${eb}`, { ...base, L_SCALING: "sqrt", L_EDGE_BUFFER: eb });
console.log("-- √ + force end-hedge (kill the naked leg) --");
for (const eh of [8, 15, 25]) report(`√ + endHedge ${eh}s`, { ...base, L_SCALING: "sqrt", L_END_HEDGE_S: eh });
console.log("-- √ + edgeBuf $8 + end-hedge --");
for (const eh of [8, 15, 25]) report(`√ + eb8 + endHedge ${eh}s`, { ...base, L_SCALING: "sqrt", L_EDGE_BUFFER: 8, L_END_HEDGE_S: eh });
console.log("-- HEDGE EXEC: taker vs maker (√ + edgeBuf $8) — does resting the cheap-loser bid beat taking it? --");
const H = { ...base, L_SCALING: "sqrt", L_EDGE_BUFFER: 8, L_ENTRY_CEIL: 0 };
report("taker hedge (baseline)", { ...H, L_HEDGE_EXEC: "taker" });
for (const off of [0.00, 0.01, 0.02]) report(`maker hedge (bid ask−$${off.toFixed(2)})`, { ...H, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: off });
// ENTRY CEILING: re-evaluate rather than inheriting the production default. On the 2026-08-24 frozen 30-day
// replay, 0.88 reduced the naked-winner reversal tail enough to turn the current high-cap profile positive.
console.log("-- ENTRY CEILING on the maker@1¢ baseline --");
const MKR = { ...H, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: 0.01 };
report("maker@1¢ (no ceil)", MKR);
for (const ceil of [0.88, 0.90, 0.92, 0.94, 0.96, 0.98]) report(`+ entry-ceil ${ceil}`, { ...MKR, L_ENTRY_CEIL: ceil });
// HEDGE OPTIMIZATION — explored + REJECTED (all lose to the fixed maker@1¢ + ride-naked hedge):
//   #1 trailing maker peg  → mechanical no-op (a bid below the ask only fills when the ask comes down to it).
//   #2 margin-guarded maker→taker fallback → −$82/30d (completing thin sets on contested rounds forgoes the
//      higher-EV naked winner).
//   #3 adaptive/profit-aware cap (hedge pricier losers when the winner was cheap) → loses monotonically
//      (−$39/−$76/−$155 at cap 0.03/0.05/0.08); the arb column DROPS because pricier-loser sets are thinner.
//   #4 laddered/DCA hedge → dominated: laddering UP hedges at a higher avg price (= #3), laddering DOWN leaves
//      partial-naked remainders (= naked drag); the maker bid already captures the cheap fill. Not built.
//   VERDICT: hedge STRICTLY — cheap loser only (low cap), maker bid ~1¢ under the ask, ride the winner naked on
//   contested rounds. Every "hedge more / at a worse price" variant loses. Do not re-attempt.
console.log("\n(arb = PnL from hedged $1-sets · dir = PnL from unhedged winner legs · nakedWR = their raw hit-rate)");
console.log("(maker hedge: 'hedged' counts only rounds where the resting bid FILLED; unfilled rests fall to 'dir' as naked winners)");
