#!/usr/bin/env node
// Fit the wallet's observable side/cap release preference without signed-order
// construction timestamps, target inventory, prior target actions, or future
// book data. This is an imitation model, not a claim about private source code.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CAP_FEATURE_NAMES, capFeatureAt, indexAtOrBefore, normalizeTick,
  scoreStandardizedLogistic } from "./weekly-parity-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const cohortDir = path.resolve(process.argv[2]
  || path.join(root, "data/wallet-75cc/exact-2026-08-20_2026-08-27"));
const cacheDir = path.resolve(process.argv[3] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[4] || path.join(cohortDir, "observable-cap-policy-model.json"));
const fireFile = path.join(cohortDir, "exact-fire-dataset.json.gz");
const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(fireFile)));
const orders = new Map(payload.orders.map((row) => [row.orderHash, row]));
const actionsBySlug = new Map();
for (const action of payload.actions) {
  if (action.confidence === "low") continue;
  const rows = actionsBySlug.get(action.slug) || [];
  rows.push(action);
  actionsBySlug.set(action.slug, rows);
}
const featureNames = CAP_FEATURE_NAMES;
const excluded = new Set(["executableRunLog", "sinceLastFireLog", "sinceSameSideFireLog",
  "absoluteInventoryLog", "orientedInventory", "oppositeInventory"]);
const active = featureNames.map((name, index) => excluded.has(name) ? -1 : index).filter((index) => index >= 0);
const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const sideAsk = (tick, side) => Number((side === "Up" ? tick?.up : tick?.down)?.asks?.[0]?.price);
const ceilCent = (price) => Math.ceil((price - 1e-10) * 100) / 100;
const capFor = (action) => Math.max(...action.orderHashes.map((hash) => Number(orders.get(hash)?.limitPrice)).filter(finite));
const segmentFor = (ms) => ms < Date.parse("2026-08-25T00:00:00Z") ? "train"
  : ms < Date.parse("2026-08-26T00:00:00Z") ? "validation" : "holdout";
const feedFile = (slug) => path.join(cacheDir, `${slug}_v2-l2-120-coherent.json.gz`);
const startMsFromSlug = (slug) => Number(slug.split("-").at(-1)) * 1_000;
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

function feature(feed, ticks, index, side, cap) {
  return capFeatureAt({ feed, ticks, index, side, cap, executableSinceMs: ticks[index].ms })?.vector || null;
}

const groups = [];
let processed = 0;
for (const [slug, marketActions] of actionsBySlug) {
  const file = feedFile(slug);
  if (!fs.existsSync(file)) continue;
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  feed.slug ||= slug;
  feed.windowStart = startMsFromSlug(slug);
  const ticks = (feed.ticks || []).map(normalizeTick);
  for (const action of marketActions.sort((a, b) => a.fireMs - b.fireMs)) {
    const cap = capFor(action), index = indexAtOrBefore(ticks, action.intervalStartMs);
    if (!(cap > 0) || index < 0 || sideAsk(ticks[index], action.outcome) > cap + 1e-9) continue;
    const positive = feature(feed, ticks, index, action.outcome, cap);
    if (!positive) continue;
    const controls = [];
    // Earlier executable snapshots answer "why release now?" without using the
    // wallet's unavailable order-construction timestamp.
    let lastChosenMs = Infinity;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const tick = ticks[cursor];
      if (action.intervalStartMs - tick.ms > 30_000) break;
      if (lastChosenMs - tick.ms < 900 || sideAsk(tick, action.outcome) > cap + 1e-9) continue;
      const vector = feature(feed, ticks, cursor, action.outcome, cap);
      if (vector) controls.push({ kind: "earlier", ms: tick.ms, vector });
      lastChosenMs = tick.ms;
    }
    // Side and neighboring cap cells answer "why this member of the menu?".
    for (const side of [action.outcome === "Up" ? "Down" : "Up"]) {
      const ask = sideAsk(ticks[index], side), otherCap = ceilCent(ask);
      const vector = ask > 0 && otherCap <= .99 ? feature(feed, ticks, index, side, otherCap) : null;
      if (vector) controls.push({ kind: "opposite", ms: ticks[index].ms, vector });
    }
    for (const delta of [-.03, -.01, .01, .03]) {
      const candidate = round(cap + delta, 2), ask = sideAsk(ticks[index], action.outcome);
      if (candidate >= ask - 1e-9 && candidate >= .01 && candidate <= .99) {
        const vector = feature(feed, ticks, index, action.outcome, candidate);
        if (vector) controls.push({ kind: "neighbor-cap", ms: ticks[index].ms, vector });
      }
    }
    if (controls.length) groups.push({ slug, fireMs: action.fireMs, segment: segmentFor(action.fireMs),
      side: action.outcome, cap, confidence: action.confidence, positive, controls });
  }
  processed++;
  if (processed % 150 === 0) console.log(JSON.stringify({ phase: "dataset", processed, total: actionsBySlug.size, groups: groups.length }));
}

function normalization(train) {
  const mean = new Array(featureNames.length).fill(0), variance = new Array(featureNames.length).fill(0);
  let count = 0;
  for (const group of train) {
    const rows = [{ vector: group.positive, weight: .5 },
      ...group.controls.map((row) => ({ vector: row.vector, weight: .5 / group.controls.length }))];
    for (const row of rows) {
      count += row.weight;
      for (const index of active) mean[index] += row.weight * row.vector[index];
    }
  }
  for (const index of active) mean[index] /= Math.max(1e-9, count);
  for (const group of train) {
    const rows = [{ vector: group.positive, weight: .5 },
      ...group.controls.map((row) => ({ vector: row.vector, weight: .5 / group.controls.length }))];
    for (const row of rows) for (const index of active) {
      const delta = row.vector[index] - mean[index];
      variance[index] += row.weight * delta * delta;
    }
  }
  const scale = variance.map((value, index) => active.includes(index)
    ? Math.max(1e-8, Math.sqrt(value / Math.max(1e-9, count))) : 1);
  return { count, mean, scale };
}

function standardized(vector, norm, index) {
  return Math.max(-12, Math.min(12, (vector[index] - norm.mean[index]) / norm.scale[index]));
}

function fit(train, epochs = 28) {
  const norm = normalization(train), weights = new Array(featureNames.length).fill(0);
  const m = new Array(featureNames.length + 1).fill(0), v = new Array(featureNames.length + 1).fill(0);
  let intercept = 0, step = 0;
  const order = train.map((_, index) => index);
  for (let epoch = 0; epoch < epochs; epoch++) {
    // Deterministic affine permutation avoids training-order/date artifacts.
    order.sort((a, b) => hash(`${epoch}:${train[a].slug}:${train[a].fireMs}`).localeCompare(hash(`${epoch}:${train[b].slug}:${train[b].fireMs}`)));
    const rate = .012 * Math.pow(.92, epoch);
    for (const groupIndex of order) {
      const group = train[groupIndex], rows = [{ vector: group.positive, label: 1, weight: .5 },
        ...group.controls.map((row) => ({ vector: row.vector, label: 0, weight: .5 / group.controls.length }))];
      let gi = 0; const gw = new Array(featureNames.length).fill(0);
      for (const row of rows) {
        let logit = intercept;
        for (const index of active) logit += weights[index] * standardized(row.vector, norm, index);
        const probability = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
        const error = (probability - row.label) * row.weight;
        gi += error;
        for (const index of active) gw[index] += error * standardized(row.vector, norm, index);
      }
      step++;
      const update = (slot, gradient) => {
        m[slot] = .9 * m[slot] + .1 * gradient;
        v[slot] = .999 * v[slot] + .001 * gradient * gradient;
        return rate * (m[slot] / (1 - .9 ** step)) / (Math.sqrt(v[slot] / (1 - .999 ** step)) + 1e-8);
      };
      intercept -= update(0, gi);
      for (const index of active) weights[index] -= update(index + 1, gw[index] + 2e-4 * weights[index]);
    }
    console.log(JSON.stringify({ phase: "fit", epoch: epoch + 1, epochs }));
  }
  return { type: "standardized-logistic-v1", featureNames, normalization: norm, intercept, weights,
    excluded: [...excluded], trainingGroups: train.length };
}

function rankMetrics(model, rows) {
  let top1 = 0, reciprocal = 0, pairWins = 0, pairTies = 0, pairs = 0;
  for (const group of rows) {
    const positive = scoreStandardizedLogistic(model, group.positive);
    const controls = group.controls.map((row) => scoreStandardizedLogistic(model, row.vector));
    const rank = 1 + controls.filter((score) => score > positive + 1e-12).length
      + .5 * controls.filter((score) => Math.abs(score - positive) <= 1e-12).length;
    if (rank <= 1) top1++;
    reciprocal += 1 / rank;
    for (const score of controls) {
      pairs++;
      if (positive > score + 1e-12) pairWins++;
      else if (Math.abs(positive - score) <= 1e-12) pairTies++;
    }
  }
  return { groups: rows.length, pairAuc: round((pairWins + .5 * pairTies) / Math.max(1, pairs), 6),
    top1Pct: round(100 * top1 / Math.max(1, rows.length), 3),
    meanReciprocalRank: round(reciprocal / Math.max(1, rows.length), 6) };
}

const train = groups.filter((group) => group.segment === "train");
const model = fit(train);
const report = {
  schema: 1, generatedAt: new Date().toISOString(),
  definition: "Observable two-sided cap-menu preference; no signed construction time, target inventory/action history, or future state.",
  discovery: payload.summary.range, source: path.resolve(fireFile), sourceSha256: hash(fs.readFileSync(fireFile)),
  exclusions: [...excluded], model,
  metrics: Object.fromEntries(["train", "validation", "holdout"].map((segment) =>
    [segment, rankMetrics(model, groups.filter((group) => group.segment === segment))])),
  data: { groups: groups.length, bySegment: Object.fromEntries(["train", "validation", "holdout"].map((segment) =>
    [segment, groups.filter((group) => group.segment === segment).length])) },
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputFile.replace(/\.json$/i, "-dataset.json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1,
  definition: report.definition, featureNames, groups }), { level: 9 }));
console.log(JSON.stringify({ outputFile, data: report.data, metrics: report.metrics }, null, 2));
