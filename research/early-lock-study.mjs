// research/early-lock-study.mjs — does an AI-trained EARLY-LOCK model have room to beat the mechanical gate?
//
// The live validation showed the edge leaks at ENTRY: the mechanical rule (|gap| > intensity·√t + edge) only
// fires LATE — when little time is left the possible-move is tiny, so you lock a pricey winner while racing
// 520ms of taker latency, and the profitable locks miss. Any improved signal would need to lock EARLIER — while the
// winner is still liquid + cheap — by predicting "this leader HOLDS to settlement" from early features.
//
// This study measures the ceiling of that idea, so we don't train blind:
//   • hold-rate  — at each early lock-time, how often does the current leader actually win? (the base rate an
//                  AI classifier must beat; if it's already ~90% there's little to learn)
//   • PnL(raw)   — lock EVERY decisive leader early, honest fill at ask + 520ms taker latency (misses count as $0)
//   • PnL(oracle)— lock ONLY the eventual holds (a PERFECT classifier). oracle − raw = the max $ an AI adds.
//   • feature check — does gap-VELOCITY (momentum confirming the lead) separate holds from flips? If yes, there
//                     is real signal to train on; if not, the features are noise and training won't help.
//
// Usage:  node research/early-lock-study.mjs [days=7] [latencyMs=520]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { STRAT, PARAMS } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 7;
const LAT = A[1] != null && !isNaN(+A[1]) ? +A[1] : 520;
const WIN = 300, SIZE = +STRAT.SIZE || 40, FLOOR = +STRAT.L_ENTRY_FLOOR || 0.50, CAP = +STRAT.L_HEDGE_CAP || 0.02;
const FEE = (px, sh) => ((+PARAMS.FEE_BPS || 700) / 10000) * (px * (1 - px)) * sh;   // taker fee, matches engine
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch consecutive windows ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push({ ws, slug: `btc-updown-5m-${ws}` });
console.log(`\nEarly-lock study — btc 5m, ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const { ws, slug } = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length && d?.winSide != null && d?.openBinance != null && d.ticks.some((t) => t.bz != null)) {
        d._ws = ws; d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : "Down"; raw.push(d);
      }
    } catch {}
    if (++done % 1000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(30);
  }
}));
raw.sort((a, b) => a._ws - b._ws);
console.log(`usable windows: ${raw.length}\n`);
if (!raw.length) { console.log("no windows — is the backtest API up with data for this range?"); process.exit(0); }

// helpers on a window's tick array
function gapOf(t, open) { return t.bz - open; }
function askAtLatency(ticks, i, side) {          // winner's ask filled LAT ms after the signal tick i (honest fill)
  const targ = ticks[i].t + LAT / 1000;
  for (let j = i; j < ticks.length; j++) if (ticks[j].t >= targ) return side === "Up" ? ticks[j].upAsk : ticks[j].dnAsk;
  return null;                                   // window ended before the fill landed → MISS
}
function gapVel(ticks, i, open, back = 10) {      // $/s change in gap over the last ~`back` seconds
  const t0 = ticks[i].t - back; let j = i;
  while (j > 0 && ticks[j].t > t0) j--;
  const dt = ticks[i].t - ticks[j].t; if (dt <= 0) return 0;
  return (gapOf(ticks[i], open) - gapOf(ticks[j], open)) / dt;
}

// One early-lock policy over all windows. mult=null ⇒ the CURRENT mechanical gate (|gap|>intensity·√t+edge).
function runPolicy({ tMin, mult }) {
  const buf = makeIntensityBuffer(12);
  let fires = 0, misses = 0, holds = 0, pnlAll = 0, pnlOracle = 0, askSum = 0, hedged = 0;
  let velAlignHold = 0, velAlignN = 0, velOppHold = 0, velOppN = 0;   // feature-signal split
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+STRAT.L_VOL_ROUNDS || 6);
    const intensity = ready ? computeIntensity(buf.ex, STRAT) : null;
    if (ready) {
      const T = d.ticks, open = d.openBinance;
      for (let i = 0; i < T.length; i++) {
        const t = T[i].t; if (t < tMin) continue;
        const secsLeft = WIN - t; if (secsLeft <= (+STRAT.L_SKIP_END_S || 5)) break;
        const gap = gapOf(T[i], open), ag = Math.abs(gap);
        const bar = mult == null
          ? intensity * Math.sqrt(Math.max(0, secsLeft) / WIN) + (+STRAT.L_EDGE_BUFFER || 0)   // current gate
          : mult * intensity;                                                                   // early: fixed × vol
        if (ag < bar) continue;
        const winner = gap > 0 ? "Up" : "Down";
        const entryAsk = askAtLatency(T, i, winner);
        if (entryAsk == null) { misses++; fires++; break; }        // signal fired but no fill landed = live MISS ($0)
        if (entryAsk < FLOOR) break;                               // coin-flip zone → the gate would skip too
        // naked settle
        const hold = winner === d.winSide;
        let pnl = SIZE * (hold ? 1 - entryAsk : -entryAsk) - FEE(entryAsk, SIZE);
        // opportunistic hedge: first later tick where the loser is ≤ cap → complete the $1-set
        const loser = winner === "Up" ? "Down" : "Up";
        for (let j = i + 1; j < T.length; j++) {
          const la = loser === "Up" ? T[j].upAsk : T[j].dnAsk;
          if (la != null && la <= CAP) { const lf = askAtLatency(T, j, loser);
            if (lf != null && lf <= CAP) { pnl = SIZE * (1 - entryAsk - lf) - FEE(entryAsk, SIZE) - FEE(lf, SIZE); hedged++; }
            break; }
        }
        fires++; askSum += entryAsk; if (hold) { holds++; pnlOracle += pnl; }
        pnlAll += pnl;
        // feature check: is gap-velocity ALIGNED with the lead (momentum confirms) predictive of holding?
        const v = gapVel(T, i, open); const aligned = (v * gap) > 0;
        if (aligned) { velAlignN++; if (hold) velAlignHold++; } else { velOppN++; if (hold) velOppHold++; }
        break;                                                     // one lock per window
      }
    }
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  const p30 = (x) => x / DAYS * 30;
  return { fires, misses, holds, pnlAll, pnlOracle, askSum, hedged,
           holdRate: fires ? holds / fires : 0, avgAsk: fires ? askSum / fires : 0,
           p30All: p30(pnlAll), p30Oracle: p30(pnlOracle), aiRoom: p30(pnlOracle - pnlAll),
           velAlignHold, velAlignN, velOppHold, velOppN };
}

function line(label, r) {
  console.log(
    `${label.padEnd(22)} fire ${String(r.fires).padStart(4)}  miss ${String(r.misses).padStart(3)}  ` +
    `hold ${(100 * r.holdRate).toFixed(1).padStart(5)}%  avgAsk ${r.avgAsk.toFixed(3)}  hedged ${String(r.hedged).padStart(4)}  ` +
    `raw/30d $${r.p30All.toFixed(0).padStart(6)}  oracle/30d $${r.p30Oracle.toFixed(0).padStart(6)}  AIroom $${r.aiRoom.toFixed(0).padStart(6)}`
  );
}

console.log("policy                 fires  miss  holdRate  avgAsk  hedged  raw/30d   oracle/30d  AIroom(perfect-classifier gain)");
console.log("-".repeat(132));
line("CURRENT gate (late)", runPolicy({ tMin: 60, mult: null }));
console.log("-- EARLIER locks: fire at first tick past tMin where |gap| ≥ mult × intensity --");
for (const tMin of [60, 120, 180]) {
  for (const mult of [0.6, 0.9, 1.2]) line(`t≥${tMin}s  |gap|≥${mult}σ`, runPolicy({ tMin, mult }));
}

// feature-signal readout on a representative early cell (t≥120, 0.9σ)
const fc = runPolicy({ tMin: 120, mult: 0.9 });
const ah = fc.velAlignN ? 100 * fc.velAlignHold / fc.velAlignN : 0;
const oh = fc.velOppN ? 100 * fc.velOppHold / fc.velOppN : 0;
console.log("\nFEATURE SIGNAL (t≥120s, 0.9σ cell) — does gap-velocity separate holds from flips?");
console.log(`  momentum ALIGNED with lead: hold ${ah.toFixed(1)}%  (n=${fc.velAlignN})`);
console.log(`  momentum AGAINST the lead:  hold ${oh.toFixed(1)}%  (n=${fc.velOppN})`);
console.log(`  → velocity edge = ${(ah - oh).toFixed(1)} pts. ${Math.abs(ah - oh) >= 5 ? "REAL signal — a classifier has something to learn." : "weak — this feature alone won't carry a model."}`);
console.log(`\n(raw/30d = lock every decisive leader · oracle/30d = a PERFECT hold-classifier · AIroom = the max /30d a model could add over raw)`);
process.exit(0);
