#!/usr/bin/env node
// Causal order-fire audit for the currently deployed FastMX signal.
//
// This intentionally evaluates proposed confirmations without changing runtime
// configuration. Candidate selection uses Aug 21 only; Aug 22-25 stays held out.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { STRAT, step } from "../../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const cohortFile = path.join(dataDir, "cohort-2026-08-16_2026-08-26-btc.json");
const actionFile = path.join(dataDir, "fire-actions-consensus-btc-aug16-25-decision520.json.gz");
const feedDir = path.join(dataDir, "feeds/v2-l2");
const runtimeFile = path.join(root, "data/fastmx-live/runtime-config.json");
const resultDir = path.join(root, "research/wallet-75cc/results");
const outputJson = path.join(resultDir, "current-fire-confirmations-2026-08-27.json");
const outputMd = path.join(resultDir, "current-fire-confirmations-2026-08-27.md");

const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");
const tolerancesMs = [500, 1000, 2000, 5000];
const staleGapMs = 6000;
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const marketLimit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 1) : Infinity;

const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const startMs = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
const segmentOf = (ms) => ms < fitEnd ? "fit" : ms < validationEnd ? "validation" : "holdout";

function nestedBook(raw) {
  const asks = raw?.asks || [], bids = raw?.bids || [];
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

function oneToOne(predictions, actions, toleranceMs, requireSide) {
  const groups = new Map();
  const groupKey = (row, action) => `${row.slug}\u0000${requireSide
    ? (action ? row.outcome : row.side) : "*"}`;
  for (const row of actions) {
    const key = groupKey(row, true), group = groups.get(key) || { predictions: [], actions: [] };
    group.actions.push(row.decisionMs); groups.set(key, group);
  }
  for (const row of predictions) {
    const key = groupKey(row, false), group = groups.get(key) || { predictions: [], actions: [] };
    group.predictions.push(row.ms); groups.set(key, group);
  }
  let matches = 0;
  for (const group of groups.values()) {
    group.predictions.sort((a, b) => a - b); group.actions.sort((a, b) => a - b);
    let p = 0, a = 0;
    while (p < group.predictions.length && a < group.actions.length) {
      const delta = group.predictions[p] - group.actions[a];
      if (Math.abs(delta) <= toleranceMs) { matches++; p++; a++; }
      else if (delta < -toleranceMs) p++;
      else a++;
    }
  }
  return matches;
}

function score(predictions, actions, toleranceMs) {
  const exactMatches = oneToOne(predictions, actions, toleranceMs, true);
  const releaseMatches = oneToOne(predictions, actions, toleranceMs, false);
  const precision = predictions.length ? exactMatches / predictions.length : null;
  const recall = actions.length ? exactMatches / actions.length : null;
  return {
    predictions: predictions.length,
    targetActions: actions.length,
    exactMatches,
    exactPrecision: round(precision),
    exactRecall: round(recall),
    exactF1: precision != null && recall != null && precision + recall > 0
      ? round(2 * precision * recall / (precision + recall)) : 0,
    releaseMatchesIgnoringSide: releaseMatches,
    releaseRecallIgnoringSide: round(actions.length ? releaseMatches / actions.length : null),
  };
}

function summarize(predictions, actions) {
  return Object.fromEntries(["fit", "validation", "holdout", "all"].map((segment) => {
    const pred = segment === "all" ? predictions : predictions.filter((row) => segmentOf(row.ms) === segment);
    const act = segment === "all" ? actions : actions.filter((row) => segmentOf(row.decisionMs) === segment);
    return [segment, Object.fromEntries(tolerancesMs.map((toleranceMs) =>
      [String(toleranceMs), score(pred, act, toleranceMs)]))];
  }));
}

function firstPerSidePriceCell(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.slug}\u0000${row.side}\u0000${Math.round(row.ask * 100)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function strictTrend(rows) {
  return rows.filter((row) => row.signal?.binanceStrongTrend
    && row.signal?.binanceTrendDir === row.side);
}

function strongerImpulse(rows, dual) {
  return rows.filter((row) => Math.abs(row.signal?.binanceGapVelocity ?? 0) >= 10
    && (!dual || Math.abs(row.signal?.midVelocity ?? 0) >= 0.03));
}

function pct(value) {
  return value == null ? "n/a" : `${round(value * 100, 2)}%`;
}

const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
const deployed = { ...STRAT, ...(runtime.shadowParams || {}) };
const allActions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionFile))).rows;
let markets = cohort.markets.filter((market) => market.winner && market.slug.startsWith("btc-")
  && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug));
if (Number.isFinite(marketLimit)) markets = markets.slice(0, marketLimit);
const marketSet = new Set(markets.map((market) => market.slug));
const actions = allActions.filter((row) => marketSet.has(row.slug));
const entryActions = actions.filter((row) => row.role === "entry/topup");

const modeParams = {
  currentBinance: { ...deployed },
  currentBoth: { ...deployed, H_CLOB_MID_VELOCITY_ON: true },
  noWindowGapBinance: { ...deployed, H_BINANCE_GAP_AGREE_ON: false },
  noWindowGapBoth: { ...deployed, H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_AGREE_ON: false },
  rawBinance: { ...deployed, H_COOLDOWN_MS: 0 },
  rawBoth: { ...deployed, H_CLOB_MID_VELOCITY_ON: true, H_COOLDOWN_MS: 0 },
};
const modeRows = Object.fromEntries(Object.keys(modeParams).map((name) => [name, []]));
const onsetRows = { rawBinance: [], rawBoth: [] };

for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const modes = Object.fromEntries(Object.entries(modeParams).map(([name, params]) => [name, {
    params, state: {}, previousMs: null, wasQualified: false, qualifiedSide: null,
  }]));

  for (const tick of (feed.ticks || [])) {
    const t = (tick.ms - ws) / 1000;
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    if (up.bestAsk == null || down.bestAsk == null) continue;
    for (const [name, mode] of Object.entries(modes)) {
      const gapMs = mode.previousMs == null ? 0 : tick.ms - mode.previousMs;
      mode.previousMs = tick.ms;
      if (gapMs > staleGapMs) {
        mode.wasQualified = false; mode.qualifiedSide = null; continue;
      }
      const bzGap = tick.bz != null && feed.openBinance != null ? tick.bz - feed.openBinance : null;
      const got = step(mode.state, { t, up, down, bzPrice: tick.bz ?? null,
        clPrice: tick.cl ?? null, openBinance: feed.openBinance ?? null,
        openChainlink: feed.openChainlink ?? null,
        bzGap, bzGapPct: bzGap != null && feed.openBinance
          ? bzGap / feed.openBinance * 100 : null,
        winHour: new Date(ws).getUTCHours(), winDay: new Date(ws).getUTCDay(),
      }, mode.params, gapMs || 120, tick.ms);
      for (const rec of got) modeRows[name].push({ slug: market.slug, ms: tick.ms,
        side: rec.side, ask: rec.effPx, cap: rec.limitPx, signal: rec.signal });

      if (name === "rawBinance" || name === "rawBoth") {
        const status = mode.state.helpmeStatus || {};
        const qualified = got.length > 0 || mode.state.gateReason === "signal-already-entered";
        const side = got[0]?.side ?? status.side ?? null;
        if (qualified && got.length > 0 && (!mode.wasQualified || side !== mode.qualifiedSide)) {
          const rec = got[0];
          onsetRows[name].push({ slug: market.slug, ms: tick.ms, side: rec.side,
            ask: rec.effPx, cap: rec.limitPx, signal: rec.signal });
        }
        mode.wasQualified = qualified;
        mode.qualifiedSide = qualified ? side : null;
      }
    }
  }
  if ((index + 1) % 50 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: "current-fire-confirmation-replay",
      done: index + 1, total: markets.length }));
  }
}

const candidates = {
  "deployed-binance": modeRows.currentBinance,
  "dual-clob-binance": modeRows.currentBoth,
  "binance-without-window-gap": modeRows.noWindowGapBinance,
  "dual-without-window-gap": modeRows.noWindowGapBoth,
  "binance-strict-trend": strictTrend(modeRows.currentBinance),
  "dual-strict-trend": strictTrend(modeRows.currentBoth),
  "binance-qualification-onset": onsetRows.rawBinance,
  "dual-qualification-onset": onsetRows.rawBoth,
  "binance-first-side-price-cell": firstPerSidePriceCell(modeRows.currentBinance),
  "dual-first-side-price-cell": firstPerSidePriceCell(modeRows.currentBoth),
  "binance-stronger-impulse": strongerImpulse(modeRows.currentBinance, false),
  "dual-stronger-impulse": strongerImpulse(modeRows.currentBoth, true),
  "binance-onset-strict-trend": strictTrend(onsetRows.rawBinance),
  "dual-onset-strict-trend": strictTrend(onsetRows.rawBoth),
};

const variants = Object.fromEntries(Object.entries(candidates).map(([name, predictions]) => [name, {
  allTargetActions: summarize(predictions, actions),
  entryTopupActions: summarize(predictions, entryActions),
}]))
const selectionTolerance = "2000";
const selectedName = Object.keys(variants).sort((left, right) => {
  const a = variants[left].entryTopupActions.validation[selectionTolerance];
  const b = variants[right].entryTopupActions.validation[selectionTolerance];
  return b.exactF1 - a.exactF1 || b.exactPrecision - a.exactPrecision || b.exactRecall - a.exactRecall;
})[0];
const roleCounts = Object.fromEntries([...new Set(actions.map((row) => row.role))]
  .map((role) => [role, actions.filter((row) => row.role === role).length]));
const oppositeInventoryCounts = Object.fromEntries(Object.keys(roleCounts).map((role) => [role,
  actions.filter((row) => row.role === role).filter((row) => {
    const sideSign = row.outcome === "Up" ? 1 : -1;
    return Math.sign(Number(row.beforeImbalance) || 0) === -sideSign;
  }).length,
]));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  method: "causal engine/strategies/helpme.js order-decision replay; one-to-one slug/side/time matching",
  markets: markets.length,
  targetActions: actions.length,
  targetEntryTopupActions: entryActions.length,
  roleCounts,
  oppositeInventoryCounts,
  deployedParams: deployed,
  tolerancesMs,
  split: { fit: "Aug 16-20", validation: "Aug 21", holdout: "Aug 22-25" },
  definitions: {
    precision: "target-matched predicted order fires / predicted order fires",
    coverageRecall: "target actions matched by a predicted fire / target actions",
    exactMatch: "same market and side, with decision clocks within the stated tolerance; one-to-one",
  },
  selection: { segment: "Aug 21 validation only", targetSubset: "entry/topup",
    toleranceMs: 2000, objective: "maximum exact F1, then precision, then recall", selected: selectedName },
  variants,
  conclusion: {
    runtimeConfigPromotion: false,
    selectedResearchCandidate: selectedName,
    selectedHoldout: variants[selectedName].entryTopupActions.holdout[selectionTolerance],
    reason: "No unapproved confirmation is promoted; exact release matching must be demonstrated out of sample.",
  },
};

fs.mkdirSync(resultDir, { recursive: true });
if (!Number.isFinite(marketLimit)) {
  fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
  const rows = Object.keys(variants).map((name) => {
    const validation = variants[name].entryTopupActions.validation[selectionTolerance];
    const holdout = variants[name].entryTopupActions.holdout[selectionTolerance];
    return `| ${name} | ${validation.predictions} | ${pct(validation.exactPrecision)} | ${pct(validation.exactRecall)} | ${pct(validation.exactF1)} | ${holdout.predictions} | ${pct(holdout.exactPrecision)} | ${pct(holdout.exactRecall)} | ${pct(holdout.exactF1)} |`;
  }).join("\n");
  const selected = variants[selectedName].entryTopupActions.holdout[selectionTolerance];
  const markdown = `# Current FastMX order-fire confirmation audit\n\n` +
    `Causal replay over ${markets.length} BTC five-minute markets. The score below matches the entry-only FastMX decision to the target wallet's ${entryActions.length} entry/top-up actions by market, side, and ±2 seconds. Aug 21 selects a candidate; Aug 22-25 is untouched holdout.\n\n` +
    `| Candidate | Val fires | Val precision | Val coverage | Val F1 | Holdout fires | Holdout precision | Holdout coverage | Holdout F1 |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `Validation selected **${selectedName}**. Holdout precision ${pct(selected.exactPrecision)}, coverage ${pct(selected.exactRecall)}, and F1 ${pct(selected.exactF1)}.\n\n` +
    `Structural limit: the target has ${roleCounts.hedge + roleCounts["overhedge-cross"]} hedge/overhedge actions (${pct((roleCounts.hedge + roleCounts["overhedge-cross"]) / actions.length)} of all actions). All ${oppositeInventoryCounts.hedge + oppositeInventoryCounts["overhedge-cross"]} occur opposite its pre-order inventory. An entry-only public-price signal cannot reproduce that private inventory-dependent branch.\n\n` +
    `No runtime confirmation was changed by this research audit.\n`;
  fs.writeFileSync(outputMd, markdown);
  console.log(markdown);
}
console.log(JSON.stringify({ limited: Number.isFinite(marketLimit), markets: markets.length,
  targetActions: actions.length, targetEntryTopupActions: entryActions.length,
  selected: selectedName,
  validation2s: variants[selectedName].entryTopupActions.validation[selectionTolerance],
  holdout2s: variants[selectedName].entryTopupActions.holdout[selectionTolerance] }, null, 2));
