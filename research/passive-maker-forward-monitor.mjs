#!/usr/bin/env node
/**
 * Forward-only research monitor for the frozen passive-maker candidate.
 *
 * This process never imports the CLOB client and never places an order. It
 * periodically collects newly resolved public v4 L2 and v2 RTDS snapshots,
 * replays the frozen policy, and writes an evidence checkpoint. A positive
 * headline PnL is not enough: the checkpoint only marks the evidence gate as
 * passed after 30 elapsed days, 100 active windows, three positive predeclared
 * ten-UTC-date folds in every enabled latency/queue stress, a positive
 * window-bootstrap lower 95% bound, exact maker/taker latency semantics, and
 * bounded complete-set taker hedges.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixedUtcDateFoldPnls } from "./passive-maker-forward-folds.mjs";

const runFile = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const START_MS = Date.parse(process.env.MAKER_FORWARD_START || "2026-08-24T03:35:00Z");
const RESOLUTION_LAG_MS = Number(process.env.MAKER_FORWARD_RESOLUTION_LAG_MS || 180_000);
const POLL_MS = Math.max(30_000, Number(process.env.MAKER_FORWARD_POLL_MS || 60_000));
const LOOKBACK_MS = Math.max(600_000, Number(process.env.MAKER_FORWARD_LOOKBACK_MS || 7_200_000));
const ONCE = process.env.MAKER_FORWARD_ONCE === "1";
if (!Number.isFinite(START_MS)) throw new Error("invalid MAKER_FORWARD_START");

const DATA = path.resolve(process.env.MAKER_FORWARD_DATA_DIR || path.join(ROOT, "data/passive-maker-forward"));
const L2 = path.join(DATA, "feeds/v4-l2"), V2 = path.join(DATA, "feeds/v2"), TRADES = path.join(DATA, "feeds/market-trades"), BATCHES = path.join(DATA, "batches");
const CHECKPOINT = path.resolve(process.env.MAKER_FORWARD_CHECKPOINT || path.join(ROOT, "data/research/passive-maker-forward.json"));
const STATE = path.resolve(process.env.MAKER_FORWARD_STATE || path.join(ROOT, "data/research/passive-maker-forward-state.json"));
const SELECTED = path.resolve(process.env.MAKER_FORWARD_SELECTED || path.join(ROOT, "research/passive-maker-maker130-baseline.json"));
// No corrected candidate is promoted yet. The deliberately absent default
// manifest keeps this monitor fail-closed until a 130ms candidate is frozen.
const MANIFEST = path.resolve(process.env.MAKER_FORWARD_MANIFEST || path.join(ROOT, "research/passive-maker-forward-maker130-manifest.json"));
const COLLECT = path.join(ROOT, "research/wallet-3048/collect.mjs");
const COLLECT_L2 = path.join(ROOT, "research/wallet-3048/collect-v4-e8-l2.mjs");
const COLLECT_V2 = path.join(ROOT, "research/wallet-3048/collect-v2-controls.mjs");
const COLLECT_TRADES = path.join(ROOT, "research/collect-market-taker-trades.mjs");
const REPLAY = path.resolve(process.env.MAKER_FORWARD_REPLAY || path.join(ROOT, "research/passive-maker-walkforward.mjs"));
for (const dir of [DATA, L2, V2, TRADES, BATCHES, path.dirname(CHECKPOINT), path.dirname(STATE)]) fs.mkdirSync(dir, { recursive: true });

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = async (args, env = {}) => {
  const result = await runFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  return String(result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "";
};

function verifyFrozenManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const files = (manifest.files || []).map((entry) => {
    const file = path.resolve(ROOT, String(entry.path || ""));
    const actualSha256 = fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
    return { path: entry.path, expectedSha256: entry.sha256, actualSha256, matches: actualSha256 === entry.sha256 };
  });
  return { path: MANIFEST, cohortStart: manifest.cohortStart, files, passed: files.length > 0
    && manifest.cohortStart === iso(START_MS) && files.every((entry) => entry.matches) };
}

function evidence(output, frozenManifest) {
  const rows = Object.values(output.diagnostics || {});
  const enabledRows = rows.filter((row) => row.params?.makerTradingEnabled !== false);
  const pausedRows = rows.filter((row) => row.params?.makerTradingEnabled === false);
  const days = new Set(rows.flatMap((row) => Object.keys(row.daily || {}))).size;
  const elapsedDays = Math.max(0, (Date.parse(output.range?.to || "") - START_MS) / 86_400_000);
  const expectedWindows = Math.max(0, Math.floor((Date.parse(output.range?.to || "") - START_MS) / 300_000));
  const loadedWindows = Number(output.range?.loaded || 0), failedWindows = Number(output.range?.failed || 0);
  const loadedWindowCoveragePct = expectedWindows > 0 ? loadedWindows / expectedWindows * 100 : 0;
  const failedWindowPct = expectedWindows > 0 ? failedWindows / expectedWindows * 100 : 100;
  const focus = rows.find((row) => row.params?.latencyMs === 130 && row.params?.makerCredit === .1) || rows[0] || {};
  const focusDays = Object.values(focus.daily || {}).map(Number);
  const profitableDayRate = focusDays.length ? focusDays.filter((pnl) => pnl > 0).length / focusDays.length : 0;
  const drawdownPctGrossBuySpend = Number(focus.grossBuySpend) > 0 ? Number(focus.maxDrawdown || 0) / Number(focus.grossBuySpend) * 100 : Infinity;
  const chronologicalForwardFolds = enabledRows.map((row) => ({
    latencyMs: row.params?.latencyMs,
    makerCredit: row.params?.makerCredit,
    folds: fixedUtcDateFoldPnls(row.daily || {}, START_MS)
      .map((fold) => ({ ...fold, pnl: Number(fold.pnl.toFixed(6)) })),
  }));
  const requirements = {
    frozenCodeManifestMatches: frozenManifest.passed,
    elapsedDurationDays30: elapsedDays >= 30,
    expectedWindowCoverage95Pct: expectedWindows > 0 && loadedWindowCoveragePct >= 95,
    failedWindowRateAtMost5Pct: expectedWindows > 0 && failedWindowPct <= 5,
    thirtyExpectedUtcDatesPresent: chronologicalForwardFolds.length > 0
      && chronologicalForwardFolds.every((row) => row.folds.every((fold) => fold.complete)),
    threeChronologicalForwardFoldsPositive: chronologicalForwardFolds.length > 0
      && chronologicalForwardFolds.every((row) => row.folds.every((fold) => fold.complete && fold.pnl > 0)),
    activeWindows100: Number(focus.activeWindows || 0) >= 100,
    everyEnabledStressPositive: enabledRows.length > 0 && enabledRows.every((row) => Number(row.pnl) > 0),
    everyEnabledStressWindowLower95Positive: enabledRows.length > 0 && enabledRows.every((row) => Number(row.bootstrapWindowLower95) > 0),
    everyPausedStressInactive: pausedRows.every((row) => Number(row.placements || 0) === 0
      && Number(row.activeWindows || 0) === 0 && Number(row.pnl || 0) === 0),
    exactTradePriceAttribution: rows.every((row) => row.params?.tradePriceMode === "exact"),
    validFiveShareMinimum: rows.every((row) => Number(row.params?.minOrderShares) >= 5 && Number(row.params?.orderSize) >= 5),
    authoritativeMakerLatency130ms: enabledRows.every((row) => Number(row.params?.effectiveMakerLatencyMs) === 130),
    configuredTakerLatency520ms: rows.every((row) => Number(row.params?.takerLatencyMs) === 520),
    takerFeesCharged: rows.every((row) => Number(row.takerShares || 0) === 0 || Number(row.fees || 0) > 0),
    boundedTakerPairCompletion: rows.every((row) => Number(row.takerBuyShares || 0) === 0
      || (row.params?.signalMode === "twoSided" && row.params?.safeHedgeEveryTick === true
        && Number(row.params?.pairCompleteCap) <= .97 && Number(row.params?.timeoutCompleteCap) <= 1.01)),
    documentedCryptoMakerRebate20Pct: rows.every((row) => Number(row.params?.makerRebateRate) === .2),
    everyEnabledStressPairedPnlPositive: enabledRows.length > 0 && enabledRows.every((row) => Number(row.pairedPnl) > 0),
    focusProfitFactorAtLeast1_25: focus.profitFactor == null ? Number(focus.pnl || 0) > 0 : Number(focus.profitFactor) >= 1.25,
    focusProfitableDayRate80Pct: profitableDayRate >= .8,
    focusDrawdownAtMost5PctGrossBuySpend: drawdownPctGrossBuySpend <= 5,
  };
  return { assessedAt: new Date().toISOString(), days, elapsedDays, frozenManifest,
    dataCoverage: { expectedWindows, discoveredWindows: Number(output.range?.discovered || 0), loadedWindows,
      failedWindows, loadedWindowCoveragePct, failedWindowPct },
    chronologicalForwardFolds, focus: {
    activeWindows: focus.activeWindows || 0, makerFillEvents: focus.makerFillEvents || 0,
    pnl: focus.pnl || 0, roiPct: focus.roiPct || 0, maxDrawdown: focus.maxDrawdown || 0,
    profitFactor: focus.profitFactor == null && Number(focus.pnl || 0) > 0 ? "Infinity" : focus.profitFactor || 0,
    pairedPnl: focus.pairedPnl || 0, residualPnl: focus.residualPnl || 0,
    grossBuySpend: focus.grossBuySpend || 0, fees: focus.fees || 0,
    makerFeeEquivalent: focus.makerFeeEquivalent || 0, makerRebate: focus.makerRebate || 0,
    takerBuyShares: focus.takerBuyShares || 0, takerSellShares: focus.takerSellShares || 0,
    makerLatencyMs: focus.params?.effectiveMakerLatencyMs || null, takerLatencyMs: focus.params?.takerLatencyMs || null,
    profitableDayRate, drawdownPctGrossBuySpend,
    bootstrapWindowLower95: focus.bootstrapWindowLower95 ?? null,
  }, requirements, passed: Object.values(requirements).every(Boolean) };
}

let lastTarget = 0;
async function cycle() {
  const frozenManifest = verifyFrozenManifest();
  if (!frozenManifest.passed) throw new Error(`frozen forward manifest mismatch: ${JSON.stringify(frozenManifest)}`);
  const target = Math.floor((Date.now() - RESOLUTION_LAG_MS) / 300_000) * 300_000;
  if (target <= START_MS || target <= lastTarget) return false;
  const from = Math.max(START_MS, target - LOOKBACK_MS);
  const source = path.join(BATCHES, `markets-${Math.floor(from / 1000)}-${Math.floor(target / 1000)}.json`);
  console.log(JSON.stringify({ phase: "collect", from: iso(from), to: iso(target) }));
  await child([COLLECT, iso(from), iso(target), source]);
  await Promise.all([
    child([COLLECT_L2, DATA, source, iso(from), iso(target), L2]),
    child([COLLECT_V2, source, V2]),
    child([COLLECT_TRADES, source, TRADES], { MARKET_TRADES_CONCURRENCY: "4" }),
  ]);
  await child([REPLAY, iso(START_MS), iso(target), CHECKPOINT], {
    MAKER_L2_DIRS: L2,
    MAKER_V2_DIRS: V2,
    MAKER_TRADE_DIRS: TRADES,
    MAKER_FILL_SOURCE: "trades",
    MAKER_POST_ONLY: "1",
    MAKER_LATENCIES: "130",
    MAKER_CREDITS: ".075,.1",
    MAKER_BOOTSTRAP_SAMPLES: "20000",
    MAKER_POLICIES_FILE: SELECTED,
    MAKER_QUIET: "1",
  });
  const output = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
  const assessment = evidence(output, frozenManifest);
  fs.writeFileSync(STATE, JSON.stringify({ schema: 1, mode: "research-only-no-orders", range: output.range, assessment }, null, 2) + "\n");
  lastTarget = target;
  console.log(JSON.stringify({ phase: "checkpoint", target: iso(target), ...assessment }));
  return true;
}

do {
  try { await cycle(); }
  catch (error) { console.error(JSON.stringify({ phase: "error", at: new Date().toISOString(), error: String(error?.stack || error) })); }
  if (ONCE) break;
  await sleep(POLL_MS);
} while (true);
