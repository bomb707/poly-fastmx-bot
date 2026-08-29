/**
 * Evaluate a minimum-size taker buy of the missing outcome. The completion is
 * safe only when the lower of the two possible final payouts covers all
 * accumulated strategy cost plus this exact fee-inclusive buy.
 */
export function assessDustLock({ up, down, cost, buySide, buyShares, buyCost, buyFees, minOrderShares, minProfit = 0 }) {
  const values = [up, down, cost, buyShares, buyCost, buyFees, minOrderShares, minProfit].map(Number);
  if (!values.every(Number.isFinite) || !(buyShares >= minOrderShares) || !(buyShares > 0))
    return { allowed: false, reason: "invalid_or_subminimum" };
  const newUp = Number(up) + (buySide === "Up" ? buyShares : 0);
  const newDown = Number(down) + (buySide === "Down" ? buyShares : 0);
  const newCost = Number(cost) + Number(buyCost) + Number(buyFees);
  const worstPayout = Math.min(newUp, newDown);
  const lockedPnl = worstPayout - newCost;
  return { allowed: lockedPnl + 1e-9 >= Number(minProfit), newUp, newDown, newCost, worstPayout, lockedPnl };
}
