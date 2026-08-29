#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const input = {
  v2: JSON.parse(fs.readFileSync(path.resolve(process.argv[2] || "data/research/passive-maker-v19-disagreement-v2.json"), "utf8")),
  v4: JSON.parse(fs.readFileSync(path.resolve(process.argv[3] || "data/research/passive-maker-v19-disagreement-v4.json"), "utf8")),
};
const outputPath = path.resolve(process.argv[4] || "data/research/passive-maker-v19-disagreement-assessment.json");
const frozen = {
  v2: JSON.parse(fs.readFileSync(path.resolve(process.argv[5] || "data/research/passive-maker-v17-selected-v2.json"), "utf8")),
  v4: JSON.parse(fs.readFileSync(path.resolve(process.argv[6] || "data/research/passive-maker-v17-selected-v4.json"), "utf8")),
};
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;

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
  const sum = (field) => ordered.reduce((total, row) => total + Number(row[field] || 0), 0);
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const daily = new Map();
  for (const row of ordered) {
    const pnl = Number(row.pnl || 0);
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (pnl > 0) grossWin += pnl; else grossLoss -= pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + pnl);
  }
  const spend = sum("grossBuySpend"), pnl = sum("pnl");
  return {
    windows: ordered.length,
    activeWindows: ordered.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9).length,
    placements: sum("placements"), makerFillEvents: sum("makerFillEvents"), takerFillEvents: sum("takerFillEvents"),
    grossBuySpend: round(spend), pnl: round(pnl), roiPct: spend ? round(100 * pnl / spend) : 0,
    pairedPnl: round(sum("pairedPnl")), residualPnl: round(sum("residualPnl")), maxDrawdown: round(maxDrawdown),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    bootstrapWindowLower95: bootstrapLower(ordered.map((row) => Number(row.pnl || 0))),
    bootstrapDayLower95: bootstrapLower([...daily.values()], 20_000, 0x21be3497),
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])),
  };
}

const diagnostics = Object.fromEntries(Object.entries(input).map(([source, report]) => [source,
  new Map(Object.values(report.diagnostics || {}).map((entry) => [entry.params.name, entry]))]));
const names = [...diagnostics.v2.keys()].filter((name) => diagnostics.v4.has(name)).sort();
const startMs = Math.max(...Object.values(input).map((report) => Date.parse(report.range.from)));
const endMs = Math.min(...Object.values(input).map((report) => Date.parse(report.range.to)));
const foldBounds = [0, 1, 2, 3].map((index) => startMs + (endMs - startMs) * index / 3);

function assessSource(entry) {
  const rows = (entry.windowsDetail || []).filter((row) => row.startMs >= startMs && row.startMs < endMs);
  return { full: summarize(rows), folds: [0, 1, 2].map((index) => ({
    index: index + 1, from: new Date(foldBounds[index]).toISOString(), to: new Date(foldBounds[index + 1]).toISOString(),
    ...summarize(rows.filter((row) => row.startMs >= foldBounds[index] && row.startMs < foldBounds[index + 1])),
  })) };
}

function exactControl(source, control) {
  const expected = Object.values(frozen[source].diagnostics || {})[0]?.windowsDetail || [];
  const actual = control?.windowsDetail || [];
  const left = new Map(actual.map((row) => [row.slug, row])), right = new Map(expected.map((row) => [row.slug, row]));
  const slugs = new Set([...left.keys(), ...right.keys()]);
  const fields = ["pnl", "grossBuySpend", "makerShares", "takerShares", "pairedPnl", "residualPnl"];
  let missing = 0, differing = 0, maxAbsDifference = 0;
  for (const slug of slugs) {
    const a = left.get(slug), b = right.get(slug);
    if (!a || !b) { missing++; continue; }
    let changed = false;
    for (const field of fields) {
      const difference = Math.abs(Number(a[field] || 0) - Number(b[field] || 0));
      maxAbsDifference = Math.max(maxAbsDifference, difference);
      changed ||= difference > 1e-9;
    }
    differing += Number(changed);
  }
  return { expectedWindows: expected.length, controlWindows: actual.length, unionWindows: slugs.size,
    missing, differing, maxAbsDifference: round(maxAbsDifference, 12), exact: missing === 0 && differing === 0 };
}

const candidates = names.map((name) => {
  const params = diagnostics.v2.get(name).params;
  const sources = { v2: assessSource(diagnostics.v2.get(name)), v4: assessSource(diagnostics.v4.get(name)) };
  const full = [sources.v2.full, sources.v4.full], folds = [...sources.v2.folds, ...sources.v4.folds];
  const evidence = {
    positiveBothSources: full.every((row) => row.pnl > 0),
    everyChronologicalFoldPositive: folds.every((row) => row.pnl > 0),
    windowLower95PositiveBoth: full.every((row) => row.bootstrapWindowLower95 > 0),
    dayLower95PositiveBoth: full.every((row) => row.bootstrapDayLower95 > 0),
    profitFactorAtLeast1p5Both: full.every((row) => row.profitFactor == null || row.profitFactor >= 1.5),
    drawdownAtMost10Both: full.every((row) => row.maxDrawdown <= 10),
    activeWindowsAtLeast75Both: full.every((row) => row.activeWindows >= 75),
    noTakerFills: full.every((row) => row.takerFillEvents === 0), zeroRebate: Number(params.makerRebateRate) === 0,
    maker130Taker520: Number(params.targetMakerLatencyMs) === 130 && Number(params.takerLatencyMs) === 520,
    postOnly: params.postOnly === true,
  };
  return { name, params, evidence, absolutePassed: Object.values(evidence).every(Boolean),
    worstWindowLower95: round(Math.min(...full.map((row) => row.bootstrapWindowLower95))),
    worstDayLower95: round(Math.min(...full.map((row) => row.bootstrapDayLower95))),
    worstFoldPnl: round(Math.min(...folds.map((row) => row.pnl))), sources };
});

const capped = candidates.filter((row) => row.name !== "disagreement_control")
  .sort((a, b) => Number(a.params.residualMaxSpotMarketProbabilityGap) - Number(b.params.residualMaxSpotMarketProbabilityGap));
for (const candidate of candidates) {
  if (candidate.name === "disagreement_control") {
    candidate.neighborhood = { tested: 0, passed: 0, robust: true, neighbors: [] };
    candidate.acceptedHistorical = candidate.absolutePassed;
    continue;
  }
  const index = capped.indexOf(candidate);
  const neighbors = [capped[index - 1], capped[index + 1]].filter(Boolean)
    .map((row) => ({ name: row.name, passed: row.absolutePassed }));
  const passed = neighbors.filter((row) => row.passed).length;
  candidate.neighborhood = { tested: neighbors.length, passed, robust: neighbors.length === 2 && passed >= 1, neighbors };
  candidate.acceptedHistorical = candidate.absolutePassed && candidate.neighborhood.robust;
}

const control = candidates.find((row) => row.name === "disagreement_control");
for (const candidate of candidates) candidate.deltaVsControl = control ? {
  v2Pnl: round(candidate.sources.v2.full.pnl - control.sources.v2.full.pnl),
  v4Pnl: round(candidate.sources.v4.full.pnl - control.sources.v4.full.pnl),
  v2Drawdown: round(candidate.sources.v2.full.maxDrawdown - control.sources.v2.full.maxDrawdown),
  v4Drawdown: round(candidate.sources.v4.full.maxDrawdown - control.sources.v4.full.maxDrawdown),
  v2ActiveWindows: candidate.sources.v2.full.activeWindows - control.sources.v2.full.activeWindows,
  v4ActiveWindows: candidate.sources.v4.full.activeWindows - control.sources.v4.full.activeWindows,
} : null;
const ranked = [...candidates].sort((a, b) => Number(b.acceptedHistorical) - Number(a.acceptedHistorical)
  || Number(b.absolutePassed) - Number(a.absolutePassed) || b.worstWindowLower95 - a.worstWindowLower95
  || b.worstFoldPnl - a.worstFoldPnl || a.name.localeCompare(b.name));
const challenger = ranked.find((row) => row.name !== "disagreement_control");
const promotion = {
  controlExactFrozenV2: exactControl("v2", diagnostics.v2.get("disagreement_control")),
  controlExactFrozenV4: exactControl("v4", diagnostics.v4.get("disagreement_control")),
  challengerAcceptedHistorical: challenger?.acceptedHistorical === true,
  challengerImprovesPnlBoth: challenger?.deltaVsControl.v2Pnl > 0 && challenger?.deltaVsControl.v4Pnl > 0,
  challengerDoesNotIncreaseDrawdownBoth: challenger?.deltaVsControl.v2Drawdown <= 0 && challenger?.deltaVsControl.v4Drawdown <= 0,
};
promotion.passed = Object.values(promotion).every((value) => typeof value === "object" ? value.exact === true : value === true);
const output = { schema: 1, generatedAt: new Date().toISOString(), methodology:
  "Frozen-v17 history only; exact V2/V4 control equivalence, three chronological folds, confidence, activity, drawdown, zero rebates, latency invariants, and immediate disagreement-cap neighbors are required.",
  range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }, control, challenger, promotion, candidates: ranked };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ output: outputPath, control: control && { v2: control.sources.v2.full, v4: control.sources.v4.full },
  challenger: challenger && { name: challenger.name, acceptedHistorical: challenger.acceptedHistorical,
    neighborhood: challenger.neighborhood, deltaVsControl: challenger.deltaVsControl,
    v2: challenger.sources.v2, v4: challenger.sources.v4 }, promotion }, null, 2));
