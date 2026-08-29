#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { config } from "../../src/config/config.js";
import { WALLET_3048, quantile } from "./core.mjs";
import { decodeTargetOrders, groupSignedOrders } from "./signed-orders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const input = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048/trades-2026-08-14_2026-08-22.json"));
const outDir = path.resolve(process.argv[3] || path.join(root, "data/wallet-3048"));
const journalFile = path.join(outDir, "onchain-tx-orders.ndjson");
const outputFile = path.join(outDir, "signed-orders.json.gz");
const summaryFile = path.join(outDir, "signed-orders-summary.json");
const batchSize = Math.max(1, Number(process.env.RPC_BATCH_SIZE || 30));
const concurrency = Math.max(1, Number(process.env.RPC_CONCURRENCY || 2));
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
console.log(`signed-order decode: ${hashes.length} transactions, ${cached.size} cached, ${pending.length} pending`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpcBatch(batch) {
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const body = batch.map((txHash, index) => ({ jsonrpc: "2.0", id: index + 1, method: "eth_getTransactionByHash", params: [txHash] }));
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json)) throw new Error("RPC did not return a batch array");
      const byId = new Map(json.map((row) => [row.id, row]));
      return batch.map((txHash, index) => {
        const item = byId.get(index + 1);
        if (item?.error) return { txHash, error: item.error.message || "RPC error", orders: [] };
        const tx = item?.result;
        return { txHash, to: tx?.to?.toLowerCase() || null, orders: decodeTargetOrders(tx, WALLET_3048) };
      });
    } catch (error) {
      if (attempt === 6) throw error;
      await sleep(300 * 2 ** attempt);
    }
  }
  return [];
}

const batches = [];
for (let index = 0; index < pending.length; index += batchSize) batches.push(pending.slice(index, index + batchSize));
let nextBatch = 0, completed = cached.size, failures = 0, lastLog = Date.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (nextBatch < batches.length) {
    const index = nextBatch++;
    const batch = batches[index];
    let rows;
    try { rows = await rpcBatch(batch); }
    catch (error) {
      failures += batch.length;
      console.error(`batch ${index + 1}/${batches.length} failed: ${error.message}`);
      continue;
    }
    for (const row of rows) {
      cached.set(row.txHash, row);
      fs.appendFileSync(journalFile, JSON.stringify(row) + "\n");
      completed++;
    }
    if (Date.now() - lastLog > 5000 || completed === hashes.length) {
      console.log(`decoded ${completed}/${hashes.length}; batches ${index + 1}/${batches.length}; failures ${failures}`);
      lastLog = Date.now();
    }
  }
}));

const decodedTransactions = hashes.map((hash) => cached.get(hash)).filter(Boolean);
const grouped = groupSignedOrders(decodedTransactions, source.trades);
const groups = grouped.groups;
const values = (selector) => groups.map(selector).filter(Number.isFinite);
const roleCounts = {};
for (const group of groups) {
  const key = group.settlementRoles.join("+");
  roleCounts[key] = (roleCounts[key] || 0) + 1;
}
const summary = {
  schema: 1,
  wallet: WALLET_3048,
  input,
  generatedAt: new Date().toISOString(),
  publicTransactions: hashes.length,
  decodedTransactions: decodedTransactions.length,
  transactionsWithTargetOrder: decodedTransactions.filter((row) => row.orders?.length).length,
  decodedOrderAppearances: grouped.decodedOrders,
  appearancesJoinedToPublicFills: grouped.joinedOrders,
  uniqueSignedOrders: groups.length,
  roleCounts,
  mixedTakerMakerOrders: groups.filter((group) => group.settlementRoles.includes("maker") && group.settlementRoles.includes("taker")).length,
  multiSettlementOrders: groups.filter((group) => group.settlements.length > 1).length,
  contractCounts: Object.fromEntries([...decodedTransactions.reduce((map, row) => map.set(row.to, (map.get(row.to) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])),
  limitPrice: Object.fromEntries([[0, 0], [.1, .1], [.25, .25], [.5, .5], [.75, .75], [.9, .9], [1, 1]].map(([name, probability]) => [`p${Math.round(name * 100)}`, quantile(values((group) => group.limitPrice), probability)])),
  signedShares: Object.fromEntries([[0, 0], [.1, .1], [.25, .25], [.5, .5], [.75, .75], [.9, .9], [1, 1]].map(([name, probability]) => [`p${Math.round(name * 100)}`, quantile(values((group) => group.signedShares), probability)])),
  settlementsPerOrder: Object.fromEntries([[0, 0], [.5, .5], [.9, .9], [.99, .99], [1, 1]].map(([name, probability]) => [`p${Math.round(name * 100)}`, quantile(values((group) => group.settlements.length), probability)])),
  signedTimestampToFirstPublicMs: Object.fromEntries([[0, 0], [.1, .1], [.5, .5], [.9, .9], [1, 1]].map(([name, probability]) => [`p${Math.round(name * 100)}`, quantile(values((group) => group.firstPublicTs != null ? group.firstPublicTs * 1000 - group.signedTimestampMs : null), probability)])),
  note: "signedTimestampMs is retained only to prove it is not fire time; order-book inference supplies fire time",
};
fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify({ schema: 1, wallet: WALLET_3048, summary, groups }), { level: 9 }));
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${outputFile}`);
