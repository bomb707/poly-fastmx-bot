import test from "node:test";
import assert from "node:assert/strict";
import { createShadow } from "./shadow.js";

test("mid-window hydration restores fills and the cooldown clock", () => {
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
  assert.equal(w.helpme.orderCount, 2);
  assert.equal(w.helpme.lastSignalKey, null);
  assert.equal("cells" in w.helpme, false);
  assert.equal("execSide" in w.helpme, false);
  assert.equal(w.helpme.lastOrderMs, 122_000);

  // A second Start in the same process is idempotent.
  shadow.hydrateWindow({ slug, windowStart: 100, fills: w.fills, orderStatus: [] });
  assert.equal(w.fills.length, 1);
  assert.equal(w.cost, 5.68);
});

test("runtime strategy selection switches parameter schemas without leaking overrides", () => {
  const shadow = createShadow();
  shadow.setParams({ STRATEGY: "wallet3048", LATENCY_MS: 250 });
  const wallet = shadow.getParams();
  assert.equal(wallet.STRATEGY, "wallet3048");
  assert.equal(wallet.W3048_SMALL_SIZE, 50);
  assert.equal(wallet.W3048_LARGE_SIZE, 150);
  assert.equal(wallet.LATENCY_MS, 250);
  assert.equal("H_BASE_ORDER_SH" in wallet, false);

  shadow.setParams({ STRATEGY: "helpme" });
  const helpme = shadow.getParams();
  assert.equal(helpme.STRATEGY, "helpme");
  assert.equal(helpme.H_BASE_ORDER_SH, 7);
  assert.equal(helpme.LATENCY_MS, 520);
  assert.equal("W3048_SMALL_SIZE" in helpme, false);
});
