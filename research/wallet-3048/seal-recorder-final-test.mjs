#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSealedFinalMember, readRecorderManifest } from "./validate-recorder-cohort.mjs";

function options(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) out[argv[index].replace(/^--/, "")] = argv[++index];
  if (!out.manifest || !out["recorder-root"] || !out["freeze-commit"]) {
    throw new Error("usage: --manifest FILE --recorder-root DIR --freeze-commit COMMIT");
  }
  return out;
}
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const args = options(process.argv.slice(2));
const manifestFile = path.resolve(args.manifest);
const root = path.resolve(args["recorder-root"]);
const manifest = readRecorderManifest(manifestFile);
for (const member of manifest.members.filter((item) => isSealedFinalMember(manifest, item))) {
  const payload = path.resolve(root, member.payload || member.name);
  const instrumentation = path.resolve(root, member.instrumentation);
  if (!payload.startsWith(`${root}${path.sep}`) || !instrumentation.startsWith(`${root}${path.sep}`)) {
    throw new Error("manifest path escapes recorder root");
  }
  member.sha256 = hash(payload); // Hash bytes only; do not parse the sealed payload.
  member.instrumentationSha256 = hash(instrumentation);
}
manifest.finalTest.freezeCommit = String(args["freeze-commit"]);
manifest.finalTest.sealedAt = new Date().toISOString();
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`sealed ${manifest.members.filter((item) => isSealedFinalMember(manifest, item)).length} final-test payload checksums without parsing payloads\n`);
