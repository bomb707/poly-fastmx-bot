#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "../src/config/config.js";
import { decodeMakerLegsFromTransaction } from "./strict-maker-flow-model.mjs";

const root = path.resolve(import.meta.dirname, "..");
const input = path.resolve(process.argv[2] || path.join(root, "data/research/strict-maker-flow-candidates.json"));
const outDir = path.resolve(process.argv[3] || path.join(root, "data/research/strict-maker-flow-transactions"));
const batchSize = Math.max(1, Math.min(100, Number(process.env.STRICT_FLOW_RPC_BATCH_SIZE || 25)));
const concurrency = Math.max(1, Math.min(8, Number(process.env.STRICT_FLOW_RPC_CONCURRENCY || 2)));
const rpcUrl = String(process.env.ONCHAIN_RPC || config.onchainRpc).trim();
if (!rpcUrl) throw new Error("ONCHAIN_RPC is required");

const source = JSON.parse(fs.readFileSync(input, "utf8"));
const rawCandidates = source.transactions || source.candidates || [];
const hashes = [...new Set(rawCandidates.map((row) => String(row?.transactionHash || row?.txHash || "").toLowerCase())
  .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)))];
const invalidHashes = rawCandidates.length - hashes.length;
fs.mkdirSync(outDir, { recursive: true });
const fileFor = (hash) => path.join(outDir, `${hash}.json.gz`);
const read = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const cached = [], pending = [];
for (const hash of hashes) {
  const file = fileFor(hash);
  if (fs.existsSync(file)) {
    try {
      const row = read(file);
      if (row?.txHash === hash && row?.status === "decoded") { cached.push(row); continue; }
    } catch {}
  }
  pending.push(hash);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpcBatch(batch) {
  let last;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const request = batch.map((hash, index) => ({
        jsonrpc: "2.0", id: index + 1, method: "eth_getTransactionByHash", params: [hash],
      }));
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("RPC batch response was not an array");
      const byId = new Map(body.map((row) => [Number(row.id), row]));
      return batch.map((hash, index) => {
        const item = byId.get(index + 1);
        if (item?.error) return { txHash: hash, status: "rpc-error", reason: String(item.error.message || "RPC error"), makerLegs: [] };
        if (!item?.result) return { txHash: hash, status: "not-found", reason: "transaction-not-found", makerLegs: [] };
        const decoded = decodeMakerLegsFromTransaction(item.result);
        return { schema: 1, txHash: hash, exchange: String(item.result.to || "").toLowerCase(), ...decoded };
      });
    } catch (error) {
      last = error;
      if (attempt < 6) await sleep(Math.min(8_000, 250 * 2 ** attempt));
    }
  }
  throw last;
}

const batches = [];
for (let index = 0; index < pending.length; index += batchSize) batches.push(pending.slice(index, index + batchSize));
let next = 0, done = 0;
const collected = [], errors = [];
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
  while (true) {
    const index = next++;
    if (index >= batches.length) return;
    let rows;
    try { rows = await rpcBatch(batches[index]); }
    catch (error) {
      for (const hash of batches[index]) errors.push({ txHash: hash, status: "rpc-error", reason: String(error?.message || error) });
      done += batches[index].length;
      continue;
    }
    for (const row of rows) {
      if (row.status === "decoded") {
        fs.writeFileSync(fileFor(row.txHash), zlib.gzipSync(JSON.stringify(row), { level: 6 }));
        collected.push(row);
      } else errors.push(row);
    }
    done += rows.length;
    if (done % 250 === 0 || done === pending.length) {
      console.log(JSON.stringify({ phase: "strict-maker-flow-rpc", done, total: pending.length, decoded: collected.length, errors: errors.length }));
    }
  }
}));

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  input,
  outDir,
  candidates: rawCandidates.length,
  uniqueValidTransactions: hashes.length,
  invalidHashes,
  cached: cached.length,
  decoded: collected.length,
  failed: errors.length,
  makerLegs: cached.concat(collected).reduce((sum, row) => sum + Number(row.makerLegs?.length || 0), 0),
  errors: errors.slice(0, 50),
};
console.log(JSON.stringify(summary, null, 2));
if (invalidHashes || errors.length) process.exitCode = 2;
