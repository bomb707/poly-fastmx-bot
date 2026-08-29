#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { assertAllMarketCoverage, crossSourceAvailability } from "./strict-maker-coverage.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifestFile = path.resolve(process.argv[2] || path.join(root, "data/research/strict-maker-all-markets.json"));
const v2File = path.resolve(process.argv[3] || path.join(root, "data/research/strict-maker-all-market-v2.json"));
const v4File = path.resolve(process.argv[4] || path.join(root, "data/research/strict-maker-all-market-v4.json"));
const outputStem = path.resolve(process.argv[5] || path.join(root, "data/research/strict-maker-all-market-audit"));
const gammaFile = path.resolve(process.argv[6] || path.join(root, "data/research/strict-maker-gamma/gamma-verification.json"));
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const gamma = JSON.parse(fs.readFileSync(gammaFile, "utf8"));
if (gamma?.summary?.markets !== manifest.markets.length || gamma?.summary?.verified !== manifest.markets.length
  || gamma?.summary?.unresolved !== 0 || gamma?.summary?.errors !== 0
  || gamma?.summary?.conditionDisagreements !== 0 || gamma?.summary?.winnerDisagreements !== 0
  || gamma?.summary?.tokenDisagreements !== 0) throw new Error("Gamma verification is incomplete or disagrees with the manifest");
const reports = {
  v2: JSON.parse(fs.readFileSync(v2File, "utf8")),
  v4: JSON.parse(fs.readFileSync(v4File, "utf8")),
};
const coverage = Object.fromEntries(Object.entries(reports)
  .map(([source, report]) => [source, assertAllMarketCoverage(report, manifest)]));
const crossSource = crossSourceAvailability(reports, manifest);
const n = (value) => Number(value || 0);
const round = (value, digits = 6) => +Number(value || 0).toFixed(digits);
const csv = (value) => {
  const string = value == null ? "" : String(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
};

function aggregateDaily(windows) {
  const days = new Map();
  for (const window of windows) {
    const day = new Date(window.startMs).toISOString().slice(0, 10);
    let row = days.get(day);
    if (!row) {
      row = { date: day, represented: 0, evaluated: 0, unavailable: 0, active: 0, placements: 0,
        makerShares: 0, takerShares: 0, grossBuySpend: 0, grossSellProceeds: 0, fees: 0, pnl: 0 };
      days.set(day, row);
    }
    row.represented++;
    if (window.unavailable === true) row.unavailable++;
    else row.evaluated++;
    if (n(window.makerShares) + n(window.takerShares) > 0) row.active++;
    for (const field of ["placements", "makerShares", "takerShares", "grossBuySpend", "grossSellProceeds", "fees", "pnl"])
      row[field] += n(window[field]);
  }
  return [...days.values()].map((row) => ({ ...row, makerShares: round(row.makerShares), takerShares: round(row.takerShares),
    grossBuySpend: round(row.grossBuySpend), grossSellProceeds: round(row.grossSellProceeds),
    fees: round(row.fees), pnl: round(row.pnl) }));
}

const summaries = {};
const windowCsv = [["source", "configuration", "slug", "date", "start_time_utc", "evaluated", "unavailable_reason",
  "active", "placements", "maker_shares", "taker_shares", "gross_buy_spend_usd", "gross_sell_proceeds_usd",
  "fees_usd", "pnl_usd"]];
for (const [source, report] of Object.entries(reports)) {
  summaries[source] = {};
  for (const [configuration, cell] of Object.entries(report.diagnostics)) {
    const daily = aggregateDaily(cell.windowsDetail);
    const profitableDays = daily.filter((day) => day.pnl > 0).length;
    const drawdownPctOfSpend = cell.grossBuySpend > 0 ? cell.maxDrawdown / cell.grossBuySpend * 100 : 0;
    const gates = {
      pnlPositive: cell.pnl > 0,
      profitFactorAtLeast125: cell.profitFactor == null ? cell.pnl > 0 : cell.profitFactor >= 1.25,
      windowBootstrapLowerPositive: cell.bootstrapWindowLower95 > 0,
      dayBootstrapLowerPositive: cell.bootstrapDayLower95 > 0,
      profitableDaysAtLeast80Pct: daily.length > 0 && profitableDays / daily.length >= .8,
      drawdownAtMost5PctOfSpend: drawdownPctOfSpend <= 5,
      everyManifestMarketRepresented: cell.windows === manifest.markets.length,
      exactFlowDiscoveryConverged: report.strictFillAudit.unresolvedCandidateTransactions === 0,
    };
    summaries[source][configuration] = {
      representedWindows: cell.windows,
      evaluatedWindows: cell.evaluatedWindows,
      unavailableWindows: cell.unavailableWindows,
      activeWindows: cell.activeWindows,
      placements: cell.placements,
      makerShares: cell.makerShares,
      takerShares: cell.takerShares,
      grossBuySpend: cell.grossBuySpend,
      grossSellProceeds: cell.grossSellProceeds,
      fees: cell.fees,
      pnl: cell.pnl,
      roiPct: cell.roiPct,
      profitFactor: cell.profitFactor,
      maxDrawdown: cell.maxDrawdown,
      drawdownPctOfSpend: round(drawdownPctOfSpend),
      bootstrapWindowLower95: cell.bootstrapWindowLower95,
      bootstrapDayLower95: cell.bootstrapDayLower95,
      profitableDays,
      representedDays: daily.length,
      gates,
      passesHistoricalGates: Object.values(gates).every(Boolean),
      daily,
    };
    for (const window of cell.windowsDetail) windowCsv.push([
      source, configuration, window.slug, new Date(window.startMs).toISOString().slice(0, 10),
      new Date(window.startMs).toISOString(), window.unavailable === true ? "false" : "true",
      window.unavailableReason || "", n(window.makerShares) + n(window.takerShares) > 0 ? "true" : "false",
      n(window.placements), n(window.makerShares), n(window.takerShares), n(window.grossBuySpend),
      n(window.grossSellProceeds), n(window.fees), n(window.pnl),
    ]);
  }
}

const comparableCells = Object.keys(summaries.v2).filter((key) => summaries.v4[key]);
const directionalAgreement = Object.fromEntries(comparableCells.map((key) => [key, {
  v2Pnl: summaries.v2[key].pnl,
  v4Pnl: summaries.v4[key].pnl,
  sameSign: Math.sign(summaries.v2[key].pnl) === Math.sign(summaries.v4[key].pnl),
}]));
const historicalGatesPass = Object.values(summaries).every((source) =>
  Object.values(source).every((cell) => cell.passesHistoricalGates));
const sourceAgreementPass = Object.values(directionalAgreement).every((row) => row.sameSign);
const everyMarketEvaluable = crossSource.unavailableEverywhere.length === 0;
const assessment = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  range: manifest.range,
  gammaVerification: { file: gammaFile, ...gamma.summary },
  methodology: reports.v2.methodology,
  coverage,
  crossSource,
  summaries,
  directionalAgreement,
  verdict: historicalGatesPass && sourceAgreementPass && everyMarketEvaluable
    ? "HISTORICAL_GATES_PASS_REQUIRES_FORWARD_VALIDATION" : "NOT_CONFIRMED_STABLE",
  verdictChecks: { historicalGatesPass, sourceAgreementPass, everyMarketEvaluable },
};

const lines = [
  "# Strict maker all-market audit",
  "",
  `Generated: ${assessment.generatedAt}`,
  "",
  `Verdict: **${assessment.verdict}**`,
  "",
  `Manifest: ${manifest.markets.length} contiguous BTC five-minute markets from ${manifest.range.requestedFrom} through ${manifest.range.requestedTo}.`,
  `Gamma verification: ${gamma.summary.verified}/${gamma.summary.markets} resolved markets; condition, token, and winner disagreements: 0.`,
  `Cross-source evaluability: ${crossSource.evaluatedByAnySource}/${crossSource.expected}; unavailable in both sources: ${crossSource.unavailableEverywhere.length}.`,
  "No market is silently skipped: every source/configuration cell has one explicit row per manifest slug; unavailable rows remain labeled and excluded from evaluated-window claims.",
  "",
  "## Aggregate results",
  "",
  "| Source | Configuration | Eval / total | Active | Gross used | Fees | PnL | ROI | PF | Max DD | Window L95 | Day L95 | Gates |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
];
for (const [source, cells] of Object.entries(summaries)) for (const [name, row] of Object.entries(cells)) lines.push(
  `| ${source.toUpperCase()} | ${name} | ${row.evaluatedWindows}/${row.representedWindows} | ${row.activeWindows} | $${row.grossBuySpend.toFixed(2)} | $${row.fees.toFixed(2)} | $${row.pnl.toFixed(2)} | ${row.roiPct.toFixed(2)}% | ${row.profitFactor == null ? "∞" : row.profitFactor.toFixed(2)} | $${row.maxDrawdown.toFixed(2)} | $${row.bootstrapWindowLower95.toFixed(2)} | $${row.bootstrapDayLower95.toFixed(2)} | ${row.passesHistoricalGates ? "PASS" : "FAIL"} |`);
lines.push("", "## Daily results", "", "| Source | Configuration | Date | Eval / total | Active | Gross used | Fees | PnL |", "|---|---|---|---:|---:|---:|---:|---:|");
for (const [source, cells] of Object.entries(summaries)) for (const [name, row] of Object.entries(cells)) for (const day of row.daily) lines.push(
  `| ${source.toUpperCase()} | ${name} | ${day.date} | ${day.evaluated}/${day.represented} | ${day.active} | $${day.grossBuySpend.toFixed(2)} | $${day.fees.toFixed(2)} | $${day.pnl.toFixed(2)} |`);
if (crossSource.unavailableEverywhere.length) lines.push("", "## Unavailable in both order-book archives", "",
  ...crossSource.unavailableEverywhere.map((slug) => `- ${slug}`));
lines.push("", "The machine-readable JSON contains every gate and daily aggregate. The CSV contains every window for every source/configuration cell.", "");

fs.mkdirSync(path.dirname(outputStem), { recursive: true });
fs.writeFileSync(`${outputStem}.json`, JSON.stringify(assessment, null, 2) + "\n");
fs.writeFileSync(`${outputStem}.csv`, windowCsv.map((row) => row.map(csv).join(",")).join("\n") + "\n");
fs.writeFileSync(`${outputStem}.md`, lines.join("\n"));
console.log(JSON.stringify({ outputs: [`${outputStem}.json`, `${outputStem}.csv`, `${outputStem}.md`],
  verdict: assessment.verdict, crossSource }, null, 2));
