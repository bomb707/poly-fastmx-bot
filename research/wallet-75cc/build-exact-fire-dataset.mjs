#!/usr/bin/env node
import path from "node:path";
import { buildExactFireDataset } from "./weekly-parity-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const cohortDir = path.resolve(process.argv[2]
  || path.join(root, "data/wallet-75cc/exact-2026-08-20_2026-08-27"));
const cacheDir = path.resolve(process.argv[3] || path.join(root, "data/wincache"));
const outputFile = path.resolve(process.argv[4] || path.join(cohortDir, "exact-fire-dataset.json.gz"));
const collectionFile = path.resolve(process.argv[5] || path.join(cohortDir, "target-collection.json"));
const signedOrdersFile = path.resolve(process.argv[6] || path.join(cohortDir, "signed-orders.json.gz"));

const summary = buildExactFireDataset({
  collectionFile,
  signedOrdersFile,
  cacheDir,
  outputFile,
});
console.log(JSON.stringify({ outputFile, summary }, null, 2));
