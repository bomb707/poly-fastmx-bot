#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048-r2"));
const sourceFile = path.resolve(process.argv[3] || path.join(root, "data/wallet-3048/trades-2026-08-22T17_2026-08-24.json"));
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "fire-actions.json.gz")))).rows;
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const marketBySlug = new Map(source.markets.map((row) => [row.slug, row]));
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const q = (values, probabilities = [.1, .25, .5, .75, .9]) => Object.fromEntries(probabilities.map((p) => [
  `p${Math.round(p * 100)}`, round(quantile(values.filter(finite).map(Number), p), 6),
]));
const fee = (price, shares) => .07 * price * (1 - price) * shares;

const regimes = [
  { name: "Q30", q: 30, from: Date.parse("2026-08-22T17:00:00Z"), to: Date.parse("2026-08-23T06:15:00Z") },
  { name: "live_transition", q: null, from: Date.parse("2026-08-23T06:15:00Z"), to: Date.parse("2026-08-23T07:00:00Z") },
  { name: "Q25", q: 25, from: Date.parse("2026-08-23T07:00:00Z"), to: Date.parse("2026-08-24T00:50:00Z") },
];

function inRegime(slug, regime) { const ms = slugStart(slug); return ms >= regime.from && ms < regime.to; }
function modes(values, digits = 3) {
  const counts = new Map();
  for (const value of values.filter(finite)) {
    const key = Number(value).toFixed(digits);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 12)
    .map(([value, count]) => ({ value: Number(value), count }));
}

function economics(regime) {
  const trades = source.trades.filter((row) => inRegime(row.slug, regime));
  const slugs = new Set(trades.map((row) => row.slug));
  const inventory = new Map();
  const costBySlug = new Map();
  let cost = 0, fees = 0, makerShares = 0, takerShares = 0;
  for (const trade of trades) {
    const shares = Number(trade.size), price = Number(trade.price), charged = trade.role === "taker" ? fee(price, shares) : 0;
    cost += price * shares + charged;
    costBySlug.set(trade.slug, (costBySlug.get(trade.slug) || 0) + price * shares + charged);
    fees += charged;
    if (trade.role === "maker") makerShares += shares; else takerShares += shares;
    const key = `${trade.slug}:${trade.outcome}`;
    inventory.set(key, (inventory.get(key) || 0) + shares);
  }
  let payout = 0;
  const payoutBySlug = new Map();
  for (const slug of slugs) {
    const value = inventory.get(`${slug}:${marketBySlug.get(slug)?.winner}`) || 0;
    payoutBySlug.set(slug, value);
    payout += value;
  }
  const pnl = payout - cost;
  const windowPnl = [...slugs].map((slug) => Number(payoutBySlug.get(slug) || 0) - Number(costBySlug.get(slug) || 0));
  return {
    tradeRows: trades.length,
    makerSharePct: pct(makerShares, makerShares + takerShares),
    cost: round(cost, 2), fees: round(fees, 2), payout: round(payout, 2), pnl: round(pnl, 2), roiPct: pct(pnl, cost),
    pnlPerWindow: round(pnl / Math.max(1, slugs.size)),
    pnlPerQPerWindow: regime.q ? round(pnl / Math.max(1, slugs.size) / regime.q) : null,
    turnoverPerQPerWindow: regime.q ? round(cost / Math.max(1, slugs.size) / regime.q) : null,
    windowCostOverQ: regime.q ? q([...costBySlug.values()].map((value) => value / regime.q), [.1, .25, .5, .75, .9, .95, .99, 1]) : null,
    profitableWindowPct: pct(windowPnl.filter((value) => value > 0).length, windowPnl.length),
    windowPnlOverQ: regime.q ? q(windowPnl.map((value) => value / regime.q), [.1, .25, .5, .75, .9, .95, .99, 1]) : null,
  };
}

function analyze(regime) {
  const marketActions = actions.filter((row) => inRegime(row.slug, regime));
  const usableFires = fires.filter((row) => row.confidence !== "low" && inRegime(row.slug, regime));
  const hashes = new Set(usableFires.map((row) => row.orderHash));
  const orders = signed.filter((row) => hashes.has(row.orderHash));
  const bySlug = new Map();
  for (const action of marketActions) {
    if (!bySlug.has(action.slug)) bySlug.set(action.slug, []);
    bySlug.get(action.slug).push(action);
  }
  const firstFire = [], lastFire = [], crossings = [], maxLean = [], finalLean = [], actionCounts = [], interActionMs = [];
  for (const [slug, rows] of bySlug) {
    const ordered = [...rows].sort((a, b) => a.fireMs - b.fireMs);
    firstFire.push((ordered[0].fireMs - slugStart(slug)) / 1000);
    lastFire.push((ordered.at(-1).fireMs - slugStart(slug)) / 1000);
    actionCounts.push(ordered.length);
    let cross = 0, maximum = 0;
    for (let index = 0; index < ordered.length; index++) {
      const row = ordered[index];
      if (index) interActionMs.push(row.fireMs - ordered[index - 1].fireMs);
      maximum = Math.max(maximum, Math.abs(Number(row.afterImbalance)));
      if (Math.sign(Number(row.beforeImbalance)) && Math.sign(Number(row.afterImbalance)) && Math.sign(Number(row.beforeImbalance)) !== Math.sign(Number(row.afterImbalance))) cross++;
    }
    crossings.push(cross);
    maxLean.push(maximum);
    finalLean.push(Math.abs(Number(ordered.at(-1).afterImbalance)));
  }
  const base = regime.q;
  const largeActions = base ? marketActions.filter((row) => row.signedSizes.some((size) => Math.abs(Number(size) - 3 * base) < .01)) : [];
  const signedPhases = orders.map((row) => (Number(row.signedTimestampMs) - slugStart(row.fillRows?.[0]?.slug || row.settlements?.[0]?.slug || "btc-updown-5m-0")) / 1000).filter(finite);
  const orderRoles = { taker: 0, maker: 0, mixed: 0 };
  for (const order of orders) {
    const maker = order.settlementRoles.includes("maker"), taker = order.settlementRoles.includes("taker");
    if (maker && taker) orderRoles.mixed++; else if (maker) orderRoles.maker++; else orderRoles.taker++;
  }
  return {
    range: { from: new Date(regime.from).toISOString(), to: new Date(regime.to).toISOString(), q: base },
    samples: { windows: bySlug.size, actions: marketActions.length, exactOrders: orders.length },
    orderSize: {
      rawModes: modes(orders.map((row) => row.signedShares)),
      normalizedModes: base ? modes(orders.map((row) => Number(row.signedShares) / base), 4) : null,
      basePct: base ? pct(orders.filter((row) => Math.abs(Number(row.signedShares) - base) < .01).length, orders.length) : null,
      triplePct: base ? pct(orders.filter((row) => Math.abs(Number(row.signedShares) - 3 * base) < .01).length, orders.length) : null,
      limitInsideObservedBandPct: pct(orders.filter((row) => Number(row.limitPrice) >= .12 && Number(row.limitPrice) <= .89).length, orders.length),
    },
    actionLoop: {
      actionsPerWindow: q(actionCounts), firstFireS: q(firstFire), lastFireS: q(lastFire), interActionMs: q(interActionMs),
      entryPct: pct(marketActions.filter((row) => row.role === "entry/topup").length, marketActions.length),
      hedgePct: pct(marketActions.filter((row) => row.role === "hedge").length, marketActions.length),
      overhedgeCrossPct: pct(marketActions.filter((row) => row.role === "overhedge-cross").length, marketActions.length),
      crossingsPerWindow: q(crossings),
      maxAbsInventoryOverQ: base ? q(maxLean.map((value) => value / base)) : null,
      finalAbsInventoryOverQ: base ? q(finalLean.map((value) => value / base)) : null,
    },
    largeBranch: base ? {
      actions: largeActions.length,
      actionPct: pct(largeActions.length, marketActions.length),
      tFireS: q(largeActions.map((row) => (row.fireMs - slugStart(row.slug)) / 1000)),
      beforeOrientedOverQ: q(largeActions.map((row) => Number(row.beforeImbalance) * (row.outcome === "Up" ? 1 : -1) / base)),
      absoluteBeforeOverQ: q(largeActions.map((row) => Math.abs(Number(row.beforeImbalance)) / base)),
      hedgeOrCrossPct: pct(largeActions.filter((row) => row.role !== "entry/topup").length, largeActions.length),
      lateAfter211Pct: pct(largeActions.filter((row) => (row.fireMs - slugStart(row.slug)) / 1000 > 211).length, largeActions.length),
    } : null,
    orderLifecycle: { roles: orderRoles, methods: Object.fromEntries(["take", "rest", "take+rest"].map((method) => [method, usableFires.filter((row) => row.method === method).length])) },
    signedPhaseS: q(signedPhases),
    economics: economics(regime),
  };
}

const results = Object.fromEntries(regimes.map((regime) => [regime.name, analyze(regime)]));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  conclusion: "Q is a live capital parameter. Stable epochs use Q and 3Q while timing, cap band, release mechanics and normalized inventory cycling remain comparable.",
  results,
};
fs.writeFileSync(path.join(dataDir, "capital-invariance.json"), JSON.stringify(report, null, 2) + "\n");
const a = results.Q30, b = results.Q25;
const md = `# Capital-invariance analysis\n\n` +
`The stable order menu changed from Q=30 / 3Q=90 to Q=25 / 3Q=75. Q and 3Q account for ${a.orderSize.basePct + a.orderSize.triplePct}% of Q30 exact orders and ${b.orderSize.basePct + b.orderSize.triplePct}% of Q25 exact orders.\n\n` +
`Median actions/window are ${a.actionLoop.actionsPerWindow.p50} versus ${b.actionLoop.actionsPerWindow.p50}; median first/last fires are ${a.actionLoop.firstFireS.p50}/${a.actionLoop.lastFireS.p50}s versus ${b.actionLoop.firstFireS.p50}/${b.actionLoop.lastFireS.p50}s. Large-branch action rates are ${a.largeBranch.actionPct}% and ${b.largeBranch.actionPct}%.\n\n` +
`The live transition from 06:15–07:00 UTC is intentionally isolated: it contains a temporary 50-share branch mixed with the prior 90 branch and is not a stable capital regime.\n`;
fs.writeFileSync(path.join(dataDir, "capital-invariance.md"), md);
console.log(md);
console.log(JSON.stringify(report, null, 2));
