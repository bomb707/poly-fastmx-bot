#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const experiment = String(process.argv[2] || "v28");
const sourceArg = String(process.argv[3] || "both");
if (!['v27', 'v28'].includes(experiment)) throw new Error("experiment must be v27 or v28");
if (!['v2', 'v4', 'both'].includes(sourceArg)) throw new Error("source must be v2, v4, or both");

const relative = (...parts) => parts.map((part) => path.join(ROOT, part));
const join = (parts) => parts.join(path.delimiter);
const v2L2 = relative(
  "data/passive-maker-forward-v15/feeds/v2-l2",
  "data/lockstep-v2-orderbooks",
);
const v4L2 = relative(
  "data/passive-maker-forward-v15/feeds/v4-l2",
  "data/lockstep-v4-top",
);
const v2Controls = relative(
  "data/passive-maker-forward-v15/feeds/v2",
);
// Use the frozen forward-v15 print archive for reproducible public-trade fills.
const trades = relative(
  "data/passive-maker-forward-v15/feeds/market-trades",
);
const config = path.join(ROOT, `research/passive-maker-${experiment === 'v27'
  ? 'v27-constant-size-screen' : 'v28-combined-risk-screen'}.json`);
const replay = path.join(ROOT, "research/passive-maker-walkforward-v23-persistence.mjs");
const sources = sourceArg === 'both' ? ['v2', 'v4'] : [sourceArg];

function run(source) {
  const output = path.join(ROOT, `data/research/passive-maker-${experiment === 'v27'
    ? 'v27-constant-size-screen' : 'v28-combined-risk-screen'}-${source}.json`);
  const env = {
    ...process.env,
    MAKER_L2_DIRS: join(source === 'v2' ? v2L2 : v4L2),
    MAKER_CONFIRM_L2_DIRS: join(source === 'v2' ? v4L2 : v2L2),
    MAKER_V2_DIRS: join(v2Controls),
    MAKER_TRADE_DIRS: join(trades),
    MAKER_SLUG_ALLOWLIST_FILE: path.join(ROOT, `data/research/passive-maker-v18-momentum-${source}.json`),
    MAKER_FILL_SOURCE: "trades",
    MAKER_TRADE_PRICE_MODE: "exact",
    MAKER_POLICIES_FILE: config,
    MAKER_LATENCIES: "130,200",
    MAKER_CREDITS: ".025",
    MAKER_TAKER_LATENCY_MS: "520",
    MAKER_BOOTSTRAP_SAMPLES: "20000",
    MAKER_INCLUDE_WINDOWS: "1",
    MAKER_QUIET: "1",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=4096", replay,
      "2026-08-16T00:00:00Z", "2026-08-25T12:55:00Z", output], { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${source} killed by ${signal}`))
      : code === 0 ? resolve() : reject(new Error(`${source} exited ${code}`)));
  });
}

await Promise.all(sources.map(run));
