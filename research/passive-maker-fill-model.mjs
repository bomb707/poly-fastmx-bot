/**
 * Conservatively allocate one public exact-price taker print across our FIFO
 * resting maker orders. The same market-wide trade volume may reduce every
 * order's recorded queue-ahead, but its maker-credit allowance is shared: it
 * cannot be credited independently to multiple orders.
 */
export function allocateConservedMakerFills(orders, tradeSize, makerCredit) {
  const size = Number(tradeSize);
  const credit = Number(makerCredit);
  if (!(size > 0) || !(credit > 0) || !orders.length) return [];

  const ordered = [...orders].sort((a, b) =>
    Number(a.effectiveArrivalMs || 0) - Number(b.effectiveArrivalMs || 0)
      || Number(a.sequence || 0) - Number(b.sequence || 0));
  const eligibility = [];
  for (const order of ordered) {
    const queueAhead = Math.max(0, Number(order.queueAhead || 0));
    const consumedAhead = Math.min(queueAhead, size);
    order.queueAhead = queueAhead - consumedAhead;
    eligibility.push({ order, postQueueVolume: Math.max(0, size - queueAhead) });
  }

  let sharedCreditBudget = size * credit;
  const fills = [];
  for (const { order, postQueueVolume } of eligibility) {
    if (!(Number(order.shares) > 1e-9)) continue;
    // A later own order cannot receive a fill while an earlier own order at
    // the same token/price is still ahead of it.
    if (!(postQueueVolume > 1e-9) || !(sharedCreditBudget > 1e-9)) break;
    const shares = Math.min(Number(order.shares), postQueueVolume * credit, sharedCreditBudget);
    if (shares > 1e-9) {
      order.shares -= shares;
      sharedCreditBudget -= shares;
      fills.push({ order, shares });
    }
    if (order.shares > 1e-9) break;
  }
  return fills;
}
