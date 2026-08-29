import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cachedClobTokenMeta,
  prewarmClobLimitSignerOnce,
  prewarmClobTokens,
  submitLimitOrderFast,
  submitMarketOrderFast,
} from "./clobFastPath.js";

const Side = Object.freeze({ BUY: "BUY" });

function fakeClient({ mismatchFirstPost = false } = {}) {
  let version = 2;
  const calls = { ensure: [], market: [], resolve: [], create: [], createMarket: [], post: [] };
  const client = {
    tickSizes: {},
    negRisk: {},
    feeInfos: {},
    async resolveVersion(force = false) {
      calls.resolve.push(force);
      if (force) version = 3;
      return version;
    },
    async _ensureMarketInfoCached(tokenId) {
      if (client.feeInfos[tokenId]) return;
      calls.ensure.push(tokenId);
      client.tickSizes[tokenId] = "0.01";
      client.negRisk[tokenId] = false;
      client.feeInfos[tokenId] = { rate: 0, exponent: 0 };
    },
    async getClobMarketInfo(conditionId) {
      calls.market.push(conditionId);
      for (const tokenId of ["up", "down"]) {
        client.tickSizes[tokenId] = "0.01";
        client.negRisk[tokenId] = false;
        client.feeInfos[tokenId] = { rate: 0.07, exponent: 1 };
      }
      return { mts: "0.01", mos: "5", nr: false, fd: { r: 0.07, e: 1 } };
    },
    async getTickSize(tokenId) { return client.tickSizes[tokenId]; },
    async getNegRisk(tokenId) { return client.negRisk[tokenId]; },
    async createOrder(order, options) {
      const signed = { ...order, signature: "0xsigned", signedVersion: options.version };
      calls.create.push({ order: { ...order }, options: { ...options }, signed });
      return signed;
    },
    async createMarketOrder(order, options) {
      const signed = { ...order, makerAmount: "1000000", takerAmount: "2000000", signature: "0xsigned", signedVersion: options.version };
      calls.createMarket.push({ order: { ...order }, options: { ...options }, signed });
      return signed;
    },
    async postOrder(order, orderType, postOnly, deferExec) {
      calls.post.push({ order, orderType, postOnly, deferExec });
      if (mismatchFirstPost && calls.post.length === 1) {
        version = 3; // mirrors postOrder's internal version refresh
        return { error: "order_version_mismatch", status: 400 };
      }
      return { orderID: `order-${calls.post.length}`, status: "live" };
    },
  };
  return { client, calls };
}

describe("CLOB live-order fast path", () => {
  test("prewarms complete token metadata and redacts the local dummy signature", async () => {
    const { client, calls } = fakeClient();
    const metas = await prewarmClobTokens({
      client, Side, tokenIds: ["up", "down", "up"], conditionId: "condition-1",
    });
    assert.equal(metas.length, 2);
    assert.deepEqual(calls.market, ["condition-1"]);
    assert.deepEqual(calls.ensure, [], "condition metadata primes both tokens in one request");
    assert.deepEqual(cachedClobTokenMeta(client, "up"), {
      tokenId: "up", tickSize: "0.01", negRisk: false, version: 2,
      minOrderSize: 5, feeRate: 0.07, feeExponent: 1,
    });
    assert.equal(calls.createMarket.length, 1, "one local-only market signer prewarm");
    assert.equal(calls.createMarket[0].signed.signature, "0x", "dummy signature is destroyed");

    await prewarmClobLimitSignerOnce({ client, Side, tokenMeta: metas[0] });
    assert.equal(calls.createMarket.length, 1, "signer prewarm is one-shot per client");
  });

  test("overlaps signing with warmer drain and posts with deferred settlement", async () => {
    const { client, calls } = fakeClient();
    const [tokenMeta] = await prewarmClobTokens({ client, Side, tokenIds: ["up"] });
    calls.create.length = 0;
    let drain;
    const warmDrain = new Promise((resolve) => { drain = resolve; });
    const submitting = submitLimitOrderFast({
      client,
      userOrder: { tokenID: "up", side: "BUY", price: 0.6, size: 5 },
      tokenMeta,
      orderType: "GTC",
      postOnly: true,
      transportReady: warmDrain,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.create.length, 1, "signing starts while warmer drains");
    assert.equal(calls.post.length, 0, "POST waits until the warmer releases its socket");
    drain();
    const result = await submitting;
    assert.equal(result.response.orderID, "order-1");
    assert.equal(calls.post.length, 1);
    assert.equal(calls.post[0].postOnly, true);
    assert.equal(calls.post[0].deferExec, true);
    assert.equal(calls.create[0].options.version, 2);
    assert.ok(result.timing.totalMs >= 0);
  });

  test("re-signs only after an authoritative order-version rejection", async () => {
    const { client, calls } = fakeClient({ mismatchFirstPost: true });
    const [tokenMeta] = await prewarmClobTokens({ client, Side, tokenIds: ["up"] });
    calls.create.length = 0;
    const result = await submitLimitOrderFast({
      client,
      userOrder: { tokenID: "up", side: "BUY", price: 0.6, size: 5 },
      tokenMeta,
      orderType: "GTC",
    });
    assert.equal(result.response.orderID, "order-2");
    assert.deepEqual(calls.create.map((row) => row.options.version), [2, 3]);
    assert.equal(calls.post.length, 2);
    assert.ok(calls.post.every((row) => row.deferExec === true));

    calls.create.length = 0;
    await submitLimitOrderFast({
      client,
      userOrder: { tokenID: "up", side: "BUY", price: 0.61, size: 5 },
      tokenMeta,
      orderType: "GTC",
    });
    assert.equal(calls.create[0].options.version, 3, "later orders use the refreshed client version immediately");
  });

  test("fixed-USD FAK signs through createMarketOrder and reuses the fast POST", async () => {
    const { client, calls } = fakeClient();
    const [tokenMeta] = await prewarmClobTokens({ client, Side, tokenIds: ["up"], conditionId: "condition-1" });
    calls.createMarket.length = 0;
    const prepared = [];
    const result = await submitMarketOrderFast({
      client,
      userOrder: { tokenID: "up", side: "BUY", price: 0.6, amount: 1.2, orderType: "FAK" },
      tokenMeta,
      orderType: "FAK",
      onOrderPrepared: (value) => prepared.push(value),
    });
    assert.equal(result.response.orderID, "order-1");
    assert.equal(calls.createMarket.length, 1);
    assert.equal(calls.createMarket[0].order.amount, 1.2);
    assert.equal(calls.post[0].orderType, "FAK");
    assert.equal(calls.post[0].postOnly, false);
    assert.equal(calls.post[0].deferExec, true);
    assert.equal(prepared.length, 1);
  });
});
