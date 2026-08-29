// research/twap-velocity.mjs — HOW FAST can the Chainlink 60s TWAP move? A TWAP is a trailing mean, so its velocity
// is mechanically bounded: d/dt mean_W = (price_now − price_(t−W)) / W. This measures the reconstructed 60s TWAP's
// rate of change empirically over the post-TWAP window — max & tail percentiles in $/s (and $ over each horizon).
// That max velocity is the ceiling on how far the TWAP can still travel in the time left (the possible-move basis).
//
// Usage:  node research/twap-velocity.mjs [days=13] [twapWindowSec=60]
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
const A = process.argv.slice(2);
const DAYS = Number(A[0]) || 13;
const TWAP_W = A[1] != null && !isNaN(+A[1]) ? +A[1] : 60;
const WIN = 300;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN, start = nowA - DAYS * 24 * 3600;
const slugs = []; for (let ws = start; ws < nowA - WIN; ws += WIN) slugs.push(`btc-updown-5m-${ws}`);
console.log(`\nTWAP-${TWAP_W}s velocity — btc 5m, ${DAYS}d, ${slugs.length} windows`);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const slug = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length > 20 && d.ticks.some((t) => t.cl != null)) raw.push(d);
    } catch {}
    if (++done % 1000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(20);
  }
}));
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 50) { console.log("too few windows."); process.exit(0); }

// reconstruct TWAP(t) = trailing mean of cl over [t−W, t], sampled on a 1s grid so velocities are comparable.
function twapSeries(d) {
  const T = d.ticks.filter((x) => x.t >= 0 && x.t <= WIN && x.cl > 0 && Number.isFinite(x.cl))
                   .sort((a, b) => a.t - b.t);
  if (T.length < 20) return null;
  // drop glitch ticks: cl deviating > 1% from the local median of its neighbours
  const clean = T.filter((x, i) => {
    const lo = Math.max(0, i - 3), hi = Math.min(T.length - 1, i + 3);
    const nb = T.slice(lo, hi + 1).map((y) => y.cl).sort((a, b) => a - b);
    const med = nb[nb.length >> 1];
    return med > 0 && Math.abs(x.cl - med) / med < 0.01;
  });
  if (clean.length < 20) return null;
  const t0 = 0, tN = WIN, series = [];
  let lo = 0;
  for (let t = t0; t <= tN; t++) {
    // samples in (t−W, t]
    while (lo < clean.length && clean[lo].t <= t - TWAP_W) lo++;
    let sum = 0, n = 0;
    for (let j = lo; j < clean.length && clean[j].t <= t; j++) { sum += clean[j].cl; n++; }
    if (n > 0) series.push({ t, twap: sum / n });
  }
  return series.length > TWAP_W ? series : null;
}

const HORIZONS = [1, 2, 5, 10, 30];   // measurement spans (s)
const acc = {}; for (const h of HORIZONS) acc[h] = [];    // |ΔTWAP| over h seconds
let priceRef = 0, nPx = 0;

for (const d of raw) {
  const s = twapSeries(d); if (!s) continue;
  const byT = new Map(s.map((x) => [x.t, x.twap]));
  priceRef += s[s.length >> 1].twap; nPx++;
  for (const h of HORIZONS) {
    for (const x of s) {
      const prev = byT.get(x.t - h);
      if (prev != null) acc[h].push(Math.abs(x.twap - prev));
    }
  }
}
const avgPx = nPx ? priceRef / nPx : 0;
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };

console.log(`avg BTC (mid-window TWAP): $${avgPx.toFixed(0)}  ·  velocity = |Δ TWAP| over each horizon, in $ and $/s\n`);
console.log("horizon    n         max $     p99.9 $    p99 $     |    MAX $/s   p99.9 $/s   p99 $/s    (max as %/s)");
console.log("-".repeat(100));
for (const h of HORIZONS) {
  const arr = acc[h]; if (!arr.length) continue;
  let mx = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
  const p999 = pct(arr, 99.9), p99 = pct(arr, 99);
  const mxs = mx / h, p999s = p999 / h, p99s = p99 / h;
  const pctS = avgPx ? (100 * mxs / avgPx).toFixed(4) : "—";
  console.log(`${(h + "s").padEnd(8)} ${String(arr.length).padStart(7)}   ${("$" + mx.toFixed(1)).padStart(8)}  ${("$" + p999.toFixed(1)).padStart(9)}  ${("$" + p99.toFixed(1)).padStart(8)}   |  ${("$" + mxs.toFixed(2)).padStart(8)}  ${("$" + p999s.toFixed(2)).padStart(9)}  ${("$" + p99s.toFixed(2)).padStart(8)}     ${pctS}%/s`);
}
console.log(`\nMAX velocity (single fastest span seen) ≈ the headline "how fast can the 60s TWAP move".`);
console.log(`Note: a 60s trailing mean's velocity ≈ (price_now − price_60s_ago)/60, so its per-second speed is naturally`);
console.log(`  damped vs raw spot — that damping is the settlement-lag edge. Reconstructed from per-tick 'cl'; glitch ticks (>1%`);
console.log(`  off local median) dropped, so MAX is a real move not a data spike. Longer horizons smooth → lower $/s.`);
process.exit(0);
