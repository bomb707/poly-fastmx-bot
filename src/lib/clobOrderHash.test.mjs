import assert from "node:assert/strict";
import { test } from "node:test";
import { hashSignedClobOrder, signedBuyPrincipalUsd, signedBuyShares } from "./clobOrderHash.js";

const order = Object.freeze({
  salt: "479249096354",
  maker: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  tokenId: "123456789",
  makerAmount: "1000000",
  takerAmount: "2000000",
  side: "BUY",
  signatureType: 2,
  timestamp: "1787796000000",
  metadata: `0x${"00".repeat(32)}`,
  builder: `0x${"00".repeat(32)}`,
  signature: "0xdeadbeef",
});

test("computes a stable pre-POST V2 order id without including the signature", () => {
  const first = hashSignedClobOrder(order, { version: 2, negRisk: false });
  const second = hashSignedClobOrder({ ...order, signature: "0xcafebabe" }, { version: 2, negRisk: false });
  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.equal(signedBuyPrincipalUsd(order), 1);
  assert.equal(signedBuyShares(order), 2);
});
