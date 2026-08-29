#!/usr/bin/env node
/**
 * Frozen forward-paper monitor for the Lockstep early-value v1 candidate.
 * It imports no order client and cannot submit CLOB orders.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixedUtcDateFoldPnls } from "./passive-maker-forward-folds.mjs";

const runFile = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const START_MS = Date.parse(process.env.LOCKSTEP_FORWARD_START || "2026-08-25T01:10:00Z");
const LAG_MS = Math.max(600_000, Number(process.env.LOCKSTEP_FORWARD_LAG_MS || 900_000));
const POLL_MS = Math.max(300_000, Number(process.env.LOCKSTEP_FORWARD_POLL_MS || 86_400_000));
const ONCE = process.env.LOCKSTEP_FORWARD_ONCE === "1";
const RUNNER = path.join(ROOT, "research/lockstep-v2-v4-paired-backtest.mjs");
const POLICY = path.join(ROOT, "research/lockstep-early-value-v1.json");
const MANIFEST = path.join(ROOT, "research/lockstep-early-value-forward-v1-manifest.json");
const DATA = path.join(ROOT, "data/lockstep-early-value-forward-v1");
const OUTPUT = path.join(DATA, "latest");
const STATE = path.join(ROOT, "data/research/lockstep-early-value-forward-v1-state.json");
if (!Number.isFinite(START_MS)) throw new Error("invalid LOCKSTEP_FORWARD_START");
for (const dir of [DATA, path.dirname(STATE)]) fs.mkdirSync(dir, { recursive: true });

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 6) => Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

function verifyManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const files = (manifest.files || []).map((entry) => {
    const file = path.join(ROOT, entry.path);
    const actual = fs.existsSync(file)
      ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      : null;
    return { ...entry, actual, matches: actual === entry.sha256 };
  });
  return {
    cohortStart: manifest.cohortStart,
    files,
    passed: manifest.cohortStart === iso(START_MS) && files.length > 0 && files.every((entry) => entry.matches),
  };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296);
}

function bootstrapLower95(values, samples = 20_000, seed = 3048) {
  if (!values.length) return null;
  const random = seeded(seed), totals = new Array(samples);
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)];
    totals[sample] = total;
  }
  totals.sort((a, b) => a - b);
  return round(totals[Math.floor(samples * .025)]);
}

function sourceAssessment(report, key, expected) {
  const summary = report.summary[key];
  const active = report.windows.filter((window) => window[key]?.status === "ok" && window[key]?.active);
  const daily = Object.fromEntries(report.daily.map((row) => [row.day, Number(row[`${key}Pnl`] || 0)]));
  const folds = fixedUtcDateFoldPnls(daily, START_MS).map((fold) => ({ ...fold, pnl: round(fold.pnl) }));
  const lower95 = bootstrapLower95(active.map((window) => Number(window[key].pnl || 0)));
  const usable = Number(summary.usableWindows || 0);
  const requirements = {
    usableCoverage95Pct: expected > 0 && usable / expected >= .95,
    activeWindows100: Number(summary.activeWindows || 0) >= 100,
    positivePnl: Number(summary.pnl || 0) > 0,
    profitFactor125: Number(summary.profitFactor || 0) >= 1.25,
    positiveWindowLower95: Number(lower95) > 0,
    drawdownAtMost5PctDeployed: Number(summary.deployed || 0) > 0
      && Number(summary.maxDrawdown || 0) / Number(summary.deployed) <= .05,
    threeCompletePositiveTenDayFolds: folds.length === 3 && folds.every((fold) => fold.complete && fold.pnl > 0),
  };
  return { key, summary, lower95, folds, requirements, passed: Object.values(requirements).every(Boolean) };
}

async function cycle() {
  const manifest = verifyManifest();
  if (!manifest.passed) throw new Error(`frozen manifest mismatch: ${JSON.stringify(manifest)}`);
  const targetMs = Math.floor((Date.now() - LAG_MS) / 300_000) * 300_000;
  if (targetMs <= START_MS) {
    writeAtomic(STATE, { schema: 1, mode: "research-only-no-orders", assessment: {
      assessedAt: new Date().toISOString(), cohortStart: iso(START_MS), target: iso(targetMs),
      passed: false, waitingForFirstResolvedWindow: true, manifest,
    } });
    return;
  }
  await runFile(process.execPath, [RUNNER, iso(START_MS), iso(targetMs), OUTPUT], {
    cwd: ROOT,
    env: { ...process.env, LOCKSTEP_PARAMS_FILE: POLICY, LOCKSTEP_MAKER_LATENCY_MS: "130", LOCKSTEP_TAKER_LATENCY_MS: "520" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const report = JSON.parse(fs.readFileSync(path.join(OUTPUT, "report.json"), "utf8"));
  const expected = Number(report.range?.expectedWindows || 0);
  const v2 = sourceAssessment(report, "v2", expected);
  const v4 = sourceAssessment(report, "v4", expected);
  const elapsedDays = (targetMs - START_MS) / 86_400_000;
  const requirements = {
    frozenManifestMatches: manifest.passed,
    elapsedDurationDays30: elapsedDays >= 30,
    gammaCoverage95Pct: expected > 0 && Number(report.coverage?.gammaVerified || 0) / expected >= .95,
    noWinnerDisagreements: Number(report.coverage?.winnerDisagreements || 0) === 0,
    nativeV2Passes: v2.passed,
    v4Passes: v4.passed,
  };
  const assessment = {
    assessedAt: new Date().toISOString(), cohortStart: iso(START_MS), target: iso(targetMs), elapsedDays,
    mode: "research-only-no-orders", manifest, coverage: report.coverage, sources: { v2, v4 }, requirements,
    passed: Object.values(requirements).every(Boolean),
  };
  writeAtomic(STATE, { schema: 1, assessment });
  console.log(JSON.stringify({ phase: "checkpoint", passed: assessment.passed, elapsedDays, v2: v2.summary, v4: v4.summary }));
}

do {
  try { await cycle(); }
  catch (error) {
    writeAtomic(STATE, { schema: 1, mode: "research-only-no-orders", failedAt: new Date().toISOString(), error: String(error?.stack || error) });
    console.error(JSON.stringify({ phase: "error", error: String(error?.message || error) }));
  }
  if (ONCE) break;
  await sleep(POLL_MS);
} while (true);
