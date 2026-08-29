#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dataDir = path.resolve(process.argv[2]);
const sourceFile = path.resolve(process.argv[3]);
const l2Dir = path.resolve(process.argv[4]);
const fromMs = Date.parse(process.argv[5]);
const toMs = Date.parse(process.argv[6]);
const baseSize = Number(process.argv[7]);
const outputFile = path.resolve(process.argv[8] || path.join(dataDir, "oracle-action-replay.json"));
const scale = 1 / baseSize;
const envGrid = (name, fallback) => process.env[name]
  ? process.env[name].split(",").map(Number).filter(Number.isFinite)
  : fallback;
// This older upper-bound replay has one shared arrival clock. Keep only the
// authoritative maker-placement and taker-fill endpoints in its default grid.
const latencyGrid = envGrid("ORACLE_LATENCIES", [130, 520]);
const offsetGrid = envGrid("ORACLE_OFFSETS", [0, .01]);
const ttlGrid = envGrid("ORACLE_TTLS", [1500, 3000]);
const creditGrid = envGrid("ORACLE_CREDITS", [.25, .5]);
const fee = (price, shares) => .07 * price * (1 - price) * shares;
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));

if (![fromMs, toMs, baseSize].every(Number.isFinite) || toMs <= fromMs || baseSize <= 0) throw new Error("invalid arguments");
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const markets = source.markets.filter((market) => market.winner && slugStart(market.slug) >= fromMs && slugStart(market.slug) < toMs);
const signed = readGzip(path.join(dataDir, "signed-orders.json.gz")).groups;
const fires = readGzip(path.join(dataDir, "order-fires.json.gz")).rows;
const signedByHash = new Map(signed.map((row) => [row.orderHash, row]));
const bySlug = new Map();
for (const fire of fires) {
  if (fire.confidence === "low" || !signedByHash.has(fire.orderHash)) continue;
  const start = slugStart(fire.slug);
  if (start < fromMs || start >= toMs) continue;
  if (!bySlug.has(fire.slug)) bySlug.set(fire.slug, []);
  bySlug.get(fire.slug).push(fire);
}

function actionsFor(slug) {
  const ordered = [...(bySlug.get(slug) || [])].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash));
  const actions = [];
  let batch = [];
  const finish = () => {
    if (!batch.length) return;
    actions.push({ fireMs: batch[0].fireMs, side: batch[0].outcome,
      orders: batch.map((fire) => ({ fire, signed: signedByHash.get(fire.orderHash) })) });
  };
  for (const fire of ordered) {
    if (batch.length && (fire.outcome !== batch[0].outcome || fire.fireMs - batch.at(-1).fireMs > 300)) {
      finish();
      batch = [];
    }
    batch.push(fire);
  }
  finish();
  let actualUp = 0, actualDown = 0;
  for (const action of actions) {
    const before = actualUp - actualDown, sign = action.side === "Up" ? 1 : -1;
    const actualShares = action.orders.reduce((sum, order) => sum + Number(order.signed.filledShares || 0), 0);
    const after = before + sign * actualShares;
    action.role = before * sign < -1e-9 ? after * sign > 1e-9 ? "cross" : "hedge" : "entry";
    action.beforeImbalanceQ = before / baseSize;
    action.actualSharesQ = actualShares / baseSize;
    action.t = (action.fireMs - slugStart(slug)) / 1000;
    action.feature = action.orders[0]?.fire?.v2Feature || action.orders[0]?.fire?.feature || {};
    if (action.side === "Up") actualUp += actualShares; else actualDown += actualShares;
  }
  return actions;
}

function firstAtOrAfter(ticks, ms) {
  let lo = 0, hi = ticks.length - 1, answer = ticks.length;
  while (lo <= hi) {
    const middle = (lo + hi) >> 1;
    if (ticks[middle].ms >= ms) { answer = middle; hi = middle - 1; } else lo = middle + 1;
  }
  return answer;
}

function levels(tick, side) {
  return (side === "Up" ? tick.up : tick.down)?.asks?.map((row) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => row.price > 0 && row.price < 1 && row.size > 0).sort((a, b) => a.price - b.price) || [];
}

function execute(book, requested, limit) {
  let left = requested, shares = 0, usd = 0;
  for (const level of book) {
    if (level.price > limit + 1e-9 || left <= 1e-9) break;
    const take = Math.min(left, level.size);
    level.size -= take;
    left -= take;
    shares += take;
    usd += take * level.price;
  }
  return shares > 1e-9 ? { shares, usd, price: usd / shares, partial: left > 1e-9 } : null;
}

function bidDepthAt(tick, side, price) {
  return ((side === "Up" ? tick.up : tick.down)?.bids || []).reduce((sum, row) =>
    Math.abs(Number(row.price) - price) < .005 ? sum + Number(row.size || 0) : sum, 0);
}

function replayQueue(latencyMs, makerTtlMs, makerCreditPct) {
  const windows = [];
  const attribution = new Map();
  for (const market of markets) {
    const file = path.join(l2Dir, `${market.slug}.json.gz`);
    if (!fs.existsSync(file)) continue;
    const feed = readGzip(file);
    const ticks = (feed.ticks || []).map((tick) => ({ ...tick, ms: Number(tick.ms ?? Date.parse(tick.time || "")) }))
      .filter((tick) => Number.isFinite(tick.ms)).sort((a, b) => a.ms - b.ms);
    let up = 0, down = 0, cost = 0, fees = 0, fills = 0, makerFills = 0, attempts = 0, partials = 0, processed = 0;
    let pending = [];
    const apply = (side, shares, price, chargedFee, maker = false, action = null) => {
      cost += price * shares + chargedFee;
      fees += chargedFee;
      fills++;
      if (maker) makerFills++;
      if (side === "Up") up += shares; else down += shares;
      if (action) {
        const sideSign = side === "Up" ? 1 : -1;
        const rawClGap = Number(action.feature?.clGapPct);
        const alignedClGap = Number.isFinite(rawClGap) ? rawClGap * sideSign : null;
        const clBand = alignedClGap == null ? "missing" : alignedClGap <= -.05 ? "le-0.05" : alignedClGap <= -.01 ? "-0.05_-0.01"
          : alignedClGap < .01 ? "neutral" : alignedClGap < .05 ? "0.01_0.05" : "ge0.05";
        const timeBand = `${Math.floor(action.t / 30) * 30}-${Math.floor(action.t / 30) * 30 + 30}`;
        const priceBand = `${Math.floor(price * 10) / 10}-${Math.floor(price * 10) / 10 + .1}`;
        const key = [maker ? "maker" : "taker", action.role, timeBand, priceBand, clBand].join("|");
        const row = attribution.get(key) || { execution: maker ? "maker" : "taker", role: action.role, timeBand, priceBand, clBand, fills: 0, shares: 0, pnl: 0 };
        row.fills++;
        row.shares += shares;
        row.pnl += (market.winner === side ? shares : 0) - price * shares - chargedFee;
        attribution.set(key, row);
      }
    };
    const processTick = (tick) => {
      const next = [];
      for (const order of pending) {
        if (tick.ms > order.expiresMs) continue;
        const visible = bidDepthAt(tick, order.side, order.price);
        let removed = Math.max(0, order.lastVisible - visible);
        const ahead = Math.min(order.queueAhead, removed);
        order.queueAhead -= ahead;
        removed -= ahead;
        const shares = Math.min(order.shares, removed * makerCreditPct);
        if (shares > 1e-9) {
          apply(order.side, shares, order.price, 0, true, order.action);
          order.shares -= shares;
        }
        order.lastVisible = visible;
        if (order.shares > 1e-9) next.push(order);
      }
      pending = next;
    };
    for (const action of actionsFor(market.slug)) {
      const arrivalIndex = firstAtOrAfter(ticks, action.fireMs + latencyMs);
      if (arrivalIndex >= ticks.length) continue;
      while (processed <= arrivalIndex) processTick(ticks[processed++]);
      const arrival = ticks[arrivalIndex], book = levels(arrival, action.side);
      for (const order of action.orders) {
        attempts++;
        const requested = Number(order.signed.signedShares) * scale;
        const limit = Number(order.signed.limitPrice);
        const fill = execute(book, requested, limit);
        let remainder = requested;
        if (fill) {
          const chargedFee = fee(fill.price, fill.shares);
          apply(action.side, fill.shares, fill.price, chargedFee, false, action);
          partials += fill.partial ? 1 : 0;
          remainder -= fill.shares;
        }
        if (remainder > 1e-9) {
          const samePriceAhead = pending.filter((row) => row.side === action.side && Math.abs(row.price - limit) < .005)
            .reduce((sum, row) => sum + row.shares, 0);
          const visible = bidDepthAt(arrival, action.side, limit);
          pending.push({ side: action.side, price: limit, shares: remainder, action,
            expiresMs: arrival.ms + makerTtlMs, queueAhead: visible + samePriceAhead, lastVisible: visible });
        }
      }
    }
    while (processed < ticks.length && pending.length) processTick(ticks[processed++]);
    const payout = market.winner === "Up" ? up : down;
    windows.push({ slug: market.slug, startMs: slugStart(market.slug), attempts, fills, makerFills, partials, up, down, cost, fees, payout, pnl: payout - cost });
  }
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const sum = (field) => windows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const daily = new Map();
  for (const row of windows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= row.pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + row.pnl);
  }
  const totalCost = sum("cost"), pnl = sum("pnl");
  return {
    windows: windows.length, activeWindows: windows.filter((row) => row.fills).length,
    attempts: sum("attempts"), fills: sum("fills"), makerFills: sum("makerFills"), partials: sum("partials"),
    cost: round(totalCost), fees: round(sum("fees")), payout: round(sum("payout")), pnl: round(pnl),
    roiPct: totalCost ? round(pnl / totalCost * 100) : 0, maxDrawdown: round(maxDrawdown),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])),
    attribution: [...attribution.values()].map((row) => ({ ...row, shares: round(row.shares), pnl: round(row.pnl) }))
      .sort((a, b) => a.execution.localeCompare(b.execution) || a.role.localeCompare(b.role) || a.timeBand.localeCompare(b.timeBand) || a.priceBand.localeCompare(b.priceBand) || a.clBand.localeCompare(b.clBand)),
  };
}

function replay(latencyMs, limitOffset) {
  const windows = [];
  for (const market of markets) {
    const file = path.join(l2Dir, `${market.slug}.json.gz`);
    if (!fs.existsSync(file)) continue;
    const feed = readGzip(file);
    const ticks = (feed.ticks || []).map((tick) => ({ ...tick, ms: Number(tick.ms ?? Date.parse(tick.time || "")) }))
      .filter((tick) => Number.isFinite(tick.ms)).sort((a, b) => a.ms - b.ms);
    let up = 0, down = 0, cost = 0, fees = 0, fills = 0, attempts = 0, partials = 0;
    for (const action of actionsFor(market.slug)) {
      const index = firstAtOrAfter(ticks, action.fireMs + latencyMs);
      if (index >= ticks.length) continue;
      const book = levels(ticks[index], action.side);
      for (const order of action.orders) {
        attempts++;
        const requested = Number(order.signed.signedShares) * scale;
        const limit = Math.min(.99, round(Number(order.signed.limitPrice) + limitOffset, 2));
        const fill = execute(book, requested, limit);
        if (!fill) continue;
        const chargedFee = fee(fill.price, fill.shares);
        fills++;
        partials += fill.partial ? 1 : 0;
        cost += fill.usd + chargedFee;
        fees += chargedFee;
        if (action.side === "Up") up += fill.shares; else down += fill.shares;
      }
    }
    const payout = market.winner === "Up" ? up : down;
    windows.push({ slug: market.slug, startMs: slugStart(market.slug), attempts, fills, partials, up, down, cost, fees, payout, pnl: payout - cost });
  }
  let equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const sum = (field) => windows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const daily = new Map();
  for (const row of windows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= row.pnl;
    const day = new Date(row.startMs).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + row.pnl);
  }
  const cost = sum("cost"), pnl = sum("pnl");
  return {
    windows: windows.length, activeWindows: windows.filter((row) => row.fills).length,
    attempts: sum("attempts"), fills: sum("fills"), partials: sum("partials"),
    cost: round(cost), fees: round(sum("fees")), payout: round(sum("payout")), pnl: round(pnl),
    roiPct: cost ? round(pnl / cost * 100) : 0, maxDrawdown: round(maxDrawdown),
    profitFactor: grossLoss > 1e-9 ? round(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])),
  };
}

const diagnostics = {};
for (const latencyMs of latencyGrid) for (const limitOffset of offsetGrid) {
  diagnostics[`${latencyMs}ms_offset${limitOffset}`] = replay(latencyMs, limitOffset);
}
const queueDiagnostics = {};
for (const latencyMs of latencyGrid) for (const makerTtlMs of ttlGrid) for (const makerCreditPct of creditGrid) {
  queueDiagnostics[`${latencyMs}ms_ttl${makerTtlMs}_credit${makerCreditPct}`] = replayQueue(latencyMs, makerTtlMs, makerCreditPct);
}
const output = {
  schema: 1, generatedAt: new Date().toISOString(),
  methodology: "oracle upper bound: target high/medium inferred v4 action side, exact signed size/price menu scaled to Q=1; execute only recorded asks at fire+latency; cancel unfilled remainder; taker fee on every fill",
  range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), sourceBaseSize: baseSize, replayBaseSize: 1 },
  diagnostics,
  queueDiagnostics,
};
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
