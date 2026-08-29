#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-3048/signal-alignment.json.gz"));
const outDir = path.resolve(process.argv[3] || path.join(ROOT, "data/wallet-3048"));
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(input)));
const rows = data.rows;
const round = (n, digits = 6) => Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
const q = (values) => {
  const clean = values.filter(Number.isFinite);
  return Object.fromEntries([["min", 0], ["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9], ["max", 1]].map(([key, p]) => [key, round(quantile(clean, p))]));
};

const bySlug = new Map();
for (const row of rows) {
  if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
  bySlug.get(row.slug).push(row);
}
for (const group of bySlug.values()) {
  group.sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
  let up = 0, down = 0;
  for (let index = 0; index < group.length; index++) {
    const row = group[index];
    const oppositeImbalance = row.outcome === "Up" ? down - up : up - down;
    row.inventoryClass = index === 0 ? "first" : oppositeImbalance > 1e-9 ? "hedge" : "add";
    row.hedgeShares = Math.max(0, Math.min(row.shares, oppositeImbalance));
    row.overbuyShares = oppositeImbalance > 0 ? Math.max(0, row.shares - oppositeImbalance) : 0;
    if (row.outcome === "Up") up += row.shares; else down += row.shares;
  }
}

function alignment(subset, source, field) {
  const usable = subset.filter((row) => Number.isFinite(row[source]?.[field]) && Math.abs(row[source][field]) > 1e-12);
  let correct = 0, correctShares = 0, shares = 0;
  for (const row of usable) {
    const aligned = (row.outcome === "Up" ? 1 : -1) * row[source][field] > 0;
    if (aligned) { correct++; correctShares += row.shares; }
    shares += row.shares;
  }
  return { n: usable.length, countPct: pct(correct, usable.length), shareWeightedPct: pct(correctShares, shares) };
}

function signalTable(subset, source) {
  const prefix = source === "v2" ? ["bzGap", "clGap"] : ["bzGap"];
  const momentum = [1, 3, 5, 10, 15, 30, 60].flatMap((seconds) => source === "v2"
    ? [`bzMom${seconds}`, `clMom${seconds}`, `clobMom${seconds}`]
    : [`bzMom${seconds}`, `clobMom${seconds}`]);
  return Object.fromEntries([...prefix, ...momentum].map((field) => [field, alignment(subset, source, field)]));
}

const subsets = {
  all: rows,
  first: rows.filter((row) => row.inventoryClass === "first"),
  add: rows.filter((row) => row.inventoryClass === "add"),
  hedge: rows.filter((row) => row.inventoryClass === "hedge"),
  taker: rows.filter((row) => row.role === "taker"),
  maker: rows.filter((row) => row.role === "maker"),
};

const signals = Object.fromEntries(Object.entries(subsets).map(([name, subset]) => [name, {
  rows: subset.length,
  v4: signalTable(subset, "v4"),
  v2: signalTable(subset, "v2"),
}]));

const v2Rows = rows.filter((row) => row.v2);
const disagreement = v2Rows.filter((row) => Number.isFinite(row.v2.bzMom5) && Number.isFinite(row.v2.clMom5)
  && Math.abs(row.v2.bzMom5) > 1e-12 && Math.abs(row.v2.clMom5) > 1e-12
  && Math.sign(row.v2.bzMom5) !== Math.sign(row.v2.clMom5));
const orderWithBinance = disagreement.filter((row) => (row.outcome === "Up" ? 1 : -1) * row.v2.bzMom5 > 0);

const openComparisons = [];
for (const slug of data.sampling.v2Windows) {
  try {
    const v2 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(outDir, "feeds/v2", `${slug}.json.gz`))));
    const v4 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(outDir, "feeds/v4", `${slug}.json.gz`))));
    openComparisons.push({ slug, v2Twap60: v2.openChainlink, v4Start: v4.openChainlink, difference: v2.openChainlink - v4.openChainlink });
  } catch {}
}

const takerFire = rows.filter((row) => row.fire?.kind === "taker");
const makerPlacement = rows.filter((row) => row.fire?.kind === "maker");
const reliableTaker = takerFire.filter((row) => row.fire.confidence === "high" || row.fire.confidence === "medium");
const confidenceCounts = (items) => Object.fromEntries([...new Set(items.map((row) => row.fire.confidence))].sort().map((confidence) => [confidence, items.filter((row) => row.fire.confidence === confidence).length]));
const fireSignalRows = reliableTaker.map((row) => ({ ...row, inferred: row.fire.feature }));
const fireV2SignalRows = reliableTaker.filter((row) => row.fire.v2Feature).map((row) => ({ ...row, inferredV2: row.fire.v2Feature }));

function hybridStats(maxSeconds) {
  let candidateMakers = 0, candidateMakerShares = 0, allMakerShares = 0;
  let candidateTakers = 0;
  for (const group of bySlug.values()) {
    const makers = group.filter((row) => row.role === "maker");
    const takers = group.filter((row) => row.role === "taker");
    for (const maker of makers) {
      allMakerShares += maker.shares;
      const prior = takers.some((taker) => taker.outcome === maker.outcome
        && maker.timestamp >= taker.timestamp && maker.timestamp - taker.timestamp <= maxSeconds
        && Math.abs(maker.vwap - taker.maxPrice) <= .011);
      if (prior) { candidateMakers++; candidateMakerShares += maker.shares; }
    }
    for (const taker of takers) {
      if (makers.some((maker) => maker.outcome === taker.outcome
        && maker.timestamp >= taker.timestamp && maker.timestamp - taker.timestamp <= maxSeconds
        && Math.abs(maker.vwap - taker.maxPrice) <= .011)) candidateTakers++;
    }
  }
  return {
    seconds: maxSeconds,
    makerBurstsCompatible: candidateMakers,
    makerBurstPct: pct(candidateMakers, subsets.maker.length),
    makerSharePct: pct(candidateMakerShares, allMakerShares),
    takerBurstsWithLaterCompatibleMaker: candidateTakers,
    takerBurstPct: pct(candidateTakers, subsets.taker.length),
  };
}

const byDay = [...new Set(rows.map((row) => new Date(row.timestamp * 1000).toISOString().slice(0, 10)))].sort().map((day) => {
  const subset = rows.filter((row) => new Date(row.timestamp * 1000).toISOString().slice(0, 10) === day);
  return {
    day,
    rows: subset.length,
    makerPct: pct(subset.filter((row) => row.role === "maker").length, subset.length),
    binanceGapAlignment: alignment(subset, "v4", "bzGap"),
    binanceMom3Alignment: alignment(subset, "v4", "bzMom3"),
    binanceMom5Alignment: alignment(subset, "v4", "bzMom5"),
  };
});

const result = {
  schema: 1,
  source: { input, rows: rows.length, v4Windows: data.sampling.allV4Windows, v2Windows: data.sampling.v2Windows.length, l2Windows: data.sampling.l2Windows.length },
  signals,
  disagreement: {
    binanceVsChainlinkMom5Rows: disagreement.length,
    orderAlignedWithBinance: orderWithBinance.length,
    orderAlignedWithBinancePct: pct(orderWithBinance.length, disagreement.length),
    orderAlignedWithChainlinkPct: pct(disagreement.length - orderWithBinance.length, disagreement.length),
  },
  chainlinkOpen: {
    comparedWindows: openComparisons.length,
    v2Twap60MinusV4Start: q(openComparisons.map((row) => row.difference)),
    materiallyDifferentPct: pct(openComparisons.filter((row) => Math.abs(row.difference) > .01).length, openComparisons.length),
    interpretation: "v2 openPrice is the RTDS TWAP-60 window open; v4 coinPriceStart is a start snapshot and is not interchangeable",
  },
  orderTiming: {
    takerInferences: takerFire.length,
    takerConfidence: confidenceCounts(takerFire),
    reliableTakerInferences: reliableTaker.length,
    reliableTakerLeadMs: q(reliableTaker.map((row) => row.fire.leadMs)),
    reliableTakerBookScore: q(reliableTaker.map((row) => row.fire.bookScore)),
    reliableTakerConsumptionMiss: q(reliableTaker.map((row) => row.fire.consumptionMiss)),
    inferredFireSignals: {
      binanceGap: alignment(fireSignalRows, "inferred", "bzGap"),
      binanceMom1: alignment(fireSignalRows, "inferred", "bzMom1"),
      binanceMom3: alignment(fireSignalRows, "inferred", "bzMom3"),
      binanceMom5: alignment(fireSignalRows, "inferred", "bzMom5"),
      clobMom1: alignment(fireSignalRows, "inferred", "clobMom1"),
      clobMom3: alignment(fireSignalRows, "inferred", "clobMom3"),
      clobMom5: alignment(fireSignalRows, "inferred", "clobMom5"),
      v2BinanceMom5: alignment(fireV2SignalRows, "inferredV2", "bzMom5"),
      v2ChainlinkGap: alignment(fireV2SignalRows, "inferredV2", "clGap"),
      v2ChainlinkMom3: alignment(fireV2SignalRows, "inferredV2", "clMom3"),
      v2ChainlinkMom5: alignment(fireV2SignalRows, "inferredV2", "clMom5"),
    },
    makerPlacements: makerPlacement.length,
    makerConfidence: confidenceCounts(makerPlacement),
    makerPlacementLeadMs: q(makerPlacement.map((row) => row.fire.leadMs)),
    makerDepthAdded: q(makerPlacement.map((row) => row.fire.depthAdded)),
  },
  clob: {
    observedVwapMinusV4SideAsk: {
      taker: q(subsets.taker.map((row) => row.v4?.askDistance)),
      maker: q(subsets.maker.map((row) => row.v4?.askDistance)),
    },
    inferredTakerVwapMinusBestAsk: q(reliableTaker.map((row) => row.vwap - row.fire.bestAsk)),
    inferredTakerWalkCompletePct: pct(reliableTaker.filter((row) => row.fire.walked?.complete).length, reliableTaker.length),
    hybridGtcCompatibility: [hybridStats(3), hybridStats(10), hybridStats(30)],
  },
  daily: byDay,
};

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "signal-analysis.json");
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");
const mdPath = path.join(outDir, "signal-analysis.md");
const md = `# Wallet 0x3048 signal and order-timing analysis\n\n` +
`All ${rows.length.toLocaleString()} fill bursts were aligned to v4 Binance/CLOB ticks. Chainlink RTDS was evaluated on ${v2Rows.length.toLocaleString()} fills across ${data.sampling.v2Windows.length} stratified windows; full L2 fire/placement inference used ${data.sampling.l2Windows.length} windows.\n\n` +
`## Findings\n\n` +
`- First orders align with Binance 5-second momentum ${signals.first.v4.bzMom5.countPct}% of the time; inventory-adding orders align ${signals.add.v4.bzMom5.countPct}%. The unconditional Binance window gap is near chance (${signals.all.v4.bzGap.countPct}%).\n` +
`- At the later public timestamp, first orders align with CLOB 5-second movement ${signals.first.v4.clobMom5.countPct}% of the time. At the inferred pre-consumption fire tick, CLOB 5-second alignment is only ${result.orderTiming.inferredFireSignals.clobMom5.countPct}%; match-time momentum is contaminated by settlement lag and the fill's book impact.\n` +
`- Chainlink 5-second momentum is near chance across all sampled fills (${signals.all.v2.clMom5.countPct}%), while first orders show ${signals.first.v2.clMom5.countPct}% alignment. This supports Chainlink/TWAP as a window reference and secondary confirmation, not the fast trigger.\n` +
`- When Binance and Chainlink 5-second directions disagree, the bought side follows Binance ${result.disagreement.orderAlignedWithBinancePct}% of the time.\n` +
`- v2 TWAP-60 opens differ materially from v4 start snapshots in ${result.chainlinkOpen.materiallyDifferentPct}% of compared windows (median difference $${result.chainlinkOpen.v2Twap60MinusV4Start.median}). They must not be substituted.\n` +
`- ${reliableTaker.length} taker fire times passed high/medium L2 matching. Median inferred lead over the public match timestamp is ${result.orderTiming.reliableTakerLeadMs.median}ms (p10 ${result.orderTiming.reliableTakerLeadMs.p10}ms, p90 ${result.orderTiming.reliableTakerLeadMs.p90}ms).\n` +
`- ${makerPlacement.length} passive placements were detectable as bid-depth additions; median detected lead is ${result.orderTiming.makerPlacementLeadMs.median}ms. Aggregated books cannot prove which cancellation belongs to this wallet.\n` +
`- Within 10 seconds, ${result.clob.hybridGtcCompatibility[1].makerBurstPct}% of maker bursts have a compatible earlier same-side/same-cap taker burst. This is consistent with marketable GTC (postOnly=false) taking immediately and leaving a resting remainder, but public data cannot prove the time-in-force flag.\n\n` +
`## Limits\n\nPublic Data API timestamps are settlement/match anchors, not submit times. L2 attribution is probabilistic because books aggregate every participant and can replenish between snapshots. “Compatible” order behavior is evidence, not access to the wallet's private signed order or live config.\n`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ jsonPath, mdPath, result }, null, 2));
