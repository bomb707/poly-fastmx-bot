// Strategy-independent Polymarket crypto taker-fee model.

export const PARAMS = {
  FEE_BPS: 700,
  FEE_USE_MIN: false,
  FEE_ALL_FILLS: false,
};

export function fillFee(px, shares, isTaker, p = PARAMS) {
  if (!isTaker || !p.FEE_BPS || px == null || shares == null) return 0;
  const sym = p.FEE_USE_MIN ? Math.min(px, 1 - px) : px * (1 - px);
  const raw = (p.FEE_BPS / 10000) * sym * shares;
  if (!Number.isFinite(raw) || raw < 0.00001) return 0;
  return Math.round(raw * 100000) / 100000;
}

/** Fee for one simulated execution, preserving nonlinear per-level pricing. */
export function executionFee(match, isTaker, p = PARAMS) {
  if (!isTaker) return 0;
  if (Array.isArray(match?.levels) && match.levels.length) {
    return match.levels.reduce((sum, level) => sum
      + fillFee(level.price, level.shares, true, p), 0);
  }
  return fillFee(match?.avgPx, match?.shares, true, p);
}

export function isTakerFill(fill) {
  return fill?.taker === true
    || fill?.exec === "marketable"
    || (typeof fill?.kind === "string" && fill.kind.includes("taker"));
}

export function isFeeFill(fill, p = PARAMS) {
  return p.FEE_ALL_FILLS ? true : isTakerFill(fill);
}

export function takerShares(ask, usd, p = PARAMS) {
  return usd / (ask + fillFee(ask, 1, true, p));
}
