#!/usr/bin/env node
/**
 * Independent, read-only validation of the frozen v17 forward cohort.
 *
 * This is deliberately not part of the frozen manifest: it does not collect data,
 * replay a strategy, or alter the cohort. It only audits immutable configuration,
 * the historical selection record, and the latest two forward checkpoints.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixedUtcDateFoldPnls } from "./passive-maker-forward-folds.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULTS = {
  manifest: path.join(ROOT, "research/passive-maker-forward-v17-manifest.json"),
  historical: path.join(ROOT, "data/research/passive-maker-v17-selected-assessment.json"),
  state: path.join(ROOT, "data/research/passive-maker-forward-v17-state.json"),
  v2: path.join(ROOT, "data/passive-maker-forward-v17/checkpoint-v2.json"),
  v4: path.join(ROOT, "data/passive-maker-forward-v17/checkpoint-v4.json"),
  output: path.join(ROOT, "data/research/passive-maker-forward-v17-independent-audit.json"),
};

const ENABLED_LATENCIES = [130, 200];
const PAUSED_LATENCIES = [300];
const MAKER_CREDITS = [0.025, 0.05, 0.075, 0.1];
const FORWARD_ACTIVE_WINDOWS_MIN = 100;
const HISTORICAL_ACTIVE_WINDOWS_MIN = 75;
const PROFIT_FACTOR_MIN = 1.5;
const MAX_DRAWDOWN = 10;
const FORWARD_DAYS_MIN = 30;
const MAX_CHECKPOINT_AGE_MS = 2 * 60 * 60 * 1000;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const number = (value) => Number(value);
const isZero = (value) => number(value || 0) === 0;
const allTrue = (object) => Object.values(object).every(Boolean);
const cellKey = (latency, credit) => `${latency}ms/${credit.toFixed(3)}`;

export function auditManifest(manifest, root = ROOT) {
  const files = (manifest.files || []).map((entry) => {
    const file = path.resolve(root, entry.path);
    const actual = fs.existsSync(file) ? sha256(file) : null;
    return { path: entry.path, expected: entry.sha256, actual, matches: actual === entry.sha256 };
  });
  const requirements = {
    researchOnlyMode: manifest.mode === "research-only-no-orders",
    cohortStartPresent: Number.isFinite(Date.parse(manifest.cohortStart)),
    filesPresent: files.length > 0 && files.every((entry) => entry.actual !== null),
    hashesMatch: files.length > 0 && files.every((entry) => entry.matches),
  };
  return { cohortStart: manifest.cohortStart, mode: manifest.mode, files, requirements, passed: allTrue(requirements) };
}

function invariantRequirements(row, enabled) {
  const params = row.params || {};
  return {
    intendedLatency: enabled
      ? ENABLED_LATENCIES.includes(number(params.latencyMs))
      : PAUSED_LATENCIES.includes(number(params.latencyMs)),
    exactTradePriceFill: params.fillSource === "trades" && params.tradePriceMode === "exact",
    postOnly: params.postOnly === true,
    zeroRebateRate: number(params.makerRebateRate) === 0,
    takerLatency520ms: number(params.takerLatencyMs) === 520,
    noAutomaticTakerHedge: params.safeHedgeEveryTick === false
      && number(params.endLiquidateS) === 0
      && number(params.unpairedTimeoutS) === 0,
    fiveShareResidualTarget: number(params.residualTargetShares) === 5
      && number(params.residualBaseOrderShares) === 5,
  };
}

function auditEnabledCell(row, cohortStartMs) {
  const folds = fixedUtcDateFoldPnls(row.daily || {}, cohortStartMs)
    .map((fold) => ({ ...fold, pnl: +number(fold.pnl).toFixed(6) }));
  const requirements = {
    activeWindows100: number(row.activeWindows) >= FORWARD_ACTIVE_WINDOWS_MIN,
    pnlPositive: number(row.pnl) > 0,
    windowBootstrapLower95Positive: number(row.bootstrapWindowLower95) > 0,
    dayBootstrapLower95Positive: number(row.bootstrapDayLower95) > 0,
    profitFactorAtLeast1p5: Number.isFinite(number(row.profitFactor))
      && number(row.profitFactor) >= PROFIT_FACTOR_MIN,
    maxDrawdownAtMost10: number(row.maxDrawdown) <= MAX_DRAWDOWN,
    threeCompletePositiveTenDayFolds: folds.length === 3
      && folds.every((fold) => fold.complete && fold.pnl > 0),
    noTakerFills: isZero(row.takerFillEvents) && isZero(row.takerShares)
      && isZero(row.takerBuyShares) && isZero(row.takerSellShares),
    noFeesOrRebates: isZero(row.fees) && isZero(row.makerRebate),
    ...invariantRequirements(row, true),
  };
  return {
    latencyMs: number(row.params?.latencyMs),
    makerCredit: number(row.params?.makerCredit),
    activeWindows: number(row.activeWindows || 0),
    pnl: number(row.pnl || 0),
    maxDrawdown: number(row.maxDrawdown || 0),
    profitFactor: row.profitFactor === null ? null : number(row.profitFactor),
    bootstrapWindowLower95: row.bootstrapWindowLower95,
    bootstrapDayLower95: row.bootstrapDayLower95,
    folds,
    requirements,
    passed: allTrue(requirements),
  };
}

function auditPausedCell(row) {
  const requirements = {
    makerTradingDisabled: row.params?.makerTradingEnabled === false,
    noOrdersOrFills: ["placements", "cancels", "makerFillEvents", "takerFillEvents", "makerShares", "takerShares"]
      .every((field) => isZero(row[field])),
    noCapitalOrPnl: ["activeWindows", "cost", "grossBuySpend", "grossSellProceeds", "fees", "makerRebate", "pnl"]
      .every((field) => isZero(row[field])),
    ...invariantRequirements(row, false),
  };
  return {
    latencyMs: number(row.params?.latencyMs),
    makerCredit: number(row.params?.makerCredit),
    requirements,
    passed: allTrue(requirements),
  };
}

export function auditForwardSource(output, source, cohortStart, target, nowMs = Date.now()) {
  const cohortStartMs = Date.parse(cohortStart);
  const targetMs = Date.parse(target);
  const rows = Object.values(output.diagnostics || {});
  const enabledRows = rows.filter((row) => row.params?.makerTradingEnabled !== false);
  const pausedRows = rows.filter((row) => row.params?.makerTradingEnabled === false);
  const enabled = Object.fromEntries(enabledRows.map((row) => [
    cellKey(number(row.params?.latencyMs), number(row.params?.makerCredit)),
    auditEnabledCell(row, cohortStartMs),
  ]));
  const paused = Object.fromEntries(pausedRows.map((row) => [
    cellKey(number(row.params?.latencyMs), number(row.params?.makerCredit)),
    auditPausedCell(row),
  ]));
  const expectedEnabled = ENABLED_LATENCIES.flatMap((latency) => MAKER_CREDITS.map((credit) => cellKey(latency, credit)));
  const expectedPaused = PAUSED_LATENCIES.flatMap((latency) => MAKER_CREDITS.map((credit) => cellKey(latency, credit)));
  const expectedWindows = Math.max(0, Math.floor((targetMs - cohortStartMs) / 300_000));
  const loaded = number(output.range?.loaded || 0);
  const failed = number(output.range?.failed || 0);
  const requirements = {
    rangeStartsAtFrozenCohort: output.range?.from === cohortStart,
    rangeEndsAtStateTarget: output.range?.to === target,
    checkpointFreshWithin2h: Number.isFinite(targetMs) && nowMs - targetMs >= 0
      && nowMs - targetMs <= MAX_CHECKPOINT_AGE_MS,
    expectedWindowCoverage95Pct: expectedWindows > 0 && loaded / expectedWindows >= 0.95,
    failedWindowRateAtMost5Pct: expectedWindows > 0 && failed / expectedWindows <= 0.05,
    exactEnabledStressMatrix: expectedEnabled.length === Object.keys(enabled).length
      && expectedEnabled.every((key) => Object.hasOwn(enabled, key)),
    exactPausedStressMatrix: expectedPaused.length === Object.keys(paused).length
      && expectedPaused.every((key) => Object.hasOwn(paused, key)),
    everyEnabledStressPasses: expectedEnabled.every((key) => enabled[key]?.passed === true),
    everyOverLatencyStressPaused: expectedPaused.every((key) => paused[key]?.passed === true),
  };
  return {
    source,
    range: output.range,
    coverage: {
      expected: expectedWindows,
      discovered: number(output.range?.discovered || 0),
      loaded,
      failed,
      pct: expectedWindows ? +(loaded / expectedWindows * 100).toFixed(4) : 0,
    },
    enabled,
    paused,
    requirements,
    passed: allTrue(requirements),
  };
}

export function auditHistoricalSelection(assessment) {
  const selected = assessment.selected || {};
  const sources = Object.fromEntries(["v2", "v4"].map((source) => {
    const evidence = selected.sources?.[source] || {};
    const historical = evidence.historical || {};
    const folds = evidence.folds || [];
    const requirements = {
      pnlPositive: number(historical.pnl) > 0,
      windowBootstrapLower95Positive: number(historical.bootstrapWindowLower95) > 0,
      dayBootstrapLower95Positive: number(historical.bootstrapDayLower95) > 0,
      profitFactorAtLeast1p5: number(historical.profitFactor) >= PROFIT_FACTOR_MIN,
      maxDrawdownAtMost10: number(historical.maxDrawdown) <= MAX_DRAWDOWN,
      activeWindows75: number(historical.activeWindows) >= HISTORICAL_ACTIVE_WINDOWS_MIN,
      everyChronologicalFoldPositive: folds.length === 3 && folds.every((fold) => number(fold.pnl) > 0),
    };
    return [source, { historical, folds, requirements, passed: allTrue(requirements) }];
  }));
  const requirements = {
    preFreezeOnly: assessment.range?.historicalEnd === assessment.range?.freshStart,
    bothSourcesPassCoreMetrics: Object.values(sources).every((source) => source.passed),
    selectionHistoricallyApproved: selected.historicalPassed === true
      && selected.acceptedHistorical === true,
    immediateNeighborhoodRobust: selected.neighborhood?.robust === true
      && number(selected.neighborhood?.tested) > 0
      && number(selected.neighborhood?.passed) > 0,
  };
  return {
    generatedAt: assessment.generatedAt,
    range: assessment.range,
    candidate: selected.name,
    sources,
    neighborhood: selected.neighborhood,
    recordedHistoricalPassed: selected.historicalPassed === true,
    recordedAcceptedHistorical: selected.acceptedHistorical === true,
    requirements,
    passed: allTrue(requirements),
  };
}

export function buildAudit({ manifest, historical, state, v2, v4, root = ROOT, nowMs = Date.now() }) {
  const manifestAudit = auditManifest(manifest, root);
  const cohortStart = manifest.cohortStart;
  const target = state.assessment?.target;
  const elapsedDays = (Date.parse(target) - Date.parse(cohortStart)) / 86_400_000;
  const historicalAudit = auditHistoricalSelection(historical);
  const sources = {
    v2: auditForwardSource(v2, "v2-native-orderbooks", cohortStart, target, nowMs),
    v4: auditForwardSource(v4, "v4-orderbooks", cohortStart, target, nowMs),
  };
  const requirements = {
    frozenManifestPasses: manifestAudit.passed,
    stateResearchOnly: state.assessment?.mode === "research-only-no-orders",
    stateCohortMatchesManifest: state.assessment?.cohortStart === cohortStart,
    historicalSelectionPasses: historicalAudit.passed,
    elapsedDurationDays30: elapsedDays >= FORWARD_DAYS_MIN,
    v2ForwardPasses: sources.v2.passed,
    v4ForwardPasses: sources.v4.passed,
  };
  return {
    schema: 1,
    auditedAt: new Date(nowMs).toISOString(),
    verdict: allTrue(requirements) ? "validated" : "not-validated",
    methodology: {
      sourceSeparation: "V2 and V4 are alternative executable reconstructions; their PnL is never added.",
      antiLeakage: "Fresh forward evidence cannot rescue a strategy that failed its pre-freeze historical selection or neighborhood gate.",
      execution: "Exact-price public trades, conserved maker credit, zero rebate, post-only makers, 130/200ms stress, and no automatic taker hedge.",
    },
    cohort: { start: cohortStart, target, elapsedDays: +elapsedDays.toFixed(6) },
    manifest: manifestAudit,
    historical: historicalAudit,
    forward: { stateAssessedAt: state.assessment?.assessedAt, sources },
    requirements,
    passed: allTrue(requirements),
  };
}

function parseArgs(argv) {
  const result = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!Object.hasOwn(result, key) || argv[index + 1] === undefined) throw new Error(`unknown or missing argument: ${argv[index]}`);
    result[key] = path.resolve(argv[index + 1]);
  }
  return result;
}

function main() {
  const files = parseArgs(process.argv.slice(2));
  const inputs = Object.fromEntries(Object.entries(files).filter(([key]) => key !== "output"));
  for (const [name, file] of Object.entries(inputs)) {
    if (!fs.existsSync(file)) throw new Error(`missing ${name}: ${file}`);
  }
  const audit = buildAudit({
    manifest: readJson(files.manifest),
    historical: readJson(files.historical),
    state: readJson(files.state),
    v2: readJson(files.v2),
    v4: readJson(files.v4),
  });
  fs.mkdirSync(path.dirname(files.output), { recursive: true });
  fs.writeFileSync(files.output, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(ROOT, files.output), verdict: audit.verdict,
    passed: audit.passed, requirements: audit.requirements }));
  process.exitCode = audit.passed ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
