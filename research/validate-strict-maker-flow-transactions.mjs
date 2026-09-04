#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { economicBuyFlow } from "./strict-maker-flow-model.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifestFile = path.resolve(process.argv[2] || path.join(root, "data/research/strict-maker-all-markets.json"));
const exactDir = path.resolve(process.argv[3] || path.join(root, "data/research/strict-maker-flow-transactions"));
const output = path.resolve(process.argv[4] || path.join(root, "data/research/strict-maker-flow-validation.json"));
const tradeDirs = String(process.env.MAKER_TRADE_DIRS || [
  "data/research/strict-maker-all-market-feeds/market-trades",
  "data/passive-maker-forward-v15/feeds/market-trades",
].map((entry) => path.join(root, entry)).join(path.delimiter)).split(path.delimiter).filter(Boolean);
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const markets = new Map(manifest.markets.map((market) => [String(market.slug), market]));
const files = fs.readdirSync(exactDir).filter((name) => /^0x[0-9a-f]{64}\.json\.gz$/.test(name));
const wanted = new Set(files.map((name) => name.slice(0, -8)));
const tradesByHash = new Map();
let conflictingPublicRows = 0;
for (const [slug, market] of markets) {
  let file = null;
  for (const dir of tradeDirs) {
    const candidate = path.join(dir, `${slug}.json.gz`);
    if (fs.existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) continue;
  for (const trade of readGzip(file).trades || []) {
    const hash = String(trade.transactionHash || "").toLowerCase();
    if (!wanted.has(hash)) continue;
    const normalized = { slug, market, outcome: String(trade.outcome), size: Number(trade.size),
      side: String(trade.side), sourceSide: String(trade.sourceSide), sourceOutcome: String(trade.sourceOutcome),
      sourcePrice: Number(trade.sourcePrice), price: Number(trade.price), ms: Number(trade.ms) };
    const previous = tradesByHash.get(hash);
    if (previous && (previous.slug !== normalized.slug || previous.outcome !== normalized.outcome
      || Math.abs(previous.size - normalized.size) > 1e-6)) conflictingPublicRows++;
    else if (!previous) tradesByHash.set(hash, normalized);
  }
}

const failures = [];
let decoded = 0, makerLegs = 0, matchedPublicTrades = 0, mappedLegs = 0;
let outcomeAgreement = 0, volumeAgreement = 0;
let minVolumeRatio = Infinity, maxVolumeRatio = -Infinity;
for (const file of files) {
  const hash = file.slice(0, -8), transaction = readGzip(path.join(exactDir, file));
  if (transaction.status !== "decoded") { failures.push({ hash, reason: `cache-status:${transaction.status}` }); continue; }
  decoded++;
  makerLegs += transaction.makerLegs?.length || 0;
  const trade = tradesByHash.get(hash);
  if (!trade) { failures.push({ hash, reason: "missing-public-trade" }); continue; }
  matchedPublicTrades++;
  const flows = (transaction.makerLegs || []).map((leg) => economicBuyFlow(leg, {
    upToken: trade.market.upToken, downToken: trade.market.downToken,
  })).filter(Boolean);
  mappedLegs += flows.length;
  if (!flows.length) { failures.push({ hash, slug: trade.slug, reason: "no-mapped-maker-legs" }); continue; }
  const outcomesAgree = flows.every((flow) => flow.outcome === trade.outcome);
  if (outcomesAgree) outcomeAgreement++;
  else failures.push({ hash, slug: trade.slug, reason: "economic-outcome-disagreement" });
  const shares = flows.filter((flow) => flow.outcome === trade.outcome).reduce((sum, flow) => sum + flow.size, 0);
  const ratio = shares / trade.size;
  minVolumeRatio = Math.min(minVolumeRatio, ratio);
  maxVolumeRatio = Math.max(maxVolumeRatio, ratio);
  if (Math.abs(ratio - 1) <= 2e-6) volumeAgreement++;
  else failures.push({ hash, slug: trade.slug, reason: "maker-volume-disagreement", publicShares: trade.size,
    decodedMakerShares: shares, ratio });
}
const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  manifest: manifestFile,
  exactDir,
  tradeDirs,
  cachedTransactions: files.length,
  decodedTransactions: decoded,
  makerLegs,
  matchedPublicTrades,
  mappedLegs,
  outcomeAgreement,
  volumeAgreement,
  minVolumeRatio: Number.isFinite(minVolumeRatio) ? minVolumeRatio : null,
  maxVolumeRatio: Number.isFinite(maxVolumeRatio) ? maxVolumeRatio : null,
  conflictingPublicRows,
  failures,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, failures: failures.slice(0, 20) }, null, 2));
assert.equal(decoded, files.length, "not every cached transaction decoded");
assert.equal(matchedPublicTrades, files.length, "not every decoded transaction joins to one public market trade");
assert.equal(outcomeAgreement, files.length, "decoded maker economic outcomes disagree with public trades");
assert.equal(volumeAgreement, files.length, "decoded maker volumes disagree with public trades");
assert.equal(conflictingPublicRows, 0, "conflicting public rows share a transaction hash");
assert.equal(failures.length, 0, "strict maker-flow validation failed");
