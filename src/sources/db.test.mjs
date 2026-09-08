import test from "node:test";
import assert from "node:assert/strict";
import { fillDocId, resolvePendingSessionDoc } from "./db.js";

test("modeled fill persistence identity is stable but does not merge later fills", () => {
  const fill = { windowStart: 100, oid: 2, leg: "entry", side: "Up", tInto: 12.52 };
  assert.equal(fillDocId(fill), "100:2:entry:Up:12.520000");
  assert.equal(fillDocId({ ...fill }), fillDocId(fill));
  assert.notEqual(fillDocId({ ...fill, tInto: 13.52 }), fillDocId(fill));
  assert.notEqual(fillDocId({ ...fill, side: "Down" }), fillDocId(fill));
  assert.equal(fillDocId({ ...fill, tInto: null }), null);
  assert.equal(fillDocId({ ...fill, fillId: "2:1" }), "100:fill:2:1");
  assert.notEqual(fillDocId({ ...fill, fillId: "2:1" }), fillDocId({ ...fill, fillId: "2:2" }));
  assert.equal(fillDocId({ ...fill, fillId: "2:1", tInto: 13.52 }), "100:fill:2:1");
});

test("restart recovery settles a persisted simulation row using its booked fees", () => {
  const pending = {
    windowStart: 100,
    slug: "btc-updown-5m-100",
    status: "pending",
    winSide: null,
    sim: { upShares: 7.0943, downShares: 0, cost: 3.71, fee: 0.1239, merged: 0, nFills: 1,
      pnl: null, cfg: { strategy: "wallet3048", latencyMs: 520 } },
  };
  const won = resolvePendingSessionDoc(pending, "Up", 999);
  assert.equal(won.status, "resolved");
  assert.equal(won.winSide, "Up");
  assert.equal(won.ts, 999);
  assert.equal(won.sim.winSh, 7.0943);
  assert.equal(won.sim.pnl, 3.2604);
  assert.deepEqual(won.sim.cfg, { strategy: "wallet3048", latencyMs: 520 });

  const lost = resolvePendingSessionDoc(pending, "Down", 1000);
  assert.equal(lost.sim.winSh, 0);
  assert.equal(lost.sim.pnl, -3.8339);
  assert.equal(lost.netMatch, null);
  assert.equal(lost.pnlErr, null);
});
