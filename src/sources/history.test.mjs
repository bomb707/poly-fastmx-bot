import assert from "node:assert/strict";
import test from "node:test";
import { downsampleV2Frames, hasCompleteV2Coverage, V2_REPLAY_END_TOLERANCE_SEC } from "./history.js";

test("rejects a settled but truncated V2 L2 replay", () => {
  assert.equal(hasCompleteV2Coverage({ ticks: [{ t: 0.05 }, { t: 217.259 }] }, 300), false);
});

test("accepts end-of-window V2 L2 coverage within the recorder tolerance", () => {
  assert.equal(V2_REPLAY_END_TOLERANCE_SEC, 2);
  assert.equal(hasCompleteV2Coverage({ ticks: [{ t: 0.05 }, { t: 298.001 }] }, 300), true);
});

test("rejects an empty or invalid V2 L2 replay", () => {
  assert.equal(hasCompleteV2Coverage({ ticks: [] }, 300), false);
  assert.equal(hasCompleteV2Coverage({ ticks: [{ t: null }] }, 300), false);
});

test("keeps a one-sided boundary frame for display without inventing tradeable asks", () => {
  const ws = 1_787_735_700;
  const [tick] = downsampleV2Frames([{
    capturedAtMs: ws * 1000 + 299_000,
    orderbookUp: { bids: [], asks: [{ price: 0.001, size: 100 }] },
    orderbookDown: { bids: [{ price: 0.999, size: 100 }], asks: [] },
    chainlinkPrice: 78_400,
    binanceAggPrice: 78_390,
  }], ws);
  assert.equal(tick.t, 299);
  assert.equal(tick.upPlot, 0.001);
  assert.equal(tick.dnPlot, 0.999);
  assert.equal(tick.upAsk, 0.001);
  assert.equal(tick.dnAsk, null);
  assert.equal(tick.up.depthKnown, false);
  assert.equal(tick.down.depthKnown, false);
});
