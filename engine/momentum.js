// Shared extraction of the Up-implied CLOB midpoint. Signal construction lives
// in strategies/fastmx-signal-policy.js so production has one causal policy.

export function midOf(book) {
  return (book && book.bestBid != null && book.bestAsk != null)
    ? (book.bestBid + book.bestAsk) / 2
    : null;
}
