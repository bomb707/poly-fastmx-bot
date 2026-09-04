#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertAllMarketCoverage, crossSourceAvailability } from "./strict-maker-coverage.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceArg = String(process.argv[2] || "both");
if (!["v2", "v4", "both"].includes(sourceArg)) throw new Error("source must be v2, v4, or both");
const manifestFile = path.resolve(process.argv[3] || path.join(root, "data/research/strict-maker-all-markets.json"));
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const from = manifest.range?.requestedFrom;
const to = manifest.range?.requestedTo;
if (!from || !to) throw new Error("manifest range is missing");
const gapRoot = path.join(root, "data/research/strict-maker-all-market-feeds");
const exactDir = path.join(root, "data/research/strict-maker-flow-transactions");
const outputRoot = path.join(root, "data/research");
const join = (rows) => rows.map((row) => path.resolve(root, row)).join(path.delimiter);
const v2L2 = [
  "data/research/strict-maker-all-market-feeds/v2-l2",
  "data/passive-maker-forward-v15/feeds/v2-l2",
  "data/lockstep-v2-orderbooks",
];
const v4L2 = [
  "data/research/strict-maker-all-market-feeds/v4-l2",
  "data/passive-maker-forward-v15/feeds/v4-l2",
  "data/lockstep-v4-top",
];
const controls = [
  "data/research/strict-maker-all-market-feeds/v2",
  "data/passive-maker-forward-v15/feeds/v2",
];
const trades = [
  "data/research/strict-maker-all-market-feeds/market-trades",
  "data/passive-maker-forward-v15/feeds/market-trades",
];

function child(script, args, env = {}, accepted = new Set([0])) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root, env: { ...process.env, ...env }, stdio: "inherit",
    });
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => signal ? reject(new Error(`${script} killed by ${signal}`))
      : accepted.has(code) ? resolve(code) : reject(new Error(`${script} exited ${code}`)));
  });
}

async function runSource(source) {
  const output = path.join(outputRoot, `strict-maker-all-market-${source}.json`);
  const candidates = path.join(outputRoot, `strict-maker-flow-candidates-${source}.json`);
  const env = {
    MAKER_L2_DIRS: join(source === "v2" ? v2L2 : v4L2),
    MAKER_CONFIRM_L2_DIRS: join(source === "v2" ? v4L2 : v2L2),
    MAKER_V2_DIRS: join(controls),
    MAKER_TRADE_DIRS: join(trades),
    MAKER_SLUG_ALLOWLIST_FILE: manifestFile,
    MAKER_FILL_SOURCE: "trades",
    MAKER_TRADE_PRICE_MODE: "exact",
    MAKER_STRICT_CAUSAL_FILLS: "1",
    MAKER_EXACT_FLOW_DIR: exactDir,
    MAKER_STRICT_CANDIDATE_OUTPUT: candidates,
    MAKER_REQUIRE_FULL_COVERAGE: "1",
    MAKER_INCLUDE_UNAVAILABLE_WINDOWS: "1",
    MAKER_INCLUDE_SPARSE_WINDOWS: "1",
    MAKER_POLICIES_FILE: path.join(root, "research/passive-maker-strict-audit-policies.json"),
    MAKER_LATENCIES: "130,200",
    MAKER_CREDITS: ".025,.05",
    MAKER_TAKER_LATENCY_MS: "520",
    MAKER_BOOTSTRAP_SAMPLES: "20000",
    MAKER_INCLUDE_WINDOWS: "1",
    MAKER_QUIET: "1",
  };
  for (let iteration = 1; iteration <= 12; iteration++) {
    console.log(JSON.stringify({ phase: "strict-replay", source, iteration }));
    const code = await child("research/passive-maker-walkforward-v23-persistence.mjs", [from, to, output], env, new Set([0, 3]));
    const candidateReport = JSON.parse(fs.readFileSync(candidates, "utf8"));
    const unresolved = candidateReport.transactions?.length || 0;
    console.log(JSON.stringify({ phase: "strict-candidates", source, iteration, unresolved }));
    if (code === 0 && unresolved === 0) return output;
    if (!unresolved) throw new Error(`${source} returned unresolved status without candidate transactions`);
    await child("research/collect-strict-maker-flow-transactions.mjs", [candidates, exactDir]);
  }
  throw new Error(`${source} exact-flow discovery did not converge`);
}

fs.mkdirSync(gapRoot, { recursive: true });
fs.mkdirSync(exactDir, { recursive: true });
const sources = sourceArg === "both" ? ["v2", "v4"] : [sourceArg];
const outputs = [];
const reports = {};
for (const source of sources) {
  const output = await runSource(source);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  const coverage = assertAllMarketCoverage(report, manifest);
  outputs.push(output);
  reports[source] = report;
  console.log(JSON.stringify({ phase: "strict-source-coverage", source, expected: coverage.expected,
    cells: Object.fromEntries(Object.entries(coverage.cells).map(([name, cell]) => [name, {
      represented: cell.represented, evaluated: cell.evaluated, unavailable: cell.unavailable,
    }])) }));
}
const crossSource = crossSourceAvailability(reports, manifest);
await child("research/validate-strict-maker-flow-transactions.mjs", [manifestFile, exactDir,
  path.join(outputRoot, "strict-maker-flow-validation.json")]);
if (sourceArg === "both") await child("research/report-strict-maker-all-market-audit.mjs", [manifestFile,
  path.join(outputRoot, "strict-maker-all-market-v2.json"), path.join(outputRoot, "strict-maker-all-market-v4.json"),
  path.join(outputRoot, "strict-maker-all-market-audit")]);
console.log(JSON.stringify({ phase: "strict-all-market-complete", outputs, crossSource }));
