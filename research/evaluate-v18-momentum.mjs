#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const v2Path = path.resolve(process.argv[2] || 'data/research/passive-maker-v18-momentum-v2.json');
const v4Path = path.resolve(process.argv[3] || 'data/research/passive-maker-v18-momentum-v4.json');
const outputPath = path.resolve(process.argv[4] || 'data/research/passive-maker-v18-momentum-assessment.json');
const frozenV2Path = path.resolve(process.argv[5] || 'data/research/passive-maker-v17-selected-v2.json');
const frozenV4Path = path.resolve(process.argv[6] || 'data/research/passive-maker-v17-selected-v4.json');

const sources = {
  v2: JSON.parse(fs.readFileSync(v2Path, 'utf8')),
  v4: JSON.parse(fs.readFileSync(v4Path, 'utf8')),
};
const frozen = {
  v2: JSON.parse(fs.readFileSync(frozenV2Path, 'utf8')),
  v4: JSON.parse(fs.readFileSync(frozenV4Path, 'utf8')),
};
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function bootstrapLower(values, samples = 20_000, seed = 0x3048d653) {
  if (!values.length) return null;
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const totals = new Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)];
    totals[sample] = total;
  }
  totals.sort((a, b) => a - b);
  return round(totals[Math.floor((totals.length - 1) * .025)]);
}

function summarize(rows) {
  const ordered = [...rows].sort((a, b) => a.startMs - b.startMs);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const daily = new Map();
  const sum = (field) => ordered.reduce((total, row) => total + Number(row[field] || 0), 0);
  for (const row of ordered) {
    const pnl = Number(row.pnl || 0);
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (pnl > 0) grossWin += pnl; else grossLoss -= pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + pnl);
  }
  const grossBuySpend = sum('grossBuySpend');
  const pnl = sum('pnl');
  const dayPnls = [...daily.values()];
  return {
    windows: ordered.length,
    activeWindows: ordered.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9).length,
    placements: sum('placements'),
    makerFillEvents: sum('makerFillEvents'),
    takerFillEvents: sum('takerFillEvents'),
    residualMomentumGateRejected: sum('residualMomentumGateRejected'),
    grossBuySpend: round(grossBuySpend),
    pnl: round(pnl),
    roiPct: grossBuySpend ? round(100 * pnl / grossBuySpend) : 0,
    pairedPnl: round(sum('pairedPnl')),
    residualPnl: round(sum('residualPnl')),
    maxDrawdown: round(maxDrawdown),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    bootstrapWindowLower95: bootstrapLower(ordered.map((row) => Number(row.pnl || 0))),
    bootstrapDayLower95: bootstrapLower(dayPnls, 20_000, 0x21be3497),
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])),
  };
}

function diagnosticsByName(output) {
  return new Map(Object.values(output.diagnostics || {}).map((entry) => [entry.params.name, entry]));
}

const maps = { v2: diagnosticsByName(sources.v2), v4: diagnosticsByName(sources.v4) };
const names = [...maps.v2.keys()].filter((name) => maps.v4.has(name)).sort();
const startMs = Math.max(Date.parse(sources.v2.range.from), Date.parse(sources.v4.range.from));
const endMs = Math.min(Date.parse(sources.v2.range.to), Date.parse(sources.v4.range.to));
const foldBounds = [0, 1, 2, 3].map((index) => startMs + (endMs - startMs) * index / 3);

function sourceAssessment(entry) {
  const rows = (entry.windowsDetail || []).filter((row) => row.startMs >= startMs && row.startMs < endMs);
  const folds = [0, 1, 2].map((index) => ({
    index: index + 1,
    from: new Date(foldBounds[index]).toISOString(),
    to: new Date(foldBounds[index + 1]).toISOString(),
    ...summarize(rows.filter((row) => row.startMs >= foldBounds[index] && row.startMs < foldBounds[index + 1])),
  }));
  return { full: summarize(rows), folds };
}

function frozenRows(source) {
  return Object.values(frozen[source].diagnostics || {})[0]?.windowsDetail || [];
}

function controlEquivalence(source) {
  const control = maps[source].get('momentum_control')?.windowsDetail || [];
  const expected = frozenRows(source);
  const controlBySlug = new Map(control.map((row) => [row.slug, row]));
  const expectedBySlug = new Map(expected.map((row) => [row.slug, row]));
  const slugs = new Set([...controlBySlug.keys(), ...expectedBySlug.keys()]);
  const fields = ['pnl', 'grossBuySpend', 'makerShares', 'takerShares', 'pairedPnl', 'residualPnl'];
  let missing = 0;
  let differing = 0;
  let maxAbsDifference = 0;
  for (const slug of slugs) {
    const left = controlBySlug.get(slug);
    const right = expectedBySlug.get(slug);
    if (!left || !right) {
      missing++;
      continue;
    }
    for (const field of fields) {
      const difference = Math.abs(Number(left[field] || 0) - Number(right[field] || 0));
      maxAbsDifference = Math.max(maxAbsDifference, difference);
      if (difference > 1e-9) {
        differing++;
        break;
      }
    }
  }
  return {
    expectedWindows: expected.length,
    controlWindows: control.length,
    unionWindows: slugs.size,
    missing,
    differing,
    maxAbsDifference: round(maxAbsDifference, 12),
    exact: missing === 0 && differing === 0,
  };
}

const candidates = names.map((name) => {
  const params = maps.v2.get(name).params;
  const assessed = {
    v2: sourceAssessment(maps.v2.get(name)),
    v4: sourceAssessment(maps.v4.get(name)),
  };
  const full = [assessed.v2.full, assessed.v4.full];
  const folds = [...assessed.v2.folds, ...assessed.v4.folds];
  const evidence = {
    positiveBothSources: full.every((row) => row.pnl > 0),
    everyChronologicalFoldPositive: folds.every((row) => row.pnl > 0),
    windowLower95PositiveBoth: full.every((row) => row.bootstrapWindowLower95 > 0),
    dayLower95PositiveBoth: full.every((row) => row.bootstrapDayLower95 > 0),
    profitFactorAtLeast1p5Both: full.every((row) => row.profitFactor == null || row.profitFactor >= 1.5),
    drawdownAtMost10Both: full.every((row) => row.maxDrawdown <= 10),
    activeWindowsAtLeast75Both: full.every((row) => row.activeWindows >= 75),
    noTakerFills: full.every((row) => row.takerFillEvents === 0),
    zeroRebate: Number(params.makerRebateRate) === 0,
    maker130Taker520: Number(params.targetMakerLatencyMs) === 130 && Number(params.takerLatencyMs) === 520,
    postOnly: params.postOnly === true,
    momentumGateExercised: name === 'momentum_control' || full.every((row) => row.residualMomentumGateRejected > 0),
  };
  return {
    name,
    params,
    evidence,
    absolutePassed: Object.values(evidence).every(Boolean),
    worstWindowLower95: round(Math.min(...full.map((row) => row.bootstrapWindowLower95))),
    worstDayLower95: round(Math.min(...full.map((row) => row.bootstrapDayLower95))),
    worstFoldPnl: round(Math.min(...folds.map((row) => row.pnl))),
    sources: assessed,
  };
});

const byCoordinate = new Map(candidates.map((row) => [
  `${Number(row.params.residualMarketMomentumLookbackS)}:${Number(row.params.residualMinMarketMomentum)}`,
  row,
]));
for (const candidate of candidates) {
  if (candidate.name === 'momentum_control') {
    candidate.neighborhood = { tested: 0, passed: 0, robust: true, neighbors: [] };
    candidate.acceptedHistorical = candidate.absolutePassed;
    continue;
  }
  const lookback = Number(candidate.params.residualMarketMomentumLookbackS);
  const threshold = Number(candidate.params.residualMinMarketMomentum);
  const neighbors = [];
  for (const coordinate of [[lookback === 5 ? 10 : 5, threshold], [lookback, threshold - .01], [lookback, threshold + .01]]) {
    const neighbor = byCoordinate.get(`${coordinate[0]}:${coordinate[1]}`);
    if (neighbor) neighbors.push({ name: neighbor.name, passed: neighbor.absolutePassed });
  }
  const passed = neighbors.filter((neighbor) => neighbor.passed).length;
  candidate.neighborhood = {
    tested: neighbors.length,
    passed,
    robust: neighbors.length >= 2 && passed / neighbors.length >= .5,
    neighbors,
  };
  candidate.acceptedHistorical = candidate.absolutePassed && candidate.neighborhood.robust;
}

const control = candidates.find((row) => row.name === 'momentum_control') || null;
for (const candidate of candidates) {
  candidate.deltaVsControl = control ? {
    v2Pnl: round(candidate.sources.v2.full.pnl - control.sources.v2.full.pnl),
    v4Pnl: round(candidate.sources.v4.full.pnl - control.sources.v4.full.pnl),
    v2Drawdown: round(candidate.sources.v2.full.maxDrawdown - control.sources.v2.full.maxDrawdown),
    v4Drawdown: round(candidate.sources.v4.full.maxDrawdown - control.sources.v4.full.maxDrawdown),
    v2ActiveWindows: candidate.sources.v2.full.activeWindows - control.sources.v2.full.activeWindows,
    v4ActiveWindows: candidate.sources.v4.full.activeWindows - control.sources.v4.full.activeWindows,
  } : null;
}

const ranked = [...candidates].sort((a, b) => Number(b.acceptedHistorical) - Number(a.acceptedHistorical)
  || Number(b.absolutePassed) - Number(a.absolutePassed)
  || b.worstWindowLower95 - a.worstWindowLower95
  || b.worstFoldPnl - a.worstFoldPnl
  || a.name.localeCompare(b.name));
const challenger = ranked.find((row) => row.name !== 'momentum_control') || null;
const promotion = {
  controlExactFrozenV2: controlEquivalence('v2'),
  controlExactFrozenV4: controlEquivalence('v4'),
  challengerAcceptedHistorical: challenger?.acceptedHistorical === true,
  challengerImprovesPnlBoth: challenger ? challenger.deltaVsControl.v2Pnl > 0 && challenger.deltaVsControl.v4Pnl > 0 : false,
  challengerDoesNotIncreaseDrawdownBoth: challenger ? challenger.deltaVsControl.v2Drawdown <= 0 && challenger.deltaVsControl.v4Drawdown <= 0 : false,
};
promotion.passed = Object.values(promotion).every((value) => typeof value === 'object' ? value.exact === true : value === true);

const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: 'History ends at the frozen v17 forward boundary. Both executable-book orientations, three fixed chronological folds, zero rebates, maker/taker latency invariants, confidence bounds, drawdown, activity, and immediate momentum-parameter neighbors are required. The disabled control must exactly reproduce frozen v17 before a challenger can be considered.',
  range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  control,
  challenger,
  promotion,
  candidates: ranked,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, control: control && { name: control.name, v2: control.sources.v2.full, v4: control.sources.v4.full },
  challenger: challenger && { name: challenger.name, acceptedHistorical: challenger.acceptedHistorical, neighborhood: challenger.neighborhood,
    deltaVsControl: challenger.deltaVsControl, v2: challenger.sources.v2.full, v4: challenger.sources.v4.full }, promotion }, null, 2));
