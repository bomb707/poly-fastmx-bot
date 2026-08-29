#!/usr/bin/env node
/** Forward-only dual-orderbook monitor for the frozen v15 candidate. No order client is imported. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixedUtcDateFoldPnls } from "./passive-maker-forward-folds.mjs";

const runFile = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const START_MS = Date.parse(process.env.MAKER_FORWARD_START || "2026-08-24T23:50:00Z");
const LAG_MS = Number(process.env.MAKER_FORWARD_RESOLUTION_LAG_MS || 180_000);
const POLL_MS = Math.max(30_000, Number(process.env.MAKER_FORWARD_POLL_MS || 300_000));
const LOOKBACK_MS = Math.max(600_000, Number(process.env.MAKER_FORWARD_LOOKBACK_MS || 7_200_000));
const ONCE = process.env.MAKER_FORWARD_ONCE === "1";
if (!Number.isFinite(START_MS)) throw new Error("invalid MAKER_FORWARD_START");

const DATA = path.resolve(process.env.MAKER_FORWARD_DATA_DIR || path.join(ROOT, "data/passive-maker-forward-v15"));
const V4_L2 = path.join(DATA, "feeds/v4-l2");
const V2 = path.join(DATA, "feeds/v2");
const V2_L2 = path.join(DATA, "feeds/v2-l2");
const TRADES = path.join(DATA, "feeds/market-trades");
const BATCHES = path.join(DATA, "batches");
const CHECKPOINT_V2 = path.join(DATA, "checkpoint-v2.json");
const CHECKPOINT_V4 = path.join(DATA, "checkpoint-v4.json");
const STATE = path.resolve(process.env.MAKER_FORWARD_STATE || path.join(ROOT, "data/research/passive-maker-forward-v15-state.json"));
const SELECTED = path.resolve(process.env.MAKER_FORWARD_SELECTED || path.join(ROOT, "research/passive-maker-maker130-selected-v15.json"));
const MANIFEST = path.resolve(process.env.MAKER_FORWARD_MANIFEST || path.join(ROOT, "research/passive-maker-forward-v15-manifest.json"));
const REPLAY = path.join(ROOT, "research/passive-maker-walkforward-v14.mjs");
const COLLECT = path.join(ROOT, "research/wallet-3048/collect.mjs");
const COLLECT_V4 = path.join(ROOT, "research/wallet-3048/collect-v4-e8-l2.mjs");
const COLLECT_V2 = path.join(ROOT, "research/wallet-3048/collect-v2-controls.mjs");
const COLLECT_V2_L2 = path.join(ROOT, "research/wallet-3048/collect-v2-orderbooks.mjs");
const COLLECT_TRADES = path.join(ROOT, "research/collect-market-taker-trades.mjs");
for (const dir of [DATA, V4_L2, V2, V2_L2, TRADES, BATCHES, path.dirname(STATE)]) fs.mkdirSync(dir, { recursive: true });

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = async (args, env = {}) => {
  const result = await runFile(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return String(result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "";
};

function frozenManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const files = (manifest.files || []).map((entry) => {
    const file = path.join(ROOT, entry.path);
    const actual = fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
    return { path: entry.path, expected: entry.sha256, actual, matches: entry.sha256 === actual };
  });
  return { cohortStart: manifest.cohortStart, files,
    passed: manifest.cohortStart === iso(START_MS) && files.length > 0 && files.every((entry) => entry.matches) };
}

function sourceAssessment(output, source, targetMs) {
  const rows = Object.values(output.diagnostics || {});
  const enabled = rows.filter((row) => row.params?.makerTradingEnabled !== false);
  const paused = rows.filter((row) => row.params?.makerTradingEnabled === false);
  const focus = enabled.find((row) => Number(row.params?.latencyMs) === 130 && Number(row.params?.makerCredit) === .075) || enabled[0] || {};
  const expected = Math.max(0, Math.floor((targetMs - START_MS) / 300_000));
  const loaded = Number(output.range?.loaded || 0);
  const failed = Number(output.range?.failed || 0);
  const folds = fixedUtcDateFoldPnls(focus.daily || {}, START_MS).map((fold) => ({ ...fold, pnl: +fold.pnl.toFixed(6) }));
  const requirements = {
    expectedWindowCoverage95Pct: expected > 0 && loaded / expected >= .95,
    failedWindowRateAtMost5Pct: expected > 0 && failed / expected <= .05,
    activeWindows100: Number(focus.activeWindows || 0) >= 100,
    threeCompletePositiveTenDayFolds: folds.every((fold) => fold.complete && fold.pnl > 0),
    everyEnabledStressPositive: enabled.length === 8 && enabled.every((row) => Number(row.pnl) > 0),
    everyEnabledStressLower95Positive: enabled.length === 8 && enabled.every((row) => Number(row.bootstrapWindowLower95) > 0),
    everyOverLatencyStressPaused: paused.length === 4 && paused.every((row) => Number(row.activeWindows || 0) === 0 && Number(row.pnl || 0) === 0),
    postOnlyEntryInvariant: rows.every((row) => row.params?.postOnly === true),
    zeroRebateDependency: rows.every((row) => Number(row.params?.makerRebateRate) === 0),
    takerLatency520ms: rows.every((row) => Number(row.params?.takerLatencyMs) === 520),
    boundedCompletion: rows.every((row) => Number(row.params?.pairCompleteCap) <= .99 && Number(row.params?.timeoutCompleteCap) <= 1),
  };
  return {
    source,
    coverage: { expected, discovered: output.range?.discovered || 0, loaded, failed, pct: expected ? loaded / expected * 100 : 0 },
    focus: { activeWindows: focus.activeWindows || 0, pnl: focus.pnl || 0, profitFactor: focus.profitFactor,
      maxDrawdown: focus.maxDrawdown || 0, bootstrapWindowLower95: focus.bootstrapWindowLower95,
      pairedPnl: focus.pairedPnl || 0, residualPnl: focus.residualPnl || 0 },
    folds,
    requirements,
    passed: Object.values(requirements).every(Boolean),
  };
}

let lastTarget = 0;
async function cycle() {
  const manifest = frozenManifest();
  if (!manifest.passed) throw new Error(`frozen manifest mismatch: ${JSON.stringify(manifest)}`);
  const target = Math.floor((Date.now() - LAG_MS) / 300_000) * 300_000;
  if (target <= START_MS || target <= lastTarget) return false;
  const from = Math.max(START_MS, target - LOOKBACK_MS);
  const markets = path.join(BATCHES, `markets-${Math.floor(from / 1000)}-${Math.floor(target / 1000)}.json`);
  console.log(JSON.stringify({ phase: "collect", from: iso(from), to: iso(target) }));
  await child([COLLECT, iso(from), iso(target), markets]);
  await Promise.all([
    child([COLLECT_V4, DATA, markets, iso(from), iso(target), V4_L2]),
    child([COLLECT_V2, markets, V2]),
    child([COLLECT_V2_L2, markets, V2_L2], { W3048_V2_L2_FROM: iso(from), W3048_V2_L2_TO: iso(target), W3048_V2_L2_CONCURRENCY: "3" }),
    child([COLLECT_TRADES, markets, TRADES], { MARKET_TRADES_CONCURRENCY: "4" }),
  ]);
  const replayEnv = {
    MAKER_V2_DIRS: V2,
    MAKER_TRADE_DIRS: TRADES,
    MAKER_FILL_SOURCE: "trades",
    MAKER_TRADE_PRICE_MODE: "exact",
    MAKER_POLICIES_FILE: SELECTED,
    MAKER_LATENCIES: "130,200,300",
    MAKER_CREDITS: ".025,.05,.075,.1",
    MAKER_TAKER_LATENCY_MS: "520",
    MAKER_BOOTSTRAP_SAMPLES: "20000",
    MAKER_QUIET: "1",
  };
  await child([REPLAY, iso(START_MS), iso(target), CHECKPOINT_V2], { ...replayEnv, MAKER_L2_DIRS: V2_L2 });
  await child([REPLAY, iso(START_MS), iso(target), CHECKPOINT_V4], { ...replayEnv, MAKER_L2_DIRS: V4_L2 });
  const v2 = sourceAssessment(JSON.parse(fs.readFileSync(CHECKPOINT_V2, "utf8")), "v2-native-orderbooks", target);
  const v4 = sourceAssessment(JSON.parse(fs.readFileSync(CHECKPOINT_V4, "utf8")), "v4-orderbooks", target);
  const elapsedDays = (target - START_MS) / 86_400_000;
  const assessment = {
    assessedAt: new Date().toISOString(),
    cohortStart: iso(START_MS),
    target: iso(target),
    elapsedDays,
    manifest,
    sources: { v2, v4 },
    requirements: { frozenManifestMatches: manifest.passed, elapsedDurationDays30: elapsedDays >= 30,
      nativeV2Passes: v2.passed, v4Passes: v4.passed },
  };
  assessment.passed = Object.values(assessment.requirements).every(Boolean);
  fs.writeFileSync(STATE, JSON.stringify({ schema: 1, mode: "research-only-no-orders", assessment }, null, 2) + "\n");
  lastTarget = target;
  console.log(JSON.stringify({ phase: "checkpoint", passed: assessment.passed, elapsedDays, v2: v2.focus, v4: v4.focus }));
  return true;
}

do {
  try { await cycle(); }
  catch (error) { console.error(JSON.stringify({ phase: "error", at: new Date().toISOString(), error: String(error?.stack || error) })); }
  if (ONCE) break;
  await sleep(POLL_MS);
} while (true);
