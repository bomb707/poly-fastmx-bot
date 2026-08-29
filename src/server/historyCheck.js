// historyCheck.js — backs the /history-check page.
//   (1) getTrackerBuys() — tracked-wallet taker BUY orders over the last N days, each with its ON-CHAIN
//       placed time (placedMs). Heavy (data-api + RPC decode) → disk-cached.
//   (2) estimateMomentum(excluded) — grid-search the LIVE momentum params (lb, sens, dens, min) that
//       best reproduce the placed times of the NON-excluded buys (the page lets you tick wash buys to
//       drop). Uses the SAME research/momentum.js the live engine + backtest use, so the result is
//       directly usable as config.
import fs from "node:fs";
import path from "node:path";
import { ordersForTx } from "../sources/onchain.js";
import { config } from "../config/config.js";
import { velocitySeries, markEvents, buySide } from "../../engine/momentum.js";

const W = config.wallet.toLowerCase();
const DAPI = (config.dataApiHost || "https://data-api.polymarket.com").replace(/\/$/, "");
const BT = (config.backtestApi || "http://localhost:3841").replace(/\/$/, "");
const ONCHAIN_CACHE = new URL("../../research/.onchain-cache.json", import.meta.url).pathname;
const BUYS_CACHE = path.join(config.dataDir, "tracker-buys.json");

async function gj(u, n = 2, timeoutMs = 12000) {
  for (let i = 0; i < n; i++) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs);   // fail fast — a hung API can't stall the whole estimate
    try { const r = await fetch(u, { signal: ac.signal }); if (r.ok) return await r.json(); } catch {} finally { clearTimeout(to); }
    await new Promise((s) => setTimeout(s, 200 * (i + 1)));
  }
  return null;
}
const MIDS_DIR = path.join(config.dataDir, "mids");   // per-slug CLOB mid cache (resolved windows are static)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BT_THROTTLE_MS = 60;   // gap between backtest-API fetches — keep it gentle so it never trips a rate limit / drops
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

async function fetchFills(start, end) {
  const seen = new Map(), chunk = 6 * 3600;
  for (let s = start; s < end; s += chunk) {
    const e = Math.min(end, s + chunk);
    for (let off = 0; off <= 20000; off += 500) {       // paginate within the chunk (limit=500 would otherwise truncate)
      const a = await gj(`${DAPI}/activity?user=${W}&limit=500&offset=${off}&start=${s}&end=${e}`);
      const arr = Array.isArray(a) ? a : []; let added = 0;
      for (const x of arr) if (x.type === "TRADE" && x.side === "BUY") { const k = x.transactionHash + ":" + x.asset; if (!seen.has(k)) { seen.set(k, x); added++; } }
      if (arr.length < 500 || added === 0) break;        // last page (or offset unsupported → no new rows)
    }
  }
  return [...seen.values()];
}

/** Tracked-wallet taker GTC BUY orders (one per on-chain orderHash) over the last `days`. Disk-cached (6h). */
export async function getTrackerBuys({ days = 20, market = "btc-updown-5m", refresh = false } = {}) {
  if (!refresh) { try { const c = JSON.parse(fs.readFileSync(BUYS_CACHE, "utf8"));
    if (c && c.market === market && c.days === days && (Date.now() - c.ts) < 6 * 3600 * 1000) return c; } catch {} }
  const NOW = Math.floor(Date.now() / 1000), START = NOW - days * 86400, re = new RegExp(`^${market}-\\d+$`);
  const fills = await fetchFills(START, NOW);
  const takerFills = fills.filter((f) => re.test(f.slug) && ((+f.usdcSize || 0) - (+f.price || 0) * (+f.size || 0)) > 0.01);
  const winFills = new Map(); for (const f of fills) if (re.test(f.slug)) { if (!winFills.has(f.slug)) winFills.set(f.slug, []); winFills.get(f.slug).push(f); }
  const takerTxs = [...new Set(takerFills.map((f) => f.slug + "|" + f.transactionHash))];
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(ONCHAIN_CACHE, "utf8")); } catch {}
  const orders = new Map();
  estProgress.phase = "fetching buys"; estProgress.done = 0; estProgress.total = takerTxs.length; let decoded = 0;   // live progress for the decode
  await pool(takerTxs, 3, async (key) => {
    const [slug, tx] = key.split("|"); const ws = Number(slug.split("-").pop());
    const tok2side = new Map(); for (const f of winFills.get(slug) || []) tok2side.set(String(f.asset), f.outcome);
    let arr = cache[tx];
    if (!arr) { const raw = (await ordersForTx(tx).catch(() => [])) || [];
      if (raw.length) cache[tx] = arr = raw.map((o) => ({ orderHash: o.orderHash, isBuy: o.isBuy, fee: o.fee, tokenId: String(o.tokenId), filledSize: o.filledSize, fullSize: o.fullSize, fullyFilled: o.fullyFilled, limitPx: o.limitPx, placedMs: o.placedMs, filledTs: o.filledTs })); else arr = []; }
    for (const o of arr) {
      if (!o.isBuy || !(o.fee > 0) || !o.placedMs) continue;            // takers only (fee>0); reliable placedMs
      const side = tok2side.get(String(o.tokenId)); if (!side) continue;
      const cur = orders.get(o.orderHash) || { orderHash: o.orderHash, slug, ws, side, shares: 0, fullSize: null, full: !!o.fullyFilled, limitPx: o.limitPx, placedMs: o.placedMs, filledTs: o.filledTs };
      cur.shares += +o.filledSize || 0; cur.full = cur.full || !!o.fullyFilled;
      if (o.fullSize != null) cur.fullSize = o.fullSize;               // order size (GTC); null for marketable / un-recached
      orders.set(o.orderHash, cur);
    }
    estProgress.done = ++decoded;
  });
  try { fs.writeFileSync(ONCHAIN_CACHE, JSON.stringify(cache)); } catch {}
  // all-in cost per (window, side) from the data-api taker fills: usdcSize = notional + taker fee (what was actually paid)
  const costBy = new Map();
  for (const f of takerFills) { const k = f.slug + "|" + f.outcome, c = costBy.get(k) || { usdc: 0, notional: 0, shares: 0 };
    c.usdc += +f.usdcSize || 0; c.notional += (+f.price || 0) * (+f.size || 0); c.shares += +f.size || 0; costBy.set(k, c); }
  const buys = [...orders.values()].map((o) => {
    const tTrig = o.placedMs / 1000 - o.ws, delayS = o.filledTs != null ? o.filledTs - Math.floor(o.placedMs / 1000) : null;
    const filled = +(+o.shares).toFixed(2);
    // full size: prefer the on-chain order size; else (fully filled) filled == full; else unknown (re-decode via reload)
    const fullSize = o.fullSize != null ? +(+o.fullSize).toFixed(2) : (o.full ? filled : null);
    return { orderHash: o.orderHash, slug: o.slug, ws: o.ws, side: o.side, shares: filled, fullSize,
      full: o.full, limitPx: o.limitPx != null ? +o.limitPx : null, placedMs: o.placedMs, tTrig: +tTrig.toFixed(3), delayS };
  }).filter((o) => o.tTrig >= 0 && o.tTrig <= config.windowSec).sort((a, b) => a.ws - b.ws || a.tTrig - b.tTrig);
  // settle each window's winning side (free — it rides in the snapshot-ticks meta) → realized PnL per buy
  const uslugs = [...new Set(buys.map((b) => b.slug))];
  estProgress.phase = "resolving outcomes"; estProgress.done = 0; estProgress.total = uslugs.length; let wseen = 0;
  const winBy = new Map();
  await pool(uslugs, 4, async (slug) => { try { winBy.set(slug, await windowWin(slug)); } catch {} estProgress.done = ++wseen; });
  saveWinCache();
  for (const b of buys) {
    b.winSide = winBy.get(b.slug) ?? null;
    // all-in cost for this order = its window+side cost prorated by this order's share of that side's fills
    const c = costBy.get(b.slug + "|" + b.side);
    if (c && c.shares > 0) { const frac = Math.min(1, b.shares / c.shares);
      b.cost = +(c.usdc * frac).toFixed(4); b.fee = +((c.usdc - c.notional) * frac).toFixed(4); }
    else { b.cost = b.limitPx != null ? +(b.shares * b.limitPx).toFixed(4) : null; b.fee = null; }   // fallback ≈ filled×limit
    // payout = $1/share if the bought side won; cost is all-in (already includes the taker fee)
    b.pnl = (b.cost != null && b.winSide != null) ? +((b.winSide === b.side ? b.shares : 0) - b.cost).toFixed(3) : null;
  }
  const out = { market, days, ts: Date.now(), windowSec: config.windowSec, count: buys.length, buys };
  try { fs.writeFileSync(BUYS_CACHE, JSON.stringify(out)); } catch {}
  return out;
}

const _midCache = new Map();   // slug -> [{t,m}]  (in-memory; also persisted per-slug on disk)
async function windowMids(slug) {
  if (_midCache.has(slug)) return _midCache.get(slug);
  const f = path.join(MIDS_DIR, slug + ".json");
  try { const m = JSON.parse(fs.readFileSync(f, "utf8")); if (Array.isArray(m)) { _midCache.set(slug, m); return m; } } catch {}
  const ws = Number(slug.split("-").pop()), mids = [];
  for (let page = 1; ; page++) {
    const d = await gj(`${BT}/snapshot-ticks?slug=${slug}&page=${page}&limit=2000`); if (!d || !d.ticks) break;
    if (page === 1 && d.winSide != null) { _winLoad(); _winSide.set(slug, d.winSide); }   // winning side rides in the meta — capture it free
    for (const t of d.ticks) { const up = t.upBestAsk != null ? +t.upBestAsk : null, dn = t.downBestAsk != null ? +t.downBestAsk : null;
      if (up != null && dn != null) mids.push({ t: (+t.capturedAtMs - ws * 1000) / 1000, m: (up + (1 - dn)) / 2 }); }
    if (page >= (d.pagination?.totalPages || 1)) break;
    await sleep(BT_THROTTLE_MS);   // throttle between backtest-API pages
  }
  mids.sort((a, b) => a.t - b.t); _midCache.set(slug, mids);
  if (mids.length) { try { fs.mkdirSync(MIDS_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(mids)); } catch {} }   // cache to disk (static once resolved)
  return mids;
}

// resolved winning side per window ("Up"/"Down") — static once settled; disk-cached so it's fetched at most once.
const WINSIDE_CACHE = path.join(config.dataDir, "winsides.json");
let _winSide = null;
function _winLoad() { if (_winSide) return; _winSide = new Map(); try { const o = JSON.parse(fs.readFileSync(WINSIDE_CACHE, "utf8")); for (const k in o) _winSide.set(k, o[k]); } catch {} }
function saveWinCache() { _winLoad(); try { const o = {}; for (const [k, v] of _winSide) if (v != null) o[k] = v; fs.writeFileSync(WINSIDE_CACHE, JSON.stringify(o)); } catch {} }
async function windowWin(slug) {
  _winLoad();
  if (_winSide.get(slug) != null) return _winSide.get(slug);          // cached & resolved → done
  const d = await gj(`${BT}/snapshot-ticks?slug=${slug}&page=1&limit=1`);   // a single tick is enough; winSide is in the meta
  const w = d && d.winSide != null ? d.winSide : null;
  _winSide.set(slug, w); await sleep(BT_THROTTLE_MS); return w;
}

const LBS = [5, 10, 15, 20, 30, 45, 60], SENSES = [0, 0.3, 0.5, 0.75], DENSES = [0, 0.3], MINS = [0, 0.02, 0.05, 0.1, 0.15];

// live progress + result for the estimate (the page POSTs to START it, then polls /api/estimate-progress;
// the heavy work runs in the BACKGROUND so no single request is held long enough for a proxy to cut it).
export const estProgress = { active: false, phase: "", done: 0, total: 0, result: null, error: null, id: 0 };
// Run an estimate in the background; progress + result land in estProgress. Ignores overlapping starts.
// Each run gets a fresh `id` (generation) so the client only ever applies the result of the run it started.
export function startEstimate(opts) {
  if (estProgress.active) return false;
  estProgress.id = (estProgress.id || 0) + 1;
  estProgress.active = true; estProgress.phase = "starting"; estProgress.done = 0; estProgress.total = 0;
  estProgress.result = null; estProgress.error = null;
  estimateMomentum(opts)
    .then((r) => { estProgress.result = r; })
    .catch((e) => { estProgress.error = String((e && e.message) || e); })
    .finally(() => { estProgress.active = false; });
  return true;
}

let _prewarming = false;
/** Background: load (disk-cache) the CLOB ticks for a set of buys' windows, so a later estimate is fast. */
export async function prewarmMids(buys) {
  if (_prewarming || !Array.isArray(buys)) return;
  _prewarming = true;
  try { const wins = [...new Set(buys.map((b) => b.slug))].filter((s) => !_midCache.has(s));
    await pool(wins, 8, async (slug) => { try { await windowMids(slug); } catch {} });
  } catch {} finally { _prewarming = false; }
}

/** Grid-search lb/sens/dens/min to best match the placed times of the non-excluded buys. A mark counts
 *  as a match when it lands in [placedTime − offBeforeMs, placedTime + offAfterMs] (millisecond window). */
export async function estimateMomentum({ days = 20, market = "btc-updown-5m", excluded = [], offBeforeMs = 2000, offAfterMs = 2000, minTInto = 0 } = {}) {
  estProgress.phase = "fetching buys";   // surfaced while the (cached 6h) fills + on-chain decode load — not a silent stall
  const { buys } = await getTrackerBuys({ days, market });
  const ex = new Set(excluded), use = buys.filter((b) => !ex.has(b.orderHash) && b.tTrig >= minTInto);   // also drop early buys (t+ < minTInto)
  const beforeS = Math.max(0, offBeforeMs) / 1000, afterS = Math.max(0, offAfterMs) / 1000;
  const wins = [...new Set(use.map((b) => b.slug))];
  // bounded tick load: stop starting new fetches after ~40s and proceed with what we have (server-side
  // deadline so the request always returns within proxy timeouts; in-memory/disk cache fills the rest on a retry).
  estProgress.phase = "loading ticks"; estProgress.done = 0; estProgress.total = wins.length;
  const deadline = Date.now() + 40000; let loaded = 0, seen = 0;
  const midsByWin = new Map(); await pool(wins, 6, async (slug) => {                  // gentler concurrency on the backtest API
    const cached = _midCache.has(slug);
    if (!(Date.now() > deadline && !cached)) {                       // past deadline + not cached → skip this window
      const m = await windowMids(slug); midsByWin.set(slug, m); if (m.length) loaded++;
      if (!cached) await sleep(BT_THROTTLE_MS);                      // throttle only when we actually hit the API
    }
    estProgress.done = ++seen;
  });
  const partial = loaded < wins.length;
  estProgress.phase = "scoring marks"; estProgress.done = 0; estProgress.total = LBS.length * SENSES.length * DENSES.length * MINS.length;
  const buysByWin = new Map(); for (const b of use) { if (!buysByWin.has(b.slug)) buysByWin.set(b.slug, []); buysByWin.get(b.slug).push(b); }
  const vel = new Map();   // `slug|lb` -> velocity series (computed once)
  for (const slug of wins) { const mids = midsByWin.get(slug) || []; for (const lb of LBS) vel.set(slug + "|" + lb, velocitySeries(mids, lb)); }
  const results = []; let gridDone = 0;
  for (const lb of LBS) for (const sens of SENSES) for (const dens of DENSES) for (const min of MINS) {
    let matched = 0, totalMarks = 0, markMatched = 0, followN = 0, fadeN = 0, totalBuys = 0;
    for (const slug of wins) {
      const v = vel.get(slug + "|" + lb); if (!v || v.length < 3) continue;
      const marks = markEvents(v, { sens, dens, thresh: min }).filter((mk) => mk.t >= minTInto);   // honor the t+ exclude criteria
      totalMarks += marks.length;
      const bs = buysByWin.get(slug) || [];
      // RECALL + direction: each buy → its closest mark in [placed−before, placed+after]
      for (const b of bs) {
        totalBuys++; let hit = null;
        for (const mk of marks) if (mk.t >= b.tTrig - beforeS && mk.t <= b.tTrig + afterS && (!hit || Math.abs(mk.t - b.tTrig) < Math.abs(hit.t - b.tTrig))) hit = mk;
        if (hit) { matched++; if (b.side === (hit.v > 0 ? "Up" : "Down")) followN++; else fadeN++; }   // bought the rising side? → follow
      }
      // PRECISION: each mark → does ANY buy fall in its window? (counts MARKS, so it can't exceed totalMarks)
      for (const mk of marks) if (bs.some((b) => b.tTrig >= mk.t - afterS && b.tTrig <= mk.t + beforeS)) markMatched++;
    }
    const recall = totalBuys ? matched / totalBuys : 0, precision = totalMarks ? markMatched / totalMarks : 0;
    const falseFires = totalMarks - markMatched;                       // config TRIGGERS the bot never acted on (no buy in the window)
    // ACCURACY now penalizes false fires: overlap of {bot buys} vs {config triggers} = matched / (bot buys + false fires).
    const accuracy = (totalBuys + falseFires) ? matched / (totalBuys + falseFires) : 0;
    const f1 = (recall + precision) ? (2 * recall * precision) / (recall + precision) : 0;
    // DIRECTION is ESTIMATED, not chosen: the dominant behaviour of the matched buys (follow/fade counts).
    const dir = followN >= fadeN ? "follow" : "fade", dirAcc = matched ? Math.max(followN, fadeN) / matched : 0;
    results.push({ lb, sens, dens, min, accuracy: +accuracy.toFixed(3), recall: +recall.toFixed(3), precision: +precision.toFixed(3),
      dir, dirAcc: +dirAcc.toFixed(3), follow: followN, fade: fadeN, matched, totalMarks, markMatched, falseFires, f1: +f1.toFixed(3) });
    estProgress.done = ++gridDone;                                   // update the live count
    if ((gridDone & 7) === 0) await sleep(0);                        // yield so /api/estimate-progress can be served mid-scan
  }
  estProgress.done = estProgress.total;
  // rank by the false-fire-aware accuracy (the total score), F1 as tie-break
  results.sort((a, b) => b.accuracy - a.accuracy || b.f1 - a.f1);
  const best = results[0] || null;
  // per-buy follow/fade at the BEST lb: rising = sign(velocity@placed); follow if the buy took the rising side.
  const perBuy = {};
  const falseFires = [];   // the WINNING config's marks that coincided with NO real bot buy
  if (best) {
    const velAt = (s, t) => { let v = null; for (const p of s) { if (p.t <= t) v = p.v; else break; } return v; };
    for (const slug of wins) {
      const s = vel.get(slug + "|" + best.lb); if (!s || s.length < 3) continue;
      const marks = markEvents(s, { sens: best.sens, dens: best.dens, thresh: best.min }).filter((mk) => mk.t >= minTInto);   // winning config's marks, t+ gated
      const bs = buysByWin.get(slug) || [];
      for (const b of bs) {
        const v = velAt(s, b.tTrig);                                                          // momentum score @ placed (always measurable)
        let hit = null; for (const mk of marks) if (mk.t >= b.tTrig - beforeS && mk.t <= b.tTrig + afterS && (!hit || Math.abs(mk.t - b.tTrig) < Math.abs(hit.t - b.tTrig))) hit = mk;
        perBuy[b.orderHash] = {
          vel: v != null ? +v.toFixed(4) : null, matched: !!hit,
          markT: hit ? +hit.t.toFixed(3) : null, markVel: hit ? +hit.v.toFixed(4) : null,
          dms: hit ? Math.round((hit.t - b.tTrig) * 1000) : null,
          // follow/fade is defined ONLY when a mark matched (no mark → no momentum signal → no direction)
          ff: hit ? (b.side === (hit.v > 0 ? "Up" : "Down") ? "follow" : "fade") : null,
        };
      }
      // FALSE FIRES: marks with NO buy in [mk−after, mk+before]; record the gap to the nearest real buy in the window
      const ws = Number(slug.split("-").pop());
      for (const mk of marks) {
        if (bs.some((b) => b.tTrig >= mk.t - afterS && b.tTrig <= mk.t + beforeS)) continue;   // it matched a buy → not a false fire
        let nd = null; for (const b of bs) { const dt = mk.t - b.tTrig; if (nd == null || Math.abs(dt) < Math.abs(nd)) nd = dt; }
        falseFires.push({ slug, ws, t: +mk.t.toFixed(3), vel: +mk.v.toFixed(4), side: mk.v > 0 ? "Up" : "Down",
          nearestDt: nd != null ? +nd.toFixed(3) : null, buysInWin: bs.length });
      }
    }
    falseFires.sort((a, b) => a.ws - b.ws || a.t - b.t);
  }
  const FF_CAP = 2000;
  return { market, days, direction: best ? best.dir : null, offBeforeMs, offAfterMs, minTInto, totalBuys: use.length, excluded: excluded.length,
    windows: wins.length, windowsUsed: loaded, partial, best, perBuy,
    falseFires: falseFires.slice(0, FF_CAP), falseFiresTotal: falseFires.length, falseFireWindows: new Set(falseFires.map((f) => f.slug)).size,
    top: results.slice(0, 15) };
}
