#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const paths = {
  stressV2: path.resolve(process.argv[2] || 'data/research/passive-maker-v25-partial-cancel-stress-v2.json'),
  stressV4: path.resolve(process.argv[3] || 'data/research/passive-maker-v25-partial-cancel-stress-v4.json'),
  neighborhoodV2: path.resolve(process.argv[4] || 'data/research/passive-maker-v25-neighborhood-v2.json'),
  neighborhoodV4: path.resolve(process.argv[5] || 'data/research/passive-maker-v25-neighborhood-v4.json'),
  frozenV2: path.resolve(process.argv[6] || 'data/research/passive-maker-v17-selected-v2.json'),
  frozenV4: path.resolve(process.argv[7] || 'data/research/passive-maker-v17-selected-v4.json'),
  output: path.resolve(process.argv[8] || 'data/research/passive-maker-v25-assessment.json'),
};

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const reports = {
  stress: { v2: read(paths.stressV2), v4: read(paths.stressV4) },
  neighborhood: { v2: read(paths.neighborhoodV2), v4: read(paths.neighborhoodV4) },
  frozen: { v2: read(paths.frozenV2), v4: read(paths.frozenV4) },
};
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function entries(report) {
  return Object.values(report.diagnostics || {});
}

function foldPnls(entry, fromMs, toMs) {
  const width = (toMs - fromMs) / 3;
  return [0, 1, 2].map((index) => {
    const from = fromMs + index * width;
    const to = index === 2 ? toMs : fromMs + (index + 1) * width;
    const rows = (entry.windowsDetail || []).filter((row) => row.startMs >= from && row.startMs < to);
    return {
      index: index + 1,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      activeWindows: rows.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9).length,
      spend: round(rows.reduce((sum, row) => sum + Number(row.grossBuySpend || 0), 0)),
      pnl: round(rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0)),
    };
  });
}

function assess(entry, fromMs, toMs, { requireActivity = true } = {}) {
  const folds = foldPnls(entry, fromMs, toMs);
  const metrics = {
    latencyMs: Number(entry.params.latencyMs),
    makerCredit: Number(entry.params.makerCredit),
    makerTradingEnabled: entry.params.makerTradingEnabled === true,
    activeWindows: Number(entry.activeWindows),
    spend: Number(entry.grossBuySpend),
    pnl: Number(entry.pnl),
    roiPct: Number(entry.roiPct),
    maxDrawdown: Number(entry.maxDrawdown),
    profitFactor: Number(entry.profitFactor),
    bootstrapWindowLower95: Number(entry.bootstrapWindowLower95),
    bootstrapDayLower95: Number(entry.bootstrapDayLower95),
    placements: Number(entry.placements),
    makerFillEvents: Number(entry.makerFillEvents),
    takerFillEvents: Number(entry.takerFillEvents),
    partialFillCancelTriggers: Number(entry.overweightCancelTriggers),
    makerRebate: Number(entry.makerRebate),
    folds,
  };
  const evidence = {
    positivePnl: metrics.pnl > 0,
    positiveWindowLower95: metrics.bootstrapWindowLower95 > 0,
    positiveDayLower95: metrics.bootstrapDayLower95 > 0,
    positiveEveryChronologicalFold: folds.every((fold) => fold.pnl > 0),
    maxDrawdownAtMost10: metrics.maxDrawdown <= 10,
    profitFactorAtLeast1p5: metrics.profitFactor >= 1.5,
    activeWindowsAtLeast75: !requireActivity || metrics.activeWindows >= 75,
    noTakerFills: metrics.takerFillEvents === 0,
    zeroMakerRebate: metrics.makerRebate === 0,
    partialFillCancellationExercised: metrics.partialFillCancelTriggers > 0,
  };
  return { ...metrics, evidence, passed: Object.values(evidence).every(Boolean) };
}

const fromMs = Math.max(...Object.values(reports.stress).map((report) => Date.parse(report.range.from)));
const toMs = Math.min(...Object.values(reports.stress).map((report) => Date.parse(report.range.to)));
const coverage = {
  v2: { discovered: reports.stress.v2.range.discovered, loaded: reports.stress.v2.range.loaded, failed: reports.stress.v2.range.failed },
  v4: { discovered: reports.stress.v4.range.discovered, loaded: reports.stress.v4.range.loaded, failed: reports.stress.v4.range.failed },
};
coverage.authoritative = coverage.v2.discovered === 2712 && coverage.v2.loaded === 2478 && coverage.v2.failed === 234
  && coverage.v4.discovered === 2712 && coverage.v4.loaded === 2664 && coverage.v4.failed === 48;

const stressCells = {};
for (const source of ['v2', 'v4']) {
  stressCells[source] = entries(reports.stress[source]).map((entry) => {
    if (entry.params.makerTradingEnabled !== true) {
      const paused = {
        latencyMs: Number(entry.params.latencyMs), makerCredit: Number(entry.params.makerCredit),
        makerTradingEnabled: false, placements: Number(entry.placements), makerFillEvents: Number(entry.makerFillEvents),
        takerFillEvents: Number(entry.takerFillEvents), spend: Number(entry.grossBuySpend), pnl: Number(entry.pnl),
      };
      paused.passed = Object.entries(paused).filter(([key]) => !['latencyMs', 'makerCredit', 'makerTradingEnabled', 'passed'].includes(key))
        .every(([, value]) => value === 0);
      return paused;
    }
    return assess(entry, fromMs, toMs);
  });
}

const enabledStress = Object.values(stressCells).flat().filter((cell) => cell.makerTradingEnabled);
const conservativeStress = enabledStress.filter((cell) => cell.makerCredit === .025);
const nominalStress = enabledStress.filter((cell) => cell.makerCredit === .075);
const pausedStress = Object.values(stressCells).flat().filter((cell) => !cell.makerTradingEnabled);

const neighborhood = {};
for (const source of ['v2', 'v4']) {
  for (const entry of entries(reports.neighborhood[source])) {
    const name = entry.params.name;
    neighborhood[name] ||= { name, params: entry.params, cells: {} };
    neighborhood[name].cells[`${source}_${entry.params.latencyMs}ms`] = assess(entry, fromMs, toMs);
  }
}
for (const candidate of Object.values(neighborhood)) {
  const cells = Object.values(candidate.cells);
  candidate.passed = cells.length === 4 && cells.every((cell) => cell.passed);
  candidate.worstWindowLower95 = round(Math.min(...cells.map((cell) => cell.bootstrapWindowLower95)));
  candidate.worstDayLower95 = round(Math.min(...cells.map((cell) => cell.bootstrapDayLower95)));
  candidate.maxDrawdown = round(Math.max(...cells.map((cell) => cell.maxDrawdown)));
  candidate.worstFoldPnl = round(Math.min(...cells.flatMap((cell) => cell.folds.map((fold) => fold.pnl))));
}

function frozenFocus(source) {
  const entry = entries(reports.frozen[source])[0];
  return assess(entry, fromMs, toMs);
}
function stressFocus(source) {
  return stressCells[source].find((cell) => cell.latencyMs === 130 && cell.makerCredit === .075);
}
const frozen = { v2: frozenFocus('v2'), v4: frozenFocus('v4') };
const focus = { v2: stressFocus('v2'), v4: stressFocus('v4') };
const deltaVsFrozen = Object.fromEntries(['v2', 'v4'].map((source) => [source, {
  pnl: round(focus[source].pnl - frozen[source].pnl),
  spend: round(focus[source].spend - frozen[source].spend),
  maxDrawdown: round(focus[source].maxDrawdown - frozen[source].maxDrawdown),
  activeWindows: focus[source].activeWindows - frozen[source].activeWindows,
}]))

const promotion = {
  authoritativeCoverage: coverage.authoritative,
  conservativeStressPassed: conservativeStress.length === 4 && conservativeStress.every((cell) => cell.passed),
  nominalStressPassed: nominalStress.length === 2 && nominalStress.every((cell) => cell.passed),
  everyEnabledStressCellPassed: enabledStress.every((cell) => cell.passed),
  latencyKillSwitchPassed: pausedStress.length === 8 && pausedStress.every((cell) => cell.passed),
  completeImmediateNeighborhoodPassed: Object.keys(neighborhood).length === 7
    && Object.values(neighborhood).every((candidate) => candidate.passed),
  improvesFocusPnlBothSources: deltaVsFrozen.v2.pnl > 0 && deltaVsFrozen.v4.pnl > 0,
  doesNotIncreaseFocusDrawdownBothSources: deltaVsFrozen.v2.maxDrawdown <= 0 && deltaVsFrozen.v4.maxDrawdown <= 0,
};
promotion.passed = Object.values(promotion).every(Boolean);

const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: 'Frozen pre-forward history only. Exact V2/V4 coverage, 130/200ms maker latency, 2.5%-10% conserved fill credit, a 300ms kill switch, zero rebates/taker fills, three chronological folds, confidence tails, drawdown, activity, and one-at-a-time TTL/disagreement/repricing neighbors are audited. V2/V4 are alternative reconstructions and their PnL is never added.',
  range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  coverage,
  promotion,
  deltaVsFrozen,
  frozen,
  focus,
  stressCells,
  neighborhood: Object.values(neighborhood).sort((a, b) => a.name.localeCompare(b.name)),
};
fs.mkdirSync(path.dirname(paths.output), { recursive: true });
fs.writeFileSync(paths.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: paths.output, coverage, promotion, deltaVsFrozen,
  neighborhood: output.neighborhood.map(({ name, passed, worstWindowLower95, worstDayLower95, maxDrawdown, worstFoldPnl }) =>
    ({ name, passed, worstWindowLower95, worstDayLower95, maxDrawdown, worstFoldPnl })) }, null, 2));
