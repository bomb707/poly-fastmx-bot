#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups;
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows;
const fireByHash = new Map(fires.map((row) => [row.orderHash, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const q = (values, ps = [0, .1, .25, .5, .75, .9, .99, 1]) => Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, quantile(values.filter(finite), p)]));
const pct = (n, d) => d ? +(n / d * 100).toFixed(3) : null;
const dayOf = (group) => new Date(Number(group.settlements[0].slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10);

const bySlug = new Map();
for (const group of signed) {
  const slug = group.settlements[0]?.slug;
  if (!slug) continue;
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(group);
}

const pairs = [];
for (const [slug, groups] of bySlug) {
  groups.sort((a, b) => a.signedTimestampMs - b.signedTimestampMs || a.orderHash.localeCompare(b.orderHash));
  const edges = [];
  const candidateCounts = new Map();
  for (let left = 0; left < groups.length; left++) {
    for (let right = left + 1; right < groups.length && groups[right].signedTimestampMs - groups[left].signedTimestampMs <= 500; right++) {
      const a = groups[left], b = groups[right];
      if (a.settlements[0].outcome === b.settlements[0].outcome || Number(a.signedShares) !== Number(b.signedShares)) continue;
      edges.push({ a, b, constructionGapMs: b.signedTimestampMs - a.signedTimestampMs, sumDistance: Math.abs(Number(a.limitPrice) + Number(b.limitPrice) - 1) });
      candidateCounts.set(a.orderHash, (candidateCounts.get(a.orderHash) || 0) + 1);
      candidateCounts.set(b.orderHash, (candidateCounts.get(b.orderHash) || 0) + 1);
    }
  }
  edges.sort((x, y) => x.constructionGapMs - y.constructionGapMs || x.sumDistance - y.sumDistance);
  const used = new Set();
  for (const edge of edges) {
    if (used.has(edge.a.orderHash) || used.has(edge.b.orderHash)) continue;
    used.add(edge.a.orderHash); used.add(edge.b.orderHash);
    const fireA = fireByHash.get(edge.a.orderHash), fireB = fireByHash.get(edge.b.orderHash);
    let first = null, second = null;
    if (fireA && fireB) [first, second] = fireA.fireMs <= fireB.fireMs ? [[edge.a, fireA], [edge.b, fireB]] : [[edge.b, fireB], [edge.a, fireA]];
    const sharedFilledShares = Math.min(Number(edge.a.filledShares) || 0, Number(edge.b.filledShares) || 0);
    pairs.push({
      slug,
      day: dayOf(edge.a),
      constructionGapMs: edge.constructionGapMs,
      aCandidateMates: candidateCounts.get(edge.a.orderHash) || 0,
      bCandidateMates: candidateCounts.get(edge.b.orderHash) || 0,
      unambiguousConstructionPair: candidateCounts.get(edge.a.orderHash) === 1 && candidateCounts.get(edge.b.orderHash) === 1,
      aHash: edge.a.orderHash,
      bHash: edge.b.orderHash,
      signedShares: edge.a.signedShares,
      aOutcome: edge.a.settlements[0].outcome,
      bOutcome: edge.b.settlements[0].outcome,
      aLimit: edge.a.limitPrice,
      bLimit: edge.b.limitPrice,
      signedLimitSum: Number(edge.a.limitPrice) + Number(edge.b.limitPrice),
      aFilledShares: edge.a.filledShares,
      bFilledShares: edge.b.filledShares,
      sharedFilledShares,
      realizedPairCost: finite(edge.a.vwap) && finite(edge.b.vwap) ? Number(edge.a.vwap) + Number(edge.b.vwap) : null,
      bothFireInferred: !!(fireA && fireB),
      bothHighMedium: !!(fireA && fireB && fireA.confidence !== "low" && fireB.confidence !== "low"),
      ...(first && second ? {
        firstHash: first[0].orderHash,
        secondHash: second[0].orderHash,
        firstOutcome: first[0].settlements[0].outcome,
        secondOutcome: second[0].settlements[0].outcome,
        firstFireMs: first[1].fireMs,
        secondFireMs: second[1].fireMs,
        fireDelayMs: second[1].fireMs - first[1].fireMs,
        firstLimit: first[0].limitPrice,
        secondLimit: second[0].limitPrice,
        firstFillVwap: first[0].vwap,
        secondFillVwap: second[0].vwap,
        hedgePairAsk: finite(first[0].vwap) && finite(second[1].beforeBestAsk) ? Number(first[0].vwap) + Number(second[1].beforeBestAsk) : null,
        firstFeature: first[1].v2Feature,
        secondFeature: second[1].v2Feature,
      } : {}),
    });
  }
}

const exact = pairs.filter((pair) => pair.bothHighMedium);
const unambiguous = exact.filter((pair) => pair.unambiguousConstructionPair);
const current = exact.filter((pair) => pair.day >= "2026-08-19");
const signalAlignment = (rows, prefix) => {
  const out = {};
  for (const field of ["clobUpMove1", "clobUpMove3", "clobUpMove5", "bzMom1", "bzMom3", "bzMom5", "clMom1", "clMom3", "clMom5", "bzGapPct", "clGapPct"]) {
    const values = rows.map((row) => {
      const feature = row[`${prefix}Feature`];
      const outcome = row[`${prefix}Outcome`];
      return finite(feature?.[field]) ? Number(feature[field]) * (outcome === "Up" ? 1 : -1) : null;
    }).filter(finite);
    out[field] = {
      n: values.length,
      followsPct: pct(values.filter((value) => value > 1e-12).length, values.length),
      fadesPct: pct(values.filter((value) => value < -1e-12).length, values.length),
      zeroPct: pct(values.filter((value) => Math.abs(value) <= 1e-12).length, values.length),
      q: q(values, [.1, .25, .5, .75, .9]),
    };
  }
  return out;
};
const modes = (values) => Object.fromEntries([...values.reduce((map, value) => {
  const key = Number(value).toFixed(2);
  map.set(key, (map.get(key) || 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 15));

const byDay = {};
for (const day of [...new Set(exact.map((pair) => pair.day))].sort()) {
  const rows = exact.filter((pair) => pair.day === day);
  byDay[day] = {
    pairs: rows.length,
    signedSizeModes: modes(rows.map((pair) => pair.signedShares)),
    limitSum: q(rows.map((pair) => pair.signedLimitSum), [.1, .25, .5, .75, .9]),
    fireDelayMs: q(rows.map((pair) => pair.fireDelayMs), [.1, .25, .5, .75, .9]),
    simultaneous300msPct: pct(rows.filter((pair) => pair.fireDelayMs <= 300).length, rows.length),
  };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  method: "heuristic greedy minimum signed-construction gap, opposite outcome, identical signed size, <=500ms; only pairs with one possible mate per order are unambiguous; signed timestamp is never used as fire time",
  signedOrders: signed.length,
  constructionPairs: pairs.length,
  ordersCoveredPct: pct(pairs.length * 2, signed.length),
  bothFireInferred: pairs.filter((pair) => pair.bothFireInferred).length,
  bothHighMedium: exact.length,
  unambiguousBothHighMedium: unambiguous.length,
  unambiguousPct: pct(unambiguous.length, exact.length),
  unambiguous: {
    signedLimitSum: q(unambiguous.map((pair) => pair.signedLimitSum)),
    fireDelayMs: q(unambiguous.map((pair) => pair.fireDelayMs)),
    hedgePairAsk: q(unambiguous.map((pair) => pair.hedgePairAsk)),
    realizedPairCost: q(unambiguous.map((pair) => pair.realizedPairCost)),
  },
  constructionGapMs: q(pairs.map((pair) => pair.constructionGapMs)),
  signedLimitSum: q(pairs.map((pair) => pair.signedLimitSum)),
  signedLimitSumModes: modes(pairs.map((pair) => pair.signedLimitSum)),
  fireDelayMs: q(exact.map((pair) => pair.fireDelayMs)),
  simultaneous300msPct: pct(exact.filter((pair) => pair.fireDelayMs <= 300).length, exact.length),
  within3sPct: pct(exact.filter((pair) => pair.fireDelayMs <= 3_000).length, exact.length),
  within10sPct: pct(exact.filter((pair) => pair.fireDelayMs <= 10_000).length, exact.length),
  hedgePairAsk: q(exact.map((pair) => pair.hedgePairAsk)),
  realizedPairCost: q(exact.map((pair) => pair.realizedPairCost)),
  realizedAtMost1Pct: pct(exact.filter((pair) => finite(pair.realizedPairCost) && pair.realizedPairCost <= 1 + 1e-9).length, exact.filter((pair) => finite(pair.realizedPairCost)).length),
  currentRegime: {
    pairs: current.length,
    signedLimitSum: q(current.map((pair) => pair.signedLimitSum)),
    fireDelayMs: q(current.map((pair) => pair.fireDelayMs)),
    hedgePairAsk: q(current.map((pair) => pair.hedgePairAsk)),
    firstSignal: signalAlignment(current, "first"),
    secondSignal: signalAlignment(current, "second"),
  },
  byDay,
};
fs.writeFileSync(path.join(dataDir, "template-cycles.json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(path.join(dataDir, "template-cycle-pairs.json.gz"), zlib.gzipSync(JSON.stringify({ schema: 1, report, pairs }), { level: 9 }));
console.log(JSON.stringify(report, null, 2));
