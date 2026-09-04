const EPS = 1e-9;

const finite = (value) => value == null || value === ""
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function component(value, scale) {
  const n = finite(value), s = Math.max(EPS, finite(scale) ?? 1);
  return n == null ? null : clamp(n / s, -1, 1);
}

/**
 * Target-derived direction score. Positive means Up and negative means Down.
 * Every component is causal and normalized before weighting:
 *   - CLOB level: current Up midpoint relative to 0.50
 *   - CLOB impulse: Up midpoint change over the configured short lookback
 *   - Binance impulse: spot change over the same short lookback
 * Missing inputs are omitted and the remaining weights are renormalized.
 */
export function evaluateDirectionScore({
  midpoint,
  midVelocity,
  binanceVelocity,
  clobLevelOn = true,
  clobVelocityOn = true,
  binanceVelocityOn = true,
  levelScale = 0.05,
  clobScale = 0.05,
  binanceScale = 10,
  levelWeight = 0.2,
  clobWeight = 0.3,
  binanceWeight = 0.5,
  enterScore = 0.35,
  exitScore = 0.15,
} = {}) {
  const values = {
    level: clobLevelOn ? component(finite(midpoint) == null ? null : Number(midpoint) - 0.5,
      levelScale) : null,
    clob: clobVelocityOn ? component(midVelocity, clobScale) : null,
    binance: binanceVelocityOn ? component(binanceVelocity, binanceScale) : null,
  };
  const weights = {
    level: Math.max(0, finite(levelWeight) ?? 0),
    clob: Math.max(0, finite(clobWeight) ?? 0),
    binance: Math.max(0, finite(binanceWeight) ?? 0),
  };
  let weighted = 0, availableWeight = 0;
  for (const key of Object.keys(values)) {
    if (values[key] == null || weights[key] <= 0) continue;
    weighted += values[key] * weights[key];
    availableWeight += weights[key];
  }
  const score = availableWeight > EPS ? clamp(weighted / availableWeight, -1, 1) : null;
  const confidence = score == null ? null : Math.abs(score);
  const rawSide = score == null || Math.abs(score) <= EPS ? null : (score > 0 ? "Up" : "Down");
  const enter = clamp(finite(enterScore) ?? 0.35, 0, 1);
  const exit = clamp(Math.min(enter, finite(exitScore) ?? 0.15), 0, 1);
  return {
    score,
    confidence,
    rawSide,
    side: confidence != null && confidence + EPS >= enter ? rawSide : null,
    qualified: confidence != null && confidence + EPS >= enter,
    released: confidence == null || confidence <= exit + EPS,
    enterScore: enter,
    exitScore: exit,
    components: values,
    availableWeight,
  };
}

export function releaseState(model) {
  return model.release || (model.release = {
    armed: true,
    activeSide: null,
    candidateSide: null,
    candidateSinceMs: null,
    lastFireMs: -Infinity,
    lastFireByRole: {},
    lastFiredSide: null,
    lastFiredConfidence: null,
    lastFiredMidpoint: null,
  });
}

/** Reset the latch only after the score returns inside the lower band. */
export function observeReleaseBand(model, direction) {
  const state = releaseState(model);
  if (!direction || direction.released) {
    state.armed = true;
    state.activeSide = null;
    state.candidateSide = null;
    state.candidateSinceMs = null;
    return { state, rearmed: true };
  }
  if (direction.rawSide && state.activeSide && direction.rawSide !== state.activeSide) {
    state.armed = true;
    state.activeSide = direction.rawSide;
    state.candidateSide = null;
    state.candidateSinceMs = null;
    return { state, rearmed: true };
  }
  if (direction.rawSide && !state.activeSide) state.activeSide = direction.rawSide;
  return { state, rearmed: false };
}

/**
 * Decide whether a qualified observation is a new release. Same-side top-ups
 * may re-arm during a sustained move only after a material score or price step.
 */
export function evaluateRelease(model, {
  direction,
  role,
  clockMs,
  midpoint,
  confirmMs = 0,
  roleCooldownMs = 0,
  topupScoreStep = 0.2,
  topupPriceStep = 0.05,
} = {}) {
  const state = releaseState(model);
  observeReleaseBand(model, direction);
  if (!direction?.qualified || !direction.side) {
    return { eligible: false, gate: direction?.released ? "signal-rearmed" : "direction-score" };
  }

  // A first entry is also the preceding same-side release for its first top-up.
  // Subsequent hedge/reversal cooldowns remain role-local.
  const priorRoleFireMs = role === "topup"
    ? state.lastFireMs : state.lastFireByRole[role];
  const sinceRole = Number(clockMs) - Number(priorRoleFireMs ?? -Infinity);
  if (!state.armed && role === "topup" && direction.side === state.lastFiredSide
      && sinceRole + EPS >= Math.max(0, Number(roleCooldownMs) || 0)) {
    const scoreStep = direction.confidence - Number(state.lastFiredConfidence ?? direction.confidence);
    const priceStep = Math.abs(Number(midpoint) - Number(state.lastFiredMidpoint ?? midpoint));
    if (scoreStep + EPS >= Math.max(0, Number(topupScoreStep) || 0)
        || priceStep + EPS >= Math.max(0, Number(topupPriceStep) || 0)) {
      state.armed = true;
      state.candidateSide = null;
      state.candidateSinceMs = null;
    }
  }

  if (!state.armed) return { eligible: false, gate: "signal-latched" };
  if (sinceRole + EPS < Math.max(0, Number(roleCooldownMs) || 0)) {
    return { eligible: false, gate: `${role}-cooldown`, remainingMs: roleCooldownMs - sinceRole };
  }
  if (state.candidateSide !== direction.side) {
    state.candidateSide = direction.side;
    state.candidateSinceMs = Number(clockMs);
  }
  const confirmedMs = Math.max(0, Number(clockMs) - Number(state.candidateSinceMs));
  const neededMs = Math.max(0, Number(confirmMs) || 0);
  return confirmedMs + EPS >= neededMs
    ? { eligible: true, gate: "release", confirmedMs }
    : { eligible: false, gate: `${role}-confirmation`, confirmedMs, remainingMs: neededMs - confirmedMs };
}

export function markReleaseFired(model, {
  role,
  side,
  clockMs,
  confidence,
  midpoint,
} = {}) {
  const state = releaseState(model);
  state.armed = false;
  state.activeSide = side || null;
  state.candidateSide = null;
  state.candidateSinceMs = null;
  state.lastFireMs = Number(clockMs);
  state.lastFireByRole[role] = Number(clockMs);
  state.lastFiredSide = side || null;
  state.lastFiredConfidence = finite(confidence);
  state.lastFiredMidpoint = finite(midpoint);
  return state;
}
