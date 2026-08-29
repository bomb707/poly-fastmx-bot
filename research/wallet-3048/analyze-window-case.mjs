#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048"));
const slug = process.argv[3] || "btc-updown-5m-1787415000";
const wallet = "0x3048d65321be3497164cdfc2996f94f98a2e7537";
const startMs = Number(slug.split("-").at(-1)) * 1000;
const source = JSON.parse(fs.readFileSync(path.join(dataDir, "trades-2026-08-14_2026-08-22.json"), "utf8"));
const market = source.markets.find((row) => row.slug === slug);
if (!market) throw new Error(`market not found: ${slug}`);

const signed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signed-orders.json.gz")))).groups
  .filter((group) => group.settlements.some((row) => row.slug === slug));
const fires = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "order-fires.json.gz")))).rows
  .filter((row) => row.slug === slug);
const cancels = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "cancel-replacements.json.gz")))).rows
  .filter((row) => row.slug === slug);
const fireByHash = new Map(fires.map((row) => [row.orderHash, row]));

const activityFile = path.join(dataDir, `window-case-${slug}-activity.json`);
let activity;
if (fs.existsSync(activityFile)) activity = JSON.parse(fs.readFileSync(activityFile, "utf8"));
else {
  const query = new URLSearchParams({ user: wallet, market: market.conditionId, limit: "500", offset: "0" });
  const response = await fetch(`https://data-api.polymarket.com/activity?${query}`);
  if (!response.ok) throw new Error(`activity ${response.status}: ${await response.text()}`);
  activity = await response.json();
  fs.writeFileSync(activityFile, JSON.stringify(activity, null, 2) + "\n");
}

const waveOf = (group) => {
  const seconds = (Number(group.signedTimestampMs) - startMs) / 1000;
  return seconds < 0 ? "pre-open" : seconds < 150 ? "middle" : "late";
};
const orders = signed.map((group) => {
  const settlement = group.settlements.find((row) => row.slug === slug);
  const fire = fireByHash.get(group.orderHash);
  return {
    orderHash: group.orderHash,
    wave: waveOf(group),
    outcome: settlement.outcome,
    signedShares: group.signedShares,
    filledShares: group.filledShares,
    filledUsd: group.filledUsd,
    vwap: group.vwap,
    limitPrice: group.limitPrice,
    signedAtS: (Number(group.signedTimestampMs) - startMs) / 1000,
    fireAtS: fire ? (Number(fire.fireMs) - startMs) / 1000 : null,
    confidence: fire?.confidence ?? null,
    method: fire?.method ?? null,
    settlementTxs: group.settlements.filter((row) => row.slug === slug).map((row) => row.txHash),
  };
}).sort((a, b) => (a.fireAtS ?? Infinity) - (b.fireAtS ?? Infinity));

function aggregateOrders(rows) {
  const out = {};
  for (const outcome of ["Up", "Down"]) {
    const side = rows.filter((row) => row.outcome === outcome);
    const shares = side.reduce((sum, row) => sum + Number(row.filledShares), 0);
    const notional = side.reduce((sum, row) => sum + Number(row.filledUsd), 0);
    out[outcome] = { orders: side.length, shares, notional, averagePrice: shares ? notional / shares : null };
  }
  return out;
}

function activityCostForOrders(rows) {
  const hashes = new Set(rows.flatMap((row) => row.settlementTxs).map((value) => String(value).toLowerCase()));
  const selected = activity.filter((row) => row.type === "TRADE" && hashes.has(String(row.transactionHash).toLowerCase()));
  const out = {};
  for (const outcome of ["Up", "Down"]) {
    const side = selected.filter((row) => row.outcome === outcome);
    const shares = side.reduce((sum, row) => sum + Number(row.size), 0);
    const notional = side.reduce((sum, row) => sum + Number(row.size) * Number(row.price), 0);
    const allInCost = side.reduce((sum, row) => sum + Number(row.usdcSize), 0);
    out[outcome] = { activityRows: side.length, shares, notional, averagePrice: shares ? notional / shares : null, allInCost, fee: allInCost - notional };
  }
  return out;
}

function inventoryCrossings(rows) {
  let up = 0, down = 0, crossings = 0;
  const timeline = [];
  for (const row of [...rows].sort((a, b) => (a.fireAtS ?? Infinity) - (b.fireAtS ?? Infinity))) {
    const before = up - down;
    if (row.outcome === "Up") up += Number(row.filledShares); else down += Number(row.filledShares);
    const after = up - down;
    const crossed = Math.sign(before) !== 0 && Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after);
    if (crossed) crossings++;
    timeline.push({ fireAtS: row.fireAtS, outcome: row.outcome, shares: row.filledShares, beforeImbalance: before, afterImbalance: after, crossed });
  }
  return { crossings, finalImbalance: up - down, timeline };
}

function checkpoint(rows) {
  const costs = activityCostForOrders(rows);
  const pairedShares = Math.min(costs.Up.shares, costs.Down.shares);
  const upAllIn = costs.Up.shares ? costs.Up.allInCost / costs.Up.shares : null;
  const downAllIn = costs.Down.shares ? costs.Down.allInCost / costs.Down.shares : null;
  const residualSide = costs.Up.shares >= costs.Down.shares ? "Up" : "Down";
  const residualShares = Math.abs(costs.Up.shares - costs.Down.shares);
  const inventory = inventoryCrossings(rows);
  return {
    sides: costs,
    pairedShares,
    displayAverageAllInPairCost: upAllIn + downAllIn,
    displayAverageAllInPairEdgeCents: (1 - upAllIn - downAllIn) * 100,
    residualSide,
    residualShares,
    inventoryCrossings: inventory.crossings,
    finalImbalance: inventory.finalImbalance,
  };
}

const waves = {};
for (const wave of ["pre-open", "middle", "late"]) {
  const rows = orders.filter((row) => row.wave === wave);
  waves[wave] = {
    orders: rows.length,
    signedStartS: Math.min(...rows.map((row) => row.signedAtS)),
    signedEndS: Math.max(...rows.map((row) => row.signedAtS)),
    firstFireS: Math.min(...rows.map((row) => row.fireAtS).filter(Number.isFinite)),
    lastFireS: Math.max(...rows.map((row) => row.fireAtS).filter(Number.isFinite)),
    sides: aggregateOrders(rows),
  };
}

const screenshotOrders = orders.filter((row) => row.wave !== "late");
const screenshot = activityCostForOrders(screenshotOrders);
const screenshotCheckpoint = checkpoint(screenshotOrders);
const completeCheckpoint = checkpoint(orders);
const expected = {
  Up: { sharesOneDecimal: 233.5, averageCentsOneDecimal: 25.5, betOneDecimal: 59.6, feeTwoDecimals: 2.69 },
  Down: { sharesOneDecimal: 333.7, averageCentsOneDecimal: 68.5, betOneDecimal: 228.7, feeTwoDecimals: 3.79 },
};
const displayed = (side) => ({
  sharesOneDecimal: Math.floor(screenshot[side].shares * 10 + 1e-8) / 10,
  averageCentsOneDecimal: Math.floor(screenshot[side].averagePrice * 1000 + 1e-8) / 10,
  betOneDecimal: Math.floor(screenshot[side].notional * 10 + 1e-8) / 10,
  feeTwoDecimals: Math.floor(screenshot[side].fee * 100 + 1e-8) / 100,
});
const screenshotMatch = Object.fromEntries(["Up", "Down"].map((side) => [side, {
  exact: screenshot[side],
  displayed: displayed(side),
  expected: expected[side],
  matches: JSON.stringify(displayed(side)) === JSON.stringify(expected[side]),
}]));

const lastMiddleFire = Math.max(...orders.filter((row) => row.wave !== "late").map((row) => row.fireAtS).filter(Number.isFinite));
const firstLateFire = Math.min(...orders.filter((row) => row.wave === "late").map((row) => row.fireAtS).filter(Number.isFinite));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  wallet,
  market,
  counts: { publicTradeRows: source.trades.filter((row) => row.slug === slug).length, signedOrders: orders.length, inferredFires: fires.length, inferredCancels: cancels.length },
  waves,
  screenshot: screenshotMatch,
  screenshotInterval: {
    lastFirstTwoWaveFireS: lastMiddleFire,
    lastFirstTwoWavePublicMatchS: Math.max(...screenshotOrders.flatMap((row) => row.settlementTxs).map((hash) => activity.find((row) => String(row.transactionHash).toLowerCase() === String(hash).toLowerCase())?.timestamp).filter(Number.isFinite)) - startMs / 1000,
    lateWaveSignedStartS: waves.late.signedStartS,
    firstLateWaveFireS: firstLateFire,
    firePauseS: firstLateFire - lastMiddleFire,
  },
  firstTwoWaves: aggregateOrders(screenshotOrders),
  completeWindow: aggregateOrders(orders),
  checkpointEconomics: {
    afterFirstTwoWaves: screenshotCheckpoint,
    completeWindow: completeCheckpoint,
  },
  orders,
};

const outputStem = path.join(dataDir, `window-case-${slug}`);
fs.writeFileSync(`${outputStem}.json`, JSON.stringify(report, null, 2) + "\n");
const md = `# Window case study: ${slug}\n\n` +
`This is the August 22, 12:10–12:15 PM ET screenshot market. The screenshot is an exact checkpoint after the first two signing waves, not the final window inventory.\n\n` +
`| Outcome | Exact shares | Exact average | Exact bet | Exact fee | Screenshot |\n|---|---:|---:|---:|---:|---|\n` +
`${["Down", "Up"].map((side) => `| ${side} | ${screenshot[side].shares.toFixed(6)} | ${(screenshot[side].averagePrice * 100).toFixed(4)}c | $${screenshot[side].notional.toFixed(6)} | $${screenshot[side].fee.toFixed(6)} | ${screenshotMatch[side].matches ? "exact display match" : "mismatch"} |`).join("\n")}\n\n` +
`- Pre-open wave: ${waves["pre-open"].orders} filled signed orders, firing t+${waves["pre-open"].firstFireS.toFixed(3)} to t+${waves["pre-open"].lastFireS.toFixed(3)}.\n` +
`- Middle wave: ${waves.middle.orders} filled signed orders, firing t+${waves.middle.firstFireS.toFixed(3)} to t+${waves.middle.lastFireS.toFixed(3)}.\n` +
`- Late wave: signed at t+${waves.late.signedStartS.toFixed(3)}, then ${waves.late.orders} filled orders fire t+${waves.late.firstFireS.toFixed(3)} to t+${waves.late.lastFireS.toFixed(3)}.\n` +
`- The visible checkpoint follows a ${report.screenshotInterval.firePauseS.toFixed(3)} second pause between the middle and late firing waves.\n` +
`- By the screenshot checkpoint, inferred inventory had crossed sides ${screenshotCheckpoint.inventoryCrossings} times. The two displayed all-in position averages sum to ${screenshotCheckpoint.displayAverageAllInPairCost.toFixed(6)} (${screenshotCheckpoint.displayAverageAllInPairEdgeCents.toFixed(4)} cents below $1), with ${screenshotCheckpoint.residualShares.toFixed(6)} excess Down shares. This display-average diagnostic is not FIFO pair attribution.\n` +
`- The late wave adds ${completeCheckpoint.inventoryCrossings - screenshotCheckpoint.inventoryCrossings} more side crossings and changes the final excess to ${completeCheckpoint.residualShares.toFixed(6)} ${completeCheckpoint.residualSide} shares.\n` +
`- Complete-window gross buys later reach Up ${report.completeWindow.Up.shares.toFixed(6)} and Down ${report.completeWindow.Down.shares.toFixed(6)}; the screenshot therefore cannot be the final strategy state.\n`;
fs.writeFileSync(`${outputStem}.md`, md);
console.log(md);
console.log(JSON.stringify({ counts: report.counts, waves: report.waves, screenshot: report.screenshot, screenshotInterval: report.screenshotInterval, completeWindow: report.completeWindow, checkpointEconomics: report.checkpointEconomics }, null, 2));
