#!/usr/bin/env node
// Upper bound: keep the target's exact inferred fill events, sides, signed caps,
// and budgets. Infer the decision 520 ms before each observed book fill, then
// vary only decision-to-fill latency. At 520 ms this should replay the target's
// observed book timing; shorter scenarios quantify execution-speed sensitivity.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const cohortFile = path.resolve(process.argv[2] || "data/wallet-75cc/cohort-2026-08-25-btc-eth-traded.json");
const feedDir = path.resolve(process.argv[3] || "data/wallet-75cc/feeds/v2-l2");
const firesFile = path.resolve(process.argv[4] || "data/wallet-75cc/order-fires-v2-l2-aug25.json.gz");
const signedFile = path.resolve(process.argv[5] || "data/wallet-75cc/signed-orders.json.gz");
const splitMs = Date.parse(process.argv[6] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[7] || "data/wallet-75cc/oracle-latency-replay.json");
const latencies = String(process.env.W75CC_ORACLE_LATENCIES || "0,130,520").split(",").map(Number).filter(Number.isFinite);
const offsets = String(process.env.W75CC_ORACLE_CAP_OFFSETS || "0,.01,.02").split(",").map(Number).filter(Number.isFinite);
const sourceDecisionLatencyMs = Number(process.env.W75CC_SOURCE_DECISION_LATENCY_MS || 520);
const marketPrefix = String(process.env.W75CC_MARKET_PREFIX || "").trim().toLowerCase();
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const fires = readGzip(firesFile).rows.filter((row) => row.confidence !== "low");
const signed = readGzip(signedFile).groups;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1_000;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const markets = cohort.markets.filter((market) => market.winner && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .filter((market) => !marketPrefix || market.slug.toLowerCase().startsWith(marketPrefix));
const marketBySlug = new Map(markets.map((market) => [market.slug, market]));
const bySlug = new Map();
for (const fire of fires) {
  if (!marketBySlug.has(fire.slug) || !signedByHash.has(fire.orderHash)) continue;
  if (!bySlug.has(fire.slug)) bySlug.set(fire.slug, []);
  bySlug.get(fire.slug).push(fire);
}

function actionsFor(slug) {
  const ordered = [...(bySlug.get(slug) || [])].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const actions = [];
  let batch = [];
  const finish = () => {
    if (!batch.length) return;
    actions.push({ fireMs: Math.min(...batch.map((row) => row.fireMs)), side: batch[0].outcome,
      orders: batch.map((fire) => ({ fire, signed: signedByHash.get(fire.orderHash) }))
        .sort((a, b) => a.signed.signedTimestampMs - b.signed.signedTimestampMs) });
  };
  for (const fire of ordered) {
    if (batch.length && (fire.outcome !== batch[0].outcome || fire.fireMs - batch.at(-1).fireMs > 300)) { finish(); batch = []; }
    batch.push(fire);
  }
  finish();
  return actions;
}
function atOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1; }
  return answer;
}
function levels(tick, side) {
  return ((side === "Up" ? tick?.up : tick?.down)?.asks || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => row.price > 0 && row.price < 1 && row.size > 0).sort((a, b) => a.price - b.price);
}
function executeBudget(book, budget, cap) {
  let remaining = budget, shares = 0, cost = 0, fees = 0;
  for (const level of book) {
    if (level.price > cap + .00011 || remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining / level.price), usd = take * level.price;
    level.size -= take; remaining -= usd; shares += take; cost += usd;
    fees += Math.round(.07 * level.price * (1 - level.price) * take * 1e5) / 1e5;
  }
  return { shares, cost, fees, fraction: budget > 0 ? cost / budget : 0 };
}
function blank() { return { windows: 0, activeWindows: 0, attempts: 0, fills: 0, correctOrders: 0, requestedBudget: 0, shares: 0, winningShares: 0, cost: 0, fees: 0, payout: 0, fillFractionSum: 0 }; }
function add(total, row) { for (const key of Object.keys(total)) total[key] += Number(row[key] || 0); }
function metrics(raw) {
  const net = raw.payout - raw.cost - raw.fees;
  return {
    ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value)])), net: round(net),
    roiPct: raw.cost + raw.fees > 0 ? round(net / (raw.cost + raw.fees) * 100) : null,
    fillRatePct: raw.attempts ? round(raw.fills / raw.attempts * 100) : null,
    averageFillFraction: raw.fills ? round(raw.fillFractionSum / raw.fills) : null,
    actionAccuracyPct: raw.fills ? round(raw.correctOrders / raw.fills * 100) : null,
    shareWeightedAccuracyPct: raw.shares ? round(raw.winningShares / raw.shares * 100) : null,
  };
}
function replayScenarios() {
  const scenarios = latencies.flatMap((latencyMs) => offsets.map((capOffset) => ({
    latencyMs, capOffset, totals: { train: blank(), holdout: blank(), all: blank() },
  })));
  for (const market of markets) {
    const feed = readGzip(path.join(feedDir, `${market.slug}.json.gz`)), ticks = feed.ticks || [];
    const actions = actionsFor(market.slug);
    for (const scenario of scenarios) {
      const row = blank(); row.windows = 1;
      let up = 0, down = 0;
      for (const action of actions) {
        const decisionMs = action.fireMs - sourceDecisionLatencyMs;
        // fireMs is the post-consumption snapshot. A historical replay must
        // use the last book strictly before arrival, or it sees our own fill.
        const index = atOrBefore(ticks, decisionMs + scenario.latencyMs - 1);
        if (index < 0) continue;
        const actionBook = levels(ticks[index], action.side);
        for (const order of action.orders) {
          row.attempts++;
          const cap = Math.min(.99, round(Number(order.signed.limitPrice) + scenario.capOffset, 2));
          const budget = cap * Number(order.signed.signedShares), fill = executeBudget(actionBook, budget, cap);
          row.requestedBudget += budget;
          if (!(fill.shares > 0)) continue;
          row.fills++; row.shares += fill.shares; row.cost += fill.cost; row.fees += fill.fees; row.fillFractionSum += fill.fraction;
          if (market.winner === action.side) { row.correctOrders++; row.winningShares += fill.shares; }
          if (action.side === "Up") up += fill.shares; else down += fill.shares;
        }
      }
      row.activeWindows = Number(row.fills > 0); row.payout = market.winner === "Up" ? up : down;
      add(scenario.totals[startMs(market.slug) < splitMs ? "train" : "holdout"], row);
      add(scenario.totals.all, row);
    }
  }
  return scenarios.map(({ latencyMs, capOffset, totals }) => ({
    latencyMs, capOffset, train: metrics(totals.train), holdout: metrics(totals.holdout), all: metrics(totals.all),
  }));
}

function actual() {
  const totals = { train: blank(), holdout: blank(), all: blank() };
  for (const market of markets) {
    const row = blank(); row.windows = 1;
    let up = 0, down = 0;
    for (const fire of bySlug.get(market.slug) || []) {
      const order = signedByHash.get(fire.orderHash), shares = Number(order.filledShares), cost = Number(order.filledUsd);
      if (!(shares > 0)) continue;
      row.attempts++; row.fills++; row.shares += shares; row.cost += cost; row.fillFractionSum += 1;
      const fees = order.settlements.reduce((sum, settlement) => sum + .07 * Number(settlement.vwap) * (1 - Number(settlement.vwap)) * Number(settlement.shares), 0);
      row.fees += fees;
      if (market.winner === fire.outcome) { row.correctOrders++; row.winningShares += shares; }
      if (fire.outcome === "Up") up += shares; else down += shares;
    }
    row.activeWindows = Number(row.fills > 0); row.payout = market.winner === "Up" ? up : down;
    add(totals[startMs(market.slug) < splitMs ? "train" : "holdout"], row); add(totals.all, row);
  }
  return { train: metrics(totals.train), holdout: metrics(totals.holdout), all: metrics(totals.all) };
}

const report = {
  schema: 1, generatedAt: new Date().toISOString(), cohortFile, feedDir, firesFile,
  methodology: "oracle target action replay: exact high/medium V2-book-inferred fill, inferred decision at fill minus source decision latency, exact side/signed minimum shares/cap; fixed BUY budget; shared mutable full-L2 action book; FAK remainder; fee rounded per level; only execution latency/cap offset changes",
  sourceDecisionLatencyMs,
  marketPrefix: marketPrefix || null,
  split: new Date(splitMs).toISOString(), markets: markets.length, actualHighMedium: actual(),
  scenarios: replayScenarios(),
};
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
