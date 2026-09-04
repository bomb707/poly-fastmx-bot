// Target-wallet entry sizing reconstructed from exact signed BUY orders.
//
// Discovery: 0x75cc…3ce1 BTC 5m orders released 2026-09-02 through
// 2026-09-03 UTC. The order calldata proves that the wallet chooses integer
// minimum-share tiers at cent-denominated caps and fixes budgetUsd=cap*shares.
// The curve below is a robust, locally-smoothed median by signed cap. Sep 4 was
// held out when selecting the shape. It is normalized to the caller's base
// size, so H_BASE_ORDER_SH remains the capital/risk control.

export const TARGET_SIZE_MODEL = Object.freeze({
  id: "75cc-btc5m-cap-median-v1",
  wallet: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  discoveryFrom: "2026-09-02T00:00:00Z",
  discoveryTo: "2026-09-04T00:00:00Z",
  holdoutFrom: "2026-09-04T00:00:00Z",
  referenceCap: 0.70,
  referenceShares: 8,
  anchors: Object.freeze([
    [0.05, 32], [0.10, 27], [0.15, 12], [0.20, 10], [0.30, 10],
    [0.40, 8], [0.50, 9], [0.60, 9], [0.70, 8], [0.80, 8],
    [0.85, 8], [0.90, 9], [0.91, 10], [0.92, 10], [0.93, 11],
    [0.94, 12], [0.95, 14], [0.96, 15], [0.97, 18], [0.98, 19],
  ]),
});

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function targetSizeMedianAtCap(cap, model = TARGET_SIZE_MODEL) {
  const value = finite(cap);
  if (value == null) return null;
  const anchors = model.anchors;
  if (value <= anchors[0][0]) return anchors[0][1];
  if (value >= anchors.at(-1)[0]) return anchors.at(-1)[1];
  for (let index = 1; index < anchors.length; index++) {
    const [rightCap, rightShares] = anchors[index];
    if (value > rightCap) continue;
    const [leftCap, leftShares] = anchors[index - 1];
    const weight = (value - leftCap) / (rightCap - leftCap);
    return leftShares + (rightShares - leftShares) * weight;
  }
  return anchors.at(-1)[1];
}

/**
 * Reproduce the target's cap-dependent shape while retaining the bot's base
 * size as its risk scale. Returned quantities are integer minimum shares, as
 * observed in every decoded target order.
 */
export function targetWalletEntryShares(cap, {
  baseShares = 7,
  minShares = 4,
  maxShares = 50,
  scale = 1,
  model = TARGET_SIZE_MODEL,
} = {}) {
  const median = targetSizeMedianAtCap(cap, model);
  const base = Math.max(0, finite(baseShares) ?? 7);
  const minimum = Math.max(1, Math.ceil(finite(minShares) ?? 4));
  const maximum = Math.max(minimum, Math.floor(finite(maxShares) ?? 50));
  const multiplier = Math.max(0, finite(scale) ?? 1);
  if (!(median > 0) || !(model.referenceShares > 0)) {
    return Math.min(maximum, Math.max(minimum, Math.round(base)));
  }
  const desired = median / model.referenceShares * base * multiplier;
  return Math.min(maximum, Math.max(minimum, Math.round(desired)));
}

/**
 * Apply the decoded cap curve by action role. First entries use the full curve;
 * top-ups scale from a conservative floor to the full curve as the causal
 * direction confidence rises. Inventory hedges stay exact-share decisions and
 * deliberately bypass cap-shaped entry sizing.
 */
export function targetWalletRoleShares(cap, {
  role = "first-entry",
  confidence = 1,
  enterScore = 0.35,
  topupMinScale = 0.65,
  ...options
} = {}) {
  const base = targetWalletEntryShares(cap, options);
  if (role !== "topup") return base;
  const enter = Math.max(0, Math.min(1, finite(enterScore) ?? 0.35));
  const conf = Math.max(enter, Math.min(1, finite(confidence) ?? enter));
  const floor = Math.max(0, Math.min(1, finite(topupMinScale) ?? 0.65));
  const normalized = (conf - enter) / Math.max(1e-9, 1 - enter);
  const scale = floor + (1 - floor) * normalized;
  const minimum = Math.max(1, Math.ceil(finite(options.minShares) ?? 4));
  return Math.max(minimum, Math.round(base * scale));
}
