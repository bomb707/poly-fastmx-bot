// onchain.js — decode the REAL maker order(s) behind a fill's transactionHash, via a Polygon RPC.
//
// The public activity API only shows FILLS. Each fill's tx is a Polymarket CTF/NegRisk Exchange
// `matchOrders` call whose logs + calldata carry the actual signed orders:
//   • OrderFilled events → orderHash (unique id), filled amounts, fee (0 = maker)
//   • matchOrders calldata → each Order struct: full size, limit/cap price, placement timestamp
//
// A sweep tx can hold MANY orders (one taker vs dozens of makers), so we ABI-DECODE with ethers
// (a naive word-walk anchors on the wrong order) and return ALL of OUR wallet's orders in the tx,
// each merged with its OrderFilled event by tokenId+side. Cached by txHash. null/[] on failure.
import { ethers } from "ethers";
import { config } from "../config/config.js";

const cache = new Map();
// Wallet is read at call time (config.wallet is mutated live by the UI), so the
// decode always targets the CURRENTLY tracked wallet. clearCache() is called on switch.
const wallet = () => config.wallet.toLowerCase();
const walletPad = () => "0x" + "0".repeat(24) + wallet().slice(2);   // wallet as a 32-byte topic
export function clearCache() { cache.clear(); }

// This exchange's non-standard Order tuple + the OrderFilled event.
const ORDER = "tuple(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)";
const iface = new ethers.Interface([`function matchOrders(bytes32,${ORDER},${ORDER}[],uint256,uint256[],uint256,uint256[])`]);
const dword = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));

async function rpc(method, params) {
  const r = await fetch(config.onchainRpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

/** All of OUR wallet's orders in a tx → [{orderHash,isBuy,tokenId,filledSize,fee,fullSize,limitPx,placedMs,placedTs,type}]. */
export async function ordersForTx(txHash) {
  if (!txHash) return [];
  if (cache.has(txHash)) return cache.get(txHash);
  const PAD = walletPad(), WALLET = wallet();   // current tracked wallet (read per call)
  let out = [];
  try {
    const [rc, tx] = await Promise.all([
      rpc("eth_getTransactionReceipt", [txHash]),
      rpc("eth_getTransactionByHash", [txHash]),
    ]);
    if (!rc || !tx) { cache.set(txHash, []); return []; }
    // fill time = the tx's block timestamp (on-chain is whole seconds; ms = ts·1000). Same for all
    // OrderFilled in the tx. (placedTs above is the order's own ms timestamp = when it was placed.)
    let filledTs = null;
    try { const blk = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]); if (blk) filledTs = parseInt(blk.timestamp, 16); } catch {}

    // 1) OrderFilled events for our wallet, decoded by STRUCTURE (this exchange's event sig is
    //    non-standard, so match the 4-topic log with maker==wallet rather than by signature hash):
    //    topics = [sig, orderHash, maker, taker]; data = makerAssetId,takerAssetId,makerFilled,takerFilled,fee.
    const events = [];
    for (const lg of rc.logs) {
      if (lg.topics.length !== 4 || !lg.topics[2] || lg.topics[2].toLowerCase() !== PAD || lg.data.length < 2 + 5 * 64) continue;
      const makerAsset = dword(lg.data, 0), takerAsset = dword(lg.data, 1), makerF = dword(lg.data, 2), takerF = dword(lg.data, 3), fee = dword(lg.data, 4);
      const isBuy = makerAsset === 0n;                                 // maker paid USDC ⇒ BUY
      const tokenId = (isBuy ? takerAsset : makerAsset).toString();
      // BUY: makerF = USDC spent (cost basis); takerF = shares. SELL: the reverse.
      events.push({ orderHash: lg.topics[1], isBuy, tokenId, filledSize: Number(isBuy ? takerF : makerF) / 1e6, usdc: Number(isBuy ? makerF : takerF) / 1e6, fee: Number(fee) / 1e6 });
    }

    // 2) calldata Order structs for our wallet → full size, limit, placement ms (best-effort).
    //    matchOrders(salt, TAKER_ORDER, MAKER_ORDERS[], ...): the FIRST order is the marketable taker
    //    (the aggressor — FAK/FOK, pays the fee), the rest are the resting makers it matched (GTC, no fee).
    const calls = [];
    try {
      const d = iface.parseTransaction({ data: tx.input });
      const tagged = [[d.args[1], true], ...d.args[2].map((o) => [o, false])];   // [order, isTakerOrder]
      for (const [o, isTakerOrder] of tagged) {
        if (o[1].toLowerCase() !== WALLET) continue;
        const isBuy = Number(o[6]) === 0, mAmt = Number(o[4]) / 1e6, tAmt = Number(o[5]) / 1e6, ms = Number(o[8]);
        const limitPx = isBuy ? (tAmt ? mAmt / tAmt : null) : (mAmt ? tAmt / mAmt : null);
        calls.push({ tokenId: o[3].toString(), isBuy, marketable: isTakerOrder,
          // BUY: makerAmount = USDC the order offers, takerAmount = shares at the LIMIT price.
          //   maker (GTC): orderSize = the resting share size (takerAmount).
          //   taker (marketable): there is NO fixed share size — it spends up to `budgetUsdc` and takes
          //   whatever shares that buys at the realized price (cheaper than limit ⇒ MORE shares than tAmt).
          orderSize: isBuy ? tAmt : mAmt,
          budgetUsdc: isBuy ? mAmt : null,
          limitPx,
          placedMs: (ms > 1e12 && ms < 2e12) ? ms : null });
      }
    } catch { /* not a matchOrders call / unparseable → event-only */ }

    // 3) merge each event with its calldata order (by tokenId + side)
    out = events.map((e) => {
      const c = calls.find((c) => c.tokenId === e.tokenId && c.isBuy === e.isBuy) || {};
      const marketable = !!c.marketable;       // our order was the aggressor (taker) in this match
      // For a resting MAKER, fullSize is the order's share size and filled≤fullSize is meaningful.
      // For a marketable TAKER, the share count is whatever the budget bought (often > orderSize when
      // it fills below its limit), so we DON'T expose a share "fullSize" (it's not a cap).
      const fullSize = marketable ? null : (c.orderSize ?? null);
      const fullyFilled = marketable ? true : (fullSize != null ? (e.filledSize >= fullSize - 1e-6) : null);
      return {
        orderHash: e.orderHash, isBuy: e.isBuy, tokenId: e.tokenId,
        filledSize: e.filledSize, fullSize, fullyFilled, marketable,
        remaining: marketable ? 0 : (fullSize != null ? Math.max(0, +(fullSize - e.filledSize).toFixed(6)) : null),
        limitPx: c.limitPx ?? null, budgetUsdc: c.budgetUsdc ?? null,
        placedMs: c.placedMs ?? null, placedTs: c.placedMs ? Math.floor(c.placedMs / 1000) : null,
        filledTs, filledMs: filledTs != null ? filledTs * 1000 : null,   // this fill's on-chain block time
        // Time-in-force: a MAKER fill is a resting GTC (GTC vs GTD not distinguishable — the Order struct
        // has no expiration field). A TAKER fill is marketable → FAK (immediate, partial OK). The
        // fee>0 ⇔ taker invariant is the cross-check (makers pay no fee on this exchange).
        type: marketable ? "FAK" : "GTC", fee: e.fee, usdc: e.usdc,   // usdc = cost basis (BUY) actually paid on-chain
      };
    });
  } catch { out = []; }
  cache.set(txHash, out);
  return out;
}

/** Single-order convenience: pick the order matching `asset` (tokenId), else the first. */
export async function orderForTx(txHash, asset) {
  const arr = await ordersForTx(txHash);
  if (!arr.length) return null;
  if (asset != null) { const m = arr.find((o) => o.tokenId === String(asset)); if (m) return m; }
  return arr[0];
}

export function _cacheSize() { return cache.size; }
