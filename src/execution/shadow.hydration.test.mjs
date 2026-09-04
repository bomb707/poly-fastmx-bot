import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveTickArchive, createShadow } from "./shadow.js";

test("live tick archive preserves the exact shadow inventory ledger", () => {
  const fill = { oid: 7, side: "Up", shares: 50, usdc: 20, effPx: .4, reason: "test", tInto: 12 };
  const payload = buildLiveTickArchive({
    slug: "btc-updown-5m-100", windowStart: 100, openBinance: 1000, openChainlink: 999,
    recTicks: [{ t: 1, ua: .4 }], fills: [fill], upShares: 50, downShares: 40,
    cost: 42, fee: 1, mergedRealized: 0,
  }, "Up", { STRATEGY: "helpme" });
  assert.equal(payload.schema, 2);
  assert.deepEqual(payload.shadowFills, [fill]);
  assert.equal(payload.shadowSummary.ifUp, 7);
  assert.equal(payload.shadowSummary.ifDown, -3);
  assert.equal(payload.shadowSummary.actualPnl, 7);
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

test("unknown persisted strategies fall back to FastMX without leaking overrides", () => {
  const shadow = createShadow();
  shadow.setParams({ STRATEGY: "retired-strategy", LATENCY_MS: 250 });
  const helpme = shadow.getParams();
  assert.equal(helpme.STRATEGY, "helpme");
  assert.equal(helpme.H_BASE_ORDER_SH, 7);
  assert.equal(helpme.LATENCY_MS, 250);
  assert.equal("RETIRED_ONLY_FIELD" in helpme, false);
});
