import { performance } from "node:perf_hooks";
import { clobConnectionMeta } from "./clobHttpTransport.js";

const versionByClient = new WeakMap();
const versionPromiseByClient = new WeakMap();
const tokenMetaByClient = new WeakMap();
const tokenPrewarmByClient = new WeakMap();
const conditionPrewarmByClient = new WeakMap();
const signerPrewarmByClient = new WeakMap();

function tokenMetaMap(client) {
  let map = tokenMetaByClient.get(client);
  if (!map) {
    map = new Map();
    tokenMetaByClient.set(client, map);
  }
  return map;
}

function tokenPrewarmMap(client) {
  let map = tokenPrewarmByClient.get(client);
  if (!map) {
    map = new Map();
    tokenPrewarmByClient.set(client, map);
  }
  return map;
}

function conditionPrewarmMap(client) {
  let map = conditionPrewarmByClient.get(client);
  if (!map) {
    map = new Map();
    conditionPrewarmByClient.set(client, map);
  }
  return map;
}

export async function resolveClobOrderVersion(client, forceUpdate = false) {
  const cached = versionByClient.get(client);
  if (!forceUpdate && Number.isFinite(cached)) return cached;
  const active = versionPromiseByClient.get(client);
  if (!forceUpdate && active) return active;
  const task = Promise.resolve(client.resolveVersion(forceUpdate)).then((value) => {
    const version = Number(value);
    if (!Number.isFinite(version)) throw new Error(`CLOB version is not numeric (${value})`);
    versionByClient.set(client, version);
    return version;
  });
  versionPromiseByClient.set(client, task);
  try { return await task; }
  finally {
    if (versionPromiseByClient.get(client) === task) versionPromiseByClient.delete(client);
  }
}

export function cachedClobTokenMeta(client, tokenId) {
  return tokenMetaByClient.get(client)?.get(String(tokenId)) || null;
}

function normalizedMarketConstraint(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function readAndCacheTokenMeta(client, tokenId, versionTask, conditionInfo = null) {
  const id = String(tokenId);
  let bookTask = null;
  // A condition-level market-info request supplies mos/mts for both outcomes.
  // When Gamma omitted conditionId, fetch the public book off the order path so
  // the eventual submit still has authoritative tick and minimum-share data.
  if (!conditionInfo && typeof client.getOrderBook === "function") {
    bookTask = Promise.resolve(client.getOrderBook(id)).catch(() => null);
  }
  const marketInfoTask = typeof client._ensureMarketInfoCached === "function"
    ? client._ensureMarketInfoCached(id)
    : Promise.all([
      client.getTickSize?.(id),
      client.getNegRisk?.(id),
      client.getFeeRateBps?.(id),
    ]);
  const [version, , book] = await Promise.all([versionTask, marketInfoTask, bookTask]);
  const tickSize = String(
    conditionInfo?.mts
      ?? book?.tick_size
      ?? client.tickSizes?.[id]
      ?? await client.getTickSize(id),
  );
  const negRisk = Object.hasOwn(client.negRisk || {}, id)
    ? client.negRisk[id] === true
    : conditionInfo?.nr === true || book?.neg_risk === true || await client.getNegRisk(id);
  const numericTick = Number(tickSize);
  if (!(numericTick > 0 && numericTick < 1)) throw new Error(`invalid CLOB tick size ${tickSize} for ${id}`);
  const cachedFee = client.feeInfos?.[id];
  const feeDetails = cachedFee || conditionInfo?.fd || null;
  const meta = Object.freeze({
    tokenId: id,
    tickSize,
    negRisk,
    version,
    minOrderSize: normalizedMarketConstraint(conditionInfo?.mos ?? book?.min_order_size),
    feeRate: normalizedMarketConstraint(feeDetails?.rate ?? feeDetails?.r, 0),
    feeExponent: normalizedMarketConstraint(feeDetails?.exponent ?? feeDetails?.e, 1),
  });
  tokenMetaMap(client).set(id, meta);
  return meta;
}

function signedOrderBody(value) {
  return value?.order && typeof value.order === "object" ? value.order : value;
}

// Exercises the same local EIP-712 limit-order signing path once. The dummy is
// never POSTed and its signature is overwritten before the promise resolves.
export function prewarmClobLimitSignerOnce({ client, Side, tokenMeta, isOrderSubmissionActive } = {}) {
  if (!client || !tokenMeta?.tokenId) return Promise.resolve({ ok: false, skipped: "missing-metadata" });
  const existing = signerPrewarmByClient.get(client);
  if (existing) return existing;
  if (typeof isOrderSubmissionActive === "function" && isOrderSubmissionActive()) {
    return Promise.resolve({ ok: false, skipped: "order-submission-active" });
  }
  const task = (async () => {
    const started = performance.now();
    let signed = null;
    let body = null;
    try {
      // Helpme's automated path is fixed-USD FAK. Exercise that exact local
      // signer path once; no order is POSTed. Explicit price avoids a book GET.
      const tick = Number(tokenMeta.tickSize);
      const price = Math.max(tick, Math.min(1 - tick, 0.5));
      const args = {
        tokenID: tokenMeta.tokenId,
        price,
        amount: 1,
        side: Side.BUY,
        orderType: "FAK",
      };
      signed = typeof client.createMarketOrder === "function"
        ? await client.createMarketOrder(args, {
          tickSize: tokenMeta.tickSize,
          negRisk: tokenMeta.negRisk,
          version: tokenMeta.version,
        })
        : await client.createOrder({
          tokenID: tokenMeta.tokenId,
          price,
          size: 0.01,
          side: Side.BUY,
        }, {
        tickSize: tokenMeta.tickSize,
        negRisk: tokenMeta.negRisk,
        version: tokenMeta.version,
        });
      body = signedOrderBody(signed);
      if (!body || typeof body !== "object" || !body.signature) {
        throw new Error("CLOB signer prewarm did not produce a signed order");
      }
      return Object.freeze({ ok: true, elapsedMs: performance.now() - started, version: tokenMeta.version });
    } finally {
      if (body && typeof body === "object") {
        try { body.signature = "0x"; } catch {}
        if (body.signature !== "0x") throw new Error("CLOB signer prewarm could not redact dummy signature");
      }
    }
  })();
  signerPrewarmByClient.set(client, task);
  return task;
}

export async function prewarmClobTokens({ client, Side, tokenIds = [], conditionId, isOrderSubmissionActive } = {}) {
  const ids = [...new Set((tokenIds || []).filter(Boolean).map(String))];
  if (!client || ids.length === 0) return [];
  const versionTask = resolveClobOrderVersion(client);
  // Gamma already gives Helpme the condition id. One getClobMarketInfo call
  // populates tick/neg-risk/fee metadata for both outcomes, avoiding two token
  // resolution requests. Concurrent lifecycle calls share the same promise.
  let conditionInfo = null;
  if (conditionId && typeof client.getClobMarketInfo === "function"
      && !ids.every((id) => cachedClobTokenMeta(client, id))) {
    const condition = String(conditionId);
    const activeByCondition = conditionPrewarmMap(client);
    let marketTask = activeByCondition.get(condition);
    if (!marketTask) {
      marketTask = Promise.resolve(client.getClobMarketInfo(condition)).finally(() => {
        if (activeByCondition.get(condition) === marketTask) activeByCondition.delete(condition);
      });
      activeByCondition.set(condition, marketTask);
    }
    [, conditionInfo] = await Promise.all([versionTask, marketTask]);
  }
  const activeByToken = tokenPrewarmMap(client);
  const metas = await Promise.all(ids.map((id) => {
    const cached = cachedClobTokenMeta(client, id);
    if (cached) return cached;
    const active = activeByToken.get(id);
    if (active) return active;
    const task = readAndCacheTokenMeta(client, id, versionTask, conditionInfo).finally(() => {
      if (activeByToken.get(id) === task) activeByToken.delete(id);
    });
    activeByToken.set(id, task);
    return task;
  }));
  // Dummy signing is diagnostic only: real signing remains authoritative. A
  // prewarm failure must not make otherwise-valid market metadata unusable.
  try {
    await prewarmClobLimitSignerOnce({ client, Side, tokenMeta: metas[0], isOrderSubmissionActive });
  } catch {}
  return metas;
}

function errorText(value) {
  try {
    return `${value?.error || ""} ${value?.errorMsg || ""} ${value?.message || ""} ${JSON.stringify(value?.response?.data || "")}`.toLowerCase();
  } catch { return String(value || "").toLowerCase(); }
}

function isVersionMismatch(value) {
  return errorText(value).includes("order_version_mismatch");
}

async function refreshedVersionAfterMismatch(client, rejectedVersion) {
  let version = Number(await client.resolveVersion());
  if (!Number.isFinite(version) || version === rejectedVersion) {
    version = await resolveClobOrderVersion(client, true);
  } else {
    versionByClient.set(client, version);
  }
  return version;
}

/**
 * Sign locally, then POST the same order through the already-warm connection.
 * deferExec=true returns on the order acknowledgement instead of waiting for
 * the SDK's settlement-transaction polling.
 */
async function submitOrderFast({
  client,
  userOrder,
  tokenMeta,
  orderType,
  postOnly = false,
  transportReady = null,
  marketOrder = false,
  onOrderPrepared = null,
} = {}) {
  if (!client || !tokenMeta) throw new Error("fast CLOB submit requires client and prewarmed token metadata");
  const started = performance.now();
  // The per-client value can advance after a venue version rejection while a
  // five-minute token's immutable metadata object remains otherwise valid.
  let version = Number(versionByClient.get(client));
  if (!Number.isFinite(version)) version = Number(tokenMeta.version);
  if (!Number.isFinite(version)) version = await resolveClobOrderVersion(client);
  let signed = null;
  let signMs = 0;
  let postStarted = 0;

  const prepare = async () => {
    const signStarted = performance.now();
    const create = marketOrder
      ? client.createMarketOrder.bind(client)
      : client.createOrder.bind(client);
    signed = await create(userOrder, {
      tickSize: tokenMeta.tickSize,
      negRisk: tokenMeta.negRisk,
      version,
    });
    signMs += performance.now() - signStarted;
  };
  const post = async () => {
    postStarted = performance.now();
    return client.postOrder(signed, orderType, !!postOnly, true);
  };
  const notifyPrepared = async () => {
    if (typeof onOrderPrepared === "function") {
      await onOrderPrepared({ signedOrder: signed, version, tokenMeta, orderType, postOnly: !!postOnly });
    }
  };

  await prepare();
  if (transportReady) await transportReady;
  await notifyPrepared();
  let response;
  try { response = await post(); }
  catch (error) {
    if (!isVersionMismatch(error)) throw error;
    version = await refreshedVersionAfterMismatch(client, version);
    await prepare();
    await notifyPrepared();
    response = await post();
  }

  if (isVersionMismatch(response)) {
    // postOrder refreshes the SDK cache after a rejected version. Re-signing is
    // safe because the first order was explicitly rejected by the venue.
    const previousVersion = version;
    version = await refreshedVersionAfterMismatch(client, previousVersion);
    await prepare();
    await notifyPrepared();
    response = await post();
  }

  const completed = performance.now();
  return {
    response,
    version,
    timing: Object.freeze({
      signMs,
      postMs: Math.max(0, completed - postStarted),
      totalMs: Math.max(0, completed - started),
      connection: clobConnectionMeta(response),
    }),
  };
}

export function submitLimitOrderFast(args = {}) {
  return submitOrderFast({ ...args, marketOrder: false });
}

export function submitMarketOrderFast(args = {}) {
  return submitOrderFast({ ...args, marketOrder: true, postOnly: false });
}
