import { config } from "../config/config.js";
import { getJson } from "../util/util.js";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ── SETTLED-WINDOW DISK CACHE — makes backtests REPRODUCIBLE. Recent windows are still being recorded, so two fetches
//    of the same slug return different ticks → two runs (or two processes) diverge. We cache a window's tick+meta ONCE
//    it is SETTLED (winSide present) AND stable (ended > WIN_CACHE_STABLE_SEC ago), keyed by slug+apiVersion. Reruns of
//    a settled range then replay byte-identical data. Recent/unsettled windows are never cached → always re-fetched. ──
function _cacheDir() { return path.join(config.dataDir, "wincache"); }
function _cachePath(slug) { return path.join(_cacheDir(), `${slug}_v2-l2-120-coherent.json.gz`); }
function _cacheRead(slug) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(_cachePath(slug)))); } catch { return null; } }
function _cacheWrite(slug, data) { try {
  fs.mkdirSync(_cacheDir(), { recursive: true });
  fs.writeFileSync(_cachePath(slug), zlib.gzipSync(JSON.stringify(data), { level: 6 }));
} catch {} }

// The recorder indexes a closed window asynchronously. Resolution metadata can
// arrive before the last order-book page, so "settled + old enough" alone is not
// sufficient evidence that a replay is immutable. Never accept/cache a replay
// unless its last coherent L2 frame reaches the end of the five-minute window.
export const V2_REPLAY_END_TOLERANCE_SEC = 2;
export function hasCompleteV2Coverage(data, windowSec = config.windowSec || 300) {
  if (!Array.isArray(data?.ticks) || !data.ticks.length) return false;
  const lastT = Number(data.ticks.at(-1)?.t);
  return Number.isFinite(lastT) && lastT >= windowSec - V2_REPLAY_END_TOLERANCE_SEC;
}

// ── Full-depth backtest source ──────────────────────────────────────────────────────────────────────
// /snapshot-ticks supplies authoritative window metadata; /orderbooks supplies coherent 50 ms full-L2 frames.
// The strategy needs actual visible depth, so a BBA-only replay is deliberately not accepted. We retain the last
// observed frame in each 120 ms live-sampler bucket, preserving causality and matching the dashboard cadence.
async function fetchTicksMeta(slug, ws) {
  if (config.winCache) {
    const c = _cacheRead(slug);
    if (c && c.winSide != null && hasCompleteV2Coverage(c)) return c;
  }
  const r = await fetchV2L2(slug, ws);
  // Cache only a SETTLED + STABLE window (its data is now immutable) — never a recent/unsettled one (still filling).
  if (config.winCache && r && r.winSide != null && hasCompleteV2Coverage(r)
      && (Date.now() / 1000 - (ws + (config.windowSec || 300))) > (config.winCacheStableSec || 600)) _cacheWrite(slug, r);
  return r;
}
const ORDERBOOK_PAGE = 2000;
export const V2_REPLAY_SAMPLE_MS = 120;
const numberOrNull = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};

export function normalizeV2Levels(levels, side, limit = Infinity) {
  const out = (Array.isArray(levels) ? levels : []).map((level) => [
    numberOrNull(Array.isArray(level) ? level[0] : level?.price),
    numberOrNull(Array.isArray(level) ? level[1] : level?.size),
  ]).filter(([price, size]) => price != null && size != null && size > 0);
  out.sort((a, b) => side === "bid" ? b[0] - a[0] : a[0] - b[0]);
  return out.slice(0, limit);
}

export function normalizeV2OrderbookFrame(frame, ws) {
  const ms = numberOrNull(frame?.capturedAtMs);
  if (ms == null) return null;
  const upBids = normalizeV2Levels(frame?.orderbookUp?.bids, "bid", 3);
  const upAsks = normalizeV2Levels(frame?.orderbookUp?.asks, "ask", 3);
  const dnBids = normalizeV2Levels(frame?.orderbookDown?.bids, "bid", 3);
  const dnAsks = normalizeV2Levels(frame?.orderbookDown?.asks, "ask", 3);
  const upBid = upBids[0]?.[0] ?? null, upAsk = upAsks[0]?.[0] ?? null;
  const dnBid = dnBids[0]?.[0] ?? null, dnAsk = dnAsks[0]?.[0] ?? null;
  // A market can legitimately become one-sided at the 0.001/0.999 boundary.
  // Keep the real ask fields nullable (the simulator must never buy invented
  // liquidity), but expose a display-only touch so the historical line remains
  // continuous. Prefer the same token's ask, then bid, then its complement.
  const upPlot = upAsk ?? upBid ?? (dnBid != null ? 1 - dnBid : (dnAsk != null ? 1 - dnAsk : null));
  const dnPlot = dnAsk ?? dnBid ?? (upBid != null ? 1 - upBid : (upAsk != null ? 1 - upAsk : null));
  return {
    ms, t: (ms - ws * 1000) / 1000, upAsk, dnAsk, upBid, dnBid, upPlot, dnPlot,
    cl: numberOrNull(frame.chainlinkPrice ?? frame.twapPrice),
    bz: numberOrNull(frame.binanceAggPrice ?? frame.binancePrice),
    up: { bestBid: upBid, bestAsk: upAsk, bids: upBids, asks: upAsks,
      depthKnown: upBids.length > 0 && upAsks.length > 0 },
    down: { bestBid: dnBid, bestAsk: dnAsk, bids: dnBids, asks: dnAsks,
      depthKnown: dnBids.length > 0 && dnAsks.length > 0 },
  };
}

export function downsampleV2Frames(frames, ws, sampleMs = V2_REPLAY_SAMPLE_MS) {
  const ticks = [];
  for (const frame of frames || []) {
    const tick = normalizeV2OrderbookFrame(frame, ws);
    // Keep one-sided boundary frames for chart/spot continuity. Their real asks,
    // bids and depthKnown flags remain untouched, so replay cannot trade them as
    // synthetic/infinite BBA liquidity.
    if (!tick || (tick.upPlot == null && tick.dnPlot == null)) continue;
    const bucket = Math.floor((tick.ms - ws * 1000) / sampleMs);
    if (ticks.length && ticks[ticks.length - 1]._bucket === bucket) ticks[ticks.length - 1] = { ...tick, _bucket: bucket };
    else ticks.push({ ...tick, _bucket: bucket });
  }
  for (const tick of ticks) delete tick._bucket;
  return ticks;
}

async function fetchV2L2(slug, ws) {
  // Attach both handlers immediately. A just-opened window can return 404
  // before the slower paginated L2 request finishes; leaving that rejection
  // temporarily unobserved produces PromiseRejectionHandled warnings and can
  // terminate stricter Node deployments.
  const metaPromise = getJson(`${config.backtestApi}/snapshot-ticks?slug=${encodeURIComponent(slug)}&page=1&limit=1`, 20000)
    .then((value) => ({ value }), (error) => ({ error }));
  const ticks = [];
  for (let page = 1; ; page++) {
    const d = await getJson(`${config.v2OrderbookApi}/orderbooks?slug=${encodeURIComponent(slug)}&page=${page}&limit=${ORDERBOOK_PAGE}`, 45000);
    const pageTicks = downsampleV2Frames(d.frames || [], ws, V2_REPLAY_SAMPLE_MS);
    // A page boundary can share a bucket. Latest observed frame wins.
    if (ticks.length && pageTicks.length && Math.floor((ticks.at(-1).ms - ws * 1000) / V2_REPLAY_SAMPLE_MS)
        === Math.floor((pageTicks[0].ms - ws * 1000) / V2_REPLAY_SAMPLE_MS)) ticks.pop();
    ticks.push(...pageTicks);
    if (page >= (d.pagination?.totalPages || 0)) break;
  }
  const metaResult = await metaPromise;
  if (metaResult.error) throw metaResult.error;
  const meta = metaResult.value;
  return { ticks,
    source: "v2-orderbook-l2", sourceFrameMs: 50, replaySampleMs: V2_REPLAY_SAMPLE_MS,
    openPrice: meta?.openPrice != null ? Number(meta.openPrice) : null,
    openBinance: meta?.openBinancePrice != null ? Number(meta.openBinancePrice) : (ticks.find((t) => t.bz != null)?.bz ?? null),
    finalPrice: meta?.finalPrice != null ? Number(meta.finalPrice) : null,
    finalBinance: meta?.finalBinancePrice != null ? Number(meta.finalBinancePrice) : null,
    winSide: meta?.winSide ?? null };
}

/**
 * Reconstruct a full PAST window for the dashboard's history view:
 *   - price ticks (up/down ask, chainlink, binance) from the local backtest API
 *   - the bot's BUY fills from data-api, joined to the ticks to recompute the
 *     same per-fill context the live path produces (gaps, book before/after,
 *     order-type, hedge class, running position/PnL).
 *
 * @param {string} slug e.g. btc-updown-5m-1781349000
 * @param {{ ticksOnly?: boolean }} [opts]  ticksOnly=true → skip Polymarket activity (session shadow backtests).
 */
export async function fetchWindowHistory(slug, opts = {}) {
  const ws = Number(slug.split("-").pop());
  if (!Number.isFinite(ws)) throw new Error("bad slug");

  // 1) V2 coherent full-L2 ticks + authoritative settlement metadata.
  const { ticks, openPrice, openBinance, finalPrice, finalBinance, winSide,
    source, sourceFrameMs, replaySampleMs } = await fetchTicksMeta(slug, ws);

  // 2) the bot's fills for this window (optional — session shadow runs skip this to halve remote calls)
  let acts = [];
  if (!opts.ticksOnly && config.wallet) {
    try {
      acts = await getJson(`${config.dataApiHost}/activity?user=${config.wallet}&limit=500&start=${ws - 120}&end=${ws + 360}`, 15000);
    } catch { acts = []; }
  }
  const trades = (Array.isArray(acts) ? acts : [])
    .filter((a) => a.slug === slug && a.type === "TRADE" && a.side === "BUY")
    .sort((a, b) => a.timestamp - b.timestamp);

  const tickBefore = (ms) => { let p = ticks[0] || null; for (const t of ticks) { if (t.ms <= ms) p = t; else break; } return p; };
  const tickAfter = (ms) => { for (const t of ticks) if (t.ms > ms) return t; return null; };
  const gap = (cur, open) => (cur != null && open != null && open !== 0 ? { g: cur - open, pct: ((cur - open) / Math.abs(open)) * 100 } : { g: null, pct: null });

  let up = 0, dn = 0, cost = 0, upCost = 0, dnCost = 0;
  const buys = trades.map((a) => {
    const ts = a.timestamp, tsMs = ts * 1000;
    const size = Number(a.size) || 0, usdc = Number(a.usdcSize) || 0;
    // TRUE fill price = the API's `price` field. NOT usdcSize/size — that's fee-inclusive
    // (usdcSize = price·size + taker fee), so it overstates the price by the per-share fee.
    const apiPx = Number(a.price);
    const effPx = Number.isFinite(apiPx) && apiPx > 0 ? apiPx : (size ? usdc / size : null);
    const side = a.outcome;
    const before = tickBefore(tsMs + 999), after = tickAfter(tsMs + 999);
    const bz = before ? before.bz : null, cl = before ? before.cl : null;
    const askKey = side === "Up" ? "upAsk" : "dnAsk";
    const askBefore = before ? before[askKey] : null, askAfter = after ? after[askKey] : null;
    // TAKER = a fee was actually charged (usdcSize > price·shares). Ground truth from the feed —
    // far more reliable than the old effPx≥ask guess (which mislabeled ~430/433 fee-paying takers
    // as makers). Makers pay no fee → extra≈0.
    const extra = (effPx != null && size) ? usdc - effPx * size : null;
    const expFee = (effPx != null && size) ? 0.07 * effPx * (1 - effPx) * size : 0;
    const taker = extra == null ? null : (expFee > 0 ? extra > 0.5 * expFee : extra > 0.001);
    const bookWalk = askBefore != null ? effPx > askBefore + 0.005 : null;
    let label = "unknown";
    if (taker === true) label = bookWalk ? "TAKER/book-walk (marketable, FAK-like)" : "TAKER (marketable, paid fee)";
    else if (taker === false) label = "MAKER (resting — no fee)";
    // hedge class vs net BEFORE this fill
    const nb = up - dn;
    const posClass = Math.abs(nb) < 1e-9 ? "OPEN" : ((side === "Up") !== (nb > 0) ? "HEDGE(reduce net)" : "ADD(grow net)");
    // apply
    if (side === "Up") { up += size; upCost += usdc; } else { dn += size; dnCost += usdc; }
    cost += usdc;
    const bzG = gap(bz, openBinance), clG = gap(cl, openPrice);
    return {
      slug, side, tInto: ts - ws, shares: size, usdc, effPx,
      bz, cl,   // absolute spot price at fill (coin price)
      bzGap: bzG.g, bzGapPct: bzG.pct, clGap: clG.g, clGapPct: clG.pct,
      spread: bz != null && cl != null ? bz - cl : null,
      spreadPct: bz != null && cl != null && cl !== 0 ? ((bz - cl) / cl) * 100 : null,
      posClass,
      orderHint: { taker, bookWalk, askBefore, askAfter, askJump: askBefore != null && askAfter != null ? askAfter - askBefore : null, label },
      tx: a.transactionHash, asset: a.asset,
      pos: { upShares: up, downShares: dn, totalCost: cost, ifUpWins: up - cost, ifDownWins: dn - cost, mtm: null },
    };
  });

  // staleness / completeness checks → surfaced as a UI warning
  const warnings = [];
  const lastTickT = ticks.length ? Number(ticks.at(-1)?.t) : null;
  const l2Complete = hasCompleteV2Coverage({ ticks });
  const distinctCl = new Set(ticks.map((t) => t.cl).filter((v) => v != null)).size;
  const distinctAsk = new Set(ticks.map((t) => t.upAsk).filter((v) => v != null)).size;
  if (ticks.length === 0) warnings.push("no tick data recorded for this window");
  else if (ticks.length < 600) warnings.push(`sparse tick data (${ticks.length} ticks — window may be incomplete)`);
  if (ticks.length > 0 && !l2Complete) warnings.push(`L2 recording is still indexing (currently through ${lastTickT.toFixed(3)}s of ${config.windowSec || 300}s)`);
  if (ticks.length > 0 && distinctCl > 0 && distinctCl < 5) warnings.push("chainlink feed looks frozen (stale recording)");
  if (ticks.length > 0 && distinctAsk > 0 && distinctAsk < 3) warnings.push("order-book asks look frozen (stale recording)");
  if (winSide == null) warnings.push("window not resolved yet (no winning side)");

  // realized PnL = winning-side shares × $1 − total cost (null if unresolved)
  const realizedPnl = winSide ? ((winSide === "Up" ? up : dn) - cost) : null;
  // per-outcome leg PnL — matches Polymarket's separate position cards.
  const upLegPnl = winSide ? ((winSide === "Up" ? up : 0) - upCost) : null;
  const downLegPnl = winSide ? ((winSide === "Down" ? dn : 0) - dnCost) : null;

  return {
    slug, windowStart: ws, openPrice, openBinance,
    finalPrice, finalBinance, winSide,
    source, sourceFrameMs, replaySampleMs, l2Complete, l2LastT: lastTickT,
    upShares: up, downShares: dn, totalCost: cost, upCost, downCost: dnCost,
    upLegPnl, downLegPnl, realizedPnl,
    warning: warnings.length ? warnings.join(" · ") : null,
    ticks: ticks.map((t) => ({ ms: t.ms, t: t.t, upAsk: t.upAsk, dnAsk: t.dnAsk,
      upPlot: t.upPlot, dnPlot: t.dnPlot,
      upBid: t.upBid, dnBid: t.dnBid, cl: t.cl, bz: t.bz, up: t.up, down: t.down })),
    buys,
  };
}
