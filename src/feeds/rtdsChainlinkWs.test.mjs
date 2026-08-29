import assert from "node:assert/strict";
import test from "node:test";
import { parseRtdsChainlinkMessage } from "./rtdsChainlinkWs.js";

test("parses the flattened TWAP-60 frame", () => {
  assert.deepEqual(parseRtdsChainlinkMessage({
    topic: "crypto_prices_twap_sixty",
    payload: { symbol: "btc/usd", timestamp: 1_787_000_000_123, value: 77_455.3695, window_s: 60 },
  }), [{ asset: "btc", value: 77_455.3695, payloadTs: 1_787_000_000_123 }]);
});

test("inherits the payload symbol for bare snapshot rows", () => {
  assert.deepEqual(parseRtdsChainlinkMessage({
    topic: "crypto_prices",
    payload: { symbol: "eth/usd", data: [{ timestamp: 1_787_000_000, value: "4321.25" }] },
  }), [{ asset: "eth", value: 4321.25, payloadTs: 1_787_000_000_000 }]);
});

test("accepts renamed TWAP topics and single-asset symbol fallback", () => {
  assert.deepEqual(parseRtdsChainlinkMessage({
    topic: "crypto_prices_twap_60s",
    payload: { data: [{ timestamp: 1_787_000_001_000, value: 123.5 }] },
  }, "sol"), [{ asset: "sol", value: 123.5, payloadTs: 1_787_000_001_000 }]);
});

test("rejects Binance-shaped symbols on the shared topic", () => {
  assert.deepEqual(parseRtdsChainlinkMessage({
    topic: "crypto_prices",
    payload: { symbol: "btcusdt", value: 77_500, timestamp: 1_787_000_001_000 },
  }), []);
});
