#!/usr/bin/env node
// Exact raw-dollar audit for the FastMX toggle modes at inferred target action times.
// Binance velocity is rebuilt from the native feed as price(t)-price(t-lookback),
// matching both dev-tool's gap-velocity algebra and the live strategy.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const resultDir = path.join(root, "research/wallet-75cc/results");
const outputJson = path.join(resultDir, "toggle-velocity-parity-2026-08-27.json");
const outputMd = path.join(resultDir, "toggle-velocity-parity-2026-08-27.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");

const config = {
  clobLookbackMs: 3000,
  clobVelocityMin: 0.08,
  binanceLookbackMs: 3000,
  binanceGapVelocityMinUsd: 6,
};

function readGzip(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}
function finite(value) {
  return value != null && Number.isFinite(Number(value));
}
function number(value) {
  return finite(value) ? Number(value) : 0;
}
function clobMidMove(row, seconds) {
  return (number(row[`sideAskMove${seconds}`]) + number(row[`sideBidMove${seconds}`])) / 2;
}
function sameDirection(a, b) {
  return a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b);
}
function atOrBefore(rows, targetMs) {
  let low = 0, high = rows.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(rows[middle].ms) <= targetMs) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer >= 0 ? rows[answer] : null;
}

function attachRawBinance(pairs, feedDir) {
  const grouped = new Map();
  for (const pair of pairs) {
    const rows = grouped.get(pair.slug) || [];
    rows.push(pair);
    grouped.set(pair.slug, rows);
  }
  const out = [];
  let missingFeeds = 0, missingVelocity = 0;
  for (const [slug, selected] of grouped) {
    const file = path.join(feedDir, `${slug}.json.gz`);
    if (!fs.existsSync(file)) {
      missingFeeds++;
      for (const pair of selected) out.push({ pair, binanceGapVelocity: null });
      continue;
    }
    const feed = readGzip(file);
    const binance = (feed.ticks || []).filter((tick) => finite(tick.ms) && finite(tick.bz));
    for (const pair of selected) {
      const current = atOrBefore(binance, pair.ms);
      const prior = atOrBefore(binance, pair.ms - config.binanceLookbackMs);
      let velocity = null;
      if (current && prior) {
        const raw = Number(current.bz) - Number(prior.bz);
        const orientedSign = Math.sign(number(pair.chosen?.bzMove3));
        if (orientedSign) velocity = Math.abs(raw) * orientedSign;
        else if (Math.abs(raw) < 1e-12) velocity = 0;
      }
      if (velocity == null) missingVelocity++;
      out.push({ pair, binanceGapVelocity: velocity });
    }
  }
  return { rows: out, missingFeeds, missingVelocity };
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return { low: null, high: null };
  const p = successes / total, zz = z * z;
  const center = (p + zz / (2 * total)) / (1 + zz / total);
  const spread = z * Math.sqrt((p * (1 - p) + zz / (4 * total)) / total) / (1 + zz / total);
  return { low: center - spread, high: center + spread };
}
function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function classify(row, mode, thresholds = config) {
  const c3 = clobMidMove(row.pair.chosen, "3");
  const bz = row.binanceGapVelocity;
  const clobReady = Math.abs(c3) + 1e-12 >= thresholds.clobVelocityMin;
  const binanceReady = bz != null && Math.abs(bz) + 1e-12 >= thresholds.binanceGapVelocityMinUsd;
  if (mode === "both") return { emit: clobReady && binanceReady && sameDirection(c3, bz), correct: c3 > 0 };
  if (mode === "clobOnly") return { emit: clobReady, correct: c3 > 0 };
  return { emit: binanceReady, correct: bz > 0 };
}
function metrics(rows, mode, thresholds = config) {
  let actions = 0, successes = 0;
  const byDay = {};
  for (const row of rows) {
    const result = classify(row, mode, thresholds);
    if (!result.emit) continue;
    actions++;
    if (result.correct) successes++;
    const day = new Date(row.pair.ms).toISOString().slice(0, 10);
    byDay[day] ||= { actions: 0, successes: 0 };
    byDay[day].actions++;
    if (result.correct) byDay[day].successes++;
  }
  for (const value of Object.values(byDay)) {
    value.precision = round(value.successes / value.actions);
    delete value.successes;
  }
  const interval = wilson(successes, actions);
  return {
    actions,
    successes,
    errors: actions - successes,
    coverage: round(actions / Math.max(1, rows.length)),
    precision: actions ? round(successes / actions) : null,
    wilson95Low: round(interval.low),
    wilson95High: round(interval.high),
    byDay,
  };
}

const mainPairs = readGzip(path.join(dataDir,
  "side-choice-samples-consensus-btc-aug16-25-decision520.json.gz")).pairs;
const aug26Pairs = readGzip(path.join(dataDir,
  "side-choice-samples-v2-btc-aug26-untouched-decision520.json.gz")).pairs;
const aug27Pairs = readGzip(path.join(dataDir,
  "fresh-aug27/side-choice-samples-aug27-exact-decision520.json.gz")).pairs;
const main = attachRawBinance(mainPairs, path.join(dataDir, "feeds/v2-l2"));
const aug26 = attachRawBinance(aug26Pairs, path.join(dataDir, "feeds/v2-l2-untouched-aug26"));
const aug27 = attachRawBinance(aug27Pairs, path.join(dataDir, "fresh-aug27/feeds-v2-l2"));
const splitRows = {
  fit: main.rows.filter((row) => row.pair.ms < fitEnd),
  validation: main.rows.filter((row) => row.pair.ms >= fitEnd && row.pair.ms < validationEnd),
  holdout: main.rows.filter((row) => row.pair.ms >= validationEnd),
  externalAug26: aug26.rows,
  freshExactAug27: aug27.rows,
};
splitRows.combinedForward = [...splitRows.holdout, ...splitRows.externalAug26, ...splitRows.freshExactAug27];

if (process.env.FASTMX_THRESHOLD_GRID === "1") {
  const candidates = [];
  for (let ci = 8; ci <= 40; ci++) {
    for (let bz = 2; bz <= 80; bz += 2) {
      const thresholds = { clobVelocityMin: ci / 100, binanceGapVelocityMinUsd: bz };
      const fit = metrics(splitRows.fit, "both", thresholds);
      const validation = metrics(splitRows.validation, "both", thresholds);
      const forward = metrics(splitRows.combinedForward, "both", thresholds);
      if (validation.actions >= 20 && forward.actions >= 20) {
        candidates.push({ ...thresholds, fit, validation, forward });
      }
    }
  }
  candidates.sort((a, b) => b.validation.precision - a.validation.precision
    || b.validation.actions - a.validation.actions || b.forward.precision - a.forward.precision);
  console.log("FASTMX_THRESHOLD_GRID");
  console.log(JSON.stringify(candidates.slice(0, 40).map((candidate) => ({
    clobVelocityMin: candidate.clobVelocityMin,
    binanceGapVelocityMinUsd: candidate.binanceGapVelocityMinUsd,
    fit: { actions: candidate.fit.actions, precision: candidate.fit.precision },
    validation: { actions: candidate.validation.actions, precision: candidate.validation.precision },
    forward: { actions: candidate.forward.actions, precision: candidate.forward.precision },
  })), null, 2));
}

const modes = {};
for (const mode of ["both", "clobOnly", "binanceOnly"]) {
  modes[mode] = Object.fromEntries(Object.entries(splitRows)
    .map(([name, rows]) => [name, metrics(rows, mode)]));
}
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  objective: "same-side precision of independently switchable FastMX velocity families at inferred target action times",
  formula: {
    binanceGapVelocity: "(priceNow-open)-(pricePrior-open)=priceNow-pricePrior, raw USD",
    clobMidVelocity: "upMidNow-upMidPrior, where upMid=(bestBid+bestAsk)/2",
    both: "both enabled families clear thresholds and agree",
  },
  config,
  dataQuality: {
    main: { pairs: mainPairs.length, missingFeeds: main.missingFeeds, missingVelocity: main.missingVelocity },
    externalAug26: { pairs: aug26Pairs.length, missingFeeds: aug26.missingFeeds, missingVelocity: aug26.missingVelocity },
    freshExactAug27: { pairs: aug27Pairs.length, missingFeeds: aug27.missingFeeds, missingVelocity: aug27.missingVelocity },
  },
  modes,
  caveat: "Retrospective direction precision at target action times is not market participation, release-time parity, profitability, or a prospectively locked result.",
};

const pct = (value) => value == null ? "n/a" : `${round(value * 100, 2)}%`;
const line = (name, value) => `- ${name}: ${value.actions} actions, ${pct(value.coverage)} coverage, ${pct(value.precision)} precision, Wilson-95 lower ${pct(value.wilson95Low)}.`;
let markdown = "# FastMX toggle-velocity parity audit\n\n";
markdown += `Binance gap velocity is rebuilt from raw feed prices with the exact formula \`price(t)-price(t-${config.binanceLookbackMs}ms)\`.\n\n`;
for (const [mode, result] of Object.entries(modes)) {
  markdown += `## ${mode}\n\n`;
  markdown += line("Fit", result.fit) + "\n" + line("Validation", result.validation) + "\n"
    + line("Holdout Aug 22–25", result.holdout) + "\n" + line("External Aug 26", result.externalAug26) + "\n"
    + line("Fresh exact Aug 27", result.freshExactAug27) + "\n" + line("Combined forward", result.combinedForward) + "\n\n";
}
markdown += `Caveat: ${report.caveat}\n`;
fs.mkdirSync(resultDir, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputMd, markdown);
console.log(markdown);
console.log(JSON.stringify({ outputJson, dataQuality: report.dataQuality }, null, 2));
