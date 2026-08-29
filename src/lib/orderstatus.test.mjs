// Consistency check: every stage in orderstatus.STAGES must be handled by the browser Order Status panel
// (public/index.html — stageText labels + ev reducer). Catches a stage added on the server but not the UI.
// Run: node src/lib/orderstatus.test.mjs
import fs from "node:fs";
import { STAGE_LIST } from "./orderstatus.js";
const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
let fail = 0;
for (const s of STAGE_LIST) {
  const handled = html.includes(`case "${s}":`);   // ev() + stageText() both switch on `case "<stage>":`
  console.log((handled ? "✓" : "✗ MISSING") + ` "${s}"`);
  if (!handled) fail++;
}
console.log(`\n${STAGE_LIST.length} stages, ${fail} unhandled in the browser panel`);
process.exit(fail ? 1 : 0);
