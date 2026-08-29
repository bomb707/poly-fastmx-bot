import assert from "node:assert/strict";
import test from "node:test";
import { dedupeExactMarketTrades } from "./market-trade-dedupe.mjs";

const trade = (overrides = {}) => ({
  ms: 1000, sourceSide: "SELL", sourceOutcome: "Up", sourcePrice: .4,
  outcome: "Up", price: .4, size: 5, transactionHash: "0xabc", ...overrides,
});

test("drops a literal repeated public print", () => {
  const row = trade();
  const result = dedupeExactMarketTrades([row, { ...row }]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.duplicatesDropped, 1);
});

test("preserves distinct fills sharing a transaction hash", () => {
  const result = dedupeExactMarketTrades([trade(), trade({ size: 6 }), trade({ price: .41 })]);
  assert.equal(result.trades.length, 3);
  assert.equal(result.duplicatesDropped, 0);
});
