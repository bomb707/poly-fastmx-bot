import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDirectionScore,
  evaluateRelease,
  markReleaseFired,
} from "./fastmx-signal-policy.js";

test("direction score combines CLOB level, CLOB impulse, and Binance impulse", () => {
  const result = evaluateDirectionScore({
    midpoint: 0.55,
    midVelocity: 0.025,
    binanceVelocity: 10,
  });
  assert.equal(result.side, "Up");
  assert.equal(result.qualified, true);
  assert.deepEqual(result.components, { level: 1, clob: 0.5, binance: 1 });
  assert.ok(result.score > 0.8);
});

test("direction score abstains on a weak conflict", () => {
  const result = evaluateDirectionScore({
    midpoint: 0.51,
    midVelocity: -0.01,
    binanceVelocity: 0,
  });
  assert.equal(result.rawSide, "Down");
  assert.equal(result.side, null);
  assert.equal(result.qualified, false);
});

test("release fires once and re-arms only after crossing the exit band", () => {
  const model = {};
  const strong = evaluateDirectionScore({ midpoint: 0.56, midVelocity: 0.05,
    binanceVelocity: 10 });
  assert.equal(evaluateRelease(model, { direction: strong, role: "first-entry",
    clockMs: 1000, midpoint: 0.56 }).eligible, true);
  markReleaseFired(model, { role: "first-entry", side: "Up", clockMs: 1000,
    confidence: strong.confidence, midpoint: 0.56 });
  assert.equal(evaluateRelease(model, { direction: strong, role: "topup",
    clockMs: 9000, midpoint: 0.56 }).gate, "signal-latched");

  const quiet = evaluateDirectionScore({ midpoint: 0.5, midVelocity: 0,
    binanceVelocity: 0 });
  assert.equal(evaluateRelease(model, { direction: quiet, role: "topup",
    clockMs: 10_000, midpoint: 0.5 }).gate, "signal-rearmed");
  assert.equal(evaluateRelease(model, { direction: strong, role: "topup",
    clockMs: 11_000, midpoint: 0.56 }).eligible, true);
});

test("same-side top-up can re-arm on a material price step after cooldown", () => {
  const model = {};
  const first = evaluateDirectionScore({ midpoint: 0.56, midVelocity: 0.05,
    binanceVelocity: 10 });
  markReleaseFired(model, { role: "first-entry", side: "Up", clockMs: 1000,
    confidence: first.confidence, midpoint: 0.56 });
  const stepped = evaluateDirectionScore({ midpoint: 0.62, midVelocity: 0.06,
    binanceVelocity: 12 });
  const early = evaluateRelease(model, { direction: stepped, role: "topup",
    clockMs: 5000, midpoint: 0.62, roleCooldownMs: 8000,
    topupPriceStep: 0.05 });
  assert.equal(early.eligible, false);
  const release = evaluateRelease(model, { direction: stepped, role: "topup",
    clockMs: 9000, midpoint: 0.62, roleCooldownMs: 8000,
    topupPriceStep: 0.05 });
  assert.equal(release.eligible, true);
});
