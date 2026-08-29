#!/usr/bin/env node
// Causal, chronological parity audit for the reconstructed wallet signal.
//
// The runtime contract being tested is intentionally narrow:
//   1. the Up-token CLOB midpoint velocity chooses direction;
//   2. Binance momentum must agree;
//   3. any extra variables below can abstain, but cannot flip that direction.
//
// This report separates point precision from statistical evidence. A tiny
// 100%-correct slice is not described as 98%-certain unless its Wilson lower
// confidence bound also clears 98%.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const resultDir = path.join(root, "research/wallet-75cc/results");
const sourceFile = path.join(dataDir, "side-choice-samples-consensus-btc-aug16-25-decision520.json.gz");
const externalFile = path.join(dataDir, "side-choice-samples-v2-btc-aug26-untouched-decision520.json.gz");
const freshExactFile = path.join(dataDir, "fresh-aug27/side-choice-samples-aug27-exact-decision520.json.gz");
const outputJson = path.join(resultDir, "signal-parity-98-2026-08-27.json");
const outputMd = path.join(resultDir, "signal-parity-98-2026-08-27.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z");
const validationEnd = Date.parse("2026-08-22T00:00:00Z");
const targetPrecision = 0.98;

function readGzip(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}
function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
function sigmoid(score) {
  if (score >= 0) return 1 / (1 + Math.exp(-Math.min(40, score)));
  const exp = Math.exp(Math.max(-40, score));
  return exp / (1 + exp);
}
function dot(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += a[index] * b[index];
  return total;
}
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function sameDirection(a, b) {
  return a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b);
}

// In the paired data, `chosen` is oriented to the token bought by the target.
// Thus a positive chosen-side feature means a live Up-oriented version of the
// feature would have pointed at the target side. A negative value is an error.
function clobMidMove(row, horizon) {
  return (number(row[`sideAskMove${horizon}`]) + number(row[`sideBidMove${horizon}`])) / 2;
}
function momentumVector(row) {
  return [
    clobMidMove(row, "1"),
    clobMidMove(row, "3"),
    clobMidMove(row, "5"),
    number(row.bzMove1),
    number(row.bzMove3),
    number(row.bzMove5),
  ];
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return { low: null, high: null };
  const p = successes / total, zz = z * z;
  const center = (p + zz / (2 * total)) / (1 + zz / total);
  const spread = z * Math.sqrt((p * (1 - p) + zz / (4 * total)) / total) / (1 + zz / total);
  return { low: center - spread, high: center + spread };
}

function metrics(pairs, classify) {
  const rows = [];
  for (const pair of pairs) {
    const result = classify(pair);
    if (result?.emit) rows.push({ pair, correct: Boolean(result.correct), confidence: result.confidence ?? null });
  }
  const successes = rows.filter((row) => row.correct).length;
  const interval = wilson(successes, rows.length);
  const byRole = {};
  for (const role of ["flat", "entry/topup", "hedge"]) {
    const selected = rows.filter((row) => row.pair.role === role);
    const wins = selected.filter((row) => row.correct).length;
    byRole[role] = { actions: selected.length, precision: selected.length ? round(wins / selected.length) : null };
  }
  const byDay = {};
  for (const row of rows) {
    const day = isoDay(row.pair.ms);
    byDay[day] ||= { actions: 0, successes: 0 };
    byDay[day].actions++;
    if (row.correct) byDay[day].successes++;
  }
  for (const day of Object.keys(byDay)) {
    byDay[day].precision = round(byDay[day].successes / byDay[day].actions);
    delete byDay[day].successes;
  }
  return {
    actions: rows.length,
    successes,
    errors: rows.length - successes,
    coverage: round(rows.length / Math.max(1, pairs.length)),
    precision: rows.length ? round(successes / rows.length) : null,
    wilson95Low: round(interval.low),
    wilson95High: round(interval.high),
    pointEstimate98: rows.length > 0 && successes / rows.length >= targetPrecision,
    wilsonLowerBound98: rows.length > 0 && interval.low >= targetPrecision,
    byRole,
    byDay,
  };
}

function strictClassifier(config) {
  return (pair) => {
    const row = pair.chosen;
    const c1 = clobMidMove(row, "1"), c3 = clobMidMove(row, "3"), c5 = clobMidMove(row, "5");
    const bz3 = number(row.bzMove3), bz5 = number(row.bzMove5);
    const bz = config.binanceHorizon === 3 ? bz3 : bz5;
    const bzOther = config.binanceHorizon === 3 ? bz5 : bz3;
    let emit = Math.abs(c3) + 1e-12 >= config.clob3Min
      && Math.abs(bz) + 1e-12 >= config.binanceMin
      && sameDirection(c3, bz);
    if (config.clob1Min != null) emit = emit
      && Math.abs(c1) + 1e-12 >= config.clob1Min && sameDirection(c3, c1);
    if (config.requireClob5Agreement) emit = emit && sameDirection(c3, c5);
    if (config.requireOtherBinanceAgreement) emit = emit && sameDirection(c3, bzOther);
    return { emit, correct: c3 > 0, confidence: Math.min(Math.abs(c3), Math.abs(bz)) };
  };
}

function buildStrictFamily() {
  const candidates = [];
  for (const clob3Min of [.01, .02, .03, .04, .05, .06, .08, .1])
    for (const clob1Min of [null, .01, .02, .03, .05])
      for (const requireClob5Agreement of [false, true])
        for (const binanceHorizon of [3, 5])
          for (const binanceMin of [0, .0025, .005, .0075, .01, .015, .02])
            for (const requireOtherBinanceAgreement of [false, true])
              candidates.push({ clob3Min, clob1Min, requireClob5Agreement,
                binanceHorizon, binanceMin, requireOtherBinanceAgreement });
  return candidates;
}

function fitMomentumLogistic(trainingPairs, l2) {
  const source = trainingPairs.map((pair) => momentumVector(pair.chosen));
  const divisors = source[0].map((_, index) => Math.max(1e-9,
    Math.sqrt(mean(source.map((row) => row[index] ** 2)))));
  const rows = source.map((row) => row.map((value, index) => Math.max(-8, Math.min(8, value / divisors[index]))));
  const weights = Array(rows[0].length).fill(0);
  const first = Array(rows[0].length).fill(0), second = Array(rows[0].length).fill(0);
  for (let epoch = 0; epoch < 600; epoch++) {
    const gradient = Array(weights.length).fill(0);
    for (const row of rows) {
      const miss = 1 - sigmoid(dot(weights, row));
      for (let index = 0; index < weights.length; index++) gradient[index] -= miss * row[index] / rows.length;
    }
    for (let index = 0; index < weights.length; index++) {
      gradient[index] += l2 * weights[index];
      first[index] = .9 * first[index] + .1 * gradient[index];
      second[index] = .999 * second[index] + .001 * gradient[index] ** 2;
      const m = first[index] / (1 - .9 ** (epoch + 1));
      const v = second[index] / (1 - .999 ** (epoch + 1));
      weights[index] -= .025 * m / (Math.sqrt(v) + 1e-8);
    }
  }
  return { fields: ["clobMid1", "clobMid3", "clobMid5", "binance1", "binance3", "binance5"], divisors, weights };
}
function modelScore(model, row) {
  return dot(model.weights, momentumVector(row).map((value, index) =>
    Math.max(-8, Math.min(8, value / model.divisors[index]))));
}
function fullAccuracy(pairs, score) {
  return mean(pairs.map((pair) => score(pair) > 0 ? 1 : 0));
}

// A threshold is calibrated only on validation. Eligibility still enforces the
// runtime contract: 3-second midpoint direction, Binance-3 agreement, and the
// learned multi-horizon likelihood ratio all point the same way.
function likelihoodRows(pairs, model) {
  const rows = [];
  for (const pair of pairs) {
    const c3 = clobMidMove(pair.chosen, "3"), bz3 = number(pair.chosen.bzMove3);
    const score = modelScore(model, pair.chosen);
    if (!sameDirection(c3, bz3) || !sameDirection(c3, score)) continue;
    rows.push({ pair, correct: c3 > 0, confidence: Math.abs(score) });
  }
  return rows.sort((a, b) => b.confidence - a.confidence);
}
function choosePrecisionThreshold(pairs, model, target = targetPrecision) {
  const rows = likelihoodRows(pairs, model);
  let wins = 0, best = null;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].correct) wins++;
    const tied = rows[index + 1] && Math.abs(rows[index + 1].confidence - rows[index].confidence) < 1e-12;
    if (!tied && wins / (index + 1) >= target) {
      best = { threshold: rows[index].confidence, actions: index + 1,
        precision: wins / (index + 1), coverage: (index + 1) / pairs.length };
    }
  }
  return best;
}
function likelihoodClassifier(model, threshold) {
  return (pair) => {
    const c3 = clobMidMove(pair.chosen, "3"), bz3 = number(pair.chosen.bzMove3);
    const score = modelScore(model, pair.chosen);
    const emit = sameDirection(c3, bz3) && sameDirection(c3, score) && Math.abs(score) + 1e-12 >= threshold;
    return { emit, correct: c3 > 0, confidence: Math.abs(score) };
  };
}

function pct(value) {
  return value == null ? "n/a" : `${round(value * 100, 2)}%`;
}
function shortMetrics(label, split) {
  return `- ${label}: ${split.actions} actions, ${pct(split.coverage)} coverage, ${pct(split.precision)} precision, Wilson-95 lower ${pct(split.wilson95Low)}.`;
}

const pairs = readGzip(sourceFile).pairs;
const externalPairs = fs.existsSync(externalFile) ? readGzip(externalFile).pairs : [];
const freshExactPairs = fs.existsSync(freshExactFile) ? readGzip(freshExactFile).pairs : [];
const fitPairs = pairs.filter((pair) => pair.ms < fitEnd);
const validationPairs = pairs.filter((pair) => pair.ms >= fitEnd && pair.ms < validationEnd);
const holdoutPairs = pairs.filter((pair) => pair.ms >= validationEnd);

const priorConfig = { clob3Min: .01, clob1Min: null, requireClob5Agreement: false,
  binanceHorizon: 5, binanceMin: .01, requireOtherBinanceAgreement: false };
const currentConfig = { clob3Min: .08, clob1Min: .055, requireClob5Agreement: false,
  binanceHorizon: 3, binanceMin: .0075, requireOtherBinanceAgreement: false };
const prior = Object.fromEntries([
  ["fit", fitPairs], ["validation", validationPairs], ["holdout", holdoutPairs],
  ["externalAug26", externalPairs], ["freshExactAug27", freshExactPairs],
].map(([name, selected]) => [name, metrics(selected, strictClassifier(priorConfig))]));
const current = Object.fromEntries([
  ["fit", fitPairs], ["validation", validationPairs], ["holdout", holdoutPairs],
  ["externalAug26", externalPairs], ["freshExactAug27", freshExactPairs],
].map(([name, selected]) => [name, metrics(selected, strictClassifier(currentConfig))]));
current.combinedForward = metrics([...holdoutPairs, ...externalPairs, ...freshExactPairs], strictClassifier(currentConfig));

// Structure/threshold screening uses fit and Aug 21 validation only. Aug 22+
// never participates in this ranking.
const strictSearch = buildStrictFamily().map((config) => {
  const classify = strictClassifier(config);
  return { config, fit: metrics(fitPairs, classify), validation: metrics(validationPairs, classify) };
});
let eligibleStrict = strictSearch.filter((row) => row.fit.actions >= 70 && row.validation.actions >= 50
  && row.fit.precision >= .96 && row.validation.precision >= targetPrecision);
let strictSelectionRule = "maximize Aug-21 validation coverage subject to fit>=96%, validation>=98%, fit n>=70, validation n>=50";
if (!eligibleStrict.length) {
  eligibleStrict = strictSearch.filter((row) => row.fit.actions >= 50
    && row.validation.actions >= 30 && row.validation.precision >= targetPrecision);
  strictSelectionRule = "fallback: maximize Aug-21 validation coverage subject to validation>=98%, fit n>=50, validation n>=30";
}
if (!eligibleStrict.length) strictSelectionRule = "no candidate cleared the 98% validation gate; report the highest-validation-precision diagnostic only";
eligibleStrict.sort((a, b) => b.validation.coverage - a.validation.coverage
  || b.validation.actions - a.validation.actions || b.fit.precision - a.fit.precision);
const selectedStrictBase = eligibleStrict[0] || strictSearch.sort((a, b) =>
  b.validation.precision - a.validation.precision || b.validation.actions - a.validation.actions)[0];
const selectedStrictClassifier = strictClassifier(selectedStrictBase.config);
const selectedStrict = {
  config: selectedStrictBase.config,
  selectionRule: strictSelectionRule,
  fit: selectedStrictBase.fit,
  validation: selectedStrictBase.validation,
  holdout: metrics(holdoutPairs, selectedStrictClassifier),
  externalAug26: metrics(externalPairs, selectedStrictClassifier),
};

const logisticCandidates = [.0001, .001, .01, .1, 1].map((l2) => {
  const model = fitMomentumLogistic(fitPairs, l2);
  return { l2, model, validationAccuracy: fullAccuracy(validationPairs, (pair) => modelScore(model, pair.chosen)) };
}).sort((a, b) => b.validationAccuracy - a.validationAccuracy || a.l2 - b.l2);
const selectedLikelihood = logisticCandidates[0];
const likelihoodThreshold = choosePrecisionThreshold(validationPairs, selectedLikelihood.model, targetPrecision);
const likelihoodClassify = likelihoodClassifier(selectedLikelihood.model, likelihoodThreshold?.threshold ?? Infinity);
const likelihood = {
  selectedL2: selectedLikelihood.l2,
  validationSelection: logisticCandidates.map((row) => ({ l2: row.l2, validationAccuracy: round(row.validationAccuracy) })),
  model: {
    formula: "logLR=sum(weight[i]*feature[i]/rms[i]); direction remains sign(CLOB midpoint 3s); emit only when Binance 3s and logLR agree",
    fields: selectedLikelihood.model.fields.map((field, index) => ({ field,
      rms: round(selectedLikelihood.model.divisors[index], 12), weight: round(selectedLikelihood.model.weights[index], 12) })),
  },
  validationThreshold: likelihoodThreshold && { threshold: round(likelihoodThreshold.threshold, 12),
    actions: likelihoodThreshold.actions, precision: round(likelihoodThreshold.precision), coverage: round(likelihoodThreshold.coverage) },
  fit: metrics(fitPairs, likelihoodClassify),
  validation: metrics(validationPairs, likelihoodClassify),
  holdout: metrics(holdoutPairs, likelihoodClassify),
  externalAug26: metrics(externalPairs, likelihoodClassify),
};

const candidates = [
  { name: "validation-selected strict consensus", result: selectedStrict },
  { name: "momentum likelihood-ratio gate", result: likelihood },
];
const bestHeldOut = candidates.sort((a, b) =>
  (b.result.holdout.precision ?? -1) - (a.result.holdout.precision ?? -1)
  || b.result.holdout.actions - a.result.holdout.actions)[0];
const pointEstimate98 = bestHeldOut.result.holdout.pointEstimate98
  && bestHeldOut.result.externalAug26.pointEstimate98;
const statisticallySupported98 = bestHeldOut.result.holdout.wilsonLowerBound98
  && bestHeldOut.result.externalAug26.wilsonLowerBound98;

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  objective: "same-side precision at target action times using only CLOB midpoint velocities and Binance momentum",
  causalTiming: "all features frozen 520ms before inferred target match",
  splits: {
    fit: { before: new Date(fitEnd).toISOString(), actions: fitPairs.length },
    validation: { from: new Date(fitEnd).toISOString(), to: new Date(validationEnd).toISOString(), actions: validationPairs.length },
    holdout: { from: new Date(validationEnd).toISOString(), through: "2026-08-25", actions: holdoutPairs.length },
    externalAug26: { actions: externalPairs.length },
    freshExactAug27: { actions: freshExactPairs.length },
  },
  definitions: {
    precision: "fraction of emitted directions matching the token chosen by the target",
    coverage: "fraction of target actions at which the rule emits; this is not market participation",
    exactClone: "requires direction plus release-time/action matching and is not established by this direction audit",
    statisticalGate: "both holdout and external point precision >=98% and both Wilson 95% lower bounds >=98%",
  },
  priorRuntimeRule: { config: priorConfig, ...prior },
  currentRuntimeRule: { config: currentConfig, ...current },
  selectedStrict,
  momentumLikelihood: likelihood,
  auditCaveat: "All reported days have now been inspected. The combined-forward label is chronological, not a claim that the final rule survived a prospectively locked test; the next collected cohort is the required frozen confirmation.",
  conclusion: {
    bestHeldOutCandidate: bestHeldOut.name,
    holdoutPointEstimate98: bestHeldOut.result.holdout.pointEstimate98,
    externalPointEstimate98: bestHeldOut.result.externalAug26.pointEstimate98,
    pointEstimate98OnBoth: pointEstimate98,
    statisticallySupported98,
    fullCoverage98: false,
    exactSignalClone98: false,
    selectiveDirectionPromotion: current.combinedForward.pointEstimate98,
    eligibleForRuntimePromotion: false,
    reason: statisticallySupported98
      ? "Direction passes the statistical gate, but exact release/action parity remains unproven."
      : "The active selective gate clears 98% combined forward point precision, but not a 98% Wilson lower bound; exact release/action parity remains unproven.",
  },
};

fs.mkdirSync(resultDir, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
const md = `# Signal parity audit — 98% target\n\n` +
  `Target: \`${report.target}\`. This is a causal direction audit at target action times, not a claim of exact release-time cloning. Features are observed 520 ms before the inferred match.\n\n` +
  `## Current runtime rule\n\n` +
  shortMetrics("Fit", current.fit) + "\n" + shortMetrics("Validation", current.validation) + "\n" +
  shortMetrics("Holdout Aug 22–25", current.holdout) + "\n" + shortMetrics("External Aug 26", current.externalAug26) + "\n" +
  shortMetrics("Fresh exact Aug 27", current.freshExactAug27) + "\n" + shortMetrics("Combined forward", current.combinedForward) + "\n\n" +
  `## Validation-selected strict momentum consensus\n\n` +
  `Config: \`${JSON.stringify(selectedStrict.config)}\`.\n\n` +
  shortMetrics("Fit", selectedStrict.fit) + "\n" + shortMetrics("Validation", selectedStrict.validation) + "\n" +
  shortMetrics("Holdout Aug 22–25", selectedStrict.holdout) + "\n" + shortMetrics("External Aug 26", selectedStrict.externalAug26) + "\n\n" +
  `## Multi-horizon momentum likelihood-ratio gate\n\n` +
  `The learned log-likelihood ratio may abstain but cannot override the required 3-second CLOB midpoint direction or Binance-3 agreement.\n\n` +
  shortMetrics("Fit", likelihood.fit) + "\n" + shortMetrics("Validation", likelihood.validation) + "\n" +
  shortMetrics("Holdout Aug 22–25", likelihood.holdout) + "\n" + shortMetrics("External Aug 26", likelihood.externalAug26) + "\n\n" +
  `## Conclusion\n\n` +
  `- Best held-out candidate: ${bestHeldOut.name}.\n` +
  `- 98% point estimate on holdout and external: **${pointEstimate98 ? "yes" : "no"}**.\n` +
  `- 98% Wilson-95 lower confidence bound on both: **${statisticallySupported98 ? "yes" : "no"}**.\n` +
  `- Exact direction + release/action clone established: **no**.\n` +
  `- Selective direction gate enabled experimentally: **${current.combinedForward.pointEstimate98 ? "yes" : "no"}**; exact release/action promotion remains **no**.\n\n` +
  `${report.conclusion.reason}\n`;
fs.writeFileSync(outputMd, md);
console.log(md);
console.log(JSON.stringify({ outputJson, selectedStrict: report.selectedStrict,
  likelihood: report.momentumLikelihood, conclusion: report.conclusion }, null, 2));
