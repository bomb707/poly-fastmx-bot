import test from "node:test";
import assert from "node:assert/strict";
import { buildPolyCryptoUrl, marketSpecFromSlug, polyOpenFetchReady } from "./resolution.js";

for (const [name, windowSeconds, variant] of [
  ["5-minute", 300, "fiveminute"],
  ["15-minute", 900, "fifteenminute"],
]) {
  test(`Polymarket ${name} resolution URL always requests the 60s TWAP pair`, () => {
    const url = new URL(buildPolyCryptoUrl("btc", 1787270400, windowSeconds));

    assert.equal(url.searchParams.get("twapEnabled"), "true");
    assert.equal(url.searchParams.get("twapLookbackSeconds"), "60");
    assert.equal(url.searchParams.get("variant"), variant);
  });
}

test("Polymarket open is withheld until the same t+10s backfill delay as poly-mom-bot", () => {
  const windowStart = 1_787_270_400;
  assert.equal(polyOpenFetchReady(windowStart, windowStart * 1000 + 9_999), false);
  assert.equal(polyOpenFetchReady(windowStart, windowStart * 1000 + 10_000), true);
});

test("settlement market identity is recovered from the pending row slug", () => {
  assert.deepEqual(marketSpecFromSlug("eth-updown-15m-1787799600"), {
    asset: "eth", interval: "15m", windowSec: 900, windowStart: 1787799600,
  });
  assert.deepEqual(marketSpecFromSlug("btc-updown-5m-1787799600"), {
    asset: "btc", interval: "5m", windowSec: 300, windowStart: 1787799600,
  });
  assert.equal(marketSpecFromSlug("not-a-market"), null);
});
