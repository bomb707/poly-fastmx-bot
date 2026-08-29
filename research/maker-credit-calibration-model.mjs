const EPS = 1e-9;

export const exactCent = (value) => Number(value).toFixed(2);

export function targetMakerFillKey(row) {
  return [
    String(row?.slug || ""),
    String(row?.transactionHash || "").toLowerCase(),
    /^up$/i.test(String(row?.outcome || "")) ? "Up" : "Down",
    exactCent(row?.price),
  ].join(":");
}

/** Preserve distinct public partial fills while aggregating one exact price level. */
export function groupTargetMakerFills(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (String(row?.action || row?.side || "BUY").toUpperCase() !== "BUY"
      || row?.role !== "maker" || !(Number(row?.size) > 0) || !(Number(row?.price) > 0)) continue;
    const key = targetMakerFillKey(row);
    let fill = grouped.get(key);
    if (!fill) {
      fill = {
        key,
        slug: String(row.slug),
        transactionHash: String(row.transactionHash || "").toLowerCase(),
        outcome: /^up$/i.test(String(row.outcome || "")) ? "Up" : "Down",
        price: Number(exactCent(row.price)),
        timestamp: Number(row.timestamp),
        components: 0,
        shares: 0,
      };
      grouped.set(key, fill);
    }
    fill.timestamp = Math.max(fill.timestamp, Number(row.timestamp));
    fill.components++;
    fill.shares += Number(row.size);
  }
  return grouped;
}

export function exactPriceVolume(trades, { outcome, price, fromMs, toMs }) {
  return (trades || []).reduce((total, trade) => total
    + (trade.outcome === outcome && Math.abs(Number(trade.price) - Number(price)) < .005
      && Number(trade.ms) >= fromMs && Number(trade.ms) <= toMs ? Number(trade.size || 0) : 0), 0);
}

export function captureMetrics({ targetShares, exactVolume, queueAhead }) {
  const shares = Number(targetShares), volume = Number(exactVolume), ahead = Math.max(0, Number(queueAhead) || 0);
  if (!(shares > 0) || !(volume > 0)) return null;
  const postQueueVolume = Math.max(0, volume - ahead);
  return {
    targetShares: shares,
    exactVolume: volume,
    queueAhead: ahead,
    postQueueVolume,
    rawCapture: shares / volume,
    postQueueCapture: postQueueVolume > EPS ? shares / postQueueVolume : null,
    volumeConsistent: shares <= volume + 1e-6,
    queueConsistent: shares <= postQueueVolume + 1e-6,
  };
}

/** Mark same-market, same-token-price order lifetimes that reuse public flow. */
export function markOverlappingIntervals(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = [row.slug, row.outcome, exactCent(row.price)].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const overlapping = new Set();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
    for (let left = 0; left < sorted.length; left++) {
      for (let right = left + 1; right < sorted.length && sorted[right].fromMs <= sorted[left].toMs; right++) {
        if (sorted[right].toMs >= sorted[left].fromMs) {
          overlapping.add(sorted[left].orderHash);
          overlapping.add(sorted[right].orderHash);
        }
      }
    }
  }
  return rows.map((row) => ({ ...row, overlapsTargetOrder: overlapping.has(row.orderHash) }));
}

/** Cluster bootstrap of a volume-weighted capture ratio, resampling whole windows. */
export function bootstrapRatioLower95(rows, numerator, denominator, samples = 5000, seed = 0x3048d653) {
  const clusters = [...(rows || []).reduce((map, row) => {
    const key = String(row.slug || "");
    let cluster = map.get(key);
    if (!cluster) { cluster = { numerator: 0, denominator: 0 }; map.set(key, cluster); }
    cluster.numerator += Number(row[numerator] || 0);
    cluster.denominator += Number(row[denominator] || 0);
    return map;
  }, new Map()).values()].filter((row) => row.denominator > 0);
  if (!clusters.length) return null;
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const ratios = [];
  for (let sample = 0; sample < samples; sample++) {
    let top = 0, bottom = 0;
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      top += cluster.numerator;
      bottom += cluster.denominator;
    }
    ratios.push(bottom > 0 ? top / bottom : 0);
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor((ratios.length - 1) * .025)];
}
