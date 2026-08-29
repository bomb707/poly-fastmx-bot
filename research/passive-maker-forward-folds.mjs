const DAY_MS = 86_400_000;

export function expectedUtcDates(startMs, count = 30) {
  const start = new Date(startMs);
  const midnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  return Array.from({ length: count }, (_, index) => new Date(midnight + index * DAY_MS).toISOString().slice(0, 10));
}

export function fixedUtcDateFoldPnls(daily, startMs, foldCount = 3, datesPerFold = 10) {
  const dates = expectedUtcDates(startMs, foldCount * datesPerFold);
  return Array.from({ length: foldCount }, (_, index) => {
    const foldDates = dates.slice(index * datesPerFold, (index + 1) * datesPerFold);
    const complete = foldDates.every((day) => Object.hasOwn(daily || {}, day));
    const pnl = foldDates.reduce((sum, day) => sum + Number(daily?.[day] || 0), 0);
    return { index: index + 1, from: foldDates[0], to: foldDates.at(-1), dates: foldDates.length, complete, pnl };
  });
}
