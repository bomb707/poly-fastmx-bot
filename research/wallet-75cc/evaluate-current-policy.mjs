#!/usr/bin/env node
// Compare the effective FastMX simulation profile with the latest reconstructed
// target-wallet action clock using the same cached BAPI v2 L2 windows.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { simulateFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const ecosystem = require("../../ecosystem.config.cjs");
const app = ecosystem.apps?.find((row) => row?.name === "poly-fastmx-simulation");
if (!app) throw new Error("poly-fastmx-simulation profile not found");

const runtimeFile = path.resolve(app.cwd || root,
  app.env?.RUNTIME_CONFIG_FILE || "data/runtime-config.json");
let runtime = {};
try { runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch {}
const strategyKeys = new Set(Object.keys(STRAT));
const strategyOnly = (value) => Object.fromEntries(Object.entries(value || {})
  .filter(([key]) => strategyKeys.has(key)));
const params = {
  ...STRAT,
  ...strategyOnly(runtime.shadowParams),
  ...strategyOnly(JSON.parse(app.env?.SHADOW_PARAMS_JSON || "{}")),
  MAX_SESSION_LOSS: 0,
  LIVE_FILLS: false,
};

const actionFile = path.join(root, "data/wallet-75cc/current-sizing-actions.json.gz");
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionFile))).rows;
const cacheDir = path.join(root, "data/wincache");
const tolerancesMs = [750, 2000, 5000];
const holdoutMs = Date.parse("2026-09-04T00:00:00Z");
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const actionsBySlug = new Map();
for (const action of actions) {
  const rows = actionsBySlug.get(action.slug) || [];
  rows.push(action);
  actionsBySlug.set(action.slug, rows);
}

const predictions = [];
const comparableActions = [];
let usableMarkets = 0;
for (const [slug, targetRows] of actionsBySlug) {
  const file = path.join(cacheDir, `${slug}_v2-l2-120-coherent.json.gz`);
  let replay;
  try { replay = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); } catch { continue; }
  if (replay.source !== "v2-orderbook-l2" || !replay.winSide) continue;
  const ws = Number(slug.split("-").at(-1));
  const fills = simulateFills({ ticks: replay.ticks, openBinance: replay.openBinance,
    openPrice: replay.openPrice, windowStart: ws }, params);
  for (const fill of fills) {
    const decidedT = Number.isFinite(fill.decidedT) ? fill.decidedT
      : Number.isFinite(fill.placedT) ? fill.placedT : fill.tInto;
    predictions.push({ slug, side: fill.side,
      decisionMs: Math.round(ws * 1000 + decidedT * 1000), role: fill.role });
  }
  comparableActions.push(...targetRows);
  usableMarkets++;
}

function match(predicted, actual, toleranceMs) {
  const byKey = (rows, timeKey, sideKey, requireSide) => {
    const map = new Map();
    for (const row of rows) {
      const key = requireSide ? `${row.slug}:${row[sideKey]}` : row.slug;
      const values = map.get(key) || [];
      values.push({ time: row[timeKey], side: row[sideKey] });
      map.set(key, values);
    }
    for (const values of map.values()) values.sort((a, b) => a.time - b.time);
    return map;
  };
  const pair = (requireSide) => {
    const pred = byKey(predicted, "decisionMs", "side", requireSide);
    const act = byKey(actual, "decisionMs", "outcome", requireSide);
    let matches = 0, sameSide = 0;
    const deltas = [];
    for (const key of new Set([...pred.keys(), ...act.keys()])) {
      const pp = pred.get(key) || [], aa = act.get(key) || [];
      let p = 0, a = 0;
      while (p < pp.length && a < aa.length) {
        const delta = pp[p].time - aa[a].time;
        if (Math.abs(delta) <= toleranceMs) {
          matches++; deltas.push(delta);
          if (pp[p].side === aa[a].side) sameSide++;
          p++; a++;
        } else if (delta < -toleranceMs) p++;
        else a++;
      }
    }
    deltas.sort((a, b) => a - b);
    return { matches, sameSide, deltas };
  };
  const exact = pair(true), release = pair(false);
  const precision = predicted.length ? exact.matches / predicted.length : null;
  const recall = actual.length ? exact.matches / actual.length : null;
  return {
    predictions: predicted.length,
    targetActions: actual.length,
    matches: exact.matches,
    precision: round(precision),
    recall: round(recall),
    f1: precision != null && recall != null && precision + recall > 0
      ? round(2 * precision * recall / (precision + recall)) : 0,
    releaseMatchesIgnoringSide: release.matches,
    matchedReleaseSideAccuracy: round(release.matches ? release.sameSide / release.matches : null),
    medianDecisionDeltaMs: exact.deltas.length
      ? exact.deltas[Math.floor(exact.deltas.length / 2)] : null,
  };
}

const segment = (rows, key, holdout) => rows.filter((row) =>
  holdout ? row[key] >= holdoutMs : row[key] < holdoutMs);
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  method: "one-to-one same-market, same-side causal decision-time matching",
  source: "cached coherent BAPI v2 full-L2 replay and public target actions shifted by 520 ms",
  usableMarkets,
  roleCounts: Object.fromEntries([...new Set(predictions.map((row) => row.role))]
    .sort().map((role) => [role, predictions.filter((row) => row.role === role).length])),
  all: Object.fromEntries(tolerancesMs.map((ms) => [ms, match(predictions, comparableActions, ms)])),
  discovery: Object.fromEntries(tolerancesMs.map((ms) => [ms, match(
    segment(predictions, "decisionMs", false), segment(comparableActions, "decisionMs", false), ms)])),
  holdout: Object.fromEntries(tolerancesMs.map((ms) => [ms, match(
    segment(predictions, "decisionMs", true), segment(comparableActions, "decisionMs", true), ms)])),
};

const output = path.join(root,
  "research/wallet-75cc/results/current-policy-parity-2026-09-04.json");
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
console.log(`Saved ${output}`);
