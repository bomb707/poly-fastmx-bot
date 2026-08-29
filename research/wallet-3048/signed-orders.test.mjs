import assert from "node:assert/strict";
import test from "node:test";
import { decodeTargetOrders, groupSignedOrders, MATCH_ORDERS_IFACE } from "./signed-orders.mjs";

const wallet = "0x3048d65321be3497164cdfc2996f94f98a2e7537";
const other = "0x0000000000000000000000000000000000000001";
const bytes32 = "0x" + "00".repeat(32);
const sig = "0x1234";
const tuple = ["1518273613122", wallet, wallet, "123", "29600000", "80000000", 0, 3, "1786665513954", bytes32, bytes32, sig];

test("decodes a signed target taker order without treating signed timestamp as fire time", () => {
  const input = MATCH_ORDERS_IFACE.encodeFunctionData("matchOrders", [bytes32, tuple, [], 0, [], 0, []]);
  const orders = decodeTargetOrders({ input, to: "0xe111180000d2663c0091e4f400237545b87b996b" }, wallet);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].settlementRole, "taker");
  assert.equal(orders[0].signedShares, 80);
  assert.equal(orders[0].signedBudgetUsd, 29.6);
  assert.equal(orders[0].limitPrice, 0.37);
  assert.equal(orders[0].signedTimestampMs, 1786665513954);
  assert.equal("fireMs" in orders[0], false);
});

test("filters other makers and groups repeated exact hashes across taker and maker settlements", () => {
  const own = { orderHash: "0xabc", tokenId: "123", tradeId: bytes32, contract: other, isBuy: true,
    limitPrice: .37, signedShares: 80, signedBudgetUsd: 29.6, signedTimestampMs: 1, salt: "1",
    signer: wallet, signatureType: 3, metadata: bytes32, builder: bytes32 };
  const decoded = [
    { txHash: "0xt1", orders: [{ ...own, settlementRole: "taker" }] },
    { txHash: "0xt2", orders: [{ ...own, settlementRole: "maker" }] },
  ];
  const trades = [
    { transactionHash: "0xt1", asset: "123", role: "taker", size: 5, price: .36, timestamp: 10, slug: "s", outcome: "Up" },
    { transactionHash: "0xt2", asset: "123", role: "maker", size: 10, price: .37, timestamp: 11, slug: "s", outcome: "Up" },
  ];
  const grouped = groupSignedOrders(decoded, trades);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(grouped.groups[0].settlementRoles, ["maker", "taker"]);
  assert.equal(grouped.groups[0].filledShares, 15);
  assert.equal(grouped.groups[0].settlements.length, 2);
});
