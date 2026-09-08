import test from "node:test";
import assert from "node:assert/strict";
import { createShadow } from "./shadow.js";

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
  assert.equal(migrated.W3048_SPEC_VERSION, 2);
  assert.equal(migrated.W3048_MIN_PRICE, 0.01);
  assert.equal(migrated.W3048_MAX_PRICE, 0.99);
  assert.equal(migrated.W3048_MOMENTUM_LOOKBACK_MS, 500);
  assert.equal(migrated.LIMIT, 0.99);
  assert.equal(migrated.LATENCY_MS, 250, "operator latency remains a valid generic override");

  shadow.setParams({ STRATEGY: "wallet3048", W3048_SPEC_VERSION: 2,
    W3048_MOMENTUM_LOOKBACK_MS: 750 });
  assert.equal(shadow.getParams().W3048_MOMENTUM_LOOKBACK_MS, 750);
});
