const EPS = 1e-9;

/** True when a submitted order satisfies the venue's minimum share quantity. */
export function validVenueOrderShares(shares, minOrderShares) {
  const quantity = Number(shares), minimum = Number(minOrderShares);
  return Number.isFinite(quantity) && Number.isFinite(minimum) && minimum > 0
    && quantity + EPS >= minimum;
}
