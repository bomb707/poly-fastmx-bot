// research/train-holdmodel.mjs — WALK-FORWARD sweep for the leader-holds classifier. Arbiter BEFORE any wiring.
//
// Per window we extract ONE early-lock decision (first tick past tMin with |gap|≥bar·σ): its feature vector, the
// label (did the leader hold), the early-lock PnL if taken, and the mechanical-gate PnL for the same window.
// Then WALK FORWARD: train logreg on past windows only, test on the next block. On each test window the model
// either (a) locks EARLY when EV(P(hold), ask) ≥ margin, or (b) FALLS BACK to the mechanical late gate. So the
// model can only ADD over pure-mechanical. We report OOS model PnL vs mechanical PnL over the SAME test windows.
//
// Usage:  node research/train-holdmodel.mjs [days=30] [latencyMs=520]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { STRAT, PARAMS } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";
import { FEATURES, buildFeatures, scoreHold, lockEV } from "../engine/holdmodel.js";
import fs from "fs";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 30;
const LAT = A[1] != null && !isNaN(+A[1]) ? +A[1] : 520;
const WIN = 300, SIZE = +STRAT.SIZE || 40, FLOOR = +STRAT.L_ENTRY_FLOOR || 0.50, CAP = +STRAT.L_HEDGE_CAP || 0.02;
const EDGE = +STRAT.L_EDGE_BUFFER || 8, SKIP = +STRAT.L_SKIP_END_S || 5;
const feeFrac = (px) => ((+PARAMS.FEE_BPS || 700) / 10000) * (px * (1 - px));      // fee per share
const FEE = (px, sh) => feeFrac(px) * sh;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fetch consecutive windows ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push({ ws, slug: `btc-updown-5m-${ws}` });
console.log(`\nHold-model walk-forward sweep — btc 5m, ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
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
    if (++done % 2000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(25);
  }
}));
raw.sort((a, b) => a._ws - b._ws);
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 400) { console.log("too few windows for a walk-forward split."); process.exit(0); }

// ── tick helpers ──
const gapOf = (t, open) => t.bz - open;
function askAtLat(T, i, side) { const targ = T[i].t + LAT / 1000; for (let j = i; j < T.length; j++) if (T[j].t >= targ) return side === "Up" ? T[j].upAsk : T[j].dnAsk; return null; }
function velBack(T, i, open, back) { const t0 = T[i].t - back; let j = i; while (j > 0 && T[j].t > t0) j--; const dt = T[i].t - T[j].t; return dt > 0 ? (gapOf(T[i], open) - gapOf(T[j], open)) / dt : 0; }
// settle an early lock at tick i on `winner`: naked, or complete the set if the loser later dips ≤ cap. latency-honest.
function lockOutcome(T, i, open, winner, winSide, entryAsk) {
  const hold = winner === winSide;
  let pnl = SIZE * (hold ? 1 - entryAsk : -entryAsk) - FEE(entryAsk, SIZE);
  const loser = winner === "Up" ? "Down" : "Up";
  for (let j = i + 1; j < T.length; j++) {
    const la = loser === "Up" ? T[j].upAsk : T[j].dnAsk;
    if (la != null && la <= CAP) { const lf = askAtLat(T, j, loser); if (lf != null && lf <= CAP) pnl = SIZE * (1 - entryAsk - lf) - FEE(entryAsk, SIZE) - FEE(lf, SIZE); break; }
  }
  return { hold, pnl };
}

// ── build per-window records: the early candidate (feats+label+pnl) and the mechanical-gate pnl ──
function buildRecords(tMin, barMult) {
  const buf = makeIntensityBuffer(12); const recs = [];
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+STRAT.L_VOL_ROUNDS || 6);
    const I = ready ? computeIntensity(buf.ex, STRAT) : null;
    if (ready) {
      const T = d.ticks, open = d.openBinance, hour = new Date(d._ws * 1000).getUTCHours();
      let early = null, mech = null;
      for (let i = 0; i < T.length; i++) {
        const t = T[i].t, secsLeft = WIN - t; if (secsLeft <= SKIP) break;
        const gap = gapOf(T[i], open), ag = Math.abs(gap); if (ag < 1e-9) continue;
        const winner = gap > 0 ? "Up" : "Down";
        // EARLY candidate (first tick past tMin with |gap| ≥ barMult·σ, winner ask ≥ floor)
        if (!early && t >= tMin && ag >= barMult * I) {
          const ea = askAtLat(T, i, winner);
          if (ea == null) early = { miss: true };
          else if (ea >= FLOOR) {
            const o = lockOutcome(T, i, open, winner, d.winSide, ea);
            const ctx = { gap, intensity: I, winnerAsk: ea, loserAsk: winner === "Up" ? T[i].dnAsk : T[i].upAsk,
                          cl: T[i].cl, open, secsLeft, win: WIN, winHour: hour,
                          v10: velBack(T, i, open, 10), v30: velBack(T, i, open, 30) };
            early = { feats: buildFeatures(ctx), label: o.hold ? 1 : 0, ask: ea, pnl: o.pnl };
          }
        }
        // MECHANICAL gate (|gap| > σ·√t + edge) — its own (later) tick
        if (!mech) {
          const bar = I * Math.sqrt(Math.max(0, secsLeft) / WIN) + EDGE;
          if (ag >= bar) { const ma = askAtLat(T, i, winner); if (ma != null && ma >= FLOOR) { const o = lockOutcome(T, i, open, winner, d.winSide, ma); mech = { pnl: o.pnl }; } }
        }
        if (early && mech) break;
      }
      recs.push({ ws: d._ws, early, mech });
    }
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  return recs;
}

// ── logreg (standardized, L2). balance=false → CALIBRATED probabilities (P(hold) reflects the true base rate,
//    so a probability threshold τ is meaningful); balance=true only if we ever want a ranking model. ──
function trainLogreg(X, y, { iters = 500, lr = 0.4, l2 = 1.0, balance = false } = {}) {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.reduce((s, v) => s + v, 0) || 1, neg = (n - pos) || 1;
  const wp = balance ? n / (2 * pos) : 1, wn = balance ? n / (2 * neg) : 1;
  let w = Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-z)), cw = y[i] ? wp : wn, g = cw * (p - y[i]);
      for (let j = 0; j < d; j++) gw[j] += g * Z[i][j]; gb += g;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n); b -= lr * gb / n;
  }
  return { mean, std, weights: w, bias: b };
}
function auc(scored) {                                                 // scored: [{p,label}]
  const pos = scored.filter((s) => s.label), neg = scored.filter((s) => !s.label);
  if (!pos.length || !neg.length) return 0.5; let c = 0;
  for (const a of pos) for (const b of neg) c += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return c / (pos.length * neg.length);
}

// ── walk-forward evaluation of one (tMin, barMult, τ) config ──
//   On each test window: if the model is confident early (P(hold) ≥ τ) it locks EARLY (cheap ask); else it falls
//   back to the mechanical late gate. VALUE-ADD (delta) is measured WITHIN-window: Σ over model-early-locked
//   windows of (early.pnl − whatMechanicalWouldHaveGot) — so the number doesn't depend on the absolute baseline.
function evalConfig(recs, { tMin, barMult, tau, l2 }) {
  const N = recs.length, folds = 4, half = Math.floor(N / 2), block = Math.floor((N - half) / folds);
  let mdl = 0, mech = 0, delta = 0, nEarly = 0, nFallback = 0, nMiss = 0, wins = 0, losses = 0;
  const scored = []; let pSum = 0, pN = 0;
  for (let k = 0; k < folds; k++) {
    const teLo = half + k * block, teHi = k === folds - 1 ? N : half + (k + 1) * block;
    const train = recs.slice(0, teLo).filter((r) => r.early && !r.early.miss && r.early.feats);
    if (train.length < 50) continue;
    const model = trainLogreg(train.map((r) => r.early.feats), train.map((r) => r.early.label), { l2 });
    for (let i = teLo; i < teHi; i++) {
      const r = recs[i], mechPnl = r.mech ? r.mech.pnl : 0;
      mech += mechPnl;
      if (r.early && !r.early.miss && r.early.feats) {
        const p = scoreHold(model, r.early.feats); scored.push({ p, label: r.early.label }); pSum += p; pN++;
        if (p >= tau) {                                                 // confident → lock EARLY
          mdl += r.early.pnl; delta += r.early.pnl - mechPnl; nEarly++;
          if (r.early.pnl > 0) wins++; else if (r.early.pnl < 0) losses++;
          continue;
        }
      } else if (r.early && r.early.miss) nMiss++;
      mdl += mechPnl; if (r.mech) nFallback++;                          // fallback to mechanical
    }
  }
  const p30 = (x) => x / (DAYS / 2) * 30;                              // test spans ~half the days
  return { tMin, barMult, tau, mdl30: p30(mdl), mech30: p30(mech), delta30: p30(delta),
           nEarly, nFallback, nMiss, wins, losses, auc: auc(scored), pMed: pN ? pSum / pN : 0,
           earlyWR: (wins + losses) ? 100 * wins / (wins + losses) : 0 };
}

// ── SWEEP ──
console.log("Sweeping early-lock hold-model configs (walk-forward, 4 folds over the last half)…");
console.log("Δ/30d = within-window value-add (early.pnl − whatMechanicalGot) over the windows the model locked early.\n");
console.log("tMin  bar    τ     OOS model/30d   mech/30d    Δ/30d      earlyLocks(WR)   fallback  medP   AUC");
console.log("-".repeat(110));
const results = [];
for (const tMin of [60, 120]) {
  for (const barMult of [0.6, 0.9]) {
    const recs = buildRecords(tMin, barMult);
    for (const tau of [0.80, 0.88, 0.92, 0.95, 0.97]) {
      const r = evalConfig(recs, { tMin, barMult, tau, l2: 1.0 });
      results.push({ ...r, recs });
      console.log(
        `${String(tMin).padStart(3)}  ${barMult.toFixed(1)}  ${tau.toFixed(2)}   ` +
        `$${r.mdl30.toFixed(0).padStart(8)}    $${r.mech30.toFixed(0).padStart(8)}   ` +
        `$${r.delta30.toFixed(0).padStart(7)}   ${String(r.nEarly).padStart(5)} (${r.earlyWR.toFixed(0).padStart(3)}%)   ` +
        `${String(r.nFallback).padStart(6)}  ${r.pMed.toFixed(3)}  ${r.auc.toFixed(3)}`
      );
    }
  }
}

// viable = beats mechanical OOS (Δ>0), enough early locks to matter, and a non-losing early leg
const viable = results.filter((r) => r.delta30 > 0 && r.nEarly >= 20 && r.earlyWR >= 50);
viable.sort((a, b) => b.delta30 - a.delta30);
console.log("\n" + "-".repeat(110));
if (!viable.length) {
  console.log("VERDICT: NO config adds value out-of-sample (Δ>0 with ≥20 early locks). Do NOT integrate.");
  const best = results.filter((r) => r.nEarly >= 20).sort((a, b) => b.delta30 - a.delta30)[0];
  if (best) console.log(`  (least-bad with volume: tMin ${best.tMin}, bar ${best.barMult}σ, τ ${best.tau} → Δ $${best.delta30.toFixed(0)}/30d, ${best.nEarly} locks @ ${best.earlyWR.toFixed(0)}% WR)`);
} else {
  const b = viable[0];
  console.log(`VERDICT: best OOS config → tMin ${b.tMin}, bar ${b.barMult}σ, τ ${b.tau}`);
  console.log(`  +$${b.delta30.toFixed(0)}/30d value-add OOS · ${b.nEarly} early locks @ ${b.earlyWR.toFixed(0)}% WR · AUC ${b.auc.toFixed(3)} · median P(hold) ${b.pMed.toFixed(3)}`);
  const train = b.recs.filter((r) => r.early && !r.early.miss && r.early.feats);
  const model = trainLogreg(train.map((r) => r.early.feats), train.map((r) => r.early.label), { l2: 1.0 });
  const out = { features: FEATURES, ...model, tMin: b.tMin, barMult: b.barMult, tau: b.tau,
                trainedOn: `${DAYS}d/${raw.length}w`, latencyMs: LAT, note: "leader-holds logreg; NOT yet wired — pending approval" };
  fs.writeFileSync("research/holdmodel.json", JSON.stringify(out, null, 2));
  console.log("  → exported research/holdmodel.json (NOT wired into the engine).");
}
process.exit(0);
