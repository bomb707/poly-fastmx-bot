// research/twap-edge-study.mjs — is there a near-deterministic edge in the CHAINLINK-TWAP settlement lag?
//
// Polymarket settles BTC 5m on the Chainlink 60s TWAP stream (btc-usd-twap-60s-streams) — per the actual market
// rules: "Up if the TWAP of the range ≥ the price at the beginning of the range." A TWAP is inertial: it can only
// follow spot at a bounded rate, so a LARGE TWAP gap with LITTLE time left can be mechanically unable to cross zero
// before close → the outcome is locked while the market may still price it as live. RTDS has no history and no API
// carries a TWAP field, so we RECONSTRUCT the TWAP from the per-tick Chainlink price (`cl`) and test the hypothesis.
//
// Reports (1) DETERMINISM grid: win-rate (TWAP-leader == winSide) by |TWAP-gap| × time-left, (2) the locked region
// (win-rate ≥ 99%) and how cheap the leader's ask is there = the EDGE, (3) a buy-the-leader-in-the-locked-region PnL.
//
// Usage:  node research/twap-edge-study.mjs [days=14] [twapWindowSec=30] [latencyMs=500]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 14;
const TWAP_W = A[1] != null && !isNaN(+A[1]) ? +A[1] : 60;     // TWAP lookback (s). BTC 5m settles on the 60s TWAP stream
const LAT = A[2] != null && !isNaN(+A[2]) ? +A[2] : 500;
const WIN = 300, SIZE = 50, FEE_BPS = 700;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch windows ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push(`btc-updown-5m-${ws}`);
console.log(`\nTWAP-edge study — btc 5m, ${DAYS}d, TWAP ${TWAP_W}s, latency ${LAT}ms, ${slugs.length} windows`);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const slug = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length > 20 && d?.winSide != null && d?.openPrice > 0 && d.ticks.some((t) => t.cl != null)) {
        d.winUp = String(d.winSide).toLowerCase() === "up" ? 1 : 0; raw.push(d);
      }
    } catch {}
    if (++done % 2000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(25);
  }
}));
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 200) { console.log("too few windows."); process.exit(0); }

// reconstruct the TWAP(t) = trailing mean of cl over [t−TWAP_W, t]; also carry Binance spot velocity (the FAST price
//   the MARKET watches) to test the reverting-spot edge. Returns per-tick rows.
const VELW = 10;   // spot-velocity lookback (s)
function twapRows(d) {
  const T = d.ticks.filter((x) => x.t >= 0 && x.t <= WIN && x.cl > 0 && Number.isFinite(x.cl));
  if (T.length < 10) return [];
  const open = d.openPrice, out = [];
  let lo = 0, vlo = 0;
  for (let i = 0; i < T.length; i++) {
    while (T[lo].t < T[i].t - TWAP_W) lo++;                    // TWAP window [t−W, t]
    let sum = 0; for (let j = lo; j <= i; j++) sum += T[j].cl;
    const twap = sum / (i - lo + 1);
    while (T[vlo].t < T[i].t - VELW) vlo++;                    // Binance spot velocity over the last VELW s
    const bzNow = T[i].bz, bzPrev = T[vlo].bz, dt = T[i].t - T[vlo].t;
    const bzVel = (bzNow != null && bzPrev != null && dt > 0) ? (bzNow - bzPrev) / dt : 0;
    out.push({ t: T[i].t, twapGap: twap - open, ua: T[i].upAsk, da: T[i].dnAsk, bzVel });
  }
  return out;
}

// ── DETERMINISM grid + locked-region edge ──
const gapEdges = [0, 5, 10, 20, 40, 80, 1e9];                 // |TWAP-gap| $ buckets
const leftEdges = [0, 30, 60, 120, 180, 300];                // secs-left buckets (low = late)
const gLbl = ["0-5", "5-10", "10-20", "20-40", "40-80", "80+"];
const lLbl = ["0-30", "30-60", "60-120", "120-180", "180-300"];
const grid = leftEdges.slice(0, -1).map(() => gapEdges.slice(0, -1).map(() => ({ n: 0, win: 0, askSum: 0 })));
const gi = (g) => { for (let i = 0; i < gapEdges.length - 1; i++) if (g >= gapEdges[i] && g < gapEdges[i + 1]) return i; return 0; };
const li = (s) => { for (let i = 0; i < leftEdges.length - 1; i++) if (s >= leftEdges[i] && s < leftEdges[i + 1]) return i; return leftEdges.length - 2; };

// per-window: also simulate "lock the TWAP-leader at the FIRST tick in a locked cell" for a PnL read
const feeFrac = (px) => (FEE_BPS / 10000) * px * (1 - px);
let ranWins = 0;

for (const d of raw) {
  const rows = twapRows(d); if (!rows.length) continue;
  for (const r of rows) {
    const ag = Math.abs(r.twapGap), secsLeft = WIN - r.t;
    if (r.ua == null || r.da == null) continue;
    const leaderUp = r.twapGap > 0;
    const cell = grid[li(secsLeft)][gi(ag)];
    cell.n++; if (leaderUp === (d.winUp === 1)) cell.win++;
    cell.askSum += leaderUp ? r.ua : r.da;                    // the leader's ask (what you'd pay to buy the near-certain side)
  }
}

console.log("DETERMINISM — win-rate that the TWAP-leader (sign of gap) == actual winner, by |TWAP-gap $| × secs-left:");
console.log("secs-left \\ gap   " + gLbl.map((s) => s.padStart(9)).join(""));
for (let l = 0; l < grid.length; l++) {
  let row = lLbl[l].padEnd(16);
  for (let g = 0; g < grid[l].length; g++) { const c = grid[l][g];
    row += (c.n ? `${(100 * c.win / c.n).toFixed(0)}%/${c.n}`.padStart(9) : "·".padStart(9)); }
  console.log(row);
}
console.log("\nLEADER ASK (avg) in each cell — how cheap the near-certain side is priced (edge = 1 − ask when win% ≈ 100):");
console.log("secs-left \\ gap   " + gLbl.map((s) => s.padStart(9)).join(""));
for (let l = 0; l < grid.length; l++) {
  let row = lLbl[l].padEnd(16);
  for (let g = 0; g < grid[l].length; g++) { const c = grid[l][g];
    row += (c.n ? (c.askSum / c.n).toFixed(3).padStart(9) : "·".padStart(9)); }
  console.log(row);
}

// LOCKED REGION: cells with win-rate ≥ 99% and ≥30 samples → the deterministic edge. Report avg ask + implied edge.
let lockN = 0, lockWin = 0, lockAsk = 0;
for (let l = 0; l < grid.length; l++) for (let g = 0; g < grid[l].length; g++) { const c = grid[l][g];
  if (c.n >= 30 && c.win / c.n >= 0.99) { lockN += c.n; lockWin += c.win; lockAsk += c.askSum; } }
console.log(`\nLOCKED REGION (cells ≥99% win, ≥30 samples): ${lockN} tick-observations · win-rate ${lockN ? (100 * lockWin / lockN).toFixed(2) : "—"}% · avg leader ask ${lockN ? (lockAsk / lockN).toFixed(3) : "—"}`);
if (lockN) {
  const avgAsk = lockAsk / lockN;
  console.log(`  → implied edge = 1 − ${avgAsk.toFixed(3)} − fee ≈ $${(1 - avgAsk - feeFrac(avgAsk)).toFixed(3)}/share IF the leader is bought at that ask and the region is truly locked.`);
  console.log(`  (These are per-TICK observations, not trades — a real strategy locks once/window. Next step wires this as a lock rule + realistic fill, like Lockstep.)`);
}
// ── REVERTING-SPOT EDGE: in high-gap / low-time cells, does a REVERTING spot (Binance moving toward the open,
//    opposite the gap) get a CHEAPER leader ask while the TWAP still can't cross in time? That's the user's edge. ──
console.log(`\nREVERTING-SPOT EDGE — near-locked region, split by whether Binance spot is reverting (toward a 0-cross) vs extending:`);
console.log(`region              side        n     win%   avg ask   EV/share (buy leader)`);
console.log("-".repeat(78));
for (const [gThr, lThr] of [[40, 30], [40, 60], [20, 30], [80, 120]]) {
  const acc = { rev: { n: 0, win: 0, ask: 0 }, ext: { n: 0, win: 0, ask: 0 } };
  for (const d of raw) for (const r of twapRows(d)) {
    const ag = Math.abs(r.twapGap), secsLeft = WIN - r.t;
    if (ag < gThr || secsLeft > lThr || r.ua == null || r.da == null) continue;
    const leaderUp = r.twapGap > 0, ask = leaderUp ? r.ua : r.da, won = leaderUp === (d.winUp === 1);
    const a = (r.bzVel * r.twapGap) < 0 ? acc.rev : acc.ext;   // spot moving opposite the gap = toward a cross
    a.n++; if (won) a.win++; a.ask += ask;
  }
  for (const [k, a] of [["reverting", acc.rev], ["extending", acc.ext]]) {
    if (!a.n) continue; const wr = a.win / a.n, avg = a.ask / a.n;
    const ev = wr * (1 - avg) - (1 - wr) * avg - feeFrac(avg);
    console.log(`gap≥$${gThr} ≤${lThr}s`.padEnd(20) + `${k.padEnd(10)} ${String(a.n).padStart(6)}  ${(100 * wr).toFixed(1).padStart(5)}%  ${avg.toFixed(3).padStart(7)}   ${(ev >= 0 ? "+" : "") + "$" + ev.toFixed(3)}`);
  }
}
console.log(`\n→ EDGE if the REVERTING row has HIGHER EV/share than extending — market discounts the leader for the falling spot,`);
console.log(`  but the TWAP can't actually cross in time. A NEGATIVE reverting EV = the discount is justified (it does cross).`);
console.log(`\nRead: a cell at high gap + low secs-left with win% ≈ 100 AND ask < ~0.98 = a TWAP-lag edge (near-certain, underpriced).`);
console.log(`TWAP reconstructed from per-tick Chainlink 'cl' (approximation of Chainlink's official ${TWAP_W}s TWAP — exact sampling not published). Latency ${LAT}ms not yet applied (determinism study). winSide = the true settlement.`);
process.exit(0);
