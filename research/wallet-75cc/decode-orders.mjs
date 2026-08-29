#!/usr/bin/env node
// Decode the target wallet's exact signed Exchange V2 taker order from each
// public settlement transaction. Polygon block time is deliberately ignored.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "../../src/config/config.js";
import { quantile } from "../wallet-3048/core.mjs";
import { decodeTargetOrders, groupSignedOrders } from "../wallet-3048/signed-orders.mjs";
import { TARGET_WALLET } from "./constants.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(root, "data/wallet-75cc/trades.json"));
const outDir = path.resolve(process.argv[3] || path.join(root, "data/wallet-75cc"));
const journalFile = path.join(outDir, "onchain-tx-orders.ndjson");
const outputFile = path.join(outDir, "signed-orders.json.gz");
const summaryFile = path.join(outDir, "signed-orders-summary.json");
const batchSize = Math.max(1, Number(process.env.W75CC_RPC_BATCH_SIZE || 75));
const concurrency = Math.max(1, Number(process.env.W75CC_RPC_CONCURRENCY || 4));
const rpcUrl = process.env.ONCHAIN_RPC || config.onchainRpc;

fs.mkdirSync(outDir, { recursive: true });
const source = JSON.parse(fs.readFileSync(input, "utf8"));
const hashes = [...new Set(source.trades.map((row) => String(row.transactionHash || "").toLowerCase()).filter(Boolean))];
const cached = new Map();
if (fs.existsSync(journalFile)) {
  for (const line of fs.readFileSync(journalFile, "utf8").split("\n")) {
    if (!line) continue;
    try { const row = JSON.parse(line); if (row.txHash) cached.set(row.txHash, row); } catch {}
  }
}
const pending = hashes.filter((hash) => !cached.has(hash));
console.log(JSON.stringify({ phase: "start", transactions: hashes.length, cached: cached.size, pending: pending.length, batchSize, concurrency, rpcHost: new URL(rpcUrl).hostname }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpcBatch(batch) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const body = batch.map((txHash, index) => ({ jsonrpc: "2.0", id: index + 1, method: "eth_getTransactionByHash", params: [txHash] }));
      const response = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json)) throw new Error("RPC did not return a batch array");
      const byId = new Map(json.map((row) => [row.id, row]));
      return batch.map((txHash, index) => {
        const item = byId.get(index + 1);
        if (item?.error) return { txHash, error: item.error.message || "RPC error", orders: [] };
        const tx = item?.result;
        return { txHash, to: tx?.to?.toLowerCase() || null, orders: decodeTargetOrders(tx, TARGET_WALLET) };
      });
    } catch (error) {
      if (attempt === 7) throw error;
      await sleep(Math.min(10_000, 250 * 2 ** attempt));
    }
  }
  return [];
}

const batches = [];
for (let index = 0; index < pending.length; index += batchSize) batches.push(pending.slice(index, index + batchSize));
let cursor = 0, completed = cached.size, failures = 0, lastLog = Date.now();
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
  while (cursor < batches.length) {
    const index = cursor++, batch = batches[index];
    let rows;
    try { rows = await rpcBatch(batch); }
    catch (error) {
      failures += batch.length;
      console.error(JSON.stringify({ phase: "rpc-error", batch: index + 1, batches: batches.length, error: error.message }));
      continue;
    }
    for (const row of rows) {
      cached.set(row.txHash, row);
      fs.appendFileSync(journalFile, JSON.stringify(row) + "\n");
      completed++;
    }
    if (Date.now() - lastLog > 5_000 || completed === hashes.length) {
      console.log(JSON.stringify({ phase: "decode", completed, total: hashes.length, batch: index + 1, batches: batches.length, failures }));
      lastLog = Date.now();
    }
  }
}));

const decodedTransactions = hashes.map((hash) => cached.get(hash)).filter(Boolean);
const grouped = groupSignedOrders(decodedTransactions, source.trades);
const groups = grouped.groups;
const q = (selector, probability) => quantile(groups.map(selector).filter(Number.isFinite), probability);
const quantiles = (selector) => Object.fromEntries([["min", 0], ["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9], ["p99", .99], ["max", 1]]
  .map(([name, probability]) => [name, q(selector, probability)]));
const countBy = (selector) => Object.fromEntries([...groups.reduce((map, row) => {
  const key = String(selector(row)); map.set(key, (map.get(key) || 0) + 1); return map;
}, new Map())].sort((a, b) => b[1] - a[1]));
const summary = {
  schema: 1, wallet: TARGET_WALLET, input, generatedAt: new Date().toISOString(),
  publicTransactions: hashes.length,
  decodedTransactions: decodedTransactions.length,
  transactionsWithTargetOrder: decodedTransactions.filter((row) => row.orders?.length).length,
  transactionsWithDecodeError: decodedTransactions.filter((row) => row.error).length,
  decodedOrderAppearances: grouped.decodedOrders,
  appearancesJoinedToPublicFills: grouped.joinedOrders,
  uniqueSignedOrders: groups.length,
  roleCounts: countBy((group) => group.settlementRoles.join("+")),
  sideCounts: countBy((group) => group.isBuy ? "BUY" : "SELL"),
  limitPrice: quantiles((group) => group.limitPrice),
  minimumSharesAtLimit: quantiles((group) => group.signedShares),
  budgetUsd: quantiles((group) => group.signedBudgetUsd),
  actualFilledShares: quantiles((group) => group.filledShares),
  betterPriceShareExpansion: quantiles((group) => group.signedShares > 0 ? group.filledShares / group.signedShares : null),
  signedTimestampToFirstPublicMs: quantiles((group) => group.firstPublicTs != null ? group.firstPublicTs * 1000 - group.signedTimestampMs : null),
  note: "For a BUY, makerAmount is the fixed USDC budget and takerAmount is the minimum tokens received at the signed limit. A better execution price can make filledShares exceed minimumSharesAtLimit. The signed timestamp is construction time, not fire time; block time is unused.",
};
fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify({ schema: 1, wallet: TARGET_WALLET, summary, groups }), { level: 9 }));
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ phase: "done", outputFile, summary }, null, 2));
