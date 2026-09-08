// In-memory Polymarket market-channel L2 book.
// `book` is a full snapshot; each `price_change` size is the new absolute
// aggregate size at that price (zero removes the level).

function level(row) {
  const price = Number(Array.isArray(row) ? row[0] : row?.price);
  const size = Number(Array.isArray(row) ? row[1] : row?.size);
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size) || size < 0) return null;
  return { price, size };
}

export class MarketDepthBook {
  constructor() {
    this.bids = new Map();
    this.asks = new Map();
    this.synchronized = false;
    this.valid = false;
    this.invalidLevelCount = 0;
    this.lastApplyInvalid = false;
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.synchronized = false;
    this.valid = false;
    this.invalidLevelCount = 0;
    this.lastApplyInvalid = false;
  }

  replace(snapshot = {}) {
    const bidsPresent = Array.isArray(snapshot?.bids);
    const asksPresent = Array.isArray(snapshot?.asks);
    const bids = bidsPresent ? snapshot.bids : [];
    const asks = asksPresent ? snapshot.asks : [];
    const nextBids = new Map();
    const nextAsks = new Map();
    let invalidLevelCount = Number(!bidsPresent) + Number(!asksPresent);
    const load = (rows, target) => {
      for (const row of rows) {
        const parsed = level(row);
        if (!parsed) { invalidLevelCount++; continue; }
        if (parsed.size > 0) target.set(parsed.price, parsed.size);
      }
    };
    load(bids, nextBids);
    load(asks, nextAsks);
    this.bids = nextBids;
    this.asks = nextAsks;
    this.synchronized = true;
    this.valid = bidsPresent && asksPresent && invalidLevelCount === 0;
    this.invalidLevelCount = invalidLevelCount;
    this.lastApplyInvalid = false;
    return true;
  }

  apply(change) {
    this.lastApplyInvalid = false;
    if (!this.synchronized) return false;
    const parsed = level(change);
    if (!parsed) {
      this.valid = false;
      this.invalidLevelCount++;
      this.lastApplyInvalid = true;
      return false;
    }
    const side = String(change?.side || '').toUpperCase();
    const target = side === 'BUY' ? this.bids : side === 'SELL' ? this.asks : null;
    if (!target) {
      this.valid = false;
      this.invalidLevelCount++;
      this.lastApplyInvalid = true;
      return false;
    }
    if (parsed.size === 0) target.delete(parsed.price);
    else target.set(parsed.price, parsed.size);
    return true;
  }

  snapshot(limit = 12) {
    const count = Math.max(1, Number(limit) || 12);
    return {
      synchronized: this.synchronized,
      valid: this.valid,
      invalidLevelCount: this.invalidLevelCount,
      bids: [...this.bids].sort((a, b) => b[0] - a[0]).slice(0, count),
      asks: [...this.asks].sort((a, b) => a[0] - b[0]).slice(0, count),
    };
  }
}
