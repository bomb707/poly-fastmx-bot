import { fillFee } from "../fees.js";
import { REGIME_META, REGIME_MODEL, REGIME_POLICY } from "./target75cc-regime-model.js";
import { REGIME_FEATURE_NAMES, regimeFeatures } from "./target75cc-regime-features.js";

const EPS = 1e-9;
const finite = (input) => input != null && input !== "" && Number.isFinite(Number(input));
const number = (input, fallback) => finite(input) ? Number(input) : fallback;
const clamp = (input, low, high) => Math.max(low, Math.min(high, input));

export const REGIME_CLASSES = Object.freeze({
  TREND_CONTINUATION: "TREND_CONTINUATION",
  TEMPORARY_NOISE: "TEMPORARY_NOISE",
  PULLBACK_ENTRY_OPPORTUNITY: "PULLBACK_ENTRY_OPPORTUNITY",
  POSSIBLE_REVERSAL: "POSSIBLE_REVERSAL",
  CONFIRMED_REVERSAL: "CONFIRMED_REVERSAL",
  UNCERTAIN: "UNCERTAIN",
});

export function scoreRegime(vector) {
  let logit = number(REGIME_MODEL.intercept, 0);
  for (let index = 0; index < REGIME_FEATURE_NAMES.length; index++) {
    const weight = number(REGIME_MODEL.weights[index], 0);
    if (!weight) continue;
    const mean = number(REGIME_MODEL.normalization.mean[index], 0);
    const scale = Math.max(EPS, number(REGIME_MODEL.normalization.scale[index], 1));
    const standardized = clamp((number(vector[index], 0) - mean) / scale, -10, 10);
    logit += weight * standardized;
  }
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}

export function interpretRegime(raw, sideProbability, ask, P = {}) {
  const dominantThreshold = Math.max(0, number(P.T_REGIME_DOMINANT_THRESHOLD,
    REGIME_POLICY.dominantThreshold));
  const shortThreshold = Math.max(0, number(P.T_REGIME_SHORT_THRESHOLD,
    REGIME_POLICY.shortCounterThreshold));
  const minimumProbability = clamp(number(P.T_REGIME_MIN_PROBABILITY,
    REGIME_POLICY.minimumProbability), 0, 1);
  const minimumEdge = number(P.T_REGIME_MIN_EDGE, REGIME_POLICY.minimumEdge);
  const reversalProbability = clamp(number(P.T_REGIME_REVERSAL_MIN_PROBABILITY,
    REGIME_POLICY.reversalMinimumProbability), 0, 1);
  const confirmedReversalProbability = clamp(number(P.T_REGIME_CONFIRMED_REVERSAL_PROBABILITY,
    REGIME_POLICY.confirmedReversalProbability), reversalProbability, 1);
  const pullbackProbability = clamp(number(P.T_REGIME_PULLBACK_MIN_PROBABILITY,
    REGIME_POLICY.pullbackMinimumProbability), minimumProbability, 1);
  const feePerShare = fillFee(ask, 1, true);
  const expectedEdge = sideProbability - ask - feePerShare;
  const dominant = number(raw?.dominantScore, 0), short = number(raw?.shortScore, 0);
  const candidateIsDominant = dominant >= dominantThreshold;
  const candidateOpposesDominant = dominant <= -dominantThreshold;
  const shortPullback = short <= -shortThreshold;
  const shortCounterTrend = short >= shortThreshold;
  const baseAllowed = sideProbability >= minimumProbability && expectedEdge >= minimumEdge;

  let classification = REGIME_CLASSES.UNCERTAIN;
  if (candidateIsDominant && shortPullback) {
    classification = baseAllowed && sideProbability >= pullbackProbability
      ? REGIME_CLASSES.PULLBACK_ENTRY_OPPORTUNITY
      : sideProbability < .5 ? REGIME_CLASSES.POSSIBLE_REVERSAL : REGIME_CLASSES.TEMPORARY_NOISE;
  } else if (candidateOpposesDominant && shortCounterTrend) {
    classification = sideProbability >= confirmedReversalProbability
      ? REGIME_CLASSES.CONFIRMED_REVERSAL
      : sideProbability >= reversalProbability
        ? REGIME_CLASSES.POSSIBLE_REVERSAL : REGIME_CLASSES.TEMPORARY_NOISE;
  } else if (candidateIsDominant && short >= -shortThreshold) {
    classification = baseAllowed ? REGIME_CLASSES.TREND_CONTINUATION : REGIME_CLASSES.UNCERTAIN;
  } else if (candidateOpposesDominant) {
    classification = sideProbability >= reversalProbability
      ? REGIME_CLASSES.POSSIBLE_REVERSAL : REGIME_CLASSES.UNCERTAIN;
  }

  const reversalCandidate = candidateOpposesDominant;
  const allowed = baseAllowed
    && (!reversalCandidate || sideProbability >= reversalProbability)
    && (!(candidateIsDominant && shortPullback) || sideProbability >= pullbackProbability);
  const breakEvenProbability = clamp(ask + feePerShare + minimumEdge, 0, 1);
  const confidence = clamp((sideProbability - breakEvenProbability)
    / Math.max(EPS, 1 - breakEvenProbability), 0, 1);
  const floor = Math.max(.05, number(P.T_REGIME_SIZE_FLOOR, REGIME_POLICY.confidenceScaleFloor));
  const ceiling = Math.max(floor, number(P.T_REGIME_SIZE_CEILING,
    REGIME_POLICY.confidenceScaleCeiling));
  const sizeScale = P.T_REGIME_CONFIDENCE_SIZING === false ? 1
    : floor + (ceiling - floor) * Math.sqrt(confidence);

  return {
    classification,
    allowed,
    sideProbability,
    noiseProbability: reversalCandidate ? 1 - sideProbability : sideProbability,
    reversalProbability: reversalCandidate ? sideProbability : 1 - sideProbability,
    expectedEdge,
    feePerShare,
    breakEvenProbability,
    confidence,
    sizeScale,
    dominantScore: dominant,
    shortScore: short,
    candidateIsDominant,
    candidateOpposesDominant,
    shortPullback,
    shortCounterTrend,
    thresholds: { minimumProbability, minimumEdge, reversalProbability, confirmedReversalProbability,
      pullbackProbability,
      dominantThreshold, shortThreshold },
  };
}

export function evaluateRegime({ history, current, tk, side, clockMs, P } = {}) {
  const features = regimeFeatures({ history, current, tk, side, clockMs });
  if (!features) return null;
  const sideProbability = scoreRegime(features.vector);
  return { ...interpretRegime(features.raw, sideProbability, Number(current[side].ask), P),
    features: features.raw, modelSha256: REGIME_META.modelSha256 };
}

export { REGIME_META, REGIME_MODEL, REGIME_POLICY };
