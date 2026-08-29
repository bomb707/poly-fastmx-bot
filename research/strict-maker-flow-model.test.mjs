import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_ORDERS_IFACE } from "./wallet-3048/signed-orders.mjs";
import {
  decodeMakerLegsFromTransaction,
  economicBuyFlow,
  exactPriceMatches,
  intervalFullyInsideOrder,
  publicTradeInterval,
} from "./strict-maker-flow-model.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const bytes32 = `0x${"0".repeat(64)}`;
const order = ({ token, makerAmount, takerAmount, side, maker = address("1") }) => [
  1n, maker, maker, BigInt(token), BigInt(makerAmount), BigInt(takerAmount), side, 0, 1_786_000_000_000n,
  bytes32, bytes32, "0x12",
];

test("public trade seconds are interval-censored and must be wholly inside the live order", () => {
  const interval = publicTradeInterval({ ms: 11_000 });
  assert.deepEqual(interval, { startMs: 10_000, endMs: 11_000 });
  assert.equal(intervalFullyInsideOrder({ effectiveArrivalMs: 10_000, expiresMs: 11_000 }, interval), true);
  assert.equal(intervalFullyInsideOrder({ effectiveArrivalMs: 10_001, expiresMs: 11_000 }, interval), false);
  assert.equal(intervalFullyInsideOrder({ effectiveArrivalMs: 10_000, expiresMs: 10_999 }, interval), false);
});

test("decodes exact maker fill amounts instead of assigning taker VWAP to one price", () => {
  const makers = [
    order({ token: 101, makerAmount: 4_000_000, takerAmount: 10_000_000, side: 0 }),
    order({ token: 101, makerAmount: 10_000_000, takerAmount: 6_000_000, side: 1, maker: address("2") }),
  ];
  const input = MATCH_ORDERS_IFACE.encodeFunctionData("matchOrders", [
    bytes32,
    order({ token: 202, makerAmount: 6_000_000, takerAmount: 10_000_000, side: 0, maker: address("3") }),
    makers,
    5_000_000n,
    [2_000_000n, 3_000_000n],
    0n,
    [0n, 0n],
  ]);
  const decoded = decodeMakerLegsFromTransaction({ input });
  assert.equal(decoded.status, "decoded");
  assert.equal(decoded.makerLegs.length, 2);
  assert.equal(decoded.makerLegs[0].isBuy, true);
  assert.equal(decoded.makerLegs[0].shares, 5);
  assert.equal(decoded.makerLegs[0].price, .4);
  assert.equal(decoded.makerLegs[1].isBuy, false);
  assert.equal(decoded.makerLegs[1].shares, 3);
  assert.equal(decoded.makerLegs[1].price, .6);
});

test("SELL outcome liquidity maps to the complementary economic BUY queue", () => {
  assert.deepEqual(economicBuyFlow({ tokenId: "101", isBuy: true, price: .4, shares: 5 }, {
    upToken: "101", downToken: "202",
  }), { outcome: "Up", price: .4, size: 5 });
  assert.deepEqual(economicBuyFlow({ tokenId: "101", isBuy: false, price: .6, shares: 3 }, {
    upToken: "101", downToken: "202",
  }), { outcome: "Down", price: .4, size: 3 });
  assert.equal(economicBuyFlow({ tokenId: "999", isBuy: true, price: .4, shares: 5 }, {
    upToken: "101", downToken: "202",
  }), null);
  assert.equal(exactPriceMatches(.4, .40000001), true);
  assert.equal(exactPriceMatches(.4, .4001), false);
});
