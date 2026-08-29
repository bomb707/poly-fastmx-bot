const clampProbability = (value) => Math.max(0, Math.min(1, Number(value)));

function median(values) {
  const sorted = values.map(clampProbability).sort((left, right) => left - right);
  if (sorted.some((value) => !Number.isFinite(value))) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Robustly pool three Brownian terminal-probability models and the CLOB
 * midpoint.  The center is the 50% trimmed mean of four values (the mean of
 * the middle two).  Lower/upper leave-one-side-out models are mandatory
 * structural neighbors, not runtime confidence switches.
 */
export function poolFairProbability(models, mode = "median-pool") {
  const h = Number(models?.harmonic), g = Number(models?.geometric);
  const a = Number(models?.arithmetic), market = Number(models?.market);
  if (![h, g, a, market].every(Number.isFinite)) return NaN;
  if (mode === "median-pool-lower") return median([h, g, market]);
  if (mode === "median-pool-upper") return median([g, a, market]);
  return median([h, g, a, market]);
}
