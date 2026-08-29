#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const reportDir = path.join(root, "research/wallet-75cc/results");
fs.mkdirSync(reportDir, { recursive: true });
const sourceFile = path.join(dataDir, "side-choice-samples-consensus-btc-aug16-25-decision520.json.gz");
const externalFile = path.join(dataDir, "side-choice-samples-v2-btc-aug26-untouched-decision520.json.gz");
const outputJson = path.join(reportDir, "match-signal-search-btc-aug16-26-decision520.json");
const outputMd = path.join(reportDir, "match-signal-search-btc-aug16-26-decision520.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");
const nativeV2Start = 1787388900 * 1000;
const nativeFitEnd = Date.parse("2026-08-24T00:00:00Z");
const nativeValidationEnd = Date.parse("2026-08-25T00:00:00Z");

function readGzip(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}
function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
function roleCounts(pairs) {
  return Object.fromEntries(["flat", "entry/topup", "hedge"].map((role) => [role, pairs.filter((pair) => pair.role === role).length]));
}

const pairs = readGzip(sourceFile).pairs;
const externalPairs = fs.existsSync(externalFile) ? readGzip(externalFile).pairs : [];
const fitPairs = pairs.filter((pair) => pair.ms < fitEnd);
const validationPairs = pairs.filter((pair) => pair.ms >= fitEnd && pair.ms < validationEnd);
const developmentPairs = pairs.filter((pair) => pair.ms < validationEnd);
const holdoutPairs = pairs.filter((pair) => pair.ms >= validationEnd);
const ignored = new Set(["id", "slug", "ms", "fillMs", "role", "label", "timeS", "absoluteInventory", "sinceLastFireS"]);
const featureNames = Object.keys(pairs[0].chosen).filter((field) => !ignored.has(field));

function value(row, field) {
  const number = Number(row[field]);
  return Number.isFinite(number) ? number : null;
}
function buildScaler(trainingPairs, fields = featureNames) {
  const scale = {};
  for (const field of fields) {
    const deltas = trainingPairs.map((pair) => {
      const a = value(pair.chosen, field), b = value(pair.rejected, field);
      return a == null || b == null ? null : a - b;
    }).filter(Number.isFinite);
    // A deployable pairwise score must be antisymmetric: score(Up, Down) must
    // equal -score(Down, Up). Never center target-oriented deltas because the
    // centering constant would encode which row was the known chosen row.
    const variance = mean(deltas.map((number) => number ** 2));
    scale[field] = { center: 0, divisor: Math.max(1e-9, Math.sqrt(variance)) };
  }
  return scale;
}
function vector(pair, scaler, fields = featureNames) {
  return fields.map((field) => {
    const a = value(pair.chosen, field), b = value(pair.rejected, field);
    if (a == null || b == null) return 0;
    return Math.max(-8, Math.min(8, ((a - b) - scaler[field].center) / scaler[field].divisor));
  });
}
function sigmoid(score) {
  if (score >= 0) return 1 / (1 + Math.exp(-Math.min(40, score)));
  const exp = Math.exp(Math.max(-40, score));
  return exp / (1 + exp);
}
function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += a[index] * b[index];
  return sum;
}
function fitLogistic(trainingPairs, { l2 = .01, epochs = 500, learningRate = .025, fields = featureNames } = {}) {
  const scaler = buildScaler(trainingPairs, fields);
  const rows = trainingPairs.map((pair) => vector(pair, scaler, fields));
  const weights = Array(fields.length).fill(0);
  const first = Array(fields.length).fill(0), second = Array(fields.length).fill(0);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Array(featureNames.length).fill(0);
    for (const row of rows) {
      const miss = 1 - sigmoid(dot(weights, row));
      for (let field = 0; field < weights.length; field++) gradient[field] -= miss * row[field] / rows.length;
    }
    for (let field = 0; field < weights.length; field++) {
      gradient[field] += l2 * weights[field];
      step++;
      first[field] = .9 * first[field] + .1 * gradient[field];
      second[field] = .999 * second[field] + .001 * gradient[field] ** 2;
      const m = first[field] / (1 - .9 ** (epoch + 1));
      const v = second[field] / (1 - .999 ** (epoch + 1));
      weights[field] -= learningRate * m / (Math.sqrt(v) + 1e-8);
    }
  }
  return { kind: "pairwise-logistic", scaler, fields, weights };
}
function logisticScore(model, pair) {
  return dot(model.weights, vector(pair, model.scaler, model.fields));
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function candidateRows(selectedPairs) {
  return selectedPairs.flatMap((pair, pairIndex) => [
    { pairIndex, label: 1, row: pair.chosen },
    { pairIndex, label: 0, row: pair.rejected },
  ]);
}
function gini(rows) {
  if (!rows.length) return 0;
  const p = rows.reduce((sum, row) => sum + row.label, 0) / rows.length;
  return 2 * p * (1 - p);
}
function fitForest(trainingPairs, { trees = 160, maxDepth = 8, minLeaf = 18, featureTrials = 9, thresholdTrials = 7, seed = 75 } = {}) {
  const random = mulberry32(seed), sourceRows = candidateRows(trainingPairs), forest = [];
  function build(rows, depth) {
    const rate = rows.reduce((sum, row) => sum + row.label, 0) / Math.max(1, rows.length);
    const node = { rate };
    if (depth >= maxDepth || rows.length < minLeaf * 2 || rate < 1e-9 || rate > 1 - 1e-9) return node;
    const parent = gini(rows);
    let best = null;
    for (let trial = 0; trial < featureTrials; trial++) {
      const field = featureNames[Math.floor(random() * featureNames.length)];
      const usable = rows.map((sample) => value(sample.row, field)).filter(Number.isFinite);
      if (usable.length < rows.length * .65) continue;
      for (let thresholdTrial = 0; thresholdTrial < thresholdTrials; thresholdTrial++) {
        const threshold = quantile(usable, .08 + .84 * random());
        const left = [], right = [];
        for (const sample of rows) {
          const number = value(sample.row, field);
          (number == null || number <= threshold ? left : right).push(sample);
        }
        if (left.length < minLeaf || right.length < minLeaf) continue;
        const gain = parent - (left.length * gini(left) + right.length * gini(right)) / rows.length;
        if (!best || gain > best.gain) best = { field, threshold, gain, left, right };
      }
    }
    if (!best || best.gain < 1e-6) return node;
    node.field = best.field; node.threshold = best.threshold;
    node.left = build(best.left, depth + 1); node.right = build(best.right, depth + 1);
    return node;
  }
  for (let treeIndex = 0; treeIndex < trees; treeIndex++) {
    const selectedPairs = [];
    for (let index = 0; index < trainingPairs.length; index++) selectedPairs.push(trainingPairs[Math.floor(random() * trainingPairs.length)]);
    forest.push(build(candidateRows(selectedPairs), 0));
  }
  return { kind: "extra-forest", trees: forest };
}
function treePredict(tree, row) {
  let node = tree;
  while (node.field) {
    const number = value(row, node.field);
    node = number == null || number <= node.threshold ? node.left : node.right;
  }
  return node.rate;
}
function forestScore(model, pair) {
  let chosen = 0, rejected = 0;
  for (const tree of model.trees) {
    chosen += treePredict(tree, pair.chosen);
    rejected += treePredict(tree, pair.rejected);
  }
  return (chosen - rejected) / model.trees.length;
}

function accuracy(selectedPairs, score) {
  if (!selectedPairs.length) return null;
  let wins = 0;
  for (const pair of selectedPairs) {
    const value = score(pair);
    wins += value > 1e-12 ? 1 : Math.abs(value) <= 1e-12 ? .5 : 0;
  }
  return wins / selectedPairs.length;
}
function frontier(selectedPairs, score) {
  const rows = selectedPairs.map((pair) => ({ correct: score(pair) > 0, confidence: Math.abs(score(pair)) }))
    .sort((a, b) => b.confidence - a.confidence);
  const output = [];
  for (const coverage of [.1, .2, .3, .4, .5, .6, .7, .8, .9, 1]) {
    const count = Math.max(1, Math.floor(rows.length * coverage));
    output.push({ coverage: round(count / rows.length), actions: count, accuracy: round(rows.slice(0, count).filter((row) => row.correct).length / count) });
  }
  return output;
}
function byRole(selectedPairs, score) {
  return Object.fromEntries(["flat", "entry/topup", "hedge"].map((role) => {
    const subset = selectedPairs.filter((pair) => pair.role === role);
    return [role, { actions: subset.length, accuracy: round(accuracy(subset, score)) }];
  }));
}
function chooseConfidenceThreshold(selectedPairs, score, targetPrecision = .9) {
  const rows = selectedPairs.map((pair) => ({ correct: score(pair) > 0, confidence: Math.abs(score(pair)) }))
    .sort((a, b) => b.confidence - a.confidence);
  let correct = 0, best = null;
  for (let index = 0; index < rows.length; index++) {
    correct += rows[index].correct ? 1 : 0;
    const nextIsTie = rows[index + 1] && rows[index + 1].confidence === rows[index].confidence;
    if (!nextIsTie && correct / (index + 1) >= targetPrecision) {
      best = { threshold: rows[index].confidence, actions: index + 1, coverage: (index + 1) / rows.length, precision: correct / (index + 1) };
    }
  }
  return best;
}
function thresholdMetrics(selectedPairs, score, threshold) {
  const selected = selectedPairs.map((pair) => ({ score: score(pair) })).filter((row) => Math.abs(row.score) >= threshold);
  return {
    actions: selected.length,
    coverage: round(selected.length / Math.max(1, selectedPairs.length)),
    precision: selected.length ? round(selected.filter((row) => row.score > 0).length / selected.length) : null,
  };
}
function summarize(model, scoreFunction, validationSet = validationPairs, holdoutSet = holdoutPairs, externalSet = externalPairs) {
  const score = (pair) => scoreFunction(model, pair);
  const selected = chooseConfidenceThreshold(validationSet, score, .9);
  return {
    validationAccuracy: round(accuracy(validationSet, score)),
    holdoutAccuracy: round(accuracy(holdoutSet, score)),
    externalAug26Accuracy: round(accuracy(externalSet, score)),
    holdoutByRole: byRole(holdoutSet, score),
    validationNinetyThreshold: selected && { threshold: round(selected.threshold, 8), coverage: round(selected.coverage), precision: round(selected.precision) },
    holdoutAtValidationNinetyThreshold: selected && thresholdMetrics(holdoutSet, score, selected.threshold),
    externalAtValidationNinetyThreshold: selected && thresholdMetrics(externalSet, score, selected.threshold),
    holdoutConfidenceFrontier: frontier(holdoutSet, score),
    externalConfidenceFrontier: frontier(externalSet, score),
  };
}

const logisticCandidates = [];
for (const l2 of [0, .0001, .001, .01, .1, 1]) {
  const model = fitLogistic(fitPairs, { l2 });
  logisticCandidates.push({ l2, model, validationAccuracy: accuracy(validationPairs, (pair) => logisticScore(model, pair)) });
}
logisticCandidates.sort((a, b) => b.validationAccuracy - a.validationAccuracy || a.l2 - b.l2);
const selectedLogisticL2 = logisticCandidates[0].l2;
// Freeze the model selected on Aug 21. The later tests do not influence its
// coefficients, confidence cutoff, or hyperparameters.
const logistic = logisticCandidates[0].model;
const directionInventoryFields = new Set(["orientedInventory", "isHedge", "fifoPairCost", "sinceSameSideFireS"]);
const marketOnlyFields = featureNames.filter((field) => !directionInventoryFields.has(field));
const marketLogisticCandidates = [];
for (const l2 of [0, .0001, .001, .01, .1, 1]) {
  const model = fitLogistic(fitPairs, { l2, fields: marketOnlyFields });
  marketLogisticCandidates.push({ l2, model, validationAccuracy: accuracy(validationPairs, (pair) => logisticScore(model, pair)) });
}
marketLogisticCandidates.sort((a, b) => b.validationAccuracy - a.validationAccuracy || a.l2 - b.l2);
const marketLogistic = marketLogisticCandidates[0].model;
const nativeFitPairs = pairs.filter((pair) => pair.ms >= nativeV2Start && pair.ms < nativeFitEnd);
const nativeValidationPairs = pairs.filter((pair) => pair.ms >= nativeFitEnd && pair.ms < nativeValidationEnd);
const nativeHoldoutPairs = pairs.filter((pair) => pair.ms >= nativeValidationEnd);
const nativeMarketCandidates = [];
for (const l2 of [0, .0001, .001, .01, .1, 1]) {
  const model = fitLogistic(nativeFitPairs, { l2, fields: marketOnlyFields });
  nativeMarketCandidates.push({ l2, model, validationAccuracy: accuracy(nativeValidationPairs, (pair) => logisticScore(model, pair)) });
}
nativeMarketCandidates.sort((a, b) => b.validationAccuracy - a.validationAccuracy || a.l2 - b.l2);
const nativeMarketLogistic = nativeMarketCandidates[0].model;

const forestCandidates = [];
for (const config of [
  { trees: 36, maxDepth: 5, minLeaf: 40, featureTrials: 7, thresholdTrials: 5 },
  { trees: 42, maxDepth: 7, minLeaf: 24, featureTrials: 8, thresholdTrials: 5 },
  { trees: 48, maxDepth: 9, minLeaf: 14, featureTrials: 8, thresholdTrials: 6 },
]) {
  const model = fitForest(fitPairs, config);
  forestCandidates.push({ config, model, validationAccuracy: accuracy(validationPairs, (pair) => forestScore(model, pair)) });
}
forestCandidates.sort((a, b) => b.validationAccuracy - a.validationAccuracy || a.config.maxDepth - b.config.maxDepth);
const selectedForestConfig = forestCandidates[0].config;
const forest = forestCandidates[0].model;

const logisticSummary = summarize(logistic, logisticScore);
const marketLogisticSummary = summarize(marketLogistic, logisticScore);
const nativeMarketLogisticSummary = summarize(nativeMarketLogistic, logisticScore, nativeValidationPairs, nativeHoldoutPairs, externalPairs);
const forestSummary = summarize(forest, forestScore);
logisticSummary.validationAccuracy = round(logisticCandidates.find((row) => row.l2 === selectedLogisticL2).validationAccuracy);
marketLogisticSummary.validationAccuracy = round(marketLogisticCandidates[0].validationAccuracy);
forestSummary.validationAccuracy = round(forestCandidates.find((row) => row.config === selectedForestConfig).validationAccuracy);
const ablationDefinitions = {
  clobPrice: featureNames.filter((field) => field === "ask" || field === "spread" || field.startsWith("sideAsk") || field.startsWith("sideBid")),
  orderBook: featureNames.filter((field) => /Depth|Imbalance|microprice/i.test(field)),
  binance: featureNames.filter((field) => field.startsWith("bz")),
  chainlink: featureNames.filter((field) => field.startsWith("cl")),
  externalPrice: featureNames.filter((field) => field.startsWith("bz") || field.startsWith("cl")),
  inventory: featureNames.filter((field) => ["orientedInventory", "isHedge", "fifoPairCost", "sinceSameSideFireS"].includes(field)),
};
const ablations = Object.fromEntries(Object.entries(ablationDefinitions).map(([name, fields]) => {
  const model = fitLogistic(fitPairs, { l2: selectedLogisticL2, fields });
  return [name, {
    fields,
    validationAccuracy: round(accuracy(validationPairs, (pair) => logisticScore(model, pair))),
    holdoutAccuracy: round(accuracy(holdoutPairs, (pair) => logisticScore(model, pair))),
    externalAug26Accuracy: round(accuracy(externalPairs, (pair) => logisticScore(model, pair))),
  }];
}));
const logisticCoefficients = logistic.fields.map((field, index) => ({
  field,
  standardizedWeight: round(logistic.weights[index], 8),
  candidateCoefficient: round(logistic.weights[index] / logistic.scaler[field].divisor, 8),
})).sort((a, b) => Math.abs(b.standardizedWeight) - Math.abs(a.standardizedWeight));
function serializePairwiseModel(model, summary, trainedBefore = fitEnd, confidenceCalibratedOn = "2026-08-21") {
  return {
    trainedBefore: new Date(trainedBefore).toISOString(),
    confidenceCalibratedOn,
    formula: "score(side)=sum(weight[field]*feature(side)/divisor[field]); choose Up if score(Up)-score(Down)>0; emit only when abs(score(Up)-score(Down))>=threshold",
    threshold: summary.validationNinetyThreshold?.threshold ?? null,
    fields: model.fields.map((field, index) => ({
      field,
      divisor: round(model.scaler[field].divisor, 12),
      weight: round(model.weights[index], 12),
      candidateCoefficient: round(model.weights[index] / model.scaler[field].divisor, 12),
    })),
  };
}
const best = logisticSummary.holdoutAccuracy >= forestSummary.holdoutAccuracy
  ? { name: "pairwise logistic", summary: logisticSummary }
  : { name: "extra-tree forest", summary: forestSummary };
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  market: "BTC up/down 5m",
  timing: "features observed 520ms before inferred match; chronological splits only",
  definition: "direction match means selecting the same token as each non-simultaneous target action; confidence coverage is the fraction of target actions for which the model emits a side",
  samples: {
    fit: fitPairs.length,
    validation: validationPairs.length,
    development: developmentPairs.length,
    holdout: holdoutPairs.length,
    externalAug26: externalPairs.length,
    holdoutRoles: roleCounts(holdoutPairs),
    nativeForwardV2: { startMs: nativeV2Start, fit: nativeFitPairs.length, validationAug24: nativeValidationPairs.length, holdoutAug25: nativeHoldoutPairs.length, externalAug26: externalPairs.length },
  },
  featureNames,
  selection: {
    logistic: logisticCandidates.map((row) => ({ l2: row.l2, validationAccuracy: round(row.validationAccuracy) })),
    marketLogistic: marketLogisticCandidates.map((row) => ({ l2: row.l2, validationAccuracy: round(row.validationAccuracy) })),
    forest: forestCandidates.map((row) => ({ config: row.config, validationAccuracy: round(row.validationAccuracy) })),
  },
  ablations,
  marketOnlyLogistic: { selectedL2: marketLogisticCandidates[0].l2, deployableModel: serializePairwiseModel(marketLogistic, marketLogisticSummary), ...marketLogisticSummary },
  nativeForwardV2MarketOnly: {
    selectedL2: nativeMarketCandidates[0].l2,
    selection: nativeMarketCandidates.map((row) => ({ l2: row.l2, validationAccuracy: round(row.validationAccuracy) })),
    deployableModel: serializePairwiseModel(nativeMarketLogistic, nativeMarketLogisticSummary, nativeFitEnd, "2026-08-24"),
    ...nativeMarketLogisticSummary,
  },
  logistic: { selectedL2: selectedLogisticL2, topCoefficients: logisticCoefficients.slice(0, 20), ...logisticSummary },
  inventoryAwareDeployableModel: serializePairwiseModel(logistic, logisticSummary),
  forest: { selectedConfig: selectedForestConfig, ...forestSummary },
  conclusion: {
    bestModel: best.name,
    holdoutAccuracy: best.summary.holdoutAccuracy,
    externalAug26Accuracy: best.summary.externalAug26Accuracy,
    ninetyPercentFullCoverageAchieved: best.summary.holdoutAccuracy >= .9 && best.summary.externalAug26Accuracy >= .9,
  },
};
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
const frontierText = best.summary.holdoutConfidenceFrontier.map((row) => `${Math.round(row.coverage * 100)}% coverage: ${round(row.accuracy * 100, 2)}%`).join("; ");
const md = `# 90% signal search — BTC 5m\n\n` +
  `Target: \`${report.target}\`. All inputs are frozen at inferred match minus 520 ms. Models were fit through Aug 20, selected and confidence-calibrated on Aug 21, then frozen for Aug 22–25. Aug 26 is a later external check.\n\n` +
  `- Pairwise logistic: holdout ${round(logisticSummary.holdoutAccuracy * 100, 2)}%; Aug 26 ${round(logisticSummary.externalAug26Accuracy * 100, 2)}%.\n` +
  `- Market-only pairwise logistic: holdout ${round(marketLogisticSummary.holdoutAccuracy * 100, 2)}%; Aug 26 ${round(marketLogisticSummary.externalAug26Accuracy * 100, 2)}%. At its validation-selected 90% cutoff: holdout ${round(marketLogisticSummary.holdoutAtValidationNinetyThreshold?.precision * 100, 2)}% precision/${round(marketLogisticSummary.holdoutAtValidationNinetyThreshold?.coverage * 100, 2)}% coverage; Aug 26 ${round(marketLogisticSummary.externalAtValidationNinetyThreshold?.precision * 100, 2)}%/${round(marketLogisticSummary.externalAtValidationNinetyThreshold?.coverage * 100, 2)}%.\n` +
  `- Native-v2-only market model (train Aug 22 08:55–Aug 23, calibrate Aug 24): Aug 25 full accuracy ${round(nativeMarketLogisticSummary.holdoutAccuracy * 100, 2)}%, cutoff precision/coverage ${round(nativeMarketLogisticSummary.holdoutAtValidationNinetyThreshold?.precision * 100, 2)}%/${round(nativeMarketLogisticSummary.holdoutAtValidationNinetyThreshold?.coverage * 100, 2)}%; Aug 26 ${round(nativeMarketLogisticSummary.externalAtValidationNinetyThreshold?.precision * 100, 2)}%/${round(nativeMarketLogisticSummary.externalAtValidationNinetyThreshold?.coverage * 100, 2)}%.\n` +
  `- Extra-tree forest: holdout ${round(forestSummary.holdoutAccuracy * 100, 2)}%; Aug 26 ${round(forestSummary.externalAug26Accuracy * 100, 2)}%.\n` +
  `- Validation-selected 90% cutoff (${best.name}): holdout precision ${round(best.summary.holdoutAtValidationNinetyThreshold?.precision * 100, 2)}% at ${round(best.summary.holdoutAtValidationNinetyThreshold?.coverage * 100, 2)}% coverage; Aug 26 precision ${round(best.summary.externalAtValidationNinetyThreshold?.precision * 100, 2)}% at ${round(best.summary.externalAtValidationNinetyThreshold?.coverage * 100, 2)}% coverage.\n` +
  `- Best confidence frontier on holdout (${best.name}): ${frontierText}.\n` +
  `- Full-coverage 90% direction match: **${report.conclusion.ninetyPercentFullCoverageAchieved ? "achieved" : "not achieved"}**.\n`;
fs.writeFileSync(outputMd, md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
