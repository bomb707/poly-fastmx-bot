// research/veto-holdmodel.mjs — WALK-FORWARD test of the hold-model as a VETO (not an early-lock trigger).
//
// The early-lock use failed (asymmetric payoff). This flips the model's role: KEEP the mechanical gate's timing,
// but at the mechanical lock tick score P(hold) and SKIP the round if P(hold) < τ. The bet: the model can flag
// the mechanical gate's LOSERS (flips + dead-arb) and vetoing them lifts PnL — without vetoing too many winners.
//
// Value-add (delta) = Σ over VETOED windows of (0 − mech.pnl) = we gain exactly the losses we skipped (minus any
// winners we wrongly skipped). Positive Δ ⇒ the vetoed windows were net-negative ⇒ the veto earns its place.
//
// Usage:  node research/veto-holdmodel.mjs [days=30] [latencyMs=520]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { STRAT, PARAMS } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";
import { FEATURES, buildFeatures, scoreHold } from "../engine/holdmodel.js";
import fs from "fs";

const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 30;
const LAT = A[1] != null && !isNaN(+A[1]) ? +A[1] : 520;
const WIN = 300, SIZE = +STRAT.SIZE || 40, FLOOR = +STRAT.L_ENTRY_FLOOR || 0.50, CAP = +STRAT.L_HEDGE_CAP || 0.02;
const EDGE = +STRAT.L_EDGE_BUFFER || 8, SKIP = +STRAT.L_SKIP_END_S || 5;
const feeFrac = (px) => ((+PARAMS.FEE_BPS || 700) / 10000) * (px * (1 - px));
const FEE = (px, sh) => feeFrac(px) * sh;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600, end = nowA - WIN;
const slugs = []; for (let ws = start; ws < end; ws += WIN) slugs.push({ ws, slug: `btc-updown-5m-${ws}` });
console.log(`\nHold-model VETO test — btc 5m, ${DAYS}d, latency ${LAT}ms, ${slugs.length} windows`);
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
if (raw.length < 400) { console.log("too few windows."); process.exit(0); }

const gapOf = (t, open) => t.bz - open;
function askAtLat(T, i, side) { const targ = T[i].t + LAT / 1000; for (let j = i; j < T.length; j++) if (T[j].t >= targ) return side === "Up" ? T[j].upAsk : T[j].dnAsk; return null; }
function velBack(T, i, open, back) { const t0 = T[i].t - back; let j = i; while (j > 0 && T[j].t > t0) j--; const dt = T[i].t - T[j].t; return dt > 0 ? (gapOf(T[i], open) - gapOf(T[j], open)) / dt : 0; }
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

// per-window MECHANICAL lock: features at the gate tick + label + pnl
function buildRecords() {
  const buf = makeIntensityBuffer(12); const recs = [];
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+STRAT.L_VOL_ROUNDS || 6);
    const I = ready ? computeIntensity(buf.ex, STRAT) : null;
    if (ready) {
      const T = d.ticks, open = d.openBinance, hour = new Date(d._ws * 1000).getUTCHours();
      for (let i = 0; i < T.length; i++) {
        const t = T[i].t, secsLeft = WIN - t; if (secsLeft <= SKIP) break;
        const gap = gapOf(T[i], open), ag = Math.abs(gap); if (ag < 1e-9) continue;
        const bar = I * Math.sqrt(Math.max(0, secsLeft) / WIN) + EDGE;
        if (ag >= bar) {
          const winner = gap > 0 ? "Up" : "Down", ma = askAtLat(T, i, winner);
          if (ma != null && ma >= FLOOR) {
            const o = lockOutcome(T, i, open, winner, d.winSide, ma);
            const ctx = { gap, intensity: I, winnerAsk: ma, loserAsk: winner === "Up" ? T[i].dnAsk : T[i].upAsk,
                          cl: T[i].cl, open, secsLeft, win: WIN, winHour: hour, v10: velBack(T, i, open, 10), v30: velBack(T, i, open, 30) };
            recs.push({ ws: d._ws, feats: buildFeatures(ctx), label: o.hold ? 1 : 0, ask: ma, pnl: o.pnl });
          }
          break;
        }
      }
    }
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  return recs;
}

function trainLogreg(X, y, { iters = 500, lr = 0.4, l2 = 1.0 } = {}) {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  let w = Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-z)), g = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += g * Z[i][j]; gb += g;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j] / n); b -= lr * gb / n;
  }
  return { mean, std, weights: w, bias: b };
}
function auc(s) { const pos = s.filter((x) => x.label), neg = s.filter((x) => !x.label); if (!pos.length || !neg.length) return 0.5; let c = 0; for (const a of pos) for (const b of neg) c += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0; return c / (pos.length * neg.length); }

const recs = buildRecords();
console.log(`mechanical locks: ${recs.length} · base hold-rate ${(100 * recs.reduce((s, r) => s + r.label, 0) / recs.length).toFixed(1)}% · total mech PnL $${recs.reduce((s, r) => s + r.pnl, 0).toFixed(0)}\n`);

// walk-forward veto sweep
function evalVeto(tau) {
  const N = recs.length, folds = 4, half = Math.floor(N / 2), block = Math.floor((N - half) / folds);
  let pure = 0, kept = 0, nKept = 0, nVeto = 0, vetoLossCaught = 0, vetoWinKilled = 0, vetoPnl = 0; const scored = [];
  for (let k = 0; k < folds; k++) {
    const teLo = half + k * block, teHi = k === folds - 1 ? N : half + (k + 1) * block;
    const tr = recs.slice(0, teLo); if (tr.length < 50) continue;
    const model = trainLogreg(tr.map((r) => r.feats), tr.map((r) => r.label));
    for (let i = teLo; i < teHi; i++) {
      const r = recs[i], p = scoreHold(model, r.feats); scored.push({ p, label: r.label });
      pure += r.pnl;
      if (p >= tau) { kept += r.pnl; nKept++; }                        // keep the lock
      else { nVeto++; vetoPnl += r.pnl; if (r.pnl < 0) vetoLossCaught++; else vetoWinKilled++; }  // veto (skip)
    }
  }
  const p30 = (x) => x / (DAYS / 2) * 30;
  return { tau, pure30: p30(pure), kept30: p30(kept), delta30: p30(kept - pure), nKept, nVeto,
           vetoPrec: nVeto ? 100 * vetoLossCaught / nVeto : 0, vetoWinKilled, avgVetoPnl: nVeto ? vetoPnl / nVeto : 0, auc: auc(scored) };
}

console.log("τ (veto below)   pure mech/30d   vetoed/30d    Δ/30d     kept   vetoed   veto-precision(%loss)  avgVetoPnl   AUC");
console.log("-".repeat(112));
const out = [];
for (const tau of [0.80, 0.85, 0.90, 0.93, 0.95, 0.97]) {
  const r = evalVeto(tau); out.push(r);
  console.log(
    `${tau.toFixed(2)}            $${r.pure30.toFixed(0).padStart(8)}    $${r.kept30.toFixed(0).padStart(8)}   $${r.delta30.toFixed(0).padStart(7)}   ` +
    `${String(r.nKept).padStart(5)}  ${String(r.nVeto).padStart(5)}    ${r.vetoPrec.toFixed(0).padStart(3)}% (killed ${r.vetoWinKilled} wins)   $${r.avgVetoPnl.toFixed(2).padStart(6)}   ${r.auc.toFixed(3)}`
  );
}
const viable = out.filter((r) => r.delta30 > 0 && r.nVeto >= 20).sort((a, b) => b.delta30 - a.delta30);
console.log("\n" + "-".repeat(112));
if (!viable.length) console.log("VERDICT (ML veto): does NOT improve mechanical PnL out-of-sample. avgVetoPnl > 0 ⇒ it skips WINNERS, not losers.");
else {
  const b = viable[0];
  console.log(`VERDICT (ML veto): helps → τ ${b.tau}: +$${b.delta30.toFixed(0)}/30d OOS, vetoes ${b.nVeto} (${b.vetoPrec.toFixed(0)}% losers), kills ${b.vetoWinKilled} wins.`);
  const model = trainLogreg(recs.map((r) => r.feats), recs.map((r) => r.label));
  fs.writeFileSync("research/vetomodel.json", JSON.stringify({ features: FEATURES, ...model, tau: b.tau, role: "veto", trainedOn: `${DAYS}d/${raw.length}w`, latencyMs: LAT, note: "veto model; NOT wired — pending approval" }, null, 2));
  console.log("  → exported research/vetomodel.json (NOT wired).");
}

// ── the actual hypothesis: the losses are the EXPENSIVE (dead-arb) locks. A pure ARITHMETIC ask-cap should cut
//    them, no ML. Sweep a max-winner-ask guard on the SAME mechanical locks and see if total PnL improves. ──
console.log("\n── ARITHMETIC guard: only lock when winner ask ≤ cap (no model). Does capping price beat the ML veto? ──");
console.log("maxAsk    locks kept   kept PnL($)   killed   killed PnL($)   avg killed   kept WR");
console.log("-".repeat(92));
const total = recs.reduce((s, r) => s + r.pnl, 0);
for (const cap of [0.86, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98, 1.00]) {
  const kept = recs.filter((r) => r.ask <= cap), killed = recs.filter((r) => r.ask > cap);
  const kp = kept.reduce((s, r) => s + r.pnl, 0), kd = killed.reduce((s, r) => s + r.pnl, 0);
  const wr = kept.length ? 100 * kept.filter((r) => r.pnl > 0).length / kept.length : 0;
  console.log(
    `${cap.toFixed(2)}      ${String(kept.length).padStart(5)}       $${kp.toFixed(0).padStart(7)}     ${String(killed.length).padStart(5)}     $${kd.toFixed(0).padStart(7)}      $${(killed.length ? kd / killed.length : 0).toFixed(2).padStart(6)}     ${wr.toFixed(1)}%`
  );
}
console.log(`(no cap total = $${total.toFixed(0)} over all ${recs.length} mechanical locks; a cap "helps" if kept PnL > that.)`);
process.exit(0);
