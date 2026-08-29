#!/usr/bin/env node
/** Descriptive loss attribution for exactly reproduced frozen-v17 replays. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = {
  detailV2: path.resolve(process.argv[2] || path.join(ROOT, "data/research/passive-maker-v18-momentum-v2.json")),
  detailV4: path.resolve(process.argv[3] || path.join(ROOT, "data/research/passive-maker-v18-momentum-v4.json")),
  frozenV2: path.resolve(process.argv[4] || path.join(ROOT, "data/research/passive-maker-v17-selected-v2.json")),
  frozenV4: path.resolve(process.argv[5] || path.join(ROOT, "data/research/passive-maker-v17-selected-v4.json")),
  output: path.resolve(process.argv[6] || path.join(ROOT, "data/research/passive-maker-v17-loss-attribution.json")),
};

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const firstDiagnostic = (report) => Object.values(report.diagnostics || {})[0];
const active = (row) => Number(row.makerShares || 0) + Number(row.takerShares || 0) > 1e-9;
const REPRODUCTION_FIELDS = ["windows", "activeWindows", "placements", "cancels", "makerFillEvents", "takerFillEvents",
  "grossBuySpend", "pnl", "pairedPnl", "residualPnl", "maxDrawdown", "profitFactor",
  "bootstrapWindowLower95", "bootstrapDayLower95"];

function reproduce(detail, frozen, source) {
  const expected = firstDiagnostic(frozen);
  const matches = Object.entries(detail.diagnostics || {}).filter(([, entry]) => REPRODUCTION_FIELDS
    .every((field) => (entry?.[field] ?? null) === (expected?.[field] ?? null)));
  const [matchedPolicy, actual] = matches[0] || [];
  const fieldChecks = Object.fromEntries(REPRODUCTION_FIELDS.map((field) => [field, {
    expected: expected?.[field] ?? null,
    actual: actual?.[field] ?? null,
    matches: (expected?.[field] ?? null) === (actual?.[field] ?? null),
  }]));
  const requirements = {
    identicalRange: JSON.stringify(detail.range) === JSON.stringify(frozen.range),
    exactlyOneReproducingDetailPolicy: matches.length === 1,
    everySummaryFieldExact: Object.values(fieldChecks).every((check) => check.matches),
    windowDetailsPresent: Array.isArray(actual?.windowsDetail) && actual.windowsDetail.length === Number(actual.windows),
  };
  return { source, matchedPolicy, fieldChecks, requirements, passed: Object.values(requirements).every(Boolean) };
}

function summarize(rows) {
  let equity = 0, peak = 0, drawdown = 0, wins = 0, losses = 0;
  for (const row of rows.sort((a, b) => a.startMs - b.startMs)) {
    const pnl = Number(row.pnl || 0);
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
    if (pnl > 0) wins += pnl;
    else losses -= pnl;
  }
  const spend = rows.reduce((sum, row) => sum + Number(row.grossBuySpend || 0), 0);
  const pnl = rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  return {
    windows: rows.length,
    wins: rows.filter((row) => Number(row.pnl) > 0).length,
    losses: rows.filter((row) => Number(row.pnl) < 0).length,
    spend: round(spend),
    pnl: round(pnl),
    roiPct: spend > 0 ? round(pnl / spend * 100) : null,
    profitFactor: losses > 1e-9 ? round(wins / losses) : wins > 0 ? null : 0,
    maxDrawdown: round(drawdown),
  };
}

function group(rows, classifier) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(classifier(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarize(values)]));
}

function band(value, cuts, labels) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "unavailable";
  const index = cuts.findIndex((cut) => n < cut);
  return labels[index < 0 ? labels.length - 1 : index];
}

function signalAgreement(row) {
  const direction = row.firstMakerSide === "Down" ? -1 : row.firstMakerSide === "Up" ? 1 : 0;
  const chainlink = Number(row.firstMakerClGapPct) * direction;
  const binance = Number(row.firstMakerBzGapPct) * direction;
  if (!Number.isFinite(chainlink) || !Number.isFinite(binance) || !direction) return "unavailable";
  if (chainlink > 0 && binance > 0) return "both-support-fill-side";
  if (chainlink < 0 && binance < 0) return "both-oppose-fill-side";
  if (chainlink >= 0 && binance <= 0) return "chainlink-only";
  return "binance-only";
}

function sourceAttribution(entry) {
  const allRows = entry.windowsDetail;
  const rows = allRows.filter(active);
  const losing = rows.filter((row) => Number(row.pnl) < 0);
  const topLosses = [...losing].sort((a, b) => Number(a.pnl) - Number(b.pnl)).slice(0, 20).map((row) => ({
    slug: row.slug,
    start: new Date(row.startMs).toISOString(),
    winner: row.winner,
    pnl: round(Number(row.pnl)),
    spend: round(Number(row.grossBuySpend)),
    makerShares: round(Number(row.makerShares)),
    up: round(Number(row.up)),
    down: round(Number(row.down)),
    firstMakerFillT: row.firstMakerFillT,
    firstMakerSide: row.firstMakerSide,
    firstMakerPrice: row.firstMakerPrice,
    firstMakerRole: row.firstMakerRole,
    firstMakerExpectedEdge: row.firstMakerExpectedEdge,
    firstMakerFairProbability: row.firstMakerFairProbability,
    firstMakerMarketMid: row.firstMakerMarketMid,
    firstMakerClGapPct: row.firstMakerClGapPct,
    firstMakerBzGapPct: row.firstMakerBzGapPct,
    signalAgreement: signalAgreement(row),
  }));
  const directionAlignedGap = (row, field) => {
    const direction = row.firstMakerSide === "Down" ? -1 : 1;
    return Number(row[field]) * direction;
  };
  return {
    total: summarize(rows),
    lossConcentration: {
      losingWindows: losing.length,
      worst1: round(-topLosses.slice(0, 1).reduce((sum, row) => sum + Number(row.pnl), 0)),
      worst3: round(-topLosses.slice(0, 3).reduce((sum, row) => sum + Number(row.pnl), 0)),
      worst5: round(-topLosses.slice(0, 5).reduce((sum, row) => sum + Number(row.pnl), 0)),
    },
    groups: {
      firstMakerRole: group(rows, (row) => row.firstMakerRole || "unavailable"),
      firstMakerSide: group(rows, (row) => row.firstMakerSide || "unavailable"),
      firstFillTimeS: group(rows, (row) => band(row.firstMakerFillT, [30, 60, 120, 180, 241], ["000-029", "030-059", "060-119", "120-179", "180-240", "241+"])),
      firstFillPrice: group(rows, (row) => band(row.firstMakerPrice, [.3, .5, .7, .9], ["0.12-0.29", "0.30-0.49", "0.50-0.69", "0.70-0.89", "0.90+"])),
      expectedEdge: group(rows, (row) => band(row.firstMakerExpectedEdge, [.05, .08, .12, Infinity], ["<0.05", "0.05-0.079", "0.08-0.119", "0.12+", "invalid"])),
      chainlinkAlignedGapPct: group(rows, (row) => band(directionAlignedGap(row, "firstMakerClGapPct"), [-.02, 0, .02, .05, Infinity], ["<-0.02", "-0.02-0", "0-0.02", "0.02-0.05", "0.05+", "invalid"])),
      binanceAlignedGapPct: group(rows, (row) => band(directionAlignedGap(row, "firstMakerBzGapPct"), [-.02, 0, .02, .05, Infinity], ["<-0.02", "-0.02-0", "0-0.02", "0.02-0.05", "0.05+", "invalid"])),
      chainlinkBinanceAgreement: group(rows, signalAgreement),
      marketMid: group(rows, (row) => band(row.firstMakerMarketMid, [.3, .5, .7, .9], ["<0.30", "0.30-0.49", "0.50-0.69", "0.70-0.89", "0.90+"])),
    },
    topLosses,
  };
}

function crossSource(v2Entry, v4Entry) {
  const v2 = new Map(v2Entry.windowsDetail.map((row) => [row.slug, row]));
  const v4 = new Map(v4Entry.windowsDetail.map((row) => [row.slug, row]));
  const common = [...v2.keys()].filter((slug) => v4.has(slug)).map((slug) => ({ slug, v2: v2.get(slug), v4: v4.get(slug) }));
  const bothActive = common.filter((row) => active(row.v2) && active(row.v4));
  const bothLose = bothActive.filter((row) => Number(row.v2.pnl) < 0 && Number(row.v4.pnl) < 0);
  const bothWin = bothActive.filter((row) => Number(row.v2.pnl) > 0 && Number(row.v4.pnl) > 0);
  const directionMatches = bothActive.filter((row) => row.v2.firstMakerSide === row.v4.firstMakerSide);
  return {
    commonWindows: common.length,
    bothActive: bothActive.length,
    bothWin: bothWin.length,
    bothLose: bothLose.length,
    mixedPnlSign: bothActive.length - bothWin.length - bothLose.length,
    sameFirstMakerSide: directionMatches.length,
    sameFirstMakerSidePct: bothActive.length ? round(directionMatches.length / bothActive.length * 100) : null,
    commonLosses: bothLose.map((row) => ({
      slug: row.slug,
      start: new Date(row.v2.startMs).toISOString(),
      v2Pnl: round(Number(row.v2.pnl)),
      v4Pnl: round(Number(row.v4.pnl)),
      v2Side: row.v2.firstMakerSide,
      v4Side: row.v4.firstMakerSide,
      v2Role: row.v2.firstMakerRole,
      v4Role: row.v4.firstMakerRole,
      v2FillT: row.v2.firstMakerFillT,
      v4FillT: row.v4.firstMakerFillT,
    })).sort((a, b) => a.v2Pnl + a.v4Pnl - b.v2Pnl - b.v4Pnl),
  };
}

const reports = {
  detail: { v2: read(files.detailV2), v4: read(files.detailV4) },
  frozen: { v2: read(files.frozenV2), v4: read(files.frozenV4) },
};
const reproduction = {
  v2: reproduce(reports.detail.v2, reports.frozen.v2, "v2-native-orderbooks"),
  v4: reproduce(reports.detail.v4, reports.frozen.v4, "v4-orderbooks"),
};
if (!Object.values(reproduction).every((entry) => entry.passed)) {
  console.error(JSON.stringify({ error: "detail replay failed exact frozen reproduction", reproduction }, null, 2));
  process.exit(2);
}
const reproducedEntries = {
  v2: reports.detail.v2.diagnostics[reproduction.v2.matchedPolicy],
  v4: reports.detail.v4.diagnostics[reproduction.v4.matchedPolicy],
};
const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  methodology: "Descriptive attribution only after exact frozen-summary reproduction. Bins are not a fitted strategy and must not be used as performance evidence without a new predeclared chronological validation.",
  reproduction,
  sources: {
    v2: sourceAttribution(reproducedEntries.v2),
    v4: sourceAttribution(reproducedEntries.v4),
  },
  crossSource: crossSource(reproducedEntries.v2, reproducedEntries.v4),
};
fs.mkdirSync(path.dirname(files.output), { recursive: true });
fs.writeFileSync(files.output, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, files.output), reproduction,
  totals: Object.fromEntries(Object.entries(output.sources).map(([source, value]) => [source, value.total])),
  crossSource: { ...output.crossSource, commonLosses: output.crossSource.commonLosses.slice(0, 10) } }, null, 2));
