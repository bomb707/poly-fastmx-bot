#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function options(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) out[argv[index].replace(/^--/, "")] = argv[++index];
  if (!out.anchor || !out.output) throw new Error("usage: --anchor ISO_UTC_MIDNIGHT --output FILE");
  return out;
}

const args = options(process.argv.slice(2));
const anchorMs = Date.parse(args.anchor);
if (!Number.isFinite(anchorMs) || new Date(anchorMs).toISOString().slice(11) !== "00:00:00.000Z") {
  throw new Error("anchor must be an exact UTC midnight");
}
const windowSeconds = 300;
const blocks = [["burn-in", 1], ["development", 14], ["validation", 7], ["final-test", 7]];
const members = [];
let cursor = anchorMs / 1000;
for (const [split, days] of blocks) {
  for (let index = 0; index < days * 86400 / windowSeconds; index++) {
    const slug = `btc-updown-5m-${cursor}`;
    const filename = `${slug}.json`;
    members.push({ windowStart: cursor, split,
      payload: `${split === "final-test" ? "sealed-final-test" : "payloads"}/${filename}`,
      instrumentation: `instrumentation/${slug}.instrumentation.json` });
    cursor += windowSeconds;
  }
}
const manifest = { schema: 1,
  cohortId: `wallet3048-${new Date(anchorMs).toISOString().slice(0, 10)}`,
  predeclaredAt: new Date().toISOString(), anchorUtc: new Date(anchorMs).toISOString(),
  intervalSeconds: windowSeconds, retentionWindows: 10000,
  policy: "chronological membership; no profitability or activity exclusions",
  splits: Object.fromEntries(blocks),
  finalTest: { sealed: true, payloadRoot: "sealed-final-test",
    memberWindowStarts: members.filter((member) => member.split === "final-test")
      .map((member) => member.windowStart),
    freezeCommit: null, sealedAt: null }, members };
fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${members.length} chronological windows written to ${path.resolve(args.output)}\n`);
