#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "../../src/config/config.js";
import { fillFee, isFeeFill } from "../../engine/fees.js";
import { labelTradeRoles, normalizeTrade, tradeFingerprint, WALLET_3048 } from "./core.mjs";
import { decodeTargetOrders } from "./signed-orders.mjs";
import {
  buildInventoryLedger,
  decodeTargetReceiptFills,
  matchInventoryCheckpoint,
  signalAt,
  summarizeLedger,
} from "./inventory-ledger-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const liveDir = path.resolve(process.argv[2] || path.join(root, "data/live-ticks"));
const outDir = path.resolve(process.argv[3] || path.join(root, "data/research/wallet3048-inventory-ledger"));
const maxWindows = Math.max(2, Number(process.argv[4] || 6));
const endWindow = Number(process.argv[5] || Infinity);
const rpcUrl = process.env.ONCHAIN_RPC || config.onchainRpc;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 6) => Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

fs.mkdirSync(outDir, { recursive: true });
const checkpointFile = path.join(import.meta.dirname, "inventory-checkpoints.json");
const checkpointSource = fs.existsSync(checkpointFile)
  ? JSON.parse(fs.readFileSync(checkpointFile, "utf8")) : { checkpoints: [] };

const captures = fs.readdirSync(liveDir)
  .filter((name) => /^btc-updown-5m-\d+\.json$/.test(name))
  .map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(liveDir, name), "utf8")); }
    catch { return null; }
  })
  .filter((row) => row?.slug && row?.ws && row?.winSide && Array.isArray(row.ticks) && row.ticks.length > 10)
  .filter((row) => Number(row.ws) <= endWindow)
  .sort((a, b) => Number(a.ws) - Number(b.ws))
  .slice(-maxWindows);
if (captures.length < 2) throw new Error(`need at least two complete captures in ${liveDir}`);

const cohorts = [];
for (const capture of captures) {
  const ws = Number(capture.ws);
  const current = cohorts.at(-1);
  if (!current || ws !== current.end + 300) cohorts.push({ start: ws, end: ws, windows: 1 });
  else { current.end = ws; current.windows++; }
}
const captureDescription = cohorts.length === 1
  ? `${captures.length} locally captured consecutive windows`
  : `${captures.length} locally captured windows across ${cohorts.length} consecutive cohorts`;

const slugSet = new Set(captures.map((row) => row.slug));
const captureBySlug = new Map(captures.map((row) => [row.slug, row]));
const earliest = Math.min(...captures.map((row) => Number(row.ws))) - 120;
const latest = Math.max(...captures.map((row) => Number(row.ws))) + 420;
console.log(JSON.stringify({ phase: "captures", windows: captures.length, earliest, latest }));

async function jsonFetch(url, options = {}, attempt = 0) {
  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (attempt >= 6) throw error;
    await sleep(400 * 2 ** attempt);
    return jsonFetch(url, options, attempt + 1);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    await sleep(400 * 2 ** attempt);
    return jsonFetch(url, options, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function fetchTradePages(takerOnly) {
  const rows = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const url = new URL("https://data-api.polymarket.com/trades");
    for (const [key, value] of Object.entries({ user: WALLET_3048, takerOnly: String(takerOnly), limit: 1000, offset })) {
      url.searchParams.set(key, String(value));
    }
    const page = await jsonFetch(url, { headers: { Accept: "application/json" } });
    if (!Array.isArray(page)) throw new Error("unexpected Polymarket trade response");
    rows.push(...page);
    const oldest = Math.min(...page.map((row) => Number(row.timestamp)).filter(Number.isFinite));
    if (page.length < 1000 || (Number.isFinite(oldest) && oldest < earliest)) break;
  }
  return rows.filter((row) => slugSet.has(String(row.slug || "")) && Number(row.timestamp) >= earliest && Number(row.timestamp) <= latest);
}

const [allRaw, takerRaw] = await Promise.all([fetchTradePages(false), fetchTradePages(true)]);
const dedupe = (rows) => {
  const seen = new Map(), out = [];
  for (const row of rows) {
    const key = tradeFingerprint(row);
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    out.push({ ...row, _occurrence: occurrence });
  }
  return out;
};
const all = dedupe(allRaw);
const taker = dedupe(takerRaw);
const trades = labelTradeRoles(all, taker).map(normalizeTrade)
  .filter((row) => row.action === "BUY" && row.size > 0 && row.price > 0);
console.log(JSON.stringify({ phase: "public-trades", all: all.length, taker: taker.length, windows: new Set(trades.map((row) => row.slug)).size }));

const publicByTxToken = new Map();
for (const row of trades) {
  const key = `${row.transactionHash}:${row.asset}`;
  let value = publicByTxToken.get(key);
  if (!value) {
    value = { slug: row.slug, outcome: row.outcome, timestamp: row.timestamp, lastTimestamp: row.timestamp, shares: 0, notional: 0, roles: [] };
    publicByTxToken.set(key, value);
  }
  value.timestamp = Math.min(value.timestamp, row.timestamp);
  value.lastTimestamp = Math.max(value.lastTimestamp, row.timestamp);
  value.shares += row.size;
  value.notional += row.size * row.price;
  if (!value.roles.includes(row.role)) value.roles.push(row.role);
}

const txHashes = [...new Set(trades.map((row) => row.transactionHash))];
const cacheFile = path.join(outDir, "decoded-receipts.ndjson");
const decoded = new Map();
if (fs.existsSync(cacheFile)) {
  for (const line of fs.readFileSync(cacheFile, "utf8").split("\n")) {
    if (!line) continue;
    try { const row = JSON.parse(line); if (row.txHash) decoded.set(row.txHash, row); } catch {}
  }
}

async function rpcBatch(hashes, attempt = 0) {
  const body = [];
  for (let index = 0; index < hashes.length; index++) {
    body.push({ jsonrpc: "2.0", id: index * 2 + 1, method: "eth_getTransactionByHash", params: [hashes[index]] });
    body.push({ jsonrpc: "2.0", id: index * 2 + 2, method: "eth_getTransactionReceipt", params: [hashes[index]] });
  }
  try {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json)) throw new Error("RPC did not return a batch array");
    const byId = new Map(json.map((row) => [row.id, row]));
    return hashes.map((txHash, index) => {
      const tx = byId.get(index * 2 + 1)?.result || null;
      const receipt = byId.get(index * 2 + 2)?.result || null;
      return {
        txHash,
        orders: decodeTargetOrders(tx, WALLET_3048),
        fills: decodeTargetReceiptFills(receipt, WALLET_3048),
      };
    });
  } catch (error) {
    if (attempt >= 6) throw error;
    await sleep(400 * 2 ** attempt);
    return rpcBatch(hashes, attempt + 1);
  }
}

const pending = txHashes.filter((hash) => !decoded.has(hash));
for (let index = 0; index < pending.length; index += 30) {
  const rows = await rpcBatch(pending.slice(index, index + 30));
  for (const row of rows) {
    decoded.set(row.txHash, row);
    fs.appendFileSync(cacheFile, `${JSON.stringify(row)}\n`);
  }
  if (index % 300 === 0 || index + 30 >= pending.length) {
    console.log(JSON.stringify({ phase: "rpc-decode", done: Math.min(index + 30, pending.length), pending: pending.length, cached: txHashes.length - pending.length }));
  }
}

const parentByHash = new Map();
const targetEvents = [];
for (const txHash of txHashes) {
  const row = decoded.get(txHash);
  if (!row) continue;
  const orders = new Map((row.orders || []).map((order) => [String(order.orderHash).toLowerCase(), order]));
  for (const fill of row.fills || []) {
    if (!fill.isBuy || !(fill.shares > 0)) continue;
    const order = orders.get(String(fill.orderHash).toLowerCase());
    const publicRow = publicByTxToken.get(`${txHash}:${fill.tokenId}`);
    if (!order || !publicRow || !slugSet.has(publicRow.slug)) continue;
    const capture = captureBySlug.get(publicRow.slug);
    const signedAtS = (Number(order.signedTimestampMs) / 1000) - Number(capture.ws);
    const event = {
      slug: publicRow.slug,
      orderHash: fill.orderHash,
      transactionHash: txHash,
      role: order.settlementRole,
      outcome: publicRow.outcome,
      executionTimestamp: publicRow.timestamp,
      executionLastTimestamp: publicRow.lastTimestamp,
      tInto: publicRow.timestamp - Number(capture.ws),
      shares: fill.shares,
      notional: fill.notional,
      fee: fill.fee,
      allInCost: fill.allInCost,
      parentSignedShares: order.signedShares,
      parentSignedBudgetUsd: order.signedBudgetUsd,
      parentLimitPrice: order.limitPrice,
      signedTimestampMs: order.signedTimestampMs,
      signedAtS,
      requestTimeKnown: false,
      requestTimingNote: "signed timestamp is order construction time; exact off-chain fire/request time is not public",
      executionSignal: signalAt(capture, publicRow.timestamp - Number(capture.ws)),
      constructionSignal: signalAt(capture, signedAtS),
    };
    targetEvents.push(event);
    if (!parentByHash.has(fill.orderHash)) parentByHash.set(fill.orderHash, {
      orderHash: fill.orderHash,
      slug: publicRow.slug,
      outcome: publicRow.outcome,
      signedShares: order.signedShares,
      signedBudgetUsd: order.signedBudgetUsd,
      limitPrice: order.limitPrice,
      signedTimestampMs: order.signedTimestampMs,
      roles: new Set(),
      executions: 0,
      filledShares: 0,
      notional: 0,
      fees: 0,
    });
    const parent = parentByHash.get(fill.orderHash);
    parent.roles.add(order.settlementRole);
    parent.executions++;
    parent.filledShares += fill.shares;
    parent.notional += fill.notional;
    parent.fees += fill.fee;
  }
}

const parentOrders = [...parentByHash.values()].map((row) => ({
  ...row,
  roles: [...row.roles].sort(),
  vwap: row.filledShares ? row.notional / row.filledShares : null,
  allInAverage: row.filledShares ? (row.notional + row.fees) / row.filledShares : null,
  fillFraction: row.signedShares ? row.filledShares / row.signedShares : null,
})).sort((a, b) => a.signedTimestampMs - b.signedTimestampMs || a.orderHash.localeCompare(b.orderHash));

const windows = [];
const ledgers = {};
for (const capture of captures) {
  const events = targetEvents.filter((row) => row.slug === capture.slug);
  const ledger = buildInventoryLedger(events, capture.winSide);
  for (const row of ledger.rows) {
    const parent = parentByHash.get(row.orderHash);
    row.parentFilledShares = round(parent?.filledShares);
    row.parentExecutionCount = parent?.executions ?? null;
  }
  ledgers[capture.slug] = ledger.rows;
  const summary = summarizeLedger(capture.slug, ledger, { winner: capture.winSide });
  const publicRows = trades.filter((row) => row.slug === capture.slug);
  const publicShares = publicRows.reduce((sum, row) => sum + row.size, 0);
  const decodedShares = events.reduce((sum, row) => sum + row.shares, 0);

  let shadow = null;
  if (Array.isArray(capture.shadowFills)) {
    const shadowEvents = capture.shadowFills.filter((fill) => fill?.leg !== "merge" && fill?.shares > 0).map((fill, index) => {
      const px = Number(fill.effPx ?? (fill.shares ? fill.usdc / fill.shares : null));
      const fee = fillFee(px, Number(fill.shares), isFeeFill(fill));
      const tInto = Number(fill.fillTInto ?? fill.tInto ?? 0);
      return {
        slug: capture.slug,
        orderHash: `shadow:${fill.oid ?? index}`,
        transactionHash: `shadow:${index}`,
        role: fill.maker ? "maker" : "taker",
        outcome: fill.side,
        executionTimestamp: Number(capture.ws) + tInto,
        tInto,
        shares: Number(fill.shares),
        notional: Number(fill.usdc),
        fee,
        allInCost: Number(fill.usdc) + fee,
        parentSignedShares: Number(fill.requestedShares ?? fill.shares),
        parentLimitPrice: Number(fill.limitPx ?? px),
        reason: fill.reason ?? null,
        executionSignal: signalAt(capture, tInto),
      };
    });
    const shadowLedger = buildInventoryLedger(shadowEvents, capture.winSide);
    shadow = summarizeLedger(capture.slug, shadowLedger, { winner: capture.winSide });
  }
  windows.push({
    ...summary,
    publicTradeRows: publicRows.length,
    publicShares: round(publicShares),
    decodedReceiptShares: round(decodedShares),
    decodedShareCoveragePct: publicShares ? round(decodedShares / publicShares * 100, 3) : null,
    shadow,
  });
}

const aggregate = {
  windows: windows.length,
  windowsWithTargetExecutions: windows.filter((row) => row.executions > 0).length,
  executions: windows.reduce((sum, row) => sum + row.executions, 0),
  uniqueParentOrders: parentOrders.length,
  makerExecutions: windows.reduce((sum, row) => sum + row.makerExecutions, 0),
  takerExecutions: windows.reduce((sum, row) => sum + row.takerExecutions, 0),
  totalShares: round(windows.reduce((sum, row) => sum + row.final.upShares + row.final.downShares, 0)),
  totalAllInCost: round(windows.reduce((sum, row) => sum + row.final.totalCost, 0)),
  actualPnl: round(windows.reduce((sum, row) => sum + Number(row.final.actualPnl || 0), 0)),
  profitableWindows: windows.filter((row) => Number(row.final.actualPnl) > 0).length,
  bothOutcomePositiveWindows: windows.filter((row) => row.final.ifUp > 0 && row.final.ifDown > 0).length,
  grossPairBelowOneWindows: windows.filter((row) => row.final.grossAveragePairCost < 1).length,
  allInPairBelowOneWindows: windows.filter((row) => row.final.allInAveragePairCost < 1).length,
  shadowLedgersAvailable: windows.filter((row) => row.shadow).length,
};
aggregate.roiPct = aggregate.totalAllInCost ? round(aggregate.actualPnl / aggregate.totalAllInCost * 100, 4) : null;

const checkpointMatches = (checkpointSource.checkpoints || []).filter((checkpoint) => ledgers[checkpoint.slug]).map((checkpoint) => {
  const targetMatch = matchInventoryCheckpoint(ledgers[checkpoint.slug], { displayTInto: checkpoint.displayTInto, ...checkpoint.target });
  const winner = captureBySlug.get(checkpoint.slug)?.winSide ?? null;
  const targetActual = winner === "Up" ? targetMatch?.state?.ifUp : winner === "Down" ? targetMatch?.state?.ifDown : null;
  const shadow = checkpoint.shadow || null;
  const shadowActual = winner === "Up" ? Number(shadow?.ifUp) : winner === "Down" ? Number(shadow?.ifDown) : null;
  const shadowAllInCostFromUp = shadow ? Number(shadow.upShares) - Number(shadow.ifUp) : null;
  const shadowAllInCostFromDown = shadow ? Number(shadow.downShares) - Number(shadow.ifDown) : null;
  const shadowAllInCost = Number.isFinite(shadowAllInCostFromUp) && Number.isFinite(shadowAllInCostFromDown)
    ? (shadowAllInCostFromUp + shadowAllInCostFromDown) / 2 : null;
  return {
    slug: checkpoint.slug,
    winner,
    target: targetMatch,
    shadow,
    comparison: {
      targetActualPnl: round(targetActual),
      shadowActualPnl: round(shadowActual),
      actualPnlAdvantageTarget: round(Number(targetActual) - Number(shadowActual)),
      targetAllInCost: targetMatch?.state?.totalCost ?? null,
      shadowAllInCostInferredFromPayoutCards: round(shadowAllInCost),
      targetGrossPairAverage: targetMatch?.state?.grossAveragePairCost ?? null,
      shadowGrossPairAverage: shadow ? round(Number(shadow.averageUp) + Number(shadow.averageDown)) : null,
    },
  };
});

const allLedgerRows = Object.values(ledgers).flat();
const inventoryRelation = (row) => {
  if (Math.abs(Number(row.before?.lean || 0)) < 1e-8) return "seed";
  const leanSide = Number(row.before.lean) > 0 ? "Up" : "Down";
  return row.outcome === leanSide ? "expand" : "repair";
};
const signalClass = (row) => {
  const signal = row.executionSignal;
  if (!signal) return { binanceAligned: false, clobAligned: false, strictLagCandidate: false };
  const direction = row.outcome === "Up" ? 1 : -1;
  const binanceDirectionalMove = Number(signal.binanceMove || 0) * direction;
  const clobDirectionalMove = Number(row.outcome === "Up" ? signal.upMidMove : signal.downMidMove) * direction;
  const threshold = Number(signal.binance || 0) * .000075;
  return {
    binanceAligned: binanceDirectionalMove > 0,
    clobAligned: clobDirectionalMove > 0,
    strictLagCandidate: binanceDirectionalMove >= threshold && clobDirectionalMove <= 0,
  };
};
const executionStats = Object.fromEntries(["maker", "taker"].map((role) => {
  const rows = allLedgerRows.filter((row) => row.role === role);
  return [role, {
    executions: rows.length,
    shares: round(rows.reduce((sum, row) => sum + row.shares, 0)),
    repairExecutions: rows.filter((row) => inventoryRelation(row) === "repair").length,
    expansionExecutions: rows.filter((row) => inventoryRelation(row) === "expand").length,
    floorImprovingExecutions: rows.filter((row) => row.delta.worstCaseProfit > 0).length,
    binanceAlignedAtExecution: rows.filter((row) => signalClass(row).binanceAligned).length,
    clobAlignedAtExecution: rows.filter((row) => signalClass(row).clobAligned).length,
    strictLagCandidatesAtExecution: rows.filter((row) => signalClass(row).strictLagCandidate).length,
  }];
}));

const parentRows = new Map();
for (const row of allLedgerRows) {
  if (!parentRows.has(row.orderHash)) parentRows.set(row.orderHash, []);
  parentRows.get(row.orderHash).push(row);
}
const quantile = (values, p) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};
const parentSizeStats = Object.fromEntries([50, 150].map((size) => {
  const groups = [...parentRows.values()].filter((rows) => Math.abs(Number(rows[0]?.parentSignedShares) - size) < .01);
  const filled = groups.map((rows) => rows.reduce((sum, row) => sum + row.shares, 0));
  const constructionToFill = groups.map((rows) => Number(rows[0].tInto) - Number(rows[0].signedAtS));
  return [String(size), {
    parents: groups.length,
    filledShares: round(filled.reduce((sum, value) => sum + value, 0)),
    firstFillRepairsInventory: groups.filter((rows) => inventoryRelation(rows[0]) === "repair").length,
    firstFillExpandsInventory: groups.filter((rows) => inventoryRelation(rows[0]) === "expand").length,
    firstFillImprovesFloor: groups.filter((rows) => rows[0].delta.worstCaseProfit > 0).length,
    medianFilledShares: round(quantile(filled, .5)),
    p90FilledShares: round(quantile(filled, .9)),
    medianConstructionToFirstFillSeconds: round(quantile(constructionToFill, .5), 3),
    p90ConstructionToFirstFillSeconds: round(quantile(constructionToFill, .9), 3),
  }];
}));
const strategyDiagnostics = {
  executionStats,
  parentSizeStats,
  totalInventoryCrossings: windows.reduce((sum, row) => sum + row.inventoryCrossings, 0),
  note: "Execution-time signal counts are descriptive for makers, not causal request-signal labels. Construction-to-fill delay is not order lifetime.",
};

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  wallet: WALLET_3048,
  method: "Exact receipt OrderFilled deltas grouped by decoded signed parent order; state is recomputed after every execution. Signed time is construction evidence only, never represented as maker request time.",
  limitations: [
    "Polygon/public execution timestamps are whole-second anchors; ordering among multiple executions in the same second is not identifiable.",
    "Historical BBA captures do not retain queue depth, so maker request/fire time cannot be inferred exactly.",
    "Shadow comparison is exact only for new capture schema files that persist shadowFills.",
  ],
  captureSelection: { description: captureDescription, cohorts },
  aggregate,
  checkpointMatches,
  strategyDiagnostics,
  windows,
  parentOrders,
  ledgers,
};

fs.writeFileSync(path.join(outDir, "inventory-ledger.json.gz"), zlib.gzipSync(JSON.stringify(report), { level: 9 }));
fs.writeFileSync(path.join(outDir, "inventory-ledger-summary.json"), `${JSON.stringify({ ...report, ledgers: undefined }, null, 2)}\n`);

const csvColumns = [
  "slug", "sequence", "tInto", "executionTimestamp", "sequenceAmbiguous", "role", "outcome", "orderHash",
  "parentSignedShares", "parentLimitPrice", "shares", "vwap", "fee", "allInCost",
  "beforeUp", "beforeDown", "beforeLean", "afterUp", "afterDown", "afterLean",
  "averageUp", "averageDown", "ifUp", "ifDown", "worstCaseProfit",
  "deltaIfUp", "deltaIfDown", "deltaWorstCase", "reverseShares", "reversePrice",
  "bzGap", "bzMove2_5", "upMid", "upMidMove2_5", "downMid", "downMidMove2_5",
];
const csvRows = [csvColumns.map(csv).join(",")];
for (const slug of captures.map((row) => row.slug)) {
  for (const row of ledgers[slug] || []) {
    const signal = row.executionSignal || {};
    const values = {
      slug, sequence: row.sequence, tInto: row.tInto, executionTimestamp: row.executionTimestamp,
      sequenceAmbiguous: row.sequenceAmbiguous, role: row.role, outcome: row.outcome, orderHash: row.orderHash,
      parentSignedShares: row.parentSignedShares, parentLimitPrice: row.parentLimitPrice,
      shares: row.shares, vwap: row.vwap, fee: row.fee, allInCost: row.allInCost,
      beforeUp: row.before.upShares, beforeDown: row.before.downShares, beforeLean: row.before.lean,
      afterUp: row.after.upShares, afterDown: row.after.downShares, afterLean: row.after.lean,
      averageUp: row.after.averageUp, averageDown: row.after.averageDown,
      ifUp: row.after.ifUp, ifDown: row.after.ifDown, worstCaseProfit: row.after.worstCaseProfit,
      deltaIfUp: row.delta.ifUp, deltaIfDown: row.delta.ifDown, deltaWorstCase: row.delta.worstCaseProfit,
      reverseShares: row.reverseCalculation.shares, reversePrice: row.reverseCalculation.price,
      bzGap: signal.binanceGap, bzMove2_5: signal.binanceMove, upMid: signal.upMid,
      upMidMove2_5: signal.upMidMove, downMid: signal.downMid, downMidMove2_5: signal.downMidMove,
    };
    csvRows.push(csvColumns.map((column) => csv(values[column])).join(","));
  }
}
fs.writeFileSync(path.join(outDir, "parent-executions.csv"), `${csvRows.join("\n")}\n`);

const lines = [
  "# Wallet 3048 inventory-consumption ledger",
  "",
  `Exact on-chain receipt reconstruction over ${captureDescription}.`,
  "",
  `- Parent orders: ${aggregate.uniqueParentOrders}; execution events: ${aggregate.executions} (${aggregate.makerExecutions} maker, ${aggregate.takerExecutions} taker).`,
  `- All-in capital: $${aggregate.totalAllInCost}; actual PnL: $${aggregate.actualPnl}; ROI: ${aggregate.roiPct}%.`,
  `- Positive windows: ${aggregate.profitableWindows}/${aggregate.windows}; positive under both outcomes: ${aggregate.bothOutcomePositiveWindows}/${aggregate.windows}.`,
  `- Gross pair average below $1: ${aggregate.grossPairBelowOneWindows}/${aggregate.windows}; all-in pair average below $1: ${aggregate.allInPairBelowOneWindows}/${aggregate.windows}.`,
  "",
  "## Screenshot checkpoints matched by inventory vector",
  "",
  "| Window | Display t | Ledger t | UI lag | Winner | Target actual | Shadow actual | Advantage target | Target pair | Shadow pair |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...checkpointMatches.map((row) => `| ${row.slug.split("-").at(-1)} | ${row.target.displayTInto.toFixed(1)} | ${Number(row.target.executionTInto).toFixed(1)} | ${Number(row.target.displayLagSeconds).toFixed(1)}s | ${row.winner} | $${row.comparison.targetActualPnl.toFixed(2)} | $${row.comparison.shadowActualPnl.toFixed(2)} | $${row.comparison.actualPnlAdvantageTarget.toFixed(2)} | ${row.comparison.targetGrossPairAverage.toFixed(3)} | ${row.comparison.shadowGrossPairAverage.toFixed(3)} |`),
  "",
  "## Cross-window strategy diagnostics",
  "",
  `- Inventory lean crossed sides ${strategyDiagnostics.totalInventoryCrossings} times. Maker executions repaired the lean ${executionStats.maker.repairExecutions}/${executionStats.maker.executions} times; takers repaired it ${executionStats.taker.repairExecutions}/${executionStats.taker.executions} times.`,
  `- Only ${executionStats.maker.strictLagCandidatesAtExecution + executionStats.taker.strictLagCandidatesAtExecution}/${aggregate.executions} execution contexts satisfy the strict 2.5-second Binance-first/CLOB-not-yet-aligned definition. For makers this is not a request-time causal test.`,
  `- 50-share parents: ${parentSizeStats["50"].parents}, median fill ${parentSizeStats["50"].medianFilledShares}; 150-share parents: ${parentSizeStats["150"].parents}, median fill ${parentSizeStats["150"].medianFilledShares}.`,
  `- A 150-share parent's first fill repairs inventory ${parentSizeStats["150"].firstFillRepairsInventory}/${parentSizeStats["150"].parents} times and expands it ${parentSizeStats["150"].firstFillExpandsInventory}/${parentSizeStats["150"].parents} times. Large size is therefore not an emergency-only label.`,
  `- Median construction-to-first-fill delay is ${parentSizeStats["50"].medianConstructionToFirstFillSeconds}s for 50-share parents and ${parentSizeStats["150"].medianConstructionToFirstFillSeconds}s for 150-share parents. This proves staged order menus, but not continuous CLOB resting time.`,
  "",
  "| Window | Winner | Parents | Execs M/T | UP | DOWN | Lean | Avg U/D | Cost | IF UP | IF DOWN | Actual | Min floor |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...windows.map((row) => `| ${row.slug.split("-").at(-1)} | ${row.winner} | ${row.parentOrders} | ${row.makerExecutions}/${row.takerExecutions} | ${row.final.upShares.toFixed(1)} | ${row.final.downShares.toFixed(1)} | ${row.final.lean.toFixed(1)} | ${(row.final.averageUp ?? 0).toFixed(3)}/${(row.final.averageDown ?? 0).toFixed(3)} | $${row.final.totalCost.toFixed(2)} | $${row.final.ifUp.toFixed(2)} | $${row.final.ifDown.toFixed(2)} | $${row.final.actualPnl.toFixed(2)} | $${row.minimumWorstCaseProfit.toFixed(2)} |`),
  "",
  "Maker warning: signedTimestampMs is an order-construction field. For makers, the exact request/fire time remains unknown unless an L2 depth jump identifies placement. The execution ledger therefore aligns signals at execution and reports construction context separately.",
  "",
  `Exact shadow ledgers are available in ${aggregate.shadowLedgersAvailable}/${aggregate.windows} archived windows. New archives persist them; older BBA-only captures cannot reproduce live L2 decisions exactly.`,
];
fs.writeFileSync(path.join(outDir, "inventory-ledger.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(JSON.stringify({ phase: "done", outDir, aggregate }, null, 2));
