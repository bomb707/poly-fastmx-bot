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

test('V2 execution retains native timestamps and decimal L2 beyond the third level', () => {
  const ws = 1_787_388_900;
  const frame = {
    capturedAtMs: ws * 1000 + 23,
    clobMinRecvTsMs: ws * 1000 + 20,
    orderbookUp: { bids: [{ price: '.50', size: '9' }], asks: [
      { price: '.513', size: '4' }, { price: '.512', size: '3' },
      { price: '.511', size: '2' }, { price: '.510', size: '1' },
    ] },
    orderbookDown: { bids: [], asks: [] },
    chainlinkPrice: '77167.65252930', binanceAggPrice: '77187.92000000',
  };
  const ticks = downsampleV2Frames([frame, { ...frame, capturedAtMs: ws * 1000 + 73 }], ws);
  assert.deepEqual(ticks.map(t => t.t), [.023, .073]);
  assert.deepEqual(ticks[0].up.asks, [[.510, 1], [.511, 2], [.512, 3], [.513, 4]]);
  assert.equal(ticks[0].up.depthTs, ws * 1000 + 20);
  assert.equal(ticks[0].cl, 77167.6525293);
  assert.equal(ticks[0].bz, 77187.92);
});

test('a fully empty V2 frame is retained as an execution-state transition', () => {
  const ticks = downsampleV2Frames([{ capturedAtMs: 1000,
    orderbookUp: { bids: [], asks: [] }, orderbookDown: { bids: [], asks: [] },
  }], 0);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].upAsk, null);
  assert.deepEqual(ticks[0].up.asks, []);
});
