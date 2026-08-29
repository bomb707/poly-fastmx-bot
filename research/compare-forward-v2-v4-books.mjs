#!/usr/bin/env node
/** Compare contemporaneous native-v2 and v4 CLOB states used by forward paper replay. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const v2Dir = path.resolve(process.argv[2] || "data/passive-maker-forward-v15/feeds/v2-l2");
const v4Dir = path.resolve(process.argv[3] || "data/passive-maker-forward-v15/feeds/v4-l2");
const output = path.resolve(process.argv[4] || "data/research/forward-v2-v4-book-comparison.json");
const fromMs = Date.parse(process.argv[5] || "2026-08-24T23:50:00Z");
const toMs = Date.parse(process.argv[6] || new Date().toISOString());
const pairCap = Number(process.env.BOOK_COMPARE_PAIR_CAP || .94);
const bucketMs = Math.max(50, Number(process.env.BOOK_COMPARE_BUCKET_MS || 250));
const maxAgeMs = Math.max(0, Number(process.env.BOOK_COMPARE_MAX_AGE_MS || 250));
const read = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;
const quantile = (values, probability) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const quantiles = (values) => Object.fromEntries([["p10", .1], ["p25", .25], ["p50", .5], ["p75", .75], ["p90", .9], ["p99", .99]]
  .map(([name, probability]) => [name, round(quantile(values, probability))]));
const slugStart = (slug) => Number(slug.split("-").at(-1)) * 1000;
const levels = (tick, side, branch) => (tick?.[String(side).toLowerCase()]?.[branch] || []).map((row) => ({ price: Number(row.price), size: Number(row.size) }))
  .filter((row) => row.price > 0 && row.price < 1 && row.size > 0)
  .sort((a, b) => branch === "asks" ? a.price - b.price : b.price - a.price);
const best = (tick, side, branch) => levels(tick, side, branch)[0] || null;
const pairBid = (tick) => Number(best(tick, "Up", "bids")?.price) + Number(best(tick, "Down", "bids")?.price);
const files = fs.readdirSync(v4Dir).filter((name) => name.endsWith(".json.gz") && fs.existsSync(path.join(v2Dir, name)))
  .map((name) => ({ name, slug: name.slice(0, -8) })).filter((row) => slugStart(row.slug) >= fromMs && slugStart(row.slug) < toMs)
  .sort((a, b) => slugStart(a.slug) - slugStart(b.slug));

const rows = [], age = [], pairDelta = [], topSizeRatios = [];
let matched = 0, priceAgreement = 0, classificationAgreement = 0, v2Eligible = 0, v4Eligible = 0;
let v2OnlyEligible = 0, v4OnlyEligible = 0, bothEligible = 0, neitherEligible = 0;
for (const { name, slug } of files) {
  const v2 = read(path.join(v2Dir, name)), v4 = read(path.join(v4Dir, name));
  const a = (v2.ticks || []).sort((x, y) => Number(x.ms) - Number(y.ms));
  const b = (v4.ticks || []).sort((x, y) => Number(x.ms) - Number(y.ms));
  let cursor = -1, lastBucket = -1;
  const local = { slug, samples: 0, priceAgreement: 0, classificationAgreement: 0, v2Eligible: 0, v4Eligible: 0,
    v2OnlyEligible: 0, v4OnlyEligible: 0, bothEligible: 0, neitherEligible: 0, pairDelta: [] };
  for (const tick4 of b) {
    const bucket = Math.floor((Number(tick4.ms) - slugStart(slug)) / bucketMs);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    while (cursor + 1 < a.length && Number(a[cursor + 1].ms) <= Number(tick4.ms)) cursor++;
    if (cursor < 0) continue;
    const tick2 = a[cursor], tickAge = Number(tick4.ms) - Number(tick2.ms);
    if (tickAge < 0 || tickAge > maxAgeMs) continue;
    const p2 = pairBid(tick2), p4 = pairBid(tick4);
    if (!Number.isFinite(p2) || !Number.isFinite(p4)) continue;
    const eligible2 = p2 <= pairCap + 1e-9, eligible4 = p4 <= pairCap + 1e-9;
    const samePrices = ["Up", "Down"].every((side) => ["bids", "asks"].every((branch) =>
      Math.abs(Number(best(tick2, side, branch)?.price) - Number(best(tick4, side, branch)?.price)) < .005));
    matched++; local.samples++; age.push(tickAge); pairDelta.push(p4 - p2); local.pairDelta.push(p4 - p2);
    priceAgreement += samePrices; local.priceAgreement += samePrices;
    classificationAgreement += eligible2 === eligible4; local.classificationAgreement += eligible2 === eligible4;
    v2Eligible += eligible2; v4Eligible += eligible4; local.v2Eligible += eligible2; local.v4Eligible += eligible4;
    if (eligible2 && eligible4) { bothEligible++; local.bothEligible++; }
    else if (eligible2) { v2OnlyEligible++; local.v2OnlyEligible++; }
    else if (eligible4) { v4OnlyEligible++; local.v4OnlyEligible++; }
    else { neitherEligible++; local.neitherEligible++; }
    for (const side of ["Up", "Down"]) for (const branch of ["bids", "asks"]) {
      const s2 = Number(best(tick2, side, branch)?.size), s4 = Number(best(tick4, side, branch)?.size);
      if (s2 > 0 && s4 > 0) topSizeRatios.push(s4 / s2);
    }
  }
  rows.push({ ...local, priceAgreementPct: pct(local.priceAgreement, local.samples),
    classificationAgreementPct: pct(local.classificationAgreement, local.samples),
    v2EligiblePct: pct(local.v2Eligible, local.samples), v4EligiblePct: pct(local.v4Eligible, local.samples),
    v4OnlyEligiblePct: pct(local.v4OnlyEligible, local.samples), pairDelta: quantiles(local.pairDelta) });
}

const result = {
  schema: 1, generatedAt: new Date().toISOString(), range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  pairCap, bucketMs, maxAgeMs, files: files.length, matched,
  summary: { priceAgreementPct: pct(priceAgreement, matched), classificationAgreementPct: pct(classificationAgreement, matched),
    v2EligiblePct: pct(v2Eligible, matched), v4EligiblePct: pct(v4Eligible, matched), bothEligible, v2OnlyEligible, v4OnlyEligible,
    neitherEligible, v4OnlyEligiblePct: pct(v4OnlyEligible, matched), matchedTickAgeMs: quantiles(age),
    v4MinusV2PairBid: quantiles(pairDelta), v4OverV2TopSizeRatio: quantiles(topSizeRatios) },
  worstV4OnlyEligibility: [...rows].sort((a, b) => b.v4OnlyEligiblePct - a.v4OnlyEligiblePct).slice(0, 30),
  rows,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output, ...result.summary }, null, 2));
