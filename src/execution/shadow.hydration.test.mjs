import test from "node:test";
import assert from "node:assert/strict";
import { createShadow } from "./shadow.js";
import { setRunning } from "./botState.js";

test("mid-window hydration restores fills, orders, and the wallet action clock", () => {
  const shadow = createShadow();
  const slug = "btc-updown-5m-100";
  const w = shadow.hydrateWindow({ slug, windowStart: 100,
    fills: [{ oid: 1, side: "Down", leg: "entry", tInto: 11.52,
      shares: 7.1, usdc: 5.68, effPx: .8, exec: "marketable", kind: "taker" }],
    orderStatus: [
      { stage: "decided", oid: 1, side: "Down", leg: "entry", tInto: 11,
        decPx: .79, limitPx: .8, budgetUsd: 5.6, ts: 111_000 },
      { stage: "sim_filled", oid: 1, side: "Down", ts: 111_520 },
      { stage: "decided", oid: 2, side: "Down", leg: "entry", tInto: 22,
        decPx: .81, limitPx: .82, budgetUsd: 5.74, ts: 122_000 },
      { stage: "skipped", oid: 2, side: "Down", ts: 122_520 },
    ] });

  assert.equal(w.downShares, 7.1);
  assert.equal(w.cost, 5.68);
  assert.ok(w.fee > 0);
  assert.equal(w.fills.length, 1);
  assert.equal(w.seq, 2);
  assert.equal(w.orders.length, 2);
  assert.equal(w.wallet3048Recovery.actions, 2);
  assert.equal(w.wallet3048Recovery.lastActionMs, 122_000);

  // A second Start in the same process is idempotent.
  shadow.hydrateWindow({ slug, windowStart: 100, fills: w.fills, orderStatus: [] });
  assert.equal(w.fills.length, 1);
  assert.equal(w.cost, 5.68);
});

test("unknown strategy names fall back to wallet3048 without leaking overrides", () => {
  const shadow = createShadow();
  shadow.setParams({ STRATEGY: "wallet3048", LATENCY_MS: 250 });
  const wallet = shadow.getParams();
  assert.equal(wallet.STRATEGY, "wallet3048");
  assert.equal(wallet.W3048_SMALL_SIZE, 50);
  assert.equal(wallet.W3048_LARGE_SIZE, 150);
  assert.equal(wallet.LATENCY_MS, 250);
  assert.equal("H_BASE_ORDER_SH" in wallet, false);

  shadow.setParams({ STRATEGY: "removed-strategy", LATENCY_MS: 300, H_BASE_ORDER_SH: 7 });
  const fallback = shadow.getParams();
  assert.equal(fallback.STRATEGY, "wallet3048");
  assert.equal(fallback.W3048_SMALL_SIZE, 50);
  assert.equal(fallback.LATENCY_MS, 300);
  assert.equal("H_BASE_ORDER_SH" in fallback, false);
});

test("an older persisted wallet snapshot cannot pin superseded strategy defaults", () => {
  const shadow = createShadow();
  shadow.setParams({ STRATEGY: "wallet3048", LATENCY_MS: 250,
    LIMIT: 0.89, W3048_MIN_PRICE: 0.12, W3048_MAX_PRICE: 0.89,
    W3048_MOMENTUM_LOOKBACK_MS: 5000 });
  const migrated = shadow.getParams();
  assert.equal(migrated.W3048_SPEC_VERSION, 5);
  assert.equal(migrated.W3048_MIN_PRICE, 0.01);
  assert.equal(migrated.W3048_MAX_PRICE, 0.99);
  assert.equal(migrated.W3048_MOMENTUM_LOOKBACK_MS, 500);
  assert.equal(migrated.LIMIT, 0.99);
  assert.equal("MAX_SESSION_LOSS" in migrated, false);
  assert.equal(migrated.LATENCY_MS, 250, "operator latency remains a valid generic override");

  shadow.setParams({ STRATEGY: "wallet3048", W3048_SPEC_VERSION: 5,
    W3048_MOMENTUM_LOOKBACK_MS: 750 });
  assert.equal(shadow.getParams().W3048_MOMENTUM_LOOKBACK_MS, 750);
});

test("hydration books distinct partial fills once and ignores duplicate fill events", () => {
  const shadow = createShadow();
  const base = { oid: 4, side: "Up", leg: "entry", tInto: 12,
    effPx: 0.4, exec: "marketable", kind: "taker" };
  const w = shadow.hydrateWindow({ slug: "btc-updown-5m-200", windowStart: 200,
    fills: [
      { ...base, fillId: "4:1", shares: 10, usdc: 4 },
      { ...base, fillId: "4:2", shares: 5, usdc: 2 },
      { ...base, fillId: "4:1", shares: 10, usdc: 4 },
    ], orderStatus: [] });
  assert.equal(w.fills.length, 2);
  assert.equal(w.upShares, 15);
  assert.equal(w.cost, 6);
});

test("shadow books due and maker partial fills before the next decision", () => {
  const events = [];
  const shadow = createShadow((event) => events.push(event), () => false);
  shadow.setParams({ STRATEGY: "wallet3048", W3048_SPEC_VERSION: 5,
    LATENCY_MS: 100, W3048_REQUIRE_SOURCE_TIMESTAMPS: false,
    W3048_CLOB_VELOCITY_GATE: false,
    W3048_RELEASE_GATE: false, W3048_COOLDOWN_MS: 10_000,
    W3048_BETA_MARKET_LOGIT: 0, W3048_BETA_MOMENTUM: 1,
    W3048_BETA_LATEST_UPDATE: 0, W3048_BETA_RELATIVE_LEAD: 0,
    W3048_BETA_CHAINLINK_DISTANCE: 0, W3048_BETA_CLOB: 0,
    W3048_BETA_TIME_CHAINLINK: 0, W3048_EDGE_BUFFER: 0,
    W3048_MIN_EXPECTED_EDGE_START: 0, W3048_MIN_EXPECTED_EDGE_END: 0,
    W3048_LARGE_EDGE: 1,
    W3048_MAKER_EXECUTION_POLICY: "book-cross-inference" });
  const side = (ask, depth, extra = {}) => ({ bestAsk: ask, bestBid: +(ask - 0.01).toFixed(2),
    asks: [[ask, depth], [+(ask + 0.01).toFixed(2), depth], [+(ask + 0.02).toFixed(2), depth]],
    bids: [[+(ask - 0.01).toFixed(2), depth], [+(ask - 0.02).toFixed(2), depth],
      [+(ask - 0.03).toFixed(2), depth]], ...extra });
  const send = (t, bz, up) => shadow.tick({ slug: "btc-updown-5m-0", windowStart: 0,
    openBinance: 100, openChainlink: 100, tInto: t, bzPrice: bz, clPrice: 100,
    nowMs: t * 1000, up, down: side(0.61, 300) });
  setRunning(true);
  try {
    send(4.5, 100, side(0.4, 100));
    send(5, 101, side(0.4, 10));
    send(5.2, 101, side(0.4, 10));
    const w = shadow.windows.get("btc-updown-5m-0");
    assert.equal(w.upShares, 40,
      "arrival liquidity and the distinct post-arrival book-cross event are each consumed once");
    assert.equal(w.fee, 0.33733, "per-level taker fees enter the ledger exactly once");
    assert.equal(events.filter((event) => event.kind === "shadow_placed").length, 1,
      "the next decision sees confirmed inventory instead of firing a second initial order");
    assert.equal(w.pendingFills[0].remaining, 10);

    send(6.2, 101, side(0.42, 100));
    assert.equal(w.upShares, 40, "time at bid alone receives no maker credit");
    send(6.3, 101, side(0.42, 100, { sellFlowAtOrBelow: 5 }));
    assert.equal(w.upShares, 40, "unidentified scalar public flow receives no maker credit");
    assert.equal(w.fee, 0.33733, "the resting maker partial adds no taker fee");
    assert.equal(w.pendingFills[0].remaining, 10);
  } finally {
    setRunning(false);
  }
});
