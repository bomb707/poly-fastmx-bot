#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048-r2"));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const finite = Number.isFinite;
const round = (value, digits = 6) => finite(value) ? +value.toFixed(digits) : null;
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
const q = (values) => Object.fromEntries([.1, .25, .5, .75, .9].map((p) => [`p${p * 100}`, round(quantile(values.filter(finite), p), 3)]));
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;

const bySlug = new Map();
for (const order of signed) {
  const slug = order.settlements[0]?.slug, side = order.settlements[0]?.outcome;
  if (!slug || !side) continue;
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push({ ...order, side });
}

const waves = [];
for (const [slug, rows] of bySlug) {
  const ordered = [...rows].sort((a, b) => a.signedTimestampMs - b.signedTimestampMs || a.orderHash.localeCompare(b.orderHash));
  let batch = [];
  for (const row of ordered) {
    if (batch.length && row.signedTimestampMs - batch.at(-1).signedTimestampMs > 60_000) {
      waves.push({ slug, rows: batch });
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) waves.push({ slug, rows: batch });
}

function phase(wave) {
  const seconds = (wave.rows[0].signedTimestampMs - slugStart(wave.slug)) / 1000;
  return seconds < 0 ? "pre-open" : seconds < 150 ? "middle" : "late";
}
function correlation(a, b) {
  const n = a.length, ma = a.reduce((sum, value) => sum + value, 0) / n, mb = b.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0, aa = 0, bb = 0;
  for (let index = 0; index < n; index++) {
    covariance += (a[index] - ma) * (b[index] - mb);
    aa += (a[index] - ma) ** 2;
    bb += (b[index] - mb) ** 2;
  }
  return covariance / Math.sqrt(aa * bb);
}

const topology = [];
for (const wave of waves) {
  const cells = new Map();
  for (const row of wave.rows) {
    const key = `${row.side}:${Number(row.limitPrice).toFixed(2)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }
  for (const side of ["Up", "Down"]) {
    const unique = [...new Map(wave.rows.filter((row) => row.side === side).map((row) => [Number(row.limitPrice), row])).values()];
    if (unique.length < 5) continue;
    topology.push({
      phase: phase(wave),
      slug: wave.slug,
      side,
      cells: unique.length,
      priceTimestampCorrelation: correlation(unique.map((row) => row.signedTimestampMs), unique.map((row) => Number(row.limitPrice))),
    });
  }
  wave.cells = cells;
}

const paired = [];
for (const wave of waves) {
  const up = wave.rows.filter((row) => row.side === "Up"), down = wave.rows.filter((row) => row.side === "Down");
  for (const row of up) {
    if (!down.length) continue;
    const nearest = down.reduce((best, candidate) => Math.abs(candidate.signedTimestampMs - row.signedTimestampMs) < Math.abs(best.signedTimestampMs - row.signedTimestampMs) ? candidate : best);
    if (Math.abs(nearest.signedTimestampMs - row.signedTimestampMs) > 3) continue;
    paired.push({ phase: phase(wave), timestampDeltaMs: nearest.signedTimestampMs - row.signedTimestampMs, capSum: Number(row.limitPrice) + Number(nearest.limitPrice) });
  }
}

function phaseReport(name) {
  const selected = waves.filter((wave) => phase(wave) === name), correlations = topology.filter((row) => row.phase === name).map((row) => row.priceTimestampCorrelation);
  const phasePairs = paired.filter((row) => row.phase === name);
  const cells = selected.flatMap((wave) => [...wave.cells.values()]);
  return {
    waves: selected.length,
    startS: q(selected.map((wave) => (wave.rows[0].signedTimestampMs - slugStart(wave.slug)) / 1000)),
    observedWaveSpanMs: q(selected.map((wave) => wave.rows.at(-1).signedTimestampMs - wave.rows[0].signedTimestampMs)),
    observedFilledOrdersPerWave: q(selected.map((wave) => wave.rows.length)),
    sideGroupsWithFiveCells: correlations.length,
    priceTimestampCorrelation: q(correlations),
    stronglyAscendingPct: pct(correlations.filter((value) => value >= .7).length, correlations.length),
    stronglyDescendingPct: pct(correlations.filter((value) => value <= -.7).length, correlations.length),
    repeatedSameSideCapPct: pct(cells.filter((rows) => rows.length > 1).length, cells.length),
    nearSimultaneousOppositePairs: phasePairs.length,
    nearSimultaneousComplementPct: pct(phasePairs.filter((row) => Math.abs(row.capSum - 1) <= .01001).length, phasePairs.length),
    nearSimultaneousCapSum: q(phasePairs.map((row) => row.capSum)),
  };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  definition: "only filled signed candidates are observable; timestamp order is used to recover the menu generator, never as release time",
  waves: waves.length,
  phases: Object.fromEntries(["pre-open", "middle", "late"].map((name) => [name, phaseReport(name)])),
  inference: {
    topology: "middle/late waves iterate side-price cells in ascending one-cent cap order; opposite-side candidates generated within 3ms are usually complementary around $1; repeated cells provide partial-fill/retry choices",
    visibilityLimit: "an unfilled signed choice is private, so the exact number of candidates at every price cell remains a lower bound",
  },
};
fs.writeFileSync(path.join(dataDir, "menu-topology.json"), JSON.stringify(report, null, 2) + "\n");
const middle = report.phases.middle, late = report.phases.late;
const md = `# Signed action-menu topology\n\n` +
`The middle and late menu builders traverse price cells in timestamp/price order: ${middle.stronglyAscendingPct}% and ${late.stronglyAscendingPct}% of side groups with at least five observed cells have correlation >= 0.7. Median correlations are ${middle.priceTimestampCorrelation.p50} and ${late.priceTimestampCorrelation.p50}.\n\n` +
`Among opposite-side filled candidates signed within 3 ms, complementary caps sum to $1 within one tick in ${pct(paired.filter((row) => Math.abs(row.capSum - 1) <= .01001).length, paired.length)}% of cases. Repeated same-side/cap cells are visible in every phase, supporting a pre-signed retry/partial-fill menu.\n\n` +
`This is consistent with iterating a one-cent two-sided ladder and storing Q/large signed choices for later release. It does not prove unseen candidates at every cell because never-filled signatures are private.\n`;
fs.writeFileSync(path.join(dataDir, "menu-topology.md"), md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
