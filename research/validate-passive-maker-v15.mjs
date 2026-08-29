#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const jsonPath = (relative) => path.join(ROOT, relative);
const read = (relative, required = true) => {
  const file = jsonPath(relative);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`missing ${relative}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const round = (value, digits = 6) => Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
const active = (window) => Number(window?.makerShares || 0) + Number(window?.takerShares || 0) > 0;

function focus(output) {
  if (!output) return null;
  return Object.values(output.diagnostics || {}).find((row) =>
    Number(row.params?.pairQuoteCap) === .94
      && Number(row.params?.ttlMs) === 750
      && Number(row.params?.latencyMs) === 130
      && Number(row.params?.makerCredit) === .075) || null;
}

function folds(row, count = 5) {
  const windows = row?.windowsDetail || [];
  return Array.from({ length: count }, (_, index) => {
    const rows = windows.slice(Math.floor(index * windows.length / count), Math.floor((index + 1) * windows.length / count));
    return {
      index: index + 1,
      from: rows.length ? new Date(rows[0].startMs).toISOString() : null,
      to: rows.length ? new Date(rows.at(-1).startMs).toISOString() : null,
      windows: rows.length,
      activeWindows: rows.filter(active).length,
      pnl: round(rows.reduce((sum, window) => sum + Number(window.pnl || 0), 0)),
    };
  });
}

function metrics(row) {
  if (!row) return null;
  return {
    windows: row.windows,
    activeWindows: row.activeWindows,
    pnl: row.pnl,
    profitFactor: row.profitFactor == null && Number(row.pnl) > 0 ? "Infinity" : row.profitFactor,
    roiPct: row.roiPct,
    maxDrawdown: row.maxDrawdown,
    bootstrapWindowLower95: row.bootstrapWindowLower95,
    bootstrapDayLower95: row.bootstrapDayLower95,
    pairedPnl: row.pairedPnl,
    residualPnl: row.residualPnl,
    makerShares: row.makerShares,
    takerBuyShares: row.takerBuyShares,
    takerSellShares: row.takerSellShares,
    daily: row.daily,
    folds: folds(row),
  };
}

const selected = read("research/passive-maker-maker130-selected-v15.json");
const historicalV4Output = read("data/research/passive-maker-v15-historical-v4.json");
const historicalV2Output = read("data/research/passive-maker-v15-selected-historical-v2.json", false);
const latestV2Output = read("data/research/passive-maker-v15-robustness-r5-v2.json");
const latestV4Output = read("data/research/passive-maker-v15-robustness-r5-v4.json");
const stressOutput = read("data/research/passive-maker-v15-selected-historical-v4-stress.json", false);
const forwardState = read("data/research/passive-maker-forward-v15-state.json", false);
const policy = selected[0];
const historicalV2 = focus(historicalV2Output);
const historicalV4 = focus(historicalV4Output);
const latestV2 = focus(latestV2Output);
const latestV4 = focus(latestV4Output);
const stressRows = Object.values(stressOutput?.diagnostics || {});
const enabledStress = stressRows.filter((row) => row.params?.makerTradingEnabled !== false);
const pausedStress = stressRows.filter((row) => row.params?.makerTradingEnabled === false);
const pointPass = (row) => row && Number(row.pnl) > 0
  && (row.profitFactor == null || Number(row.profitFactor) >= 1.25)
  && Number(row.bootstrapWindowLower95) > 0
  && Number(row.bootstrapDayLower95) > 0;
const foldPass = (row) => row && folds(row).every((fold) => fold.activeWindows > 0 && fold.pnl > 0);

const requirements = {
  postOnlyEntryInvariant: policy?.postOnly === true,
  zeroRebateDependency: Number(policy?.makerRebateRate) === 0,
  makerLatency130ms: Number(policy?.targetMakerLatencyMs) === 130,
  takerLatency520ms: Number(policy?.takerLatencyMs) === 520,
  fiveShareMinimum: Number(policy?.orderSize) >= 5 && Number(policy?.minOrderShares) >= 5,
  boundedPairEconomics: Number(policy?.pairQuoteCap) === .94
    && Number(policy?.pairCostCap) === .94
    && Number(policy?.pairCompleteCap) <= .99
    && Number(policy?.timeoutCompleteCap) <= 1,
  historicalV4Coverage2000: Number(historicalV4Output?.range?.loaded || 0) >= 2000,
  historicalV2Coverage2000: Number(historicalV2Output?.range?.loaded || 0) >= 2000,
  historicalV4ConfidencePositive: pointPass(historicalV4),
  historicalV2ConfidencePositive: pointPass(historicalV2),
  latestNativeV2ConfidencePositive: pointPass(latestV2),
  latestV4ConfidencePositive: pointPass(latestV4),
  everyHistoricalV4FoldActivePositive: foldPass(historicalV4),
  everyHistoricalV2FoldActivePositive: foldPass(historicalV2),
  everyEnabledLatencyCreditStressPositive: enabledStress.length >= 8
    && enabledStress.every((row) => pointPass(row)),
  everyOverLatencyStressPaused: pausedStress.length > 0
    && pausedStress.every((row) => Number(row.activeWindows || 0) === 0 && Number(row.pnl || 0) === 0),
  frozenForward30DayPasses: forwardState?.assessment?.passed === true,
};
const promotionRequirements = Object.fromEntries(Object.entries(requirements)
  .filter(([name]) => name !== "frozenForward30DayPasses"));
const paperPromotionReady = Object.values(promotionRequirements).every(Boolean);
const stableProfitConfirmed = Object.values(requirements).every(Boolean);
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  candidate: policy?.name,
  policy,
  methodology: "causal two-sided post-only GTC replay; native v2 or v4 L2 queue ahead is consumed by exact-price public market-wide taker prints under FIFO volume conservation; zero maker rebate credit; taker fees and 130/520 ms decision-to-place/fill latencies included",
  historical: {
    v2: metrics(historicalV2),
    v4: metrics(historicalV4),
  },
  latestIndependent: {
    v2: metrics(latestV2),
    v4: metrics(latestV4),
  },
  stress: stressRows.map((row) => ({
    makerLatencyMs: row.params?.effectiveMakerLatencyMs,
    makerCredit: row.params?.makerCredit,
    enabled: row.params?.makerTradingEnabled !== false,
    ...metrics(row),
  })),
  requirements,
  paperPromotionReady,
  stableProfitConfirmed,
  limitation: "Backtests and short forward samples cannot guarantee profit. Live promotion remains blocked until the frozen 30-day forward gate passes.",
};
const outputFile = jsonPath("data/research/passive-maker-v15-validation.json");
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + "\n");

const money = (value) => value == null ? "n/a" : `$${Number(value).toFixed(2)}`;
const line = (label, row) => `| ${label} | ${row?.windows ?? 0} | ${row?.activeWindows ?? 0} | ${money(row?.pnl)} | ${row?.profitFactor ?? "n/a"} | ${money(row?.maxDrawdown)} | ${money(row?.bootstrapWindowLower95)} |`;
const report = `# Passive Maker v15 Validation\n\n`
  + `Generated: ${output.generatedAt}\n\n`
  + `Candidate: \`${output.candidate}\`. This is research-only and is not evidence of guaranteed future earnings.\n\n`
  + `| Dataset | Windows | Active | PnL | Profit factor | Max drawdown | Window lower 95% |\n`
  + `|---|---:|---:|---:|---:|---:|---:|\n`
  + `${line("Historical native v2", output.historical.v2)}\n`
  + `${line("Historical v4", output.historical.v4)}\n`
  + `${line("Newest native v2", output.latestIndependent.v2)}\n`
  + `${line("Newest v4", output.latestIndependent.v4)}\n\n`
  + `Paper promotion ready: **${paperPromotionReady}**  \nStable profit confirmed: **${stableProfitConfirmed}**\n\n`
  + `Stable-profit confirmation remains fail-closed until every requirement, including the untouched 30-day forward cohort, passes.\n`;
fs.writeFileSync(jsonPath("research/PASSIVE_MAKER_V15_VALIDATION_2026-08-24.md"), report);
console.log(JSON.stringify({ outputFile, paperPromotionReady, stableProfitConfirmed, requirements }, null, 2));
