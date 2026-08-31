// Pair-completion engine — the profit mechanism described in TARGET_WALLET_STRATEGY_ANALYSIS.md §4/§9/§12.5,
// implemented as a first-class strategy so it can be measured on its own.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────────────────
// The report's headline decomposition is that the target wallet's gross PnL is almost entirely a PAIRED
// component (+$2,846.76 broad / +$2,840.80 fresh) and that its DIRECTIONAL residual is roughly zero to
// negative (-$693.82 broad / +$178.87 fresh). `helpme` implements only the directional half: it buys one side
// on momentum and holds to settlement, never completing a pair. Measured over the 2,339-window cache that
// costs -2.31c/share (-0.58c signal vs mid, -0.53c spread crossed, -1.20c taker fee).
//
// A matched pair pays exactly $1 at resolution regardless of the winner, so `m` shares acquired for a combined
// `c < 1` is a locked `m*(1-c)` gross profit. This module goes and gets those pairs.
//
// ── THE MECHANISM ────────────────────────────────────────────────────────────────────────────────────────────
// `upAsk + dnAsk` is pinned at ~1.01 (measured: below 1.00 in 0.00% of 4.44M cached ticks), so a pair can
// NEVER be formed by crossing both asks at the same instant. A cheap pair is necessarily time-separated:
// buy leg one, then complete the other leg only after it has fallen enough to lock the target margin. That is
// exactly the report's lot-aware cap (§9.2):
//
//     P_pair,i = 1 - oppositeLotPrice - g - feeReserve
//
// Lot-level (FIFO) opposite cost is used rather than a global average, per §9.2 — an expensive opposite lot
// must not be hidden behind a cheap one.
//
// ── MEASURED BEHAVIOUR — READ BEFORE DEPLOYING ───────────────────────────────────────────────────────────────
// `node research/backtest-paircomp.mjs --split` over the 2,340-window cache (2026-08-14 .. 2026-08-31):
//
//              turnover   paired                     directional   fees    NET       $/window
//   FIT        $10,479    9,834 sh @ 0.9399 = +$591  -$848         $190    -$447.73  -$0.383
//   HOLDOUT     $5,332    4,804 sh @ 0.9301 = +$336  -$593          $93    -$350.38  -$0.299
//
// The pair engine WORKS and is stable out of sample: 0.9301 on the holdout against the wallet's measured
// 0.9306 (report §1.1). It is nonetheless NET NEGATIVE, because every pair must be seeded by a directional leg
// and the seed is adversely selected under every acquisition method measured:
//   • crossing the ask   — pays spread + taker fee, and the mid drifts against the fill at every horizon;
//   • resting under it   — no fee, but a resting bid only fills when its side is FALLING, which is worse.
// The unpaired remainder is adversely selected for the same reason: completion needs your side to rally, so
// you stay unpaired precisely when it does not. In the cache, seeds that never paired won 0-10% of the time,
// and seed legs overall won 51.4% / 51.9% of shares at an average price of 0.522 / 0.527 — a hit rate equal to
// the price paid, i.e. no edge over the market, before the taker fee.
//
// So `PC_SEED_*` is deliberately a pluggable policy with a deliberately weak default. The reusable, validated
// asset here is the pair engine; the seed is the open problem. Do not run this live expecting profit.
//
// Everything unidentified is an explicit parameter so forward tests stay auditable.

import { fillFee } from "../fees.js";

export const NAME = "paircomp";
export const LABEL = "Pair completion · lot-aware complement accumulation";

export const STRAT = {
  STRATEGY: NAME,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  LIVE_FILLS: false,
  LIMIT: 0.99,
  FEE_BPS: 700,
  FEE_USE_MIN: false,
  FEE_ALL_FILLS: false,
  MAX_SESSION_LOSS: 0,          // 0 = never halt. A nonzero value freezes the whole rest of a backtest range.

  PC_ON: true,
  PC_START_S: 5,
  PC_STOP_S: 285,
  PC_LOT_SH: 10,                // one parent lot; pairs are matched lot-for-lot
  PC_MIN_ASK: 0.05,
  PC_MAX_ASK: 0.90,
  PC_MIN_DEPTH_SH: 4,           // visible depth at/under the cap required before acting
  PC_COOLDOWN_MS: 3000,
  PC_MAX_WINDOW_SPEND: 400,

  // ── pair completion (the profit engine) ──
  PC_PAIR_PROFIT_TARGET: 0.10,  // g — required gross margin on a newly matched pair. Measured best: a thin g
                                // buys more pairs but at a worse combined cost (g=0.03 -> 0.9715, g=0.10 -> 0.9290).
  PC_PAIR_TICK: 0.01,
  PC_FEE_RESERVE: true,         // subtract the seed leg's taker fee from the pair cap
  PC_REST_COMPLEMENT: true,     // post the complement as a resting GTC limit (maker, no taker fee)
  PC_REST_TIMEOUT_MS: 300000,   // let it rest to the cutoff; simrun expires it at this age

  // ── late loss cap (§12.4: it completes pairs above $1 to bound the bad outcome) ──
  // Default OFF: it does bound the tail, but measured over the cache it only adds expensive pairs and dilutes
  // the combined cost (0.9290 -> 0.9755) without improving net. §12.4 observes the wallet doing it anyway.
  PC_LOSS_CAP_ON: false,
  PC_LOSS_CAP_S: 240,           // after this, allow a pair above $1 to cap the loss
  PC_LOSS_CAP_MAX: 1.03,        // worst combined pair cost the loss-cap branch will accept

  // ── directional seed (the OPEN PROBLEM — see the header) ──
  PC_SEED_MODE: "signal",       // "signal" | "off". "off" runs the pair engine against injected inventory only.
  PC_SEED_TAKER: true,          // true = cross the ask; false = rest one tick under it
  PC_SEED_REST_TICKS: 1,
  PC_SEED_REST_TTL_MS: 60000,
  PC_SEED_BZ_LOOKBACK_MS: 1000, // measured: 0.5-1.0s carries more alpha than the 3s `helpme` uses
  PC_SEED_BZ_MIN_USD: 20,       // measured: edge vs market rises with threshold ($5 -> +0.33pp, $20 -> +1.52pp)
  PC_SEED_REQUIRE_CLOB_QUIET: false, // measured +0.66pp when Binance fires and the CLOB has NOT yet moved
  PC_SEED_CLOB_LOOKBACK_MS: 3000,
  PC_SEED_CLOB_QUIET_MAX: 0.02,

  // ── inventory risk (§12.5) ──
  PC_MAX_LEAN_SH: 10,           // hard cap on |upShares - downShares|
};

const EPS = 1e-9;
const finite = (v) => (v == null || v === "") ? null : (Number.isFinite(+v) ? +v : null);
const round4 = (v) => { const n = finite(v); return n == null ? null : Math.round(n * 1e4) / 1e4; };
const enabled = (v, fallback = true) => {
  if (v == null || v === "") return fallback;
  return !(v === false || v === 0 || v === "0" || String(v).toLowerCase() === "false");
};
const other = (side) => side === "Up" ? "Down" : "Up";
const floorTick = (px, tick) => Math.floor((px + EPS) / tick) * tick;

function levels(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const p = finite(Array.isArray(row) ? row[0] : row?.price);
    const s = finite(Array.isArray(row) ? row[1] : row?.size);
    if (p != null && s != null && p > 0 && p < 1 && s > 0) out.push([p, s]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Visible shares obtainable at or below `cap`.
function depthTo(asks, cap) {
  let n = 0;
  for (const [px, size] of asks) { if (px > cap + EPS) break; n += size; }
  return n;
}

function model(state) {
  return state.pc || (state.pc = {
    lots: { Up: [], Down: [] },     // FIFO unpaired lots per side: { sh, px }
    consumed: 0,                    // how many of state.fills have been folded into `lots`
    spend: 0,
    lastActionMs: -Infinity,
    seedRest: null,                 // { side, level, expiresMs }
    bzHist: [],                     // { ms, px }
    midHist: [],                    // { ms, mid }
    seq: 0,
  });
}

// Fold any fills the engine has booked since the last tick into the FIFO lot ledger, matching each new share
// against the oldest unpaired opposite lot. What survives in `lots` is the UNPAIRED inventory, which is exactly
// what the pair caps must be priced against.
function syncLots(m, state) {
  const fills = state.fills || [];
  for (; m.consumed < fills.length; m.consumed++) {
    const f = fills[m.consumed];
    const sh = +f.shares || 0;
    if (!(sh > 0) || (f.side !== "Up" && f.side !== "Down")) continue;
    const px = f.effPx != null ? +f.effPx : (sh ? (+f.usdc || 0) / sh : 0);
    m.spend += (+f.usdc || 0);
    let left = sh;
    const opp = m.lots[other(f.side)];
    while (left > EPS && opp.length) {        // pair off against the oldest opposite lot
      const lot = opp[0];
      const take = Math.min(left, lot.sh);
      lot.sh -= take; left -= take;
      if (lot.sh <= EPS) opp.shift();
    }
    if (left > EPS) m.lots[f.side].push({ sh: left, px });
  }
}

// Two clocks are in play: the CLOB tick clock (`clockMs`, window-relative in replay) and the Binance feed's own
// receive timestamp (absolute epoch when live, absent in historical snapshots). Each history is kept and queried
// in ITS OWN clock — mixing them silently starves every lookback. Same convention as helpme.js.
function pushHistory(m, tk, clockMs, keepMs) {
  const bz = finite(tk.bzPrice);
  if (bz != null) {
    const feedAtMs = finite(tk.binanceAtMs);
    const observedAtMs = feedAtMs ?? clockMs;
    const prev = m.bzHist.at(-1);
    // Live stamps every Binance frame, so dedupe on time; replay has no stamp, so dedupe on price transition.
    const isNew = feedAtMs != null ? (!prev || observedAtMs > prev.ms) : (!prev || prev.px !== bz);
    if (isNew) m.bzHist.push({ ms: observedAtMs, px: bz });
  }
  const ua = finite(tk.up?.bestAsk), ub = finite(tk.up?.bestBid);
  if (ua != null && ub != null) {
    const mid = (ua + ub) / 2;
    const prev = m.midHist.at(-1);
    if (!prev || prev.mid !== mid) m.midHist.push({ ms: clockMs, mid });
  }
  const bzCutoff = (m.bzHist.at(-1)?.ms ?? clockMs) - keepMs;
  while (m.bzHist.length > 2 && m.bzHist[1].ms < bzCutoff) m.bzHist.shift();
  const midCutoff = clockMs - keepMs;
  while (m.midHist.length > 2 && m.midHist[1].ms < midCutoff) m.midHist.shift();
}

// Value of `hist` at or before `clockMs - lookbackMs` (causal — never reads forward).
function priorValue(hist, key, clockMs, lookbackMs) {
  const deadline = clockMs - lookbackMs;
  let found = null;
  for (const h of hist) { if (h.ms <= deadline) found = h; else break; }
  return found ? found[key] : null;
}

function seedSignal(m, P, clockMs) {
  const bzLb = Math.max(100, +P.PC_SEED_BZ_LOOKBACK_MS || 1000);
  const now = m.bzHist.at(-1);
  // Queried in the Binance feed's own clock (see pushHistory), not the CLOB tick clock.
  const prior = now ? priorValue(m.bzHist, "px", now.ms, bzLb) : null;
  if (!now || prior == null) return { side: null, reason: "seed-bz-warmup" };
  const move = now.px - prior;
  const min = Math.max(EPS, +P.PC_SEED_BZ_MIN_USD || 20);
  if (Math.abs(move) + EPS < min) return { side: null, reason: "seed-bz-below-threshold", move };
  if (enabled(P.PC_SEED_REQUIRE_CLOB_QUIET, false)) {
    // The measured best subset: Binance has moved but the CLOB mid has NOT yet repriced. Requiring the book to
    // have already moved (what `helpme` does) conditions on the information being priced in and kills the edge.
    const clLb = Math.max(100, +P.PC_SEED_CLOB_LOOKBACK_MS || 3000);
    const midNow = m.midHist.at(-1)?.mid;
    const midPrior = priorValue(m.midHist, "mid", clockMs, clLb);
    if (midNow == null || midPrior == null) return { side: null, reason: "seed-clob-warmup", move };
    if (Math.abs(midNow - midPrior) > (+P.PC_SEED_CLOB_QUIET_MAX || 0.02) + EPS) {
      return { side: null, reason: "seed-clob-already-moved", move };
    }
  }
  return { side: move > 0 ? "Up" : "Down", reason: "seed-binance-momentum", move };
}

function order(state, m, tk, { side, shares, limitPx, ask, leg, reason, resting, P }) {
  const oid = state.seq = (+state.seq || 0) + 1;
  m.seq++;
  return {
    tInto: tk.t,
    side,
    shares: round4(shares),
    minimumShares: round4(shares),
    budgetUsd: null,
    amountMode: "shares",           // shares-mode + GTC is what lets simrun rest an unfilled remainder
    effPx: round4(resting ? limitPx : ask),
    usdc: round4((resting ? limitPx : ask) * shares),
    exec: "marketable",
    limitPx: round4(limitPx),
    kind: resting ? "maker" : "taker",
    leg,
    role: leg,
    reason,
    status: "full",
    postOnly: false,
    orderType: "GTC",
    liveOrderType: "GTC",
    restTimeoutMs: resting ? Math.max(0, +P.PC_REST_TIMEOUT_MS || 0) : 0,
    oid,
  };
}

// A resting complement is only worth keeping while it still clears the current cap. Re-priced by cancelling and
// re-posting on the next tick, which is also how the report describes the wallet's cancel/replace behaviour (§8.5).
export function shouldCancelResting(state, rec, tk, P = STRAT, clockMs = tk.t * 1000) {
  if (rec?.leg !== "complement") return { cancel: false };
  const m = model(state);
  syncLots(m, state);
  const oppLot = m.lots[other(rec.side)][0];
  if (!oppLot) return { cancel: true, reason: "complement-no-opposite-lot" };
  const cap = pairCap(oppLot.px, tk.t, P);
  if (cap == null) return { cancel: true, reason: "complement-cap-unavailable" };
  if (rec.limitPx > cap + EPS) return { cancel: true, reason: "complement-above-cap", currentCap: round4(cap) };
  return { cancel: false, currentCap: round4(cap) };
}

// §9.2 pair-completion cap, priced against ONE specific opposite lot. After PC_LOSS_CAP_S the branch widens to
// PC_LOSS_CAP_MAX so an unpaired leg can still be bounded, which is what §12.4 observes late in the round.
function pairCap(oppLotPx, tSec, P) {
  const g = Math.max(0, +P.PC_PAIR_PROFIT_TARGET || 0);
  const tick = Math.max(0.001, +P.PC_PAIR_TICK || 0.01);
  const reserve = enabled(P.PC_FEE_RESERVE) ? fillFee(oppLotPx, 1, true, P) : 0;
  let cap = 1 - oppLotPx - g - reserve;
  if (enabled(P.PC_LOSS_CAP_ON) && tSec >= (+P.PC_LOSS_CAP_S || 240)) {
    cap = Math.max(cap, (+P.PC_LOSS_CAP_MAX || 1.03) - oppLotPx);
  }
  return cap > 0 ? floorTick(cap, tick) : null;
}

function restingOn(state, side, leg) {
  for (const p of (state.pendingFills || [])) {
    if (p?.phase === "resting" && p.rec?.side === side && p.rec?.leg === leg) return p;
  }
  return null;
}

export function step(state, tk, P = STRAT, _dtMs = 120, clockMs = tk.t * 1000) {
  state.placedThisTick = [];
  const m = model(state);
  const gate = (reason, extra) => { state.gateReason = reason; state.pcStatus = { t: tk.t, gate: reason, ...extra }; return []; };

  const keepMs = Math.max(+P.PC_SEED_BZ_LOOKBACK_MS || 1000, +P.PC_SEED_CLOB_LOOKBACK_MS || 3000) + 5000;
  pushHistory(m, tk, clockMs, keepMs);
  syncLots(m, state);

  if (!enabled(P.PC_ON)) return gate("disabled");
  if (tk.t < (+P.PC_START_S || 0)) return gate("wait-open");
  if (tk.t > (+P.PC_STOP_S || P.WINDOW_SEC || 300)) return gate("end-cutoff");

  const lot = Math.max(1, +P.PC_LOT_SH || 10);
  const minAsk = Math.max(0.01, +P.PC_MIN_ASK || 0.05);
  const maxAsk = Math.min(+P.LIMIT || 0.99, +P.PC_MAX_ASK || 0.90);
  const minDepth = Math.max(+P.PC_MIN_DEPTH_SH || 0, 1);

  const upSh = +state.upShares || 0, dnSh = +state.downShares || 0;
  const inv = { Up: upSh, Down: dnSh };

  // ── 1. PAIR COMPLETION — always the first claim on capital ────────────────────────────────────────────────
  // The minority side is the one that pairs off existing opposite inventory. This branch is priced purely on
  // lot economics; it needs no directional opinion, which is the whole point.
  for (const side of ["Up", "Down"]) {
    if (inv[side] + EPS >= inv[other(side)]) continue;            // not the minority side -> not a completion
    const oppLot = m.lots[other(side)][0];
    if (!oppLot) continue;
    const cap = pairCap(oppLot.px, tk.t, P);
    if (cap == null) continue;

    const book = side === "Up" ? tk.up : tk.down;
    const asks = levels(book?.asks);
    const ask = finite(book?.bestAsk) ?? asks[0]?.[0] ?? null;
    const want = Math.min(lot, inv[other(side)] - inv[side]);
    if (!(want > EPS)) continue;

    const already = restingOn(state, side, "complement");
    if (ask != null && ask <= cap + EPS && ask >= minAsk - EPS && ask <= maxAsk + EPS) {
      // The complement is already at our price — cross it now rather than queue behind it.
      if (depthTo(asks, cap) + EPS < Math.min(want, minDepth)) continue;
      if (clockMs - m.lastActionMs < (+P.PC_COOLDOWN_MS || 0)) return gate("cooldown", { side });
      m.lastActionMs = clockMs;
      const rec = order(state, m, tk, { side, shares: want, limitPx: cap, ask, leg: "complement",
        reason: "pair-completion-cross", resting: false, P });
      state.gateReason = "fired";
      return [rec];
    }
    if (enabled(P.PC_REST_COMPLEMENT) && !already && cap >= minAsk - EPS) {
      // Post it and wait. A resting complement fills only if the market comes down to the locked pair price,
      // and it fills as a maker, so it pays no taker fee.
      m.lastActionMs = clockMs;
      const rec = order(state, m, tk, { side, shares: want, limitPx: cap, ask, leg: "complement",
        reason: "pair-completion-rest", resting: true, P });
      state.gateReason = "rest-complement";
      return [rec];
    }
  }

  // ── 2. DIRECTIONAL SEED — the open problem (see header) ───────────────────────────────────────────────────
  if (String(P.PC_SEED_MODE || "signal").toLowerCase() === "off") return gate("seed-off");
  if (m.spend >= (+P.PC_MAX_WINDOW_SPEND || Infinity)) return gate("window-spend-cap", { spend: round4(m.spend) });
  if (clockMs - m.lastActionMs < (+P.PC_COOLDOWN_MS || 0)) return gate("cooldown");

  // A resting seed that the market has walked away from is dead weight; let it expire.
  if (m.seedRest && clockMs > m.seedRest.expiresMs) m.seedRest = null;

  const sig = seedSignal(m, P, clockMs);
  if (!sig.side) return gate(sig.reason, { move: round4(sig.move) });

  const side = sig.side;
  const lean = Math.abs((inv[side] + lot) - inv[other(side)]);
  if (lean > (+P.PC_MAX_LEAN_SH || 0) + EPS) return gate("lean-limit", { side, lean });

  const book = side === "Up" ? tk.up : tk.down;
  const asks = levels(book?.asks);
  const ask = finite(book?.bestAsk) ?? asks[0]?.[0] ?? null;
  if (ask == null || ask < minAsk - EPS || ask > maxAsk + EPS) return gate("seed-ask-range", { side, ask });
  if (depthTo(asks, ask) + EPS < Math.max(lot, minDepth)) return gate("seed-depth", { side, ask });

  const takerSeed = enabled(P.PC_SEED_TAKER);
  const tick = Math.max(0.001, +P.PC_PAIR_TICK || 0.01);
  const limitPx = takerSeed ? ask : floorTick(ask - tick * Math.max(1, +P.PC_SEED_REST_TICKS || 1), tick);
  if (!takerSeed) {
    if (restingOn(state, side, "seed")) return gate("seed-already-resting", { side });
    if (limitPx < minAsk - EPS) return gate("seed-rest-below-floor", { side, limitPx });
    m.seedRest = { side, level: limitPx, expiresMs: clockMs + (+P.PC_SEED_REST_TTL_MS || 60000) };
  }
  m.lastActionMs = clockMs;
  const rec = order(state, m, tk, { side, shares: lot, limitPx, ask, leg: "seed",
    reason: sig.reason, resting: !takerSeed, P });
  state.gateReason = "fired";
  state.pcStatus = { t: tk.t, gate: "fired", side, leg: "seed", ask: round4(ask), limitPx: round4(limitPx),
    move: round4(sig.move), lean, spend: round4(m.spend) };
  return [rec];
}

export function clearLivePending() {}
