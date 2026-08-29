#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz"))));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz"))));
const signedByHash = new Map(signed.groups.map((group) => [group.orderHash, group]));
const rows = fires.rows.map((row) => ({ ...row, fillVwap: signedByHash.get(row.orderHash)?.vwap ?? null }));
const usable = rows.filter((row) => row.confidence !== "low");
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const q = (values, probabilities = [0, .1, .25, .5, .75, .9, .99, 1]) => Object.fromEntries(probabilities.map((probability) => [
  `p${Math.round(probability * 100)}`,
  round(quantile(values.filter(finite).map(Number), probability)),
]));
const mode = (values) => {
  const counts = new Map();
  for (const value of values.filter(finite)) counts.set(Number(value), (counts.get(Number(value)) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 6).map(([value, count]) => ({ value, count }));
};
const pct = (n, d) => d ? round(n / d * 100, 3) : null;

const bySlug = new Map();
for (const row of rows) {
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}

const pairedLots = [], labeled = [], windows = [];
for (const [slug, slugRows] of bySlug) {
  const ordered = slugRows.sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const queues = { Up: [], Down: [] };
  let up = 0, down = 0;
  for (const row of ordered) {
    const side = row.outcome, opposite = side === "Up" ? "Down" : "Up";
    let shares = Number(row.filledShares) || 0, hedgeShares = 0;
    while (shares > 1e-8 && queues[opposite].length) {
      const lot = queues[opposite][0], take = Math.min(shares, lot.remaining);
      hedgeShares += take;
      pairedLots.push({
        slug,
        entryHash: lot.row.orderHash,
        hedgeHash: row.orderHash,
        entrySide: opposite,
        entryFireMs: lot.row.fireMs,
        hedgeFireMs: row.fireMs,
        delayMs: row.fireMs - lot.row.fireMs,
        shares: take,
        entryPrice: lot.row.fillVwap,
        hedgePrice: row.fillVwap,
        pairCost: finite(lot.row.fillVwap) && finite(row.fillVwap) ? Number(lot.row.fillVwap) + Number(row.fillVwap) : null,
        hedgeLimitPairCost: finite(lot.row.fillVwap) ? Number(lot.row.fillVwap) + Number(row.limitPrice) : null,
        askPairAtHedge: finite(row.beforeBestAsk) && finite(lot.row.fillVwap) ? Number(lot.row.fillVwap) + Number(row.beforeBestAsk) : null,
      });
      shares -= take;
      lot.remaining -= take;
      if (lot.remaining <= 1e-8) queues[opposite].shift();
    }
    const entryShares = Math.max(0, shares);
    if (entryShares > 1e-8) queues[side].push({ row, remaining: entryShares });
    const label = hedgeShares <= 1e-8 ? "entry/topup" : entryShares <= 1e-8 ? "hedge" : "overhedge-cross";
    const beforeImbalance = up - down;
    if (side === "Up") up += Number(row.filledShares) || 0; else down += Number(row.filledShares) || 0;
    labeled.push({ ...row, label, hedgeShares, entryShares, beforeImbalance, afterImbalance: up - down });
  }
  const confident = ordered.filter((row) => row.confidence !== "low");
  if (confident.length) {
    const start = Number(slug.split("-").at(-1)) * 1000;
    windows.push({ slug, orders: confident.length, firstT: (confident[0].fireMs - start) / 1000, lastT: (confident.at(-1).fireMs - start) / 1000 });
  }
}

const signal = (subset) => {
  const metrics = {};
  for (const field of ["bzGapPct", "clGapPct", "bzClSpreadPct", "bzMom1", "bzMom3", "bzMom5", "bzMom10", "clMom1", "clMom3", "clMom5", "clMom10", "clobUpMove1", "clobUpMove3", "clobUpMove5", "clobUpMove10", "sideAskMove1", "sideAskMove3", "sideAskMove5", "sideAskMove10"]) {
    const values = subset.map((row) => finite(row.v2Feature?.[field]) ? Number(row.v2Feature[field]) * (row.outcome === "Up" ? 1 : -1) : null).filter(finite);
    metrics[field] = {
      n: values.length,
      alignedPct: pct(values.filter((value) => value > 1e-12).length, values.length),
      opposedPct: pct(values.filter((value) => value < -1e-12).length, values.length),
      zeroPct: pct(values.filter((value) => Math.abs(value) <= 1e-12).length, values.length),
      q: q(values, [.1, .25, .5, .75, .9]),
    };
  }
  return metrics;
};

const confidentLabeled = labeled.filter((row) => row.confidence !== "low");
const entries = confidentLabeled.filter((row) => row.label === "entry/topup");
const hedges = confidentLabeled.filter((row) => row.label === "hedge");
const crosses = confidentLabeled.filter((row) => row.label === "overhedge-cross");
const currentLabeled = confidentLabeled.filter((row) => new Date(Number(row.slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10) >= "2026-08-19");
const offsets = usable.map((row) => Number(row.limitPrice) - Number(row.beforeBestAsk)).filter(finite);
const tickOffsets = Object.fromEntries([...offsets.reduce((map, value) => {
  const key = round(value, 2).toFixed(2);
  map.set(key, (map.get(key) || 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 15));

const replacements = [];
for (const slugRows of bySlug.values()) {
  const ordered = slugRows.filter((row) => row.confidence !== "low").sort((a, b) => a.fireMs - b.fireMs);
  for (let index = 0; index < ordered.length; index++) {
    const row = ordered[index];
    const remainder = Math.max(0, Number(row.signedShares) - Number(row.filledShares));
    if (remainder < .05 || !row.settlementRoles.includes("maker")) continue;
    const next = ordered.slice(index + 1).find((candidate) => candidate.outcome === row.outcome);
    if (!next) continue;
    replacements.push({
      orderHash: row.orderHash,
      nextHash: next.orderHash,
      dtMs: next.fireMs - row.fireMs,
      limitDelta: Number(next.limitPrice) - Number(row.limitPrice),
      sameSignedSize: Number(next.signedShares) === Number(row.signedShares),
      remainder,
    });
  }
}

const daily = {};
for (const group of signed.groups) {
  const day = new Date(Number(group.settlements[0]?.slug?.split("-").at(-1)) * 1000).toISOString().slice(0, 10);
  if (!daily[day]) daily[day] = { orders: [], sizes: [], prices: [], first: [], last: [] };
  daily[day].orders.push(group);
  daily[day].sizes.push(group.signedShares);
  daily[day].prices.push(group.limitPrice);
}
for (const window of windows) {
  const day = new Date(Number(window.slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10);
  daily[day]?.first.push(window.firstT);
  daily[day]?.last.push(window.lastT);
}
for (const [day, value] of Object.entries(daily)) {
  daily[day] = {
    orders: value.orders.length,
    signedSizeModes: mode(value.sizes).slice(0, 4),
    limit: q(value.prices, [0, .1, .5, .9, 1]),
    firstFireS: q(value.first, [.1, .5, .9]),
    lastFireS: q(value.last, [.1, .5, .9]),
  };
}

const pairValues = pairedLots.filter((row) => finite(row.pairCost));
const immediatePairs = pairValues.filter((row) => row.delayMs <= 10_000);
const lifecycle = {
  exactSignedOrders: signed.groups.length,
  multiSettlementOrders: signed.summary.multiSettlementOrders,
  mixedTakerMakerHashes: signed.summary.mixedTakerMakerOrders,
  v4HighMediumFires: usable.length,
  takeRestHighMedium: usable.filter((row) => row.method === "take+rest").length,
  restingIncompleteOrders: signed.groups.filter((group) => group.settlementRoles.includes("maker") && Number(group.filledShares) < Number(group.signedShares) - .05).length,
  inferredReplacementCandidates: replacements.length,
  replacementWithin1sPct: pct(replacements.filter((row) => row.dtMs <= 1_000).length, replacements.length),
  replacementWithin3sPct: pct(replacements.filter((row) => row.dtMs <= 3_000).length, replacements.length),
  replacementWithin10sPct: pct(replacements.filter((row) => row.dtMs <= 10_000).length, replacements.length),
  replacementDelayMs: q(replacements.map((row) => row.dtMs)),
  replacementLimitDelta: q(replacements.map((row) => row.limitDelta)),
  replacementSameSizePct: pct(replacements.filter((row) => row.sameSignedSize).length, replacements.length),
};

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  lifecycle,
  execution: {
    signedSize: q(signed.groups.map((group) => group.signedShares)),
    signedSizeModes: mode(signed.groups.map((group) => group.signedShares)),
    signedLimit: q(signed.groups.map((group) => group.limitPrice)),
    within012to089Pct: pct(signed.groups.filter((group) => group.limitPrice >= .12 - 1e-9 && group.limitPrice <= .89 + 1e-9).length, signed.groups.length),
    limitMinusPreFireAsk: q(offsets),
    limitOffsetModes: tickOffsets,
    exactAskPct: pct(offsets.filter((value) => Math.abs(value) < .005).length, offsets.length),
    oneTickAbovePct: pct(offsets.filter((value) => value >= .005 && value < .015).length, offsets.length),
    oneTickBelowPct: pct(offsets.filter((value) => value <= -.005 && value > -.015).length, offsets.length),
  },
  timing: {
    windows: windows.length,
    ordersPerWindow: q(windows.map((window) => window.orders)),
    firstFireS: q(windows.map((window) => window.firstT)),
    lastFireS: q(windows.map((window) => window.lastT)),
  },
  cycles: {
    entries: entries.length,
    hedges: hedges.length,
    overhedgeCrosses: crosses.length,
    pairedLots: pairValues.length,
    pairedShares: round(pairValues.reduce((sum, row) => sum + row.shares, 0), 2),
    pairDelayMs: q(pairValues.map((row) => row.delayMs)),
    pairCost: q(pairValues.map((row) => row.pairCost)),
    pairCostAtMost1Pct: pct(pairValues.filter((row) => row.pairCost <= 1 + 1e-9).length, pairValues.length),
    pairCostAtMost101Pct: pct(pairValues.filter((row) => row.pairCost <= 1.01 + 1e-9).length, pairValues.length),
    immediateWithin10sLots: immediatePairs.length,
    immediatePairCost: q(immediatePairs.map((row) => row.pairCost)),
  },
  signal: {
    all: signal(usable),
    entry: signal(entries),
    hedge: signal(hedges),
    overhedgeCross: signal(crosses),
    currentRegime: {
      all: signal(currentLabeled),
      entry: signal(currentLabeled.filter((row) => row.label === "entry/topup")),
      hedge: signal(currentLabeled.filter((row) => row.label === "hedge")),
      overhedgeCross: signal(currentLabeled.filter((row) => row.label === "overhedge-cross")),
      sizeRole: Object.fromEntries([...new Set(currentLabeled.map((row) => Number(row.signedShares)))].sort((a, b) => a - b).map((size) => {
        const sizeRows = currentLabeled.filter((row) => Number(row.signedShares) === size);
        return [size, {
          orders: sizeRows.length,
          entryPct: pct(sizeRows.filter((row) => row.label === "entry/topup").length, sizeRows.length),
          hedgePct: pct(sizeRows.filter((row) => row.label === "hedge").length, sizeRows.length),
          overhedgeCrossPct: pct(sizeRows.filter((row) => row.label === "overhedge-cross").length, sizeRows.length),
          absoluteImbalanceBefore: q(sizeRows.map((row) => Math.abs(row.beforeImbalance)), [.1, .25, .5, .75, .9]),
        }];
      })),
    },
  },
  daily,
};

const md = `# Exact-order strategy analysis\n\n` +
`Generated ${report.generatedAt}. Fire time is independently inferred from v4 depth; signed/on-chain timestamps are excluded.\n\n` +
`## Lifecycle\n\n` +
`- ${lifecycle.exactSignedOrders.toLocaleString()} exact signed orders; ${lifecycle.multiSettlementOrders.toLocaleString()} settled more than once.\n` +
`- ${lifecycle.mixedTakerMakerHashes.toLocaleString()} hashes occur as both taker and maker; ${lifecycle.takeRestHighMedium.toLocaleString()} have high/medium v4 take+rest fingerprints.\n` +
`- ${lifecycle.restingIncompleteOrders.toLocaleString()} maker-seen orders ended partially filled; ${lifecycle.inferredReplacementCandidates.toLocaleString()} have a later same-side order available for cancel/replace analysis.\n\n` +
`## Execution\n\n` +
`- Signed size modes: ${report.execution.signedSizeModes.map((row) => `${row.value} (${row.count})`).join(", ")}.\n` +
`- ${report.execution.exactAskPct}% of high/medium orders cap exactly at the pre-fire best ask; ${report.execution.oneTickAbovePct}% cap one tick above; ${report.execution.oneTickBelowPct}% one tick below.\n` +
`- ${report.execution.within012to089Pct}% of signed limits are in 0.12–0.89.\n\n` +
`## Cycles\n\n` +
`- Inventory labeling: ${entries.length.toLocaleString()} entry/top-up orders, ${hedges.length.toLocaleString()} pure hedges, ${crosses.length.toLocaleString()} overhedge crossings.\n` +
`- FIFO pair delay median ${report.cycles.pairDelayMs.p50} ms (p90 ${report.cycles.pairDelayMs.p90} ms).\n` +
`- Realized pair cost median ${report.cycles.pairCost.p50}; ${report.cycles.pairCostAtMost1Pct}% at or below 1.00.\n\n` +
`## Timing\n\n` +
`- First fire median t+${report.timing.firstFireS.p50}s; last fire median t+${report.timing.lastFireS.p50}s; median ${report.timing.ordersPerWindow.p50} inferred orders/window.\n`;

fs.writeFileSync(path.join(dataDir, "exact-order-strategy.json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(path.join(dataDir, "exact-order-strategy.md"), md);
console.log(md);
console.log(JSON.stringify({ lifecycle: report.lifecycle, execution: report.execution, timing: report.timing, cycles: report.cycles }, null, 2));
