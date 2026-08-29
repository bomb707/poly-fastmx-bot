#!/usr/bin/env node
// Exact-engine release/action parity audit against reconstructed wallet actions.
// Each feed is read once, then replayed through a small, predeclared config set.
// Config selection uses Aug 21 only; Aug 22-25 are reported after selection.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const cohortFile = path.join(dataDir, "cohort-2026-08-16_2026-08-26-btc.json");
const actionFile = path.join(dataDir, "fire-actions-consensus-btc-aug16-25-decision520.json.gz");
const feedDir = path.join(dataDir, "feeds/v2-l2");
const resultDir = path.join(root, "research/wallet-75cc/results");
const outputJson = path.join(resultDir, "release-parity-2026-08-27.json");
const outputMd = path.join(resultDir, "release-parity-2026-08-27.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");
const tolerancesMs = [500, 1000, 2000, 5000, 10000];
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const marketLimit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 1) : Infinity;

const variants = [
  { name: "current-high-confidence", overrides: {} },
  { name: "hazard-7.5s", overrides: { H_EXEC_RUN_MS: 7500 } },
  { name: "hazard-9.75s", overrides: { H_EXEC_RUN_MS: 9750 } },
  { name: "hazard-10s", overrides: { H_EXEC_RUN_MS: 10000 } },
  { name: "hazard-12.5s", overrides: { H_EXEC_RUN_MS: 12500 } },
  { name: "repeat-menu-current", overrides: { H_MAX_ORDERS: 0, H_MAX_CELL_USES: 99 } },
  { name: "repeat-menu-9.75s", overrides: { H_EXEC_RUN_MS: 9750, H_MAX_ORDERS: 0, H_MAX_CELL_USES: 99 } },
];

function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function startMs(slug) {
  return Number(String(slug).split("-").at(-1)) * 1000;
}
function nestedBook(raw) {
  const asks = raw?.asks || [], bids = raw?.bids || [];
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}
function timeSegment(ms) {
  return ms < fitEnd ? "fit" : ms < validationEnd ? "validation" : "holdout";
}
function matchCount(predicted, actual, toleranceMs) {
  let p = 0, a = 0, matches = 0;
  while (p < predicted.length && a < actual.length) {
    const delta = predicted[p] - actual[a];
    if (Math.abs(delta) <= toleranceMs) { matches++; p++; a++; }
    else if (delta < -toleranceMs) p++;
    else a++;
  }
  return matches;
}
function scoreRows(predictions, actions, toleranceMs) {
  const predTimes = predictions.map((row) => row.ms).sort((a, b) => a - b);
  const actionTimes = actions.map((row) => row.decisionMs).sort((a, b) => a - b);
  const releaseMatches = matchCount(predTimes, actionTimes, toleranceMs);
  let exactMatches = 0;
  for (const side of ["Up", "Down"]) {
    exactMatches += matchCount(
      predictions.filter((row) => row.side === side).map((row) => row.ms).sort((a, b) => a - b),
      actions.filter((row) => row.outcome === side).map((row) => row.decisionMs).sort((a, b) => a - b),
      toleranceMs,
    );
  }
  const precision = predictions.length ? exactMatches / predictions.length : null;
  const recall = actions.length ? exactMatches / actions.length : null;
  return {
    predictions: predictions.length,
    targetActions: actions.length,
    releaseMatches,
    exactMatches,
    exactPrecision: round(precision),
    exactRecall: round(recall),
    exactF1: precision != null && recall != null && precision + recall > 0
      ? round(2 * precision * recall / (precision + recall)) : 0,
    releaseRecallIgnoringSide: round(actions.length ? releaseMatches / actions.length : null),
  };
}
function summarize(predictions, actions) {
  const output = {};
  for (const segment of ["fit", "validation", "holdout", "all"]) {
    const pred = segment === "all" ? predictions : predictions.filter((row) => timeSegment(row.ms) === segment);
    const act = segment === "all" ? actions : actions.filter((row) => timeSegment(row.decisionMs) === segment);
    output[segment] = Object.fromEntries(tolerancesMs.map((tolerance) =>
      [String(tolerance), scoreRows(pred, act, tolerance)]));
  }
  return output;
}
function pct(value) {
  return value == null ? "n/a" : `${round(value * 100, 2)}%`;
}

const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const allActions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionFile))).rows;
const actionsBySlug = new Map();
for (const action of allActions) {
  const rows = actionsBySlug.get(action.slug) || [];
  rows.push(action); actionsBySlug.set(action.slug, rows);
}
let markets = cohort.markets.filter((market) => market.winner && market.slug.startsWith("btc-")
  && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug));
if (Number.isFinite(marketLimit)) markets = markets.slice(0, marketLimit);
const marketSet = new Set(markets.map((market) => market.slug));
const scopedActions = allActions.filter((action) => marketSet.has(action.slug));
const predictions = Object.fromEntries(variants.map((variant) => [variant.name, []]));

for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = (feed.ticks || []).map((tick) => {
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    return { t: (tick.ms - ws) / 1000, ms: tick.ms, bz: tick.bz, cl: tick.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid, up, down };
  });
  const replay = { ticks, openBinance: feed.openBinance, openPrice: feed.openChainlink, windowStart: ws / 1000 };
  for (const variant of variants) {
    const fills = simulateFills(replay, { ...STRAT, ...variant.overrides });
    for (const fill of fills) {
      const decidedT = Number.isFinite(fill.decidedT) ? fill.decidedT
        : Number.isFinite(fill.placedT) ? fill.placedT : fill.tInto;
      predictions[variant.name].push({ slug: market.slug, side: fill.side,
        ms: Math.round(ws + decidedT * 1000), role: fill.role });
    }
  }
  if ((index + 1) % 50 === 0 || index + 1 === markets.length)
    console.log(JSON.stringify({ phase: "release-parity-replay", done: index + 1, total: markets.length }));
}

const summaries = Object.fromEntries(variants.map((variant) =>
  [variant.name, { overrides: variant.overrides, ...summarize(predictions[variant.name], scopedActions) }]));
const selectionTolerance = "2000";
const selectedName = [...variants].sort((a, b) => {
  const aa = summaries[a.name].validation[selectionTolerance], bb = summaries[b.name].validation[selectionTolerance];
  return bb.exactF1 - aa.exactF1 || bb.exactRecall - aa.exactRecall || bb.exactPrecision - aa.exactPrecision;
})[0].name;
const selected = summaries[selectedName];
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  method: "exact registered helpme engine replay; one-to-one decision-time matching",
  markets: markets.length,
  targetActions: scopedActions.length,
  tolerancesMs,
  definitions: {
    exactMatch: "one predicted action and one target action share side and their causal decision times differ by at most tolerance",
    exactPrecision: "exact matches / predicted actions",
    exactRecall: "exact matches / target actions",
    releaseRecallIgnoringSide: "time-matched releases / target actions, without requiring side",
  },
  selection: { segment: "2026-08-21 validation only", toleranceMs: 2000,
    objective: "maximum exact F1, then recall, then precision", selected: selectedName },
  variants: summaries,
  conclusion: {
    selected: selectedName,
    holdout2s: selected.holdout[selectionTolerance],
    exactReleaseActionParity98: selected.holdout[selectionTolerance].exactPrecision >= .98
      && selected.holdout[selectionTolerance].exactRecall >= .98,
    runtimeConfigPromotion: false,
    reason: "A release-clock change is promoted only if held-out exact precision and exact recall both clear 98%.",
  },
};

fs.mkdirSync(resultDir, { recursive: true });
if (!Number.isFinite(marketLimit)) {
  fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
  const rows = variants.map((variant) => {
    const val = summaries[variant.name].validation[selectionTolerance];
    const hold = summaries[variant.name].holdout[selectionTolerance];
    return `| ${variant.name} | ${val.predictions} | ${pct(val.exactPrecision)} | ${pct(val.exactRecall)} | ${pct(val.exactF1)} | ${hold.predictions} | ${pct(hold.exactPrecision)} | ${pct(hold.exactRecall)} | ${pct(hold.exactF1)} |`;
  }).join("\n");
  const md = `# Exact release/action parity audit\n\n` +
    `Exact registered-engine replay over ${markets.length} BTC 5-minute markets and ${scopedActions.length} target actions. Config selection uses Aug 21 only; the table uses a ±2 second causal decision-time tolerance.\n\n` +
    `| Variant | Val predictions | Val precision | Val recall | Val F1 | Holdout predictions | Holdout precision | Holdout recall | Holdout F1 |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `Selected on validation: **${selectedName}**. Held-out exact precision ${pct(selected.holdout[selectionTolerance].exactPrecision)}, recall ${pct(selected.holdout[selectionTolerance].exactRecall)}.\n\n` +
    `98% exact direction + release/action parity: **${report.conclusion.exactReleaseActionParity98 ? "yes" : "no"}**. No runtime clock/config is promoted by this audit.\n`;
  fs.writeFileSync(outputMd, md);
  console.log(md);
}
console.log(JSON.stringify({ limited: Number.isFinite(marketLimit), markets: markets.length,
  targetActions: scopedActions.length, selected: selectedName,
  validation2s: selected.validation[selectionTolerance], holdout2s: selected.holdout[selectionTolerance] }, null, 2));
