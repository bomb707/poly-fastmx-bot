#!/usr/bin/env node
/**
 * Describe how wallet 0x3048 sizes the next inferred order after a public fill.
 *
 * Public match timestamps establish inventory changes. The next order is only
 * linked when its inferred fire interval begins after the full reported fill
 * second, avoiding same-second ordering assumptions and all on-chain timing.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { quantile } from "./core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048-r7"));
const source = String(process.argv[3] || "v4").toLowerCase() === "v2" ? "v2" : "v4";
const actionsFile = path.join(dataDir, `fire-actions-${source}.json.gz`);
const firesFile = path.join(dataDir, `order-fires-${source}.json.gz`);
const tradesFile = path.join(dataDir, "trades.json");
const outputFile = path.join(dataDir, `fill-next-order-${source}.json`);
const markdownFile = path.join(dataDir, `fill-next-order-${source}.md`);

const readGzip = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const actions = readGzip(actionsFile).rows;
const fires = readGzip(firesFile).rows;
const trades = JSON.parse(fs.readFileSync(tradesFile, "utf8")).trades;
const fireByHash = new Map(fires.map((row) => [row.orderHash, row]));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (count, total) => total ? round(count / total * 100, 3) : null;
const q = (values, probabilities = [0, .1, .25, .5, .75, .9, .99, 1]) => {
  const usable = values.filter(finite).map(Number);
  return Object.fromEntries(probabilities.map((probability) => [
    `p${Math.round(probability * 100)}`, usable.length ? round(quantile(usable, probability)) : null,
  ]));
};
const modes = (values, limit = 12) => {
  const counts = new Map();
  for (const value of values.filter(finite).map(Number)) {
    const key = round(value, 6);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
};
const sideSign = (side) => side === "Up" ? 1 : -1;
const sideFromSign = (value) => value > 1e-9 ? "Up" : value < -1e-9 ? "Down" : null;

// Collapse public matches into side/second bursts. The causal inventory clock
// advances at the end of the timestamp's whole second.
const fillBursts = [];
const fillMap = new Map();
for (const row of trades) {
  const key = `${row.slug}:${row.timestamp}:${row.outcome}`;
  if (!fillMap.has(key)) fillMap.set(key, {
    slug: row.slug, timestamp: Number(row.timestamp), outcome: row.outcome,
    shares: 0, usd: 0, makerShares: 0, takerShares: 0, rows: 0,
  });
  const burst = fillMap.get(key), shares = Number(row.size) || 0, usd = shares * (Number(row.price) || 0);
  burst.shares += shares; burst.usd += usd; burst.rows++;
  if (row.role === "maker") burst.makerShares += shares; else burst.takerShares += shares;
}
for (const burst of fillMap.values()) {
  burst.vwap = burst.shares > 0 ? burst.usd / burst.shares : null;
  burst.causalAfterMs = (burst.timestamp + 1) * 1000;
  fillBursts.push(burst);
}

const actionsBySlug = new Map(), fillsBySlug = new Map();
for (const action of actions) {
  if (!actionsBySlug.has(action.slug)) actionsBySlug.set(action.slug, []);
  const orderFires = action.orderHashes.map((hash) => fireByHash.get(hash)).filter(Boolean);
  const representative = orderFires[0];
  const feature = source === "v2" ? representative?.feature : representative?.v2Feature || representative?.feature || null;
  const clGapPct = Number(feature?.clGapPct), bzGapPct = Number(feature?.bzGapPct);
  const dualSignalSide = finite(clGapPct) && finite(bzGapPct) && clGapPct > 0 && bzGapPct > 0 ? "Up"
    : finite(clGapPct) && finite(bzGapPct) && clGapPct < 0 && bzGapPct < 0 ? "Down" : null;
  const signedDenominator = orderFires.reduce((sum, row) => sum + Number(row.signedShares || 0), 0);
  const signedLimitPrice = signedDenominator > 0 ? orderFires.reduce((sum, row) =>
    sum + Number(row.limitPrice || 0) * Number(row.signedShares || 0), 0) / signedDenominator : null;
  // A small number of multi-order transactions cannot be uniquely allocated
  // from public aggregate trade rows and appear overfilled if the same burst is
  // joined to each hash. Cap descriptive action fills at submitted size.
  const observableFilledCapShares = Math.min(Number(action.filledShares) || 0, Number(action.signedShares) || 0);
  actionsBySlug.get(action.slug).push({ ...action, clGapPct, bzGapPct, dualSignalSide,
    signedLimitPrice: round(signedLimitPrice), observableFilledCapShares: round(observableFilledCapShares) });
}
for (const burst of fillBursts) {
  if (!fillsBySlug.has(burst.slug)) fillsBySlug.set(burst.slug, []);
  fillsBySlug.get(burst.slug).push(burst);
}
for (const rows of actionsBySlug.values()) rows.sort((a, b) => a.intervalStartMs - b.intervalStartMs || a.outcome.localeCompare(b.outcome));
for (const rows of fillsBySlug.values()) rows.sort((a, b) => a.causalAfterMs - b.causalAfterMs || a.outcome.localeCompare(b.outcome));

const transitions = [], actionStates = [];
for (const [slug, slugActions] of actionsBySlug) {
  const slugFills = fillsBySlug.get(slug) || [];
  let cursor = 0, up = 0, down = 0, lastFill = null;
  const residualLots = { Up: [], Down: [] };
  const addResidual = (side, shares, unitCost) => {
    const oppositeSide = side === "Up" ? "Down" : "Up";
    let left = shares;
    while (left > 1e-9 && residualLots[oppositeSide].length) {
      const lot = residualLots[oppositeSide][0], take = Math.min(left, lot.shares);
      left -= take; lot.shares -= take;
      if (lot.shares <= 1e-9) residualLots[oppositeSide].shift();
    }
    if (left > 1e-9) residualLots[side].push({ shares: left, unitCost });
  };
  const residualAverage = (side) => {
    const lots = residualLots[side], shares = lots.reduce((sum, lot) => sum + lot.shares, 0);
    return shares > 1e-9 ? lots.reduce((sum, lot) => sum + lot.shares * lot.unitCost, 0) / shares : null;
  };
  for (const action of slugActions) {
    while (cursor < slugFills.length && slugFills[cursor].causalAfterMs <= action.intervalStartMs) {
      const fill = slugFills[cursor++];
      if (fill.outcome === "Up") up += fill.shares; else down += fill.shares;
      addResidual(fill.outcome, fill.shares, fill.vwap);
      lastFill = fill;
    }
    const imbalance = up - down, residualSide = sideFromSign(imbalance);
    const reducesResidual = residualSide !== null && action.outcome !== residualSide;
    const heldAverage = residualSide ? residualAverage(residualSide) : null;
    const lockedPairEdgeAtLimit = reducesResidual && finite(heldAverage) && finite(action.signedLimitPrice)
      ? 1 - heldAverage - Number(action.signedLimitPrice) : null;
    const reversalSupported = reducesResidual && action.dualSignalSide === action.outcome;
    const pairEdgePositive = reducesResidual && finite(lockedPairEdgeAtLimit) && lockedPairEdgeAtLimit > 1e-9;
    const state = {
      ...action,
      observedUpBefore: round(up), observedDownBefore: round(down), observedImbalanceBefore: round(imbalance),
      observedBalancedSharesBefore: round(Math.min(up, down)), observedResidualSharesBefore: round(Math.abs(imbalance)),
      observedResidualSide: residualSide, reducesResidual, heldAverage: round(heldAverage),
      lockedPairEdgeAtEffectivePrice: round(lockedPairEdgeAtLimit), reversalSupported, pairEdgePositive,
      justifiedOpposite: reducesResidual && (reversalSupported || pairEdgePositive),
    };
    actionStates.push(state);
    if (lastFill) transitions.push({
      slug,
      previousFillTimestamp: lastFill.timestamp,
      previousFillSide: lastFill.outcome,
      previousFillShares: round(lastFill.shares),
      previousFillMakerShares: round(lastFill.makerShares),
      previousFillTakerShares: round(lastFill.takerShares),
      nextFireMs: action.fireMs,
      conservativeReactionMs: action.intervalStartMs - lastFill.causalAfterMs,
      nextSide: action.outcome,
      nextSignedShares: round(action.signedShares),
      nextFilledShares: action.observableFilledCapShares,
      nextExactOrders: action.exactOrders,
      nextSignedSizes: action.signedSizes,
      fillToNextSignedRatio: lastFill.shares > 1e-9 ? round(action.signedShares / lastFill.shares) : null,
      sameSideAsPreviousFill: action.outcome === lastFill.outcome,
      observedImbalanceBefore: state.observedImbalanceBefore,
      observedResidualSide: residualSide,
      reducesResidual,
      coverageOfResidualBySigned: reducesResidual && Math.abs(imbalance) > 1e-9
        ? round(action.signedShares / Math.abs(imbalance)) : null,
      dualSignalSide: action.dualSignalSide,
      reversalSupported,
      pairEdgePositive,
      justifiedOpposite: state.justifiedOpposite,
      lockedPairEdgeAtEffectivePrice: state.lockedPairEdgeAtEffectivePrice,
    });
  }
}

// Pair near-simultaneous opposite-side fire actions without reusing an action.
const pairedClusters = [];
for (const slugActions of actionsBySlug.values()) {
  const used = new Set();
  for (let index = 0; index < slugActions.length; index++) {
    if (used.has(index)) continue;
    const a = slugActions[index];
    let best = -1, bestDelta = Infinity;
    for (let j = index + 1; j < slugActions.length; j++) {
      if (used.has(j) || slugActions[j].outcome === a.outcome) continue;
      const delta = Math.abs(slugActions[j].fireMs - a.fireMs);
      if (delta <= 500 && delta < bestDelta) { best = j; bestDelta = delta; }
      if (slugActions[j].intervalStartMs - a.intervalStartMs > 500) break;
    }
    if (best < 0) continue;
    used.add(index); used.add(best);
    const b = slugActions[best], upAction = a.outcome === "Up" ? a : b, downAction = a.outcome === "Down" ? a : b;
    pairedClusters.push({ slug: a.slug, deltaMs: bestDelta,
      upSignedShares: upAction.signedShares, downSignedShares: downAction.signedShares,
      upFilledShares: upAction.observableFilledCapShares, downFilledShares: downAction.observableFilledCapShares,
      signedBalanceRatio: Math.min(upAction.signedShares, downAction.signedShares) / Math.max(upAction.signedShares, downAction.signedShares),
      signedNetUp: upAction.signedShares - downAction.signedShares,
    });
  }
}

const sizeBins = [
  { name: "le5", test: (value) => value <= 5 + 1e-9 },
  { name: "gt5_le25", test: (value) => value > 5 && value <= 25 + 1e-9 },
  { name: "gt25_le50", test: (value) => value > 25 && value <= 50 + 1e-9 },
  { name: "gt50_le75", test: (value) => value > 50 && value <= 75 + 1e-9 },
  { name: "gt75", test: (value) => value > 75 },
];
const byPreviousFillSize = Object.fromEntries(sizeBins.map((bin) => {
  const rows = transitions.filter((row) => bin.test(row.previousFillShares));
  return [bin.name, { transitions: rows.length, previousFillShares: q(rows.map((row) => row.previousFillShares)),
    nextSignedShares: q(rows.map((row) => row.nextSignedShares)), nextSignedModes: modes(rows.map((row) => row.nextSignedShares), 8),
    sameSidePct: pct(rows.filter((row) => row.sameSideAsPreviousFill).length, rows.length),
    reducesResidualPct: pct(rows.filter((row) => row.reducesResidual).length, rows.length) }];
}));

const opposite = actionStates.filter((row) => row.reducesResidual);
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  wallet: "0x3048d65321be3497164cdfc2996f94f98a2e7537",
  source,
  methodology: {
    fireClock: `${source} public order-book fire intervals; signed/on-chain timestamps excluded`,
    fillClock: "Data API public match second; a response is linked only after the entire reported second",
    caveat: "Signed quantity is observable for filled signed orders only. Never-filled private orders and private cancellations remain unobservable.",
  },
  coverage: { actions: actions.length, windows: actionsBySlug.size, publicFillBursts: fillBursts.length,
    transitionsAfterCausallyPriorFill: transitions.length, pairedFireClustersWithin500ms: pairedClusters.length },
  actionSizing: {
    exactSignedSizeModes: modes(actions.flatMap((row) => row.signedSizes)),
    actionSignedShares: q(actions.map((row) => row.signedShares)),
    actionSignedShareModes: modes(actions.map((row) => row.signedShares)),
    actionFilledShares: q(actionStates.map((row) => row.observableFilledCapShares)),
    actionFillFraction: q(actionStates.map((row) => Number(row.signedShares) > 0
      ? Number(row.observableFilledCapShares) / Number(row.signedShares) : null)),
  },
  nextAfterFill: {
    conservativeReactionMs: q(transitions.map((row) => row.conservativeReactionMs)),
    previousFillShares: q(transitions.map((row) => row.previousFillShares)),
    nextSignedShares: q(transitions.map((row) => row.nextSignedShares)),
    nextSignedModes: modes(transitions.map((row) => row.nextSignedShares)),
    fillToNextSignedRatio: q(transitions.map((row) => row.fillToNextSignedRatio)),
    sameSidePct: pct(transitions.filter((row) => row.sameSideAsPreviousFill).length, transitions.length),
    reducesObservedResidualPct: pct(transitions.filter((row) => row.reducesResidual).length, transitions.length),
    byPreviousFillSize,
  },
  oppositeSideOrders: {
    actions: opposite.length,
    reversalSupportedPct: pct(opposite.filter((row) => row.reversalSupported).length, opposite.length),
    pairEdgePositivePct: pct(opposite.filter((row) => row.pairEdgePositive).length, opposite.length),
    reversalOrPairEdgePct: pct(opposite.filter((row) => row.justifiedOpposite).length, opposite.length),
    lockedPairEdge: q(opposite.map((row) => row.lockedPairEdgeAtEffectivePrice)),
    signedCoverageOfObservedResidual: q(transitions.filter((row) => row.reducesResidual).map((row) => row.coverageOfResidualBySigned)),
  },
  pairedFireClusters: {
    clusters: pairedClusters.length,
    deltaMs: q(pairedClusters.map((row) => row.deltaMs)),
    upSignedShares: q(pairedClusters.map((row) => row.upSignedShares)),
    downSignedShares: q(pairedClusters.map((row) => row.downSignedShares)),
    signedBalanceRatio: q(pairedClusters.map((row) => row.signedBalanceRatio)),
    signedNetUpModes: modes(pairedClusters.map((row) => row.signedNetUp)),
  },
  transitions,
  actionStates,
  pairedClusters,
};

const md = `# Fill-to-next-order transitions (${source})\n\n` +
`Generated ${report.generatedAt}. Order fire uses ${source} public order books; signed/on-chain timestamps are excluded. ` +
`A next order is linked only after the prior fill's full public match second.\n\n` +
`- ${report.coverage.actions} inferred actions in ${report.coverage.windows} windows; ${report.coverage.transitionsAfterCausallyPriorFill} have a causally prior public fill.\n` +
`- Exact signed sizes: ${report.actionSizing.exactSignedSizeModes.map((row) => `${row.value} (${row.count})`).join(", ")}.\n` +
`- Filled shares/action median ${report.actionSizing.actionFilledShares.p50}; next signed shares median ${report.nextAfterFill.nextSignedShares.p50}.\n` +
`- ${report.nextAfterFill.sameSidePct}% of next actions stay on the previous fill side; ${report.nextAfterFill.reducesObservedResidualPct}% reduce the observed residual.\n` +
`- ${report.coverage.pairedFireClustersWithin500ms} opposite-side fire pairs occur within 500 ms; median signed balance ratio ${report.pairedFireClusters.signedBalanceRatio.p50}.\n\n` +
`Caveat: only orders that eventually filled expose their signed quantity; private never-filled orders and cancellations are unavailable.\n`;

fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(markdownFile, md);
console.log(md);
console.log(JSON.stringify({ actionSizing: report.actionSizing, nextAfterFill: report.nextAfterFill,
  oppositeSideOrders: report.oppositeSideOrders, pairedFireClusters: report.pairedFireClusters }, null, 2));
