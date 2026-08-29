// engine/strategies/gap_predictor.js — strategy extracted from sonex/gap_predictor.zip.
//
// The source strategy and this project's Lockstep engine share the same causal signal:
//
//   possible remaining move = recent completed-round intensity × (seconds left / window seconds)
//   enter when             = |spot - window open| > possible remaining move
//
// Gap Predictor's distinct profile is linear time scaling, no extra edge buffer, a 0.50 entry floor,
// and a taker hedge of the opposite side at <= 0.02 only when the completed pair locks at least 0.03
// profit per share after fees. Reusing the hardened engine keeps simulation, real-fill reconciliation,
// latency, settlement, and order routing identical to the rest of this project.
import {
  STRAT as BASE_STRAT,
  stepSignalHedge,
  injectRealFill,
  applyManualHedge,
  clearLivePending,
  passesGate,
} from "../strategy.js";

export const NAME = "gap_predictor";
export const LABEL = "Gap Predictor";

export const STRAT = {
  ...BASE_STRAT,
  STRATEGY: NAME,

  // Source defaults (gap_predictor_strategy.js + gap_analytics.js).
  SIZE: 40,
  LIMIT: 0.99,
  LATENCY_MS: 0,
  WINDOW_SEC: 300,
  L_VOL_ROUNDS: 6,          // six completed 5m rounds = 30 minutes; active round excluded upstream
  L_VOL_MODE: "max",
  L_SCALING: "linear",
  L_EDGE_BUFFER: 0,
  L_MIN_GAP: 0,
  L_ENTRY_FLOOR: 0.50,
  L_ENTRY_CEIL: 0,
  L_SKIP_END_S: 5,
  L_SKIP_OPEN_S: 0,
  L_MIN_TIME_S: 1,
  L_ONE_PER_ROUND: true,
  L_MAX_ENTRIES: 8,
  L_COOLDOWN_MS: 1500,

  // Source default hedge mode: price cap plus fee-inclusive >= 0.03 profit per share.
  L_HEDGE_CAP: 0.02,
  L_HEDGE_MODE: "price",
  L_HEDGE_MIN_PROFIT: 0.03,
  L_HEDGE_EXEC: "taker",
  L_HEDGE_EAGER: false,
  L_HEDGE_MAKER_TIMEOUT_S: 0,
  L_END_HEDGE_S: 0,
};

// The imported source always buys its hedge as a marketable order and has no unconditional final hedge.
// Cache the normalized object because step() is a hot path and P is immutable between config updates.
const normalized = new WeakMap();
function sourceExecutionParams(P) {
  if (P && typeof P === "object") {
    const cached = normalized.get(P);
    if (cached) return cached;
    const next = {
      ...P,
      L_HEDGE_EXEC: "taker",
      L_HEDGE_EAGER: false,
      L_HEDGE_MAKER_TIMEOUT_S: 0,
      L_END_HEDGE_S: 0,
    };
    normalized.set(P, next);
    return next;
  }
  return STRAT;
}

export function step(state, tk, P, dtMs = 120, clockMs = tk.t * 1000) {
  const fills = stepSignalHedge(state, tk, sourceExecutionParams(P), dtMs, clockMs);
  for (const fill of fills) {
    if (fill.leg === "entry" && fill.reason === "lock") fill.reason = "gap-lock";
    else if (fill.leg === "hedge" && fill.reason === "lockstep") fill.reason = "gap-hedge";
  }
  return fills;
}

export { injectRealFill, applyManualHedge, clearLivePending, passesGate };
