#!/usr/bin/env node
// Causal autonomous replay of the learned two-sided, one-cent cap menu.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { capFeatureAt, indexAtOrBefore, normalizeTick } from "./weekly-parity-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const cohortDir = path.resolve(process.argv[2]
  || path.join(root, "data/wallet-75cc/exact-2026-08-20_2026-08-27"));
const cacheDir = path.resolve(process.argv[3] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[4] || path.join(cohortDir, "observable-menu-evaluation.json"));
const modelDir = path.resolve(process.argv[5] || cohortDir);
const exact = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cohortDir, "exact-fire-dataset.json.gz"))));
const fitted = JSON.parse(fs.readFileSync(path.join(modelDir, "observable-cap-policy-model.json")));
const frozenEvaluationFile = path.join(modelDir, "observable-menu-evaluation.json");
const frozenEvaluation = modelDir === cohortDir || !fs.existsSync(frozenEvaluationFile) ? null
  : JSON.parse(fs.readFileSync(frozenEvaluationFile));
const model = fitted.model;
const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1_000;
const segmentFor = (ms) => ms < Date.parse("2026-08-25T00:00:00Z") ? "train"
  : ms < Date.parse("2026-08-26T00:00:00Z") ? "validation" : "holdout";
const thresholds = String(process.env.W75CC_MENU_THRESHOLDS || ".70,.75,.80,.84,.87,.90,.92,.94,.96")
  .split(",").map(Number).filter(finite);
const cooldowns = String(process.env.W75CC_MENU_COOLDOWNS_MS || "250,500,1000,2000,4000")
  .split(",").map(Number).filter(finite);
const cellUses = String(process.env.W75CC_MENU_CELL_USES || "1,2")
  .split(",").map(Number).filter(finite);
const decisionStepMs = Math.max(50, Number(process.env.W75CC_MENU_STEP_MS || 250));
const policyGrid = process.env.W75CC_FIXED_POLICY === "1" && frozenEvaluation
  ? [frozenEvaluation.selected.config]
  : thresholds.flatMap((threshold) => cooldowns.flatMap((cooldownMs) => cellUses.map((maxCellUses) => ({
    threshold, cooldownMs, maxCellUses,
  }))));
const policies = policyGrid.map(({ threshold, cooldownMs, maxCellUses }) => ({
  id: `q${threshold}-c${cooldownMs}-u${maxCellUses}`, threshold, cooldownMs, maxCellUses,
  generated: { train: [], validation: [], holdout: [] },
}));
const target = { train: [], validation: [], holdout: [] };
for (const action of exact.actions) {
  if (action.confidence === "low") continue;
  target[segmentFor(action.fireMs)].push(action);
}
const coeff = model.weights.map((weight, index) => Number(weight || 0)
  / Math.max(1e-9, Number(model.normalization.scale[index]) || 1));
const capIndex = model.featureNames.indexOf("cap");
const headroomIndex = model.featureNames.indexOf("capHeadroom");
const exactIndex = model.featureNames.indexOf("exactCap");
const logistic = (logit) => logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
function logit(vector) {
  let value = Number(model.intercept || 0);
  for (let index = 0; index < vector.length; index++) {
    value += coeff[index] * (vector[index] - Number(model.normalization.mean[index] || 0));
  }
  return value;
}
function askOf(tick, side) { return Number((side === "Up" ? tick.up : tick.down)?.asks?.[0]?.price); }
function nextCap(used, side, ask, maxUses) {
  for (let cents = Math.ceil((ask - 1e-10) * 100); cents <= 99; cents++) {
    if ((used.get(`${side}:${cents}`) || 0) < maxUses) return cents / 100;
  }
  return null;
}

const usableSlugs = exact.markets.filter((market) => market.usable).map((market) => market.slug);
for (let marketIndex = 0; marketIndex < usableSlugs.length; marketIndex++) {
  const slug = usableSlugs[marketIndex], file = path.join(cacheDir, `${slug}_v2-l2-120-coherent.json.gz`);
  if (!fs.existsSync(file)) continue;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  feed.slug ||= slug;
  feed.windowStart = startMs(slug);
  const ticks = (feed.ticks || []).map(normalizeTick);
  const points = [];
  let lastPointMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const t = (ticks[index].ms - startMs(slug)) / 1_000;
    if (t < 4 || t > 286 || ticks[index].ms - lastPointMs < decisionStepMs) continue;
    lastPointMs = ticks[index].ms;
    const sides = {};
    for (const side of ["Up", "Down"]) {
      const ask = askOf(ticks[index], side);
      if (!(ask >= .01 && ask <= .99)) continue;
      const base = capFeatureAt({ feed, ticks, index, side, cap: ask, executableSinceMs: ticks[index].ms });
      if (base) sides[side] = { ask, baseLogit: logit(base.vector) };
    }
    if (Object.keys(sides).length) points.push({ tick: ticks[index], sides });
  }
  for (const policy of policies) {
    const state = { used: new Map(), lastFireMs: -Infinity };
    for (const point of points) {
      if (point.tick.ms - state.lastFireMs < policy.cooldownMs) continue;
      const candidates = [];
      for (const side of ["Up", "Down"]) {
        const base = point.sides[side];
        if (!base) continue;
        const cap = nextCap(state.used, side, base.ask, policy.maxCellUses);
        if (cap == null) continue;
        const headroom = cap - base.ask;
        const adjustedLogit = base.baseLogit + coeff[capIndex] * headroom
          + coeff[headroomIndex] * headroom + (headroom > .005 ? -coeff[exactIndex] : 0);
        candidates.push({ side, cap, score: logistic(adjustedLogit) });
      }
      candidates.sort((a, b) => b.score - a.score || a.cap - b.cap || a.side.localeCompare(b.side));
      const chosen = candidates[0];
      if (!chosen || chosen.score < policy.threshold) continue;
      const cents = Math.round(chosen.cap * 100), cell = `${chosen.side}:${cents}`;
      state.used.set(cell, (state.used.get(cell) || 0) + 1);
      state.lastFireMs = point.tick.ms;
      policy.generated[segmentFor(point.tick.ms)].push({ slug, fireMs: point.tick.ms,
        side: chosen.side, cap: chosen.cap, score: chosen.score });
    }
  }
  if ((marketIndex + 1) % 100 === 0 || marketIndex + 1 === usableSlugs.length) {
    console.log(JSON.stringify({ phase: "replay", done: marketIndex + 1, total: usableSlugs.length }));
  }
}

function metrics(generated, actual) {
  const targetsBySlug = new Map();
  for (const row of actual) {
    const rows = targetsBySlug.get(row.slug) || [];
    rows.push(row); targetsBySlug.set(row.slug, rows);
  }
  const used = new Set();
  let timingMatches = 0, sideMatches = 0, capMatches = 0, absoluteTimingMs = 0;
  for (const row of generated) {
    const candidates = (targetsBySlug.get(row.slug) || []).map((target, index) => ({ target, index,
      delta: Math.abs(target.fireMs - row.fireMs) })).filter((item) => item.delta <= 2_000
      && !used.has(`${row.slug}:${item.index}`)).sort((a, b) => a.delta - b.delta);
    const closest = candidates[0];
    if (!closest) continue;
    timingMatches++; absoluteTimingMs += closest.delta; used.add(`${row.slug}:${closest.index}`);
    if (closest.target.outcome === row.side) {
      sideMatches++;
      const caps = closest.target.orderHashes.map((hash) => exact.orders.find((order) => order.orderHash === hash)?.limitPrice)
        .filter(finite).map(Number);
      if (caps.some((cap) => Math.abs(cap - row.cap) < .005)) capMatches++;
    }
  }
  const precision = timingMatches / Math.max(1, generated.length), recall = timingMatches / Math.max(1, actual.length);
  return { generated: generated.length, target: actual.length, timingMatches,
    timingPrecisionPct: round(100 * precision, 3), timingRecallPct: round(100 * recall, 3),
    timingF1Pct: round(100 * 2 * precision * recall / Math.max(1e-9, precision + recall), 3),
    meanAbsoluteTimingMs: timingMatches ? round(absoluteTimingMs / timingMatches, 1) : null,
    sideAccuracyWithinTimingPct: timingMatches ? round(100 * sideMatches / timingMatches, 3) : null,
    exactCapWithinSideTimingPct: sideMatches ? round(100 * capMatches / sideMatches, 3) : null };
}
const rows = policies.map((policy) => ({ config: { id: policy.id, threshold: policy.threshold,
  cooldownMs: policy.cooldownMs, maxCellUses: policy.maxCellUses },
  train: metrics(policy.generated.train, target.train),
  validation: metrics(policy.generated.validation, target.validation),
  holdout: metrics(policy.generated.holdout, target.holdout) }));
const selected = [...rows].sort((a, b) => b.validation.timingF1Pct - a.validation.timingF1Pct
  || b.validation.sideAccuracyWithinTimingPct - a.validation.sideAccuracyWithinTimingPct)[0];
const report = { schema: 1, generatedAt: new Date().toISOString(), definition: fitted.definition,
  causality: { decisionStepMs, targetMatchToleranceMs: 2_000, modelDir,
    selection: frozenEvaluation ? "frozen discovery policy; no OOS tuning"
      : "maximum validation timing F1; holdout excluded from model and policy selection" },
  policies: rows.length, selected, topValidation: [...rows].sort((a, b) => b.validation.timingF1Pct - a.validation.timingF1Pct).slice(0, 20), rows };
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, policies: rows.length, selected }, null, 2));
