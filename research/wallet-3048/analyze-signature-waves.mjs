#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const feedDir = path.resolve(process.argv[3] || path.join(dataDir, "feeds/v4-top"));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (count, total) => total ? round(count / total * 100, 3) : null;
const q = (values, probabilities = [0, .1, .25, .5, .75, .9, .99, 1]) => Object.fromEntries(probabilities.map((probability) => [
  `p${Math.round(probability * 100)}`,
  round(quantile(values.filter(finite).map(Number), probability), 3),
]));
const modes = (values, digits = 0, count = 12) => [...values.reduce((map, value) => {
  if (!finite(value)) return map;
  const key = Number(value).toFixed(digits);
  map.set(key, (map.get(key) || 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, count)
  .map(([value, n]) => ({ value: Number(value), count: n }));

function readFeed(slug) {
  const file = path.join(feedDir, `${slug}.json.gz`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}

function indexAtOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

function askAt(tick, outcome) {
  if (outcome === "Up") return finite(tick?.up?.asks?.[0]?.price) ? Number(tick.up.asks[0].price) : Number(tick?.upAsk);
  return finite(tick?.down?.asks?.[0]?.price) ? Number(tick.down.asks[0].price) : Number(tick?.dnAsk);
}

function signatureWave(tSigned) {
  if (tSigned < 0) return "pre-open";
  if (tSigned < 150) return "middle";
  return "late";
}

const joined = fires.map((fire) => {
  const order = signedByHash.get(fire.orderHash);
  const startMs = Number(fire.slug.split("-").at(-1)) * 1000;
  return {
    ...fire,
    order,
    startMs,
    tSigned: order ? (Number(order.signedTimestampMs) - startMs) / 1000 : null,
    tFire: (Number(fire.fireMs) - startMs) / 1000,
    wave: order ? signatureWave((Number(order.signedTimestampMs) - startMs) / 1000) : null,
  };
}).filter((row) => row.order);

// A major signing wave is separated by at least 60 seconds. Tiny millisecond
// gaps inside a wave are useful sequence markers, but not independent orders.
const bySlug = new Map();
for (const row of joined) {
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}
const signingBatches = [];
for (const [slug, rows] of bySlug) {
  const ordered = [...rows].sort((a, b) => a.order.signedTimestampMs - b.order.signedTimestampMs || a.orderHash.localeCompare(b.orderHash));
  let batch = [];
  for (const row of ordered) {
    if (batch.length && row.order.signedTimestampMs - batch.at(-1).order.signedTimestampMs > 60_000) {
      signingBatches.push({ slug, rows: batch });
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) signingBatches.push({ slug, rows: batch });
}

const thresholdRows = [];
for (const [slug, rows] of bySlug) {
  const feed = readFeed(slug);
  if (!feed) continue;
  for (const row of rows) {
    const ticks = feed.ticks;
    const index = indexAtOrBefore(ticks, row.intervalStartMs);
    if (index < 0) continue;
    const limit = Number(row.limitPrice);
    const beforeAsk = askAt(ticks[index], row.outcome);
    const marketable = finite(beforeAsk) && beforeAsk <= limit + .00011;
    let onsetMs = null;
    if (marketable) {
      let cursor = index;
      // Find the beginning of the current uninterrupted executable run. The
      // order may deliberately wait through a long run because inventory and
      // cadence gates are independent from the price threshold.
      while (cursor > 0 && askAt(ticks[cursor - 1], row.outcome) <= limit + .00011) cursor--;
      onsetMs = ticks[cursor].ms;
    }
    thresholdRows.push({
      ...row,
      beforeAsk,
      marketable,
      exactAsk: marketable && Math.abs(beforeAsk - limit) < .005,
      eligibleRunMs: onsetMs == null ? null : row.intervalStartMs - onsetMs,
      signedToFireMs: row.fireMs - row.order.signedTimestampMs,
    });
  }
}

const fireClusters = [];
for (const [slug, rows] of bySlug) {
  const ordered = [...rows].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  let cluster = [];
  for (const row of ordered) {
    if (cluster.length && row.fireMs - cluster.at(-1).fireMs > 300) {
      fireClusters.push({ slug, rows: cluster });
      cluster = [];
    }
    cluster.push(row);
  }
  if (cluster.length) fireClusters.push({ slug, rows: cluster });
}

function subsetReport(rows) {
  const usable = rows.filter((row) => row.confidence !== "low");
  const usableHashes = new Set(usable.map((row) => row.orderHash));
  const threshold = thresholdRows.filter((row) => usableHashes.has(row.orderHash));
  return {
    orders: rows.length,
    highMedium: usable.length,
    signedSizeModes: modes(rows.map((row) => row.signedShares)),
    limitPrice: q(rows.map((row) => row.limitPrice), [.1, .25, .5, .75, .9]),
    tSigned: q(rows.map((row) => row.tSigned), [.1, .25, .5, .75, .9]),
    tFire: q(usable.map((row) => row.tFire), [.1, .25, .5, .75, .9]),
    signedToFireMs: q(threshold.map((row) => row.signedToFireMs), [.1, .25, .5, .75, .9]),
    marketableAtFirePct: pct(threshold.filter((row) => row.marketable).length, threshold.length),
    exactAskAtFirePct: pct(threshold.filter((row) => row.exactAsk).length, threshold.length),
    eligibleRunMs: q(threshold.map((row) => row.eligibleRunMs), [.1, .25, .5, .75, .9]),
  };
}

const current = joined.filter((row) => new Date(row.startMs).toISOString().slice(0, 10) >= "2026-08-19");
const currentThreshold = thresholdRows.filter((row) => new Date(row.startMs).toISOString().slice(0, 10) >= "2026-08-19" && row.confidence !== "low");
const batchStarts = signingBatches.map((batch) => (batch.rows[0].order.signedTimestampMs - batch.rows[0].startMs) / 1000);
const interBatch = [];
for (const slug of bySlug.keys()) {
  const batches = signingBatches.filter((batch) => batch.slug === slug).sort((a, b) => a.rows[0].order.signedTimestampMs - b.rows[0].order.signedTimestampMs);
  for (let index = 1; index < batches.length; index++) interBatch.push(batches[index].rows[0].order.signedTimestampMs - batches[index - 1].rows[0].order.signedTimestampMs);
}

const byWave = {};
for (const wave of ["pre-open", "middle", "late"]) byWave[wave] = subsetReport(joined.filter((row) => row.wave === wave));
const bySizeCurrent = {};
for (const size of [...new Set(current.map((row) => Number(row.signedShares)))].sort((a, b) => a - b)) {
  if (current.filter((row) => Number(row.signedShares) === size).length < 25) continue;
  bySizeCurrent[size] = subsetReport(current.filter((row) => Number(row.signedShares) === size));
}

function menuReport(batches) {
  let cells = 0, mixedSizeCells = 0, duplicateSizeCells = 0, wavesWithMixedSizeCell = 0, wavesWithDuplicateSizeCell = 0;
  for (const batch of batches) {
    const menu = new Map();
    for (const row of batch.rows) {
      const key = `${row.outcome}:${Number(row.limitPrice).toFixed(2)}`;
      if (!menu.has(key)) menu.set(key, []);
      menu.get(key).push(Number(row.signedShares));
    }
    let mixed = false, duplicate = false;
    for (const sizes of menu.values()) {
      cells++;
      if (new Set(sizes).size > 1) { mixedSizeCells++; mixed = true; }
      if (sizes.length > new Set(sizes).size) { duplicateSizeCells++; duplicate = true; }
    }
    if (mixed) wavesWithMixedSizeCell++;
    if (duplicate) wavesWithDuplicateSizeCell++;
  }
  return {
    waves: batches.length,
    observedSidePriceCells: cells,
    mixedSizeCells,
    mixedSizeCellPct: pct(mixedSizeCells, cells),
    duplicateSizeCells,
    duplicateSizeCellPct: pct(duplicateSizeCells, cells),
    wavesWithMixedSizeCellPct: pct(wavesWithMixedSizeCell, batches.length),
    wavesWithDuplicateSizeCellPct: pct(wavesWithDuplicateSizeCell, batches.length),
  };
}

const e8StartMs = Date.parse("2026-08-21T19:55:00Z");
const e8Batches = signingBatches.filter((batch) => batch.rows[0].startMs >= e8StartMs);

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  definition: "EIP-712 timestamp groups orders into signing waves only; v4 book transitions independently determine fire time",
  windows: bySlug.size,
  orders: joined.length,
  signing: {
    majorBatches: signingBatches.length,
    batchesPerWindow: q([...bySlug.keys()].map((slug) => signingBatches.filter((batch) => batch.slug === slug).length), [.1, .25, .5, .75, .9]),
    ordersPerBatch: q(signingBatches.map((batch) => batch.rows.length), [.1, .25, .5, .75, .9, .99]),
    batchSpanMs: q(signingBatches.map((batch) => batch.rows.at(-1).order.signedTimestampMs - batch.rows[0].order.signedTimestampMs), [.1, .25, .5, .75, .9, .99]),
    batchStartSeconds: q(batchStarts, [.1, .25, .5, .75, .9]),
    batchStartFiveSecondModes: modes(batchStarts.map((value) => Math.round(value / 5) * 5)),
    interBatchMs: q(interBatch, [.1, .25, .5, .75, .9]),
    inferredFireBeforeTimestamp: joined.filter((row) => row.fireMs < row.order.signedTimestampMs).length,
  },
  release: {
    highMedium: thresholdRows.filter((row) => row.confidence !== "low").length,
    marketableAtFirePct: pct(thresholdRows.filter((row) => row.confidence !== "low" && row.marketable).length, thresholdRows.filter((row) => row.confidence !== "low").length),
    exactAskAtFirePct: pct(thresholdRows.filter((row) => row.confidence !== "low" && row.exactAsk).length, thresholdRows.filter((row) => row.confidence !== "low").length),
    eligibleRunMs: q(thresholdRows.filter((row) => row.confidence !== "low").map((row) => row.eligibleRunMs), [.1, .25, .5, .75, .9, .99]),
    fireClusterOrders: q(fireClusters.map((cluster) => cluster.rows.length), [.5, .75, .9, .99, 1]),
    multiOrderFireClusterPct: pct(fireClusters.filter((cluster) => cluster.rows.length > 1).length, fireClusters.length),
  },
  waves: byWave,
  currentRegime: {
    orders: current.length,
    waves: Object.fromEntries(["pre-open", "middle", "late"].map((wave) => [wave, subsetReport(current.filter((row) => row.wave === wave))])),
    bySignedSize: bySizeCurrent,
    marketableAtFirePct: pct(currentThreshold.filter((row) => row.marketable).length, currentThreshold.length),
    exactAskAtFirePct: pct(currentThreshold.filter((row) => row.exactAsk).length, currentThreshold.length),
    eligibleRunMs: q(currentThreshold.map((row) => row.eligibleRunMs), [.1, .25, .5, .75, .9, .99]),
    observedMenu: menuReport(signingBatches.filter((batch) => new Date(batch.rows[0].startMs).toISOString().slice(0, 10) >= "2026-08-19")),
  },
  e8ObservedMenu: menuReport(e8Batches),
};

fs.writeFileSync(path.join(dataDir, "signature-waves.json"), JSON.stringify(report, null, 2) + "\n");
const md = `# Signed-order waves and v4 release thresholds\n\n` +
`The signed EIP-712 timestamp is used only to group pre-built orders. It is never used as submit/fire time. Fire is independently matched to consecutive v4 order-book states.\n\n` +
`- ${report.orders.toLocaleString()} filled signed orders form ${report.signing.majorBatches.toLocaleString()} major signing waves in ${report.windows.toLocaleString()} windows.\n` +
`- Median major waves/window: ${report.signing.batchesPerWindow.p50}; median observed filled orders/wave: ${report.signing.ordersPerBatch.p50}.\n` +
`- Major wave spacing has median ${report.signing.interBatchMs.p50} ms and p75 ${report.signing.interBatchMs.p75} ms. Common phase starts cluster before open, around t+40–65s, and around t+185–200s.\n` +
`- ${report.release.marketableAtFirePct}% of high/medium releases are executable at their cap; ${report.release.exactAskAtFirePct}% cap exactly at the pre-fire ask.\n` +
`- The current executable-price run before release has median age ${report.release.eligibleRunMs.p50} ms (p90 ${report.release.eligibleRunMs.p90} ms). This shows a price threshold plus separate inventory/cadence gates.\n` +
`- ${report.release.multiOrderFireClusterPct}% of 300 ms fire clusters contain multiple exact signed orders.\n\n` +
`- In the current two-size epoch, ${report.e8ObservedMenu.wavesWithDuplicateSizeCellPct}% of waves contain repeated filled orders at the same side/cap/size, and ${report.e8ObservedMenu.wavesWithMixedSizeCellPct}% contain both observed base- and large-size filled orders at the same side/cap. These are lower bounds because never-filled signed candidates are private.\n\n` +
`Interpretation: the wallet prepares two-sided price/size ladders in waves, then releases selected signed orders when the CLOB reaches their cap and inventory/cadence state permits. The CLOB threshold is the immediate trigger; Binance/RTDS can select or suppress a ladder branch but do not explain timing alone.\n`;
fs.writeFileSync(path.join(dataDir, "signature-waves.md"), md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
