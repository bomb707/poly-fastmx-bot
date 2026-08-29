// momentum.js — the ONE momentum implementation, shared by the chart marks (public/index.html),
// the live strategy (research/strategy.js → stepMomTaker) and the backtest (research/simrun.js).
//
// This is live-tracker-tool's vel_mid mark logic, verbatim:
//   • signal  = RAW CLOB Up-implied mid, velocity over a FIXED 5s lookback:  v(t) = mid(t) − mid(t−5)
//   • trigger = RELATIVE: a mark fires when |v| ≥ SENS × peak|v| × (1 − 0.85·DENS), where peak|v| is the
//               max over the supplied series (full window for the chart/backtest; data-so-far live).
//   • points  = ONSET (first tick crossing the bar) + (DENS>0) local |v| PEAKS.
// Pure ESM, no Node/DOM APIs, so every caller imports the same functions.

export const MOM_LB = 5;   // fixed lookback (seconds)

/** Up-implied mid from a book: (bestBid + bestAsk) / 2. null if incomplete. */
export function midOf(book) {
  return (book && book.bestBid != null && book.bestAsk != null) ? (book.bestBid + book.bestAsk) / 2 : null;
}

/** Velocity series from mids=[{t,m}]: v(t)=m(t)−m(t−lb). null (skipped) for the first `lb` seconds.
 *  O(n) via a monotonic lag pointer (mids are time-sorted; target t−lb only moves forward). */
export function velocitySeries(mids, lb = MOM_LB) {
  const arr = (mids || []).filter((p) => p && p.m != null);
  const n = arr.length;
  if (n < 2) return [];
  const out = [];
  let j = 0;                                   // arr[j] = latest sample with t ≤ (arr[i].t − lb)
  for (let i = 0; i < n; i++) {
    const target = arr[i].t - lb;
    if (arr[0].t > target) continue;           // no sample as old as t−lb yet → null
    while (j + 1 < n && arr[j + 1].t <= target) j++;
    out.push({ t: arr[i].t, v: arr[i].m - arr[j].m });
  }
  return out;
}

/** The relative part of the bar. sens=0 → 0 (so the absolute `thresh` floor alone decides the bar,
 *  i.e. sens_dens with sens=0/dens=0/min=thr is EXACTLY the fixed-threshold method). */
export function markThreshold(maxAbs, sens, dens) {
  return maxAbs * Math.max(0, sens) * (1 - 0.85 * (dens || 0));
}

/**
 * Mark/fire points for a velocity series — onset (first tick over the bar) + (dens>0) local peaks,
 * for BOTH signs. Returns [{t, v}] in time order. `v`'s sign → which side to buy (see buySide).
 */
export function markEvents(vel, { sens = 0.75, dens = 0, thresh = 0 } = {}) {
  if (!vel || vel.length < 2) return [];
  let maxAbs = 1e-9;                                   // O(n), no array alloc / no Math.max(...spread) stack risk
  for (let k = 0; k < vel.length; k++) { const a = vel[k].v < 0 ? -vel[k].v : vel[k].v; if (a > maxAbs) maxAbs = a; }
  // bar = the relative sens×peak bar, but never below an optional absolute FLOOR `thresh` (filter).
  const thr = Math.max(markThreshold(maxAbs, sens, dens), thresh || 0), markPeaks = dens > 0;
  const out = [];
  for (const sgn of [1, -1]) {
    let prevFav = false;
    for (let i = 0; i < vel.length; i++) {
      const v = vel[i].v, fav = Math.sign(v) === sgn && Math.abs(v) >= thr;
      const onset = fav && !prevFav;
      let peak = false;
      if (markPeaks && fav && i > 0 && i < vel.length - 1) {
        const a = Math.abs(vel[i - 1].v), b = Math.abs(v), c = Math.abs(vel[i + 1].v); peak = (b >= a && b > c);
      }
      prevFav = fav;
      if (onset || peak) out.push({ t: vel[i].t, v });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The single entry point engine/backtest/marks all use. A mark fires when |velocity| (over a LOOKBACK_S
 * window, default MOM_LB=5) clears the bar = max(SENS × peak|v| × (1−0.85·DENS), SENS_THRESHOLD).
 *   • SENS/DENS  — the relative bar (scales with the window peak). SENS=0 disables it.
 *   • SENS_THRESHOLD — an absolute |velocity| FLOOR (the "min" knob). 0 = off.
 * So SENS=0/DENS=0/min=T is a pure fixed-threshold trigger; SENS>0 adds the adaptive bar on top.
 */
export function momentumMarks(mids, P = {}) {
  const lb = P.LOOKBACK_S > 0 ? P.LOOKBACK_S : MOM_LB;
  return markEvents(velocitySeries(mids, lb), { sens: P.SENS, dens: P.DENS, thresh: P.SENS_THRESHOLD });
}

/**
 * CAUSAL marks — the marks the LIVE engine actually fires on (running-peak, data-so-far), exactly as
 * stepMomTaker: at each tick it recomputes momentumMarks over the mids seen SO FAR and acts on the
 * NEW last mark. So this walks growing prefixes and emits each "new latest" mark, frozen at the tick it
 * was first detected. Use THIS for the chart overlay / history so the gold marks line up with the fills
 * (which the causal backtest produces). momentumMarks (full-window, hindsight peak) is for nothing live.
 * O(n²) — fine for one window (cache it); don't call per animation frame on a growing live series.
 */
export function momentumMarksCausal(mids, P = {}) {
  const arr = (mids || []).filter((p) => p && p.m != null);
  if (arr.length < 3) return [];
  const out = [];
  let lastT = -Infinity;
  for (let i = 2; i <= arr.length; i++) {
    const ev = momentumMarks(arr.slice(0, i), P);     // running-peak detection over data-so-far
    const last = ev.length ? ev[ev.length - 1] : null;
    if (last && last.t > lastT) { out.push(last); lastT = last.t; }
  }
  return out;
}

/** Which side a momentum value implies buying. follow = the rising side · fade = the falling side. */
export function buySide(v, direction) {
  const rising = v > 0 ? "Up" : "Down";              // Up-implied mid rising ⇒ Up rising
  return direction === "fade" ? (rising === "Up" ? "Down" : "Up") : rising;
}
