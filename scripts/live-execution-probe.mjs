#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { config } from "../src/config/config.js";

function argsOf(argv) {
  const out = {};
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    out[key] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function topPrice(rows, side) {
  const prices = (rows || []).map((row) => Number(row?.price)).filter(Number.isFinite);
  if (!prices.length) return null;
  return side === "ask" ? Math.min(...prices) : Math.max(...prices);
}

function publicOrder(order) {
  if (!order) return null;
  return {
    id: String(order.id || order.orderID || order.orderId || ""),
    status: String(order.status || ""),
    originalSize: Number(order.original_size ?? order.originalSize ?? 0),
    sizeMatched: Number(order.size_matched ?? order.sizeMatched ?? 0),
    price: Number(order.price ?? 0),
    createdAt: order.created_at ?? order.createdAt ?? null,
  };
}

function fillsForOrder(trades, orderId) {
  const out = [];
  for (const trade of trades || []) {
    if (String(trade?.taker_order_id || "") === orderId) {
      out.push({
        tradeId: String(trade.id || ""), role: "taker", status: String(trade.status || ""),
        shares: Number(trade.size || 0), price: Number(trade.price || 0),
        matchTime: trade.match_time ?? trade.matchTime ?? null,
      });
    }
    for (const maker of trade?.maker_orders || []) {
      if (String(maker?.order_id || "") !== orderId) continue;
      out.push({
        tradeId: String(trade.id || ""), role: "maker", status: String(trade.status || ""),
        shares: Number(maker.matched_amount || 0), price: Number(maker.price || 0),
        matchTime: trade.match_time ?? trade.matchTime ?? null,
      });
    }
  }
  return out;
}

const flags = argsOf(process.argv.slice(2));
const mode = String(flags.mode || "fak").toLowerCase();
if (!["fak", "gtc", "gtc-cancel", "maker-cancel"].includes(mode)) {
  throw new Error("--mode must be fak, gtc, gtc-cancel, or maker-cancel");
}
const confirmed = flags["confirm-live"] === "YES";
const maxRiskUsd = Math.max(1, finite(flags["max-usd"], 2.5));
const cancelAfterMs = Math.max(100, finite(flags["cancel-after-ms"], 500));
const settlementMs = Math.max(0, finite(flags["settlement-ms"], 12_000));

config.simulationOnly = false;
config.executionMode = "live";
config.liveMaxOrderUsd = maxRiskUsd;
config.liveMinOrderUsd = 1;

const live = await import("../src/lib/executor.js");
const nowSec = Math.floor(Date.now() / 1000);
const windowStart = Math.floor(nowSec / 300) * 300;
const slug = `btc-updown-5m-${windowStart}`;
const markets = await fetch(`${config.gammaHost}/markets?slug=${slug}`).then((response) => response.json());
const market = Array.isArray(markets) ? markets[0] : null;
if (!market || market.closed || market.acceptingOrders === false) throw new Error(`BTC market is not accepting orders: ${slug}`);
if (nowSec - windowStart > 250) throw new Error(`refusing to probe during the final 50 seconds of ${slug}`);
const tokenIds = JSON.parse(market.clobTokenIds);
const outcomes = JSON.parse(market.outcomes);

await live.getDep();
await live.prewarm(tokenIds, market.conditionId);
const { client } = await live.getDep();
const openOrders = await client.getOpenOrders(undefined, true);
if (Array.isArray(openOrders) && openOrders.length) {
  throw new Error(`refusing live probe while ${openOrders.length} unrelated order(s) are open`);
}
const books = await Promise.all(tokenIds.map((tokenId) => client.getOrderBook(tokenId)));
const choices = books.map((book, index) => ({
  tokenId: String(tokenIds[index]),
  outcome: String(outcomes[index]),
  bestAsk: topPrice(book?.asks, "ask"),
  bestBid: topPrice(book?.bids, "bid"),
  tickSize: Number(book?.tick_size),
  minOrderSize: Number(book?.min_order_size),
})).filter((row) => row.bestAsk > 0 && row.bestAsk < 1 && row.bestBid > 0 && row.bestBid < 1);
choices.sort((a, b) => a.bestAsk - b.bestAsk);
const selected = choices[0];
if (!selected) throw new Error("no executable BTC outcome book");

const isMakerCancel = mode === "maker-cancel";
const isRestCancel = isMakerCancel || mode === "gtc-cancel";
const price = isRestCancel
  ? Math.max(selected.tickSize, +(selected.bestBid - selected.tickSize).toFixed(6))
  : selected.bestAsk;
const minSharesForDollar = Math.ceil((1 / price) * 100) / 100;
const shares = Math.max(selected.minOrderSize, minSharesForDollar);
const amountUsd = Math.max(1, +(selected.minOrderSize * price).toFixed(6));
const boundedUsd = mode === "fak" ? amountUsd : shares * price;
if (boundedUsd > maxRiskUsd + 1e-9) {
  throw new Error(`minimum valid ${mode} probe is $${boundedUsd.toFixed(4)}, above --max-usd=$${maxRiskUsd.toFixed(2)}`);
}

const journalDir = path.resolve(".state/execution-probes");
fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
const journalPath = path.join(journalDir, `${mode}-${Date.now()}.json`);
const journal = {
  schema: "wallet3048-live-execution-probe-v1",
  phase: "preflight",
  createdAtMs: Date.now(),
  mode,
  maxRiskUsd,
  slug,
  conditionId: String(market.conditionId || ""),
  tokenId: selected.tokenId,
  outcome: selected.outcome,
  book: selected,
  request: { price, shares, amountUsd: mode === "fak" ? amountUsd : null, postOnly: isMakerCancel },
  attempts: [],
};
function persist() {
  const temporary = `${journalPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const fd = fs.openSync(temporary, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(temporary, journalPath);
}
persist();

if (!confirmed) {
  console.log(JSON.stringify({ dryRun: true, journal: journalPath, ...journal }, null, 2));
  console.log("Re-run with --confirm-live=YES to submit the spend-capped probe.");
  process.exit(0);
}

try {
  const started = performance.now();
  const response = await live.placeBuy({
    tokenId: selected.tokenId,
    price,
    sizeShares: shares,
    amountUsd: mode === "fak" ? amountUsd : undefined,
    fillPx: selected.bestAsk,
    orderType: mode === "fak" ? "FAK" : "GTC",
    postOnly: isMakerCancel,
    cancelRemainderAfterMs: mode === "gtc" || mode === "gtc-cancel" ? 0 : undefined,
    label: `execution-probe-${mode}`,
    onOrderPrepared: async (prepared) => {
      journal.phase = "signed-before-post";
      journal.attempts.push({ ...prepared, preparedAtMs: Date.now() });
      persist();
    },
  });
  journal.ack = response;
  journal.callMs = performance.now() - started;
  journal.phase = response?.error ? "rejected" : "acknowledged";
  journal.ackAtMs = Date.now();
  persist();
  if (response?.error) throw new Error(response.error);

  let order = null;
  let cancel = response.remainderCancel || null;
  if (response.orderId) {
    if (mode !== "fak") await new Promise((resolve) => setTimeout(resolve, cancelAfterMs));
    try { order = await client.getOrder(response.orderId); } catch {}
    const original = Number(order?.original_size ?? 0);
    const matched = Number(order?.size_matched ?? 0);
    if (mode !== "fak" && !cancel && order && matched + 1e-6 < original) {
      const cancelStarted = performance.now();
      cancel = await live.cancelOrder(response.orderId);
      cancel.cancelCallMs = performance.now() - cancelStarted;
    }
  }

  const settleDeadline = Date.now() + settlementMs;
  let fills = [];
  do {
    if (response.orderId) {
      try { order = await client.getOrder(response.orderId); } catch {}
      const trades = await client.getTrades({ market: String(market.conditionId) }, true).catch(() => []);
      fills = fillsForOrder(trades, response.orderId);
      if (fills.length && fills.every((fill) => ["CONFIRMED", "FAILED"].includes(fill.status.toUpperCase()))) break;
    }
    if (Date.now() >= settleDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (true);

  journal.phase = "reconciled";
  journal.cancel = cancel;
  journal.order = publicOrder(order);
  journal.fills = fills;
  journal.reconciledAtMs = Date.now();
  persist();
  console.log(JSON.stringify({
    journal: journalPath,
    mode,
    request: journal.request,
    ack: response,
    cancel,
    order: journal.order,
    fills,
  }, null, 2));
} catch (error) {
  journal.phase = "error-needs-reconciliation";
  journal.error = String(error?.message || error);
  journal.errorAtMs = Date.now();
  persist();
  console.error(JSON.stringify({ journal: journalPath, error: journal.error }, null, 2));
  process.exitCode = 1;
}
