export function dedupeExactMarketTrades(rows) {
  const seen = new Set(), trades = [];
  let duplicatesDropped = 0;
  for (const row of rows) {
    const key = [row.ms, row.sourceSide, row.sourceOutcome, row.sourcePrice,
      row.outcome, row.price, row.size, row.transactionHash].join("|");
    if (seen.has(key)) { duplicatesDropped++; continue; }
    seen.add(key);
    trades.push(row);
  }
  return { trades, duplicatesDropped };
}
