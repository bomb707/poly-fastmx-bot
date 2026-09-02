import test from "node:test";
import assert from "node:assert/strict";
import {
  applyParentExecution,
  buildInventoryLedger,
  decodeTargetReceiptFills,
  emptyInventory,
  inventorySnapshot,
  matchInventoryCheckpoint,
  signalAt,
  summarizeLedger,
} from "./inventory-ledger-core.mjs";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");

test("parent execution tracks inventory, payouts, averages, and reverse calculation", () => {
  const state = emptyInventory();
  const first = applyParentExecution(state, { outcome: "Up", shares: 50, notional: 20, fee: 0.5 }, "Up");
  assert.equal(first.after.upShares, 50);
  assert.equal(first.after.averageUp, .4);
  assert.equal(first.after.totalCost, 20.5);
  assert.equal(first.after.ifUp, 29.5);
  assert.equal(first.after.ifDown, -20.5);
  assert.equal(first.reverseCalculation.shares, 50);
  assert.equal(first.reverseCalculation.price, .4);

  const second = applyParentExecution(state, { outcome: "Down", shares: 50, notional: 25, fee: 0 }, "Up");
  assert.equal(second.after.guaranteedPayout, 50);
  assert.equal(second.after.grossAveragePairCost, .9);
  assert.equal(second.after.allInAveragePairCost, .91);
  assert.equal(second.delta.ifUp, -25);
  assert.equal(second.delta.ifDown, 25);
});

test("ledger marks within-second ordering as ambiguous and settles the actual winner", () => {
  const ledger = buildInventoryLedger([
    { executionTimestamp: 100, transactionHash: "0xb", orderHash: "2", outcome: "Down", shares: 60, notional: 30, fee: 0, role: "maker", tInto: 20 },
    { executionTimestamp: 100, transactionHash: "0xa", orderHash: "1", outcome: "Up", shares: 50, notional: 20, fee: 0, role: "taker", tInto: 20 },
  ], "Down");
  assert.equal(ledger.rows[0].sequenceAmbiguous, true);
  assert.equal(ledger.rows[1].sameSecondExecutions, 2);
  assert.equal(ledger.final.upShares, 50);
  assert.equal(ledger.final.downShares, 60);
  assert.equal(ledger.final.actualPnl, 10);
  assert.deepEqual(inventorySnapshot({ upShares: 50, downShares: 60, upNotional: 20, downNotional: 30, upCost: 20, downCost: 30 }, "Down"), ledger.final);
});

test("signal alignment uses the causal 2.5-second lookback", () => {
  const capture = { openBz: 100, openCl: 99, ticks: [
    { t: 1, ua: .4, ub: .38, da: .62, db: .6, bz: 100, cl: 99 },
    { t: 3.5, ua: .45, ub: .43, da: .57, db: .55, bz: 105, cl: 101 },
  ] };
  const signal = signalAt(capture, 3.5);
  assert.equal(signal.binanceMove, 5);
  assert.equal(signal.binanceGap, 5);
  assert.equal(signal.upMidMove, .05);
  assert.equal(signal.downMidMove, -.05);
});

test("window summary reports risk path and parent counts", () => {
  const ledger = buildInventoryLedger([
    { executionTimestamp: 1, tInto: 1, orderHash: "a", parentSignedShares: 50, outcome: "Up", shares: 50, notional: 20, allInCost: 20, role: "maker" },
    { executionTimestamp: 2, tInto: 2, orderHash: "b", parentSignedShares: 150, outcome: "Down", shares: 100, notional: 55, allInCost: 55, role: "taker" },
  ], "Down");
  const summary = summarizeLedger("test", ledger, { winner: "Down" });
  assert.equal(summary.parentOrders, 2);
  assert.equal(summary.makerExecutions, 1);
  assert.equal(summary.takerExecutions, 1);
  assert.equal(summary.maxAbsoluteLean, 50);
  assert.equal(summary.final.actualPnl, 25);
});

test("receipt decoder attributes exact shares, notional, and fee to an order hash", () => {
  const wallet = "0x3048d65321be3497164cdfc2996f94f98a2e7537";
  const token = 987n;
  const receipt = { logs: [{
    topics: ["0xsig", "0xorder", `0x${"0".repeat(24)}${wallet.slice(2)}`, "0xtaker"],
    data: `0x${word(0)}${word(token)}${word(20_000_000)}${word(50_000_000)}${word(500_000)}`,
    logIndex: "0x3",
  }] };
  assert.deepEqual(decodeTargetReceiptFills(receipt, wallet), [{
    orderHash: "0xorder",
    isBuy: true,
    tokenId: "987",
    shares: 50,
    notional: 20,
    fee: .5,
    allInCost: 20.5,
    logIndex: 3,
  }]);
});

test("inventory checkpoint matching ignores a delayed display timestamp", () => {
  const ledger = buildInventoryLedger([
    { executionTimestamp: 110, tInto: 10, outcome: "Up", shares: 50, notional: 20, allInCost: 20 },
    { executionTimestamp: 120, tInto: 20, outcome: "Down", shares: 50, notional: 25, allInCost: 25 },
  ]);
  const match = matchInventoryCheckpoint(ledger.rows, {
    displayTInto: 43,
    upShares: 50,
    downShares: 50,
    averageUp: .4,
    averageDown: .5,
    totalCost: 45,
    ifUp: 5,
    ifDown: 5,
  });
  assert.equal(match.sequence, 2);
  assert.equal(match.executionTInto, 20);
  assert.equal(match.displayLagSeconds, 23);
  assert.equal(match.exactAtDisplayedPrecision, true);
});
