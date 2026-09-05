import test from "node:test";
import assert from "node:assert/strict";
import * as helpme from "./helpme.js";
import { DEFAULT_STRATEGY, getStrategy, listStrategies } from "./index.js";

test("Helpme is the sole runtime strategy and unknown names fall back to it", () => {
  assert.equal(DEFAULT_STRATEGY, "helpme");
  assert.equal(getStrategy(), helpme);
  assert.equal(getStrategy("unknown"), helpme);
  assert.deepEqual(listStrategies(), [{ name: helpme.NAME, label: helpme.LABEL }]);
});
