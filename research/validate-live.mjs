// research/validate-live.mjs — REAL-vs-MODELED validation for the live LOCKSTEP shadow.
//
// The backtest says +$935/30d, but that's a MODEL (optimistic fills, no live latency/adverse-selection).
// Every window the live shadow resolves logs BOTH:
//     sim.pnl  — the strategy's own modeled fill on the LIVE feed (the backtest-style number, live)
//     real.pnl — what ACTUALLY filled on-chain (present only when a real order filled; the honest number)
// This script reads shadow_sessions_<mode> and reports the gap: does the modeled edge survive real execution?
//
// A window the model LOCKED but that got NO real fill (latency / adverse selection) counts as real $0 —
// the modeled profit that live execution missed. Those misses are the whole point of the check.
//
// Usage:  node research/validate-live.mjs [days=all] [--table]
import { sessionsCol } from "../src/sources/db.js";

const A = process.argv.slice(2);
const DAYS = A.find((a) => /^\d+$/.test(a)) ? +A.find((a) => /^\d+$/.test(a)) : null;
const TABLE = A.includes("--table");

const col = await sessionsCol();
const q = { status: "resolved" };
if (DAYS) q.windowStart = { $gte: Math.floor(Date.now() / 1000) - DAYS * 86400 };
const docs = (await col.find(q).sort({ windowStart: 1 }).toArray());
if (!docs.length) { console.log("no resolved windows logged yet — let the live bot run first."); process.exit(0); }

const r2 = (x) => Math.round(x * 100) / 100;
const traded = docs.filter((d) => d.sim && d.sim.nFills > 0);          // model actually locked
const hasReal = docs.some((d) => d.real);                             // is this a live-execution run at all?
const span = (docs[docs.length - 1].windowStart - docs[0].windowStart) / 86400 || 1;
const perWin = 300;                                                   // 5m windows for the /30d projection

console.log(`\nLockstep live validation — ${docs.length} resolved windows over ${span.toFixed(1)}d`);
console.log(`(${traded.length} the model locked · mode = ${hasReal ? "LIVE execution (real fills present)" : "SIM-only (no real fills — feed-gap check only)"})`);

// config drift: only windows run under one config are apples-to-apples
const cfgs = new Map();
for (const d of traded) { const k = JSON.stringify(d.sim.cfg || null); cfgs.set(k, (cfgs.get(k) || 0) + 1); }
if (cfgs.size > 1) console.log(`⚠ ${cfgs.size} distinct configs across the traded windows — the gap mixes config changes (run after a stable stretch for a clean read).`);

if (!hasReal) {
  // SIM-only: no on-chain fills to compare. The only live signal is that the strategy fired on the live feed.
  const simPnl = traded.reduce((s, d) => s + (d.sim.pnl || 0), 0);
  const wins = traded.filter((d) => d.sim.pnl > 0).length;
  console.log(`\nmodeled (sim) over live feed:  pnl $${r2(simPnl)}  WR ${(100 * wins / traded.length).toFixed(1)}%  $/win ${r2(simPnl / traded.length)}`);
  console.log("→ no real fills yet. Switch the bot to live execution to measure the modeled-vs-real gap.");
  process.exit(0);
}

// ── LIVE: pair modeled vs real per traded window ──
let simSum = 0, realSum = 0, missPnl = 0, filled = 0, missed = 0;
let simWins = 0, realWins = 0, simFills = 0, realFills = 0;
const rows = [];
for (const d of traded) {
  const s = d.sim.pnl || 0;
  simSum += s; if (s > 0) simWins++;
  simFills += d.sim.nFills || 0;
  if (d.real) {
    const rp = d.real.pnl || 0;
    realSum += rp; if (rp > 0) realWins++;
    realFills += d.real.nFills || 0; filled++;
    rows.push({ ws: d.windowStart, win: d.winSide, sim: s, real: rp, gap: rp - s, sf: d.sim.nFills, rf: d.real.nFills });
  } else {
    // model locked, live never filled → the modeled PnL that execution missed (real contribution = $0)
    missed++; missPnl += s;
    rows.push({ ws: d.windowStart, win: d.winSide, sim: s, real: 0, gap: -s, sf: d.sim.nFills, rf: 0 });
  }
}
const realTotal = realSum;                                            // missed windows contribute $0 (already excluded from realSum)
const gap = realTotal - simSum;
const ratio = simSum !== 0 ? realTotal / simSum : 0;
const proj = (x) => r2(x / span * 30);                               // → per-30d

console.log(`\n                    modeled(sim)      real(on-chain)      gap`);
console.log(`  total PnL         $${simSum.toFixed(2).padStart(9)}      $${realTotal.toFixed(2).padStart(9)}      $${gap.toFixed(2).padStart(8)}`);
console.log(`  per 30d (proj)    $${proj(simSum).toFixed(2).padStart(9)}      $${proj(realTotal).toFixed(2).padStart(9)}      $${proj(gap).toFixed(2).padStart(8)}`);
console.log(`  $/locked-window   $${r2(simSum / traded.length).toString().padStart(9)}      $${r2(realTotal / traded.length).toString().padStart(9)}`);
console.log(`  win-rate          ${(100 * simWins / traded.length).toFixed(1).padStart(9)}%      ${(100 * realWins / traded.length).toFixed(1).padStart(9)}%`);
console.log(`  fills realized    ${String(simFills).padStart(9)}       ${String(realFills).padStart(9)}       (${(100 * realFills / (simFills || 1)).toFixed(0)}% of modeled fills actually filled)`);
console.log(`  real-fill misses  ${missed}/${traded.length} locked windows never filled live  (forfeited modeled $${r2(missPnl)})`);

console.log(`\nVERDICT`);
const realPos = realTotal > 0;
const capture = ratio >= 0.7 ? "holds" : ratio >= 0.3 ? "erodes" : "collapses";
console.log(`  real execution captures ${(100 * ratio).toFixed(0)}% of the modeled edge → the edge ${capture}${realPos ? "" : " (real is NET NEGATIVE)"}.`);
console.log(`  modeled +$935/30d baseline ⇒ this run projects real ≈ $${proj(realTotal)}/30d.`);
if (!realPos) console.log(`  ⇒ same story as the rest of this codebase: modeled-positive, live-dead. Do NOT scale up.`);
else if (ratio < 0.5) console.log(`  ⇒ execution eats >half the edge — chase the miss/slippage source before scaling.`);
else console.log(`  ⇒ the edge is surviving execution so far — keep collecting; re-check as N grows.`);

if (TABLE) {
  console.log(`\nlast 20 windows (ws · winner · sim → real · gap · fills sim/real):`);
  for (const r of rows.slice(-20)) {
    const t = new Date(r.ws * 1000).toISOString().slice(5, 16).replace("T", " ");
    console.log(`  ${t}  ${String(r.win).padEnd(4)}  $${r.sim.toFixed(2).padStart(7)} → $${r.real.toFixed(2).padStart(7)}  gap $${r.gap.toFixed(2).padStart(7)}  ${r.sf}/${r.rf}${r.rf === 0 ? "  ⟵ MISS" : ""}`);
  }
}
process.exit(0);
