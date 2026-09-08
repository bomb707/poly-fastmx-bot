#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validateRecorderWindow, readRecorderManifest,
  readVerifiedRecorderJson, isSealedFinalMember } from "./validate-recorder-cohort.mjs";

function options(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) out[argv[index].replace(/^--/, "")] = argv[++index];
  if (!out.manifest || !out["recorder-root"] || !out.output
    || !out["confirm-freeze-commit"] || out["confirm-unseal"] !== "UNSEAL_FINAL_TEST") {
    throw new Error("deliberate final evaluation requires --manifest, --recorder-root, --output, --confirm-freeze-commit, and --confirm-unseal UNSEAL_FINAL_TEST");
  }
  return out;
}

const args = options(process.argv.slice(2));
const manifest = readRecorderManifest(path.resolve(args.manifest));
if (manifest.finalTest?.sealed !== true || !manifest.finalTest?.freezeCommit
  || manifest.finalTest.freezeCommit !== args["confirm-freeze-commit"]) {
  throw new Error("final-test freeze metadata does not match the explicit confirmation");
}
const members = manifest.members.filter((member) => isSealedFinalMember(manifest, member));
if (!members.length || members.some((member) => !member.sha256)) {
  throw new Error("final-test membership and payload checksums must be sealed before evaluation");
}
const root = path.resolve(args["recorder-root"]);
const windows = members.map((member) => {
  const payload = path.resolve(root, member.payload || member.name);
  if (!payload.startsWith(`${root}${path.sep}`)) throw new Error("manifest payload escapes recorder root");
  return validateRecorderWindow(readVerifiedRecorderJson(payload, member.sha256), null,
    { allowPerformance: true });
});
const settlementPnl = windows.reduce((sum, window) => sum
  + Number(window.reconciliation.recorded?.settlementPnl || 0), 0);
const report = { schema: 1, finalTest: true, cohortId: manifest.cohortId,
  freezeCommit: manifest.finalTest.freezeCommit, evaluatedAt: new Date().toISOString(),
  summary: { windows: windows.length,
    exactParity: windows.filter((window) => window.parity.exact).length,
    reconciled: windows.filter((window) => window.reconciliation.recorded?.exact).length,
    settlementPnl }, windows };
fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
