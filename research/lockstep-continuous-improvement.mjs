#!/usr/bin/env node
/**
 * Daily, fail-closed Lockstep research cycle.
 *
 * It appends newly resolved v2/v4/Gamma data through the paired backtest, then
 * runs the chronological robust candidate search. It never edits runtime
 * configuration and never promotes a candidate to live execution.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const FROM = String(process.env.LOCKSTEP_RESEARCH_FROM || "2026-08-16T00:00:00Z");
const HOUR_UTC = Math.max(0, Math.min(23, Number(process.env.LOCKSTEP_RESEARCH_HOUR_UTC || 0)));
const MINUTE_UTC = Math.max(0, Math.min(59, Number(process.env.LOCKSTEP_RESEARCH_MINUTE_UTC || 20)));
const RUN_ON_START = process.env.LOCKSTEP_RESEARCH_RUN_ON_START === "1";
const ONCE = process.env.LOCKSTEP_RESEARCH_ONCE === "1";
const STATE_DIR = path.join(ROOT, "data/research/lockstep-continuous");
const FROZEN_POLICIES = [
  { label: "early-value-v1-stop120", file: "research/lockstep-early-value-v1.json" },
  { label: "early-value-stop90-challenger", file: "research/lockstep-early-value-stop90-challenger.json" },
];
fs.mkdirSync(STATE_DIR, { recursive: true });

let timer = null;
let stopping = false;

function safeToMs(now = Date.now()) {
  const resolutionLagMs = 15 * 60_000;
  return Math.floor((now - resolutionLagMs) / 300_000) * 300_000;
}

function rangeTag(toMs) {
  return `${new Date(FROM).toISOString().slice(0, 10)}_${new Date(toMs).toISOString().replaceAll(":", "-")}`;
}

function nextRunMs(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(HOUR_UTC, MINUTE_UTC, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`)));
  });
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

async function cycle() {
  const startedAt = new Date().toISOString();
  const toMs = safeToMs();
  if (toMs <= Date.parse(FROM)) throw new Error("resolution-safe cutoff does not follow research start");
  const to = new Date(toMs).toISOString();
  console.log(JSON.stringify({ phase: "continuous-start", startedAt, from: FROM, to }));

  await run(process.execPath, ["research/lockstep-v2-v4-paired-backtest.mjs", FROM, to]);
  const frozenReports = [];
  for (const policy of FROZEN_POLICIES) {
    const output = path.join(STATE_DIR, `${policy.label}-${rangeTag(toMs)}`);
    await run(process.execPath, ["research/lockstep-v2-v4-paired-backtest.mjs", FROM, to, output], {
      LOCKSTEP_PARAMS_FILE: path.join(ROOT, policy.file),
      LOCKSTEP_MAKER_LATENCY_MS: "130",
      LOCKSTEP_TAKER_LATENCY_MS: "520",
    });
    const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
    frozenReports.push({
      label: policy.label,
      policy: policy.file,
      report: path.relative(ROOT, output),
      range: report.range,
      coverage: report.coverage,
      summary: report.summary,
    });
  }
  await run(process.execPath, ["research/lockstep-v4-walkforward.mjs", FROM, to], {
    LOCKSTEP_SIZE: "50",
    LOCKSTEP_ROBUST_ONLY: "1",
    LOCKSTEP_V4_DIRS: path.join(ROOT, "data/lockstep-v4-top"),
    LOCKSTEP_V2_DIRS: path.join(ROOT, "data/lockstep-v2-top"),
  });

  const pairedDir = path.join(ROOT, "data/research", `lockstep-v2-v4-${rangeTag(toMs)}`);
  const paired = JSON.parse(fs.readFileSync(path.join(pairedDir, "report.json"), "utf8"));
  const robust = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/lockstep-v4-robust.json"), "utf8"));
  const latest = {
    schema: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    range: paired.range,
    pairedReport: path.relative(ROOT, pairedDir),
    coverage: paired.coverage,
    currentProfile: paired.summary,
    frozenPolicyReports: frozenReports,
    researchCandidate: robust.selected,
    acceptance: robust.acceptance,
    promotion: {
      enabled: false,
      reason: robust.acceptance?.passed
        ? "all automated gates passed; manual review and a frozen forward-paper cohort are still required"
        : "one or more stable-profit gates failed",
    },
  };
  writeJsonAtomic(path.join(STATE_DIR, "latest.json"), latest);
  console.log(JSON.stringify({ phase: "continuous-complete", completedAt: latest.completedAt,
    candidate: robust.selected?.label, acceptance: robust.acceptance, promotion: latest.promotion }));
}

function schedule() {
  if (stopping || ONCE) return;
  const at = nextRunMs();
  console.log(JSON.stringify({ phase: "continuous-scheduled", at: new Date(at).toISOString() }));
  timer = setTimeout(async () => {
    try { await cycle(); }
    catch (error) {
      writeJsonAtomic(path.join(STATE_DIR, "last-error.json"), {
        schema: 1,
        failedAt: new Date().toISOString(),
        error: String(error?.stack || error),
      });
      console.error(JSON.stringify({ phase: "continuous-error", error: String(error?.message || error) }));
    } finally { schedule(); }
  }, Math.max(1_000, at - Date.now()));
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  process.exit(0);
});

if (RUN_ON_START || ONCE) {
  try { await cycle(); }
  catch (error) {
    writeJsonAtomic(path.join(STATE_DIR, "last-error.json"), {
      schema: 1,
      failedAt: new Date().toISOString(),
      error: String(error?.stack || error),
    });
    console.error(JSON.stringify({ phase: "continuous-error", error: String(error?.message || error) }));
    if (ONCE) process.exitCode = 1;
  }
}
schedule();
