// research/hedge-outcome.mjs — how well does the AUTOMATED HEDGE complete the $1-set? (BACKTEST API, no wallet)
//
// The auto-hedge IS the edge: a lock alone is a directional gamble; it only becomes +EV when the hedge catches the
// cheap loser and completes a guaranteed set (the arb). This re-simulates the CURRENT Lockstep config over historical
// windows (backtest API + cross-round intensity, same engine as live) and classifies every LOCKED round:
//   completed — a hedge fill landed → balanced $1-set → ARB
//   naked     — no hedge → the winner rode to settlement (directional)
//
// It runs the hedge BOTH ways on the SAME windows to separate the two questions:
//   TAKER  completion = how often the loser got cheap enough to complete AT ALL (the "completable" rate).
//   MAKER  completion = how often the resting 1¢ bid actually FILLED. The gap (completable − maker) is the maker
//                       adverse-selection miss — the sets that were there for the taking but the maker bid didn't get.
//
// Usage:  node research/hedge-outcome.mjs [days=14] [latencyMs=520] [key=val ...]   (key=val overrides STRAT)
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 14;
const LAT = A[1] != null && !isNaN(+A[1]) ? +A[1] : 520;
const OVER = {}; for (const a of A.slice(2)) { const [k, v] = a.split("="); if (k && v != null) OVER[k] = isNaN(+v) ? v : +v; }
const WIN = 300;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch consecutive windows ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push({ ws, slug: `btc-updown-5m-${ws}` });
console.log(`\nHedge-outcome (backtest) — btc 5m, ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
if (Object.keys(OVER).length) console.log("overrides:", OVER);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const { ws, slug } = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length && d?.winSide != null && d?.openBinance != null && d.ticks.some((t) => t.bz != null)) {
        d._ws = ws; d.windowStart = ws; d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : "Down"; raw.push(d);
      }
    } catch {}
    if (++done % 2000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(25);
  }
}));
raw.sort((a, b) => a._ws - b._ws);
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 100) { console.log("too few windows — is the backtest API up with data for this range?"); process.exit(0); }

// classify every locked round for one hedge-exec config, cross-round intensity attached (same as live/backtest)
function run(P) {
  const buf = makeIntensityBuffer(12);
  let locked = 0, completed = 0, naked = 0, nakedWin = 0, nakedLoss = 0;
  let pnl = 0, arb = 0, dir = 0;
  const perWin = [];
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+P.L_VOL_ROUNDS || 6);
    d.intensity = ready ? computeIntensity(buf.ex, P) : null;
    if (ready) {
      const fills = simulateFills(d, P);
      const entry = fills.filter((f) => f.leg === "entry");
      if (entry.length) {
        locked++;
        const hedged = fills.some((f) => f.leg === "hedge");
        const p = positionFromFills(fills, d.winSide, d.ticks).realizedPnl ?? 0;
        pnl += p;
        if (hedged) { completed++; arb += p; }
        else { naked++; dir += p; (entry[0].side === d.winSide) ? nakedWin++ : nakedLoss++; }
        perWin.push({ ws: d._ws, side: entry[0].side, hedged, p, win: d.winSide });
      }
    }
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  return { locked, completed, naked, nakedWin, nakedLoss, pnl, arb, dir, perWin };
}

const base = { ...STRAT, ...OVER, WINDOW_SEC: WIN, LATENCY_MS: LAT, MERGE_ON: false };
const off = (base.L_HEDGE_MAKER_OFFSET != null) ? +base.L_HEDGE_MAKER_OFFSET : 0.01;
const T = run({ ...base, L_HEDGE_EXEC: "taker" });
const M = run({ ...base, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: off });
const r2 = (x) => Math.round(x * 100) / 100;
const p30 = (x) => r2(x / DAYS * 30);
const pctL = (n, r) => r.locked ? `${(100 * n / r.locked).toFixed(1)}%` : "—";

function line(label, r) {
  console.log(
    `${label.padEnd(16)} locks ${String(r.locked).padStart(4)}  completed ${String(r.completed).padStart(4)} (${pctL(r.completed, r).padStart(5)})  ` +
    `naked ${String(r.naked).padStart(4)} (${pctL(r.naked, r).padStart(5)})  ` +
    `arb $${r.arb.toFixed(0).padStart(6)}  dir $${r.dir.toFixed(0).padStart(6)}  net $${r.pnl.toFixed(0).padStart(6)}  /30d $${p30(r.pnl).toFixed(0).padStart(6)}`
  );
}
console.log("config            locks  completed(arb)     naked(dir)        arb $     dir $     net $     /30d");
console.log("-".repeat(110));
const ME = run({ ...base, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: off, L_HEDGE_EAGER: true });
line("TAKER hedge", T);
line(`MAKER wait −$${off}`, M);
line(`MAKER eager (@cap)`, ME);
console.log(`\nEAGER vs WAIT (place the bid at the cap immediately vs wait for ask ≤ cap, then bid 1¢-under):`);
console.log(`  completions: ${M.completed} → ${ME.completed}  (${ME.completed - M.completed >= 0 ? "+" : ""}${ME.completed - M.completed} sets)`);
console.log(`  net PnL:     $${p30(M.pnl)} → $${p30(ME.pnl)} /30d  (${ME.pnl - M.pnl >= 0 ? "+" : ""}$${p30(ME.pnl - M.pnl)}/30d)`);
console.log(`  → eager catches more collapses but fills near the cap (0.02) vs 0.01 — the trade-off, quantified.`);

// the two questions, separated
const completable = T.completed, makerGot = M.completed;
console.log(`\nHEDGE COMPLETION`);
console.log(`  completable rate (taker) : ${pctL(T.completed, T)}  — how often the loser got cheap enough to complete a set at all`);
console.log(`  maker fill rate          : ${completable ? (100 * makerGot / completable).toFixed(1) + "%" : "—"}  (${makerGot}/${completable})  — of completable sets, how many the resting 1¢ bid actually caught`);
const missed = Math.max(0, completable - makerGot);
console.log(`  maker adverse-selection  : ${missed} sets missed → those rode NAKED instead of banking the arb`);
console.log(`\nMAKER − TAKER PnL: $${r2(M.pnl - T.pnl)} over ${DAYS}d ($${p30(M.pnl - T.pnl)}/30d) — the net cost/benefit of resting the hedge vs taking it`);
console.log(`(the maker hedge trades a fee-free/cheaper fill WHEN it fills against missing ${missed} completable sets to adverse selection)`);

// ── MAKER FILL-RATE SENSITIVITY: sweep TOUCH % — how eagerly the resting bid fills when the loser's ask SITS at it
//    (cross-through fills fully regardless; TOUCH % only governs the at-the-touch queue). 100% = the optimistic
//    ceiling; lower = a realistic queue that catches fewer of the touch-only sets. This parameterises the "sim is
//    optimistic" caveat into an actual curve, WITHOUT needing on-chain data. ──
const touchMs = (base.L_SIM_TOUCH_MS != null) ? +base.L_SIM_TOUCH_MS : 250;
const TO = A.find((a) => /^to=\d+/.test(a)) ? +A.find((a) => /^to=\d+/.test(a)).slice(3) : 2;   // partial-fill timeout to test (s)
console.log(`\nPARTIAL-FILL TIMEOUT — sweep TOUCH % (touchMs=${touchMs}); compare maker OFF vs maker + ${TO}s taker-completion of unfilled makers`);
console.log(`         ───────── timeout OFF ─────────   ──── timeout ${TO}s ────    `);
console.log(`touch%   completed  fill%   net/30d       completed  net/30d    Δ/30d`);
console.log("-".repeat(78));
for (const tp of [100, 40, 25, 15, 8, 4]) {
  const rOff = run({ ...base, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: off, L_SIM_FILL_PCT: tp });
  const rTo = run({ ...base, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: off, L_SIM_FILL_PCT: tp, L_HEDGE_MAKER_TIMEOUT_S: TO });
  const fr = completable ? (100 * rOff.completed / completable) : 0;
  console.log(
    `${String(tp).padStart(4)}     ${String(rOff.completed).padStart(5)}    ${fr.toFixed(1).padStart(5)}%  $${p30(rOff.pnl).toFixed(0).padStart(6)}        ` +
    `${String(rTo.completed).padStart(5)}   $${p30(rTo.pnl).toFixed(0).padStart(6)}   ${((rTo.pnl - rOff.pnl) >= 0 ? "+" : "") + p30(rTo.pnl - rOff.pnl).toFixed(0)}`
  );
}
console.log(`\n→ Δ/30d = the partial-timeout's value. Positive at LOW touch% = it recovers half-hedges the maker queue would`);
console.log(`  otherwise leave lopsided. ~0 at high touch% = few partials to rescue (full fills already dominate).`);
console.log(`\nNote: latency ${LAT}ms is applied to fills; pass a 2nd arg to vary it (0 = optimistic). TOUCH MS via L_SIM_TOUCH_MS=…`);
process.exit(0);
