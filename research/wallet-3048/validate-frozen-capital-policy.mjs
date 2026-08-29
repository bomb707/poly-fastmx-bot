#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const modelDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const sampleDir = path.resolve(process.argv[3] || path.join(root, "data/wallet-3048-r2"));
const scaleChangeStart = Date.parse(process.argv[4] || "2026-08-23T06:15:00Z");
const scaleChangeEnd = Date.parse(process.argv[5] || "2026-08-23T07:00:00Z");
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;

const fireModel = JSON.parse(fs.readFileSync(path.join(modelDir, "fire-gate-tree.json"), "utf8")).models.all.tree;
const sizeModel = JSON.parse(fs.readFileSync(path.join(modelDir, "fire-gate-tree.json"), "utf8")).models.size90.tree;
const hazardModel = JSON.parse(fs.readFileSync(path.join(modelDir, "order-hazard-analysis.json"), "utf8")).tree.root;
const structuralModel = JSON.parse(fs.readFileSync(path.join(modelDir, "order-hazard-analysis.json"), "utf8")).structuralTree.root;
const sideModel = JSON.parse(fs.readFileSync(path.join(modelDir, "side-choice-analysis.json"), "utf8")).marketOnlyTree.root;
const fireSamples = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sampleDir, "fire-gate-samples.json.gz"))));
const hazardGroups = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sampleDir, "order-hazard-samples.json.gz")))).groups;
const sidePairs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sampleDir, "side-choice-samples.json.gz")))).pairs;

function rootNode(model) { return model?.root || model?.tree?.root || model; }
function predict(model, row) {
  let node = rootNode(model);
  while (node?.field) node = Number(row[node.field]) <= Number(node.threshold) ? node.left : node.right;
  return Number(node?.balancedPositiveRate ?? node?.positiveRate);
}

function rankAuc(rows, model, adapt = false) {
  const ranked = rows.map((row) => ({ label: Number(row.label), score: predict(model, adapt ? normalizeCapital(row) : row) }))
    .filter((row) => Number.isFinite(row.score)).sort((a, b) => a.score - b.score);
  const positives = ranked.filter((row) => row.label).length, negatives = ranked.length - positives;
  if (!positives || !negatives) return null;
  let rankSum = 0;
  for (let index = 0; index < ranked.length;) {
    let end = index + 1;
    while (end < ranked.length && ranked[end].score === ranked[index].score) end++;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (ranked[cursor].label) rankSum += averageRank;
    index = end;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function matchedAuc(groups, model, adapt = false) {
  let score = 0, comparisons = 0;
  for (const group of groups) {
    const positive = predict(model, adapt ? normalizeCapital(group.positive) : group.positive);
    for (const control of group.controls) {
      const negative = predict(model, adapt ? normalizeCapital(control) : control);
      if (!Number.isFinite(positive) || !Number.isFinite(negative)) continue;
      score += positive > negative ? 1 : positive === negative ? .5 : 0;
      comparisons++;
    }
  }
  return comparisons ? score / comparisons : null;
}

function pairedAuc(pairs, model, adapt = false) {
  let score = 0, comparisons = 0;
  for (const pair of pairs) {
    const chosen = predict(model, adapt ? normalizeCapital(pair.chosen) : pair.chosen);
    const rejected = predict(model, adapt ? normalizeCapital(pair.rejected) : pair.rejected);
    if (!Number.isFinite(chosen) || !Number.isFinite(rejected)) continue;
    score += chosen > rejected ? 1 : chosen === rejected ? .5 : 0;
    comparisons++;
  }
  return comparisons ? score / comparisons : null;
}

function qAt(ms) {
  if (ms < scaleChangeStart) return 30;
  if (ms >= scaleChangeEnd) return 25;
  return null;
}

// The original frozen trees learned inventory in 30-share units. Only inventory
// is rescaled; price, feed and public CLOB-liquidity features remain untouched.
function normalizeCapital(row) {
  const q = qAt(Number(row.ms));
  if (!q || q === 30) return row;
  const factor = 30 / q;
  return {
    ...row,
    orientedInventory: Number.isFinite(Number(row.orientedInventory)) ? Number(row.orientedInventory) * factor : row.orientedInventory,
    absoluteInventory: Number.isFinite(Number(row.absoluteInventory)) ? Number(row.absoluteInventory) * factor : row.absoluteInventory,
  };
}

const regimes = [
  { name: "q30_prechange", from: -Infinity, to: scaleChangeStart, q: 30 },
  { name: "transition_excluded", from: scaleChangeStart, to: scaleChangeEnd, q: null },
  { name: "q25_postchange", from: scaleChangeEnd, to: Infinity, q: 25 },
];

function subsetRows(rows, regime) { return rows.filter((row) => Number(row.ms) >= regime.from && Number(row.ms) < regime.to); }
function subsetGroups(groups, regime) { return groups.filter((row) => Number(row.positive.ms) >= regime.from && Number(row.positive.ms) < regime.to); }
function subsetPairs(pairs, regime) { return pairs.filter((row) => Number(row.ms) >= regime.from && Number(row.ms) < regime.to); }

function evaluate(regime) {
  const positives = subsetRows(fireSamples.positives, regime), controls = subsetRows(fireSamples.controls, regime);
  const fires = [...positives, ...controls];
  const hazards = subsetGroups(hazardGroups, regime), sides = subsetPairs(sidePairs, regime);
  const sizeRows = positives.map((row) => ({ ...row, label: (regime.q === 30 ? row.contains90 : row.containsLarge) ? 1 : 0 }));
  return {
    q: regime.q,
    samples: {
      firePositives: positives.length,
      fireControls: controls.length,
      hazardActions: hazards.length,
      hazardControls: hazards.reduce((sum, group) => sum + group.controls.length, 0),
      sidePairs: sides.length,
    },
    frozenRaw: {
      fireAuc: round(rankAuc(fires, fireModel)),
      largeBranchAuc: round(rankAuc(sizeRows, sizeModel)),
      hazardMatchedAuc: round(matchedAuc(hazards, hazardModel)),
      structuralHazardMatchedAuc: round(matchedAuc(hazards, structuralModel)),
      marketSidePairedAuc: round(pairedAuc(sides, sideModel)),
    },
    frozenCapitalNormalized: {
      fireAuc: round(rankAuc(fires, fireModel, true)),
      largeBranchAuc: round(rankAuc(sizeRows, sizeModel, true)),
      hazardMatchedAuc: round(matchedAuc(hazards, hazardModel, true)),
      structuralHazardMatchedAuc: round(matchedAuc(hazards, structuralModel, true)),
      marketSidePairedAuc: round(pairedAuc(sides, sideModel, true)),
    },
  };
}

const results = Object.fromEntries(regimes.map((regime) => [regime.name, evaluate(regime)]));
const stable = { name: "stable_combined", from: -Infinity, to: Infinity, q: "30 then 25" };
const stableFireRows = [...fireSamples.positives, ...fireSamples.controls].filter((row) => qAt(Number(row.ms)) != null);
const stableHazards = hazardGroups.filter((group) => qAt(Number(group.positive.ms)) != null);
const stableSides = sidePairs.filter((pair) => qAt(Number(pair.ms)) != null);
const stableSizeRows = stableFireRows.filter((row) => row.label).map((row) => ({ ...row, label: (qAt(Number(row.ms)) === 30 ? row.contains90 : row.containsLarge) ? 1 : 0 }));
results.stable_combined = {
  q: stable.q,
  samples: {
    firePositives: stableFireRows.filter((row) => row.label).length,
    fireControls: stableFireRows.filter((row) => !row.label).length,
    hazardActions: stableHazards.length,
    hazardControls: stableHazards.reduce((sum, group) => sum + group.controls.length, 0),
    sidePairs: stableSides.length,
  },
  frozenRaw: {
    fireAuc: round(rankAuc(stableFireRows, fireModel)),
    largeBranchAuc: round(rankAuc(stableSizeRows, sizeModel)),
    hazardMatchedAuc: round(matchedAuc(stableHazards, hazardModel)),
    structuralHazardMatchedAuc: round(matchedAuc(stableHazards, structuralModel)),
    marketSidePairedAuc: round(pairedAuc(stableSides, sideModel)),
  },
  frozenCapitalNormalized: {
    fireAuc: round(rankAuc(stableFireRows, fireModel, true)),
    largeBranchAuc: round(rankAuc(stableSizeRows, sizeModel, true)),
    hazardMatchedAuc: round(matchedAuc(stableHazards, hazardModel, true)),
    structuralHazardMatchedAuc: round(matchedAuc(stableHazards, structuralModel, true)),
    marketSidePairedAuc: round(pairedAuc(stableSides, sideModel, true)),
  },
};

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  modelTrainingRange: "original E8 data ending 2026-08-22T17:00:00Z",
  testRange: "strictly later data beginning 2026-08-22T17:00:00Z",
  scaleChange: { transitionStart: new Date(scaleChangeStart).toISOString(), stableQ25Start: new Date(scaleChangeEnd).toISOString() },
  note: "capital-normalized evaluation maps inventory/Q back to the old Q=30 units; public price, signal and L2-liquidity features are not rescaled",
  results,
};
fs.writeFileSync(path.join(sampleDir, "frozen-capital-validation.json"), JSON.stringify(report, null, 2) + "\n");
const post = results.q25_postchange, combined = results.stable_combined;
const md = `# Frozen capital-independent policy validation\n\n` +
`The models were frozen on data ending before this sample. At the wallet's Q=25 stable setting, capital-normalized scores are: generic fire AUC ${post.frozenCapitalNormalized.fireAuc}, same-order release AUC ${post.frozenCapitalNormalized.hazardMatchedAuc}, clock-free release AUC ${post.frozenCapitalNormalized.structuralHazardMatchedAuc}, and simultaneous side-choice AUC ${post.frozenCapitalNormalized.marketSidePairedAuc}.\n\n` +
`Across both stable Q=30 and Q=25 periods the corresponding scores are ${combined.frozenCapitalNormalized.fireAuc}, ${combined.frozenCapitalNormalized.hazardMatchedAuc}, ${combined.frozenCapitalNormalized.structuralHazardMatchedAuc}, and ${combined.frozenCapitalNormalized.marketSidePairedAuc}. The 45-minute live reconfiguration transition is reported separately and excluded from the stable aggregate.\n`;
fs.writeFileSync(path.join(sampleDir, "frozen-capital-validation.md"), md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
