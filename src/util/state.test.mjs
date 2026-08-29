import test from "node:test";
import assert from "node:assert/strict";
import { bookAround, createLiveState, recordBook } from "./state.js";

test("recordBook retains transitions and at most one unchanged heartbeat per second", () => {
  const state = createLiveState();
  const token = "up-token";

  for (let ts = 100_000; ts < 105_000; ts += 10) {
    recordBook(state, token, 0.49, 0.50, ts);
  }

  const history = state.bookHistory.get(token);
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((row) => row.ts), [100_000, 101_000, 102_000, 103_000, 104_000]);

  recordBook(state, token, 0.50, 0.51, 104_010);
  assert.equal(history.length, 6);
  assert.deepEqual(bookAround(state, token, 104_005), {
    before: { ts: 104_000, bestBid: 0.49, bestAsk: 0.50 },
    after: { ts: 104_010, bestBid: 0.50, bestAsk: 0.51 },
  });
});
