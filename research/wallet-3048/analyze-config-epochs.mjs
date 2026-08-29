#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const source = JSON.parse(fs.readFileSync(path.join(dataDir, "trades-2026-08-14_2026-08-22.json"), "utf8"));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const cancels = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "cancel-replacements.json.gz")))).rows;
const marketBySlug = new Map(source.markets.map((row) => [row.slug, row]));
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const iso = (ms) => new Date(ms).toISOString();
const q = (values, probabilities = [.1, .25, .5, .75, .9]) => Object.fromEntries(probabilities.map((probability) => [
  `p${Math.round(probability * 100)}`,
  round(quantile(values.filter(finite).map(Number), probability), 3),
]));
const modes = (values) => [...values.reduce((map, value) => {
  if (!finite(value)) return map;
  const key = Number(value);
  map.set(key, (map.get(key) || 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([value, count]) => ({ value, count }));

function weightedQuantile(rows, probability, field = "value", weight = "weight") {
  const ordered = rows.filter((row) => finite(row[field]) && Number(row[weight]) > 0)
    .sort((a, b) => Number(a[field]) - Number(b[field]));
  const total = ordered.reduce((sum, row) => sum + Number(row[weight]), 0);
  if (!total) return null;
  const target = probability * total;
  let cumulative = 0;
  for (const row of ordered) {
    cumulative += Number(row[weight]);
    if (cumulative >= target) return Number(row[field]);
  }
  return Number(ordered.at(-1)[field]);
}

// These boundaries are the first five-minute market in which a new recovered
// filled size mode appears. They describe observed configurations, not private
// settings: an enabled size that never fills is inherently invisible.
const epochDefinitions = [
  { id: "E1", label: "80", start: "2026-08-14T00:00:00Z", end: "2026-08-15T20:05:00Z" },
  { id: "E2", label: "50", start: "2026-08-15T20:05:00Z", end: "2026-08-18T05:10:00Z" },
  { id: "E3", label: "20", start: "2026-08-18T05:10:00Z", end: "2026-08-18T06:15:00Z" },
  { id: "E4", label: "30", start: "2026-08-18T06:15:00Z", end: "2026-08-18T20:35:00Z" },
  { id: "E5", label: "30+60", start: "2026-08-18T20:35:00Z", end: "2026-08-19T12:25:00Z" },
  { id: "E6", label: "30+90", start: "2026-08-19T12:25:00Z", end: "2026-08-20T15:30:00Z" },
  { id: "E7", label: "30+60+90", start: "2026-08-20T15:30:00Z", end: "2026-08-21T19:55:00Z" },
  { id: "E8", label: "30+90 pair-priority", start: "2026-08-21T19:55:00Z", end: "2026-08-22T17:00:00Z" },
].map((row) => ({ ...row, startMs: Date.parse(row.start), endMs: Date.parse(row.end) }));

function epochAt(ms) {
  return epochDefinitions.find((epoch) => ms >= epoch.startMs && ms < epoch.endMs) || null;
}

function exactOrderFee(order) {
  return order.settlements.reduce((sum, settlement) => {
    if (settlement.role !== "taker") return sum;
    const shares = Number(settlement.shares), price = Number(settlement.vwap);
    return sum + .07 * price * (1 - price) * shares;
  }, 0);
}

const fireBySlug = new Map();
for (const fire of fires) {
  const order = signedByHash.get(fire.orderHash);
  if (!order) continue;
  if (!fireBySlug.has(fire.slug)) fireBySlug.set(fire.slug, []);
  fireBySlug.get(fire.slug).push({
    ...fire,
    order,
    fillPrice: Number(order.vwap),
    fillFee: exactOrderFee(order),
    effectivePrice: Number(order.filledShares) ? (Number(order.filledUsd) + exactOrderFee(order)) / Number(order.filledShares) : null,
  });
}

// Label order roles from the inventory state at independently inferred fire
// time. An order can hedge existing inventory and overbuy through neutral.
const labeledFires = [];
const fireWindows = [];
for (const [slug, rows] of fireBySlug) {
  const ordered = [...rows].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const queues = { Up: [], Down: [] };
  let up = 0, down = 0, signCrosses = 0;
  const lots = [];
  for (const row of ordered) {
    const side = row.outcome, opposite = side === "Up" ? "Down" : "Up";
    let remaining = Number(row.filledShares), hedgeShares = 0;
    while (remaining > 1e-9 && queues[opposite].length) {
      const lot = queues[opposite][0], take = Math.min(remaining, lot.remaining);
      const pairCost = Number(row.effectivePrice) + Number(lot.effectivePrice);
      lots.push({ value: pairCost, weight: take, pnl: take * (1 - pairCost) });
      hedgeShares += take;
      remaining -= take;
      lot.remaining -= take;
      if (lot.remaining <= 1e-9) queues[opposite].shift();
    }
    const entryShares = Math.max(0, remaining);
    if (entryShares > 1e-9) queues[side].push({ remaining: entryShares, effectivePrice: row.effectivePrice });
    const before = up - down;
    if (side === "Up") up += Number(row.filledShares); else down += Number(row.filledShares);
    const after = up - down;
    if (Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) signCrosses++;
    labeledFires.push({
      ...row,
      role: hedgeShares <= 1e-9 ? "entry/topup" : entryShares <= 1e-9 ? "hedge" : "overhedge-cross",
      hedgeShares,
      entryShares,
      beforeImbalance: before,
      afterImbalance: after,
    });
  }
  const highMedium = ordered.filter((row) => row.confidence !== "low");
  fireWindows.push({
    slug,
    startMs: slugStart(slug),
    orders: ordered.length,
    highMedium: highMedium.length,
    firstFireS: highMedium.length ? (highMedium[0].fireMs - slugStart(slug)) / 1000 : null,
    lastFireS: highMedium.length ? (highMedium.at(-1).fireMs - slugStart(slug)) / 1000 : null,
    signCrosses,
    pairLots: lots,
  });
}

// Major EIP-712 construction waves: a new batch begins after 60 seconds. The
// timestamp is used for batching only; it is never treated as order fire time.
const signingWaves = [];
for (const [slug, rows] of fireBySlug) {
  const ordered = [...rows].sort((a, b) => a.order.signedTimestampMs - b.order.signedTimestampMs || a.orderHash.localeCompare(b.orderHash));
  let batch = [];
  for (const row of ordered) {
    if (batch.length && row.order.signedTimestampMs - batch.at(-1).order.signedTimestampMs > 60_000) {
      signingWaves.push({ slug, rows: batch });
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) signingWaves.push({ slug, rows: batch });
}

// Actual wallet economics from all public fill rows. This is independent of
// fire inference and retains partial/maker fills that cannot be timed in v4.
const tradeBySlug = new Map();
for (const trade of source.trades) {
  if (!tradeBySlug.has(trade.slug)) tradeBySlug.set(trade.slug, []);
  tradeBySlug.get(trade.slug).push(trade);
}
const economicsBySlug = new Map();
for (const [slug, rows] of tradeBySlug) {
  rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || a.outcome.localeCompare(b.outcome));
  const queues = { Up: [], Down: [] };
  const pairedLots = [];
  let grossCost = 0, fees = 0, makerShares = 0, takerShares = 0;
  for (const row of rows) {
    const shares = Number(row.size), price = Number(row.price);
    const rowFee = row.role === "taker" ? .07 * price * (1 - price) * shares : 0;
    const effectivePrice = price + rowFee / shares;
    grossCost += Number(row.usdcSize ?? price * shares);
    fees += rowFee;
    if (row.role === "maker") makerShares += shares; else takerShares += shares;
    const side = row.outcome, opposite = side === "Up" ? "Down" : "Up";
    let remaining = shares;
    while (remaining > 1e-9 && queues[opposite].length) {
      const lot = queues[opposite][0], take = Math.min(remaining, lot.remaining);
      const pairCost = effectivePrice + lot.effectivePrice;
      pairedLots.push({ value: pairCost, weight: take, pnl: take * (1 - pairCost) });
      remaining -= take;
      lot.remaining -= take;
      if (lot.remaining <= 1e-9) queues[opposite].shift();
    }
    if (remaining > 1e-9) queues[side].push({ remaining, effectivePrice });
  }
  const up = queues.Up.reduce((sum, lot) => sum + lot.remaining, 0);
  const down = queues.Down.reduce((sum, lot) => sum + lot.remaining, 0);
  const residualSide = up >= down ? "Up" : "Down";
  const residualLots = queues[residualSide];
  const residualShares = residualLots.reduce((sum, lot) => sum + lot.remaining, 0);
  const residualCost = residualLots.reduce((sum, lot) => sum + lot.remaining * lot.effectivePrice, 0);
  const winner = marketBySlug.get(slug)?.winner;
  const residualPayout = winner === residualSide ? residualShares : 0;
  const pairedShares = pairedLots.reduce((sum, lot) => sum + lot.weight, 0);
  const pairedPnl = pairedLots.reduce((sum, lot) => sum + lot.pnl, 0);
  const payout = rows.filter((row) => row.outcome === winner).reduce((sum, row) => sum + Number(row.size), 0);
  economicsBySlug.set(slug, {
    slug,
    pairedLots,
    pairedShares,
    pairedPnl,
    residualSide,
    residualShares,
    residualCost,
    residualPayout,
    residualPnl: residualPayout - residualCost,
    grossCost,
    fees,
    payout,
    totalPnl: payout - grossCost - fees,
    makerShares,
    takerShares,
  });
}

function roleSummary(rows) {
  const total = rows.length;
  return {
    entryPct: pct(rows.filter((row) => row.role === "entry/topup").length, total),
    hedgePct: pct(rows.filter((row) => row.role === "hedge").length, total),
    overhedgeCrossPct: pct(rows.filter((row) => row.role === "overhedge-cross").length, total),
  };
}

function alignment(rows, field) {
  const values = rows.map((row) => {
    const value = row.v2Feature?.[field];
    if (!finite(value)) return null;
    return Number(value) * (row.outcome === "Up" ? 1 : -1);
  }).filter(finite);
  return {
    n: values.length,
    alignedPct: pct(values.filter((value) => value > 1e-12).length, values.length),
    opposedPct: pct(values.filter((value) => value < -1e-12).length, values.length),
    zeroPct: pct(values.filter((value) => Math.abs(value) <= 1e-12).length, values.length),
  };
}

function signalSummary(rows) {
  return Object.fromEntries(["bzGapPct", "clGapPct", "bzMom1", "bzMom3", "bzMom5", "clobUpMove1", "clobUpMove3", "clobUpMove5"]
    .map((field) => [field, alignment(rows, field)]));
}

function summarize(epoch) {
  const windowSlugs = [...tradeBySlug.keys()].filter((slug) => {
    const start = slugStart(slug);
    return start >= epoch.startMs && start < epoch.endMs;
  });
  const slugSet = new Set(windowSlugs);
  const epochSigned = signed.filter((row) => row.settlements.some((settlement) => slugSet.has(settlement.slug)));
  const epochFires = labeledFires.filter((row) => slugSet.has(row.slug));
  const highMedium = epochFires.filter((row) => row.confidence !== "low");
  const fireWindowRows = fireWindows.filter((row) => slugSet.has(row.slug));
  const epochWaves = signingWaves.filter((wave) => slugSet.has(wave.slug));
  const economics = windowSlugs.map((slug) => economicsBySlug.get(slug)).filter(Boolean);
  const pairLots = economics.flatMap((row) => row.pairedLots);
  const pairedShares = pairLots.reduce((sum, row) => sum + row.weight, 0);
  const pairedPnl = pairLots.reduce((sum, row) => sum + row.pnl, 0);
  const residualShares = economics.reduce((sum, row) => sum + row.residualShares, 0);
  const residualCost = economics.reduce((sum, row) => sum + row.residualCost, 0);
  const residualPayout = economics.reduce((sum, row) => sum + row.residualPayout, 0);
  const grossCost = economics.reduce((sum, row) => sum + row.grossCost, 0);
  const fees = economics.reduce((sum, row) => sum + row.fees, 0);
  const totalPnl = economics.reduce((sum, row) => sum + row.totalPnl, 0);
  const makerShares = economics.reduce((sum, row) => sum + row.makerShares, 0);
  const takerShares = economics.reduce((sum, row) => sum + row.takerShares, 0);
  const exactAsk = highMedium.filter((row) => finite(row.beforeBestAsk) && Math.abs(Number(row.limitPrice) - Number(row.beforeBestAsk)) < .005).length;
  const cancelRows = cancels.filter((row) => slugSet.has(row.slug) && row.confidence !== "low");
  const bySizeRole = {};
  for (const size of [...new Set(highMedium.map((row) => Number(row.signedShares)))].sort((a, b) => a - b)) {
    const subset = highMedium.filter((row) => Number(row.signedShares) === size);
    bySizeRole[size] = { orders: subset.length, ...roleSummary(subset) };
  }
  return {
    id: epoch.id,
    label: epoch.label,
    start: epoch.start,
    end: epoch.end,
    windows: windowSlugs.length,
    observedSignedOrders: epochSigned.length,
    observedSizeModes: modes(epochSigned.map((row) => row.signedShares)),
    inferredOrders: epochFires.length,
    highMediumOrders: highMedium.length,
    execution: {
      exactAskPct: pct(exactAsk, highMedium.length),
      marketablePct: pct(highMedium.filter((row) => finite(row.beforeBestAsk) && Number(row.beforeBestAsk) <= Number(row.limitPrice) + .00011).length, highMedium.length),
      takePct: pct(highMedium.filter((row) => row.method === "take").length, highMedium.length),
      takeRestPct: pct(highMedium.filter((row) => row.method === "take+rest").length, highMedium.length),
      restPct: pct(highMedium.filter((row) => row.method === "rest").length, highMedium.length),
      makerSharePct: pct(makerShares, makerShares + takerShares),
      firstFireS: q(fireWindowRows.map((row) => row.firstFireS)),
      lastFireS: q(fireWindowRows.map((row) => row.lastFireS)),
      ordersPerWindow: q(fireWindowRows.map((row) => row.highMedium)),
      signCrossesPerWindow: q(fireWindowRows.map((row) => row.signCrosses)),
    },
    construction: {
      majorWaves: epochWaves.length,
      wavesPerWindow: round(epochWaves.length / Math.max(1, new Set(epochWaves.map((wave) => wave.slug)).size), 3),
      filledOrdersPerWave: q(epochWaves.map((wave) => wave.rows.length)),
      startSeconds: q(epochWaves.map((wave) => (wave.rows[0].order.signedTimestampMs - slugStart(wave.slug)) / 1000)),
    },
    roles: roleSummary(highMedium),
    bySizeRole,
    signals: {
      entry: signalSummary(highMedium.filter((row) => row.role === "entry/topup")),
      hedge: signalSummary(highMedium.filter((row) => row.role === "hedge")),
      overhedgeCross: signalSummary(highMedium.filter((row) => row.role === "overhedge-cross")),
      size90: signalSummary(highMedium.filter((row) => Number(row.signedShares) === 90)),
    },
    cancellation: {
      highMedium: cancelRows.length,
      per100Orders: round(cancelRows.length / Math.max(1, highMedium.length) * 100, 3),
      lifeMs: q(cancelRows.map((row) => row.lifeMs)),
      replaceLagMs: q(cancelRows.map((row) => row.replacementLagMs)),
    },
    economics: {
      grossCost: round(grossCost, 2),
      fees: round(fees, 2),
      pairedShares: round(pairedShares, 2),
      pairedPnl: round(pairedPnl, 2),
      pairedEdgeCentsPerSet: pairedShares ? round(pairedPnl / pairedShares * 100, 4) : null,
      feeInclusivePairCost: {
        p10: round(weightedQuantile(pairLots, .1), 6),
        p25: round(weightedQuantile(pairLots, .25), 6),
        p50: round(weightedQuantile(pairLots, .5), 6),
        p75: round(weightedQuantile(pairLots, .75), 6),
        p90: round(weightedQuantile(pairLots, .9), 6),
      },
      pairSharesAtMost1Pct: pct(pairLots.filter((row) => row.value <= 1 + 1e-12).reduce((sum, row) => sum + row.weight, 0), pairedShares),
      pairSharesAtMost101Pct: pct(pairLots.filter((row) => row.value <= 1.01 + 1e-12).reduce((sum, row) => sum + row.weight, 0), pairedShares),
      residualShares: round(residualShares, 2),
      residualAveragePrice: residualShares ? round(residualCost / residualShares, 6) : null,
      residualWeightedWinPct: pct(residualPayout, residualShares),
      residualPnl: round(residualPayout - residualCost, 2),
      totalPnl: round(totalPnl, 2),
      roiPct: pct(totalPnl, grossCost + fees),
    },
  };
}

// Surface every contiguous observation cluster for each signed size. A gap of
// three hours is long enough to reveal the 60-share toggle without fragmenting
// normal five-minute operation.
const sizeObservationClusters = {};
for (const size of [...new Set(signed.map((row) => Number(row.signedShares)))].sort((a, b) => a - b)) {
  const rows = signed.filter((row) => Number(row.signedShares) === size).sort((a, b) => a.signedTimestampMs - b.signedTimestampMs);
  const clusters = [];
  let batch = [];
  for (const row of rows) {
    if (batch.length && row.signedTimestampMs - batch.at(-1).signedTimestampMs > 3 * 60 * 60_000) {
      clusters.push(batch);
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) clusters.push(batch);
  sizeObservationClusters[size] = clusters.map((cluster) => ({
    orders: cluster.length,
    firstSigned: iso(cluster[0].signedTimestampMs),
    firstMarket: cluster[0].settlements[0]?.slug,
    lastSigned: iso(cluster.at(-1).signedTimestampMs),
    lastMarket: cluster.at(-1).settlements[0]?.slug,
  }));
}

const epochs = epochDefinitions.map(summarize);
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  caveat: "Epochs use the first market with a newly observed filled signed-size mode. Unfilled enabled templates are private and cannot appear in this dataset.",
  sizeObservationClusters,
  epochs,
};
fs.writeFileSync(path.join(dataDir, "config-epochs.json"), JSON.stringify(report, null, 2) + "\n");

const tableRows = epochs.map((row) => {
  const sizes = row.observedSizeModes.slice(0, 3).map((mode) => mode.value).sort((a, b) => a - b).join("/");
  return `| ${row.id} | ${row.start.slice(5, 16).replace("T", " ")}–${row.end.slice(5, 16).replace("T", " ")} | ${sizes} | ${row.windows} | ${row.execution.ordersPerWindow.p50} | ${row.execution.firstFireS.p50} / ${row.execution.lastFireS.p50} | ${row.roles.hedgePct} / ${row.roles.overhedgeCrossPct} | ${row.economics.pairedEdgeCentsPerSet}c | $${row.economics.residualPnl} | $${row.economics.totalPnl} |`;
}).join("\n");
const markdown = `# Runtime configuration epochs\n\n` +
`Epochs are detected from exact filled signed-order sizes and then evaluated using independently inferred v4 fire times. A size can be proven enabled when it fills; absence cannot prove it was disabled.\n\n` +
`| Epoch | UTC range | observed sizes | windows | median orders | median first/last fire | hedge/cross % | pair edge | residual PnL | total PnL |\n` +
`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${tableRows}\n\n` +
`The 60-share mode has two distinct observation clusters: Aug 18 20:35–Aug 19 12:15 and Aug 20 15:30–Aug 21 19:50. The 90-share mode begins in the Aug 19 12:25 market and persists. This is direct evidence of live configuration toggling, not a day-level coincidence.\n\n` +
`E8 is economically different: the 60-share mode disappears, 30/90 remains, complete-set edge rises, and residual inventory loses. That is consistent with a pair-priority retune near Aug 21 20:00 UTC.\n`;
fs.writeFileSync(path.join(dataDir, "config-epochs.md"), markdown);
console.log(markdown);
console.log(JSON.stringify({ sizeObservationClusters, epochs }, null, 2));
