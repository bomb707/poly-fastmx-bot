#!/usr/bin/env node
// Consolidate the strict-consensus target wallet's order sizing, opposite-side
// inventory transition, and last-reversal behavior. This is a research artifact
// only; it is not registered with the runtime strategy.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(root, "data/wallet-75cc");
const resultDir = path.join(root, "research/wallet-75cc/results");
const actionFile = path.join(dataDir, "fire-actions-consensus-btc-aug16-25-decision520.json.gz");
const sampleFile = path.join(dataDir, "fire-gate-samples-consensus-btc-aug16-25-decision520.json.gz");
const signedFile = path.join(dataDir, "signed-orders.json.gz");
const cohortFile = path.join(dataDir, "cohort-2026-08-16_2026-08-26-btc.json");
const branchModelFile = path.join(resultDir, "target-hedge-branch-consensus-2026-08-27.json");
const residualModelFile = path.join(resultDir, "target-residual-size-consensus-2026-08-27.json");
const outputJson = path.join(resultDir, "target-wallet-sizing-hedge-extraction-2026-08-27.json");
const outputMd = path.join(resultDir, "target-wallet-sizing-hedge-extraction-2026-08-27.md");
const splitMs = Date.parse("2026-08-22T00:00:00Z");

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => finite(value) ? +Number(value).toFixed(digits) : null;
const pct = (n, d) => d ? round(n / d * 100, 3) : null;
function quantile(values, probability) {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) * probability)];
}
const q = (values) => Object.fromEntries([["p10", .1], ["p25", .25], ["p50", .5],
  ["p75", .75], ["p90", .9]].map(([name, probability]) => [name, round(quantile(values, probability))]));
const startMs = (slug) => Number(String(slug).split("-").at(-1)) * 1000;

const actions = JSON.parse(zlib.gunzipSync(fs.readFileSync(actionFile))).rows
  .sort((a, b) => a.decisionMs - b.decisionMs);
const positives = JSON.parse(zlib.gunzipSync(fs.readFileSync(sampleFile))).positives;
const signedGroups = JSON.parse(zlib.gunzipSync(fs.readFileSync(signedFile))).groups;
const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const branchModel = JSON.parse(fs.readFileSync(branchModelFile, "utf8"));
const residualModel = JSON.parse(fs.readFileSync(residualModelFile, "utf8"));
const signedByHash = new Map(signedGroups.map((row) => [row.orderHash, row]));
const sampleByAction = new Map(positives.map((row) => [`${row.slug}:${row.fillMs}:${row.side}`, row]));
const winnerBySlug = new Map(cohort.markets.map((row) => [row.slug, row.winner]));

const rows = actions.map((action) => {
  const orders = action.orderHashes.map((hash) => signedByHash.get(hash)).filter(Boolean);
  const sideSign = action.outcome === "Up" ? 1 : -1;
  const beforeOriented = Number(action.beforeImbalance) * sideSign;
  const afterOriented = Number(action.afterImbalance) * sideSign;
  const signedShares = orders.reduce((sum, row) => sum + Number(row.signedShares), 0);
  const signedBudgetUsd = orders.reduce((sum, row) => sum + Number(row.signedBudgetUsd), 0);
  const sample = sampleByAction.get(`${action.slug}:${action.fireMs}:${action.outcome}`) || {};
  return {
    ...action,
    joinedOrders: orders.length,
    allOrdersJoined: orders.length === action.orderHashes.length,
    orders,
    sideSign,
    beforeOriented,
    afterOriented,
    signedShares,
    signedBudgetUsd,
    signedLimit: signedShares > 0 ? signedBudgetUsd / signedShares : null,
    signedAfterAtLimit: beforeOriented + signedShares,
    fillExpansion: signedShares > 0 ? Number(action.filledShares) / signedShares : null,
    timeS: (Number(action.decisionMs) - startMs(action.slug)) / 1000,
    sample,
  };
});

function constructionStats(selected) {
  const orders = selected.flatMap((row) => row.orders.map((order) => ({
    signedIntoMs: Number(order.signedTimestampMs) - startMs(row.slug),
    decisionLeadMs: Number(row.decisionMs) - Number(order.signedTimestampMs),
  })));
  return {
    orders: orders.length,
    signedWithin15sPct: pct(orders.filter((row) => row.signedIntoMs <= 15_000).length, orders.length),
    signedWithin30sPct: pct(orders.filter((row) => row.signedIntoMs <= 30_000).length, orders.length),
    releasedAtLeast20sLaterPct: pct(orders.filter((row) => row.decisionLeadMs >= 20_000).length, orders.length),
    releasedAtLeast60sLaterPct: pct(orders.filter((row) => row.decisionLeadMs >= 60_000).length, orders.length),
    signedIntoMs: q(orders.map((row) => row.signedIntoMs)),
    decisionLeadMs: q(orders.map((row) => row.decisionLeadMs)),
  };
}

function roleStats(role) {
  const selected = rows.filter((row) => row.role === role);
  return {
    actions: selected.length,
    signedMinimumShares: q(selected.map((row) => row.signedShares)),
    signedBudgetUsd: q(selected.map((row) => row.signedBudgetUsd)),
    signedLimit: q(selected.map((row) => row.signedLimit)),
    beforeOriented: q(selected.map((row) => row.beforeOriented)),
    afterOriented: q(selected.map((row) => row.afterOriented)),
    fillExpansion: q(selected.map((row) => row.fillExpansion)),
    construction: constructionStats(selected),
  };
}

const entryTimeBands = [[0, 60], [60, 120], [120, 180], [180, 240], [240, 301]]
  .map(([fromS, toS]) => {
    const selected = rows.filter((row) => row.role === "entry/topup"
      && row.timeS >= fromS && row.timeS < toS);
    return {
      fromS, toS, actions: selected.length,
      signedMinimumSharesP50: round(quantile(selected.map((row) => row.signedShares), .5)),
      postActionResidualP50: round(quantile(selected.map((row) => row.afterOriented), .5)),
      signedLimitP50: round(quantile(selected.map((row) => row.signedLimit), .5)),
    };
  });

function plannedBranchEvaluation(selected) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of selected) {
    const plannedCross = row.signedAfterAtLimit > 0;
    const realizedCross = row.role === "overhedge-cross";
    if (plannedCross && realizedCross) tp++;
    else if (plannedCross) fp++;
    else if (realizedCross) fn++;
    else tn++;
  }
  return {
    rows: selected.length, tp, fp, tn, fn,
    accuracyPct: pct(tp + tn, selected.length),
    crossPrecisionPct: pct(tp, tp + fp),
    crossRecallPct: pct(tp, tp + fn),
  };
}

function transitionStats(role, selected = rows.filter((row) => row.role === role)) {
  return {
    actions: selected.length,
    oldImbalanceAbs: q(selected.map((row) => Math.abs(row.beforeOriented))),
    signedMinimumShares: q(selected.map((row) => row.signedShares)),
    filledToOldImbalanceRatio: q(selected.map((row) => Number(row.filledShares) / Math.abs(row.beforeOriented))),
    postActionResidualAbs: q(selected.map((row) => Math.abs(row.afterOriented))),
    fifoPairCost: q(selected.map((row) => Number(row.sample.fifoPairCost))),
    fifoPairCostAtMostOnePct: pct(selected.filter((row) => finite(row.sample.fifoPairCost)
      && Number(row.sample.fifoPairCost) <= 1).length,
    selected.filter((row) => finite(row.sample.fifoPairCost)).length),
  };
}

const reversals = rows.filter((row) => row.role === "hedge" || row.role === "overhedge-cross");
const reversalsBySlug = new Map();
for (const row of reversals) {
  const selected = reversalsBySlug.get(row.slug) || [];
  selected.push(row); reversalsBySlug.set(row.slug, selected);
}
const lastReversals = [...reversalsBySlug.values()].map((selected) => selected.at(-1));
const allBySlug = new Map();
for (const row of rows) {
  const selected = allBySlug.get(row.slug) || [];
  selected.push(row); allBySlug.set(row.slug, selected);
}
function lastStats(role) {
  const selected = role === "all" ? lastReversals : lastReversals.filter((row) => row.role === role);
  return {
    markets: selected.length,
    shareOfLastReversalsPct: pct(selected.length, lastReversals.length),
    timeS: q(selected.map((row) => row.timeS)),
    ...transitionStats(role, selected),
    orderSideWinnerPct: pct(selected.filter((row) => winnerBySlug.get(row.slug) === row.outcome).length,
      selected.length),
    postActionLeanWinnerPct: pct(selected.filter((row) => {
      const lean = Number(row.afterImbalance) > 0 ? "Up" : Number(row.afterImbalance) < 0 ? "Down" : null;
      return lean != null && winnerBySlug.get(row.slug) === lean;
    }).length, selected.length),
  };
}

const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  target: "0x75cc3b63a2f2423085e10706c78b494017b93ce1",
  scope: "strict V2/V4 consensus BTC five-minute target actions, Aug 16-25",
  actions: rows.length,
  decodedOrderJoinPct: pct(rows.filter((row) => row.allOrdersJoined).length, rows.length),
  definitions: {
    orientedInventory: "(Up shares - Down shares) * signal-side sign; negative means the action opposes current inventory",
    signedMinimumShares: "minimum tokens encoded in the BUY at its signed price cap",
    fixedBudgetUsd: "signed price cap * signed minimum shares",
    actualFilledShares: "fixed budget / realized execution price, subject to partial fill",
  },
  menuEvidence: constructionStats(rows),
  roles: {
    entryTopup: roleStats("entry/topup"),
    hedge: roleStats("hedge"),
    overhedgeCross: roleStats("overhedge-cross"),
  },
  entrySizing: {
    identity: "Q_min is selected from a pre-signed integer-share menu; budgetUsd = cap * Q_min",
    observedResidualLadderByFireMinute: entryTimeBands,
    approximation: "Q_min = max(5, round(R_target(time, price, confidence) - orientedInventory))",
  },
  reversalSizing: {
    exactPositionIdentity: "afterOriented = beforeOriented + actualFilledShares",
    plannedBranchRule: "beforeOriented + signedMinimumShares > 0 means the signed order intends to cross; otherwise it intends to trim",
    plannedBranchAll: plannedBranchEvaluation(reversals),
    plannedBranchFit: plannedBranchEvaluation(reversals.filter((row) => row.decisionMs < splitMs)),
    plannedBranchHoldout: plannedBranchEvaluation(reversals.filter((row) => row.decisionMs >= splitMs)),
    partialHedge: {
      formula: "desiredFillShares = abs(beforeOriented) - desiredOldSideResidual",
      ...transitionStats("hedge"),
    },
    overhedgeCross: {
      formula: "desiredFillShares = abs(beforeOriented) + desiredNewSideResidual",
      ...transitionStats("overhedge-cross"),
    },
    signedBudgetConversion: "Q_min ~= ceil(desiredFillShares * expectedFillPrice / signedPriceCap); budgetUsd = signedPriceCap * Q_min",
  },
  lastOppositeSideAction: {
    definition: "chronologically last hedge or overhedge-cross action in each market",
    markets: lastReversals.length,
    alsoFinalActionInMarketPct: pct(lastReversals.filter((row) => allBySlug.get(row.slug)?.at(-1) === row).length,
      lastReversals.length),
    partialHedge: lastStats("hedge"),
    overhedgeCross: lastStats("overhedge-cross"),
  },
  heldOutModels: {
    branch: branchModel.model.holdout,
    residualSize: residualModel.holdout,
  },
  conclusion: {
    exactPrivateLogicRecovered: false,
    runtimePromotion: false,
    reason: "The inventory arithmetic and menu encoding are exact, but public settled orders reveal only the menu item that fired, not the complete private menu or its confidence state.",
  },
};

const hedge = report.reversalSizing.partialHedge;
const cross = report.reversalSizing.overhedgeCross;
const lastHedge = report.lastOppositeSideAction.partialHedge;
const lastCross = report.lastOppositeSideAction.overhedgeCross;
const ladderRows = entryTimeBands.map((row) =>
  `| ${row.fromS}-${Math.min(300, row.toS)}s | ${row.actions} | ${row.signedMinimumSharesP50} | ${row.postActionResidualP50} | ${row.signedLimitP50} |`).join("\n");
const markdown = `# Target-wallet order sizing and last-hedge extraction\n\n` +
  `Strict consensus analysis of ${rows.length.toLocaleString()} BTC five-minute actions with ${report.decodedOrderJoinPct}% decoded signed-order coverage. This is research-only and is not wired into FastMX.\n\n` +
  `## Core finding: a pre-signed order menu\n\n` +
  `The target does not appear to calculate a new arbitrary quantity at fire time. ${report.menuEvidence.signedWithin15sPct}% of decoded orders were signed within 15 seconds of market open, and ${report.menuEvidence.releasedAtLeast20sLaterPct}% were released at least 20 seconds after signing. For hedge/cross orders specifically, ${report.roles.hedge.construction.releasedAtLeast20sLaterPct}%/${report.roles.overhedgeCross.construction.releasedAtLeast20sLaterPct}% were released at least 20 seconds later. The fire selects a pre-sized integer-share order at a cent price cap.\n\n` +
  `For every BUY: \`budgetUsd = signedPriceCap * signedMinimumShares\`. Actual shares can differ because \`filledShares = spentBudget / executionPrice\` or because the order partially fills.\n\n` +
  `## Entry/top-up sizing\n\n` +
  `The entry size is best represented as a target inventory residual, not a constant order size:\n\n` +
  `\`Q_min = max(5, round(R_target(time, price, confidence) - orientedInventory))\`\n\n` +
  `| Fire time | Actions | Median signed shares | Median post-action residual | Median signed cap |\n` +
  `|---|---:|---:|---:|---:|\n${ladderRows}\n\n` +
  `The strict held-out residual model has median absolute error ${report.heldOutModels.residualSize.medianAbsoluteError} shares versus ${report.heldOutModels.residualSize.baselineMedianAbsoluteError} for one constant residual. Its >=16-share precision is ${report.heldOutModels.residualSize.large16PrecisionPct}%, but recall is ${report.heldOutModels.residualSize.large16RecallPct}%; the private tail-sizing state is not fully observable.\n\n` +
  `## Hedge and cross sizing\n\n` +
  `An opposite-side signal first creates \`I = orientedInventory < 0\`. The selected order then implies one of two transitions:\n\n` +
  `- Partial hedge: \`desiredFill = abs(I) - oldSideResidual\`. Median old imbalance ${hedge.oldImbalanceAbs.p50}, fill/imbalance ratio ${hedge.filledToOldImbalanceRatio.p50}, and remaining old-side residual ${hedge.postActionResidualAbs.p50} shares.\n` +
  `- Overhedge-cross: \`desiredFill = abs(I) + newSideResidual\`. Median old imbalance ${cross.oldImbalanceAbs.p50}, fill/imbalance ratio ${cross.filledToOldImbalanceRatio.p50}, and new-side residual ${cross.postActionResidualAbs.p50} shares.\n\n` +
  `The simple signed-order test \`I + Q_min > 0\` identifies realized cross versus partial hedge with ${report.reversalSizing.plannedBranchHoldout.accuracyPct}% held-out accuracy, ${report.reversalSizing.plannedBranchHoldout.crossPrecisionPct}% precision, and ${report.reversalSizing.plannedBranchHoldout.crossRecallPct}% recall. The remaining errors are mostly price improvement or partial fills moving the realized transition across zero.\n\n` +
  `This is signal-driven inventory rebalancing, not a guaranteed pair-value hedge: only ${hedge.fifoPairCostAtMostOnePct}% of partial hedges and ${cross.fifoPairCostAtMostOnePct}% of crosses had reconstructed FIFO pair cost <= $1.\n\n` +
  `## Last opposite-side action in each market\n\n` +
  `Across ${lastReversals.length} markets with a reversal, the last reversal was a partial hedge in ${lastHedge.markets} (${lastHedge.shareOfLastReversalsPct}%) and a cross in ${lastCross.markets} (${lastCross.shareOfLastReversalsPct}%). It was also the market's final action only ${report.lastOppositeSideAction.alsoFinalActionInMarketPct}% of the time.\n\n` +
  `- Last partial hedge: median time ${lastHedge.timeS.p50}s, signed size ${lastHedge.signedMinimumShares.p50}, and old-side residual ${lastHedge.postActionResidualAbs.p50}. Its order side ultimately won ${lastHedge.orderSideWinnerPct}%, while the remaining old lean won only ${lastHedge.postActionLeanWinnerPct}%. This is usually a risk reduction without crossing.\n` +
  `- Last cross: median time ${lastCross.timeS.p50}s, signed size ${lastCross.signedMinimumShares.p50}, and new-side residual ${lastCross.postActionResidualAbs.p50}. Its new side ultimately won ${lastCross.orderSideWinnerPct}%.\n\n` +
  `## Extraction boundary\n\n` +
  `The position arithmetic, fixed-budget encoding, and selected-order branch are recovered. The exact private menu-generation/confidence rule is not: public data exposes only orders that fired. The causal branch classifier reaches held-out AUC ${report.heldOutModels.branch.auc} and ${report.heldOutModels.branch.accuracyPct}% accuracy, so this should be treated as an approximation, not a 98% clone. No runtime logic was changed.\n`;

fs.mkdirSync(resultDir, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(outputMd, markdown);
console.log(markdown);
console.log(JSON.stringify({ outputJson, outputMd, actions: rows.length,
  menuEvidence: report.menuEvidence, plannedBranchHoldout: report.reversalSizing.plannedBranchHoldout,
  lastOppositeSideAction: report.lastOppositeSideAction }, null, 2));
