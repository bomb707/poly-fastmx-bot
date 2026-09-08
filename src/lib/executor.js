// lib/executor.js — REUSABLE Polymarket CLOB order executor + order-status watch.
//
// ── LIB BOUNDARY ─────────────────────────────────────────────────────────────────────────────────────
// Self-contained real-order engine, portable across bots. Public API:
//   placeBuy({tokenId, price, sizeShares, expireS, label, postOnly, orderType, fillPx}) → {orderId, filled, spent, avgPx}
//   cancelOrder(orderId) / cancelById / cancelAll / getOpenOrders({market,tokenId})
//   reconcileOrder(orderId, {seedShares, seedSpent, onDelta, onStatus, restTimeoutMs})  ← the STATUS WATCH:
//       late-fill reconcile (getOrder.size_matched + getTrades) + order/on-chain status transitions
//       (LIVE→partially_matched→matched→canceled/expired · MATCHED→MINED→CONFIRMED) + stale-cancel.
//   isLive / liveAddress / getApiCreds / resolveFunder / ensureReadyOrDowngrade / prewarm / getDep / liveStatus
// External deps (the seam to a host bot): config/config.js (executionMode, clobHost/ChainId, livePrivateKey,
//   liveMin/MaxOrderUsd, reconcile*/trackOrder* budgets), keys/dk.js (key resolver), logging/verbose.js.
//   To reuse in another bot: provide those three modules (or swap for injected equivalents). NO strategy coupling.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Aligned with the proven /home/polybots/polystack-bot live path:
//   • @polymarket/clob-client-v2 (object constructor), derive-first L2 auth, split createOrder/postOrder.
//   • ethers v6 → EthersSigner adapter that STRIPS the EIP712Domain type entry (ethers v6's
//     signTypedData computes the domain itself; leaving EIP712Domain in `types` makes it throw).
//   • signatureType + funderAddress MUST match the wallet model. EOA(0) only when the signer IS the
//     funder; a Polymarket proxy needs POLY_GNOSIS_SAFE(2)+funder, else the CLOB 400s every order
//     ("invalid signature"). Configurable via LIVE_SIG_TYPE / LIVE_FUNDER.
//
// SAFETY: default-OFF. Places an order only when config.executionMode === "live" AND a key is set. The
// client is LAZILY imported so simulation never depends on it. Hard per-order cap (LIVE_MAX_ORDER_USD)
// checked BEFORE any client call. Never falls back to simulation on failure — it logs + returns an error.
//
// HEDGE: the opposite-side hedge leg IS placed live — but only once the REAL primary order takes
// shares (driven off the live fill in the CLOB response, never off a simulated fill). See src/index.js.
// Validate on a funded TEST wallet at minimal size before trusting it.
import { ethers } from "ethers";
import { config } from "../config/config.js";
import { getKey, dkConfigured } from "../keys/dk.js";
import { verbose, verboseOn } from "../logging/verbose.js";
import {
  beginClobOrderSubmission,
  clobConnectionStats,
  clobOrderSubmissionActive,
  installClobHttpTransport,
  startClobConnectionWarmer,
  warmClobConnection,
} from "./clobHttpTransport.js";
import {
  cachedClobTokenMeta,
  prewarmClobTokens,
  resolveClobOrderVersion,
  submitLimitOrderFast,
  submitMarketOrderFast,
} from "./clobFastPath.js";
import {
  hashSignedClobOrder,
  signedBuyPrincipalUsd,
  signedBuyShares,
} from "./clobOrderHash.js";

export function isLive() { return !config.simulationOnly && config.executionMode === "live"; }

let _ready = null;     // Promise<{client, Side, OrderType}> once initialized
let _failed = null;    // sticky init error (don't retry a broken config every tick)
let _funderAddr = null; // resolved funder/trading address once init succeeds (for the balance widget)
let _apiCreds = null;   // derived L2 API creds {apiKey,secret,passphrase} — exposed for the user-channel WS auth

/** The wallet the bot trades FROM (funder), once live init has resolved it; null until then. */
export function liveAddress() { return _funderAddr; }
export function getApiCreds() { return _apiCreds; }   // for the user-channel WebSocket subscribe (auth)

let _funderResolving = null;
/**
 * Resolve the live FUNDER wallet (the Polymarket proxy that holds USDC) WITHOUT the full CLOB
 * bootstrap — so the balance widget can show your funder's balance as soon as live mode is
 * configured, even before the bot is started. Cached after the first success. Returns null when
 * not in live mode or credentials aren't set (caller then falls back to the tracked wallet).
 */
export async function resolveFunder() {
  if (_funderAddr) return _funderAddr;                       // already resolved (or set by init)
  if (config.executionMode !== "live") return null;          // simulation → no funder
  if (!_funderResolving) {
    _funderResolving = (async () => {
      try {
        if (dkConfigured()) { const k = await getKey(); return k.profile || k.address || null; }   // dk: profile = funder
        if (config.livePrivateKey) return (process.env.LIVE_FUNDER || new ethers.Wallet(config.livePrivateKey).address); // env: explicit funder or EOA
      } catch (e) { if (verboseOn) verbose("live.resolveFunder_failed", { error: String(e?.message || e) }); }
      return null;
    })();
  }
  const addr = await _funderResolving;
  _funderResolving = null;                                   // clear so a failed resolve can retry later
  if (addr) _funderAddr = addr;                              // cache success
  return _funderAddr;
}

// EthersSigner adapter for clob-client-v2: it calls `_signTypedData(domain, types, value)` (ethers v5
// name). ethers v6 renamed it to `signTypedData` AND rejects a types object that still contains the
// EIP712Domain meta-entry — so strip it. (Exactly the polystack-bot bridge.)
function signerAdapter(pk) {
  const w = new ethers.Wallet(pk);
  return {
    address: w.address,
    getAddress: async () => w.address,
    _signTypedData: (domain, types, value) => {
      const { EIP712Domain, ...typesNoDomain } = types || {};
      return w.signTypedData(domain, typesNoDomain, value);
    },
  };
}

let _downgradeReason = null;   // set when a live wallet failed to connect and we fell back to simulation

// Verify the live wallet can connect; if not, DOWNGRADE to simulation (no real orders, badge shows sim).
// Call at engine start in live mode. Safety: if we can't actually trade, we must not pretend to be live.
export async function ensureReadyOrDowngrade() {
  if (config.executionMode !== "live") return;
  try {
    await init();
    console.log("[live] wallet connected — REAL LIVE armed");
  } catch (e) {
    _downgradeReason = String(e?.message || e);
    config.executionMode = "simulation";   // isLive() now returns false → live routing stops, shadow simulates
    console.error(`[live] wallet connect FAILED → falling back to SIMULATION (no real orders): ${_downgradeReason}`);
  }
}

async function init() {
  if (_failed) throw new Error(_failed);
  if (_ready) return _ready;
  _ready = (async () => {
    const { ClobClient, Chain, Side, OrderType, SignatureTypeV2 } = await import("@polymarket/clob-client-v2");
    let privateKey, funderAddress, sigType, source;
    if (dkConfigured()) {                                   // PREFERRED: resolve key/funder/sig_type from the dk service
      const k = await getKey();
      privateKey = k.privateKey; funderAddress = k.profile || undefined; sigType = k.sign_type ?? SignatureTypeV2.EOA; source = `dk(${k.address})`;
    } else if (config.livePrivateKey) {                     // FALLBACK: raw env key + explicit LIVE_SIG_TYPE/LIVE_FUNDER
      privateKey = config.livePrivateKey;
      sigType = ({ EOA: SignatureTypeV2.EOA, POLY_PROXY: SignatureTypeV2.POLY_PROXY,
        POLY_GNOSIS_SAFE: SignatureTypeV2.POLY_GNOSIS_SAFE, POLY_1271: SignatureTypeV2.POLY_1271 })
        [(process.env.LIVE_SIG_TYPE || "EOA").toUpperCase()] ?? SignatureTypeV2.EOA;
      funderAddress = process.env.LIVE_FUNDER || undefined; source = "env";
    } else {
      throw new Error("EXECUTION_MODE=live but no credentials — set dk (API_KEY/PROTECT_KEY/CIPHERTEXT_JSON) or LIVE_PRIVATE_KEY");
    }
    const signer = signerAdapter(privateKey);
    if (!funderAddress) funderAddress = signer.address;     // EOA: signer is the funder
    const chain = config.clobChainId === 80002 ? Chain.AMOY : Chain.POLYGON;
    installClobHttpTransport(config.clobHost);
    if (verboseOn) verbose("live.init", { source, signer: signer.address, funder: funderAddress, sigType, host: config.clobHost, chainId: config.clobChainId });
    // bootstrap client → derive L2 creds; then full client with creds attached.
    const bootstrap = new ClobClient({ host: config.clobHost, chain, signer, signatureType: sigType, funderAddress, retryOnError: true });
    // Existing wallets already have credentials. Derive first so ordinary
    // restarts avoid a guaranteed failed create request before derivation.
    let creds = null;
    try { creds = await bootstrap.deriveApiKey?.(); } catch {}
    if (!creds?.key) { try { creds = await bootstrap.createApiKey?.(); } catch {} }
    if (!creds?.key && bootstrap.createOrDeriveApiKey) creds = await bootstrap.createOrDeriveApiKey();
    if (!creds?.key) throw new Error("unable to derive CLOB API credentials");
    _apiCreds = creds && creds.key ? { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase } : null;   // for the user-channel WS auth
    if (verboseOn) verbose("live.creds_derived", { apiKey: creds?.key ? String(creds.key).slice(0, 8) + "…" : null, hasSecret: !!creds?.secret, hasPassphrase: !!creds?.passphrase });
    const client = new ClobClient({ host: config.clobHost, chain, signer, creds, signatureType: sigType, funderAddress, retryOnError: true });
    _funderAddr = funderAddress;   // expose the trading wallet for the balance widget
    // Resolve the API version and prime both dedicated LIFO pool sockets off the
    // order path. A periodic /ok keeps the reserve alive between windows.
    try {
      await Promise.allSettled([
        resolveClobOrderVersion(client),
        warmClobConnection({ host: config.clobHost, reason: "client-ready", force: true }),
      ]);
    } catch {}
    startClobConnectionWarmer(config.clobHost, (result) => {
      if (verboseOn && result && !result.ok && !result.skipped) {
        verbose("live.clob_warm_failed", { error: result.error || null, reason: result.reason || null });
      }
    });
    console.log(`[live] CLOB ready · src=${source} · signer=${signer.address} · funder=${funderAddress} · sigType=${sigType} · cap=$${config.liveMaxOrderUsd}`);
    return { client, Side, OrderType };
  })().catch((e) => { _failed = String(e?.message || e); _ready = null; console.error("[live] init FAILED:", _failed); throw e; });
  return _ready;
}

/**
 * PRE-WARM a window's tokens: resolve API version, complete tick/neg-risk/fee
 * metadata, exercise local signing once, and refresh the dedicated HTTPS pool.
 * Call as soon as current/next token ids are known. No-op in simulation.
 */
// Expose the initialized CLOB dependency ({client, Side, OrderType}) for tooling (e.g. the latency harness).
export async function getDep() { return init(); }

export async function prewarm(tokenIds = [], conditionId = null) {
  if (!isLive()) return;
  let dep; try { dep = await init(); } catch { return; }
  const { client, Side } = dep;
  const tokens = (tokenIds || []).filter(Boolean).map(String);
  const results = await Promise.allSettled([
    prewarmClobTokens({ client, Side, tokenIds: tokens, conditionId, isOrderSubmissionActive: clobOrderSubmissionActive }),
    warmClobConnection({ host: config.clobHost, reason: "window-prewarm" }),
  ]);
  if (verboseOn) verbose("live.prewarm", {
    tokens: tokens.map((t) => t.slice(0, 8) + "…"),
    metadataReady: results[0]?.status === "fulfilled",
    transport: clobConnectionStats(),
  });
}

/**
 * Place a REAL marketable BUY. orderType may be FAK (partial fill + cancel remainder), FOK, or GTC;
 * expireS selects GTD and takes precedence. The default remains GTC for manual/legacy callers.
 * @returns {Promise<{orderId?:string,status?:string,filled?:number,error?:string}>}
 */
export async function placeBuy({
  tokenId,
  price,
  sizeShares,
  amountUsd,
  expireS,
  label,
  postOnly,
  orderType: requestedOrderType,
  fillPx,
  onOrderPrepared,
  cancelRemainderAfterMs,
} = {}) {
  if (!isLive()) { if (verboseOn) verbose("order.skip", { reason: "not live (executionMode=" + config.executionMode + ")", label }); return { error: "not live" }; }
  if (!tokenId) { if (verboseOn) verbose("order.skip", { reason: "no tokenId", label }); return { error: "no tokenId" }; }
  const rawPrice = Number(price);
  const requested = String(requestedOrderType || "GTC").toUpperCase();
  const isImmediate = requested === "FAK" || requested === "FOK";
  let requestedPrincipal = Number(amountUsd);
  if (!(requestedPrincipal > 0) && isImmediate) {
    requestedPrincipal = Number(sizeShares) * rawPrice;
  }
  const coarseNotional = isImmediate ? requestedPrincipal : Number(sizeShares) * rawPrice;
  if (!(rawPrice > 0 && rawPrice < 1) || !(coarseNotional > 0)) {
    if (verboseOn) verbose("order.skip", { reason: "invalid price/size", label, price, sizeShares, amountUsd });
    return { error: "invalid price/size" };
  }
  // The order size IS the primary $ (HEAP) config. LIVE_MAX_ORDER_USD is an OPTIONAL hard backstop on
  // top of it (catches a config typo / bad size) — set it to 0 to disable and let the primary $ govern.
  if (config.liveMaxOrderUsd > 0 && coarseNotional > config.liveMaxOrderUsd + 1e-9) {
    if (verboseOn) verbose("order.skip", { reason: "over LIVE_MAX_ORDER_USD cap", label, notional: +coarseNotional.toFixed(2), cap: config.liveMaxOrderUsd });
    return { error: `order $${coarseNotional.toFixed(2)} > LIVE_MAX_ORDER_USD $${config.liveMaxOrderUsd} (safety cap)` };
  }
  // Claim transport priority before the first await. In the normal prewarmed
  // path init/meta are synchronous cache hits; on a collision, signing overlaps
  // the warmer abort and POST waits only for its short drain.
  const releaseClobOrderPriority = beginClobOrderSubmission();
  let dep; try { dep = await init(); } catch (e) {
    releaseClobOrderPriority();
    if (verboseOn) verbose("order.init_failed", { label, error: String(e?.message || e) });
    return { error: "init: " + String(e?.message || e) };
  }
  const { client, Side, OrderType } = dep;
  const startedAt = verboseOn ? Date.now() : 0;
  try {
    let orderType = requested === "FAK" ? OrderType.FAK : (requested === "FOK" ? OrderType.FOK : OrderType.GTC);
    if (postOnly && (orderType === OrderType.FAK || orderType === OrderType.FOK)) {
      throw new Error(`${orderType} cannot be post-only`);
    }
    let tokenMeta = cachedClobTokenMeta(client, tokenId);
    if (!tokenMeta) {
      [tokenMeta] = await prewarmClobTokens({
        client,
        Side,
        tokenIds: [String(tokenId)],
        isOrderSubmissionActive: clobOrderSubmissionActive,
      });
    }
    if (!tokenMeta) throw new Error(`CLOB metadata unavailable for token ${tokenId}`);
    const tick = Number(tokenMeta.tickSize);
    if (!(tick > 0 && tick < 1)) throw new Error(`invalid live tick size ${tokenMeta.tickSize}`);
    // A BUY ceiling must never round upward. Dynamic book metadata supports
    // BTC markets that move to finer ticks.
    const tickSteps = Math.max(1, Math.floor(Math.min(1 - tick, rawPrice) / tick + 1e-9));
    const px = +(tickSteps * tick).toFixed(6);
    const minShares = Number(tokenMeta.minOrderSize) > 0 ? Number(tokenMeta.minOrderSize) : 0;
    const minPrincipal = Math.max(1, Number(config.liveMinOrderUsd) || 0);
    let size = Number(sizeShares) || 0;
    let principal = Number(requestedPrincipal) || 0;
    let userOrder;
    if (isImmediate) {
      // In CLOB V2 a market BUY is fixed maker amount (USD), not fixed shares.
      // The explicit price is the worst-price cap and avoids a REST book walk.
      principal = Math.max(principal, minPrincipal, minShares > 0 ? minShares * px : 0);
      principal = +principal.toFixed(6);
      if (config.liveMaxOrderUsd > 0 && principal > config.liveMaxOrderUsd + 1e-9) {
        throw new Error(`order $${principal.toFixed(2)} > LIVE_MAX_ORDER_USD $${config.liveMaxOrderUsd} (safety cap)`);
      }
      userOrder = { tokenID: String(tokenId), price: px, amount: principal, side: Side.BUY, orderType };
    } else {
      // Limit/GTC size is share-denominated. Enforce the live market's exact
      // share minimum and the crossing-BUY $1 principal floor.
      const minBasis = (fillPx != null && Number(fillPx) > 0) ? Math.min(px, Number(fillPx)) : px;
      if (minBasis > 0 && size * minBasis < minPrincipal - 1e-9) size = Math.ceil((minPrincipal / minBasis) * 100) / 100;
      if (minShares > 0) size = Math.max(size, minShares);
      size = +size.toFixed(2);
      principal = +(size * px).toFixed(6);
      if (config.liveMaxOrderUsd > 0 && principal > config.liveMaxOrderUsd + 1e-9) {
        throw new Error(`order $${principal.toFixed(2)} > LIVE_MAX_ORDER_USD $${config.liveMaxOrderUsd} (safety cap)`);
      }
      userOrder = { tokenID: String(tokenId), price: px, size, side: Side.BUY };
      if (expireS && expireS > 0) {
        userOrder.expiration = Math.floor(Date.now() / 1000) + Math.max(Math.ceil(expireS), 60) + 5;
        orderType = OrderType.GTD;
      }
    }
    let preparedOrderId = null;
    let signedPrincipal = null;
    let signedShares = null;
    const prepared = async ({ signedOrder, version }) => {
      preparedOrderId = hashSignedClobOrder(signedOrder, {
        version,
        negRisk: tokenMeta.negRisk,
        chainId: config.clobChainId,
      });
      signedPrincipal = signedBuyPrincipalUsd(signedOrder);
      signedShares = signedBuyShares(signedOrder);
      if (!(signedPrincipal >= minPrincipal - 1e-9)) {
        throw new Error(`signed BUY principal $${Number(signedPrincipal).toFixed(6)} is below venue minimum $${minPrincipal.toFixed(2)}`);
      }
      if (minShares > 0 && !(signedShares >= minShares - 1e-9)) {
        throw new Error(`signed BUY size ${Number(signedShares).toFixed(6)} is below market minimum ${minShares}`);
      }
      if (typeof onOrderPrepared === "function") {
        await onOrderPrepared({
          orderId: preparedOrderId,
          tokenId: String(tokenId),
          orderType: String(orderType),
          price: px,
          principalUsd: signedPrincipal,
          shares: signedShares,
          version,
          postOnly: !!postOnly,
        });
      }
    };
    if (verboseOn) verbose("order.submit", { label, tokenId: String(tokenId), side: "BUY", price: px,
      size: isImmediate ? null : +size.toFixed(4), amountUsd: isImmediate ? principal : null,
      notional: +principal.toFixed(2), orderType, postOnly: !!postOnly,
      expiration: userOrder.expiration ?? null, tickSize: tokenMeta.tickSize, minOrderSize: minShares || null });
    const submitted = await (isImmediate ? submitMarketOrderFast : submitLimitOrderFast)({
      client, userOrder, tokenMeta, orderType, postOnly: !!postOnly,
      transportReady: releaseClobOrderPriority.warmDrain,
      onOrderPrepared: prepared,
    });
    const res = submitted.response;
    const latencyMs = verboseOn ? Date.now() - startedAt : 0;
    const venueOrderId = String(res?.orderID ?? res?.orderId ?? "");
    const responseError = res?.errorMsg || res?.error || null;
    const acceptedStatus = ["live", "matched", "delayed", "unmatched"].includes(String(res?.status || "").toLowerCase());
    const accepted = res?.success !== false && !responseError && (!!venueOrderId || acceptedStatus);
    const orderId = accepted ? String(venueOrderId || preparedOrderId || "") : "";
    const filled = Number(res?.takingAmount ?? 0) || 0;      // shares actually received
    const spent = Number(res?.makingAmount ?? 0) || 0;       // USDC actually paid (the REAL cost — for honest PnL)
    const avgPx = filled > 0 ? spent / filled : null;        // real average fill price
    const ok = accepted && !!orderId;
    let remainderCancel = null;
    const requestedCancelDelay = Number(cancelRemainderAfterMs);
    const configuredCancelDelay = Number(config.liveGtcCancelRemainderMs);
    const gtcCancelDelay = Number.isFinite(requestedCancelDelay)
      ? Math.max(0, requestedCancelDelay)
      : Math.max(0, Number.isFinite(configuredCancelDelay) ? configuredCancelDelay : 0);
    const canCancelRemainder = ok
      && orderType === OrderType.GTC
      && !postOnly
      && String(res?.status || "").toLowerCase() !== "delayed"
      && Number.isFinite(signedShares)
      && filled + 1e-6 < signedShares;
    if (canCancelRemainder) {
      if (gtcCancelDelay > 0) await new Promise((resolve) => setTimeout(resolve, gtcCancelDelay));
      const cancelStarted = performance.now();
      remainderCancel = await cancelOrder(orderId);
      remainderCancel.cancelCallMs = performance.now() - cancelStarted;
      if (verboseOn) verbose("order.remainder_cancel", {
        orderId,
        requestedShares: signedShares,
        acknowledgedShares: filled,
        delayMs: gtcCancelDelay,
        cancelCallMs: remainderCancel.cancelCallMs,
        canceled: remainderCancel.canceled === true,
        raced: remainderCancel.notCanceledReason || null,
        error: remainderCancel.error || null,
      });
    }
    // FULL raw response (so you can see exactly what the CLOB returned — success or rejection shape).
    if (verboseOn) verbose("order.response", { label, ok, orderId: orderId || null, latencyMs,
      signMs: +submitted.timing.signMs.toFixed(3), postMs: +submitted.timing.postMs.toFixed(3),
      totalSubmitMs: +submitted.timing.totalMs.toFixed(3), connectionReused: submitted.timing.connection?.reusedSocket ?? null,
      status: res?.status ?? null, takingAmount: res?.takingAmount ?? null, makingAmount: res?.makingAmount ?? null,
      errorMsg: responseError, raw: safeRaw(res) });
    const requestedLabel = isImmediate ? `$${principal.toFixed(2)}` : `${size.toFixed(2)}sh`;
    console.log(`[live] BUY ${label || ""} tok=${String(tokenId).slice(0, 10)}… ${requestedLabel} @ ${px} (${orderType}) → ${ok ? "OK" : "FAIL"} ${orderId ? "id=" + orderId : ""} filled=${filled}${(res?.errorMsg || res?.error) ? " err=" + (res.errorMsg || res.error) : ""}`);
    return ok ? {
      orderId, status: String(res?.status ?? "live"), filled, spent, avgPx,
      requestedUsd: isImmediate ? principal : null,
      signedPrincipalUsd: signedPrincipal,
      signedShares,
      remainderCancel,
      latencyMs: submitted.timing.totalMs,
      signMs: submitted.timing.signMs,
      postMs: submitted.timing.postMs,
      connectionReused: submitted.timing.connection?.reusedSocket ?? null,
    } : { error: responseError || "post rejected (no accepted order acknowledgement)" };
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("order.error", { label, latencyMs: startedAt ? Date.now() - startedAt : null, error: msg, stack: (e?.stack || "").split("\n").slice(0, 4).join(" | ") });
    console.error("[live] placeBuy error:", msg);
    return { error: msg };
  } finally {
    releaseClobOrderPriority();
  }
}

/**
 * Place a REAL marketable SELL to CLOSE a position. `price` is the limit FLOOR —
 * pass a low price (e.g. 0.01) for a marketable sell that fills at the current bid. GTC (fills exact shares).
 * @returns {Promise<{orderId?:string,status?:string,sold?:number,proceeds?:number,avgPx?:number,error?:string}>}
 */
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── WS-AS-TRIGGER ───────────────────────────────────────────────────────────────────────────────────
// A running reconcileOrder loop registers a resolver under its orderId WHILE it sleeps between polls. A CLOB
// user-ws order/trade event calls nudgeReconcile(orderId) to end that sleep EARLY → the loop polls immediately
// (~ws speed + one REST round-trip, instead of up to a full poll interval late). The REST poll stays the single
// money-booking source (getTrades pricing + dedup by bookedShares) — the ws only shortens the wait, never books
// PnL, so there is no double-count. A nudge with no registered loop (order already done / not tracked) is a no-op.
const _reconcileNudges = new Map();   // orderId → { t:Timeout, fire:()=>void } for the CURRENT inter-poll sleep
function _sleepNudgeable(orderId, ms) {
  return new Promise((resolve) => {
    const entry = { t: setTimeout(() => { if (_reconcileNudges.get(orderId) === entry) _reconcileNudges.delete(orderId); resolve(); }, ms),
                    fire: () => { clearTimeout(entry.t); if (_reconcileNudges.get(orderId) === entry) _reconcileNudges.delete(orderId); resolve(); } };
    _reconcileNudges.set(orderId, entry);   // one sleep per orderId at a time; a re-register overwrites the prior (already resolved) entry
  });
}
/** WS-AS-TRIGGER hook: end reconcileOrder(orderId)'s current inter-poll sleep NOW so it polls immediately.
 *  Returns true if a loop was waiting (nudged), false if none is tracking this order. Safe to call anytime. */
export function nudgeReconcile(orderId) {
  const n = (orderId != null) ? _reconcileNudges.get(orderId) : null;
  if (n) { n.fire(); return true; }
  return false;
}

// OUR fills of `orderId` across a trades page — as { shares, price, status }. The order can be the TAKER (whole trade
//   is ours: t.size @ t.price) OR a MAKER when a resting remainder fills late (our slice lives in t.maker_orders[] as
//   matched_amount @ that maker order's price). Missing the maker case dropped every late resting fill's exact price.
function myFillsOf(trades, orderId) {
  const out = [];
  for (const t of (trades || [])) {
    const status = String(t.status || "").toUpperCase();
    if (t.taker_order_id === orderId) out.push({ shares: Number(t.size) || 0, price: Number(t.price) || 0, status });
    else if (Array.isArray(t.maker_orders)) {
      for (const mo of t.maker_orders) if (mo && mo.order_id === orderId) out.push({ shares: Number(mo.matched_amount) || 0, price: Number(mo.price) || 0, status });
    }
  }
  return out;
}
// Collapse an order's trades to ONE on-chain status: FAILED/RETRYING dominate; else the LEAST-advanced (laggard)
//   of MATCHED<MINED<CONFIRMED — so "CONFIRMED" means every fill of this order settled.
function tradeStatusOf(trades) {
  const sts = (trades || []).map((t) => String(t.status || "").toUpperCase()).filter(Boolean);
  if (!sts.length) return null;
  if (sts.includes("FAILED")) return "FAILED";
  if (sts.includes("RETRYING")) return "RETRYING";
  const rank = { MATCHED: 1, MINED: 2, CONFIRMED: 3 };
  const ranks = sts.map((s) => rank[s] || 0).filter((r) => r > 0);
  if (!ranks.length) return sts[0];
  const min = Math.min(...ranks);
  return Object.keys(rank).find((k) => rank[k] === min);
}

/**
 * reconcileOrder — CHECK AN ORDER AFTER FIRING: (1) reconcile LATE FILLS (a resting remainder can fill after the
 * synchronous POST response) via getOrder.size_matched + exact getTrades pricing → onDelta; (2) track STATUS
 * TRANSITIONS — order status (live → partially_matched → matched → canceled/expired) and the on-chain trade status
 * (MATCHED → MINED → CONFIRMED / RETRYING / FAILED) → onStatus, each with a timestamp. Bounded, best-effort, never
 * throws. Fill reconcile runs up to config.reconcileFillMaxMs; status tracking (when onStatus given) up to the
 * longer config.trackOrderMaxMs (on-chain confirmation takes tens of seconds).
 *
 * @param {string} orderId
 * @param {object} opts
 * @param {number} opts.seedShares  shares already booked from the POST response (avoid double-counting)
 * @param {number} opts.seedSpent   USDC already booked (cost for a buy / proceeds for a sell)
 * @param {(d:{shares:number,spent:number,avgPx:number|null,matched:number})=>void} opts.onDelta   per NEW fill
 * @param {(s:{phase:"order"|"trade",status:string,ts:number,matched?:number,orig?:number})=>void} opts.onStatus  per status change
 */
export async function reconcileOrder(orderId, { seedShares = 0, seedSpent = 0, onDelta, onStatus, restTimeoutMs = 0 } = {}) {
  if (!isLive() || !orderId) return;
  const fillMaxMs = +config.reconcileFillMaxMs || 0;
  const statusMaxMs = onStatus ? (+config.trackOrderMaxMs || 0) : 0;
  const maxMs = Math.max(fillMaxMs, statusMaxMs);
  if (maxMs <= 0) return;                                        // both disabled
  // Poll cadence: faster (≤1s) while a rest-timeout is armed so the abandon fires close to restTimeoutMs, not a track-interval late.
  const baseInterval = onStatus ? (+config.trackOrderIntervalMs || 1500) : (+config.reconcileFillIntervalMs || 800);
  const intervalMs = Math.max(200, restTimeoutMs > 0 ? Math.min(1000, baseInterval) : baseInterval);
  let dep; try { dep = await init(); } catch { return; }
  const { client } = dep;
  let bookedShares = +seedShares || 0, bookedSpent = +seedSpent || 0;
  let lastOrderStatus = null, lastTradeStatus = null;
  let staleCancelPending = false;   // a stale-cancel was attempted but NOT confirmed (errored) → order may still be live
  const ORDER_TERMINAL = new Set(["CANCELED", "CANCELLED", "EXPIRED", "UNMATCHED"]);
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;
  while (Date.now() < deadline) {
    await _sleepNudgeable(orderId, intervalMs);   // WS-AS-TRIGGER: a user-ws event on this order ends the sleep early → immediate poll
    let ord; try { ord = await client.getOrder(orderId); } catch { continue; }   // transient error → retry next tick
    if (!ord) continue;
    const matched = Number(ord.size_matched ?? 0) || 0;
    const orig = Number(ord.original_size ?? 0) || 0;
    const ordStatusRaw = String(ord.status || "").toUpperCase();
    // Fetch this order's fills once per poll when there's anything matched (used for cost delta AND on-chain status).
    //   myFillsOf handles BOTH taker and maker (resting-remainder) participation → correct price + status either way.
    let myTrades = null;
    if (matched > 0) { try { myTrades = myFillsOf(await client.getTrades({}, /*only_first_page*/ true), orderId); } catch {} }
    // (1) LATE-FILL reconcile — book the delta beyond what's already recorded (exact via trades, else estimate).
    if (matched > bookedShares + 1e-6) {
      let trShares = 0, trCost = 0;
      for (const t of (myTrades || [])) { if (t.status === "FAILED") continue; trShares += t.shares; trCost += t.shares * t.price; }
      const haveTrades = trShares >= matched - 1e-6;
      let dShares, dSpent;
      // Book shares AND cost from the SAME source so avgPx is consistent: from trades when we have them (exact), else
      //   the size_matched delta at the estimated avg. (Old code mixed size_matched shares with trades cost → avgPx skew.)
      if (haveTrades) { dShares = trShares - bookedShares; dSpent = trCost - bookedSpent; bookedShares = trShares; bookedSpent = trCost; }
      else { dShares = matched - bookedShares; const estPx = bookedShares > 0 ? (bookedSpent / bookedShares) : (Number(ord.price) || 0); dSpent = dShares * estPx; bookedShares = matched; bookedSpent += dSpent; }
      if (dShares > 1e-6) { try { onDelta && onDelta({ shares: dShares, spent: Math.max(0, dSpent), avgPx: dShares > 0 ? Math.max(0, dSpent) / dShares : null, matched: bookedShares }); } catch {} }
    }
    // (2) STATUS transitions — order-level, then on-chain trade-level. Emit only on change, with a timestamp.
    if (onStatus) {
      const os = (matched > 0 && matched < orig - 1e-6) ? "PARTIALLY_MATCHED" : ordStatusRaw;
      if (os && os !== lastOrderStatus) { lastOrderStatus = os; try { onStatus({ phase: "order", status: os, ts: Date.now(), matched, orig }); } catch {} }
      const ts = tradeStatusOf(myTrades);
      if (ts && ts !== lastTradeStatus) { lastTradeStatus = ts; try { onStatus({ phase: "trade", status: ts, ts: Date.now() }); } catch {} }
    }
    // STALE ABANDON (entry/hedge): a marketable order that hasn't FULLY filled within restTimeoutMs is stuck → CANCEL the
    //   resting remainder HERE (bookedShares stays the single source of truth → no double-count). Any PARTIAL already booked
    //   via onDelta above is kept. Fires for zero OR partial; no-op when restTimeoutMs is 0 (long-track behavior unchanged).
    if (restTimeoutMs > 0 && (Date.now() - startedAt) >= restTimeoutMs && matched < (orig || Infinity) - 1e-6 && !ORDER_TERMINAL.has(ordStatusRaw)) {
      let cx = null; try { cx = await cancelOrder(orderId); } catch (e) { cx = { error: String(e?.message || e) }; }
      if (cx && cx.canceled) {   // remainder gone → caller frees the pending guard (keeps any booked partial as the position).
        // FINAL RECONCILE: a fill can land between the top-of-loop snapshot and the cancel confirmation → book that delta
        //   now (else the honest ledger + engine under-count the real fill → residual naked leg).
        try { const ord2 = await client.getOrder(orderId); const m2 = Number(ord2?.size_matched ?? 0) || 0;
          if (m2 > bookedShares + 1e-6) { const tr2 = myFillsOf(await client.getTrades({}, true), orderId);
            let trS = 0, trC = 0; for (const t of (tr2 || [])) { if (t.status === "FAILED") continue; trS += t.shares; trC += t.shares * t.price; }
            let dS, dC; if (trS >= m2 - 1e-6) { dS = trS - bookedShares; dC = trC - bookedSpent; bookedShares = trS; bookedSpent = trC; }
            else { dS = m2 - bookedShares; const estPx = bookedShares > 0 ? bookedSpent / bookedShares : (Number(ord2.price) || 0); dC = dS * estPx; bookedShares = m2; bookedSpent += dC; }
            if (dS > 1e-6) { try { onDelta && onDelta({ shares: dS, spent: Math.max(0, dC), avgPx: dS > 0 ? Math.max(0, dC) / dS : null, matched: bookedShares }); } catch {} } }
        } catch {}
        if (onStatus) { try { onStatus({ phase: "order", status: "CANCELED_STALE", ts: Date.now(), matched: bookedShares, orig }); } catch {} }
        return;
      }
      if (cx && cx.notCanceledReason) {
        // cancel LOST the race (order matched in-flight, e.g. "already matched") → keep polling so onDelta books the fill
        //   and the loop breaks on `full`. The real fill clears the guard; do NOT re-attempt the cancel.
        restTimeoutMs = 0; staleCancelPending = false;
        if (onStatus) { try { onStatus({ phase: "order", status: "CANCEL_RACED", ts: Date.now(), matched, orig, note: cx.notCanceledReason }); } catch {} }
      } else {
        // cancel ERRORED / unknown (network/HTTP) → the order is almost certainly STILL LIVE. Keep restTimeoutMs armed to
        //   RETRY the cancel next poll, and mark pending so the deadline does NOT free the guard on a still-live order
        //   (freeing it here would let the strategy re-fire while the resting order can still fill → double position).
        staleCancelPending = true;
        if (onStatus) { try { onStatus({ phase: "order", status: "CANCEL_RETRY", ts: Date.now(), note: (cx && cx.error) || "cancel failed" }); } catch {} }
      }
    }
    // STOP: order canceled/expired/rejected → done. Filled: without status tracking stop now; with it, keep going
    //   until the on-chain trade CONFIRMS/FAILS (or the deadline).
    const full = matched >= (orig || Infinity) - 1e-6;
    if (ORDER_TERMINAL.has(ordStatusRaw)) break;
    if (full && (!onStatus || lastTradeStatus === "CONFIRMED" || lastTradeStatus === "FAILED")) break;
  }
  _reconcileNudges.delete(orderId);   // WS-AS-TRIGGER: drop any lingering nudge resolver on loop exit (defensive; self-deletes on resolve too)
  // DEADLINE with NOTHING filled and no terminal order status (a resting order that never filled or canceled within the
  //   budget) → tell the caller so it can release the engine's pending guard (else the leg stays frozen for the window).
  if (onStatus && bookedShares <= 1e-6 && !ORDER_TERMINAL.has(lastOrderStatus) && !staleCancelPending) {   // fire ONLY if NOTHING ever filled AND we didn't leave an un-canceled (still-live) order — else freeing the guard risks a double
    try { onStatus({ phase: "order", status: "UNFILLED_TIMEOUT", ts: Date.now() }); } catch {}
  }
}

/** Cancel a resting order by its CLOB orderId (for the resting/chase reprice + escalate). Best-effort, never throws. */
export async function cancelOrder(orderId) {
  if (!isLive() || !orderId) return { error: "not live / no orderId" };
  let dep; try { dep = await init(); } catch (e) { return { error: "init: " + String(e?.message || e) }; }
  const { client } = dep;
  try {
    const res = await client.cancelOrder({ orderID: String(orderId) });
    // CLOB response = { canceled: string[], not_canceled: { [orderId]: reason } }. An order that filled during the
    //   cancel round-trip lands in not_canceled (e.g. "order already matched") → canceled:false so the caller adopts
    //   the fill instead of firing a replacement (the cancel/fill race).
    const nc = res && res.not_canceled && typeof res.not_canceled === "object" ? res.not_canceled[String(orderId)] : null;
    const inCanceled = !!(res && Array.isArray(res.canceled) && res.canceled.map(String).includes(String(orderId)));
    // POSITIVE confirmation only: require the id in `canceled` AND not in `not_canceled`. An ambiguous/empty response is
    //   treated as NOT canceled (safe) — the caller then keeps polling instead of freeing the guard and risking a re-fire
    //   into a double position if the order was actually still live.
    const canceled = inCanceled && !nc;
    if (verboseOn) verbose("order.cancel", { orderId: String(orderId), canceled, notCanceledReason: nc || null, raw: safeRaw(res) });
    return { ok: true, canceled, notCanceledReason: nc || null, res };
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("order.cancel_error", { orderId: String(orderId), error: msg });
    console.error("[live] cancelOrder error:", msg);
    return { error: msg };
  }
}


/**
 * List the funder's OPEN (resting, unfilled) orders on the CLOB — for the manual-order panel.
 * Optionally filter to one market (conditionId) / one token (asset_id). Returns [] in simulation.
 * @returns {Promise<Array<{orderId:string,tokenId:string,side:string,price:number,size:number,filled:number,remaining:number,status:string}>>}
 */
export async function getOpenOrders({ market, tokenId } = {}) {
  if (!isLive()) return [];
  let dep; try { dep = await init(); } catch { return []; }
  const { client } = dep;
  try {
    const params = {};
    if (market) params.market = String(market);
    if (tokenId) params.asset_id = String(tokenId);
    const res = await client.getOpenOrders(Object.keys(params).length ? params : undefined);
    const rows = Array.isArray(res) ? res : (res?.data ?? res?.orders ?? []);
    return (rows || []).map((o) => {
      const size = Number(o.original_size ?? o.originalSize ?? o.size ?? 0) || 0;
      const filled = Number(o.size_matched ?? o.sizeMatched ?? o.filled ?? 0) || 0;
      return {
        orderId: String(o.id ?? o.orderID ?? o.orderId ?? ""),
        tokenId: String(o.asset_id ?? o.assetId ?? o.tokenID ?? o.tokenId ?? ""),
        side: String(o.side ?? "").toUpperCase(),
        price: Number(o.price ?? 0) || 0,
        size, filled, remaining: Math.max(0, size - filled),
        status: String(o.status ?? o.order_status ?? "open"),
        outcome: o.outcome ?? null,
      };
    }).filter((o) => o.orderId);
  } catch (e) {
    if (verboseOn) verbose("order.open_list_failed", { error: String(e?.message || e) });
    return [];
  }
}

/** Cancel one resting order by id. Returns {ok} or {error}. */
export async function cancelById(orderId) {
  if (!isLive()) return { error: "not live" };
  if (!orderId) return { error: "no orderId" };
  let dep; try { dep = await init(); } catch (e) { return { error: "init: " + String(e?.message || e) }; }
  const { client } = dep;
  try {
    const res = await client.cancelOrder({ orderID: String(orderId) });
    if (verboseOn) verbose("order.cancel", { orderId: String(orderId), raw: safeRaw(res) });
    console.log(`[live] CANCEL id=${orderId} → ${JSON.stringify(res?.canceled ?? res?.not_canceled ?? res ?? "")}`);
    return { ok: true, raw: res };
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("order.cancel_failed", { orderId: String(orderId), error: msg });
    return { error: msg };
  }
}

/** Cancel ALL of the funder's resting orders. Returns {ok, canceled} or {error}. */
export async function cancelAll() {
  if (!isLive()) return { error: "not live" };
  let dep; try { dep = await init(); } catch (e) { return { error: "init: " + String(e?.message || e) }; }
  const { client } = dep;
  try {
    const res = await client.cancelAll();
    const canceled = Array.isArray(res?.canceled) ? res.canceled.length : null;
    if (verboseOn) verbose("order.cancel_all", { canceled, raw: safeRaw(res) });
    console.log(`[live] CANCEL-ALL → canceled=${canceled ?? JSON.stringify(res ?? "")}`);
    return { ok: true, canceled, raw: res };
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("order.cancel_all_failed", { error: msg });
    return { error: msg };
  }
}

// Compact, safe stringify of the CLOB response for the verbose log (cap size so a huge payload can't flood).
function safeRaw(res) {
  try { const s = JSON.stringify(res); return s.length > 600 ? s.slice(0, 600) + "…" : s; } catch { return String(res); }
}

// For the UI badge / status endpoint.
export function liveStatus() {
  if (config.simulationOnly) return { mode: "simulation", live: false, configured: false, source: null,
    simulationOnly: true, failed: null, downgraded: false, downgradeReason: null,
    maxOrderUsd: 0, clobTransport: clobConnectionStats() };
  return { mode: config.executionMode, live: isLive(),
    configured: dkConfigured() || !!config.livePrivateKey,
    source: dkConfigured() ? "dk" : (config.livePrivateKey ? "env" : null),
    failed: _failed, downgraded: !!_downgradeReason, downgradeReason: _downgradeReason,
    maxOrderUsd: config.liveMaxOrderUsd,
    takerOrderType: config.liveTakerOrderType,
    gtcCancelRemainderMs: config.liveGtcCancelRemainderMs,
    clobTransport: clobConnectionStats() };
}
