import test from "node:test";
import assert from "node:assert/strict";
import { STRAT, evaluateBinanceTrendRegime, step, validateParams } from "./helpme.js";

function book(ask, bid = ask - 0.02, askSizes = [20, 20, 20]) {
  return {
    bestAsk: ask,
    bestBid: bid,
    asks: askSizes.map((size, i) => [+(ask + i * 0.01).toFixed(2), size]),
    bids: [[bid, 30], [+(bid - 0.01).toFixed(2), 30]],
  };
}

function tick(t, upAsk, downAsk, opts = {}) {
  const openBinance = Object.hasOwn(opts, "openBinance") ? opts.openBinance : 100;
  const bzPrice = Object.hasOwn(opts, "bzPrice") ? opts.bzPrice : null;
  return {
    t,
    up: book(upAsk, opts.upBid ?? upAsk - 0.02, opts.upAskSizes),
    down: book(downAsk, opts.downBid ?? downAsk - 0.02, opts.downAskSizes),
    bzPrice,
    openBinance,
    bzGap: bzPrice != null && openBinance != null ? bzPrice - openBinance : null,
  };
}

function state(extra = {}) {
  return { upShares: 0, downShares: 0, upCost: 0, downCost: 0, seq: 0, orders: [], ...extra };
}

const FAST = {
  ...STRAT,
  H_TARGET_DIRECTION_ON: false,
  H_SIGNAL_HYSTERESIS_ON: false,
  H_COOLDOWN_MS: 0,
  H_MID_VELOCITY_MIN: 0.01,
  H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5000,
  H_BINANCE_GAP_VELOCITY_MIN: 0.01,
  H_BINANCE_TREND_ON: false,
};

test("unchanged high-rate book events do not grow the momentum history", () => {
  const s = state();
  const P = { ...FAST, H_ON: false };
  for (let ms = 0; ms < 5000; ms += 10) {
    step(s, tick(ms / 1000, 0.50, ms % 20 ? 0.49 : 0.51, { bzPrice: 100 }), P, 10, ms);
  }
  assert.equal(s.helpme.history.length, 1);
  step(s, tick(5, 0.51, 0.49, { bzPrice: 101 }), P, 10, 5000);
  assert.equal(s.helpme.history.length, 2);
});

test("agreeing CLOB and Binance velocities fire an entry at inclusive thresholds", () => {
  const s = state();
  assert.equal(STRAT.H_CLOB_MID_VELOCITY_ON, true);
  assert.equal(STRAT.H_MID_VELOCITY_LOOKBACK_MS, 3000);
  assert.equal(STRAT.H_MID_VELOCITY_MIN, 0.02);
  assert.equal(STRAT.H_BINANCE_GAP_MOMENTUM_ON, true);
  assert.equal(STRAT.H_BINANCE_GAP_VELOCITY_LOOKBACK_MS, 3000);
  assert.equal(STRAT.H_BINANCE_GAP_VELOCITY_MIN, 5);
  assert.equal(STRAT.H_BINANCE_TREND_ON, true);
  assert.equal(STRAT.H_BINANCE_TREND_LOOKBACK_SEC, 30);
  assert.equal("H_BINANCE_TREND_LOOKBACK_MIN" in STRAT, false);
  assert.equal(STRAT.H_BINANCE_TREND_MIN_PCT, 0.05);
  assert.equal(STRAT.H_BINANCE_COUNTERTREND_LOOKBACK_SEC, 60);
  assert.equal(STRAT.H_BINANCE_COUNTERTREND_MIN_PCT, 0.075);
  assert.equal(STRAT.H_BINANCE_GAP_AGREE_ON, false);
  assert.equal(STRAT.H_TARGET_DIRECTION_ON, true);
  assert.equal(STRAT.H_DIRECTION_LOOKBACK_MS, 5000);
  assert.equal(STRAT.H_DIRECTION_ENTER_SCORE, 0.35);
  assert.equal(STRAT.H_DIRECTION_EXIT_SCORE, 0.15);
  assert.equal(STRAT.H_FIRST_ENTRY_EARLIEST_S, 15);
  assert.equal(STRAT.H_MAX_ACTIONS_PER_WINDOW, 7);
  assert.equal(STRAT.H_HEDGE_ON, true);
  assert.equal(STRAT.H_HEDGE_SCORE_MIN, 0.6);
  assert.equal(STRAT.H_REVERSAL_ON, true);
  assert.equal(STRAT.H_REVERSAL_SCORE_MIN, 0.95);
  assert.equal(STRAT.H_REVERSAL_CONFIRM_MS, 1000);
  assert.equal(STRAT.H_OPPOSITE_CANDIDATE_RESET_MS, 3000);
  assert.equal(STRAT.H_REVERSAL_MAX_ORDER_SH, 50);

  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), FAST, 120, 0);
  step(s, tick(2, 0.51, 0.49, { bzPrice: 100 }), FAST, 120, 2000);
  const [order] = step(s, tick(5, 0.52, 0.48, { bzPrice: 100.01 }), FAST, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.minimumShares, 7);
  assert.equal(order.limitPx, 0.53);
  assert.equal(order.budgetUsd, 3.71);
  assert.equal(order.amountMode, "usd");
  assert.equal(order.orderType, "FAK");
  assert.equal(order.liveOrderType, "GTC");
  assert.equal(order.role, "entry");
  assert.equal(order.leg, "entry");
  assert.equal(order.reason, "dual-velocity-entry");
  assert.equal(order.signal.midVelocity, 0.01);
  assert.equal(order.signal.binanceGapVelocity, 0.01);
  assert.equal(order.signal.binanceGapAgreeOn, false);
  assert.equal(order.signal.binanceWindowOpen, 100);
  assert.equal(order.signal.binanceWindowGap, 0.01);
  assert.equal(order.signal.binanceWindowGapDir, "Up");
  assert.equal("executableMs" in order.signal, false);
});

test("default target policy uses five-second scored direction plus the Binance trend regime", () => {
  const s = state();
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), STRAT, 120, 0);
  step(s, tick(27, 0.51, 0.49, { bzPrice: 100 }), STRAT, 120, 27000);
  step(s, tick(29, 0.53, 0.47, { bzPrice: 100.002 }), STRAT, 120, 29000);
  assert.deepEqual(step(s, tick(30, 0.59, 0.41, { bzPrice: 106 }), STRAT, 120, 30000), []);
  const [order] = step(s, tick(30.5, 0.59, 0.41, { bzPrice: 106 }), STRAT, 120, 30500);
  assert.equal(order.side, "Up");
  assert.equal(order.signal.midVelocity, 0.09);
  assert.equal(order.signal.binanceGapVelocity, 6);
  assert.equal(order.signal.midLookbackMs, 5000);
  assert.equal(order.signal.binanceLookbackMs, 5000);
  assert.equal(order.signal.binanceTrendOn, true);
  assert.equal(order.signal.binanceTrendLookbackSec, 30);
  assert.equal(order.signal.binanceTrendReferencePrice, 100);
  assert.equal(order.signal.binanceTrendReferenceMs, 0);
  assert.equal(order.signal.binanceTrendDir, "Up");
  assert.equal(order.signal.binanceStrongTrend, true);
  assert.equal(order.signal.binanceCountertrend, false);
  assert.equal(order.role, "first-entry");
  assert.equal(order.reason, "target-score-first-entry");
});

test("CLOB-only mode fires without Binance when gap agreement is off", () => {
  const s = state();
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false, H_BINANCE_GAP_AGREE_ON: false };
  step(s, tick(0, 0.50, 0.50, { openBinance: null }), P, 120, 0);
  const [order] = step(s, tick(5, 0.52, 0.48, { openBinance: null }), P, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.reason, "clob-mid-velocity-entry");
  assert.equal(order.signal.binanceGapVelocity, null);
});

test("Binance-only mode fires with a flat CLOB midpoint", () => {
  const s = state();
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false };
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.50, 0.50, { bzPrice: 100.01 }), P, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.reason, "binance-gap-momentum-entry");
  assert.equal(order.signal.midVelocity, 0);
});

test("at least one fast momentum source must be enabled", () => {
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: false };
  assert.throws(() => validateParams(P), /at least one FastMX fast-momentum toggle/i);
  const s = state();
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  assert.deepEqual(step(s, tick(5, 0.52, 0.48, { bzPrice: 101 }), P, 120, 5000), []);
  assert.equal(s.gateReason, "signal-toggle-required");
});

test("target policy validates its hysteresis band and sizing bounds", () => {
  assert.throws(() => validateParams({ ...STRAT, H_DIRECTION_EXIT_SCORE: 0.35 }),
    /exit < enter/i);
  assert.throws(() => validateParams({ ...STRAT, H_DIRECTION_BINANCE_SCALE: 0 }),
    /component scales/i);
  assert.throws(() => validateParams({ ...STRAT, H_TARGET_SIZE_ON: true,
    H_TARGET_SIZE_MAX_SH: 3 }), /max shares/i);
});

test("live taker transport remains configurable without changing replay FAK intent", () => {
  const s = state();
  const P = { ...FAST, H_LIVE_ORDER_TYPE: "FAK" };
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.52, 0.48, { bzPrice: 101 }), P, 120, 5000);
  assert.equal(order.orderType, "FAK");
  assert.equal(order.amountMode, "usd");
  assert.equal(order.liveOrderType, "FAK");
});

test("target sizing reshapes an entry by signed price cap while retaining fixed-USD transport", () => {
  const s = state();
  const P = { ...FAST, H_TARGET_SIZE_ON: true };
  step(s, tick(0, 0.92, 0.08, { bzPrice: 100 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.94, 0.06, { bzPrice: 101 }), P, 120, 5000);
  assert.equal(order.limitPx, 0.95);
  assert.equal(order.minimumShares, 12);
  assert.equal(order.budgetUsd, 11.4);
  assert.equal(order.amountMode, "usd");
  assert.equal(s.helpmeStatus.targetSizeOn, true);
  assert.equal(s.helpmeStatus.staticBaseShares, 7);
  assert.equal(s.helpmeStatus.targetSizedShares, 12);
});

test("target policy latches an impulse and enforces the per-window action cap", () => {
  const s = state();
  const P = { ...STRAT, H_BINANCE_TREND_ON: false,
    H_FIRST_ENTRY_EARLIEST_S: 0, H_FIRST_ENTRY_CONFIRM_MS: 0,
    H_MAX_ACTIONS_PER_WINDOW: 1, H_COOLDOWN_MS: 0 };
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  const [entry] = step(s, tick(5, 0.60, 0.40, { bzPrice: 110 }), P, 120, 5000);
  assert.equal(entry.role, "first-entry");
  assert.deepEqual(step(s, tick(6, 0.61, 0.39, { bzPrice: 111 }), P, 120, 6000), []);
  assert.equal(s.gateReason, "window-action-cap");
});

test("target policy blocks an uneconomic partial hedge", () => {
  const s = state({ upShares: 14, upCost: 7 });
  const P = { ...STRAT, H_BINANCE_TREND_ON: false, H_REVERSAL_ON: false,
    H_FIRST_ENTRY_EARLIEST_S: 0, H_HEDGE_CONFIRM_MS: 0,
    H_HEDGE_SCORE_MIN: 0.35, H_HEDGE_MIN_PAIR_EDGE: 0,
    H_COOLDOWN_MS: 0 };
  step(s, tick(0, 0.55, 0.45, { bzPrice: 101 }), P, 120, 0);
  assert.deepEqual(step(s, tick(5, 0.45, 0.55, { bzPrice: 99 }), P, 120, 5000), []);
  assert.equal(s.gateReason, "hedge-economics");
  assert.ok(s.helpmeStatus.pairEdge < 0);
});

test("target policy strong reversal crosses only to the configured residual", () => {
  const s = state({ upShares: 7, upCost: 3.5 });
  const P = { ...STRAT, H_BINANCE_TREND_ON: false,
    H_FIRST_ENTRY_EARLIEST_S: 0, H_REVERSAL_CONFIRM_MS: 0,
    H_REVERSAL_SCORE_MIN: 0.9, H_REVERSAL_MIN_PAIR_EDGE: -1,
    H_REVERSAL_MAX_WORST_LOSS_USD: 100, H_REVERSAL_RESIDUAL_SH: 4,
    H_COOLDOWN_MS: 0 };
  step(s, tick(0, 0.55, 0.45, { bzPrice: 101 }), P, 120, 0);
  const [reversal] = step(s, tick(5, 0.45, 0.55, { bzPrice: 91 }), P, 120, 5000);
  assert.equal(reversal.role, "reversal");
  assert.equal(reversal.minimumShares, 11);
  assert.equal(s.helpmeStatus.plannedPostOrientedShares, 4);
});

test("ask differential cannot override a flat enabled CLOB midpoint", () => {
  const s = state();
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), FAST, 120, 0);
  const out = step(s, tick(5, 0.52, 0.35, { upBid: 0.46, bzPrice: 200 }), FAST, 120, 5000);
  assert.deepEqual(out, []);
  assert.equal(s.gateReason, "clob-mid-velocity");
  assert.equal(s.helpmeStatus.midVelocity, 0);
});

test("each enabled velocity must independently qualify and agree", () => {
  const cases = [
    { final: null, gate: "binance-gap-warmup" },
    { final: 100, gate: "binance-gap-velocity" },
    { final: 100.005, gate: "binance-gap-velocity" },
    { final: 99, gate: "momentum-disagreement" },
  ];
  for (const { final, gate } of cases) {
    const s = state();
    step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), FAST, 120, 0);
    assert.deepEqual(step(s, tick(5, 0.52, 0.48, { bzPrice: final }), FAST, 120, 5000), []);
    assert.equal(s.gateReason, gate);
  }
});

test("Binance gap-agree toggle matches momentum direction against spot versus window open", () => {
  const base = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_GAP_AGREE_ON: true };

  const blocked = state();
  step(blocked, tick(0, 0.50, 0.50, { bzPrice: 110 }), base, 120, 0);
  assert.deepEqual(step(blocked, tick(5, 0.50, 0.50, { bzPrice: 109 }), base, 120, 5000), []);
  assert.equal(blocked.gateReason, "binance-gap-disagreement");
  assert.equal(blocked.helpmeStatus.binanceDir, "Down");
  assert.equal(blocked.helpmeStatus.binanceWindowGapDir, "Up");

  const allowed = state();
  const noAgree = { ...base, H_BINANCE_GAP_AGREE_ON: false };
  step(allowed, tick(0, 0.50, 0.50, { bzPrice: 110 }), noAgree, 120, 0);
  const [order] = step(allowed, tick(5, 0.50, 0.50, { bzPrice: 109 }), noAgree, 120, 5000);
  assert.equal(order.side, "Down");
  assert.equal(order.signal.binanceGapAgreeOn, false);
});

test("gap agreement waits for the Binance window open", () => {
  const s = state();
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_GAP_AGREE_ON: true };
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100, openBinance: null }), P, 120, 0);
  assert.deepEqual(step(s, tick(5, 0.50, 0.50, { bzPrice: 101, openBinance: null }), P, 120, 5000), []);
  assert.equal(s.gateReason, "binance-gap-agree-warmup");
});

test("trend, momentum, and gap agreement permit a real direction switch", () => {
  const s = state();
  const P = { ...FAST,
    H_CLOB_MID_VELOCITY_ON: false,
    H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5000,
    H_BINANCE_GAP_VELOCITY_MIN: 0.1,
    H_BINANCE_TREND_ON: true,
    H_BINANCE_TREND_LOOKBACK_SEC: 5,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 5,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.05,
    H_BINANCE_GAP_AGREE_ON: true,
    H_COOLDOWN_MS: 0,
  };

  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  const [up] = step(s, tick(5, 0.55, 0.45, { bzPrice: 101 }), P, 120, 5000);
  const [down] = step(s, tick(10, 0.45, 0.55, { bzPrice: 99 }), P, 120, 10000);

  assert.equal(up.side, "Up");
  assert.equal(up.signal.binanceTrendDir, "Up");
  assert.equal(up.signal.binanceWindowGapDir, "Up");
  assert.equal(down.side, "Down");
  assert.equal(down.signal.binanceTrendDir, "Down");
  assert.equal(down.signal.binanceWindowGapDir, "Down");
  assert.deepEqual(s.orders.map((order) => order.side), ["Up", "Down"]);
});

test("aligned signals remain entries while an enabled opposing signal becomes a partial hedge", () => {
  const s = state({ upShares: 21, upCost: 10 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false, H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: true, H_REVERSAL_ON: false };
  step(s, tick(0, 0.50, 0.50), P, 120, 0);

  const [first] = step(s, tick(5, 0.52, 0.48), P, 120, 5000);
  assert.equal(first.side, "Up");
  assert.equal(first.role, "entry");

  assert.deepEqual(step(s, tick(5.1, 0.52, 0.48), P, 120, 5100), []);
  assert.equal(s.gateReason, "signal-already-entered");

  const [second] = step(s, tick(5.2, 0.53, 0.47), P, 120, 5200);
  assert.equal(second.side, "Up");
  assert.equal(second.role, "entry");
  assert.equal(second.minimumShares, 7);

  const [third] = step(s, tick(10, 0.48, 0.52), P, 120, 10000);
  assert.equal(third.side, "Down");
  assert.equal(third.role, "hedge");
  assert.equal(third.leg, "hedge");
  assert.equal(third.amountMode, "shares");
  assert.equal(third.budgetUsd, null);
  assert.equal(third.minimumShares, 7);
  assert.equal(s.helpme.orderCount, 3);
});

test("a partial hedge retains the previous inventory majority", () => {
  const s = state({ upShares: 7, upCost: 3.5 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_GAP_AGREE_ON: false, H_HEDGE_ON: true, H_REVERSAL_ON: false };
  step(s, tick(0, 0.55, 0.45), P, 120, 0);
  const [hedge] = step(s, tick(5, 0.45, 0.55), P, 120, 5000);

  assert.equal(hedge.side, "Down");
  assert.equal(hedge.role, "hedge");
  assert.equal(hedge.minimumShares, 6);
  assert.equal(hedge.liveOrderType, "GTC");
  assert.equal(7 - hedge.minimumShares, 1);
  assert.equal(s.helpmeStatus.plannedPostOrientedShares, 1);
});

test("a partial hedge is skipped when the minimum order would remove the retained lead", () => {
  const s = state({ upShares: 4, upCost: 2 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_GAP_AGREE_ON: false, H_HEDGE_ON: true, H_REVERSAL_ON: false };
  step(s, tick(0, 0.55, 0.45), P, 120, 0);
  assert.deepEqual(step(s, tick(5, 0.45, 0.55), P, 120, 5000), []);
  assert.equal(s.gateReason, "hedge-retained-majority");
  assert.equal(s.helpmeStatus.maximumHedgeShares, 3);
});

test("a strong CLOB, Binance, trend, and window-gap confirmation crosses into a new residual", () => {
  const s = state({ upShares: 7, upCost: 3.5 });
  const P = { ...FAST,
    H_BINANCE_GAP_VELOCITY_MIN: 0.1,
    H_BINANCE_TREND_ON: true,
    H_BINANCE_TREND_LOOKBACK_SEC: 5,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 5,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.05,
    H_HEDGE_ON: true,
    H_REVERSAL_ON: true,
    H_REVERSAL_CONFIRM_MS: 1000,
  };
  step(s, tick(0, 0.55, 0.45, { openBinance: 100, bzPrice: 101 }), P, 120, 0);
  const [hedge] = step(s,
    tick(5, 0.45, 0.55, { openBinance: 100, bzPrice: 99 }), P, 120, 5000);
  const [reversal] = step(s,
    tick(6, 0.43, 0.45, { openBinance: 100, bzPrice: 98 }), P, 120, 6000);

  assert.equal(hedge.role, "hedge");
  assert.equal(reversal.side, "Down");
  assert.equal(reversal.role, "reversal");
  assert.equal(reversal.leg, "reversal");
  assert.equal(reversal.amountMode, "shares");
  assert.equal(reversal.minimumShares, 11);
  assert.equal(reversal.liveOrderType, "GTC");
  assert.equal(s.helpmeStatus.reversalConfirmed, true);
  assert.equal(s.helpmeStatus.reversalConfirmedMs, 1000);
  assert.equal(s.helpmeStatus.plannedPostOrientedShares, 4);
});

test("an opposite candidate pauses old-side top-ups until its reset interval expires", () => {
  const s = state({ upShares: 14, upCost: 7 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_MID_VELOCITY_LOOKBACK_MS: 1000,
    H_BINANCE_TREND_ON: false, H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: false, H_REVERSAL_ON: true,
    H_REVERSAL_CONFIRM_MS: 1000, H_OPPOSITE_CANDIDATE_RESET_MS: 3000 };
  step(s, tick(0, 0.50, 0.50), P, 120, 0);
  assert.deepEqual(step(s, tick(1, 0.48, 0.52), P, 120, 1000), []);
  assert.equal(s.gateReason, "reversal-confirmation");

  assert.deepEqual(step(s, tick(1.5, 0.52, 0.48), P, 120, 1500), []);
  assert.equal(s.gateReason, "opposite-candidate-pending");

  const [entry] = step(s, tick(5, 0.54, 0.46), P, 120, 5000);
  assert.equal(entry.side, "Up");
  assert.equal(entry.role, "entry");
});

test("large old inventory is de-risked instead of being disabled by a fixed imbalance cap", () => {
  const s = state({ upShares: 207, upCost: 100 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: false, H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: true, H_REVERSAL_ON: true, H_REVERSAL_MAX_ORDER_SH: 50 };
  step(s, tick(0, 0.55, 0.45), P, 120, 0);
  const [order] = step(s, tick(5, 0.45, 0.45), P, 120, 5000);
  assert.equal(order.side, "Down");
  assert.equal(order.role, "hedge");
  assert.equal(order.minimumShares, 7);
  assert.equal("H_REVERSAL_MAX_IMBALANCE_SH" in STRAT, false);
});

test("insufficient reversal depth falls back to a bounded hedge", () => {
  const s = state({ upShares: 14, upCost: 7 });
  const P = { ...FAST, H_BINANCE_GAP_VELOCITY_MIN: 0.1,
    H_BINANCE_TREND_ON: true, H_BINANCE_TREND_LOOKBACK_SEC: 5,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 5,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.05,
    H_HEDGE_ON: true, H_REVERSAL_ON: true, H_REVERSAL_CONFIRM_MS: 0,
    H_REVERSAL_MIN_PAIR_EDGE: -1, H_REVERSAL_MAX_WORST_LOSS_USD: 100 };
  step(s, tick(0, 0.55, 0.45, { openBinance: 100, bzPrice: 101 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.45, 0.45, {
    openBinance: 100, bzPrice: 99, downAskSizes: [7],
  }), P, 120, 5000);
  assert.equal(order.role, "hedge");
  assert.equal(order.minimumShares, 7);
  assert.equal(order.reason, "reversal-risk-bounded-partial-hedge");
});

test("without strong reversal confirmation an opposing signal hedges but never crosses", () => {
  const s = state({ upShares: 14, upCost: 7 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: false, H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: true, H_REVERSAL_ON: true };
  step(s, tick(0, 0.55, 0.45), P, 120, 0);
  const [hedge] = step(s, tick(5, 0.45, 0.55), P, 120, 5000);
  assert.equal(hedge.role, "hedge");
  assert.equal(hedge.minimumShares, 7);
  assert.ok(14 - hedge.minimumShares > 0);
});

test("hedge and reversal toggles independently suppress opposing orders", () => {
  const s = state({ upShares: 14, upCost: 7 });
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: false, H_BINANCE_GAP_AGREE_ON: false,
    H_HEDGE_ON: false, H_REVERSAL_ON: false };
  step(s, tick(0, 0.55, 0.45), P, 120, 0);
  assert.deepEqual(step(s, tick(5, 0.45, 0.55), P, 120, 5000), []);
  assert.equal(s.gateReason, "opposite-signal-disabled");
});

test("entries release immediately without executable-duration state", () => {
  const s = state();
  const P = { ...FAST, H_EXEC_RUN_MS: 60_000 };
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.52, 0.48, { bzPrice: 101 }), P, 120, 5000);
  assert.equal(order.role, "entry");
  assert.equal("executableMs" in order.signal, false);
  assert.equal("execSide" in s.helpme, false);
});

test("cooldown is the only release throttle", () => {
  const s = state();
  const P = { ...FAST, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_GAP_AGREE_ON: false, H_COOLDOWN_MS: 5000 };
  step(s, tick(0, 0.50, 0.50), P, 120, 0);
  assert.equal(step(s, tick(5, 0.52, 0.48), P, 120, 5000).length, 1);
  assert.deepEqual(step(s, tick(6, 0.53, 0.47), P, 120, 6000), []);
  assert.equal(s.gateReason, "cooldown");
  assert.equal(s.helpmeStatus.cooldownRemainingMs, 4000);
  assert.equal(step(s, tick(10, 0.54, 0.46), P, 120, 10000).length, 1);
  assert.equal(STRAT.H_COOLDOWN_MS, 1000);
});

test("poly-mom trend regime keeps a fast signal that follows a strong trend", () => {
  const s = state();
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_TREND_ON: true,
    H_BINANCE_TREND_LOOKBACK_SEC: 5, H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60, H_BINANCE_COUNTERTREND_MIN_PCT: 0.075 };
  step(s, tick(0, 0.50, 0.50, { openBinance: 100.2, bzPrice: 100 }), P, 120, 0);
  const [order] = step(s, tick(5, 0.50, 0.50, { openBinance: 100.2,
    bzPrice: 101 }), P, 120, 5000);
  assert.equal(order.side, "Up");
  assert.equal(order.signal.binanceTrendPct, 1);
  assert.equal(order.signal.binanceTrendDir, "Up");
  assert.equal(order.signal.binanceStrongTrend, true);
  assert.equal(order.signal.binanceCountertrend, false);
  assert.equal(order.signal.binanceCountertrendConfirmed, true);
});

test("poly-mom trend regime rejects a short pullback against a strong trend", () => {
  const s = state();
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_TREND_ON: true,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 3000, H_BINANCE_GAP_VELOCITY_MIN: 0.1,
    H_BINANCE_TREND_LOOKBACK_SEC: 30, H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.075, H_START_S: 60 };
  step(s, tick(0, 0.50, 0.50, { openBinance: 100.2, bzPrice: 100.5 }), P, 120, 0);
  step(s, tick(30, 0.50, 0.50, { openBinance: 100.2, bzPrice: 100 }), P, 120, 30000);
  step(s, tick(57, 0.50, 0.50, { openBinance: 100.2, bzPrice: 101 }), P, 120, 57000);
  assert.deepEqual(step(s, tick(60, 0.50, 0.50, { openBinance: 100.2,
    bzPrice: 100.5 }), P, 120, 60000), []);
  assert.equal(s.gateReason, "binance-countertrend-confirmation");
  assert.equal(s.helpmeStatus.binanceCountertrend, true);
  assert.equal(s.helpmeStatus.binanceCountertrendMomentumPct, 0);
});

test("poly-mom trend regime accepts a sustained confirmed countertrend move", () => {
  const s = state();
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_TREND_ON: true,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 3000, H_BINANCE_GAP_VELOCITY_MIN: 0.1,
    H_BINANCE_TREND_LOOKBACK_SEC: 30, H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_COUNTERTREND_LOOKBACK_SEC: 60,
    H_BINANCE_COUNTERTREND_MIN_PCT: 0.075, H_START_S: 60 };
  step(s, tick(0, 0.50, 0.50, { openBinance: 100.2, bzPrice: 101.5 }), P, 120, 0);
  step(s, tick(30, 0.50, 0.50, { openBinance: 100.2, bzPrice: 100 }), P, 120, 30000);
  step(s, tick(57, 0.50, 0.50, { openBinance: 100.2, bzPrice: 101 }), P, 120, 57000);
  const [order] = step(s, tick(60, 0.50, 0.50, { openBinance: 100.2,
    bzPrice: 100.5 }), P, 120, 60000);
  assert.equal(order.side, "Down");
  assert.equal(order.signal.binanceCountertrend, true);
  assert.equal(order.signal.binanceCountertrendConfirmed, true);
  assert.ok(order.signal.binanceFastMomentumPct <= -0.075);
  assert.ok(order.signal.binanceCountertrendMomentumPct <= -0.075);
});

test("poly-mom trend regime falls back to the fast trigger when trend history is unavailable", () => {
  const result = evaluateBinanceTrendRegime({
    enabled: true, currentWindowOpen: 100, trendReferenceOpen: null,
    trendThresholdPct: 0.05, fastMomentumPct: -0.02, fastThresholdPct: 0.01,
    countertrendMomentumPct: null, countertrendThresholdPct: 0.075,
  });
  assert.equal(result.trendAvailable, false);
  assert.equal(result.strongTrend, false);
  assert.equal(result.passes, true);
});

test("missing momentum remains missing inside the Binance trend regime", () => {
  const result = evaluateBinanceTrendRegime({
    enabled: true,
    currentWindowOpen: 100,
    trendReferenceOpen: 99,
    fastMomentumPct: null,
    countertrendMomentumPct: null,
  });
  assert.equal(result.fastDirection, null);
  assert.equal(result.fastMomentumPct, null);
  assert.equal(result.countertrendMomentumPct, null);
  assert.equal(result.countertrend, false);
  assert.equal(result.effectiveMomentumPct, null);
});

test("Binance trend is a regime and cannot operate as a standalone direction source", () => {
  const P = { ...FAST, H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_GAP_MOMENTUM_ON: false,
    H_BINANCE_TREND_ON: true };
  assert.throws(() => validateParams(P), /fast-momentum toggle/i);
  const s = state();
  step(s, tick(0, 0.50, 0.50, { bzPrice: 100 }), P, 120, 0);
  assert.equal(s.gateReason, "signal-toggle-required");
});

test("removed action and release controls are absent from the active strategy config", () => {
  for (const key of [
    "H_EXEC_RUN_MS",
    "H_SAME_SIDE_ADDS_ON",
    "H_HEDGING_ON",
    "H_HEDGE_VALUE_GATE_ON",
    "H_BOUNDED_HEDGE_SHARES",
    "H_CROSS_RESIDUAL_SH",
    "H_REVERSAL_MAX_IMBALANCE_SH",
    "H_MAX_ORDERS",
    "H_MAX_CELL_USES",
    "H_MAX_WINDOW_LOSS_USD",
  ]) assert.equal(key in STRAT, false, key);
});
