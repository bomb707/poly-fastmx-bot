// engine/strategies/_template.js — SKELETON for a new strategy. Copy me → engine/strategies/<name>.js.
//
// A strategy is a pure decision function over a stream of per-tick market snapshots. It NEVER places real orders
// or touches the DB — it just returns intended fills; simrun/shadow/index.js handle sim vs real execution. The
// same `step()` therefore drives backtest, live-sim, AND real-live (the only difference is P.LIVE_FILLS).
//
// ── SHARED MODULES you can import (strategy-agnostic) ──────────────────────────────────────────────────────────
//   import { fillFee, isFeeFill, isTakerFill, PARAMS } from "../fees.js";           // fee model (bot+sim match)
//   import { roundExcursion, computeIntensity, makeIntensityBuffer, pushExcursion } from "../intensity.js"; // vol
//   import { makerTouchFill, latencyFillPrice } from "../fillsim.js";               // sim fill model
//   import { applyMergeToLedger } from "../mergesim.js";                            // on-chain $1-set merge
//
// ── THE CONTRACT (what to export) ──────────────────────────────────────────────────────────────────────────────
export const NAME = "template";      // config id (P.STRATEGY === this selects it)
export const LABEL = "Template";     // UI dropdown label

// Default params for THIS strategy. mergedP = { ...STRAT, ...liveParams } — include framework knobs it reads
//   (SIZE, LIMIT, WINDOW_SEC, LATENCY_MS, LIVE_FILLS, FEE_BPS, MERGE_ON, …) plus your own STRAT_-prefixed ones.
export const STRAT = {
  SIZE: 40,
  LIMIT: 0.99,
  WINDOW_SEC: 300,
  LATENCY_MS: 0,
  LIVE_FILLS: false,
  // …your strategy's own params…
};

// REQUIRED. Called once per market tick. MUTATE `state` (your per-window scratch), RETURN an array of intended
//   fills. Fill shape (match the engine's): { tInto, side:"Up"|"Down", shares, effPx, usdc, exec, limitPx, kind,
//   leg:"entry"|"hedge"|"merge", reason, status:"full", oid, postOnly? }. Set state.gateReason for the UI.
//   tk carries: t (secs into window), up/down {bestAsk,bestBid}, bzGap, bzGapPct, intensity, winHour, winDay, …
//   In LIVE (P.LIVE_FILLS) prefer resting/pending guards so you don't double-fire before the real fill injects.
export function step(state, tk, P, dtMs = 120, clockMs = tk.t * 1000) {
  const out = [];
  state.gateReason = "template-noop";
  // …decide, push fills into `out`…
  return out;
}

// OPTIONAL live-fill hooks (the dispatcher supplies no-ops if you omit them). Only needed for real-live:
// export function injectRealFill(state, fill) { /* book a real on-chain fill into `state` */ }
// export function applyManualHedge(state, hedgeSide, shares, px) { return 0; }
// export function clearLivePending(state, oid) { /* release a pending-order guard on reject/cancel */ }
