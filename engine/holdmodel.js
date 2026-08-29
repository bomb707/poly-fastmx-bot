// engine/holdmodel.js — shared feature builder + scorer for the LEADER-HOLDS classifier.
//
// The whole point of sharing this module between the trainer (research/train-holdmodel.mjs) and the live engine
// (strategy.js) is that the feature vector is computed by THE SAME CODE on both sides — no train/serve skew.
//
// The model predicts P(the current leader HOLDS to settlement) from causal, at-the-tick features, so Lockstep can
// lock EARLY + CHEAP when confident (10c margin instead of the mechanical gate's 4c) and skip the flips. The
// study (research/early-lock-study.mjs) proved the ceiling is $5-8k/30d and that gap-velocity carries real signal.

// Feature order is FROZEN — the model's mean/std/weights arrays index into this exact order.
export const FEATURES = ["ratio", "velAlign10", "velAlign30", "winnerAsk", "loserAsk", "clAlign", "secsFrac", "hourSin", "hourCos"];

// Build the feature vector from a decision CONTEXT. Both trainer and engine assemble the same context then call this.
//   ctx = { gap, intensity, winnerAsk, loserAsk, cl, open, secsLeft, win, winHour, v10, v30 }
//   v10/v30 = raw gap velocity ($/s) over ~10s / ~30s (unsigned direction; this fn signs them toward the leader).
export function buildFeatures(ctx) {
  const eps = 1e-6;
  const sg = Math.sign(ctx.gap) || 1;                 // +1 leader = Up, -1 = Down
  const I = Math.max(Math.abs(ctx.intensity || 0), eps);
  const win = ctx.win || 300;
  const h = 2 * Math.PI * ((ctx.winHour || 0) / 24);
  return [
    Math.abs(ctx.gap) / I,                             // ratio — the core signal (|gap| in units of vol)
    (sg * (ctx.v10 || 0)) / I,                         // velAlign10 — momentum CONFIRMING the lead (+) vs fighting (−), vol-scaled
    (sg * (ctx.v30 || 0)) / I,                         // velAlign30 — slower confirmation
    ctx.winnerAsk,                                     // price = margin (1 − ask); higher ask ⇒ pricier/safer
    ctx.loserAsk,                                      // consensus: a cheap loser = the market already agrees
    (sg * ((ctx.cl || ctx.open) - ctx.open)) / I,      // clAlign — does the CHAINLINK (settlement) feed also lead the same way?
    Math.max(0, ctx.secsLeft) / win,                   // secsFrac — how early we are (more time = more reversal room)
    Math.sin(h), Math.cos(h),                          // hour-of-day (cyclical) — regime
  ];
}

// Logistic score P(hold) — standardize with the model's own scaler, then sigmoid. Pure, hot-path cheap.
export function scoreHold(model, feats) {
  if (!model || !model.weights) return null;
  let z = model.bias || 0;
  for (let i = 0; i < feats.length; i++) z += model.weights[i] * ((feats[i] - (model.mean[i] || 0)) / (model.std[i] || 1));
  return 1 / (1 + Math.exp(-z));
}

// Expected value per share of locking the winner at `winnerAsk` given P(hold) and the taker fee fraction.
//   EV = p·(1−ask) − (1−p)·ask − fee.  Lock when EV ≥ marginMin (price-aware: demands more p when ask is pricey).
export function lockEV(p, winnerAsk, feeFrac) {
  return p * (1 - winnerAsk) - (1 - p) * winnerAsk - (feeFrac || 0);
}
