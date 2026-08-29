#!/usr/bin/env node
// Fit/validation screen for execution and inventory policy only. The two
// current direction signals stay enabled, unchanged, and agreement-gated.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/helpme.js";

const dataRoot = path.resolve(process.argv[2] || "data/wallet-75cc");
const resultRoot = path.resolve(process.argv[3] || "research/wallet-75cc/results");
const fitEndMs = Date.parse(process.argv[4] || "2026-08-21T00:00:00Z");
const validationEndMs = Date.parse(process.argv[5] || "2026-08-22T00:00:00Z");
const screenKind = process.argv[6] || "policy";
const evaluationStartMs = Date.parse(process.argv[7] || "1970-01-01T00:00:00Z");
const cohortFile = path.join(dataRoot, "cohort-2026-08-16_2026-08-26-btc.json");
const feedDir = path.join(dataRoot, "feeds/v2-l2");
const outputJson = path.join(resultRoot, `fastmx-execution-${screenKind}-screen-2026-08-27.json`);
const startMs = (slug) => Number(slug.split("-").at(-1)) * 1000;
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const core = { ...STRAT, H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true };
const mode = (minAsk, maxAsk, maxOrders, extra = {}) => ({ ...core,
  H_MIN_ASK: minAsk, H_MAX_ASK: maxAsk, H_MAX_ORDERS: maxOrders, ...extra });
const policyModes = {
  declaredBaseline: mode(.05, .98, 7, { H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 7 }),
  savedRuntime: mode(.05, .98, 30, { H_EXEC_RUN_MS: 0, H_COOLDOWN_MS: 1000,
    H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 0 }),
  band50_80_n1: mode(.50, .80, 1),
  band50_80_n2: mode(.50, .80, 2),
  band50_80_n3: mode(.50, .80, 3),
  band55_80_n2: mode(.55, .80, 2),
  band60_80_n2: mode(.60, .80, 2),
  band50_75_n2: mode(.50, .75, 2),
  band50_85_n2: mode(.50, .85, 2),
  band45_80_n2: mode(.45, .80, 2),
  band50_80_n2_noHedge: mode(.50, .80, 2, { H_HEDGING_ON: false }),
  band50_80_n2_flatHedge: mode(.50, .80, 2, { H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 0 }),
  band50_80_n3_flatHedge: mode(.50, .80, 3, { H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 0 }),
};
const thresholdModes = {
  band50_85_n2_bz6_mid08: mode(.50, .85, 2),
  band50_85_n1_bz6_mid08: mode(.50, .85, 1),
  band50_85_n2_bz12_mid08: mode(.50, .85, 2, { H_BINANCE_GAP_VELOCITY_MIN: 12 }),
  band50_85_n2_bz20_mid08: mode(.50, .85, 2, { H_BINANCE_GAP_VELOCITY_MIN: 20 }),
  band50_85_n2_bz30_mid08: mode(.50, .85, 2, { H_BINANCE_GAP_VELOCITY_MIN: 30 }),
  band50_85_n2_bz40_mid08: mode(.50, .85, 2, { H_BINANCE_GAP_VELOCITY_MIN: 40 }),
  band50_85_n2_bz6_mid10: mode(.50, .85, 2, { H_MID_VELOCITY_MIN: .10 }),
  band50_85_n2_bz6_mid12: mode(.50, .85, 2, { H_MID_VELOCITY_MIN: .12 }),
  band50_85_n2_bz12_mid10: mode(.50, .85, 2,
    { H_MID_VELOCITY_MIN: .10, H_BINANCE_GAP_VELOCITY_MIN: 12 }),
  band50_85_n2_bz20_mid10: mode(.50, .85, 2,
    { H_MID_VELOCITY_MIN: .10, H_BINANCE_GAP_VELOCITY_MIN: 20 }),
  band50_85_n2_bz30_mid10: mode(.50, .85, 2,
    { H_MID_VELOCITY_MIN: .10, H_BINANCE_GAP_VELOCITY_MIN: 30 }),
  band50_85_n2_bz20_mid12: mode(.50, .85, 2,
    { H_MID_VELOCITY_MIN: .12, H_BINANCE_GAP_VELOCITY_MIN: 20 }),
  band50_85_n2_bz30_mid12: mode(.50, .85, 2,
    { H_MID_VELOCITY_MIN: .12, H_BINANCE_GAP_VELOCITY_MIN: 30 }),
};
const frozenSignal = { H_MID_VELOCITY_MIN: .12, H_BINANCE_GAP_VELOCITY_MIN: 30 };
const safeHedge = (extra = {}) => ({ ...frozenSignal, H_HEDGING_ON: true,
  H_HEDGE_VALUE_GATE_ON: true, H_HEDGE_MIN_PAIR_EDGE: .01,
  H_BOUNDED_HEDGE_SHARES: true, ...extra });
const hedgeModes = {
  frozenBaseline: mode(.50, .85, 2, { ...frozenSignal, H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 7 }),
  frozenOneOrder: mode(.50, .85, 1, frozenSignal),
  frozenNoHedge: mode(.50, .85, 2, { ...frozenSignal, H_HEDGING_ON: false }),
  safeFlatEdge0: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 0, H_HEDGE_MIN_PAIR_EDGE: 0 })),
  safeFlatEdge1: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 0, H_HEDGE_MIN_PAIR_EDGE: .01 })),
  safeFlatEdge2: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 0, H_HEDGE_MIN_PAIR_EDGE: .02 })),
  safeReverse7Edge0: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7, H_HEDGE_MIN_PAIR_EDGE: 0 })),
  safeReverse7Edge1: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7, H_HEDGE_MIN_PAIR_EDGE: .01 })),
  safeReverse7Edge2: mode(.50, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7, H_HEDGE_MIN_PAIR_EDGE: .02 })),
  safeReverse7Edge1Band50_80: mode(.50, .80, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7 })),
  safeReverse7Edge1Band55_85: mode(.55, .85, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7 })),
  valueGateUnbounded: mode(.50, .85, 2, { ...frozenSignal, H_HEDGING_ON: true,
    H_CROSS_RESIDUAL_SH: 7, H_HEDGE_VALUE_GATE_ON: true, H_HEDGE_MIN_PAIR_EDGE: .01,
    H_BOUNDED_HEDGE_SHARES: false }),
};
const frozenPrimary = mode(.50, .80, 2, safeHedge({ H_CROSS_RESIDUAL_SH: 7 }));
const holdoutModes = {
  declaredBaseline: mode(.05, .98, 7, { H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 7 }),
  savedRuntime: mode(.05, .98, 30, { H_EXEC_RUN_MS: 0, H_COOLDOWN_MS: 1000,
    H_HEDGING_ON: true, H_CROSS_RESIDUAL_SH: 0 }),
  frozenPrimary,
  frozenPrimaryHedgeOff: { ...frozenPrimary, H_HEDGING_ON: false },
};
const finalModes = {
  safeCurrent: { ...STRAT, H_CLOB_MID_VELOCITY_ON: true, H_BINANCE_GAP_MOMENTUM_ON: true },
  safeCurrentHedgeOff: { ...STRAT, H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true, H_HEDGING_ON: false },
};
const modes = screenKind === "threshold" ? thresholdModes
  : screenKind === "hedge" ? hedgeModes
    : screenKind === "holdout" ? holdoutModes
      : screenKind === "final" ? finalModes : policyModes;

const cohort = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const markets = cohort.markets.filter((market) => market.winner && market.slug.startsWith("btc-")
  && startMs(market.slug) >= evaluationStartMs
  && startMs(market.slug) < validationEndMs
  && fs.existsSync(path.join(feedDir, `${market.slug}.json.gz`)))
  .sort((left, right) => startMs(left.slug) - startMs(right.slug));

function nestedBook(raw) {
  const asks = raw?.asks || [], bids = raw?.bids || [];
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

function marketResult(feed, market, ws, params) {
  const ticks = (feed.ticks || []).map((tick) => {
    const up = nestedBook(tick.up), down = nestedBook(tick.down);
    return { t: (tick.ms - ws) / 1000, ms: tick.ms, bz: tick.bz, cl: tick.cl,
      upAsk: up.bestAsk, dnAsk: down.bestAsk, upBid: up.bestBid, dnBid: down.bestBid,
      up, down };
  });
  const fills = simulateFills({ ticks, openBinance: feed.openBinance,
    openPrice: feed.openChainlink, windowStart: ws / 1000 }, params);
  const pos = positionFromFills(fills, market.winner, ticks);
  const winnerShares = market.winner === "Up" ? pos.upShares : pos.downShares;
  const loserShares = market.winner === "Up" ? pos.downShares : pos.upShares;
  return { orders: fills.length, cost: pos.totalCost, fees: pos.fee, pnl: pos.realizedPnl,
    winnerMinusLoserShares: winnerShares - loserShares };
}

function summarize(rows) {
  let active = 0, orders = 0, cost = 0, fees = 0, pnl = 0, wins = 0;
  let equity = 0, peak = 0, maxDrawdown = 0, shareGap = 0, wrongDominance = 0;
  const daily = new Map();
  for (const row of rows) {
    if (row.orders > 0) {
      active++; shareGap += row.winnerMinusLoserShares;
      if (row.winnerMinusLoserShares < -1e-9) wrongDominance++;
    }
    orders += row.orders; cost += row.cost; fees += row.fees; pnl += row.pnl;
    if (row.pnl > 0) wins++;
    equity += row.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    const current = daily.get(row.day) || 0; daily.set(row.day, current + row.pnl);
  }
  const deployed = cost + fees;
  const dailyPnls = [...daily.values()];
  return { markets: rows.length, activeMarkets: active,
    participationPct: rows.length ? round(active / rows.length * 100, 3) : null,
    orders, ordersPerActive: active ? round(orders / active, 3) : null,
    cost: round(cost), fees: round(fees), pnl: round(pnl),
    roiPct: deployed ? round(pnl / deployed * 100, 3) : null,
    winRatePct: active ? round(wins / active * 100, 3) : null,
    maxDrawdown: round(maxDrawdown),
    profitableDays: dailyPnls.filter((value) => value > 0).length,
    losingDays: dailyPnls.filter((value) => value < 0).length,
    worstDayPnl: dailyPnls.length ? round(Math.min(...dailyPnls)) : null,
    meanWinnerMinusLoserShares: active ? round(shareGap / active) : null,
    wrongDominancePct: active ? round(wrongDominance / active * 100, 3) : null,
    daily: Object.fromEntries([...daily].map(([day, value]) => [day, round(value)])) };
}

const windows = [];
for (let index = 0; index < markets.length; index++) {
  const market = markets[index], ws = startMs(market.slug);
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feedDir, `${market.slug}.json.gz`))));
  windows.push({ slug: market.slug, startMs: ws, day: new Date(ws).toISOString().slice(0, 10),
    results: Object.fromEntries(Object.entries(modes).map(([name, params]) =>
      [name, marketResult(feed, market, ws, params)])) });
  if ((index + 1) % 50 === 0 || index + 1 === markets.length) {
    console.log(JSON.stringify({ phase: "fit-validation-screen", done: index + 1, total: markets.length }));
  }
}

const splits = {
  fit: windows.filter((row) => row.startMs < fitEndMs),
  validation: windows.filter((row) => row.startMs >= fitEndMs),
  fitPlusValidation: windows,
};
const report = { schema: 1, generatedAt: new Date().toISOString(),
  method: "exact engine replay; only execution/inventory parameters vary",
  fitEnd: new Date(fitEndMs).toISOString(), validationEnd: new Date(validationEndMs).toISOString(),
  modes,
  results: Object.fromEntries(Object.entries(splits).map(([split, rows]) => [split,
    Object.fromEntries(Object.keys(modes).map((name) => [name,
      summarize(rows.map((row) => ({ ...row.results[name], day: row.day }))) ]))])),
  caveat: "Selection screen only. Candidates must be frozen before evaluating Aug 22-25 holdout.",
};
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputJson, results: report.results }, null, 2));
