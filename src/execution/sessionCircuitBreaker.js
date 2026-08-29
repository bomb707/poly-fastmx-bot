// Session-scoped realized-PnL breaker. Each Start creates a new generation so
// a delayed settlement from a stopped/older run cannot halt the fresh session.
export function createSessionCircuitBreaker(limitProvider = () => 0, onTrip = () => {}) {
  let generation = 0;
  let sessionRealized = 0;
  let tripped = false;

  const limit = () => Math.max(0, Number(limitProvider()) || 0);
  const state = () => ({
    generation,
    sessionRealized: Math.round(sessionRealized * 100) / 100,
    tripped,
    limit: limit(),
  });

  return {
    stamp: () => generation,
    reset() {
      generation++;
      sessionRealized = 0;
      tripped = false;
      return state();
    },
    record(windowGeneration, pnl) {
      if (windowGeneration !== generation) return state();
      sessionRealized += Number(pnl) || 0;
      const activeLimit = limit();
      if (!tripped && activeLimit > 0 && sessionRealized <= -activeLimit) {
        tripped = true;
        onTrip({ sessionRealized: Math.round(sessionRealized * 100) / 100, limit: activeLimit });
      }
      return state();
    },
    state,
  };
}
