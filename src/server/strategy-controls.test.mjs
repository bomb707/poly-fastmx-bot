import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.resolve(import.meta.dirname, "../../public/index.html"), "utf8");

test("FastMX exposes only the wallet-75cc runtime strategy", () => {
  assert.match(html, /id="strategySelect" type="hidden" value="target75cc"/);
  assert.match(html, /FastMX · wallet-75cc logic/);
  assert.doesNotMatch(html, /FastMX baseline/);
  assert.doesNotMatch(html, /id="sigBaseOrderInput"/);
  assert.doesNotMatch(html, /id="sigClobMidOn"/);
  assert.match(html, /class="cfgnum target-only"[^>]*>model residual scale/);
});

test("FastMX uses the wallet-75cc model cooldown", () => {
  assert.match(html, /id="sigTargetCooldownInput"[^>]*value="4000"/);
  assert.match(html, /T_COOLDOWN_MS:Math\.round\(clamp\(nv\("sigTargetCooldownInput",4000\)/);
  assert.doesNotMatch(html, /id="sigReleaseCooldownInput"/);
});
