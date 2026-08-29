// Strategy-independent Polymarket crypto taker-fee model.

export const PARAMS = {
  FEE_BPS: 700,
  FEE_USE_MIN: false,
  FEE_ALL_FILLS: false,
};

export function fillFee(px, shares, isTaker, p = PARAMS) {
  if (!isTaker || !p.FEE_BPS || px == null || shares == null) return 0;
  const sym = p.FEE_USE_MIN ? Math.min(px, 1 - px) : px * (1 - px);
  return (p.FEE_BPS / 10000) * sym * shares;
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
