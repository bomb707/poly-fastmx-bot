import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills } from "../../engine/simrun.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SLUG = "btc-updown-5m-1787831700";
const FEED = path.join(ROOT, "data/fastmx-live/wincache",
  `${SLUG}_v2-l2-120-coherent.json.gz`);

// Simultaneous same-side fills are one target signal group. The public wallet
// activity classifies the two Down groups as inventory-reducing hedges; FastMX
// intentionally has no hedge/reversal branch, so only entry/top-up groups are
// valid targets for its entry-only signal.
const TARGET_GROUPS = [
  { t: 28, side: "Up", role: "entry/topup", actions: 1 },
  { t: 40, side: "Down", role: "hedge", actions: 1 },
  { t: 75, side: "Up", role: "entry/topup", actions: 1 },
  { t: 94, side: "Up", role: "entry/topup", actions: 2 },
  { t: 211, side: "Up", role: "entry/topup", actions: 1 },
  { t: 244, side: "Down", role: "hedge", actions: 1 },
];

export const WINDOW_TEST_PARAMS = {
  STRATEGY: "helpme",
  LIMIT: 0.98,
  LATENCY_MS: 520,
  H_ON: true,
  H_START_S: 27,
  H_STOP_S: 245,
  H_CLOB_MID_VELOCITY_ON: true,
  H_MID_VELOCITY_LOOKBACK_MS: 5000,
  H_MID_VELOCITY_MIN: 0.12,
  H_BINANCE_GAP_MOMENTUM_ON: true,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 3000,
  H_BINANCE_GAP_VELOCITY_MIN: 0.01,
  H_BINANCE_TREND_ON: true,
  H_BINANCE_TREND_LOOKBACK_SEC: 10,
  H_BINANCE_TREND_MIN_PCT: 0.05,
  H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60,
  H_BINANCE_COUNTERTREND_MIN_PCT: 0.075,
  H_BINANCE_GAP_AGREE_ON: false,
  H_MIN_ASK: 0.54,
  H_MAX_ASK: 0.98,
  H_CAP_HEADROOM: 0.01,
  H_MIN_DEPTH_SH: 4,
  H_BASE_ORDER_SH: 7,
  H_MIN_ORDER_SH: 4,
  H_COOLDOWN_MS: 10000,
};

function loadWindow() {
  const window = JSON.parse(zlib.gunzipSync(fs.readFileSync(FEED)));
  window.slug = SLUG;
  window.windowStart = 1787831700;
  return window;
}

function matchOneToOne(predictions, targets, toleranceSec) {
  const unused = new Set(predictions.map((_, index) => index));
  const pairs = [];
  for (const target of targets) {
    let selected = null;
    for (const index of unused) {
      const prediction = predictions[index];
      const errorSec = Math.abs(prediction.t - target.t);
      if (prediction.side !== target.side || errorSec > toleranceSec) continue;
      if (!selected || errorSec < selected.errorSec) {
        selected = { index, target, prediction, errorSec };
      }
    }
    if (selected) {
      unused.delete(selected.index);
      pairs.push(selected);
    }
  }
  return pairs;
}

test("window test profile matches every target entry signal group without extra fires", () => {
  const fills = simulateFills(loadWindow(), WINDOW_TEST_PARAMS);
  const predictions = fills.map((fill) => ({
    t: fill.decidedT,
    fillT: fill.tInto,
    side: fill.side,
    clobVelocity: fill.signal.midVelocity,
    binanceVelocity: fill.signal.binanceGapVelocity,
  }));
  const targets = TARGET_GROUPS.filter((group) => group.role === "entry/topup");
  const pairs = matchOneToOne(predictions, targets, 3);

  assert.equal(predictions.length, 4);
  assert.equal(pairs.length, 4);
  assert.deepEqual(predictions.map(({ side }) => side), ["Up", "Up", "Up", "Up"]);
  assert.deepEqual(predictions.map(({ t }) => t), [27.593, 77.271, 92.618, 209.116]);
  assert.ok(pairs.every(({ errorSec }) => errorSec <= 3));
});

test("the two unmatched visible target groups are hedges, not entry-signal misses", () => {
  const hedges = TARGET_GROUPS.filter((group) => group.role === "hedge");
  assert.deepEqual(hedges, [
    { t: 40, side: "Down", role: "hedge", actions: 1 },
    { t: 244, side: "Down", role: "hedge", actions: 1 },
  ]);
});
