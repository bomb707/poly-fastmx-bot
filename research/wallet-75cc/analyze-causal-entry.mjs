#!/usr/bin/env node
// Conservative, reproducible entry-direction analysis for wallet 0x75cc...3ce1.
//
// This script deliberately does not search thresholds, weights, lookbacks, or
// feature combinations. The features and chronological split are fixed below.
// Results measure signal direction conditional on a target action; they do not
// identify the wallet's exact trigger, prove causality, or estimate profit.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { TARGET_WALLET } from "./constants.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INPUT = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-75cc/fresh-2026-09-03_2026-09-04.json"));
const CACHE_DIR = path.resolve(process.argv[3] || path.join(ROOT, "data/wincache"));
const OUTPUT_DIR = path.resolve(process.argv[4] || path.join(import.meta.dirname, "results"));
const SPLIT_MS = Date.parse("2026-09-04T00:00:00Z");
const PRIMARY_LAG_MS = 1000;
const LAGS_MS = [500, 1000, 1500];
const BOOTSTRAP_SAMPLES = 2000;

const FEATURE_DEFS = [
  ["clobMid3s", "CLOB Up midpoint change, 3s"],
  ["clobMid5s", "CLOB Up midpoint change, 5s"],
  ["binance3s", "Binance BTC spot change, 3s"],
  ["binance5s", "Binance BTC spot change, 5s"],
  ["clobLevel", "CLOB Up midpoint minus 0.50"],
  ["binanceWindowGap", "Binance spot minus window open"],
  ["chainlink3s", "Chainlink change, 3s (control)"],
  ["crossVenueDelta3s", "Binance change minus Chainlink change, 3s (control)"],
  ["upDepthImbalance", "CLOB Up top-3 bid/ask depth imbalance (control)"],
];

const raw = JSON.parse(fs.readFileSync(INPUT, "utf8"));
if (String(raw.wallet || "").toLowerCase() !== TARGET_WALLET) {
  throw new Error(`Unexpected wallet in ${INPUT}`);
}

const btcTrades = raw.trades.filter((trade) =>
  String(trade.slug || "").startsWith("btc-updown-5m-") &&
  trade.action === "BUY" && /^(Up|Down)$/.test(String(trade.outcome || "")));

// Multiple fills for one side in one second are one observable wallet action.
const grouped = new Map();
for (const trade of btcTrades) {
  const key = `${trade.slug}|${trade.outcome}|${trade.timestamp}`;
  let action = grouped.get(key);
  if (!action) {
    action = { slug: trade.slug, side: trade.outcome, timestamp: Number(trade.timestamp),
      shares: 0, cost: 0, fills: 0 };
    grouped.set(key, action);
  }
  action.shares += Number(trade.size) || 0;
  action.cost += (Number(trade.size) || 0) * (Number(trade.price) || 0);
  action.fills++;
}

const actionsBySlug = new Map();
for (const action of grouped.values()) {
  if (!actionsBySlug.has(action.slug)) actionsBySlug.set(action.slug, []);
  actionsBySlug.get(action.slug).push(action);
}
for (const actions of actionsBySlug.values()) {
  actions.sort((a, b) => a.timestamp - b.timestamp || a.side.localeCompare(b.side));
  const firstSecond = actions[0]?.timestamp;
  for (const action of actions) action.firstAction = action.timestamp === firstSecond;
}

const cacheFiles = new Map();
for (const name of fs.readdirSync(CACHE_DIR)) {
  const match = /^(btc-updown-5m-\d+)_v2-l2-120-coherent\.json\.gz$/.exec(name);
  if (match && actionsBySlug.has(match[1])) cacheFiles.set(match[1], path.join(CACHE_DIR, name));
}

function snapshotAt(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(ticks[middle]?.ms) <= ms) { answer = ticks[middle]; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

function midpoint(tick) {
  const bid = Number(tick?.upBid), ask = Number(tick?.upAsk);
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
}

function delta(now, before, field) {
  const a = Number(now?.[field]), b = Number(before?.[field]);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

function depthImbalance(tick) {
  const bids = tick?.up?.bids?.slice(0, 3) || [];
  const asks = tick?.up?.asks?.slice(0, 3) || [];
  if (!bids.length || !asks.length) return null;
  const bidSize = bids.reduce((sum, level) => sum + (Number(level?.[1]) || 0), 0);
  const askSize = asks.reduce((sum, level) => sum + (Number(level?.[1]) || 0), 0);
  const total = bidSize + askSize;
  return total > 0 ? (bidSize - askSize) / total : null;
}

function buildFeatures(ticks, eventMs, lagMs, replay) {
  // Wallet timestamps have one-second resolution. Reading strictly before the
  // reported boundary avoids later ticks, but cannot prove that it precedes the
  // private decision because public trade timestamps may reflect confirmation.
  const cutoff = eventMs - lagMs;
  const now = snapshotAt(ticks, cutoff);
  const prior3 = snapshotAt(ticks, cutoff - 3000);
  const prior5 = snapshotAt(ticks, cutoff - 5000);
  const midNow = midpoint(now), mid3 = midpoint(prior3), mid5 = midpoint(prior5);
  const bzNow = Number(now?.bz);
  const openBinance = Number(replay?.openBinance);
  const bz3 = delta(now, prior3, "bz");
  const cl3 = delta(now, prior3, "cl");
  return {
    clobMid3s: midNow != null && mid3 != null ? midNow - mid3 : null,
    clobMid5s: midNow != null && mid5 != null ? midNow - mid5 : null,
    binance3s: bz3,
    binance5s: delta(now, prior5, "bz"),
    clobLevel: midNow != null ? midNow - 0.5 : null,
    binanceWindowGap: Number.isFinite(bzNow) && Number.isFinite(openBinance) ? bzNow - openBinance : null,
    chainlink3s: cl3,
    crossVenueDelta3s: bz3 != null && cl3 != null ? bz3 - cl3 : null,
    upDepthImbalance: depthImbalance(now),
  };
}

const rows = [];
let unreadableCaches = 0;
for (const [slug, actions] of actionsBySlug) {
  const cacheFile = cacheFiles.get(slug);
  if (!cacheFile) continue;
  let replay;
  try { replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile))); }
  catch { unreadableCaches++; continue; }
  if (replay.source !== "v2-orderbook-l2" || !Array.isArray(replay.ticks) || !replay.ticks.length) continue;
  for (const action of actions) {
    const eventMs = action.timestamp * 1000;
    const lagFeatures = Object.fromEntries(LAGS_MS.map((lag) =>
      [String(lag), buildFeatures(replay.ticks, eventMs, lag, replay)]));
    rows.push({ ...action, eventMs, expected: action.side === "Up" ? 1 : -1,
      split: eventMs < SPLIT_MS ? "discovery" : "holdout", lagFeatures });
  }
}

function sign(value) {
  return Number.isFinite(value) && value !== 0 ? Math.sign(value) : 0;
}

function seededRandom(seedText) {
  let state = 2166136261;
  for (const char of seedText) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function percentile(sorted, probability) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[index];
}

function summarizeDecisions(decisions, seed) {
  const usable = decisions.filter((item) => item.prediction !== 0);
  const byWindow = new Map();
  for (const item of usable) {
    const cell = byWindow.get(item.slug) || { hits: 0, count: 0 };
    cell.count++;
    if (item.prediction === item.expected) cell.hits++;
    byWindow.set(item.slug, cell);
  }
  const clusters = [...byWindow.values()];
  const hits = clusters.reduce((sum, item) => sum + item.hits, 0);
  const count = clusters.reduce((sum, item) => sum + item.count, 0);
  const random = seededRandom(seed);
  const bootstrap = [];
  if (clusters.length) {
    for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
      let sampleHits = 0, sampleCount = 0;
      for (let index = 0; index < clusters.length; index++) {
        const selected = clusters[Math.floor(random() * clusters.length)];
        sampleHits += selected.hits;
        sampleCount += selected.count;
      }
      if (sampleCount) bootstrap.push(sampleHits / sampleCount);
    }
    bootstrap.sort((a, b) => a - b);
  }
  return {
    observations: count,
    windows: clusters.length,
    coverage: decisions.length ? count / decisions.length : null,
    accuracy: count ? hits / count : null,
    clusterBootstrap95: [percentile(bootstrap, 0.025), percentile(bootstrap, 0.975)],
  };
}

function scopeRows(split, firstOnly) {
  return rows.filter((row) => (split === "all" || row.split === split) && (!firstOnly || row.firstAction));
}

function featureSummary(selected, feature, lagMs, seed) {
  return summarizeDecisions(selected.map((row) => ({ slug: row.slug, expected: row.expected,
    prediction: sign(row.lagFeatures[String(lagMs)]?.[feature]) })), seed);
}

function agreementSummary(selected, lagMs, seed) {
  const decisions = selected.map((row) => {
    const features = row.lagFeatures[String(lagMs)];
    const clob = sign(features?.clobMid3s), binance = sign(features?.binance3s);
    return { slug: row.slug, expected: row.expected,
      prediction: clob !== 0 && clob === binance ? clob : 0 };
  });
  return summarizeDecisions(decisions, seed);
}

const scopes = {};
for (const split of ["discovery", "holdout", "all"]) {
  scopes[split] = {};
  for (const [scopeName, firstOnly] of [["allActions", false], ["firstActions", true]]) {
    const selected = scopeRows(split, firstOnly);
    scopes[split][scopeName] = {
      actions: selected.length,
      windows: new Set(selected.map((row) => row.slug)).size,
      features: Object.fromEntries(FEATURE_DEFS.map(([feature]) => [feature,
        featureSummary(selected, feature, PRIMARY_LAG_MS, `${split}:${scopeName}:${feature}`)])),
      clobBinanceAgreement3s: agreementSummary(selected, PRIMARY_LAG_MS, `${split}:${scopeName}:agreement`),
    };
  }
}

const lagSensitivity = Object.fromEntries(LAGS_MS.map((lag) => {
  const selected = scopeRows("holdout", false);
  return [String(lag), {
    clobMid3s: featureSummary(selected, "clobMid3s", lag, `lag:${lag}:clob`),
    binance3s: featureSummary(selected, "binance3s", lag, `lag:${lag}:binance`),
    clobBinanceAgreement3s: agreementSummary(selected, lag, `lag:${lag}:agreement`),
  }];
}));

function behaviorSummary(selected) {
  const byWindow = new Map();
  for (const action of selected) {
    if (!byWindow.has(action.slug)) byWindow.set(action.slug, []);
    byWindow.get(action.slug).push(action);
  }
  let bothSideWindows = 0, sideTransitions = 0;
  for (const actions of byWindow.values()) {
    actions.sort((a, b) => a.timestamp - b.timestamp || a.side.localeCompare(b.side));
    if (new Set(actions.map((action) => action.side)).size > 1) bothSideWindows++;
    for (let index = 1; index < actions.length; index++) {
      if (actions[index].side !== actions[index - 1].side) sideTransitions++;
    }
  }
  return {
    actions: selected.length,
    windows: byWindow.size,
    upActions: selected.filter((action) => action.side === "Up").length,
    downActions: selected.filter((action) => action.side === "Down").length,
    bothSideWindows,
    bothSideWindowRate: byWindow.size ? bothSideWindows / byWindow.size : null,
    sideTransitions,
  };
}

const allCollapsedActions = [...grouped.values()];
const publicBehavior = {
  discovery: behaviorSummary(allCollapsedActions.filter((action) => action.timestamp * 1000 < SPLIT_MS)),
  holdout: behaviorSummary(allCollapsedActions.filter((action) => action.timestamp * 1000 >= SPLIT_MS)),
};

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  wallet: TARGET_WALLET,
  input: path.relative(ROOT, INPUT),
  cache: { sourceRequired: "v2-orderbook-l2", directory: path.relative(ROOT, CACHE_DIR),
    targetWindows: actionsBySlug.size, replayedWindows: new Set(rows.map((row) => row.slug)).size,
    missingWindows: actionsBySlug.size - new Set(rows.map((row) => row.slug)).size, unreadableCaches },
  design: {
    asset: "BTC 5-minute Up/Down",
    event: "target BUY fills collapsed by market, side, and whole-second timestamp",
    primaryLagMs: PRIMARY_LAG_MS,
    lagSensitivityMs: LAGS_MS,
    splitAt: new Date(SPLIT_MS).toISOString(),
    bootstrap: `${BOOTSTRAP_SAMPLES} market-window cluster resamples`,
    fixedFeatures: Object.fromEntries(FEATURE_DEFS),
    caveat: "Public timestamps may lag the private decision. Conditional direction agreement is not a trigger test, causal attribution, sizing model, or profitability estimate.",
  },
  counts: { rawBtcFills: btcTrades.length, collapsedActions: grouped.size, replayableActions: rows.length },
  publicBehavior,
  scopes,
  holdoutLagSensitivity: lagSensitivity,
};

const pct = (value) => value == null ? "—" : `${(100 * value).toFixed(2)}%`;
const metricCell = (metric) => `${pct(metric.accuracy)} (${pct(metric.clusterBootstrap95[0])}–${pct(metric.clusterBootstrap95[1])})`;
const holdout = report.scopes.holdout.allActions;
const holdoutFirst = report.scopes.holdout.firstActions;
const coreFeatures = FEATURE_DEFS.slice(0, 4);
const lines = [
  "# Conservative target-wallet entry-direction analysis",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "## Design",
  "",
  `- Wallet: \`${TARGET_WALLET}\``,
  `- Evidence: exact BAPI v2 L2 replays for ${report.cache.replayedWindows}/${report.cache.targetWindows} target BTC windows`,
  `- Split: September 3 discovery; September 4 chronological holdout at \`${report.design.splitAt}\``,
  `- Clock rule: features end ${PRIMARY_LAG_MS} ms before the wallet's reported whole-second timestamp`,
  "- No parameter, threshold, weight, lookback, or feature-combination search is performed",
  "- 95% intervals resample whole market windows, not correlated actions",
  "",
  "## Descriptive wallet behavior",
  "",
  `On September 4, the target bought both outcomes in ${publicBehavior.holdout.bothSideWindows}/${publicBehavior.holdout.windows} traded markets (${pct(publicBehavior.holdout.bothSideWindowRate)}) and made ${publicBehavior.holdout.sideTransitions} observed side-to-side action transitions. This confirms that a one-direction-per-market bot is structurally different from the target; it does not identify the target's hedge or sizing rule.`,
  "",
  "## September 4 holdout — all target actions",
  "",
  "| Predeclared signal | Direction agreement (95% cluster CI) | Usable actions | Coverage |",
  "|---|---:|---:|---:|",
  ...FEATURE_DEFS.map(([key, label]) => {
    const metric = holdout.features[key];
    return `| ${label} | ${metricCell(metric)} | ${metric.observations} | ${pct(metric.coverage)} |`;
  }),
  `| CLOB 3s and Binance 3s agree | ${metricCell(holdout.clobBinanceAgreement3s)} | ${holdout.clobBinanceAgreement3s.observations} | ${pct(holdout.clobBinanceAgreement3s.coverage)} |`,
  "",
  "## September 4 holdout — first target action per market",
  "",
  "| Predeclared signal | Direction agreement (95% cluster CI) | Usable markets | Coverage |",
  "|---|---:|---:|---:|",
  ...coreFeatures.map(([key, label]) => {
    const metric = holdoutFirst.features[key];
    return `| ${label} | ${metricCell(metric)} | ${metric.observations} | ${pct(metric.coverage)} |`;
  }),
  `| CLOB 3s and Binance 3s agree | ${metricCell(holdoutFirst.clobBinanceAgreement3s)} | ${holdoutFirst.clobBinanceAgreement3s.observations} | ${pct(holdoutFirst.clobBinanceAgreement3s.coverage)} |`,
  "",
  "## Timestamp sensitivity — September 4 holdout",
  "",
  "| Pre-event offset | CLOB 3s | Binance 3s | Both agree |",
  "|---:|---:|---:|---:|",
  ...LAGS_MS.map((lag) => {
    const item = lagSensitivity[String(lag)];
    return `| ${lag} ms | ${metricCell(item.clobMid3s)} | ${metricCell(item.binance3s)} | ${metricCell(item.clobBinanceAgreement3s)} |`;
  }),
  "",
  "## Interpretation",
  "",
  "CLOB midpoint velocity and Binance spot velocity remain the strongest predeclared directional correlates if their holdout accuracy and intervals exceed the controls. Agreement between them is stronger evidence of direction than either signal alone.",
  "",
  "This cannot establish which feed the wallet actually reads: CLOB and Binance co-move, the sample is conditioned on times when the wallet traded, and a public trade timestamp may follow the wallet's private decision. It also does not recover the release trigger or token sizing. Those require evaluating candidate signals at every eligible timestamp, including non-entry times, on a later untouched period.",
  "",
];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const jsonOutput = path.join(OUTPUT_DIR, "causal-entry-analysis.json");
const markdownOutput = path.join(OUTPUT_DIR, "causal-entry-analysis.md");
fs.writeFileSync(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(markdownOutput, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ jsonOutput, markdownOutput, counts: report.counts, cache: report.cache,
  holdout: { actions: holdout.actions, windows: holdout.windows,
    clob3s: holdout.features.clobMid3s.accuracy,
    binance3s: holdout.features.binance3s.accuracy,
    agreement: holdout.clobBinanceAgreement3s.accuracy } }, null, 2));
