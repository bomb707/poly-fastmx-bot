#!/usr/bin/env node
// Causal, independently executable imitation of wallet 0x75cc.  Models are
// fitted on the first half of Aug 25; policy selection uses training PnL only.
// Every simulated fill arrives 520 ms after its decision, walks full V2 L2 up
// to the pre-signed cap, and pays the documented five-minute crypto taker fee.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const cohortFile = path.resolve(process.argv[2] || "data/wallet-75cc/cohort-2026-08-25.json");
const feedDir = path.resolve(process.argv[3] || "data/wallet-75cc/feeds/v2-l2");
const modelDir = path.resolve(process.argv[4] || "data/wallet-75cc");
const splitMs = Date.parse(process.argv[5] || "2026-08-25T12:00:00Z");
const outputFile = path.resolve(process.argv[6] || "data/wallet-75cc/tree-imitation-backtest.json");
if (!Number.isFinite(splitMs)) throw new Error("invalid split time");
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const fireTreeFile = path.resolve(process.env.W75CC_FIRE_TREE_FILE || path.join(modelDir, "fire-gate-tree-v2.json"));
const sideTreeFile = path.resolve(process.env.W75CC_SIDE_TREE_FILE || path.join(modelDir, "side-choice-analysis.json"));
const sizeTreeFile = path.resolve(process.env.W75CC_SIZE_TREE_FILE || path.join(modelDir, "action-size-tree.json"));
const valueTreeFile = process.env.W75CC_VALUE_TREE_FILE ? path.resolve(process.env.W75CC_VALUE_TREE_FILE) : null;
const hazardFile = process.env.W75CC_HAZARD_FILE ? path.resolve(process.env.W75CC_HAZARD_FILE) : null;
const reversalFile = process.env.W75CC_REVERSAL_FILE ? path.resolve(process.env.W75CC_REVERSAL_FILE) : null;
const fireModels = JSON.parse(fs.readFileSync(fireTreeFile, "utf8")).models;
const sideTree = JSON.parse(fs.readFileSync(sideTreeFile, "utf8")).marketOnlyTree.root;
const sizeTree = JSON.parse(fs.readFileSync(sizeTreeFile, "utf8")).tree;
const valueTree = valueTreeFile ? JSON.parse(fs.readFileSync(valueTreeFile, "utf8")).tree : null;
const hazardReport = hazardFile ? JSON.parse(fs.readFileSync(hazardFile, "utf8")) : null;
const hazardModels = hazardReport?.models || null;
// The order-conditioned report contains two distinct models. `models` removes
// clock/cadence fields and is appropriate when the exact private candidate is
// unknown. In ladder mode we explicitly reconstruct every one-cent candidate
// and its uninterrupted executable duration, so the full hazard tree is causal
// and its strongest release feature (`executableRunS`) is available.
const hazardFullTree = process.env.W75CC_HAZARD_FULL === "1" ? hazardReport?.tree?.root : null;
const reversalReport = reversalFile ? JSON.parse(fs.readFileSync(reversalFile, "utf8")) : null;
const reversalTree = reversalReport?.model?.tree?.root || null;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const marketPrefix = String(process.env.W75CC_MARKET_PREFIX || "").trim().toLowerCase();
const decisionStepMs = Math.max(50, Number(process.env.W75CC_DECISION_STEP_MS || 250));
const markets = cohort.markets.filter((market) => market.winner && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .filter((market) => !marketPrefix || market.slug.toLowerCase().startsWith(marketPrefix))
  .sort((a, b) => startMs(a.slug) - startMs(b.slug) || a.slug.localeCompare(b.slug));

function blank() { return { markets: 0, activeMarkets: 0, orders: 0, correctOrders: 0, shares: 0, winningShares: 0, cost: 0, fees: 0, payout: 0, requestedBudget: 0, fillFractionSum: 0 }; }
const envNumbers = (name, fallback) => String(process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite).length
  ? String(process.env[name]).split(",").map((value) => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
  : fallback;
const envStrings = (name, fallback) => String(process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean).length
  ? String(process.env[name]).split(",").map((value) => value.trim()).filter(Boolean)
  : fallback;
const triggerMode = hazardFullTree ? "hazard-full" : hazardModels ? "hazard" : "fire";
const policies = [];
const capHeadroomGrid = envNumbers("W75CC_CAP_HEADROOMS", [.01]);
for (const entryThreshold of envNumbers("W75CC_ENTRY_THRESHOLDS", [.88, .925, .95]))
  for (const hedgeThreshold of envNumbers("W75CC_HEDGE_THRESHOLDS", [.84, .92]))
      for (const cooldownMs of envNumbers("W75CC_COOLDOWNS_MS", [500, 2_000, 4_000]))
        for (const capHeadroom of capHeadroomGrid)
          for (const sizeMode of envStrings("W75CC_SIZE_MODES", ["base7", "model"]))
          for (const valueEdgeMin of valueTree ? envNumbers("W75CC_VALUE_EDGE_MINS", [.01]) : [-Infinity])
            for (const sideThreshold of envNumbers("W75CC_SIDE_THRESHOLDS", [0]))
              for (const cheapSideThreshold of envNumbers("W75CC_CHEAP_SIDE_THRESHOLDS", [sideThreshold]))
                for (const maxOrdersPerMarket of envNumbers("W75CC_MAX_ORDERS_PER_MARKET", [999]))
                  for (const reversalMode of envStrings("W75CC_REVERSAL_MODES", reversalTree ? ["crossOnly"] : ["all"]))
                    for (const crossThreshold of reversalTree ? envNumbers("W75CC_CROSS_THRESHOLDS", [reversalReport.model.train.threshold]) : [-Infinity])
                      for (const maxPairCost of envNumbers("W75CC_MAX_PAIR_COSTS", [.995])) policies.push({
          id: `${triggerMode}-e${entryThreshold}-h${hedgeThreshold}-c${cooldownMs}-x${capHeadroom}-${sizeMode}-v${valueEdgeMin}-s${sideThreshold}-sc${cheapSideThreshold}-n${maxOrdersPerMarket}-r${reversalMode}-q${crossThreshold}-p${maxPairCost}`,
          entryThreshold, hedgeThreshold, cooldownMs, capHeadroom, sizeMode, sideThreshold, cheapSideThreshold, maxOrdersPerMarket,
          reversalMode, crossThreshold, maxPairCost,
          takerLatencyMs: 520, decisionStepMs, maxCellUses: 1,
          eventMode: String(process.env.W75CC_EVENT_MODE || "all"),
          valueEdgeMin,
          minAsk: .01, maxAsk: .99, train: blank(), holdout: blank(), all: blank(), daily: {},
        });

function atOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) { const middle = (low + high) >> 1; if (ticks[middle].ms <= ms) { answer = middle; low = middle + 1; } else high = middle - 1; }
  return answer;
}
const opposite = (side) => side === "Up" ? "Down" : "Up";
const book = (tick, side) => side === "Up" ? tick?.up : tick?.down;
const bestAsk = (tick, side) => Number(book(tick, side)?.asks?.[0]?.price);
const bestBid = (tick, side) => Number(book(tick, side)?.bids?.[0]?.price);
const depth = (levels, n = 3) => (levels || []).slice(0, n).reduce((sum, level) => sum + Number(level.size), 0);
function walkBudget(levels, budget, cap) {
  let remaining = budget, shares = 0, cost = 0, fee = 0;
  for (const level of levels || []) {
    const price = Number(level.price), available = Number(level.size);
    if (!(price > 0) || price > cap + .00011 || !(available > 0) || remaining <= 1e-9) break;
    const take = Math.min(available, remaining / price), usd = take * price;
    shares += take; cost += usd; fee += Math.round(.07 * price * (1 - price) * take * 1e5) / 1e5; remaining -= usd;
  }
  return { shares, cost, fee, fraction: budget > 0 ? cost / budget : 0 };
}
function firstLotCost(lots, shares) {
  let remaining = shares, used = 0, cost = 0;
  for (const lot of lots) {
    const take = Math.min(remaining, lot.shares);
    remaining -= take; used += take; cost += take * lot.effectivePrice;
    if (remaining <= 1e-9) break;
  }
  return used >= shares - 1e-9 ? cost / used : null;
}
function addInventory(state, side, shares, effectivePrice) {
  const other = opposite(side);
  let remaining = shares;
  while (remaining > 1e-9 && state.lots[other].length) {
    const lot = state.lots[other][0], take = Math.min(remaining, lot.shares);
    remaining -= take; lot.shares -= take;
    if (lot.shares <= 1e-9) state.lots[other].shift();
  }
  if (remaining > 1e-9) state.lots[side].push({ shares: remaining, effectivePrice });
  if (side === "Up") state.up += shares; else state.down += shares;
}
function predict(tree, row, field = "balancedPositiveRate") {
  let node = tree?.tree?.root || tree?.root || tree;
  while (node?.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Number(node?.[field] ?? node?.positiveRate ?? 0);
}
function predictSize(row) {
  let node = sizeTree;
  while (node.field) node = Number(row[node.field]) <= node.threshold ? node.left : node.right;
  return Math.max(5, Math.min(227, Math.round(Number(node.medianSize) || 7)));
}
function requestedSharesFor(mode, row, intent = "normal") {
  // A partial order is admitted only when completing a pair is independently
  // profitable after fees.  It may flatten obsolete inventory, never cross it.
  if (intent === "profitablePair") return Math.max(0, Math.ceil(Math.abs(row.orientedInventory)));
  if (mode === "base7") return 7;
  if (mode === "model") return predictSize(row);
  if (mode === "residualModel") {
    const desiredResidual = predictSize(row);
    return Math.max(0, Math.ceil(desiredResidual - row.orientedInventory));
  }
  if (mode === "mirror7" || mode === "mirrorModel") {
    if (row.orientedInventory < -1e-9) return Math.max(5, Math.ceil(2 * Math.abs(row.orientedInventory)));
    return mode === "mirrorModel" ? predictSize(row) : 7;
  }
  if (mode === "cycle7" || mode === "cycle15") {
    const residual = mode === "cycle15" ? 15 : 7;
    if (row.orientedInventory < -1e-9) return Math.ceil(Math.abs(row.orientedInventory) + residual);
    return Math.max(0, Math.ceil(residual - row.orientedInventory));
  }
  throw new Error(`unknown size mode ${mode}`);
}

function staticFeature(feed, index, side) {
  const tick = feed.ticks[index], sideSign = side === "Up" ? 1 : -1, other = opposite(side);
  const sideBook = book(tick, side), ask = bestAsk(tick, side), bid = bestBid(tick, side), otherAsk = bestAsk(tick, other);
  if (!finite(ask) || !finite(bid) || !finite(otherAsk)) return null;
  const askDepth1 = depth(sideBook.asks, 1), bidDepth1 = depth(sideBook.bids, 1), askDepth3 = depth(sideBook.asks, 3), bidDepth3 = depth(sideBook.bids, 3);
  const out = {
    timeS: (tick.ms - startMs(feed.slug)) / 1000, ask, spread: ask - bid, pairAsk: ask + otherAsk,
    askDepth1, bidDepth1, askDepth3, bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(1e-9, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(1e-9, bidDepth3 + askDepth3),
    topAskShareOfDepth3: askDepth1 / Math.max(1e-9, askDepth3),
    micropriceBias: (bidDepth1 * ask + askDepth1 * bid) / Math.max(1e-9, bidDepth1 + askDepth1) - (ask + bid) / 2,
    coinBtc: Number(feed.slug.startsWith("btc-")),
  };
  const previous = feed.ticks[index - 1];
  out.sideAskTickMove = finite(bestAsk(previous, side)) ? ask - bestAsk(previous, side) : null;
  out.sideBidTickMove = finite(bestBid(previous, side)) ? bid - bestBid(previous, side) : null;
  out.observationAgeMs = 0;
  for (const [label, lookbackMs] of [["100ms", 100], ["250ms", 250], ["500ms", 500], ["1", 1_000], ["3", 3_000], ["5", 5_000], ["10", 10_000]]) {
    const prior = feed.ticks[atOrBefore(feed.ticks, tick.ms - lookbackMs)], priorBook = book(prior, side);
    const priorAsk = bestAsk(prior, side), priorBid = bestBid(prior, side);
    out[`sideAskMove${label}`] = finite(priorAsk) ? ask - priorAsk : null;
    out[`sideBidMove${label}`] = finite(priorBid) ? bid - priorBid : null;
    out[`askDepth3Change${label}`] = priorBook ? askDepth3 - depth(priorBook.asks, 3) : null;
    out[`bidDepth3Change${label}`] = priorBook ? bidDepth3 - depth(priorBook.bids, 3) : null;
    out[`bzMove${label}`] = Number(tick.bz) > 0 && Number(prior?.bz) > 0 ? (Number(tick.bz) - Number(prior.bz)) / Number(prior.bz) * 100 * sideSign : null;
    out[`clMove${label}`] = Number(tick.cl) > 0 && Number(prior?.cl) > 0 ? (Number(tick.cl) - Number(prior.cl)) / Number(prior.cl) * 100 * sideSign : null;
  }
  out.sideAskAccel500ms = finite(out.sideAskMove500ms) && finite(out.sideAskMove1) ? 2 * out.sideAskMove500ms - out.sideAskMove1 : null;
  out.sideBidAccel500ms = finite(out.sideBidMove500ms) && finite(out.sideBidMove1) ? 2 * out.sideBidMove500ms - out.sideBidMove1 : null;
  out.bzAccel500ms = finite(out.bzMove500ms) && finite(out.bzMove1) ? 2 * out.bzMove500ms - out.bzMove1 : null;
  out.bzGap = Number(tick.bz) > 0 && Number(feed.openBinance) > 0 ? (Number(tick.bz) - Number(feed.openBinance)) / Number(feed.openBinance) * 100 * sideSign : null;
  out.clGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0 ? (Number(tick.cl) - Number(feed.openChainlink)) / Number(feed.openChainlink) * 100 * sideSign : null;
  return out;
}
function dynamicFeature(base, side, state, tickMs) {
  const sign = side === "Up" ? 1 : -1, imbalance = state.up - state.down, oriented = imbalance * sign;
  const lotCost = oriented < -1e-9 ? firstLotCost(state.lots[opposite(side)], Math.min(30, Math.abs(imbalance))) : null;
  return {
    ...base, orientedInventory: oriented, absoluteInventory: Math.abs(imbalance), isHedge: Number(oriented < -1e-9),
    fifoPairCost: lotCost == null ? null : lotCost + base.ask + .07 * base.ask * (1 - base.ask),
    sinceLastFireS: Number.isFinite(state.lastFireMs) ? (tickMs - state.lastFireMs) / 1_000 : 300,
    sinceSameSideFireS: Number.isFinite(state.lastSideMs[side]) ? (tickMs - state.lastSideMs[side]) / 1_000 : 300,
  };
}

for (let marketIndex = 0; marketIndex < markets.length; marketIndex++) {
  const market = markets[marketIndex], feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  const ticks = feed.ticks || [], segment = startMs(market.slug) < splitMs ? "train" : "holdout";
  const points = [];
  let lastMs = -Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const timeS = (ticks[index].ms - startMs(market.slug)) / 1_000;
    if (timeS < 5 || timeS > 270 || ticks[index].ms - lastMs < decisionStepMs) continue;
    lastMs = ticks[index].ms;
    points.push({ index, tick: ticks[index], base: { Up: staticFeature(feed, index, "Up"), Down: staticFeature(feed, index, "Down") } });
  }
  if (hazardFullTree) {
    // Precompute uninterrupted marketability once per market. Every policy can
    // then query its cap cell in O(1), instead of rebuilding the 99-cell menu.
    const executableSince = { Up: new Array(100).fill(null), Down: new Array(100).fill(null) };
    for (const point of points) {
      point.executableRunS = { Up: {}, Down: {} };
      for (const side of ["Up", "Down"]) {
        const sideAsk = Number(point.base[side]?.ask);
        if (!Number.isFinite(sideAsk)) continue;
        for (let cents = 1; cents <= 99; cents++) {
          if (sideAsk <= cents / 100 + 1e-9) {
            if (executableSince[side][cents] == null) executableSince[side][cents] = point.tick.ms;
          } else executableSince[side][cents] = null;
        }
        for (const headroom of capHeadroomGrid) {
          const cap = Math.min(.99, Math.ceil((sideAsk + headroom - 1e-10) * 100) / 100);
          const cents = Math.round(cap * 100), since = executableSince[side][cents];
          point.executableRunS[side][cap.toFixed(2)] = since == null ? 0 : Math.max(0, (point.tick.ms - since) / 1000);
        }
      }
    }
  }
  const states = policies.map(() => ({ up: 0, down: 0, lots: { Up: [], Down: [] }, lastFireMs: -Infinity, lastSideMs: { Up: -Infinity, Down: -Infinity }, prevFireScore: { Up: null, Down: null }, prevCellScore: new Map(), executableSince: new Map(), used: new Map(), orders: 0, correctOrders: 0, shares: 0, winningShares: 0, cost: 0, fees: 0, requestedBudget: 0, fillFractionSum: 0 }));
  for (const point of points) {
    for (let policyIndex = 0; policyIndex < policies.length; policyIndex++) {
      const policy = policies[policyIndex], state = states[policyIndex];
      if (state.orders >= policy.maxOrdersPerMarket) continue;
      const inCooldown = point.tick.ms - state.lastFireMs < policy.cooldownMs;
      const candidates = [];
      for (const side of ["Up", "Down"]) {
        if (!point.base[side]) continue;
        const row = dynamicFeature(point.base[side], side, state, point.tick.ms);
        if (policy.eventMode === "rise" && !(row.sideAskTickMove > 0 || row.sideBidTickMove > 0)) continue;
        if (policy.eventMode === "change" && !(Math.abs(row.sideAskTickMove) > 1e-12 || Math.abs(row.sideBidTickMove) > 1e-12)) continue;
        if (row.ask < policy.minAsk || row.ask > policy.maxAsk) continue;
        const role = row.isHedge ? "hedge" : "entry";
        const cap = Math.min(.99, Math.ceil((row.ask + policy.capHeadroom - 1e-10) * 100) / 100);
        const scoredRow = {
          ...row,
          cap,
          capHeadroom: cap - row.ask,
          exactCap: Number(Math.abs(cap - row.ask) < .005),
          contains90: 0,
          executableRunS: hazardFullTree ? (point.executableRunS?.[side]?.[cap.toFixed(2)] ?? 0) : null,
        };
        const fireScore = hazardFullTree
          ? predict(hazardFullTree, scoredRow, "positiveRate")
          : hazardModels
          ? predict(hazardModels[role]?.root || hazardModels.all?.root, scoredRow, "positiveRate")
          : predict(fireModels[role], scoredRow);
        const fireThreshold = row.isHedge ? policy.hedgeThreshold : policy.entryThreshold;
        const scoreKey = hazardFullTree ? `${side}:${cap.toFixed(2)}` : side;
        const wasAboveFireThreshold = Number(hazardFullTree ? state.prevCellScore.get(scoreKey) : state.prevFireScore[side]) >= fireThreshold;
        if (hazardFullTree) state.prevCellScore.set(scoreKey, fireScore);
        else state.prevFireScore[side] = fireScore;
        if (inCooldown || fireScore + 1e-12 < fireThreshold) continue;
        if (policy.eventMode === "scoreCross" && wasAboveFireThreshold) continue;
        const valueWinProbability = valueTree ? predict(valueTree, scoredRow, "winRate") : null;
        const valueEdge = valueTree ? valueWinProbability - scoredRow.ask - .07 * scoredRow.ask * (1 - scoredRow.ask) : null;
        if (valueTree && valueEdge + 1e-12 < policy.valueEdgeMin) continue;
        const cell = `${side}:${cap.toFixed(2)}`;
        if ((state.used.get(cell) || 0) >= policy.maxCellUses) continue;
        const sideScore = predict(sideTree, scoredRow, "positiveRate");
        const requiredSideScore = scoredRow.ask <= .53 ? policy.cheapSideThreshold : policy.sideThreshold;
        if (sideScore + 1e-12 < requiredSideScore) continue;
        const crossScore = row.isHedge && reversalTree ? predict(reversalTree, scoredRow, "balancedPositiveRate") : null;
        let intent = row.isHedge ? "cross" : "entry";
        if (row.isHedge && reversalTree && crossScore + 1e-12 < policy.crossThreshold) {
          if (policy.reversalMode === "crossOnly") continue;
          if (policy.reversalMode === "crossOrPair" && scoredRow.fifoPairCost <= policy.maxPairCost) intent = "profitablePair";
          else if (policy.reversalMode !== "all") continue;
        }
        candidates.push({ side, row: scoredRow, cap, cell, fireScore, sideScore, crossScore, intent, valueWinProbability, valueEdge,
          score: .7 * fireScore + .3 * sideScore });
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => b.score - a.score || b.row.bzMove3 - a.row.bzMove3);
      const chosen = candidates[0], requestedShares = requestedSharesFor(policy.sizeMode, chosen.row, chosen.intent);
      if (!(requestedShares > 0)) continue;
      const budget = chosen.cap * requestedShares, fillIndex = atOrBefore(ticks, point.tick.ms + policy.takerLatencyMs);
      if (fillIndex < 0) continue;
      const fill = walkBudget(book(ticks[fillIndex], chosen.side)?.asks, budget, chosen.cap);
      state.used.set(chosen.cell, (state.used.get(chosen.cell) || 0) + 1);
      state.lastFireMs = point.tick.ms; state.lastSideMs[chosen.side] = point.tick.ms; state.requestedBudget += budget;
      if (!(fill.shares > 0)) continue;
      state.orders++; state.shares += fill.shares; state.cost += fill.cost; state.fees += fill.fee; state.fillFractionSum += fill.fraction;
      if (market.winner === chosen.side) { state.correctOrders++; state.winningShares += fill.shares; }
      addInventory(state, chosen.side, fill.shares, (fill.cost + fill.fee) / fill.shares);
    }
  }
  for (let index = 0; index < policies.length; index++) {
    const policy = policies[index], state = states[index], payout = market.winner === "Up" ? state.up : state.down;
    const day = new Date(startMs(market.slug)).toISOString().slice(0, 10);
    policy.daily[day] ||= blank();
    for (const total of [policy[segment], policy.all, policy.daily[day]]) {
      total.markets++; if (state.orders) total.activeMarkets++;
      total.orders += state.orders; total.correctOrders += state.correctOrders; total.shares += state.shares; total.winningShares += state.winningShares; total.cost += state.cost; total.fees += state.fees;
      total.payout += payout; total.requestedBudget += state.requestedBudget; total.fillFractionSum += state.fillFractionSum;
    }
  }
  if ((marketIndex + 1) % 25 === 0 || marketIndex + 1 === markets.length) console.log(JSON.stringify({ phase: "replay", done: marketIndex + 1, total: markets.length }));
}

function metrics(raw) {
  const net = raw.payout - raw.cost - raw.fees;
  return {
    ...Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === "number" ? round(value, 4) : value])),
    net: round(net, 4), roiPct: raw.cost + raw.fees > 0 ? round(net / (raw.cost + raw.fees) * 100, 4) : null,
    participationPct: raw.markets ? round(raw.activeMarkets / raw.markets * 100, 3) : null,
    ordersPerActiveMarket: raw.activeMarkets ? round(raw.orders / raw.activeMarkets, 3) : null,
    actionAccuracyPct: raw.orders ? round(raw.correctOrders / raw.orders * 100, 3) : null,
    shareWeightedAccuracyPct: raw.shares ? round(raw.winningShares / raw.shares * 100, 3) : null,
    averageFillFraction: raw.orders ? round(raw.fillFractionSum / raw.orders, 4) : null,
  };
}
const rows = policies.map((policy) => ({
  config: Object.fromEntries(Object.entries(policy).filter(([key]) => !["train", "holdout", "all", "daily"].includes(key))),
  train: metrics(policy.train), holdout: metrics(policy.holdout), all: metrics(policy.all),
  daily: Object.fromEntries(Object.entries(policy.daily).map(([day, raw]) => [day, metrics(raw)])),
}));
const minTrainOrders = Number(process.env.W75CC_MIN_TRAIN_ORDERS || 500);
const maxTrainOrders = Number(process.env.W75CC_MAX_TRAIN_ORDERS || 3_000);
const minTrainMarkets = Number(process.env.W75CC_MIN_TRAIN_MARKETS || 100);
const eligible = rows.filter((row) => row.train.orders >= minTrainOrders && row.train.orders <= maxTrainOrders && row.train.activeMarkets >= minTrainMarkets)
  .sort((a, b) => b.train.net - a.train.net || b.train.roiPct - a.train.roiPct);
const selected = eligible[0] || [...rows].sort((a, b) => b.train.net - a.train.net)[0];
const report = {
  schema: 1, generatedAt: new Date().toISOString(), cohortFile, feedDir, modelDir, valueTreeFile, hazardFile, reversalFile, triggerMode,
  marketPrefix: marketPrefix || null,
  causality: { split: new Date(splitMs).toISOString(), decisionStepMs, takerLatencyMs: 520, orderType: "FAK-equivalent full-depth walk capped at signed limit", fee: "round(0.07*p*(1-p)*shares, 5) per consumed level", selection: `maximum train net subject to ${minTrainOrders}-${maxTrainOrders} orders and >=${minTrainMarkets} active train markets` },
  markets: markets.length, policies: rows.length, selected, topTrain: eligible.slice(0, 30), rows,
};
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputFile, policies: rows.length, selected, topTrainHoldout: eligible.slice(0, 12).map((row) => ({ id: row.config.id, trainNet: row.train.net, trainRoi: row.train.roiPct, holdoutNet: row.holdout.net, holdoutRoi: row.holdout.roiPct, holdoutOrders: row.holdout.orders })) }, null, 2));
