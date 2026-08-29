/** Return due maker orders in causal submission/FIFO order without mutation. */
export function dueMakerArrivals(arriving, tickMs) {
  return (arriving || []).filter((order) => Number(order.arrivalMs) <= Number(tickMs))
    .sort((a, b) => Number(a.arrivalMs) - Number(b.arrivalMs) || Number(a.sequence) - Number(b.sequence));
}
