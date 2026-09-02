import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { featuresAtFire, inferGroupedOrderFire } from "../wallet-3048/order-fire.mjs";

const EPS = 1e-9;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const startMs = (slug) => Number(String(slug || "").split("-").at(-1)) * 1_000;
const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const CAP_FEATURE_NAMES = [
  "timeFraction", "ask", "cap", "capHeadroom", "exactCap", "spread", "pairAsk",
  "askDepth1", "askDepth3", "bidDepth1", "bidDepth3", "topDepthImbalance",
  "depth3Imbalance", "micropriceBias", "executableRunLog", "sinceLastFireLog",
  "sinceSameSideFireLog", "absoluteInventoryLog", "orientedInventory", "oppositeInventory",
  "binanceGap", "twapGap", "binanceTwapBasis",
  ...[1_000, 3_000, 5_000, 15_000, 30_000, 60_000].flatMap((ms) => [
    `askMove${ms}`, `bidMove${ms}`, `binanceMove${ms}`, `twapMove${ms}`, `basisMove${ms}`,
  ]),
  "askDepth3Change1000", "bidDepth3Change1000", "askDepth3Change3000",
  "bidDepth3Change3000", "askDepth3Change5000", "bidDepth3Change5000",
];

export function indexAtOrBefore(ticks, ms) {
  let low = 0, high = ticks.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(ticks[middle].ms) <= ms) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

const opposite = (side) => side === "Up" ? "Down" : "Up";
const sideSign = (side) => side === "Up" ? 1 : -1;
const sideBook = (tick, side) => side === "Up" ? tick?.up : tick?.down;
const bestAsk = (tick, side) => Number(sideBook(tick, side)?.asks?.[0]?.price);
const bestBid = (tick, side) => Number(sideBook(tick, side)?.bids?.[0]?.price);
const depth = (rows, count) => (rows || []).slice(0, count)
  .reduce((sum, row) => sum + Number(row.size || 0), 0);
const pctMove = (current, prior) => current > 0 && prior > 0 ? (current - prior) / prior * 100 : 0;
const basisPct = (tick) => Number(tick?.bz) > 0 && Number(tick?.cl) > 0
  ? (Number(tick.bz) - Number(tick.cl)) / Number(tick.cl) * 100 : 0;

/**
 * Reconstruct the causal 59-column cap-cell vector used by the weekly policy.
 * `executableSinceMs` belongs to this side/cap cell and must be tracked without
 * looking ahead. Target inventory fields are retained for schema parity; the
 * autonomous structural model deliberately assigns them zero weight.
 */
export function capFeatureAt({ feed, ticks = feed?.ticks || [], index, side, cap,
  executableSinceMs = null, lastFireMs = null, lastSideFireMs = null,
  upShares = 0, downShares = 0 } = {}) {
  if (!(index >= 0) || !["Up", "Down"].includes(side)) return null;
  const tick = ticks[index], book = sideBook(tick, side), other = opposite(side);
  const ask = bestAsk(tick, side), bid = bestBid(tick, side), otherAsk = bestAsk(tick, other);
  if (!(ask > 0 && bid > 0 && otherAsk > 0 && cap >= ask - 1e-9)) return null;
  const askDepth1 = depth(book.asks, 1), askDepth3 = depth(book.asks, 3);
  const bidDepth1 = depth(book.bids, 1), bidDepth3 = depth(book.bids, 3);
  const sign = sideSign(side), net = Number(upShares) - Number(downShares);
  const orientedInventory = net * sign;
  const rawWindowStart = Number(feed?.windowStart);
  const windowStartMs = rawWindowStart > 1e11 ? rawWindowStart
    : rawWindowStart > 1e8 ? rawWindowStart * 1_000 : startMs(feed?.slug);
  const raw = {
    timeFraction: (Number(tick.ms) - windowStartMs) / 300_000,
    ask, cap, capHeadroom: cap - ask, exactCap: Number(Math.abs(cap - ask) < .005),
    spread: ask - bid, pairAsk: ask + otherAsk,
    askDepth1, askDepth3, bidDepth1, bidDepth3,
    topDepthImbalance: (bidDepth1 - askDepth1) / Math.max(EPS, bidDepth1 + askDepth1),
    depth3Imbalance: (bidDepth3 - askDepth3) / Math.max(EPS, bidDepth3 + askDepth3),
    micropriceBias: (bidDepth1 * ask + askDepth1 * bid) / Math.max(EPS, bidDepth1 + askDepth1)
      - (ask + bid) / 2,
    executableRunLog: Math.log1p(Math.max(0, (Number(tick.ms) - Number(executableSinceMs ?? tick.ms)) / 1_000)),
    sinceLastFireLog: Math.log1p(Math.min(300, Number.isFinite(lastFireMs)
      ? Math.max(0, (Number(tick.ms) - lastFireMs) / 1_000) : 300)),
    sinceSameSideFireLog: Math.log1p(Math.min(300, Number.isFinite(lastSideFireMs)
      ? Math.max(0, (Number(tick.ms) - lastSideFireMs) / 1_000) : 300)),
    absoluteInventoryLog: Math.log1p(Math.abs(net)),
    orientedInventory,
    oppositeInventory: Math.max(0, -orientedInventory),
    binanceGap: Number(tick.bz) > 0 && Number(feed?.openBinance) > 0
      ? pctMove(Number(tick.bz), Number(feed.openBinance)) * sign : 0,
    twapGap: Number(tick.cl) > 0 && Number(feed?.openPrice ?? feed?.openChainlink) > 0
      ? pctMove(Number(tick.cl), Number(feed.openPrice ?? feed.openChainlink)) * sign : 0,
    binanceTwapBasis: basisPct(tick) * sign,
  };
  for (const lookbackMs of [1_000, 3_000, 5_000, 15_000, 30_000, 60_000]) {
    const priorIndex = indexAtOrBefore(ticks, Number(tick.ms) - lookbackMs);
    const prior = priorIndex >= 0 ? ticks[priorIndex] : null;
    const priorAsk = bestAsk(prior, side), priorBid = bestBid(prior, side);
    raw[`askMove${lookbackMs}`] = priorAsk > 0 ? ask - priorAsk : 0;
    raw[`bidMove${lookbackMs}`] = priorBid > 0 ? bid - priorBid : 0;
    raw[`binanceMove${lookbackMs}`] = prior ? pctMove(Number(tick.bz), Number(prior.bz)) * sign : 0;
    raw[`twapMove${lookbackMs}`] = prior ? pctMove(Number(tick.cl), Number(prior.cl)) * sign : 0;
    raw[`basisMove${lookbackMs}`] = prior ? (basisPct(tick) - basisPct(prior)) * sign : 0;
    if (lookbackMs <= 5_000) {
      const priorBook = sideBook(prior, side);
      raw[`askDepth3Change${lookbackMs}`] = priorBook ? askDepth3 - depth(priorBook.asks, 3) : 0;
      raw[`bidDepth3Change${lookbackMs}`] = priorBook ? bidDepth3 - depth(priorBook.bids, 3) : 0;
    }
  }
  return { raw, vector: CAP_FEATURE_NAMES.map((name) => Number(raw[name]) || 0) };
}

export function scoreStandardizedLogistic(model, vector) {
  let logit = Number(model?.intercept || 0);
  const mean = model?.normalization?.mean || [], scale = model?.normalization?.scale || [];
  for (let index = 0; index < vector.length; index++) {
    logit += Number(model?.weights?.[index] || 0)
      * ((Number(vector[index]) || 0) - Number(mean[index] || 0)) / Math.max(EPS, Number(scale[index]) || 1);
  }
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}

function normalizeLevels(rows, side) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    price: Number(Array.isArray(row) ? row[0] : row?.price),
    size: Number(Array.isArray(row) ? row[1] : row?.size),
  })).filter((row) => row.price > 0 && row.price < 1 && row.size > 0)
    .sort((a, b) => side === "asks" ? a.price - b.price : b.price - a.price);
}

export function normalizeTick(tick) {
  const up = { asks: normalizeLevels(tick?.up?.asks, "asks"), bids: normalizeLevels(tick?.up?.bids, "bids") };
  const down = { asks: normalizeLevels(tick?.down?.asks, "asks"), bids: normalizeLevels(tick?.down?.bids, "bids") };
  return {
    ...tick,
    ms: Number(tick.ms),
    bz: finite(tick.bz) ? Number(tick.bz) : null,
    cl: finite(tick.cl) ? Number(tick.cl) : null,
    upAsk: finite(tick.upAsk) ? Number(tick.upAsk) : up.asks[0]?.price ?? null,
    dnAsk: finite(tick.dnAsk) ? Number(tick.dnAsk) : down.asks[0]?.price ?? null,
    up,
    down,
  };
}

function confidenceWeight(confidence) {
  return confidence === "high" ? 1 : confidence === "medium" ? 0.7 : 0.25;
}

function actionConfidence(rows) {
  if (rows.some((row) => row.confidence === "low")) return "low";
  if (rows.some((row) => row.confidence === "medium")) return "medium";
  return "high";
}

function groupActions(rows, clusterMs = 300) {
  const actions = [];
  let batch = [];
  const finish = () => {
    if (!batch.length) return;
    const confidence = actionConfidence(batch);
    const first = batch[0];
    actions.push({
      slug: first.slug,
      outcome: first.outcome,
      fireMs: Math.min(...batch.map((row) => row.fireMs)),
      intervalStartMs: Math.min(...batch.map((row) => row.intervalStartMs)),
      intervalEndMs: Math.max(...batch.map((row) => row.intervalEndMs)),
      confidence,
      weight: confidenceWeight(confidence),
      orderHashes: batch.map((row) => row.orderHash),
      orders: batch.length,
      signedShares: batch.reduce((sum, row) => sum + Number(row.signedShares), 0),
      signedBudgetUsd: batch.reduce((sum, row) => sum + Number(row.signedBudgetUsd), 0),
      filledShares: batch.reduce((sum, row) => sum + Number(row.filledShares), 0),
      filledUsd: batch.reduce((sum, row) => sum + Number(row.filledUsd), 0),
      feature: first.feature,
    });
    batch = [];
  };
  for (const row of [...rows].sort((a, b) => a.fireMs - b.fireMs || a.orderHash.localeCompare(b.orderHash))) {
    const prior = batch.at(-1);
    if (prior && (row.slug !== prior.slug || row.outcome !== prior.outcome || row.fireMs - prior.fireMs > clusterMs)) finish();
    batch.push(row);
  }
  finish();
  return actions;
}

function classifyActions(actions, winner) {
  let up = 0, down = 0;
  let lastFireMs = null;
  const out = [];
  for (const action of actions) {
    const beforeNet = up - down;
    const sign = action.outcome === "Up" ? 1 : -1;
    const beforeOriented = beforeNet * sign;
    if (action.outcome === "Up") up += action.filledShares;
    else down += action.filledShares;
    const afterNet = up - down;
    const afterOriented = afterNet * sign;
    const transition = Math.abs(beforeNet) <= EPS ? "entry"
      : beforeOriented >= -EPS ? "topup"
        : afterOriented > EPS ? "reversal" : "repair";
    out.push({
      ...action,
      tInto: (action.fireMs - startMs(action.slug)) / 1_000,
      transition,
      before: { upShares: round(up - (action.outcome === "Up" ? action.filledShares : 0)),
        downShares: round(down - (action.outcome === "Down" ? action.filledShares : 0)), net: round(beforeNet) },
      after: { upShares: round(up), downShares: round(down), net: round(afterNet) },
      beforeOriented: round(beforeOriented),
      afterOriented: round(afterOriented),
      won: winner === action.outcome,
      sinceLastFireMs: lastFireMs == null ? null : action.fireMs - lastFireMs,
    });
    lastFireMs = action.fireMs;
  }
  return out;
}

export function buildExactFireDataset({ collectionFile, signedOrdersFile, cacheDir, outputFile,
  minimumLastT = 298, clusterMs = 300 } = {}) {
  for (const [name, file] of Object.entries({ collectionFile, signedOrdersFile, cacheDir, outputFile })) {
    if (!file) throw new Error(`missing ${name}`);
  }
  const collection = JSON.parse(fs.readFileSync(collectionFile, "utf8"));
  const signed = readGzip(signedOrdersFile);
  const marketBySlug = new Map((collection.markets || []).map((market) => [market.slug, market]));
  const groupsBySlug = new Map();
  for (const group of signed.groups || []) {
    const slug = group.settlements?.[0]?.slug;
    if (!marketBySlug.has(slug)) continue;
    const rows = groupsBySlug.get(slug) || [];
    rows.push(group);
    groupsBySlug.set(slug, rows);
  }

  const orderRows = [], marketRows = [];
  let cachedMarkets = 0, completeMarkets = 0, tradedCompleteMarkets = 0, targetOrdersInCompleteMarkets = 0;
  for (const market of collection.markets || []) {
    const file = path.join(cacheDir, `${market.slug}_v2-l2-120-coherent.json.gz`);
    const marketGroups = groupsBySlug.get(market.slug) || [];
    if (!fs.existsSync(file)) {
      marketRows.push({ slug: market.slug, winner: market.winner, targetOrders: marketGroups.length,
        usable: false, error: "missing-cache" });
      continue;
    }
    cachedMarkets++;
    let feed;
    try { feed = readGzip(file); }
    catch {
      marketRows.push({ slug: market.slug, winner: market.winner, targetOrders: marketGroups.length,
        usable: false, error: "invalid-cache" });
      continue;
    }
    const ticks = (feed.ticks || []).map(normalizeTick).filter((tick) => Number.isFinite(tick.ms));
    const lastT = ticks.length ? (ticks.at(-1).ms - startMs(market.slug)) / 1_000 : null;
    if (!(lastT >= minimumLastT) || !market.winner) {
      marketRows.push({ slug: market.slug, winner: market.winner, targetOrders: marketGroups.length,
        ticks: ticks.length, lastT: round(lastT, 3), usable: false,
        error: !market.winner ? "unresolved" : "incomplete-cache" });
      continue;
    }
    completeMarkets++;
    targetOrdersInCompleteMarkets += marketGroups.length;
    if (marketGroups.length) tradedCompleteMarkets++;
    let inferred = 0;
    for (const group of marketGroups) {
      const fire = inferGroupedOrderFire(ticks, group);
      if (!fire) continue;
      inferred++;
      orderRows.push({
        orderHash: group.orderHash,
        slug: market.slug,
        outcome: group.settlements[0].outcome,
        limitPrice: Number(group.limitPrice),
        signedShares: Number(group.signedShares),
        signedBudgetUsd: Number(group.signedBudgetUsd),
        signedTimestampMs: Number(group.signedTimestampMs),
        firstPublicTs: Number(group.firstPublicTs),
        filledShares: Number(group.filledShares),
        filledUsd: Number(group.filledUsd),
        ...fire,
        feature: featuresAtFire(ticks, fire.intervalStartMs, group,
          Number(feed.openBinance), Number(feed.openPrice ?? feed.openChainlink)),
      });
    }
    marketRows.push({ slug: market.slug, winner: market.winner, targetOrders: marketGroups.length,
      inferredOrders: inferred, ticks: ticks.length, lastT: round(lastT, 3), usable: true });
  }

  const actionsBySlug = new Map();
  for (const action of groupActions(orderRows, clusterMs)) {
    const rows = actionsBySlug.get(action.slug) || [];
    rows.push(action);
    actionsBySlug.set(action.slug, rows);
  }
  const actions = [];
  for (const [slug, rows] of actionsBySlug) {
    actions.push(...classifyActions(rows.sort((a, b) => a.fireMs - b.fireMs), marketBySlug.get(slug)?.winner));
  }
  actions.sort((a, b) => a.fireMs - b.fireMs || a.slug.localeCompare(b.slug));

  const confidence = Object.fromEntries(["high", "medium", "low"].map((level) =>
    [level, orderRows.filter((row) => row.confidence === level).length]));
  const transitions = Object.fromEntries(["entry", "topup", "repair", "reversal"].map((role) =>
    [role, actions.filter((row) => row.transition === role).length]));
  const summary = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    range: { from: collection.from, to: collection.to },
    inputs: {
      collectionFile: path.resolve(collectionFile), collectionSha256: sha256(collectionFile),
      signedOrdersFile: path.resolve(signedOrdersFile), signedOrdersSha256: sha256(signedOrdersFile),
      cacheDir: path.resolve(cacheDir),
    },
    definition: "Signed target BUY orders ordered and clustered by independently inferred pre/post CLOB consumption intervals; public timestamps are search anchors only.",
    coverage: {
      expectedMarkets: collection.markets?.length || 0,
      cachedMarkets, completeMarkets, tradedCompleteMarkets,
      completePct: round(100 * completeMarkets / Math.max(1, collection.markets?.length || 0), 3),
      targetOrders: signed.groups?.length || 0,
      targetOrdersInCompleteMarkets,
      inferredOrders: orderRows.length,
      inferredOrderPct: round(100 * orderRows.length / Math.max(1, targetOrdersInCompleteMarkets), 3),
    },
    confidence,
    actions: actions.length,
    transitions,
    ambiguousActions: actions.filter((row) => row.confidence === "low").length,
    clusterMs,
    minimumLastT,
  };
  const payload = { schema: 1, summary, markets: marketRows, orders: orderRows, actions };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify(payload), { level: 9 }));
  fs.writeFileSync(outputFile.replace(/\.json\.gz$/i, "-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
