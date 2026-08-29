#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "../..");
const dataDir = path.resolve(process.argv[2] || path.join(ROOT, "data/wallet-3048"));
const tradesFile = path.resolve(process.argv[3] || path.join(dataDir, "trades-2026-08-14_2026-08-22.json"));
const raw = JSON.parse(fs.readFileSync(tradesFile, "utf8"));
const marketBySlug = new Map(raw.markets.map((market) => [market.slug, market]));
const tradedSlugs = [...new Set(raw.trades.map((row) => row.slug))].filter((slug) => marketBySlug.get(slug)?.winner).sort();
const targetByDay = new Map();
for (const row of raw.trades) {
  const day = new Date(row.timestamp * 1000).toISOString().slice(0, 10);
  if (!targetByDay.has(day)) targetByDay.set(day, { fills: 0, maker: 0 });
  const value = targetByDay.get(day);
  value.fills++;
  if (row.role === "maker") value.maker++;
}

const fee = (price, shares, taker) => taker ? 0.07 * price * (1 - price) * shares : 0;
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const pct = (value, total) => total ? round(value / total * 100, 3) : null;

function readFeed(slug, l2 = false) {
  const version = l2 ? "v4-l2" : "v4-top";
  const feed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "feeds", version, `${slug}.json.gz`))));
  if (l2) {
    // The older L2 research cache also carries v4 priceUp/priceDown midpoint
    // fields as upAsk/dnAsk. Replace them with the actual book asks.
    for (const tick of feed.ticks) {
      tick.upAsk = tick.up?.bestAsk ?? tick.up?.asks?.[0]?.price ?? null;
      tick.dnAsk = tick.down?.bestAsk ?? tick.down?.asks?.[0]?.price ?? null;
    }
  }
  return feed;
}

function asksFor(tick, side) {
  const book = side === "Up" ? tick.up : tick.down;
  return book?.asks || null;
}

function walkAtLimit(tick, side, requested, limit) {
  const asks = asksFor(tick, side);
  if (!asks) {
    const price = side === "Up" ? tick.upAsk : tick.dnAsk;
    return price != null && price <= limit + 1e-9 ? { shares: requested, price, partial: false } : null;
  }
  let left = requested, shares = 0, usd = 0;
  for (const level of asks) {
    if (level.price > limit + 1e-9 || left <= 1e-9) break;
    const take = Math.min(left, level.size);
    shares += take; usd += take * level.price; left -= take;
  }
  return shares > 1e-9 ? { shares, price: usd / shares, partial: left > 1e-9 } : null;
}

function priorIndex(ticks, index, lookbackMs) {
  let lo = 0, hi = index, answer = 0;
  const target = ticks[index].ms - lookbackMs;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].ms <= target) { answer = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return answer;
}

function firstLotCost(lots, shares) {
  let left = shares, cost = 0, used = 0;
  for (const lot of lots) {
    const take = Math.min(left, lot.shares);
    cost += take * lot.effectivePrice; used += take; left -= take;
    if (left <= 1e-9) break;
  }
  return used > 1e-9 ? cost / used : null;
}

function applyLot(state, side, shares, effectivePrice) {
  const opposite = side === "Up" ? "Down" : "Up";
  let left = shares;
  while (left > 1e-9 && state.lots[opposite].length) {
    const lot = state.lots[opposite][0];
    const take = Math.min(left, lot.shares);
    left -= take; lot.shares -= take; state.pairedShares += take;
    if (lot.shares <= 1e-9) state.lots[opposite].shift();
  }
  if (left > 1e-9) state.lots[side].push({ shares: left, effectivePrice });
}

function simulate(feed, market, params) {
  const ws = Number(feed.slug.split("-").at(-1)) * 1000;
  const state = {
    up: 0, down: 0, cost: 0, fees: 0, fills: [], pending: [], lots: { Up: [], Down: [] },
    cancels: 0, partials: 0, pairedShares: 0, lastDecisionMs: -Infinity,
  };
  const sideAsk = (tick, side) => side === "Up" ? tick.upAsk : tick.dnAsk;
  const fill = (order, tick, role, execution) => {
    const shares = execution.shares;
    const taker = role === "taker";
    const chargedFee = fee(execution.price, shares, taker);
    state.cost += execution.price * shares + chargedFee;
    state.fees += chargedFee;
    if (order.side === "Up") state.up += shares; else state.down += shares;
    applyLot(state, order.side, shares, execution.price + chargedFee / shares);
    state.fills.push({ side: order.side, role, shares, price: execution.price, decidedMs: order.decidedMs, fillMs: tick.ms, partial: execution.partial, reason: order.reason });
    if (execution.partial) state.partials++;
    const left = order.shares - shares;
    if (left > 1e-9 && tick.ms < order.expiresMs) {
      order.shares = left;
      order.status = "resting";
      order.restedMs = tick.ms;
      return false;
    }
    return true;
  };

  for (let index = 0; index < feed.ticks.length; index++) {
    const tick = feed.ticks[index];
    const t = (tick.ms - ws) / 1000;
    // Marketable GTC: cross on arrival if the ask is at/below the cap; if it
    // moved away, retain the remainder as a quote until timeout/cancel.
    for (let p = state.pending.length - 1; p >= 0; p--) {
      const order = state.pending[p];
      if (tick.ms >= order.expiresMs) {
        state.pending.splice(p, 1); state.cancels++; continue;
      }
      if (order.status === "transit" && tick.ms >= order.arrivesMs) {
        const execution = walkAtLimit(tick, order.side, order.shares, order.limit);
        if (execution) {
          if (fill(order, tick, "taker", execution)) state.pending.splice(p, 1);
        } else {
          order.status = "resting"; order.restedMs = tick.ms;
        }
      } else if (order.status === "resting" && tick.ms > order.restedMs) {
        const ask = sideAsk(tick, order.side);
        if (ask != null && ask <= order.limit + 1e-9) {
          // Queue position is unknowable. This branch is explicitly the
          // optimistic maker-fill scenario; the all-taker benchmark below is
          // reported separately.
          const execution = { shares: order.shares, price: order.limit, partial: false };
          if (fill(order, tick, "maker", execution)) state.pending.splice(p, 1);
        }
      }
    }

    if (t < params.startS || t > params.endS || tick.bz == null || tick.ms - state.lastDecisionMs < params.cooldownMs) continue;
    const previous = feed.ticks[priorIndex(feed.ticks, index, params.lookbackMs)];
    if (!(previous?.bz > 0)) continue;
    const momentumPct = (tick.bz - previous.bz) / previous.bz * 100;
    let side = null, reason = null;

    // Hedge an unmatched lot when the current complement locks a complete-set
    // cost under pairCap. Otherwise use the short Binance impulse for the next
    // inventory-adding order.
    const imbalance = state.up - state.down;
    if (params.pairCap != null && Math.abs(imbalance) > 1e-9) {
      const hedgeSide = imbalance > 0 ? "Down" : "Up";
      const entrySide = imbalance > 0 ? "Up" : "Down";
      const shares = Math.min(params.size, Math.abs(imbalance));
      const priorCost = firstLotCost(state.lots[entrySide], shares);
      const ask = sideAsk(tick, hedgeSide);
      if (priorCost != null && ask != null && priorCost + ask + fee(ask, 1, true) <= params.pairCap) {
        side = hedgeSide; reason = "pair-hedge";
      }
    }
    if (!side && Math.abs(momentumPct) >= params.momentumThresholdPct && Math.abs(momentumPct) > 1e-12) {
      side = momentumPct > 0 ? "Up" : "Down";
      reason = "momentum-entry";
    }
    if (!side || state.pending.some((order) => order.side === side)) continue;
    const ask = sideAsk(tick, side);
    if (!(ask >= params.minPrice && ask <= params.maxPrice)) continue;
    const currentLean = side === "Up" ? state.up - state.down : state.down - state.up;
    if (currentLean >= params.maxLeanShares - 1e-9) continue;
    const limit = Math.min(params.maxPrice, ask + params.limitOffset);
    state.pending.push({
      side, reason, shares: params.size, limit, decidedMs: tick.ms,
      arrivesMs: tick.ms + params.latencyMs,
      expiresMs: tick.ms + params.latencyMs + params.restTimeoutMs,
      status: "transit", restedMs: null,
    });
    state.lastDecisionMs = tick.ms;
    if (params.latencyMs <= 0) {
      const pendingIndex = state.pending.length - 1;
      const order = state.pending[pendingIndex];
      const execution = walkAtLimit(tick, order.side, order.shares, order.limit);
      if (execution) {
        if (fill(order, tick, "taker", execution)) state.pending.splice(pendingIndex, 1);
      } else {
        order.status = "resting";
        order.restedMs = tick.ms;
      }
    }
  }
  state.cancels += state.pending.length;
  const payout = market.winner === "Up" ? state.up : state.down;
  return {
    slug: feed.slug,
    day: new Date(ws).toISOString().slice(0, 10),
    fills: state.fills.length,
    makerFills: state.fills.filter((row) => row.role === "maker").length,
    takerFills: state.fills.filter((row) => row.role === "taker").length,
    entryFills: state.fills.filter((row) => row.reason === "momentum-entry").length,
    hedgeFills: state.fills.filter((row) => row.reason === "pair-hedge").length,
    cancels: state.cancels,
    partials: state.partials,
    up: state.up, down: state.down, pairedShares: state.pairedShares,
    cost: state.cost, fees: state.fees, payout, pnl: payout - state.cost,
  };
}

function aggregate(results) {
  const total = (field) => results.reduce((sum, row) => sum + row[field], 0);
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const result of results) {
    equity += result.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const cost = total("cost"), pnl = total("pnl"), fills = total("fills");
  return {
    windows: results.length,
    activeWindows: results.filter((row) => row.fills > 0).length,
    profitableWindows: results.filter((row) => row.pnl > 0).length,
    fills,
    makerFills: total("makerFills"), takerFills: total("takerFills"), makerPct: pct(total("makerFills"), fills),
    entryFills: total("entryFills"), hedgeFills: total("hedgeFills"), cancels: total("cancels"), partials: total("partials"),
    pairedShares: round(total("pairedShares")), cost: round(cost, 2), fees: round(total("fees"), 2), payout: round(total("payout"), 2),
    pnl: round(pnl, 2), roiPct: pct(pnl, cost), maxDrawdown: round(maxDrawdown, 2), profitableWindowPct: pct(results.filter((row) => row.pnl > 0).length, results.filter((row) => row.fills > 0).length),
  };
}

const defaults = {
  size: 30, startS: 7, endS: 270, minPrice: .12, maxPrice: .89,
  lookbackMs: 1_000, momentumThresholdPct: .005, cooldownMs: 2_000,
  maxLeanShares: 60, pairCap: 1.005,
  latencyMs: 0, restTimeoutMs: 10_000, limitOffset: 0,
};
const candidates = [];
for (const lookbackMs of [1_000, 3_000])
  for (const momentumThresholdPct of [0, .003, .005, .01, .02, .04])
    for (const cooldownMs of [2_000, 5_000])
      for (const maxLeanShares of [60, 90])
        for (const pairCap of [null, .995, 1.005])
          for (const limitOffset of [0, .01])
            candidates.push({ ...defaults, lookbackMs, momentumThresholdPct, cooldownMs, maxLeanShares, pairCap, limitOffset });

console.log(`loading ${tradedSlugs.length} v4 windows`);
const feeds = tradedSlugs.map((slug) => ({ feed: readFeed(slug), market: marketBySlug.get(slug) }));
const fitDays = new Set(["2026-08-17", "2026-08-18"]);
const fitTargetFills = [...targetByDay].filter(([day]) => fitDays.has(day)).reduce((sum, [, row]) => sum + row.fills, 0);
const fitTargetMaker = [...targetByDay].filter(([day]) => fitDays.has(day)).reduce((sum, [, row]) => sum + row.maker, 0);
const candidateResults = [];
for (let index = 0; index < candidates.length; index++) {
  const params = candidates[index];
  const results = feeds.filter(({ feed }) => fitDays.has(new Date(Number(feed.slug.split("-").at(-1)) * 1000).toISOString().slice(0, 10)))
    .map(({ feed, market }) => simulate(feed, market, params));
  const summary = aggregate(results);
  const volumeDistance = Math.abs(Math.log(Math.max(1, summary.fills) / fitTargetFills));
  const makerDistance = Math.abs((summary.makerPct || 0) - pct(fitTargetMaker, fitTargetFills)) / 100;
  const behaviorScore = volumeDistance + makerDistance * 2;
  candidateResults.push({ params, summary, behaviorScore });
  if ((index + 1) % 30 === 0 || index + 1 === candidates.length) console.log(`fit: ${index + 1}/${candidates.length}`);
}
candidateResults.sort((a, b) => a.behaviorScore - b.behaviorScore || b.summary.pnl - a.summary.pnl);
const chosen = candidateResults[0];
const allResults = feeds.map(({ feed, market }) => simulate(feed, market, chosen.params));
const trainResults = allResults.filter((row) => row.day <= "2026-08-18");
const holdoutResults = allResults.filter((row) => row.day >= "2026-08-19");

// Separate profit-selected proxy. This is selected only on the fit period and
// is not claimed to be the wallet clone; its untouched holdout answers whether
// the publicly observable signal core can be made executable/profitable.
const profitChosen = [...candidateResults].filter((row) => row.summary.fills >= 300)
  .sort((a, b) => b.summary.pnl - a.summary.pnl || b.summary.roiPct - a.summary.roiPct)[0];
const profitAllResults = feeds.map(({ feed, market }) => simulate(feed, market, profitChosen.params));
const profitTrainResults = profitAllResults.filter((row) => row.day <= "2026-08-18");
const profitHoldoutResults = profitAllResults.filter((row) => row.day >= "2026-08-19");
const latencyBehaviorResults = feeds.map(({ feed, market }) => simulate(feed, market, { ...chosen.params, latencyMs: 500 }));
const latencyProfitResults = feeds.map(({ feed, market }) => simulate(feed, market, { ...profitChosen.params, latencyMs: 500 }));

const l2Slugs = fs.existsSync(path.join(dataDir, "signal-alignment.json.gz"))
  ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, "signal-alignment.json.gz")))).sampling.l2Windows
  : [];
const l2Results = l2Slugs.filter((slug) => marketBySlug.get(slug)?.winner && fs.existsSync(path.join(dataDir, "feeds/v4-l2", `${slug}.json.gz`)))
  .map((slug) => simulate(readFeed(slug, true), marketBySlug.get(slug), chosen.params));
const profitL2Results = l2Slugs.filter((slug) => marketBySlug.get(slug)?.winner && fs.existsSync(path.join(dataDir, "feeds/v4-l2", `${slug}.json.gz`)))
  .map((slug) => simulate(readFeed(slug, true), marketBySlug.get(slug), profitChosen.params));

const daily = [...new Set(allResults.map((row) => row.day))].sort().map((day) => {
  const modeled = aggregate(allResults.filter((row) => row.day === day));
  const target = targetByDay.get(day) || { fills: 0, maker: 0 };
  return { day, modeled, targetObserved: { fillRows: target.fills, makerPct: pct(target.maker, target.fills) } };
});
const output = {
  schema: 1,
  source: { api: "bapi-v4 recorded Binance and CLOB best asks", from: raw.from, to: raw.to, windows: feeds.length, l2AuditWindows: l2Results.length },
  methodology: {
    fit: "Parameter behavior-fit on Aug 17-18 only; Aug 19-22 is untouched holdout",
    execution: "Primary replay executes marketable GTC at the contemporaneous off-chain v4 book (0ms recorder-tick latency), postOnly=false; an unfilled L2 remainder rests up to 10s. A separate 500ms sensitivity is reported. 7% crypto taker fee curve; maker scenario has zero fee.",
    caveat: "Full range uses v4 full-L2-derived top depth (up to 300 shares/20 levels) and walks up to the GTC limit. Queue position after a remainder rests, and cancellation ownership, remain unknowable.",
  },
  targetFit: { days: [...fitDays], fills: fitTargetFills, makerPct: pct(fitTargetMaker, fitTargetFills) },
  chosenParams: chosen.params,
  behaviorScore: round(chosen.behaviorScore),
  profitProxyParams: profitChosen.params,
  nextBestCandidates: candidateResults.slice(0, 10).map((row) => ({ behaviorScore: round(row.behaviorScore), params: row.params, fit: row.summary })),
  topFitProfitCandidates: [...candidateResults].sort((a, b) => b.summary.pnl - a.summary.pnl).slice(0, 10)
    .map((row) => ({ behaviorScore: round(row.behaviorScore), params: row.params, fit: row.summary })),
  results: {
    behaviorClone: {
      preHoldout_Aug14_18: aggregate(trainResults),
      holdout_Aug19_current: aggregate(holdoutResults),
      fullRange: aggregate(allResults),
      fullL2StratifiedAudit: aggregate(l2Results),
      latency500msSensitivity: aggregate(latencyBehaviorResults),
    },
    profitFilteredProxy: {
      preHoldout_Aug14_18: aggregate(profitTrainResults),
      holdout_Aug19_current: aggregate(profitHoldoutResults),
      fullRange: aggregate(profitAllResults),
      fullL2StratifiedAudit: aggregate(profitL2Results),
      latency500msSensitivity: aggregate(latencyProfitResults),
    },
  },
  daily,
};

const jsonPath = path.join(dataDir, "strategy-backtest.json");
fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2) + "\n");
const mdPath = path.join(dataDir, "strategy-backtest.md");
const p = output.chosenParams, pp = output.profitProxyParams, r = output.results;
const dailyRows = daily.map((row) => `| ${row.day} | ${row.modeled.fills} | ${row.modeled.makerPct}% | $${row.modeled.pnl} | ${row.modeled.roiPct}% | ${row.targetObserved.fillRows} | ${row.targetObserved.makerPct}% |`).join("\n");
const md = `# Reconstructed wallet strategy — v4 backtest\n\n` +
`Behavior fit used Aug 17–18; Aug 19 onward was held out. The selected rule uses ${p.lookbackMs / 1000}s Binance momentum, threshold ${p.momentumThresholdPct}%, ${p.size} shares, ${p.cooldownMs / 1000}s cooldown, ${p.maxLeanShares}-share max lean, pair cap ${p.pairCap}, active t=${p.startS}–${p.endS}s, and price band ${p.minPrice}–${p.maxPrice}. Orders are modeled as GTC/postOnly=false at the current ask with ${p.latencyMs}ms arrival and ${p.restTimeoutMs / 1000}s cancel/replace timeout.\n\n` +
`Behavior clone (visible mechanics/volume fit):\n\n` +
`- Pre-holdout Aug 14–18: $${r.behaviorClone.preHoldout_Aug14_18.pnl}, ${r.behaviorClone.preHoldout_Aug14_18.roiPct}% ROI, ${r.behaviorClone.preHoldout_Aug14_18.fills} fills.\n` +
`- Holdout Aug 19–current: $${r.behaviorClone.holdout_Aug19_current.pnl}, ${r.behaviorClone.holdout_Aug19_current.roiPct}% ROI, ${r.behaviorClone.holdout_Aug19_current.fills} fills.\n` +
`- Full range: $${r.behaviorClone.fullRange.pnl}, ${r.behaviorClone.fullRange.roiPct}% ROI; L2 audit ${r.behaviorClone.fullL2StratifiedAudit.roiPct}%.\n\n` +
`Profit-filtered public-signal proxy (fit-period PnL selected, holdout untouched): ${pp.lookbackMs / 1000}s momentum, ${pp.momentumThresholdPct}% threshold, ${pp.cooldownMs / 1000}s cooldown, limit offset ${pp.limitOffset}.\n\n` +
`- Pre-holdout: $${r.profitFilteredProxy.preHoldout_Aug14_18.pnl}, ${r.profitFilteredProxy.preHoldout_Aug14_18.roiPct}% ROI.\n` +
`- Holdout: $${r.profitFilteredProxy.holdout_Aug19_current.pnl}, ${r.profitFilteredProxy.holdout_Aug19_current.roiPct}% ROI.\n` +
`- Full range: $${r.profitFilteredProxy.fullRange.pnl}, ${r.profitFilteredProxy.fullRange.roiPct}% ROI; L2 audit ${r.profitFilteredProxy.fullL2StratifiedAudit.roiPct}%.\n\n` +
`| UTC day | modeled fills | modeled maker | modeled PnL | ROI | observed rows | observed maker |\n|---|---:|---:|---:|---:|---:|---:|\n${dailyRows}\n\n` +
`This validates a public-data reconstruction, not the private bot byte-for-byte. L2 replay cannot know queue priority, signed GTC flags, private cancellation ownership, or live config changes; executable depth and the holdout are included so those unknowns are not hidden.\n`;
fs.writeFileSync(mdPath, md);
console.log(JSON.stringify({ jsonPath, mdPath, chosen: output.chosenParams, results: output.results }, null, 2));
