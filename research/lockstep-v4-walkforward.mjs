#!/usr/bin/env node
/**
 * Chronological, depth-aware Lockstep research replay.
 *
 * This is intentionally separate from engine/simrun.js.  The normal simulator
 * assumes that a marketable order fills the requested size at one future best
 * ask.  Here every taker fill walks the recorded bapi-v4 ask depth, respects
 * the order's limit at arrival, and charges the crypto taker fee.  Passive
 * hedges are reported under several touch/queue sensitivities because another
 * order's historical queue position is not observable.
 *
 * By default it uses the already-downloaded post-TWAP v4 caches produced by
 * the wallet research.  No target-wallet activity is used by this script.
 *
 * Usage:
 *   node research/lockstep-v4-walkforward.mjs [from=2026-08-14] [to=2026-08-25]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { STRAT, fillFee } from "../engine/strategy.js";
import { computeIntensity, roundExcursion } from "../engine/intensity.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAIR_ONLY = process.env.LOCKSTEP_PAIR_ONLY === "1";
const MODEL_ONLY = process.env.LOCKSTEP_MODEL_ONLY === "1";
const RTDS_ONLY = process.env.LOCKSTEP_RTDS_ONLY === "1";
const AUDIT_ONLY = process.env.LOCKSTEP_AUDIT_ONLY === "1";
const RATIO_ONLY = process.env.LOCKSTEP_RATIO_ONLY === "1";
const ROBUST_ONLY = process.env.LOCKSTEP_ROBUST_ONLY === "1";
const FIXED_PATH = String(process.env.LOCKSTEP_FIXED_PARAMS || "").trim();
const RESEARCH_SIZE = Math.max(1, Math.round(Number(process.env.LOCKSTEP_SIZE || 40)));
const FROM_MS = Date.parse(process.argv[2] || "2026-08-14T00:00:00Z");
const TO_MS = Date.parse(process.argv[3] || "2026-08-25T00:00:00Z");
if (!Number.isFinite(FROM_MS) || !Number.isFinite(TO_MS) || TO_MS <= FROM_MS) throw new Error("invalid from/to range");

const CACHE_DIRS = String(process.env.LOCKSTEP_V4_DIRS || [
  path.join(ROOT, "data/lockstep-v4-top"),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);
const V2_DIRS = String(process.env.LOCKSTEP_V2_DIRS || [
  path.join(ROOT, "data/lockstep-v2-top"),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);

const WINDOW_MS = 300_000;
const EPS = 1e-9;
const slugStart = (slug) => Number(String(slug).split("-").at(-1)) * 1000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;

function readGzip(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
}

function levels(raw) {
  if (Array.isArray(raw) && (raw.length === 0 || typeof raw[0] === "number")) return raw.slice(0, 24).map(Number);
  const rows = (raw?.asks || []).map((row) => [Number(row.price), Number(row.size)])
    .filter((row) => row[0] >= .01 && row[0] <= .99 && row[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let depth = 0;
  for (const [price, size] of rows) {
    out.push(price, size);
    depth += size;
    if ((depth >= 80 && out.length >= 6) || out.length >= 24) break;
  }
  return out;
}

function normalizeFeed(raw, rtds = null) {
  const startMs = slugStart(raw.slug);
  if (!Number.isFinite(startMs)) return null;
  const rtdsTicks = (rtds?.ticks || []).filter((tick) => Number.isFinite(Number(tick.ms))).sort((a, b) => Number(a.ms) - Number(b.ms));
  let rtdsCursor = -1, currentChainlink = null;
  const expanded = (raw.ticks || []).map((tick) => {
    const ms = Number(tick.ms ?? Date.parse(tick.time || ""));
    while (rtdsCursor + 1 < rtdsTicks.length && Number(rtdsTicks[rtdsCursor + 1].ms) <= ms) {
      rtdsCursor++;
      if (Number(rtdsTicks[rtdsCursor].cl) > 0) currentChainlink = Number(rtdsTicks[rtdsCursor].cl);
    }
    const up = levels(tick.up || { asks: tick.upAsks });
    const down = levels(tick.down || { asks: tick.downAsks });
    return {
      ms,
      bz: Number(tick.bz ?? tick.binanceSpotPrice),
      cl: currentChainlink,
      up,
      down,
      upAsk: up[0] ?? Number(tick.upAsk),
      dnAsk: down[0] ?? Number(tick.dnAsk),
    };
  }).filter((tick) => Number.isFinite(tick.ms) && tick.ms >= startMs - 1_000 && tick.ms < startMs + WINDOW_MS + 2_000
      && Number.isFinite(tick.bz) && Number.isFinite(tick.upAsk) && Number.isFinite(tick.dnAsk))
    .sort((a, b) => a.ms - b.ms);
  // Native v4 contains many depth-only updates.  Keep every price/Binance
  // change and otherwise the last depth snapshot per 120 ms bucket.  The live
  // strategy cannot change its decision on an unchanged best ask+spot, while
  // the periodic depth row still preserves arrival execution within 120 ms.
  const ticks = [];
  let pending = null, bucket = null, prior = null;
  for (const tick of expanded) {
    const nextBucket = Math.floor((tick.ms - startMs) / 120);
    const changed = !prior || tick.bz !== prior.bz || tick.upAsk !== prior.upAsk || tick.dnAsk !== prior.dnAsk;
    if (bucket != null && nextBucket !== bucket && pending) { ticks.push(pending); pending = null; }
    if (changed) { if (pending && pending !== tick) ticks.push(pending); ticks.push(tick); }
    else pending = tick;
    bucket = nextBucket;
    prior = tick;
  }
  if (pending) ticks.push(pending);
  if (ticks.length < 30) return null;
  const openBinance = Number(raw.openBinance ?? raw.binanceSpotPriceStart);
  const openChainlink = Number(rtds?.openChainlink ?? raw.openChainlink ?? raw.coinPriceStart);
  const winner = /^up$/i.test(raw.winner) ? "Up" : /^down$/i.test(raw.winner) ? "Down" : null;
  if (!(openBinance > 0) || !winner) return null;
  return {
    slug: raw.slug,
    startMs,
    openBinance,
    openChainlink: openChainlink > 0 ? openChainlink : null,
    winner,
    ticks,
    excursion: roundExcursion(ticks.map((tick) => tick.bz), openBinance),
  };
}

function loadFeeds() {
  const files = new Map();
  // Earlier directories have priority: v4-top has trimmed executable asks and
  // the later full-L2 directories fill its date gaps.
  for (const dir of CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json.gz")) continue;
      const slug = name.slice(0, -8);
      const startMs = slugStart(slug);
      if (startMs >= FROM_MS && startMs < TO_MS && !files.has(slug)) files.set(slug, path.join(dir, name));
    }
  }
  const feeds = [];
  let failed = 0;
  const rtdsFiles = new Map();
  for (const dir of V2_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".json.gz") && !rtdsFiles.has(name.slice(0, -8))) {
      rtdsFiles.set(name.slice(0, -8), path.join(dir, name));
    }
  }
  for (const [slug, file] of files) {
    try {
      const rtds = rtdsFiles.has(slug) ? readGzip(rtdsFiles.get(slug)) : null;
      const feed = normalizeFeed(readGzip(file), rtds);
      if (feed) feeds.push(feed); else failed++;
    } catch { failed++; }
  }
  feeds.sort((a, b) => a.startMs - b.startMs);
  return { feeds, failed, files: files.size, rtdsFiles: rtdsFiles.size, rtdsFeeds: feeds.filter((feed) => feed.openChainlink > 0 && feed.ticks.some((tick) => tick.cl > 0)).length };
}

function firstAtOrAfter(ticks, targetMs, lo = 0) {
  let left = Math.max(0, lo), right = ticks.length - 1, answer = ticks.length;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (ticks[middle].ms >= targetMs) { answer = middle; right = middle - 1; }
    else left = middle + 1;
  }
  return answer;
}

function asks(tick, side) { return side === "Up" ? tick.up : tick.down; }
function bestAsk(tick, side) { return side === "Up" ? tick.upAsk : tick.dnAsk; }

function priorIndex(ticks, index, lookbackMs) {
  const target = ticks[index].ms - lookbackMs;
  let left = 0, right = index, answer = 0;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (ticks[middle].ms <= target) { answer = middle; left = middle + 1; }
    else right = middle - 1;
  }
  return answer;
}

function walk(tick, side, requested, limit) {
  let left = requested, shares = 0, cost = 0;
  const book = asks(tick, side);
  for (let index = 0; index < book.length; index += 2) {
    const price = book[index], size = book[index + 1];
    if (price > limit + EPS || left <= EPS) break;
    const take = Math.min(left, size);
    left -= take;
    shares += take;
    cost += take * price;
  }
  return shares > EPS ? { shares, cost, price: cost / shares, partial: left > EPS } : null;
}

function entryLimit(P, decisionAsk = null) {
  if (!P.STRICT_LIMITS) return Number(P.LIMIT || .99);
  const ceil = Number(P.L_ENTRY_CEIL || 0);
  let limit = ceil > 0 ? Math.min(Number(P.LIMIT || .99), ceil) : Number(P.LIMIT || .99);
  if (decisionAsk != null && P.ENTRY_LIMIT_OFFSET != null) limit = Math.min(limit, round(decisionAsk + Number(P.ENTRY_LIMIT_OFFSET || 0), 2));
  return limit;
}

function hedgeLimit(P, maker, decisionAsk) {
  if (maker) return Math.max(.01, round(decisionAsk - Number(P.L_HEDGE_MAKER_OFFSET ?? .01), 2));
  return P.STRICT_LIMITS ? Math.min(Number(P.LIMIT || .99), Number(P.L_HEDGE_CAP ?? .02)) : Number(P.LIMIT || .99);
}

function pairNet(entryPrice, entryShares, hedgePrice, hedgeShares, hedgeMaker) {
  const paired = Math.min(entryShares, hedgeShares);
  return paired * (1 - entryPrice - hedgePrice)
    - fillFee(entryPrice, paired, true)
    - fillFee(hedgePrice, paired, !hedgeMaker);
}

/** One-entry causal replay with depth, latency, strict limits, and maker TTL. */
function replayWindow(feed, intensity, P) {
  const ticks = feed.ticks;
  const size = Math.max(1, Math.round(Number(P.SIZE || 40)));
  const latencyMs = Math.max(0, Number(P.LATENCY_MS || 0));
  const winSec = Number(P.WINDOW_SEC || 300);
  let decisionIndex = -1;
  let entrySide = null;
  let previousMs = null;

  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index];
    const gapMs = previousMs == null ? 0 : tick.ms - previousMs;
    previousMs = tick.ms;
    if (gapMs > Number(P.STALE_GAP_MS || 6000)) continue;
    const t = (tick.ms - feed.startMs) / 1000;
    const left = winSec - t;
    if (t < Number(P.L_SKIP_OPEN_S || 0) || left <= Number(P.L_SKIP_END_S || 0) || left < Number(P.L_MIN_TIME_S || 1)) continue;
    const gap = tick.bz - feed.openBinance;
    const absGap = Math.abs(gap);
    if (Number(P.L_MIN_GAP || 0) > 0 && absGap < Number(P.L_MIN_GAP)) continue;
    const fraction = P.L_SCALING === "sqrt" ? Math.sqrt(Math.max(0, left) / winSec) : Math.max(0, Math.min(1, left / winSec));
    const possible = intensity * fraction + Number(P.L_EDGE_BUFFER || 0);
    if (!(absGap > possible)) continue;
    const side = gap > 0 ? "Up" : "Down";
    const ask = bestAsk(tick, side);
    if (!(ask >= Number(P.L_ENTRY_FLOOR || 0))) continue;
    if (Number(P.L_ENTRY_CEIL || 0) > 0 && ask > Number(P.L_ENTRY_CEIL)) continue;
    if (ask > Number(P.LIMIT || .99)) continue;

    // Optional causal confirmation gates used only by this research harness.
    // They consume the same Binance and CLOB feeds already available to the
    // running bot; no outcome or target-wallet feature is involved.
    if (Number(P.S_MIN_T || 0) > 0 && t < Number(P.S_MIN_T)) continue;
    if (Number(P.S_MAX_T || 0) > 0 && t > Number(P.S_MAX_T)) continue;
    if (Number(P.S_MIN_MARGIN_RATIO || 0) > 0 && absGap / Math.max(EPS, possible) < Number(P.S_MIN_MARGIN_RATIO)) continue;
    const sign = side === "Up" ? 1 : -1;
    if (Number(P.S_BZ_MOM_MS || 0) > 0) {
      const prior = ticks[priorIndex(ticks, index, Number(P.S_BZ_MOM_MS))];
      const momentumPct = sign * (tick.bz - prior.bz) / prior.bz * 100;
      if (momentumPct < Number(P.S_MIN_BZ_MOM_PCT || 0)) continue;
    }
    if (Number(P.S_CLOB_MOM_MS || 0) > 0) {
      const prior = ticks[priorIndex(ticks, index, Number(P.S_CLOB_MOM_MS))];
      const tokenMomentum = ask - bestAsk(prior, side);
      if (tokenMomentum < Number(P.S_MIN_CLOB_MOM || 0)) continue;
    }

    if (P.REQUIRE_PAIR_AT_ENTRY) {
      const loser = side === "Up" ? "Down" : "Up";
      const entryNow = walk(tick, side, size, entryLimit(P, ask));
      const hedgeNow = walk(tick, loser, size, Number(P.L_HEDGE_CAP ?? .02));
      if (!entryNow || !hedgeNow || entryNow.shares < size - EPS || hedgeNow.shares < size - EPS) continue;
      const net = pairNet(entryNow.price, size, hedgeNow.price, size, false);
      if (net < Number(P.REQUIRE_PAIR_PROFIT || 0) * size - EPS) continue;
    }
    decisionIndex = index;
    entrySide = side;
    break;
  }
  if (decisionIndex < 0) return { active: false, pnl: 0, deployed: 0, fills: 0 };

  const arrivalIndex = firstAtOrAfter(ticks, ticks[decisionIndex].ms + latencyMs, decisionIndex);
  if (arrivalIndex >= ticks.length) return { active: false, attempted: true, pnl: 0, deployed: 0, fills: 0 };
  const decisionAsk = bestAsk(ticks[decisionIndex], entrySide);
  const arrivalAsk = bestAsk(ticks[arrivalIndex], entrySide);
  const entry = walk(ticks[arrivalIndex], entrySide, size, entryLimit(P, decisionAsk));
  const loser = entrySide === "Up" ? "Down" : "Up";
  const concurrentHedge = P.PAIR_CONCURRENT
    ? walk(ticks[arrivalIndex], loser, size, Number(P.L_HEDGE_CAP ?? .02))
    : null;
  // A limit that is not marketable at arrival rests.  Ignoring its possible
  // later fill is conservative and avoids inventing queue position.
  // With concurrent pair orders, count an orphaned hedge even when the entry
  // did not fill; hiding that leg would make two-order execution look atomic.
  if (!entry && !concurrentHedge) return { active: false, attempted: true, pnl: 0, deployed: 0, fills: 0 };
  if (!entry && !P.PAIR_CONCURRENT) return { active: false, attempted: true, pnl: 0, deployed: 0, fills: 0 };

  const entryShares = entry?.shares || 0;
  const entryPrice = entry?.price ?? null;
  let up = entrySide === "Up" ? entryShares : 0;
  let down = entrySide === "Down" ? entryShares : 0;
  let cost = entry?.cost || 0;
  let fees = entry ? fillFee(entry.price, entry.shares, true) : 0;
  let fills = entry ? 1 : 0;
  let hedgeShares = concurrentHedge?.shares || 0;
  let hedgePrice = concurrentHedge?.price ?? null;
  let hedgeMaker = false;
  if (concurrentHedge) {
    cost += concurrentHedge.cost;
    fees += fillFee(concurrentHedge.price, concurrentHedge.shares, true);
    fills++;
  }
  const hedgeExec = String(P.L_HEDGE_EXEC || "maker").toLowerCase();

  if (!P.PAIR_CONCURRENT && hedgeExec !== "none" && entryShares > EPS) {
    let cursor = Math.min(ticks.length, arrivalIndex + 1);
    const closeMs = feed.startMs + WINDOW_MS;
    while (cursor < ticks.length && ticks[cursor].ms < closeMs && hedgeShares < entryShares - EPS) {
      const tick = ticks[cursor];
      const ask = bestAsk(tick, loser);
      const cap = Number(P.L_HEDGE_CAP ?? .02);
      const prospective = pairNet(entryPrice, entryShares, ask, entryShares, hedgeExec === "maker");
      const minNet = Number(P.L_HEDGE_MIN_PROFIT || 0) * entryShares;
      if (!(ask <= cap + EPS && prospective >= minNet - EPS && prospective > 0)) { cursor++; continue; }

      const maker = hedgeExec === "maker";
      const limit = hedgeLimit(P, maker, ask);
      const orderArrival = firstAtOrAfter(ticks, tick.ms + latencyMs, cursor);
      if (orderArrival >= ticks.length) break;
      if (!maker) {
        const got = walk(ticks[orderArrival], loser, entryShares - hedgeShares, limit);
        if (got) {
          hedgeShares += got.shares;
          hedgePrice = hedgePrice == null ? got.price : ((hedgePrice * (hedgeShares - got.shares) + got.cost) / hedgeShares);
          cost += got.cost;
          fees += fillFee(got.price, got.shares, true);
          fills++;
        }
        break;
      }

      // Post-only rejects an order already crossing at its arrival.  Otherwise
      // it rests for TTL.  A historical ask touching our counterfactual bid is
      // only a proxy for a fill, hence the configurable confirmation delay and
      // fill fraction used in sensitivity tests.
      if (bestAsk(ticks[orderArrival], loser) <= limit + EPS) { cursor = orderArrival + 1; continue; }
      const expiresMs = ticks[orderArrival].ms + Number(P.MAKER_TTL_MS || 10_000);
      let firstTouchMs = null;
      let filledThisOrder = 0;
      let next = orderArrival + 1;
      for (; next < ticks.length && ticks[next].ms <= expiresMs; next++) {
        if (bestAsk(ticks[next], loser) <= limit + EPS) {
          if (firstTouchMs == null) firstTouchMs = ticks[next].ms;
          if (ticks[next].ms - firstTouchMs >= Number(P.MAKER_TOUCH_CONFIRM_MS || 0)) {
            const available = walk(ticks[next], loser, entryShares - hedgeShares, limit);
            if (available) {
              const fraction = Math.max(0, Math.min(1, Number(P.MAKER_FILL_FRACTION ?? 1)));
              const shares = Math.min(entryShares - hedgeShares, available.shares * fraction);
              if (shares > EPS) {
                cost += shares * limit;
                hedgePrice = hedgePrice == null ? limit : ((hedgePrice * hedgeShares + limit * shares) / (hedgeShares + shares));
                hedgeShares += shares;
                filledThisOrder += shares;
                fills++;
              }
            }
            break;
          }
        } else firstTouchMs = null;
      }
      cursor = Math.max(next, orderArrival + 1);
      if (filledThisOrder <= EPS && Number(P.MAKER_FILL_FRACTION ?? 1) <= 0) break;
    }
  }

  if (loser === "Up") up += hedgeShares; else down += hedgeShares;
  const payout = feed.winner === "Up" ? up : down;
  const pnl = payout - cost - fees;
  const decisionTick = ticks[decisionIndex];
  const decisionT = (decisionTick.ms - feed.startMs) / 1000;
  const decisionGap = decisionTick.bz - feed.openBinance;
  const decisionLeft = winSec - decisionT;
  const decisionPossible = intensity * (P.L_SCALING === "sqrt" ? Math.sqrt(Math.max(0, decisionLeft) / winSec) : Math.max(0, Math.min(1, decisionLeft / winSec))) + Number(P.L_EDGE_BUFFER || 0);
  const mom5Tick = ticks[priorIndex(ticks, decisionIndex, 5_000)];
  const decisionSign = entrySide === "Up" ? 1 : -1;
  return {
    active: true,
    attempted: true,
    slug: feed.slug,
    startMs: feed.startMs,
    day: dayKey(feed.startMs),
    winner: feed.winner,
    side: entrySide,
    correct: entrySide === feed.winner,
    hour: new Date(feed.startMs).getUTCHours(),
    weekday: new Date(feed.startMs).getUTCDay(),
    intensity,
    decisionGap,
    decisionGapRatio: Math.abs(decisionGap) / Math.max(EPS, decisionPossible),
    decisionBzMom5Pct: decisionSign * (decisionTick.bz - mom5Tick.bz) / mom5Tick.bz * 100,
    decisionAsk: bestAsk(decisionTick, entrySide),
    decisionPairAsk: decisionTick.upAsk + decisionTick.dnAsk,
    arrivalAsk,
    arrivalAskChange: arrivalAsk - bestAsk(decisionTick, entrySide),
    arrivalBzGap: ticks[arrivalIndex].bz - feed.openBinance,
    arrivalDirectionalGap: decisionSign * (ticks[arrivalIndex].bz - feed.openBinance),
    entryLimit: entryLimit(P, decisionAsk),
    entryDecisionT: decisionT,
    entryFillT: (ticks[arrivalIndex].ms - feed.startMs) / 1000,
    entryShares,
    entryPrice,
    entryPartial: entry?.partial || false,
    hedgeShares,
    hedgePrice,
    hedgeMaker,
    hedged: entryShares > EPS && hedgeShares >= entryShares - EPS,
    fills,
    cost,
    fees,
    deployed: cost + fees,
    payout,
    pnl,
  };
}

function aggregate(rows) {
  const active = rows.filter((row) => row.active);
  let pnl = 0, deployed = 0, equity = 0, peak = 0, maxDrawdown = 0, grossWin = 0, grossLoss = 0;
  const days = new Map();
  for (const row of active) {
    pnl += row.pnl;
    deployed += row.deployed;
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (row.pnl > 0) grossWin += row.pnl; else grossLoss -= row.pnl;
    days.set(row.day, (days.get(row.day) || 0) + row.pnl);
  }
  const dayValues = [...days.values()];
  return {
    windows: rows.length,
    active: active.length,
    correct: active.filter((row) => row.correct).length,
    hedged: active.filter((row) => row.hedged).length,
    partialEntries: active.filter((row) => row.entryPartial).length,
    pnl: round(pnl, 4),
    deployed: round(deployed, 4),
    roiPct: deployed ? round(pnl / deployed * 100, 4) : 0,
    perTrade: active.length ? round(pnl / active.length, 4) : 0,
    maxDrawdown: round(maxDrawdown, 4),
    profitFactor: grossLoss > EPS ? round(grossWin / grossLoss, 4) : (grossWin > 0 ? Infinity : 0),
    days: days.size,
    positiveDays: dayValues.filter((value) => value > 0).length,
    worstDay: dayValues.length ? round(Math.min(...dayValues), 4) : 0,
    bestDay: dayValues.length ? round(Math.max(...dayValues), 4) : 0,
    daily: Object.fromEntries([...days].map(([day, value]) => [day, round(value, 4)])),
  };
}

function run(feeds, P) {
  const excursions = [];
  const rows = [];
  const rounds = Math.max(1, Math.round(Number(P.L_VOL_ROUNDS || 6)));
  for (const feed of feeds) {
    const ready = excursions.length >= rounds;
    if (ready) rows.push(replayWindow(feed, computeIntensity(excursions, P), P));
    excursions.push(feed.excursion);
    if (excursions.length > Math.max(16, rounds + 4)) excursions.shift();
  }
  return { rows, summary: aggregate(rows) };
}

function splitFeeds(feeds) {
  const first = feeds[0]?.startMs ?? FROM_MS;
  const last = (feeds.at(-1)?.startMs ?? TO_MS) + WINDOW_MS;
  const span = last - first;
  const trainEnd = first + span * .60;
  const validationEnd = first + span * .82;
  return {
    boundaries: { first: new Date(first).toISOString(), trainEnd: new Date(trainEnd).toISOString(), validationEnd: new Date(validationEnd).toISOString(), last: new Date(last).toISOString() },
    train: feeds.filter((feed) => feed.startMs < trainEnd),
    validation: feeds.filter((feed) => feed.startMs >= trainEnd && feed.startMs < validationEnd),
    test: feeds.filter((feed) => feed.startMs >= validationEnd),
  };
}

function objective(summary) {
  const minimum = (RATIO_ONLY || ROBUST_ONLY) ? 10 : 20;
  if (summary.active < minimum) return -Infinity;
  return summary.pnl - 1.25 * summary.maxDrawdown + Math.min(0, summary.worstDay) * .5;
}

function robustObjective(stresses, minimumActive) {
  if (!stresses.length || stresses.some((row) => row.summary.active < minimumActive)) return -Infinity;
  const minPnl = Math.min(...stresses.map((row) => row.summary.pnl));
  const meanPnl = stresses.reduce((sum, row) => sum + row.summary.pnl, 0) / stresses.length;
  const maxDrawdown = Math.max(...stresses.map((row) => row.summary.maxDrawdown));
  const worstDay = Math.min(...stresses.map((row) => row.summary.worstDay));
  return minPnl + .25 * meanPnl - maxDrawdown + Math.min(0, worstDay) * .5;
}

function makeRng(seed = 0x3048d653) {
  let state = seed >>> 0;
  return () => ((state = Math.imul(1664525, state) + 1013904223 >>> 0) / 0x1_0000_0000);
}

function percentile(sorted, probability) {
  if (!sorted.length) return 0;
  const at = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * probability));
  const lo = Math.floor(at), hi = Math.ceil(at), weight = at - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function bootstrapSums(values, iterations, seed) {
  if (!values.length) return { samples: 0, observed: 0, lower95: 0, median: 0, upper95: 0, probabilityPositive: 0 };
  const rng = makeRng(seed), sums = new Array(iterations);
  let positive = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) sum += values[Math.floor(rng() * values.length)];
    sums[iteration] = sum;
    if (sum > 0) positive++;
  }
  sums.sort((a, b) => a - b);
  return {
    samples: values.length,
    observed: round(values.reduce((sum, value) => sum + value, 0), 4),
    lower95: round(percentile(sums, .025), 4),
    median: round(percentile(sums, .5), 4),
    upper95: round(percentile(sums, .975), 4),
    probabilityPositive: round(positive / iterations, 6),
  };
}

function confidence(rows, sourceFeeds, iterations = 20_000) {
  const active = rows.filter((row) => row.active);
  const allDays = [...new Set(sourceFeeds.map((feed) => dayKey(feed.startMs)))];
  const pnlByDay = new Map(allDays.map((day) => [day, 0]));
  for (const row of active) pnlByDay.set(row.day, (pnlByDay.get(row.day) || 0) + row.pnl);
  return {
    method: "deterministic non-parametric bootstrap; trade IID and UTC-day block intervals",
    iterations,
    trade: bootstrapSums(active.map((row) => row.pnl), iterations, 0x3048d653),
    dayBlock: bootstrapSums([...pnlByDay.values()], iterations, 0x21be3497),
  };
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const e = Math.exp(value);
  return e / (1 + e);
}

function logit(value) {
  const p = Math.max(1e-5, Math.min(1 - 1e-5, value));
  return Math.log(p / (1 - p));
}

function modelPoints(feeds, P = {}) {
  const rounds = Math.max(1, Number(P.L_VOL_ROUNDS || 6));
  const excursions = [];
  const byFeed = [];
  for (const feed of feeds) {
    const points = [];
    if (excursions.length >= rounds) {
      const intensity = computeIntensity(excursions, { L_VOL_ROUNDS: rounds, L_VOL_MODE: "max" });
      let lastBucket = -1;
      for (let index = 0; index < feed.ticks.length; index++) {
        const tick = feed.ticks[index];
        const t = (tick.ms - feed.startMs) / 1000;
        if (t < 45 || t > 292) continue;
        const bucket = Math.floor(t);
        if (bucket === lastBucket) continue;
        lastBucket = bucket;
        const gap = tick.bz - feed.openBinance;
        const chainlinkGap = Number(tick.cl) > 0 && Number(feed.openChainlink) > 0 ? tick.cl - feed.openChainlink : null;
        if (Math.abs(gap) < EPS || !Number.isFinite(chainlinkGap)) continue;
        const p5 = feed.ticks[priorIndex(feed.ticks, index, 5_000)];
        const p15 = feed.ticks[priorIndex(feed.ticks, index, 15_000)];
        const left = 300 - t;
        const possible = intensity * Math.sqrt(Math.max(0, left) / 300) + 8;
        for (const side of ["Up", "Down"]) {
          const sign = side === "Up" ? 1 : -1;
          const opposite = side === "Up" ? "Down" : "Up";
          const ask = bestAsk(tick, side), oppositeAsk = bestAsk(tick, opposite);
          if (!(ask >= .40 && ask <= .96) || !(oppositeAsk > 0)) continue;
          const marketProb = ask / Math.max(EPS, ask + oppositeAsk);
          const raw = [
            logit(marketProb),
            sign * gap / Math.max(EPS, intensity),
            sign * gap / Math.max(EPS, possible),
            sign * chainlinkGap / feed.openChainlink * 100,
            sign * ((tick.bz - tick.cl) - (feed.openBinance - feed.openChainlink)) / feed.openChainlink * 100,
            Math.sqrt(Math.max(0, left) / 300),
            sign * (tick.bz - p5.bz) / p5.bz * 100,
            sign * (tick.bz - p15.bz) / p15.bz * 100,
            Number(p5.cl) > 0 ? sign * (tick.cl - p5.cl) / p5.cl * 100 : 0,
            Number(p15.cl) > 0 ? sign * (tick.cl - p15.cl) / p15.cl * 100 : 0,
            ask - bestAsk(p5, side),
            ask + oppositeAsk - 1,
          ];
          if (!raw.every(Number.isFinite)) continue;
          points.push({ index, t, side, ask, raw, y: side === feed.winner ? 1 : 0 });
        }
      }
    }
    byFeed.push({ feed, points });
    excursions.push(feed.excursion);
    if (excursions.length > Math.max(16, rounds + 4)) excursions.shift();
  }
  return byFeed;
}

function fitLogistic(byFeed, ridge = .03) {
  const rows = [];
  for (const item of byFeed) {
    const weight = item.points.length ? 1 / item.points.length : 0;
    for (const point of item.points) rows.push({ ...point, weight });
  }
  const dim = rows[0]?.raw.length || 0;
  const means = new Array(dim).fill(0), scales = new Array(dim).fill(0);
  let totalWeight = 0, yWeight = 0;
  for (const row of rows) {
    totalWeight += row.weight;
    yWeight += row.weight * row.y;
    for (let j = 0; j < dim; j++) means[j] += row.weight * row.raw[j];
  }
  for (let j = 0; j < dim; j++) means[j] /= Math.max(EPS, totalWeight);
  for (const row of rows) for (let j = 0; j < dim; j++) scales[j] += row.weight * (row.raw[j] - means[j]) ** 2;
  for (let j = 0; j < dim; j++) scales[j] = Math.sqrt(scales[j] / Math.max(EPS, totalWeight)) || 1;
  const beta = new Array(dim + 1).fill(0);
  beta[0] = logit(yWeight / Math.max(EPS, totalWeight));
  for (let iteration = 0; iteration < 500; iteration++) {
    const gradient = new Array(dim + 1).fill(0);
    for (const row of rows) {
      let value = beta[0];
      for (let j = 0; j < dim; j++) value += beta[j + 1] * ((row.raw[j] - means[j]) / scales[j]);
      const error = sigmoid(value) - row.y;
      gradient[0] += row.weight * error;
      for (let j = 0; j < dim; j++) gradient[j + 1] += row.weight * error * ((row.raw[j] - means[j]) / scales[j]);
    }
    const rate = .35 / Math.sqrt(1 + iteration / 50);
    beta[0] -= rate * gradient[0] / Math.max(EPS, totalWeight);
    for (let j = 1; j < beta.length; j++) beta[j] -= rate * (gradient[j] / Math.max(EPS, totalWeight) + ridge * beta[j]);
  }
  const predict = (raw) => {
    let value = beta[0];
    for (let j = 0; j < dim; j++) value += beta[j + 1] * ((raw[j] - means[j]) / scales[j]);
    return sigmoid(value);
  };
  let logLoss = 0, brier = 0;
  for (const row of rows) {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, predict(row.raw)));
    logLoss += row.weight * -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
    brier += row.weight * (p - row.y) ** 2;
  }
  return { beta, means, scales, predict, rows: rows.length, weightedWindows: totalWeight, logLoss: logLoss / totalWeight, brier: brier / totalWeight };
}

function replayModel(byFeed, model, policy) {
  const rows = [];
  for (const { feed, points } of byFeed) {
    let selected = null;
    for (const point of points) {
      if (selected && point.index !== selected.index) break;
      if (point.t < policy.minT || point.ask > policy.cap) continue;
      const probability = model.predict(point.raw);
      const breakEven = point.ask + fillFee(point.ask, 1, true);
      if (probability < policy.minP || probability - breakEven < policy.edge) continue;
      const candidate = { ...point, probability, breakEven };
      if (!selected || candidate.probability - candidate.breakEven > selected.probability - selected.breakEven) selected = candidate;
    }
    if (!selected) { rows.push({ active: false, pnl: 0, deployed: 0 }); continue; }
    const decision = feed.ticks[selected.index];
    const arrivalIndex = firstAtOrAfter(feed.ticks, decision.ms + policy.latencyMs, selected.index);
    const limit = Math.min(policy.cap, round(selected.ask + policy.limitOffset, 2));
    const fill = arrivalIndex < feed.ticks.length ? walk(feed.ticks[arrivalIndex], selected.side, policy.size, limit) : null;
    if (!fill) { rows.push({ active: false, attempted: true, pnl: 0, deployed: 0 }); continue; }
    const fee = fillFee(fill.price, fill.shares, true);
    const payout = selected.side === feed.winner ? fill.shares : 0;
    rows.push({ active: true, attempted: true, slug: feed.slug, startMs: feed.startMs, day: dayKey(feed.startMs),
      side: selected.side, winner: feed.winner, correct: selected.side === feed.winner, hedged: false,
      entryPartial: fill.partial, entryShares: fill.shares, entryPrice: fill.price,
      predicted: selected.probability, predictedEdge: selected.probability - selected.breakEven,
      deployed: fill.cost + fee, cost: fill.cost, fees: fee, payout, pnl: payout - fill.cost - fee });
  }
  return { rows, summary: aggregate(rows) };
}

function replayRtds(feeds, policy) {
  const rows = [];
  for (const feed of feeds) {
    const decisionIndex = firstAtOrAfter(feed.ticks, feed.startMs + policy.decisionT * 1000);
    const decision = feed.ticks[decisionIndex];
    if (!decision || !(Number(decision.cl) > 0) || !(Number(feed.openChainlink) > 0)) {
      rows.push({ active: false, pnl: 0, deployed: 0 });
      continue;
    }
    const clGapPct = (decision.cl - feed.openChainlink) / feed.openChainlink * 100;
    if (Math.abs(clGapPct) < policy.minClGapPct) {
      rows.push({ active: false, pnl: 0, deployed: 0 });
      continue;
    }
    const side = clGapPct > 0 ? "Up" : "Down";
    const bzGap = decision.bz - feed.openBinance;
    if (policy.requireBinanceAgree && Math.sign(bzGap) !== Math.sign(clGapPct)) {
      rows.push({ active: false, pnl: 0, deployed: 0 });
      continue;
    }
    const decisionAsk = bestAsk(decision, side);
    if (!(decisionAsk >= .01 && decisionAsk <= policy.cap)) {
      rows.push({ active: false, pnl: 0, deployed: 0 });
      continue;
    }
    const arrivalIndex = firstAtOrAfter(feed.ticks, decision.ms + policy.latencyMs, decisionIndex);
    const limit = Math.min(policy.cap, round(decisionAsk + policy.limitOffset, 2));
    const fill = arrivalIndex < feed.ticks.length ? walk(feed.ticks[arrivalIndex], side, policy.size, limit) : null;
    if (!fill) {
      rows.push({ active: false, attempted: true, pnl: 0, deployed: 0 });
      continue;
    }
    const chargedFee = fillFee(fill.price, fill.shares, true);
    const payout = side === feed.winner ? fill.shares : 0;
    rows.push({
      active: true, attempted: true, slug: feed.slug, startMs: feed.startMs, day: dayKey(feed.startMs),
      side, winner: feed.winner, correct: side === feed.winner, hedged: false,
      entryPartial: fill.partial, entryShares: fill.shares, entryPrice: fill.price,
      clGapPct, bzGap, decisionAsk, limit,
      deployed: fill.cost + chargedFee, cost: fill.cost, fees: chargedFee, payout,
      pnl: payout - fill.cost - chargedFee,
    });
  }
  return { rows, summary: aggregate(rows) };
}

function runRtdsResearch(split, feeds) {
  const policies = [];
  for (const decisionT of [150, 165, 180, 195, 210, 225, 240])
    for (const minClGapPct of [.005, .01, .02, .03, .05, .08])
      for (const cap of [.75, .84, .90])
        for (const limitOffset of [0, .01, .02, .03])
          for (const requireBinanceAgree of [false, true])
            policies.push({ decisionT, minClGapPct, cap, limitOffset, requireBinanceAgree, latencyMs: 520, size: RESEARCH_SIZE });
  const latencyGrid = [260, 520, 780, 1040];
  const stress = (source, policy) => latencyGrid.map((latencyMs) => ({ latencyMs,
    summary: replayRtds(source, { ...policy, latencyMs }).summary }));
  console.log(JSON.stringify({ phase: "rtds-robust-search", candidates: policies.length, latencies: latencyGrid }));
  const trained = policies.map((policy) => {
    const trainStresses = stress(split.train, policy);
    return { policy, trainStresses, robustTrainScore: robustObjective(trainStresses, 80) };
  }).filter((row) => Number.isFinite(row.robustTrainScore)).sort((a, b) => b.robustTrainScore - a.robustTrainScore);
  const validated = trained.slice(0, 120).map((row) => {
    const validationStresses = stress(split.validation, row.policy);
    return { ...row, validationStresses, robustValidationScore: robustObjective(validationStresses, 30),
      combinedRobustScore: row.robustTrainScore + robustObjective(validationStresses, 30) };
  }).filter((row) => Number.isFinite(row.robustValidationScore)).sort((a, b) => b.combinedRobustScore - a.combinedRobustScore);
  const chosen = validated[0];
  if (!chosen) throw new Error("no RTDS policy reached minimum chronological samples");
  const selected = {
    policy: chosen.policy,
    train: replayRtds(split.train, chosen.policy).summary,
    validation: replayRtds(split.validation, chosen.policy).summary,
    test: replayRtds(split.test, chosen.policy).summary,
    full: replayRtds(feeds, chosen.policy).summary,
    trainStresses: chosen.trainStresses,
    validationStresses: chosen.validationStresses,
  };
  const testReplay = replayRtds(split.test, chosen.policy), fullReplay = replayRtds(feeds, chosen.policy);
  const stresses = latencyGrid.map((latencyMs) => ({ latencyMs,
    test: replayRtds(split.test, { ...chosen.policy, latencyMs }).summary,
    full: replayRtds(feeds, { ...chosen.policy, latencyMs }).summary }));
  const result = {
    schema: 1, generatedAt: new Date().toISOString(),
    source: "causal Polymarket RTDS TWAP60 plus bapi-v4 executable order books",
    selection: "fixed-time RTDS gap policies ranked on train+validation worst-latency objective; test excluded",
    selected, stresses,
    topValidation: validated.slice(0, 20),
    confidence: { test: confidence(testReplay.rows, split.test), full: confidence(fullReplay.rows, feeds) },
  };
  const outDir = path.join(ROOT, "data/research");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "lockstep-v4-rtds.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "rtds-result", selected, stresses, confidence: result.confidence }, null, 2));
}

function runModelResearch(split, feeds) {
  console.log(JSON.stringify({ phase: "model-features" }));
  const trainPoints = modelPoints(split.train), validationPoints = modelPoints(split.validation), testPoints = modelPoints(split.test), fullPoints = modelPoints(feeds);
  const fitted = fitLogistic(trainPoints, .03);
  const policies = [];
  for (const edge of [.01, .03, .05, .08])
    for (const minP of [.60, .70, .80])
      for (const minT of [60, 120, 180, 210])
        for (const cap of [.75, .84, .90])
          for (const limitOffset of [0, .01, .02, .03])
            policies.push({ edge, minP, minT, cap, limitOffset, latencyMs: 520, size: RESEARCH_SIZE });
  console.log(JSON.stringify({ phase: "model-policy-search", candidates: policies.length, fitRows: fitted.rows, weightedWindows: round(fitted.weightedWindows, 2), logLoss: round(fitted.logLoss), brier: round(fitted.brier) }));
  const latencyGrid = [260, 520, 780, 1040];
  const stress = (points, policy) => latencyGrid.map((latencyMs) => ({ latencyMs,
    summary: replayModel(points, fitted, { ...policy, latencyMs }).summary }));
  const trained = policies.map((policy) => {
    const trainStresses = stress(trainPoints, policy);
    return { policy, trainStresses, robustTrainScore: robustObjective(trainStresses, 80) };
  }).filter((row) => Number.isFinite(row.robustTrainScore)).sort((a, b) => b.robustTrainScore - a.robustTrainScore);
  console.log(JSON.stringify({ phase: "model-robust-validation", candidates: Math.min(100, trained.length), latencies: latencyGrid }));
  const validated = trained.slice(0, 100).map((row) => {
    const validationStresses = stress(validationPoints, row.policy);
    return { ...row, validationStresses,
      robustValidationScore: robustObjective(validationStresses, 30),
      combinedRobustScore: row.robustTrainScore + robustObjective(validationStresses, 30) };
  }).filter((row) => Number.isFinite(row.robustValidationScore))
    .sort((a, b) => b.combinedRobustScore - a.combinedRobustScore);
  const chosen = validated[0];
  if (!chosen) throw new Error("no model policy reached the minimum training sample");
  const trainReplay = replayModel(trainPoints, fitted, chosen.policy);
  const validationReplay = replayModel(validationPoints, fitted, chosen.policy);
  const testReplay = replayModel(testPoints, fitted, chosen.policy);
  const fullReplay = replayModel(fullPoints, fitted, chosen.policy);
  const stresses = latencyGrid.map((latencyMs) => ({ latencyMs,
    test: replayModel(testPoints, fitted, { ...chosen.policy, latencyMs }).summary,
    full: replayModel(fullPoints, fitted, { ...chosen.policy, latencyMs }).summary }));
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: "bapi-v4 full orderbook compact cache; model trained on chronological train only",
    features: ["clob_logit", "oriented_binance_gap_over_intensity", "oriented_binance_gap_over_possible_move", "oriented_chainlink_gap_pct", "oriented_binance_chainlink_basis_change_pct", "sqrt_time_left", "binance_mom5", "binance_mom15", "chainlink_mom5", "chainlink_mom15", "token_mom5", "pair_ask_minus_one"],
    model: { beta: fitted.beta.map((value) => round(value)), means: fitted.means.map((value) => round(value)), scales: fitted.scales.map((value) => round(value)), rows: fitted.rows, weightedWindows: round(fitted.weightedWindows, 2), logLoss: round(fitted.logLoss), brier: round(fitted.brier) },
    selected: { policy: chosen.policy, train: trainReplay.summary, validation: validationReplay.summary,
      test: testReplay.summary, full: fullReplay.summary,
      trainStresses: chosen.trainStresses, validationStresses: chosen.validationStresses },
    selection: "maximize combined train+validation worst-latency objective over 260/520/780/1040ms; test excluded",
    topValidation: validated.slice(0, 20).map((row) => ({ policy: row.policy, robustTrainScore: round(row.robustTrainScore),
      robustValidationScore: round(row.robustValidationScore), combinedRobustScore: round(row.combinedRobustScore),
      trainStresses: row.trainStresses, validationStresses: row.validationStresses })),
    stresses,
    confidence: { test: confidence(testReplay.rows, split.test), full: confidence(fullReplay.rows, feeds) },
  };
  const outDir = path.join(ROOT, "data/research");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "lockstep-v4-model.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "model-result", selected: result.selected, stresses }, null, 2));
}

function label(P) {
  const signal = P.S_NAME ? `-${P.S_NAME}` : "";
  const pair = P.REQUIRE_PAIR_AT_ENTRY ? `-pair${P.PAIR_CONCURRENT ? "2" : "seq"}-h${P.L_HEDGE_CAP}` : "";
  return `v${P.L_VOL_ROUNDS}-e${P.L_EDGE_BUFFER}-f${P.L_ENTRY_FLOOR}-c${P.L_ENTRY_CEIL}-${P.L_HEDGE_EXEC}${pair}${signal}`;
}

const loaded = loadFeeds();
const feeds = loaded.feeds;
if (feeds.length < 100) throw new Error(`only ${feeds.length} usable v4 windows in range`);
const coverageHours = ((feeds.at(-1).startMs - feeds[0].startMs + WINDOW_MS) / 3_600_000);
const expected = Math.round(coverageHours * 12);
const coveragePct = feeds.length / Math.max(1, expected) * 100;
console.log(JSON.stringify({ phase: "loaded", cacheDirs: CACHE_DIRS, files: loaded.files, failed: loaded.failed, usable: feeds.length,
  rtdsFiles: loaded.rtdsFiles, rtdsFeeds: loaded.rtdsFeeds,
  from: new Date(feeds[0].startMs).toISOString(), to: new Date(feeds.at(-1).startMs + WINDOW_MS).toISOString(), coveragePct: round(coveragePct, 2) }));

const split = splitFeeds(feeds);
console.log(JSON.stringify({ phase: "split", ...split.boundaries, windows: { train: split.train.length, validation: split.validation.length, test: split.test.length } }));
if (MODEL_ONLY) {
  runModelResearch(split, feeds);
  process.exit(0);
}
if (RTDS_ONLY) {
  runRtdsResearch(split, feeds);
  process.exit(0);
}

const common = {
  ...STRAT,
  SIZE: RESEARCH_SIZE,
  WINDOW_SEC: 300,
  LATENCY_MS: 520,
  L_SCALING: "sqrt",
  L_VOL_MODE: "max",
  L_SKIP_OPEN_S: 0,
  L_SKIP_END_S: 5,
  L_MIN_TIME_S: 1,
  L_HEDGE_CAP: .02,
  L_HEDGE_MIN_PROFIT: 0,
  L_HEDGE_MAKER_OFFSET: .01,
  MAKER_TTL_MS: 10_000,
  MAKER_TOUCH_CONFIRM_MS: 250,
  MAKER_FILL_FRACTION: 1,
  STRICT_LIMITS: true,
  REQUIRE_PAIR_AT_ENTRY: false,
};

if (FIXED_PATH) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(FIXED_PATH), "utf8"));
  const params = { ...common, ...(parsed.selected?.params || parsed.params || parsed) };
  const partition = (sourceFeeds) => {
    const replay = run(sourceFeeds, params);
    return { summary: replay.summary, trades: replay.rows.filter((row) => row.active) };
  };
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: "fixed frozen parameter audit on bapi-v4 include_orderbook=true caches",
    label: label(params),
    params,
    train: partition(split.train),
    validation: partition(split.validation),
    test: partition(split.test),
    full: partition(feeds),
    stresses: [520, 780, 1040].map((latency) => {
      const replay = run(feeds, { ...params, LATENCY_MS: latency });
      return { latency, summary: replay.summary, trades: replay.rows.filter((row) => row.active) };
    }),
  };
  const outDir = path.join(ROOT, "data/research");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "lockstep-v4-fixed-audit.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "fixed-result", label: result.label, train: result.train.summary,
    validation: result.validation.summary, test: result.test.summary, stresses: result.stresses.map((row) => ({ latency: row.latency, summary: row.summary })) }, null, 2));
  process.exit(0);
}

if (AUDIT_ONLY) {
  const policies = [];
  for (const hedge of ["maker", "taker", "none"])
    for (const latency of [520, 780, 1040]) {
      const params = { ...common, L_HEDGE_EXEC: hedge, L_VOL_ROUNDS: 6, L_EDGE_BUFFER: 8, L_ENTRY_FLOOR: .50, L_ENTRY_CEIL: .88, LATENCY_MS: latency };
      const replay = run(feeds, params);
      policies.push({ label: label(params), latency, summary: replay.summary,
        trades: latency === 520 ? replay.rows.filter((row) => row.active) : undefined });
    }
  const output = { schema: 1, generatedAt: new Date().toISOString(), source: "bapi-v4 full-orderbook compact cache; frozen post-change Lockstep profile; no fitting on this range",
    range: { from: new Date(feeds[0].startMs).toISOString(), to: new Date(feeds.at(-1).startMs + WINDOW_MS).toISOString(), coveragePct: round(coveragePct, 3) }, policies };
  const outDir = path.join(ROOT, "data/research");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "lockstep-v4-frozen-audit.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "audit-result", ...output }, null, 2));
  process.exit(0);
}

const families = (PAIR_ONLY || RATIO_ONLY || ROBUST_ONLY) ? [] : ["maker", "taker", "none"];
const candidates = [];
for (const hedge of families)
  for (const volRounds of [6, 8, 12])
    for (const edge of [8, 12, 18])
      for (const floor of [.50, .60, .70])
        for (const ceil of [.84, .86, .88]) candidates.push({ ...common, L_HEDGE_EXEC: hedge, L_VOL_ROUNDS: volRounds,
          L_EDGE_BUFFER: edge, L_ENTRY_FLOOR: floor, L_ENTRY_CEIL: ceil });

console.log(JSON.stringify({ phase: "train-search", candidates: candidates.length }));
const trained = candidates.map((params, index) => {
  if ((index + 1) % 30 === 0) console.log(JSON.stringify({ phase: "train-progress", done: index + 1, total: candidates.length }));
  const train = run(split.train, params).summary;
  return { params, train, score: objective(train) };
}).sort((a, b) => b.score - a.score);

// Causal signal confirmations are searched only around the best core models
// from the training period.  This staged search keeps the effective parameter
// count modest and prevents the untouched test slice from influencing gates.
const signalPresets = [
  { S_NAME: "base" },
  ...[120, 180, 210, 240].map((value) => ({ S_NAME: `t${value}`, S_MIN_T: value })),
  ...[1.10, 1.25, 1.50].map((value) => ({ S_NAME: `r${value}`, S_MIN_MARGIN_RATIO: value })),
  ...[3_000, 5_000, 10_000, 15_000].map((value) => ({ S_NAME: `bz${value / 1000}p`, S_BZ_MOM_MS: value, S_MIN_BZ_MOM_PCT: 0 })),
  ...[3_000, 5_000, 10_000].map((value) => ({ S_NAME: `cl${value / 1000}p`, S_CLOB_MOM_MS: value, S_MIN_CLOB_MOM: 0 })),
  { S_NAME: "bz5-r110", S_BZ_MOM_MS: 5_000, S_MIN_BZ_MOM_PCT: 0, S_MIN_MARGIN_RATIO: 1.10 },
  { S_NAME: "bz10-r110", S_BZ_MOM_MS: 10_000, S_MIN_BZ_MOM_PCT: 0, S_MIN_MARGIN_RATIO: 1.10 },
  { S_NAME: "bz5-r125", S_BZ_MOM_MS: 5_000, S_MIN_BZ_MOM_PCT: 0, S_MIN_MARGIN_RATIO: 1.25 },
  { S_NAME: "bz10-r125", S_BZ_MOM_MS: 10_000, S_MIN_BZ_MOM_PCT: 0, S_MIN_MARGIN_RATIO: 1.25 },
  { S_NAME: "bz5-cl5", S_BZ_MOM_MS: 5_000, S_MIN_BZ_MOM_PCT: 0, S_CLOB_MOM_MS: 5_000, S_MIN_CLOB_MOM: 0 },
  { S_NAME: "late-bz5", S_MIN_T: 180, S_BZ_MOM_MS: 5_000, S_MIN_BZ_MOM_PCT: 0 },
];
const signalCandidates = [];
for (const seed of trained.slice(0, 18)) for (const preset of signalPresets) signalCandidates.push({ ...seed.params, ...preset });
console.log(JSON.stringify({ phase: "signal-search", candidates: signalCandidates.length, presets: signalPresets.length }));
const signalTrained = signalCandidates.map((params, index) => {
  if ((index + 1) % 60 === 0) console.log(JSON.stringify({ phase: "signal-progress", done: index + 1, total: signalCandidates.length }));
  const train = run(split.train, params).summary;
  return { params, train, score: objective(train) };
}).sort((a, b) => b.score - a.score);

// Fee-bounded pair family.  Both variants first require full visible depth for
// both legs and a positive pair at the decision.  `PAIR_CONCURRENT` submits
// the two strict-limit GTC legs together; the sequential form waits for the
// entry arrival before sending the hedge.  The replay counts either orphaned
// concurrent leg, so the result does not assume atomic execution.
const pairCandidates = [];
for (const concurrent of ((RATIO_ONLY || ROBUST_ONLY) ? [] : [false, true]))
  for (const volRounds of [4, 6, 8])
    for (const edge of [0, 4, 8])
      for (const ceil of [.88, .90, .92, .94])
        for (const hedgeCap of [.01, .02, .03, .04, .05]) {
          const guaranteed = 1 - ceil - hedgeCap - fillFee(ceil, 1, true) - fillFee(hedgeCap, 1, true);
          if (guaranteed < .002 - EPS) continue;
          pairCandidates.push({ ...common, L_HEDGE_EXEC: "taker", L_VOL_ROUNDS: volRounds, L_EDGE_BUFFER: edge,
            L_ENTRY_FLOOR: .50, L_ENTRY_CEIL: ceil, L_HEDGE_CAP: hedgeCap,
            REQUIRE_PAIR_AT_ENTRY: true, REQUIRE_PAIR_PROFIT: .002, PAIR_CONCURRENT: concurrent });
        }
console.log(JSON.stringify({ phase: "pair-search", candidates: pairCandidates.length }));
const pairTrained = pairCandidates.map((params, index) => {
  if ((index + 1) % 60 === 0) console.log(JSON.stringify({ phase: "pair-progress", done: index + 1, total: pairCandidates.length }));
  const train = run(split.train, params).summary;
  return { params, train, score: objective(train) };
}).sort((a, b) => b.score - a.score);

// Direct search of the economically interpretable safety ratio
// |gap| / possibleMove.  It is crossed with broader core settings rather than
// attached only to the already-best unfiltered seeds.
const ratioCandidates = [];
for (const volRounds of ((RATIO_ONLY || ROBUST_ONLY) ? [4, 6, 8] : [4, 6, 8, 12]))
  for (const edge of ((RATIO_ONLY || ROBUST_ONLY) ? [4, 8, 12] : [0, 4, 8, 12]))
    for (const floor of [.50, .60])
      for (const ceil of [.84, .86, .88, .90])
        for (const ratio of [1.025, 1.05, 1.075, 1.10, 1.15])
          for (const limitOffset of [null, 0, .01, .02]) ratioCandidates.push({ ...common,
            L_HEDGE_EXEC: "taker", L_VOL_ROUNDS: volRounds, L_EDGE_BUFFER: edge, L_ENTRY_FLOOR: floor,
            L_ENTRY_CEIL: ceil, ENTRY_LIMIT_OFFSET: limitOffset,
            S_NAME: `r${ratio}-lo${limitOffset == null ? "cap" : limitOffset}`, S_MIN_MARGIN_RATIO: ratio });
console.log(JSON.stringify({ phase: "ratio-search", candidates: ratioCandidates.length }));
const ratioTrained = ratioCandidates.map((params, index) => {
  if ((index + 1) % 80 === 0) console.log(JSON.stringify({ phase: "ratio-progress", done: index + 1, total: ratioCandidates.length }));
  const train = run(split.train, params).summary;
  return { params, train, score: objective(train) };
}).sort((a, b) => b.score - a.score);

// The validation set is consulted only for the strongest older-period models.
// In ROBUST mode, training candidates first have to survive three latency
// assumptions. Validation then ranks those survivors on the same worst-case
// basis. The test period remains excluded from both selection stages.
let validated, chosen, robustSelection = null;
if (ROBUST_ONLY) {
  const latencies = [520, 780, 1040];
  console.log(JSON.stringify({ phase: "robust-train-stress", candidates: Math.min(180, ratioTrained.length), latencies }));
  const robustTrained = ratioTrained.slice(0, 180).map((row, index) => {
    if ((index + 1) % 30 === 0) console.log(JSON.stringify({ phase: "robust-train-progress", done: index + 1, total: Math.min(180, ratioTrained.length) }));
    const trainStresses = latencies.map((latency) => ({ latency, summary: latency === 520 ? row.train : run(split.train, { ...row.params, LATENCY_MS: latency }).summary }));
    return { ...row, trainStresses, robustTrainScore: robustObjective(trainStresses, 10) };
  }).filter((row) => Number.isFinite(row.robustTrainScore)).sort((a, b) => b.robustTrainScore - a.robustTrainScore);
  console.log(JSON.stringify({ phase: "robust-validation-stress", candidates: Math.min(60, robustTrained.length), latencies }));
  validated = robustTrained.slice(0, 60).map((row, index) => {
    if ((index + 1) % 15 === 0) console.log(JSON.stringify({ phase: "robust-validation-progress", done: index + 1, total: Math.min(60, robustTrained.length) }));
    const validationStresses = latencies.map((latency) => ({ latency, summary: run(split.validation, { ...row.params, LATENCY_MS: latency }).summary }));
    return { ...row, validation: validationStresses[0].summary, validationStresses,
      robustValidationScore: robustObjective(validationStresses, 6) };
  }).filter((row) => Number.isFinite(row.robustValidationScore));
  validated.sort((a, b) => {
    const aAll = a.trainStresses.every((row) => row.summary.pnl > 0) && a.validationStresses.every((row) => row.summary.pnl > 0);
    const bAll = b.trainStresses.every((row) => row.summary.pnl > 0) && b.validationStresses.every((row) => row.summary.pnl > 0);
    if (aAll !== bAll) return Number(bAll) - Number(aAll);
    return (b.robustTrainScore + b.robustValidationScore) - (a.robustTrainScore + a.robustValidationScore);
  });
  chosen = validated[0];
  robustSelection = {
    method: "rank train then validation by worst fee-inclusive PnL across 520/780/1040ms; test excluded",
    trainingCandidates: robustTrained.length,
    validationCandidates: validated.length,
    trainStresses: chosen?.trainStresses,
    validationStresses: chosen?.validationStresses,
  };
} else {
  const validationSeeds = new Map();
  for (const row of [...trained.slice(0, 18), ...signalTrained.slice(0, 36), ...pairTrained.slice(0, 36), ...ratioTrained.slice(0, 48)]) validationSeeds.set(label(row.params), row);
  validated = [...validationSeeds.values()].map((row) => ({ ...row, validation: run(split.validation, row.params).summary }));
  validated.sort((a, b) => {
    const ap = a.train.pnl > 0 && a.validation.pnl > 0;
    const bp = b.train.pnl > 0 && b.validation.pnl > 0;
    if (ap !== bp) return bp - ap;
    return (objective(b.train) + objective(b.validation)) - (objective(a.train) + objective(a.validation));
  });
  chosen = validated[0];
}
if (!chosen) throw new Error("no candidate reached the minimum chronological sample requirements");
const testRun = run(split.test, chosen.params);
const fullRun = run(feeds, chosen.params);

// Only after the candidate is frozen do we expose the untouched test and
// execution-assumption sensitivities.
const stresses = [];
for (const latency of [520, 780, 1040]) {
  for (const makerFill of chosen.params.L_HEDGE_EXEC === "maker" ? [0, .25, 1] : [1]) {
    for (const confirmMs of chosen.params.L_HEDGE_EXEC === "maker" ? [0, 250, 1000] : [0]) {
      const params = { ...chosen.params, LATENCY_MS: latency, MAKER_FILL_FRACTION: makerFill, MAKER_TOUCH_CONFIRM_MS: confirmMs };
      stresses.push({ latency, makerFill, confirmMs, test: run(split.test, params).summary, full: run(feeds, params).summary });
    }
  }
}

const current = { ...common, L_HEDGE_EXEC: "maker", L_VOL_ROUNDS: 6, L_EDGE_BUFFER: 8, L_ENTRY_FLOOR: .50, L_ENTRY_CEIL: .88 };
const currentStrict = run(feeds, current).summary;
const currentLegacyLimit = run(feeds, { ...current, STRICT_LIMITS: false }).summary;

// One-factor neighborhood audit of the frozen candidate. This is an audit,
// never a second selection pass: no neighbor can replace `chosen` after test
// outcomes are exposed. A real edge should not disappear under one small
// parameter perturbation.
const neighborParams = [];
const addNeighbor = (name, patch) => neighborParams.push({ name, params: { ...chosen.params, ...patch } });
for (const value of [...new Set([Math.max(2, chosen.params.L_VOL_ROUNDS - 2), chosen.params.L_VOL_ROUNDS + 2])]) addNeighbor(`vol=${value}`, { L_VOL_ROUNDS: value });
for (const value of [...new Set([Math.max(0, chosen.params.L_EDGE_BUFFER - 4), chosen.params.L_EDGE_BUFFER + 4])]) addNeighbor(`edge=${value}`, { L_EDGE_BUFFER: value });
for (const value of [...new Set([round(Math.max(.4, chosen.params.L_ENTRY_FLOOR - .1), 2), round(Math.min(.8, chosen.params.L_ENTRY_FLOOR + .1), 2)])]) addNeighbor(`floor=${value}`, { L_ENTRY_FLOOR: value });
for (const value of [...new Set([round(Math.max(.80, chosen.params.L_ENTRY_CEIL - .02), 2), round(Math.min(.94, chosen.params.L_ENTRY_CEIL + .02), 2)])]) addNeighbor(`ceil=${value}`, { L_ENTRY_CEIL: value });
if (Number(chosen.params.S_MIN_MARGIN_RATIO) > 0) for (const value of [...new Set([round(Math.max(1, chosen.params.S_MIN_MARGIN_RATIO - .025), 3), round(chosen.params.S_MIN_MARGIN_RATIO + .025, 3)])]) addNeighbor(`ratio=${value}`, { S_MIN_MARGIN_RATIO: value });
const neighborhood = neighborParams.map(({ name, params }) => ({ name,
  stresses: [520, 780, 1040].map((latency) => ({ latency,
    validation: run(split.validation, { ...params, LATENCY_MS: latency }).summary,
    test: run(split.test, { ...params, LATENCY_MS: latency }).summary })) }));
const neighborhoodCells = neighborhood.flatMap((row) => row.stresses.flatMap((stress) => [stress.validation, stress.test]));
const positiveNeighborhood = neighborhoodCells.filter((summary) => summary.pnl > 0).length;
const confidenceIntervals = {
  full: confidence(fullRun.rows, feeds),
  test: confidence(testRun.rows, split.test),
};

const positiveStresses = stresses.filter((row) => row.test.pnl > 0).length;
const minimumCurrentRegimeDays = 30;
const observedDays = (feeds.at(-1).startMs + WINDOW_MS - feeds[0].startMs) / 86_400_000;
const acceptance = {
  enoughCurrentRegimeHistory: observedDays >= minimumCurrentRegimeDays && coveragePct >= 90,
  positiveTrain: chosen.train.pnl > 0,
  positiveValidation: chosen.validation.pnl > 0,
  positiveTest: testRun.summary.pnl > 0,
  enoughTestTrades: testRun.summary.active >= 100,
  testProfitFactor: testRun.summary.profitFactor >= 1.25,
  testDrawdownControlled: testRun.summary.pnl > 0 && testRun.summary.maxDrawdown <= testRun.summary.pnl,
  allExecutionStressesPositive: positiveStresses === stresses.length,
  bootstrapTradeLowerPositive: confidenceIntervals.full.trade.lower95 > 0,
  bootstrapDayBlockLowerPositive: confidenceIntervals.full.dayBlock.lower95 > 0,
  parameterNeighborhoodRobust: neighborhoodCells.length > 0 && positiveNeighborhood === neighborhoodCells.length,
};
acceptance.passed = Object.values(acceptance).every(Boolean);

const output = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: "bapi-v4 include_orderbook=true caches; Binance spot signal; v4 Chainlink-settled winner; target-wallet activity excluded",
  range: { requestedFrom: new Date(FROM_MS).toISOString(), requestedTo: new Date(TO_MS).toISOString(), observedDays: round(observedDays, 3), coveragePct: round(coveragePct, 3), ...split.boundaries },
  execution: {
    taker: "first v4 snapshot at/after decision+latency; walk recorded asks only through the submitted GTC limit; exact crypto taker fee",
    maker: "post-only arrival rejection; then historical ask touch proxy with explicit TTL, fill-fraction, and touch-confirmation sensitivities; zero maker fee",
    conservativeRemainder: "unfilled taker depth and nonmarketable arrival remainders are ignored rather than assigned an invented queue fill",
  },
  selected: { label: label(chosen.params), params: chosen.params, train: chosen.train, validation: chosen.validation, test: testRun.summary, full: fullRun.summary },
  robustSelection,
  topValidation: validated.slice(0, 30).map((row) => ({ label: label(row.params), params: row.params, train: row.train, validation: row.validation,
    trainStresses: row.trainStresses, validationStresses: row.validationStresses })),
  stresses,
  confidence: confidenceIntervals,
  neighborhood: { positiveCells: positiveNeighborhood, totalCells: neighborhoodCells.length, rows: neighborhood },
  currentProfileAudit: { strictArrivalLimits: currentStrict, legacy099Limits: currentLegacyLimit },
  acceptance,
};

const outDir = path.join(ROOT, "data/research");
fs.mkdirSync(outDir, { recursive: true });
const outputName = ROBUST_ONLY ? "lockstep-v4-robust.json" : "lockstep-v4-walkforward.json";
fs.writeFileSync(path.join(outDir, outputName), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ phase: "result", selected: output.selected, currentProfileAudit: output.currentProfileAudit, acceptance }, null, 2));
