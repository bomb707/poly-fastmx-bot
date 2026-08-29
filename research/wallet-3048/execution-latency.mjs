/** Return the first raw-book tick at or after targetMs, or null. */
export function firstTickAtOrAfter(ticks, targetMs) {
  if (!Array.isArray(ticks) || !ticks.length || !Number.isFinite(Number(targetMs))) return null;
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(ticks[middle]?.ms) >= targetMs) { answer = middle; high = middle - 1; }
    else low = middle + 1;
  }
  return answer >= 0 ? ticks[answer] : null;
}

export function orderExecutionTicks(ticks, decisionMs, makerLatencyMs = 130, takerLatencyMs = 520) {
  return {
    maker: firstTickAtOrAfter(ticks, Number(decisionMs) + Number(makerLatencyMs)),
    taker: firstTickAtOrAfter(ticks, Number(decisionMs) + Number(takerLatencyMs)),
  };
}
