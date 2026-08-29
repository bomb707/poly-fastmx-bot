#!/usr/bin/env node
// Test a sequential-evidence hypothesis: target direction is the required CLOB
// midpoint/Binance agreement, but only after that agreement persists without an
// interruption. This is distinct from executable-book persistence.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const oldData = path.join(root, "data/wallet-75cc");
const freshData = path.join(oldData, "fresh-aug27");
const oldActionsFile = path.join(oldData, "fire-actions-consensus-btc-aug16-25-decision520.json.gz");
const freshActionsFile = path.join(freshData, "fire-actions-aug27-exact-decision520.json.gz");
const oldFeedDir = path.join(oldData, "feeds/v2-l2");
const freshFeedDir = path.join(freshData, "feeds-v2-l2");
const resultDir = path.join(root, "research/wallet-75cc/results");
const outputJson = path.join(resultDir, "signal-persistence-2026-08-27.json");
const outputMd = path.join(resultDir, "signal-persistence-2026-08-27.md");
const fitEnd = Date.parse("2026-08-21T00:00:00Z"), validationEnd = Date.parse("2026-08-22T00:00:00Z");
const configs = [
  ...[0, 250, 500, 750, 1000, 1500, 2000, 3000, 5000].map((persistenceMs) =>
    ({ midLookbackMs: 3000, midMin: .01, binanceLookbackMs: 5000, binanceMinPct: .01, persistenceMs })),
  ...[0, 250, 500, 750, 1000, 1500, 2000, 3000, 5000].map((persistenceMs) =>
    ({ midLookbackMs: 3000, midMin: .01, binanceLookbackMs: 3000, binanceMinPct: .01, persistenceMs })),
];

const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const startMs = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
function indexAtOrBefore(ticks, ms, high = ticks.length - 1) {
  let low = 0, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1;
  }
  return answer;
}
function best(rows, ascending) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let value = null;
  for (const row of rows) {
    const number = Number(Array.isArray(row) ? row[0] : row?.price);
    if (!Number.isFinite(number)) continue;
    if (value == null || (ascending ? number < value : number > value)) value = number;
  }
  return value;
}
function midpoint(tick) {
  const ask = best(tick?.up?.asks, true), bid = best(tick?.up?.bids, false);
  return ask != null && bid != null ? (ask + bid) / 2 : null;
}
function signalAt(ticks, index, config) {
  const tick = ticks[index], currentMid = midpoint(tick), currentBz = Number(tick?.bz);
  const midIndex = indexAtOrBefore(ticks, tick.ms - config.midLookbackMs, index);
  const bzIndex = indexAtOrBefore(ticks, tick.ms - config.binanceLookbackMs, index);
  const priorMid = midIndex >= 0 ? midpoint(ticks[midIndex]) : null;
  const priorBz = bzIndex >= 0 ? Number(ticks[bzIndex]?.bz) : null;
  if (currentMid == null || priorMid == null || !(currentBz > 0) || !(priorBz > 0)) return null;
  const midMove = currentMid - priorMid;
  const bzPct = (currentBz - priorBz) / priorBz * 100;
  if (Math.abs(midMove) + 1e-12 < config.midMin || Math.abs(bzPct) + 1e-12 < config.binanceMinPct
    || Math.sign(midMove) !== Math.sign(bzPct)) return null;
  return midMove > 0 ? "Up" : "Down";
}
function signalRun(ticks, index, config, direction) {
  const endMs = ticks[index].ms;
  let sinceMs = endMs;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (ticks[cursor + 1].ms - ticks[cursor].ms > 6000) break;
    if (signalAt(ticks, cursor, config) !== direction) break;
    sinceMs = ticks[cursor].ms;
    if (endMs - sinceMs >= config.persistenceMs + 1000) break;
  }
  return endMs - sinceMs;
}
function unambiguous(actions) {
  return actions.filter((action, index) => !actions.some((other, otherIndex) => otherIndex !== index
    && other.slug === action.slug && other.outcome !== action.outcome
    && Math.abs(other.fireMs - action.fireMs) <= 500));
}
function loadObservations(actionsFile, feedDir, label) {
  const actions = unambiguous(readGzip(actionsFile).rows);
  const bySlug = new Map();
  for (const action of actions) {
    const rows = bySlug.get(action.slug) || []; rows.push(action); bySlug.set(action.slug, rows);
  }
  const observations = [];
  let done = 0;
  for (const [slug, selected] of bySlug) {
    const file = path.join(feedDir, `${slug}.json.gz`);
    if (!fs.existsSync(file)) continue;
    const ticks = readGzip(file).ticks || [];
    for (const action of selected) {
      const decisionMs = Number(action.decisionMs ?? (action.fireMs - 520));
      const index = indexAtOrBefore(ticks, decisionMs);
      if (index < 0) continue;
      const evaluated = configs.map((config) => {
        const direction = signalAt(ticks, index, config);
        return { direction, runMs: direction ? signalRun(ticks, index, config, direction) : 0 };
      });
      observations.push({ label, slug, ms: decisionMs, targetSide: action.outcome, role: action.role, evaluated });
    }
    done++;
    if (done % 250 === 0) console.log(JSON.stringify({ phase: `signal-persistence-${label}`, done, total: bySlug.size }));
  }
  return observations;
}
function metrics(observations, configIndex) {
  const config = configs[configIndex];
  const rows = observations.filter((row) => {
    const value = row.evaluated[configIndex];
    return value.direction && value.runMs + 1e-9 >= config.persistenceMs;
  });
  const wins = rows.filter((row) => row.evaluated[configIndex].direction === row.targetSide).length;
  return { actions: rows.length, successes: wins, errors: rows.length - wins,
    coverage: round(rows.length / Math.max(1, observations.length)),
    precision: rows.length ? round(wins / rows.length) : null };
}

const old = loadObservations(oldActionsFile, oldFeedDir, "old");
const fresh = loadObservations(freshActionsFile, freshFeedDir, "freshAug27");
const fit = old.filter((row) => row.ms < fitEnd), validation = old.filter((row) => row.ms >= fitEnd && row.ms < validationEnd);
const holdout = old.filter((row) => row.ms >= validationEnd);
const rows = configs.map((config, index) => ({ config,
  fit: metrics(fit, index), validation: metrics(validation, index),
  holdout: metrics(holdout, index), freshAug27: metrics(fresh, index) }));
const eligible = rows.filter((row) => row.validation.actions >= 30 && row.validation.precision >= .98);
eligible.sort((a, b) => b.validation.coverage - a.validation.coverage || b.fit.precision - a.fit.precision);
const selected = eligible[0] || [...rows].sort((a, b) => b.validation.precision - a.validation.precision
  || b.validation.actions - a.validation.actions)[0];
const report = { schema: 1, generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  hypothesis: "uninterrupted CLOB-midpoint/Binance direction agreement is a sequential evidence gate",
  samples: { fit: fit.length, validation: validation.length, holdout: holdout.length, freshAug27: fresh.length },
  selection: "Aug21 validation only: maximum coverage with >=98% precision and >=30 actions",
  selected, rows,
  conclusion: { heldout98: selected.holdout.precision >= .98,
    freshAug2798: selected.freshAug27.precision >= .98,
    promote: selected.holdout.precision >= .98 && selected.freshAug27.precision >= .98,
    note: "Fresh Aug27 is exact high/medium native-V2 order-fire inference, not public second-resolution time." },
};
fs.mkdirSync(resultDir, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
const pct = (value) => value == null ? "n/a" : `${round(value * 100, 2)}%`;
const line = (name, value) => `- ${name}: ${value.actions} actions, ${pct(value.coverage)} coverage, ${pct(value.precision)} precision.`;
const md = `# Signal-agreement persistence audit\n\n` +
  `Hypothesis: uninterrupted CLOB midpoint/Binance agreement supplies the missing sequential evidence. Direction always remains the required 3-second CLOB midpoint direction.\n\n` +
  `Selected config: \`${JSON.stringify(selected.config)}\`.\n\n` + line("Fit", selected.fit) + "\n" + line("Validation", selected.validation) + "\n" +
  line("Holdout Aug22-25", selected.holdout) + "\n" + line("Untouched exact Aug27", selected.freshAug27) + "\n\n" +
  `Runtime promotion: **${report.conclusion.promote ? "yes" : "no"}**.\n`;
fs.writeFileSync(outputMd, md);
console.log(md);
console.log(JSON.stringify({ outputJson, selected, conclusion: report.conclusion }, null, 2));
