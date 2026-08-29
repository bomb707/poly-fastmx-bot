#!/usr/bin/env node
/** Evaluate pre-forward execution stresses for fixed maker candidates on both orderbook sources. */
import fs from "node:fs";
import path from "node:path";

const v2File = path.resolve(process.argv[2]);
const v4File = path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4] || "data/research/passive-maker-v16-execution-stress-assessment.json");
const sources = {
  v2: JSON.parse(fs.readFileSync(v2File, "utf8")),
  v4: JSON.parse(fs.readFileSync(v4File, "utf8")),
};

function group(source) {
  const grouped = new Map();
  for (const [key, row] of Object.entries(source.diagnostics || {})) {
    const name = String(row.params?.name || key);
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push({ key, ...row });
  }
  return grouped;
}

const grouped = { v2: group(sources.v2), v4: group(sources.v4) };
const names = [...grouped.v2.keys()].filter((name) => grouped.v4.has(name)).sort();
const candidates = names.map((name) => {
  const result = { name, sources: {} };
  for (const sourceName of ["v2", "v4"]) {
    const rows = grouped[sourceName].get(name);
    const enabled = rows.filter((row) => row.params?.makerTradingEnabled !== false);
    const paused = rows.filter((row) => row.params?.makerTradingEnabled === false);
    const requirements = {
      completeEnabledMatrix: enabled.length === 8,
      completePausedMatrix: paused.length === 4,
      everyEnabledStressPositive: enabled.every((row) => Number(row.pnl) > 0),
      everyEnabledStressWindowLower95Positive: enabled.every((row) => Number(row.bootstrapWindowLower95) > 0),
      everyEnabledStressProfitFactorAtLeast1p2: enabled.every((row) => row.profitFactor == null || Number(row.profitFactor) >= 1.2),
      everyEnabledStressDrawdownAtMost5: enabled.every((row) => Number(row.maxDrawdown) <= 5),
      everyOverCeilingStressPaused: paused.every((row) => Number(row.activeWindows || 0) === 0 && Number(row.pnl || 0) === 0),
      zeroRebateDependency: rows.every((row) => Number(row.params?.makerRebateRate) === 0),
      takerLatency520ms: rows.every((row) => Number(row.params?.takerLatencyMs) === 520),
      postOnlyEntry: rows.every((row) => row.params?.postOnly === true),
    };
    result.sources[sourceName] = {
      requirements,
      passed: Object.values(requirements).every(Boolean),
      enabled: enabled.map((row) => ({ latencyMs: row.params.latencyMs, makerCredit: row.params.makerCredit,
        activeWindows: row.activeWindows, pnl: row.pnl, pairedPnl: row.pairedPnl, residualPnl: row.residualPnl,
        profitFactor: row.profitFactor, maxDrawdown: row.maxDrawdown,
        bootstrapWindowLower95: row.bootstrapWindowLower95, bootstrapDayLower95: row.bootstrapDayLower95 })),
      paused: paused.map((row) => ({ latencyMs: row.params.latencyMs, makerCredit: row.params.makerCredit,
        activeWindows: row.activeWindows, pnl: row.pnl })),
    };
  }
  result.passed = result.sources.v2.passed && result.sources.v4.passed;
  return result;
});

const assessment = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  mode: "pre-forward-parameter-stress-no-orders",
  methodology: "A fixed policy must remain positive and have a positive 95% window-bootstrap lower bound at 130 and 200 ms maker latency under 2.5%, 5%, 7.5%, and 10% queue-credit assumptions on both native-v2 and v4 books. At 300 ms it must fail closed because the configured ceiling is 250 ms. Maker rebate is zero and taker completion latency is 520 ms.",
  ranges: { v2: sources.v2.range, v4: sources.v4.range },
  passed: candidates.some((candidate) => candidate.passed),
  candidates,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(assessment, null, 2) + "\n");
console.log(JSON.stringify({ output, passed: assessment.passed, candidates: candidates.map((candidate) => ({
  name: candidate.name, passed: candidate.passed,
  v2: { passed: candidate.sources.v2.passed, requirements: candidate.sources.v2.requirements },
  v4: { passed: candidate.sources.v4.passed, requirements: candidate.sources.v4.requirements },
})) }, null, 2));
