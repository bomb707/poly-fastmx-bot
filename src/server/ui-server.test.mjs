import test from "node:test";
import assert from "node:assert/strict";
import { currentShadowSession, effectiveMaxSessionLoss } from "./ui-server.js";

test("market status reports the effective hot-configured session-loss limit", () => {
  assert.equal(effectiveMaxSessionLoss(() => ({ MAX_SESSION_LOSS: 25 }), 0), 25);
  assert.equal(effectiveMaxSessionLoss(() => ({ MAX_SESSION_LOSS: 0 }), 25), 0);
  assert.equal(effectiveMaxSessionLoss(() => { throw new Error("not ready"); }, 7), 7);
  assert.equal(effectiveMaxSessionLoss(() => ({ MAX_SESSION_LOSS: "bad" }), -1), 0);
});

test("normalizes the authoritative in-memory session total for the dashboard", () => {
  assert.deepEqual(
    currentShadowSession(() => ({ sessionRealized: "12.34", resolvedWindows: 3, tripped: false })),
    { sessionRealized: 12.34, resolvedWindows: 3 },
  );
  assert.equal(currentShadowSession(() => ({ sessionRealized: 2, resolvedWindows: -1 })), null);
  assert.equal(currentShadowSession(() => { throw new Error("not ready"); }), null);
});
