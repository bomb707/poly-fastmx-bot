/**
 * Combine contemporaneous Chainlink and Binance percentage gaps without
 * consulting outcomes or future ticks. Consensus modes return zero when the
 * feed directions disagree.
 */
export function aggregateSpotGap(chainlinkGap, binanceGap, mode = "weighted", chainlinkWeight = .7) {
  const cl = Number(chainlinkGap), bz = Number(binanceGap);
  if (!Number.isFinite(cl) || !Number.isFinite(bz)) return NaN;
  const weight = Math.max(0, Math.min(1, Number(chainlinkWeight)));
  if (mode === "weighted") return weight * cl + (1 - weight) * bz;
  if (Math.sign(cl) !== Math.sign(bz)) return 0;
  const sign = Math.sign(cl), a = Math.abs(cl), b = Math.abs(bz);
  const conservative = sign * Math.min(a, b);
  const harmonic = a + b > 0 ? sign * 2 * a * b / (a + b) : 0;
  const geometric = sign * Math.sqrt(a * b);
  const arithmetic = sign * (a + b) / 2;
  if (mode === "conservative") return conservative;
  if (mode === "harmonic") return harmonic;
  if (mode === "geometric") return geometric;
  if (mode === "arithmetic") return arithmetic;
  if (mode === "lower-ensemble") return (harmonic + geometric) / 2;
  if (mode === "upper-ensemble") return (geometric + arithmetic) / 2;
  if (mode === "power-ensemble") return (harmonic + geometric + arithmetic) / 3;
  return weight * cl + (1 - weight) * bz;
}
