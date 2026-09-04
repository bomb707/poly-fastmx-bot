import assert from "node:assert/strict";
import test from "node:test";
import { bapiKeyForUrl, config } from "../config/config.js";

test("backtest credentials are restricted to the exact polywinbot domain", () => {
  const previous = { bapiKey: config.bapiKey, bapiV3Key: config.bapiV3Key };
  config.bapiKey = "v2-test-key";
  config.bapiV3Key = "v3-test-key";
  try {
    assert.equal(bapiKeyForUrl("https://bapi-v2.polywinbot.com/snapshot-ticks"), "v2-test-key");
    assert.equal(bapiKeyForUrl("https://bapi-v2-ob.polywinbot.com/orderbooks"), "v2-test-key");
    assert.equal(bapiKeyForUrl("https://bapi-v3.polywinbot.com/markets/x/snapshots"), "v3-test-key");
    assert.equal(bapiKeyForUrl("https://polywinbot.com.evil.example/orderbooks"), "");
    assert.equal(bapiKeyForUrl("https://evil.example/?next=polywinbot.com"), "");
    assert.equal(bapiKeyForUrl("not a url"), "");
  } finally {
    config.bapiKey = previous.bapiKey;
    config.bapiV3Key = previous.bapiV3Key;
  }
});
