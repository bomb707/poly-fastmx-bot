import assert from "node:assert/strict";
import test from "node:test";
import { auditForwardSource, auditHistoricalSelection } from "./passive-maker-forward-audit-v17.mjs";

const START = "2026-08-25T12:55:00.000Z";
const TARGET = "2026-09-24T12:55:00.000Z";
const dates = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 7, 25) + index * 86_400_000).toISOString().slice(0, 10);
  return [day, 1];
}));

function row(latencyMs, makerCredit, enabled = true) {
  return {
    params: {
      latencyMs, makerCredit, makerTradingEnabled: enabled,
      fillSource: "trades", tradePriceMode: "exact", postOnly: true,
      makerRebateRate: 0, takerLatencyMs: 520, safeHedgeEveryTick: false,
      endLiquidateS: 0, unpairedTimeoutS: 0, residualTargetShares: 5,
      residualBaseOrderShares: 5,
    },
    activeWindows: enabled ? 120 : 0,
    placements: enabled ? 10 : 0,
    cancels: enabled ? 9 : 0,
    makerFillEvents: enabled ? 3 : 0,
    takerFillEvents: 0,
    makerShares: enabled ? 5 : 0,
    takerShares: 0,
    takerBuyShares: 0,
    takerSellShares: 0,
    cost: enabled ? 2 : 0,
    grossBuySpend: enabled ? 2 : 0,
    grossSellProceeds: 0,
    fees: 0,
    makerRebate: 0,
    pnl: enabled ? 30 : 0,
    maxDrawdown: enabled ? 4 : 0,
    profitFactor: enabled ? 2 : 0,
    bootstrapWindowLower95: enabled ? 2 : 0,
    bootstrapDayLower95: enabled ? 3 : 0,
    daily: enabled ? dates : {},
  };
}

function checkpoint() {
  const diagnostics = {};
  for (const latency of [130, 200, 300]) {
    for (const credit of [0.025, 0.05, 0.075, 0.1]) {
      diagnostics[`${latency}-${credit}`] = row(latency, credit, latency !== 300);
    }
  }
  return {
    range: { from: START, to: TARGET, discovered: 8640, loaded: 8640, failed: 0 },
    diagnostics,
  };
}

test("complete stress matrix passes strict forward gates", () => {
  const result = auditForwardSource(checkpoint(), "v2", START, TARGET, Date.parse(TARGET) + 60_000);
  assert.equal(result.passed, true);
  assert.equal(Object.keys(result.enabled).length, 8);
  assert.equal(Object.keys(result.paused).length, 4);
});
test("one weak stress cell rejects the entire source", () => {
  const output = checkpoint();
  output.diagnostics["200-0.1"].bootstrapDayLower95 = -0.01;
  const result = auditForwardSource(output, "v4", START, TARGET, Date.parse(TARGET) + 60_000);
  assert.equal(result.passed, false);
  assert.equal(result.enabled["200ms/0.100"].requirements.dayBootstrapLower95Positive, false);
});

test("historical headline gains cannot bypass missing neighborhood validation", () => {
  const source = {
    historical: { pnl: 20, bootstrapWindowLower95: 2, bootstrapDayLower95: 2,
      profitFactor: 2, maxDrawdown: 4, activeWindows: 80 },
    folds: [{ pnl: 1 }, { pnl: 2 }, { pnl: 3 }],
  };
  const result = auditHistoricalSelection({
    range: { historicalEnd: TARGET, freshStart: TARGET },
    selected: { name: "candidate", sources: { v2: source, v4: source }, historicalPassed: true,
      acceptedHistorical: true, neighborhood: { robust: false, tested: 0, passed: 0 } },
  });
  assert.equal(result.requirements.bothSourcesPassCoreMetrics, true);
  assert.equal(result.requirements.immediateNeighborhoodRobust, false);
  assert.equal(result.passed, false);
});
