#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const replay = path.join(ROOT, "research/passive-maker-walkforward.mjs");
const cohort = String(process.argv[2] || "maker130");
if (cohort !== "maker130") throw new Error("legacy maker-latency cohorts are retired; use maker130");
const output = path.join(ROOT, "data/research/passive-maker-maker130-credit-floor.json");
const join = (...parts) => parts.map((part) => path.join(ROOT, part)).join(path.delimiter);
const env = {
  ...process.env,
  MAKER_L2_DIRS: join("data/lockstep-v4-top", "data/passive-maker-forward-v15/feeds/v4-l2"),
  MAKER_V2_DIRS: join("data/passive-maker-forward-v15/feeds/v2"),
  MAKER_TRADE_DIRS: join("data/passive-maker-forward-v15/feeds/market-trades"),
  MAKER_FILL_SOURCE: "trades",
  MAKER_POST_ONLY: "1",
  MAKER_POLICIES_FILE: path.join(ROOT, "research/passive-maker-maker130-baseline.json"),
  MAKER_LATENCIES: "130",
  MAKER_CREDITS: ".05,.055,.06,.065,.07,.075,.08",
  MAKER_INCLUDE_WINDOWS: "1",
  MAKER_QUIET: "1",
};
const child = spawn(process.execPath, ["--max-old-space-size=4096", replay,
  "2026-08-14T00:00:00Z", "2026-08-24T04:35:00Z", output], { cwd: ROOT, env, stdio: "inherit" });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = Number(code || 0);
});
