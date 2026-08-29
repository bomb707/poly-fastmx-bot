#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const reportDir = path.join(root, "research/wallet-75cc/results");
fs.mkdirSync(reportDir, { recursive: true });
const samplesFile = path.join(dataDir, "fire-gate-samples-consensus-btc-aug16-25-decision520-controls.ndjson.gz");
const externalFile = path.join(dataDir, "fire-gate-samples-v2-btc-aug26-untouched-decision520.json.gz");
const outputFile = path.join(reportDir, "release-signal-search-btc-aug16-26-decision520.json");
const outputMd = path.join(reportDir, "release-signal-search-btc-aug16-26-decision520.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");
const nativeV2Start = 1787388900 * 1000;
const nativeFitEnd = Date.parse("2026-08-24T00:00:00Z");
const nativeValidationEnd = Date.parse("2026-08-25T00:00:00Z");
const ignored = new Set(["kind", "slug", "ms", "fillMs", "side", "label", "role", "contains90", "containsLarge", "observationAgeMs"]);
const inventoryFields = new Set(["orientedInventory", "absoluteInventory", "isHedge", "fifoPairCost", "sinceLastFireS", "sinceSameSideFireS"]);

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
function hash(text) {
  let output = 2166136261;
  for (let index = 0; index < text.length; index++) output = Math.imul(output ^ text.charCodeAt(index), 16777619);
  return output >>> 0;
}
async function* readNdjson(file) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}
function rawVector(row, fields) {
  return Float64Array.from(fields, (field) => finite(row[field]) ? Number(row[field]) : NaN);
}
function scaler(rows, fields) {
  const means = new Float64Array(fields.length), counts = new Uint32Array(fields.length);
  for (const sample of rows) for (let field = 0; field < fields.length; field++) {
    const number = sample.x[field];
    if (Number.isFinite(number)) { means[field] += number; counts[field]++; }
  }
  for (let field = 0; field < fields.length; field++) means[field] /= Math.max(1, counts[field]);
  const variances = new Float64Array(fields.length);
  for (const sample of rows) for (let field = 0; field < fields.length; field++) {
    const number = sample.x[field];
    if (Number.isFinite(number)) variances[field] += (number - means[field]) ** 2;
  }
  const divisors = Float64Array.from(variances, (variance, field) => Math.max(1e-9, Math.sqrt(variance / Math.max(1, counts[field]))));
  return { means, divisors };
}
function standardizedValue(x, field, scale) {
  return Number.isFinite(x[field]) ? Math.max(-8, Math.min(8, (x[field] - scale.means[field]) / scale.divisors[field])) : 0;
}
function sigmoid(score) {
  if (score >= 0) return 1 / (1 + Math.exp(-Math.min(40, score)));
  const exp = Math.exp(Math.max(-40, score));
  return exp / (1 + exp);
}
function shuffle(values, seed) {
  let state = seed | 0;
  function random() {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
}
function fitLogistic(rows, fields, { epochs = 24, learningRate = .018, l2 = .001 } = {}) {
  const scale = scaler(rows, fields), weights = new Float64Array(fields.length);
  let intercept = 0;
  const positives = rows.filter((row) => row.label).length, negatives = rows.length - positives;
  const positiveWeight = negatives / Math.max(1, positives), order = Array.from({ length: rows.length }, (_, index) => index);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(order, 7500 + epoch);
    const rate = learningRate / Math.sqrt(1 + epoch * .35);
    for (const rowIndex of order) {
      const sample = rows[rowIndex];
      let score = intercept;
      for (let field = 0; field < fields.length; field++) score += weights[field] * standardizedValue(sample.x, field, scale);
      const importance = sample.label ? positiveWeight : 1;
      const error = (sigmoid(score) - sample.label) * importance;
      intercept -= rate * error;
      for (let field = 0; field < fields.length; field++) {
        weights[field] -= rate * (error * standardizedValue(sample.x, field, scale) + l2 * weights[field]);
      }
      step++;
    }
  }
  return { fields, scale, weights, intercept, positiveWeight, trainingRows: rows.length };
}
function score(model, row) {
  const x = rawVector(row, model.fields);
  let output = model.intercept;
  for (let field = 0; field < model.fields.length; field++) output += model.weights[field] * standardizedValue(x, field, model.scale);
  return output;
}
function auc(rows) {
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const positives = sorted.filter((row) => row.label).length, negatives = sorted.length - positives;
  if (!positives || !negatives) return null;
  let rankSum = 0;
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score) end++;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (sorted[cursor].label) rankSum += averageRank;
    index = end;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}
function chooseThreshold(rows, targetPrecision = .9) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  let positives = 0, best = null;
  const allPositives = sorted.filter((row) => row.label).length;
  for (let index = 0; index < sorted.length; index++) {
    positives += sorted[index].label;
    const nextTie = sorted[index + 1] && sorted[index + 1].score === sorted[index].score;
    if (!nextTie && positives / (index + 1) >= targetPrecision) {
      best = { threshold: sorted[index].score, selected: index + 1, precision: positives / (index + 1), recall: positives / Math.max(1, allPositives) };
    }
  }
  return best;
}
function metrics(rows, threshold) {
  const selected = rows.filter((row) => row.score >= threshold), positives = rows.filter((row) => row.label).length;
  const truePositive = selected.filter((row) => row.label).length;
  return {
    rows: rows.length,
    positives,
    controls: rows.length - positives,
    selected: selected.length,
    truePositive,
    falsePositive: selected.length - truePositive,
    precision: selected.length ? round(truePositive / selected.length) : null,
    recall: round(truePositive / Math.max(1, positives)),
    falsePositiveRate: round((selected.length - truePositive) / Math.max(1, rows.length - positives), 8),
  };
}
function precisionFrontier(rows) {
  const sorted = [...rows].sort((a, b) => b.score - a.score), totalPositives = sorted.filter((row) => row.label).length;
  let positives = 0;
  const requested = new Set([10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000].filter((count) => count <= sorted.length));
  const at = [], bestByMinimum = { 10: null, 50: null, 100: null, 500: null };
  for (let index = 0; index < sorted.length; index++) {
    positives += sorted[index].label;
    const selected = index + 1, precision = positives / selected;
    if (requested.has(selected)) at.push({ selected, precision: round(precision), recall: round(positives / Math.max(1, totalPositives)) });
    for (const minimum of [10, 50, 100, 500]) {
      if (selected >= minimum && (!bestByMinimum[minimum] || precision > bestByMinimum[minimum].precision)) {
        bestByMinimum[minimum] = { selected, precision, recall: positives / Math.max(1, totalPositives), threshold: sorted[index].score };
      }
    }
  }
  return {
    at,
    bestByMinimum: Object.fromEntries(Object.entries(bestByMinimum).map(([minimum, row]) => [minimum, row && {
      selected: row.selected, precision: round(row.precision), recall: round(row.recall), threshold: round(row.threshold, 8),
    }])),
  };
}

if (!fs.existsSync(samplesFile)) throw new Error(`missing ${samplesFile}`);
let allFields = null;
const fitRaw = [];
const nativeFitRaw = [];
let observed = { positives: 0, controls: 0, sampledControls: 0 };
let nativeObserved = { positives: 0, controls: 0, sampledControls: 0 };
for await (const row of readNdjson(samplesFile)) {
  if (row.kind === "meta") continue;
  if (!allFields) allFields = Object.keys(row).filter((field) => !ignored.has(field));
  const label = row.kind === "positive" ? 1 : 0;
  const sampled = label || hash(`${row.slug}:${row.ms}:${row.side}`) % 20 === 0;
  if (row.ms < fitEnd) {
    if (label) observed.positives++; else observed.controls++;
    if (sampled) {
      if (!label) observed.sampledControls++;
      fitRaw.push({ label, row });
    }
  }
  if (row.ms >= nativeV2Start && row.ms < nativeFitEnd) {
    if (label) nativeObserved.positives++; else nativeObserved.controls++;
    if (sampled) {
      if (!label) nativeObserved.sampledControls++;
      nativeFitRaw.push({ label, row });
    }
  }
}
const marketFields = allFields.filter((field) => !inventoryFields.has(field));
const fullFields = allFields;
const models = {
  marketOnly: fitLogistic(fitRaw.map((sample) => ({ label: sample.label, x: rawVector(sample.row, marketFields) })), marketFields),
  inventoryAware: fitLogistic(fitRaw.map((sample) => ({ label: sample.label, x: rawVector(sample.row, fullFields) })), fullFields),
  nativeForwardMarketOnly: fitLogistic(nativeFitRaw.map((sample) => ({ label: sample.label, x: rawVector(sample.row, marketFields) })), marketFields),
};

const scored = Object.fromEntries(Object.keys(models).map((name) => [name, { validation: [], holdout: [] }]));
for await (const row of readNdjson(samplesFile)) {
  if (row.kind === "meta") continue;
  const label = row.kind === "positive" ? 1 : 0;
  for (const [name, model] of Object.entries(models)) {
    const isNative = name === "nativeForwardMarketOnly";
    const validationStart = isNative ? nativeFitEnd : fitEnd;
    const splitEnd = isNative ? nativeValidationEnd : validationEnd;
    if (row.ms < validationStart) continue;
    const split = row.ms < splitEnd ? "validation" : "holdout";
    scored[name][split].push({ label, score: score(model, row), ms: row.ms });
  }
}
const external = JSON.parse(zlib.gunzipSync(fs.readFileSync(externalFile)));
const externalRows = [...external.positives.map((row) => ({ ...row, kind: "positive" })), ...external.controls.map((row) => ({ ...row, kind: "control" }))];
const results = {};
for (const [name, model] of Object.entries(models)) {
  const externalScores = externalRows.map((row) => ({ label: row.kind === "positive" ? 1 : 0, score: score(model, row) }));
  const threshold = chooseThreshold(scored[name].validation, .9);
  const coefficients = model.fields.map((field, index) => ({
    field,
    standardizedWeight: round(model.weights[index], 8),
    candidateCoefficient: round(model.weights[index] / model.scale.divisors[index], 8),
  })).sort((a, b) => Math.abs(b.standardizedWeight) - Math.abs(a.standardizedWeight));
  results[name] = {
    validationAuc: round(auc(scored[name].validation)),
    holdoutAuc: round(auc(scored[name].holdout)),
    externalAug26Auc: round(auc(externalScores)),
    validationCounts: { rows: scored[name].validation.length, positives: scored[name].validation.filter((row) => row.label).length },
    holdoutCounts: { rows: scored[name].holdout.length, positives: scored[name].holdout.filter((row) => row.label).length },
    externalAug26Counts: { rows: externalScores.length, positives: externalScores.filter((row) => row.label).length },
    validationPrecisionFrontier: precisionFrontier(scored[name].validation),
    holdoutPrecisionFrontier: precisionFrontier(scored[name].holdout),
    externalAug26PrecisionFrontier: precisionFrontier(externalScores),
    validationNinetyThreshold: threshold && { threshold: round(threshold.threshold, 8), precision: round(threshold.precision), recall: round(threshold.recall) },
    validation: threshold && metrics(scored[name].validation, threshold.threshold),
    holdout: threshold && metrics(scored[name].holdout, threshold.threshold),
    externalAug26: threshold && metrics(externalScores, threshold.threshold),
    topCoefficients: coefficients.slice(0, 20),
  };
}
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  timing: "public features at inferred match minus 520ms; one-second two-side no-fire controls; no conditioning on target private cap or signed order",
  training: {
    backfill: { fitBefore: new Date(fitEnd).toISOString(), validate: "2026-08-21", holdout: "2026-08-22 through 2026-08-25", ...observed, sampledRows: fitRaw.length },
    nativeForward: { starts: new Date(nativeV2Start).toISOString(), fitBefore: new Date(nativeFitEnd).toISOString(), validate: "2026-08-24", holdout: "2026-08-25", ...nativeObserved, sampledRows: nativeFitRaw.length },
    external: "2026-08-26",
  },
  fields: { marketOnly: marketFields, inventoryAware: fullFields },
  results,
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
const pct = (value) => value == null ? "n/a" : `${round(value * 100, 3)}%`;
const md = `# Public-feed release-signal search — BTC 5m\n\n` +
  `Unlike the private-cap hazard model, this test scans both sides once per second and does not know the wallet's signed order or limit price. The 90% threshold is selected on Aug 21 and frozen.\n\n` +
  Object.entries(results).map(([name, result]) => `- ${name}: holdout AUC ${result.holdoutAuc}; at the validation-selected cutoff, holdout precision ${pct(result.holdout?.precision)}, recall ${pct(result.holdout?.recall)}; Aug 26 precision ${pct(result.externalAug26?.precision)}, recall ${pct(result.externalAug26?.recall)}.`).join("\n") + "\n";
fs.writeFileSync(outputMd, md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
