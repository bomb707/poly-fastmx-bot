#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const reference = process.argv[2] || "e654426abb9c779ee5dc764df8e805c983f91485";
const manifest = path.resolve(process.argv[3]
  || path.join(import.meta.dirname, "correctness-cohort-manifest.json"));
const dataDir = path.resolve(process.argv[4] || path.join(root, "data/wincache"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wallet3048-original-audit-"));

try {
  const archive = spawnSync("git", ["archive", reference], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(archive.stderr.toString() || `git archive failed (${archive.status})`);
  const extract = spawnSync("tar", ["-x", "-C", temporary], {
    input: archive.stdout, maxBuffer: 256 * 1024 * 1024,
  });
  if (extract.status !== 0) throw new Error(extract.stderr.toString() || `tar failed (${extract.status})`);
  const researchDir = path.join(temporary, "research/wallet-3048");
  fs.mkdirSync(researchDir, { recursive: true });
  const runner = path.join(researchDir, "audit-corrected-baseline.mjs");
  const frozenManifest = path.join(researchDir, "correctness-cohort-manifest.json");
  fs.copyFileSync(path.join(import.meta.dirname, "audit-corrected-baseline.mjs"), runner);
  fs.copyFileSync(manifest, frozenManifest);
  const run = spawnSync(process.execPath, [runner, frozenManifest, dataDir], {
    cwd: temporary, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(run.stderr || `reference audit failed (${run.status})`);
  const report = JSON.parse(run.stdout);
  const originalResult = { ...report.results[0],
    name: "original_implicit_time_at_bid_maker" };
  process.stdout.write(`${JSON.stringify({ schema: 1, reference,
    manifest: path.relative(root, manifest), dataDir,
    diagnosticOnly: true,
    warning: "This reproduces the already-inspected reference cohort; it is not a final test.",
    executionWarning: "The original code predates explicit maker policies and credits implicit time-at-bid executions.",
    result: originalResult,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
