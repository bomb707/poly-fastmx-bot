// research/lockstep-twap-signal.mjs — should Lockstep lock on the BINANCE gap (current) or the 60s-TWAP gap (what
// actually settles)? Lockstep locks the sign(gap) leader but settles on the Chainlink 60s TWAP — a signal/settlement
// mismatch. This runs the SAME engine two ways and compares wrong-side locks (leader ≠ winner) + PnL.
//
// Trick: reuse simulateFills unchanged by swapping the tick's `bz` → the reconstructed TWAP and openBinance → the
// Chainlink open, so the engine's gap = TWAP − open = the settlement gap. Intensity comes from each series' own
// excursions (Binance vol for the baseline, TWAP vol for the variant).
//
// Usage:  node research/lockstep-twap-signal.mjs [days=14] [latencyMs=500] [twapWindowSec=60] [key=val ...]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 14;
const LAT = A[1] != null && !isNaN(+A[1]) ? +A[1] : 500;
const TWAP_W = A[2] != null && !isNaN(+A[2]) ? +A[2] : 60;
const OVER = {}; for (const a of A.slice(3)) { const [k, v] = a.split("="); if (k && v != null) OVER[k] = isNaN(+v) ? v : +v; }
const WIN = 300;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push(`btc-updown-5m-${ws}`);
console.log(`\nLockstep signal: Binance-gap vs ${TWAP_W}s-TWAP-gap — ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const slug = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length > 20 && d?.winSide != null && d?.openBinance != null && d?.openPrice > 0 &&
          d.ticks.some((t) => t.bz != null) && d.ticks.some((t) => t.cl != null)) {
        d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : "Down"; raw.push(d);
      }
    } catch {}
    if (++done % 2000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(25);
  }
}));
raw.sort((a, b) => (Number(a.slug?.split("-").pop()) || 0) - (Number(b.slug?.split("-").pop()) || 0));
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 200) { console.log("too few windows."); process.exit(0); }

// build a TWAP-gap "view" of a window: bz ← trailing 60s-mean of cl, openBinance ← Chainlink open.
function twapView(d) {
  const T = d.ticks, out = [];
  let lo = 0, sum = 0, cnt = 0; const clAt = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    if (t.cl > 0 && Number.isFinite(t.cl)) { clAt.push({ t: t.t, cl: t.cl }); }
    // trailing mean over [t-TWAP_W, t]
    while (clAt.length && clAt[0].t < t.t - TWAP_W) clAt.shift();
    const twap = clAt.length ? clAt.reduce((s, x) => s + x.cl, 0) / clAt.length : (t.cl || null);
    out.push({ ...t, bz: twap });   // swap bz → TWAP; upAsk/dnAsk/t/cl preserved
  }
  return { ...d, ticks: out, openBinance: d.openPrice };   // gap = TWAP − chainlink open
}

const base = { ...STRAT, ...OVER, WINDOW_SEC: WIN, LATENCY_MS: LAT, MERGE_ON: false, L_HEDGE_EXEC: "maker" };
// TWAP moves LESS than Binance spot, so the same $ edge locks less. Sweep the TWAP variant's edge to normalize
// lock-count against the Binance baseline → fair PnL comparison. Binance stays at its configured edge.
const BZ_EDGE = +base.L_EDGE_BUFFER;
const TW_EDGES = String(OVER.TW_EDGES || "8,6,5,4,3,2").split(",").map(Number).filter((x) => x > 0);

function mk() { return { locks: 0, wrong: 0, pnl: 0, arb: 0, dir: 0, hedged: 0 }; }
function runVariant(useTwap, edge) {
  const buf = makeIntensityBuffer(12), a = mk();
  const cfg = { ...base, L_EDGE_BUFFER: edge };
  for (const d of raw) {
    const dd = useTwap ? twapView(d) : d;
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+STRAT.L_VOL_ROUNDS || 6);
    dd.intensity = ready ? computeIntensity(buf.ex, cfg) : null;
    if (ready) {
      const fills = simulateFills(dd, cfg);
      const entry = fills.filter((f) => f.leg === "entry");
      if (entry.length) {
        a.locks++;
        if (entry[0].side !== d.winSide) a.wrong++;       // WRONG-SIDE lock (leader ≠ actual winner)
        const p = positionFromFills(fills, d.winSide, d.ticks).realizedPnl ?? 0; a.pnl += p;
        if (fills.some((f) => f.leg === "hedge")) { a.hedged++; a.arb += p; } else a.dir += p;
      }
    }
    pushExcursion(buf, roundExcursion(dd.ticks.map((t) => t.bz), dd.openBinance));
  }
  return a;
}

const p30 = (x) => Math.round(x / DAYS * 30);
const row = (lbl, a) => { const wr = a.locks ? (100 * a.wrong / a.locks).toFixed(1) : "—";
  console.log(`${lbl.padEnd(20)} ${String(a.locks).padStart(5)}   ${String(a.wrong).padStart(4)} (${wr.padStart(4)}%)   $${String(p30(a.pnl)).padStart(7)}   $${String(p30(a.arb)).padStart(5)}   $${String(p30(a.dir)).padStart(6)}   ${a.hedged}`); };

console.log("signal / edge         locks   wrong-side     net/30d    arb $    dir $     hedged");
console.log("-".repeat(82));
row(`BINANCE gap  e=$${BZ_EDGE}`, runVariant(false, BZ_EDGE));    // the current live baseline
console.log("-".repeat(82));
for (const e of TW_EDGES) row(`TWAP-${TWAP_W}s gap e=$${e}`, runVariant(true, e));
console.log(`\nwrong-side = locked leader (sign of gap) ≠ actual winner. Lower = fewer flipped locks (the accuracy win).`);
console.log(`Compare the TWAP row whose lock-count ≈ the Binance baseline (${BZ_EDGE}$): same volume, then net/wrong-side is apples-to-apples.`);
console.log(`Window: last ${DAYS}d = post-TWAP-60s-go-live (Aug 7 2026). Latency ${LAT}ms. winSide from bapi settlement.`);
process.exit(0);
