import test from "node:test";
import assert from "node:assert/strict";
import { createShadow } from "./shadow.js";

test("runtime configuration cannot reactivate the retired Helpme policy", () => {
  const shadow = createShadow();
  shadow.setParams({ STRATEGY: "helpme", H_BASE_ORDER_SH: 7, T_COOLDOWN_MS: 2500 });
  const params = shadow.getParams();
  assert.equal(params.STRATEGY, "target75cc");
  assert.equal(params.T_COOLDOWN_MS, 2500);
  assert.equal("H_BASE_ORDER_SH" in params, false);
});

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
  assert.equal(w.orders.length, 2);
  assert.equal(w.orders[1].limit, .82);
  assert.equal("helpme" in w, false);

  // A second Start in the same process is idempotent.
  shadow.hydrateWindow({ slug, windowStart: 100, fills: w.fills, orderStatus: [] });
  assert.equal(w.fills.length, 1);
  assert.equal(w.cost, 5.68);
});
