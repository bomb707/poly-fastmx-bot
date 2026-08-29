#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { aggregateFillBursts, quantile } from "./core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-3048/trades-2026-08-14_2026-08-22.json"));
const outDir = path.resolve(process.argv[3] || path.join(ROOT, "data/wallet-3048"));
const data = JSON.parse(fs.readFileSync(input, "utf8"));
let rebatesByDay = new Map();
try {
  const rebateData = JSON.parse(fs.readFileSync(path.join(outDir, "maker-rebates.json"), "utf8"));
  rebatesByDay = new Map((rebateData.rows || []).map((row) => [row.date, Number(row.rebate) || 0]));
} catch {}
const bursts = aggregateFillBursts(data.trades);
const marketBySlug = new Map(data.markets.map((market) => [market.slug, market]));
const burstsBySlug = new Map();
for (const burst of bursts) {
  if (!burstsBySlug.has(burst.slug)) burstsBySlug.set(burst.slug, []);
  burstsBySlug.get(burst.slug).push(burst);
}

const fee = (burst) => Number(burst.modeledFee) || 0;
const dayOf = (timestamp) => new Date(timestamp * 1000).toISOString().slice(0, 10);
const round = (value, digits = 6) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const q = (values) => Object.fromEntries([["min", 0], ["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9], ["max", 1]].map(([key, p]) => [key, round(quantile(values, p))]));
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
const sum = (values) => values.reduce((a, b) => a + b, 0);

function modeTable(values, precision = 2, limit = 10) {
  const counts = new Map();
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(precision);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, limit)
    .map(([value, count]) => ({ value: Number(value), count, pct: pct(count, values.length) }));
}

function pairInventory(windowBursts) {
  const queues = { Up: [], Down: [] };
  const paired = [];
  const classifications = [];
  let up = 0, down = 0, signFlips = 0, previousSign = 0;
  for (const burst of windowBursts) {
    const beforeUp = up, beforeDown = down;
    const imbalance = burst.outcome === "Up" ? down - up : up - down;
    const hedgeShares = Math.max(0, Math.min(burst.shares, imbalance));
    // "Overbuy" is only the portion of an actual hedge that crosses through
    // balance. A same-lean entry is new inventory, not an over-hedge.
    const overbuyShares = imbalance > 0 ? Math.max(0, burst.shares - imbalance) : 0;
    classifications.push({ hedgeShares, overbuyShares, entryShares: burst.shares - hedgeShares, burst });

    let remaining = burst.shares;
    const opposite = burst.outcome === "Up" ? "Down" : "Up";
    while (remaining > 1e-9 && queues[opposite].length) {
      const entry = queues[opposite][0];
      const shares = Math.min(remaining, entry.shares);
      const newFeePerShare = fee(burst) / burst.shares;
      const oldFeePerShare = entry.feePerShare;
      paired.push({
        shares,
        completedAt: burst.timestamp,
        secondsApart: burst.timestamp - entry.timestamp,
        rawCost: entry.price + burst.vwap,
        feeCost: oldFeePerShare + newFeePerShare,
        totalCost: entry.price + burst.vwap + oldFeePerShare + newFeePerShare,
        combo: `${entry.role}+${burst.role}`,
      });
      remaining -= shares;
      entry.shares -= shares;
      if (entry.shares <= 1e-9) queues[opposite].shift();
    }
    if (remaining > 1e-9) queues[burst.outcome].push({ shares: remaining, price: burst.vwap, feePerShare: fee(burst) / burst.shares, role: burst.role, timestamp: burst.timestamp });

    if (burst.outcome === "Up") up += burst.shares; else down += burst.shares;
    const sign = Math.abs(up - down) < 1e-9 ? 0 : Math.sign(up - down);
    if (previousSign && sign && sign !== previousSign) signFlips++;
    if (sign) previousSign = sign;
    classifications.at(-1).beforeUp = beforeUp;
    classifications.at(-1).beforeDown = beforeDown;
    classifications.at(-1).afterUp = up;
    classifications.at(-1).afterDown = down;
  }
  return { paired, classifications, signFlips, up, down, unmatched: Math.abs(up - down) };
}

function summarizeWindow(slug, windowBursts) {
  const market = marketBySlug.get(slug) || {};
  const ws = Number(slug.split("-").at(-1));
  const pairing = pairInventory(windowBursts);
  const cost = sum(windowBursts.map((b) => b.usd));
  const fees = sum(windowBursts.map(fee));
  const payout = market.winner === "Up" ? pairing.up : market.winner === "Down" ? pairing.down : null;
  const hedgeShares = sum(pairing.classifications.map((x) => x.hedgeShares));
  const overbuyShares = sum(pairing.classifications.map((x) => x.overbuyShares));
  const totalShares = pairing.up + pairing.down;
  return {
    slug,
    day: new Date(ws * 1000).toISOString().slice(0, 10),
    winner: market.winner,
    bursts: windowBursts.length,
    makerBursts: windowBursts.filter((b) => b.role === "maker").length,
    takerBursts: windowBursts.filter((b) => b.role === "taker").length,
    up: pairing.up,
    down: pairing.down,
    totalShares,
    pairedShares: Math.min(pairing.up, pairing.down),
    unmatchedShares: pairing.unmatched,
    hedgeShares,
    overbuyShares,
    hedgeSharePct: pct(hedgeShares, totalShares),
    overbuySharePct: pct(overbuyShares, totalShares),
    signFlips: pairing.signFlips,
    firstT: Math.min(...windowBursts.map((b) => b.timestamp - ws)),
    lastT: Math.max(...windowBursts.map((b) => b.timestamp - ws)),
    cost,
    fees,
    payout,
    net: payout == null ? null : payout - cost - fees,
    roiPct: payout == null ? null : pct(payout - cost - fees, cost + fees),
    pairings: pairing.paired,
  };
}

const windows = [...burstsBySlug].map(([slug, rows]) => summarizeWindow(slug, rows)).sort((a, b) => a.slug.localeCompare(b.slug));
const settled = windows.filter((w) => w.payout != null);
const days = [...new Set(windows.map((w) => w.day))].sort().map((day) => {
  const wb = windows.filter((w) => w.day === day);
  const db = bursts.filter((b) => dayOf(b.timestamp) === day);
  const sw = wb.filter((w) => w.payout != null);
  const cost = sum(sw.map((w) => w.cost));
  const fees = sum(sw.map((w) => w.fees));
  const payout = sum(sw.map((w) => w.payout));
  const firstSideCorrect = wb.filter((w) => {
    const first = burstsBySlug.get(w.slug)?.[0];
    return first && first.outcome === w.winner;
  }).length;
  return {
    day,
    windows: wb.length,
    settledWindows: sw.length,
    bursts: db.length,
    makerBursts: db.filter((b) => b.role === "maker").length,
    takerBursts: db.filter((b) => b.role === "taker").length,
    makerPct: pct(db.filter((b) => b.role === "maker").length, db.length),
    bothSidesPct: pct(wb.filter((w) => w.up > 0 && w.down > 0).length, wb.length),
    firstSideWinnerPct: pct(firstSideCorrect, wb.filter((w) => w.winner).length),
    medianPrice: round(quantile(db.map((b) => b.vwap), .5)),
    medianShares: round(quantile(db.map((b) => b.shares), .5)),
    shareModes: modeTable(db.map((b) => b.shares), 2, 5),
    notionalModes: modeTable(db.map((b) => b.usd), 2, 5),
    firstT: q(wb.map((w) => w.firstT)),
    lastT: q(wb.map((w) => w.lastT)),
    signFlips: q(wb.map((w) => w.signFlips)),
    cost: round(cost, 2), fees: round(fees, 2), payout: round(payout, 2),
    net: round(payout - cost - fees, 2), roiPct: pct(payout - cost - fees, cost + fees),
    makerRebate: round(rebatesByDay.get(day) || 0, 2),
    netWithRebate: round(payout - cost - fees + (rebatesByDay.get(day) || 0), 2),
  };
});

const pairings = windows.flatMap((w) => w.pairings);
const pairingCombos = [...new Set(pairings.map((p) => p.combo))].sort().map((combo) => {
  const rows = pairings.filter((p) => p.combo === combo);
  const shares = sum(rows.map((p) => p.shares));
  return { combo, chunks: rows.length, shares: round(shares), sharePct: pct(shares, sum(pairings.map((p) => p.shares))), totalCost: q(rows.map((p) => p.totalCost)) };
});
const pricedInBand = bursts.filter((b) => b.vwap >= .12 - 1e-9 && b.vwap <= .89 + 1e-9).length;
const hedgeShares = sum(windows.map((w) => w.hedgeShares));
const totalShares = sum(windows.map((w) => w.totalShares));
const overbuyShares = sum(windows.map((w) => w.overbuyShares));
const result = {
  schema: 1,
  source: { input, wallet: data.wallet, from: data.from, to: data.to, publicRows: data.trades.length, marketsInRange: data.markets.length },
  fills: {
    bursts: bursts.length,
    tradedWindows: windows.length,
    makerBursts: bursts.filter((b) => b.role === "maker").length,
    takerBursts: bursts.filter((b) => b.role === "taker").length,
    makerPct: pct(bursts.filter((b) => b.role === "maker").length, bursts.length),
    price: q(bursts.map((b) => b.vwap)),
    shareSize: q(bursts.map((b) => b.shares)),
    notional: q(bursts.map((b) => b.usd)),
    timeIntoWindow: q(bursts.map((b) => b.timestamp - Number(b.slug.split("-").at(-1)))),
    inPriceBand_0_12_to_0_89: pricedInBand,
    inPriceBandPct: pct(pricedInBand, bursts.length),
  },
  behavior: {
    burstsPerWindow: q(windows.map((w) => w.bursts)),
    firstFireSecondByWindow: q(windows.map((w) => w.firstT)),
    lastFireSecondByWindow: q(windows.map((w) => w.lastT)),
    inventorySignFlipsPerWindow: q(windows.map((w) => w.signFlips)),
    hedgeSharePct: pct(hedgeShares, totalShares),
    overbuySharePct: pct(overbuyShares, totalShares),
    pairingSecondsApart: q(pairings.map((p) => p.secondsApart)),
    pairRawCost: q(pairings.map((p) => p.rawCost)),
    pairFeeInclusiveCost: q(pairings.map((p) => p.totalCost)),
    pairedSharesProfitablePct: pct(sum(pairings.filter((p) => p.totalCost < 1).map((p) => p.shares)), sum(pairings.map((p) => p.shares))),
    pairingRoleCombinations: pairingCombos,
  },
  performance: {
    settledWindows: settled.length,
    estimatedCost: round(sum(settled.map((w) => w.cost)), 2),
    estimatedTakerFees: round(sum(settled.map((w) => w.fees)), 2),
    payout: round(sum(settled.map((w) => w.payout)), 2),
    net: round(sum(settled.map((w) => w.net)), 2),
    roiPct: pct(sum(settled.map((w) => w.net)), sum(settled.map((w) => w.cost + w.fees))),
    makerRebates: round(sum([...rebatesByDay.values()]), 2),
    netWithMakerRebates: round(sum(settled.map((w) => w.net)) + sum([...rebatesByDay.values()]), 2),
    feeModel: "taker fee = 0.07 * price * (1-price) * shares; maker fee = 0",
  },
  daily: days,
};

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "fill-analysis.json");
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");
const dailyRows = days.map((d) => `| ${d.day} | ${d.windows} | ${d.bursts} | ${d.makerPct}% | ${d.firstT.median}s | ${d.lastT.median}s | ${d.signFlips.median} | $${d.net} | $${d.makerRebate} | $${d.netWithRebate} |`).join("\n");
const md = `# Wallet 0x3048 fill-only reconstruction\n\n` +
`Range: ${data.from} through ${data.to}. Maker/taker roles come from exact multiset subtraction of Polymarket Data API all-trades and taker-only results. Public match times are analyzed here; off-chain fire-time inference is a separate stage.\n\n` +
`- ${bursts.length.toLocaleString()} fill bursts in ${windows.length.toLocaleString()} traded five-minute windows.\n` +
`- ${result.fills.makerPct}% maker and ${round(100-result.fills.makerPct,3)}% taker bursts.\n` +
`- ${result.fills.inPriceBandPct}% of burst VWAPs are in the proposed 0.12–0.89 band.\n` +
`- Median ${result.behavior.burstsPerWindow.median} bursts/window and ${result.behavior.inventorySignFlipsPerWindow.median} inventory-side flips/window: this is repeated inventory cycling, not one entry plus one hedge.\n` +
`- ${result.behavior.hedgeSharePct}% of shares reduce existing imbalance; ${result.behavior.overbuySharePct}% cross through balance into an opposite lean.\n` +
`- Fee-inclusive paired-set cost median ${result.behavior.pairFeeInclusiveCost.median}; ${result.behavior.pairedSharesProfitablePct}% of FIFO-paired shares cost under $1 before settlement exposure.\n` +
`- Estimated settled net: $${result.performance.net} (${result.performance.roiPct}% on cost plus modeled taker fees).\n\n` +
`- Publicly reported maker rebates add $${result.performance.makerRebates}; net including paid rebates is $${result.performance.netWithMakerRebates}.\n\n` +
`| UTC day | windows | bursts | maker | median first | median last | median flips | trading net | rebate | net + rebate |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${dailyRows}\n\n` +
`Caveats: Data API timestamps are public match timestamps, not order-fire timestamps. Fees are modeled with the stated crypto-market taker curve. FIFO pairing is an inventory diagnostic, not proof of the bot's internal lot accounting.\n`;
const mdPath = path.join(outDir, "fill-analysis.md");
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ jsonPath, mdPath, summary: result }, null, 2));
