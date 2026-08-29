#!/usr/bin/env node
/** Select on pre-forward history and report the post-freeze cohort without tuning on it. */
import fs from "node:fs";
import path from "node:path";

const v2File = path.resolve(process.argv[2]);
const v4File = path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4] || "data/research/dual-source-neighborhood-assessment.json");
const freezeMs = Date.parse(process.argv[5] || "2026-08-24T23:50:00Z");
const v2 = JSON.parse(fs.readFileSync(v2File, "utf8"));
const v4 = JSON.parse(fs.readFileSync(v4File, "utf8"));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function bootstrapLower(values, samples = 10_000, seed = 0x3048d653) {
  if (!values.length) return null;
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
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
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const daily = new Map();
  for (const row of ordered) {
    equity += Number(row.pnl || 0); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= Number(row.pnl || 0);
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + Number(row.pnl || 0));
  }
  const sum = (field) => ordered.reduce((total, row) => total + Number(row[field] || 0), 0);
  const active = ordered.filter((row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9).length;
  return { windows: ordered.length, activeWindows: active, pnl: round(sum("pnl")), pairedPnl: round(sum("pairedPnl")),
    residualPnl: round(sum("residualPnl")), maxDrawdown: round(maxDrawdown),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    bootstrapWindowLower95: bootstrapLower(ordered.map((row) => Number(row.pnl || 0))),
    bootstrapDayLower95: bootstrapLower([...daily.values()], 10_000, 0x21be3497),
    daily: Object.fromEntries([...daily].map(([day, pnl]) => [day, round(pnl)])) };
}

function policyMap(source) {
  return new Map(Object.entries(source.diagnostics || {}).map(([key, value]) => [value.params.name, { key, params: value.params,
    rows: value.windowsDetail || [] }]));
}
const maps = { v2: policyMap(v2), v4: policyMap(v4) };
const names = [...maps.v2.keys()].filter((name) => maps.v4.has(name)).sort();
const startMs = Math.max(Date.parse(v2.range.from), Date.parse(v4.range.from));
const historicalEndMs = Math.min(freezeMs, Date.parse(v2.range.to), Date.parse(v4.range.to));
const span = historicalEndMs - startMs;
const foldBounds = [0, 1, 2, 3].map((index) => startMs + span * index / 3);

function sourceAssessment(entry) {
  const historical = entry.rows.filter((row) => row.startMs >= startMs && row.startMs < historicalEndMs);
  const fresh = entry.rows.filter((row) => row.startMs >= freezeMs);
  const folds = [0, 1, 2].map((index) => ({ index: index + 1,
    from: new Date(foldBounds[index]).toISOString(), to: new Date(foldBounds[index + 1]).toISOString(),
    ...summarize(historical.filter((row) => row.startMs >= foldBounds[index] && row.startMs < foldBounds[index + 1])) }));
  return { historical: summarize(historical), folds, fresh: summarize(fresh) };
}

const candidates = names.map((name) => {
  const params = maps.v2.get(name).params;
  const sources = { v2: sourceAssessment(maps.v2.get(name)), v4: sourceAssessment(maps.v4.get(name)) };
  const historical = [sources.v2.historical, sources.v4.historical];
  const folds = [...sources.v2.folds, ...sources.v4.folds];
  const evidence = {
    historicalPositiveBoth: historical.every((row) => row.pnl > 0),
    everyChronologicalFoldPositive: folds.every((row) => row.pnl > 0),
    bootstrapWindowLowerPositiveBoth: historical.every((row) => row.bootstrapWindowLower95 > 0),
    bootstrapDayLowerPositiveBoth: historical.every((row) => row.bootstrapDayLower95 > 0),
    profitFactorAtLeast1p2Both: historical.every((row) => row.profitFactor == null || row.profitFactor >= 1.2),
    maxDrawdownAtMost5Both: historical.every((row) => row.maxDrawdown <= 5),
    activeWindowsAtLeast75Both: historical.every((row) => row.activeWindows >= 75),
  };
  const score = Math.min(...historical.map((row) => Number(row.bootstrapWindowLower95 || -Infinity)),
    ...folds.map((row) => Number(row.pnl || -Infinity)));
  return { name, params, score: round(score), evidence, historicalPassed: Object.values(evidence).every(Boolean), sources };
});

const byCoordinates = new Map(candidates.map((row) => [`${row.params.pairQuoteCap}:${row.params.ttlMs}:${row.params.maxTimeS}`, row]));
for (const row of candidates) {
  const p = row.params, neighbors = [];
  for (const [field, values] of [["pairQuoteCap", [.92, .93, .94]], ["ttlMs", [500, 625, 750]], ["maxTimeS", [90, 120, 150]]]) {
    const index = values.indexOf(Number(p[field]));
    for (const next of [values[index - 1], values[index + 1]].filter((value) => value != null)) {
      const q = { pairQuoteCap: p.pairQuoteCap, ttlMs: p.ttlMs, maxTimeS: p.maxTimeS, [field]: next };
      const neighbor = byCoordinates.get(`${q.pairQuoteCap}:${q.ttlMs}:${q.maxTimeS}`);
      if (neighbor) neighbors.push({ name: neighbor.name, passed: neighbor.historicalPassed });
    }
  }
  row.neighborhood = { tested: neighbors.length, passed: neighbors.filter((neighbor) => neighbor.passed).length,
    passPct: neighbors.length ? round(neighbors.filter((neighbor) => neighbor.passed).length / neighbors.length * 100, 3) : null,
    robust: neighbors.length >= 3 && neighbors.filter((neighbor) => neighbor.passed).length / neighbors.length >= .6, neighbors };
  row.acceptedHistorical = row.historicalPassed && row.neighborhood.robust;
}

const ranked = [...candidates].sort((a, b) => Number(b.acceptedHistorical) - Number(a.acceptedHistorical)
  || Number(b.historicalPassed) - Number(a.historicalPassed) || b.score - a.score || a.name.localeCompare(b.name));
const selected = ranked[0] || null;
const freshEvidence = selected ? {
  enoughFreshWindows: selected.sources.v2.fresh.windows >= 100 && selected.sources.v4.fresh.windows >= 100,
  enoughFreshActiveWindows: selected.sources.v2.fresh.activeWindows >= 30 && selected.sources.v4.fresh.activeWindows >= 30,
  freshPositiveBoth: selected.sources.v2.fresh.pnl > 0 && selected.sources.v4.fresh.pnl > 0,
  freshWindowLowerPositiveBoth: selected.sources.v2.fresh.bootstrapWindowLower95 > 0 && selected.sources.v4.fresh.bootstrapWindowLower95 > 0,
  freshDayLowerPositiveBoth: selected.sources.v2.fresh.bootstrapDayLower95 > 0 && selected.sources.v4.fresh.bootstrapDayLower95 > 0,
} : {};
const result = { schema: 1, generatedAt: new Date().toISOString(), methodology: {
  selection: "parameters ranked only on history before the frozen forward start; both sources, three fixed chronological folds, confidence, drawdown, activity, and immediate-neighbor robustness are required",
  forward: "post-freeze windows are reported only after selection and cannot rescue a failed historical gate",
}, range: { start: new Date(startMs).toISOString(), historicalEnd: new Date(historicalEndMs).toISOString(), freshStart: new Date(freezeMs).toISOString(),
  end: new Date(Math.min(Date.parse(v2.range.to), Date.parse(v4.range.to))).toISOString() }, selected, freshEvidence,
  forwardPassed: selected?.acceptedHistorical === true && Object.values(freshEvidence).every(Boolean),
  candidates: ranked };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output, selected: selected && { name: selected.name, score: selected.score, historicalPassed: selected.historicalPassed,
  neighborhood: selected.neighborhood, v2: selected.sources.v2, v4: selected.sources.v4 }, freshEvidence, forwardPassed: result.forwardPassed }, null, 2));
