// ui-server.js — HTTP + WebSocket server for the visual tracker dashboard.
// Serves public/index.html and broadcasts live events to browser clients.
// Modeled on poly-ladder-merge-bot/src/ui-server.js (same http+ws pattern).
//
// Broadcast event types:
//   snapshot       full state on connect
//   tick           { tBz, bzGap, bzGapPct, cl, clGap, clGapPct, spread, spreadPct,
//                    window:{slug,windowStart,tInto,openPrice,openBinance},
//                    up:{bestBid,bestAsk}, down:{bestBid,bestAsk}, pos:{...} }
//   buy            { slug, side, tInto, shares, usdc, effPx, bzGapPct, clGapPct,
//                    posClass, orderHint, up:{...}, down:{...}, pos:{...} }
//   window_start   { slug, windowStart, openPrice, openBinance }
//   window_resolved{ slug, summary }
//   market_changed { asset, interval, windowSec, wallet }  (tracked market hot-swapped)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { fetchWindowHistory } from "../sources/history.js";
import { runSession } from "../execution/session.js";
import { ordersForTx } from "../sources/onchain.js";
import { getTrackerBuys, startEstimate, prewarmMids, estProgress } from "./historyCheck.js";
import { liveStatus, liveAddress, resolveFunder } from "../lib/executor.js";
import { getBalance } from "../sources/balance.js";
import { isRunning, setRunning, isTradeEnabled, setTradeEnabled, skippedWindow, setSkippedWindow } from "../execution/botState.js";
import { currentWindowStart } from "../util/util.js";
import { setVerbose, isVerbose } from "../logging/verbose.js";
import { handleAuth, isAuthed, warnPassword, authRequired } from "./auth.js";
import { config, ASSETS, INTERVALS, setBacktestApiVersion } from "../config/config.js";
import { patchConfigStore, getConfigStore } from "../config/configStore.js";
import { fillsCol, sessionsCol, recordOrderStatus, orderStatusOf } from "../sources/db.js";   // MongoDB record store (mode-split: reads THIS process's sim/real collections)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const ENGINE_DIR = path.join(__dirname, "..", "..", "engine");

// Monotonic id so a newer "Run backtest" supersedes an in-flight one (partials/results from the old run are ignored).
let _sessRunId = 0;
// Latest session-backtest progress (polled by the UI via /api/session-progress — backup when WS is quiet).
let _sessProgress = { phase: "idle", done: 0, total: 0, runId: 0, used: 0 };

// Bot/session start (raw) — the shadow Session card counts from here by default (this boot, not all-time).
// Floored to the window boundary AT REQUEST TIME with the CURRENT windowSec (it can change on a hot-swap).
const BOOT_MS = Date.now();
const bootFloorSec = () => Math.floor(BOOT_MS / 1000 / config.windowSec) * config.windowSec;

// The circuit breaker is hot-configurable through the strategy parameter
// endpoint. /api/market must report that effective value rather than the
// process-start environment fallback, otherwise a fresh browser can display 0
// while the running engine is actually armed at (for example) $25.
export function effectiveMaxSessionLoss(getShadowParams, fallback = 0) {
  try {
    const value = Number(getShadowParams?.()?.MAX_SESSION_LOSS);
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {}
  const value = Number(fallback);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
// PERSISTED session floor — the Session-card / live-history "since" default. Pinned to the FIRST boot and saved
// in the config store, so it survives bot restarts (history persists). The client's Reset still raises it via
// reqSince. Only wiped if the user clears runtime-config.json.
function sessionFloorSec() {
  const st = getConfigStore().sessionStartSec;
  if (typeof st === "number" && st > 0) return st;
  const v = bootFloorSec();
  patchConfigStore({ sessionStartSec: v });   // first run → pin (persists across restarts)
  return v;
}

/** Build the animated-replay dataset for a window: ticks + orders (grouped by on-chain orderHash)
 * with placement time, limit, full size, and each partial fill (time/size/px). */
async function buildReplay(slug) {
  const d = await fetchWindowHistory(slug);
  if (!d) return { error: "window not found" };
  const ws = (d.windowStart ?? Number(String(slug).split("-").pop())) || 0;
  const buys = (d.buys || []).filter((b) => b.tx);
  // decode each unique tx once (cached in onchain.js), then group fills by real orderHash
  const uniq = [...new Set(buys.map((b) => b.tx))];
  const byTx = {};
  await Promise.all(uniq.map(async (tx) => { try { byTx[tx] = await ordersForTx(tx); } catch { byTx[tx] = []; } }));
  const orders = new Map();
  for (const b of buys) {
    const arr = byTx[b.tx] || [];
    const oi = arr.find((o) => o.tokenId === String(b.asset)) || arr[0] || null;
    const key = oi ? oi.orderHash : `${b.tx}:${b.asset}`;          // fallback: treat lone fill as its own order
    const fillInto = oi && oi.filledMs ? oi.filledMs / 1000 - ws : b.tInto;
    let o = orders.get(key);
    if (!o) {
      o = { orderHash: oi ? oi.orderHash : null, side: b.side, limitPx: oi ? oi.limitPx : b.effPx,
            fullSize: oi ? oi.fullSize : b.shares,
            placedInto: oi && oi.placedMs ? oi.placedMs / 1000 - ws : b.tInto, fills: [] };
      orders.set(key, o);
    }
    o.fills.push({ into: fillInto, size: b.shares, px: b.effPx });
  }
  const ordersArr = [...orders.values()].map((o) => {
    o.fills.sort((a, b) => a.into - b.into);
    o.filledTotal = +o.fills.reduce((s, f) => s + f.size, 0).toFixed(4);
    if (o.placedInto == null || o.placedInto < 0) o.placedInto = o.fills.length ? Math.max(0, o.fills[0].into - 0.5) : 0;
    o.lastFillInto = o.fills.length ? o.fills[o.fills.length - 1].into : o.placedInto;
    return o;
  }).sort((a, b) => a.placedInto - b.placedInto);
  const ticks = (d.ticks || []).map((t) => ({ t: t.t, upAsk: t.upAsk, dnAsk: t.dnAsk }));
  return { slug, windowStart: ws, winSide: d.winSide, openBinance: d.openBinance, durationS: config.windowSec, ticks, orders: ordersArr };
}

// setMarket({asset, interval, wallet}) is provided by index.js to hot-swap the tracked market live.
// The last three args feed the SHADOW A/B: current sim fills + live strategy-param get/set.
export function startUiServer(port, getSnapshotBuys, setMarket, getShadowCurrent, setShadowParams, getShadowParams, manualOps, getLiveTicks) {
  const clients = new Set();
  let lastTick = null;
  let activeWindow = null;
  const recentBuys = []; // for snapshot replay of the live window

  const server = http.createServer((req, res) => {
    let url = req.url.split("?")[0];
    if (handleAuth(req, res, url)) return;   // login routes + auth gate — everything below requires a session
    // Current tracked market + wallet (seeds the UI selector on load).
    if (url === "/api/market") {
      (async () => {
        // Default the tracked WALLET to the bot's INTEGRATED funder (the wallet it actually trades on) in live mode, so the
        //   tracker follows the bot's own on-chain activity out of the box. Falls back to config.wallet (TRACK_WALLET).
        let wallet = config.wallet;
        if (config.executionMode === "live") { try { const f = await resolveFunder(); if (f) wallet = f; } catch {} }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ asset: config.asset, interval: config.interval, windowSec: config.windowSec, wallet, showTracker: !!config.showTracker, maxSessionLoss: effectiveMaxSessionLoss(getShadowParams, config.maxSessionLoss), executionMode: config.executionMode }));
      })().catch(() => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ asset: config.asset, interval: config.interval, windowSec: config.windowSec, wallet: config.wallet, showTracker: !!config.showTracker, maxSessionLoss: effectiveMaxSessionLoss(getShadowParams, config.maxSessionLoss), executionMode: config.executionMode })); });
      return;
    }
    // /history-check: tracked-wallet taker BUY orders (on-chain placed time) over the last N days.
    if (url === "/api/tracker-buys") {
      const q = new URL(req.url, "http://x").searchParams;
      const days = Math.min(40, Math.max(1, Number(q.get("days")) || 20));
      const refresh = q.get("refresh") === "1";
      getTrackerBuys({ days, refresh })
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(r));
          prewarmMids(r.buys); })   // fire-and-forget: warm the tick cache so the estimate is fast
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // execution mode (real-live vs simulation) — drives the UI badge + disabled controls.
    if (url === "/api/exec-mode") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ ...liveStatus(), running: isRunning(), tradeEnabled: isTradeEnabled(), verbose: isVerbose(), manualBuyMode: !!config.manualBuyMode,
        windowStart: currentWindowStart(), skipWindow: skippedWindow() === currentWindowStart() }));
      return;
    }
    // PER-WINDOW pause: stop/resume auto orders for the CURRENT window only (auto-resumes next window). ?on=1|0.
    if (url === "/api/manual/skip-window") {
      const q = new URL(req.url, "http://x").searchParams;
      if (q.get("on") != null) setSkippedWindow(/^(1|true|yes|on)$/i.test(q.get("on")) ? currentWindowStart() : null);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ skipWindow: skippedWindow() === currentWindowStart(), windowStart: currentWindowStart() }));
      return;
    }
    // LIVE-TRADE kill switch (manual panel toggle). GET/POST ?on=1|0. Disabled → auto strategy places no real orders
    //   (shadow sim + manual buys still work). Persisted so the choice survives a restart.
    if (url === "/api/manual/trade-enable") {
      const q = new URL(req.url, "http://x").searchParams;
      if (q.get("on") != null) { setTradeEnabled(/^(1|true|yes|on)$/i.test(q.get("on"))); patchConfigStore({ tradeEnabled: isTradeEnabled() }); }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ tradeEnabled: isTradeEnabled() }));
      return;
    }
    // bot run switch (Start/Stop). GET = status; POST ?on=1|0 = set.
    if (url === "/api/bot/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ running: isRunning(), ...liveStatus() }));
      return;
    }
    if (url === "/api/bot/start" || url === "/api/bot/stop") {
      setRunning(url.endsWith("/start"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: isRunning() }));
      return;
    }
    // live wallet balance (USDC.e + POL) via RPC. ?refresh=1 bypasses the short cache.
    // In LIVE mode the address is YOUR funder wallet (the Polymarket proxy holding USDC) — resolved as
    // soon as the wallet is connected/configured. In simulation it's the tracked wallet from the header.
    if (url === "/api/balance") {
      const q = new URL(req.url, "http://x").searchParams;
      (async () => {
        const funder = await resolveFunder().catch(() => null);
        const addr = funder || config.wallet;
        const b = await getBalance(addr, q.get("refresh") === "1");
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ ...b, live: !!funder }));
      })().catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // verbose order/route logging toggle. GET = status; /api/verbose/on|off = set (live, no restart).
    if (url === "/api/verbose" || url === "/api/verbose/on" || url === "/api/verbose/off") {
      if (url.endsWith("/on")) { setVerbose(true); patchConfigStore({ verbose: true }); }
      else if (url.endsWith("/off")) { setVerbose(false); patchConfigStore({ verbose: false }); }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ verbose: isVerbose() }));
      return;
    }
    // live progress of an in-flight estimate (polled by the page).
    if (url === "/api/estimate-progress") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(estProgress));
      return;
    }
    // /history-check submit: START the estimate in the BACKGROUND and return immediately. The page polls
    // /api/estimate-progress for progress + the final result — so no request is held long enough to be
    // cut by a proxy ("Failed to fetch").
    if (url === "/api/estimate-momentum") {
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
      req.on("end", () => {
        let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
        const started = startEstimate({ days: Math.min(40, Math.max(1, Number(b.days) || 20)),
          excluded: Array.isArray(b.excluded) ? b.excluded : [],
          offBeforeMs: Math.max(0, Number(b.offBeforeMs) || 0), offAfterMs: Math.max(0, Number(b.offAfterMs) || 0), minTInto: Math.max(0, Number(b.minTInto) || 0) });
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ started, busy: !started, id: estProgress.id }));
      });
      return;
    }
    // Hot-swap the tracked market + wallet (POST { asset, interval, wallet }). Validates the
    // 8 allowed combos, then index.js re-subscribes the feeds and resets tracker state.
    if (url === "/api/set-market") {
      const q = new URL(req.url, "http://x").searchParams;
      let body = q.get("asset") ? { asset: q.get("asset"), interval: q.get("interval"), wallet: q.get("wallet") } : null;
      const apply = (b) => {
        const asset = String(b.asset || "").toLowerCase();
        const interval = String(b.interval || "").toLowerCase();
        const wallet = String(b.wallet || "").toLowerCase().trim();
        if (!ASSETS.includes(asset) || !INTERVALS[interval]) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid asset/interval" })); return;
        }
        if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid wallet address" })); return;
        }
        Promise.resolve(setMarket && setMarket({ asset, interval, wallet }))
          .then(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, asset, interval, windowSec: INTERVALS[interval], wallet })); })
          .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      };
      if (body) return apply(body);
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", () => { try { apply(JSON.parse(raw || "{}")); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bad json" })); } });
      return;
    }
    // Window REPLAY dataset: window ticks + bot orders (grouped by on-chain orderHash) with placement
    // time, limit, full size, and each partial fill — for the animated replay of how orders fill.
    if (url === "/api/window-replay") {
      const slug = new URL(req.url, "http://x").searchParams.get("slug") || "";
      buildReplay(slug)
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(r)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // On-chain ORDER decode for the tracker: ?tx=h1,h2,… → { hash: {orderHash,type,fullSize,limitPx,…} }
    // Groups partial fills by real orderHash and exposes the order's GTC/GTD, size & cap. Best-effort.
    if (url === "/api/orders") {
      const txs = (new URL(req.url, "http://x").searchParams.get("tx") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 80);
      Promise.all(txs.map((tx) => ordersForTx(tx).then((o) => [tx, o]).catch(() => [tx, []])))
        .then((pairs) => { const out = {}; for (const [tx, o] of pairs) out[tx] = o;
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(out)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // Historical window API: reconstruct any past window (ticks + bot fills).
    if (url === "/api/window") {
      const slug = new URL(req.url, "http://x").searchParams.get("slug") || "";
      fetchWindowHistory(slug)
        .then((d) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(d)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    if (url === "/api/backtest-version") {   // config-menu combobox: v2 / v3
      const q = new URL(req.url, "http://x").searchParams;
      const v = q.get("v");
      // Only "select" mode lets the UI change the version; v2/v3 modes are FIXED (ignore any change attempt).
      if (v != null && config.backtestMode === "select") setBacktestApiVersion(v);
      if (config.backtestMode === "select") patchConfigStore({ backtestApiVersion: config.backtestApiVersion });   // persist only when user-selectable
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ ok: true, version: config.backtestApiVersion, mode: config.backtestMode }));
      return;
    }
    if (url === "/api/config") {   // full persisted runtime config → the dashboard reflects it on load
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(getConfigStore())); return;
    }
    if (url === "/api/ui-config") {   // dashboard's own control snapshot (opaque id→value blob) — persisted for restore on load
      const q = new URL(req.url, "http://x").searchParams;
      const raw = q.get("ui"); let ui = null; try { ui = raw ? JSON.parse(raw) : null; } catch {}
      if (ui && typeof ui === "object") {
        if (!("sigBinanceTrendLookbackSecInput" in ui)) {
          ui.sigBinanceTrendLookbackSecInput = "30";
        }
        delete ui.sigBinanceTrendLookbackInput;
        // A pre-deployment tab lacks the two countertrend controls and still
        // carries the retired 5m/0% hard-agreement values. Preserve its toggle
        // choice, but migrate the feature's parameters to poly-mom defaults.
        if (!("sigBinanceCountertrendLookbackInput" in ui)
          || !("sigBinanceCountertrendMinInput" in ui)) {
          ui.sigBinanceTrendMinInput = "0.05";
          ui.sigBinanceCountertrendLookbackInput = "60";
          ui.sigBinanceCountertrendMinInput = "0.075";
        }
        patchConfigStore({ ui });
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
    }
    // Session backtest: START in the background and return immediately (same pattern as /api/estimate-momentum).
    // Progress + mid-results (~10s) + final result arrive over WS — so long ranges (30d) never trip proxy/HTTP timeouts.
    if (url === "/api/session-progress") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(_sessProgress));
      return;
    }
    // Cancel the in-flight session backtest (supersedes via runId bump — workers stop between windows).
    if (url === "/api/session-stop") {
      const prev = _sessRunId;
      _sessRunId++;
      _sessProgress = { phase: "idle", done: 0, total: 0, runId: _sessRunId, used: 0, stopped: true };
      broadcast("session_progress", { phase: "stopped", runId: prev, done: 0, total: 0 });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ ok: true, stopped: prev }));
      return;
    }
    if (url === "/api/session") {
      const q = new URL(req.url, "http://x").searchParams;
      const start = Number(q.get("start")), end = Number(q.get("end")), bal = Number(q.get("balance"));
      if (!start || !end || end < start || !(bal > 0)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "need start≤end (unix s) and balance>0" })); return; }
      let sParams;
      const pRaw = q.get("p"); if (pRaw) { try { sParams = JSON.parse(pRaw); } catch {} }
      const total0 = Math.max(1, Math.round((end - start) / config.windowSec));
      const runId = ++_sessRunId;
      _sessProgress = { phase: "start", done: 0, total: total0, runId, used: 0 };
      broadcast("session_progress", { phase: "start", done: 0, total: total0, runId });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ started: true, runId, total: total0 }));
      const pushProg = (done, total, phase = "fetch", extra = {}) => {
        if (runId !== _sessRunId) return;
        _sessProgress = { phase, done, total, runId, used: extra.used ?? _sessProgress.used, ...extra };
        broadcast("session_progress", { phase, done, total, runId, used: _sessProgress.used, ...extra });
      };
      const heapMB = () => {
        const m = process.memoryUsage();
        return { heap: Math.round(m.heapUsed / 1e6), rss: Math.round(m.rss / 1e6), ext: Math.round(m.external / 1e6) };
      };
      const memBefore = heapMB();
      runSession(
        start, end, bal,
        (done, total, _phase, usedCnt, health) => pushProg(done, total, "fetch", {
          ...(usedCnt != null ? { used: usedCnt } : {}),
          ...(health ? { health } : {}),
        }),
        sParams,
        (partial) => { if (runId === _sessRunId) broadcast("session_partial", { ...partial, runId }); },
        () => runId !== _sessRunId,
      ).then((r) => {
        if (runId !== _sessRunId) return;   // a newer Run superseded this one
        pushProg(r.windowsRequested, r.windowsRequested, "done", { used: r.windowsUsed, health: r.health || null });
        const memPeak = heapMB();
        try { broadcast("session_result", { ...r, runId }); } catch {}
        // Free server-side result payload after WS send (clients already have their copy).
        const nWin = Array.isArray(r.windows) ? r.windows.length : 0;
        if (Array.isArray(r.windows)) {
          for (const w of r.windows) {
            if (w?.bot) { w.bot.fills = null; w.bot = null; }
            if (w?.shadow) { w.shadow.fills = null; w.shadow = null; }
          }
          r.windows.length = 0;
        }
        if (r.bot) r.bot.curve = null;
        if (r.shadow) r.shadow.curve = null;
        // Defer the heap check so V8 can reclaim; optional gc() if the process was started with --expose-gc.
        setTimeout(() => {
          try { if (typeof globalThis.gc === "function") globalThis.gc(); } catch {}
          const memAfter = heapMB();
          console.log(`[session] run #${runId} done · ${nWin} windows · mem before=${memBefore.heap}MB peak≈${memPeak.heap}MB after-free=${memAfter.heap}MB heap (rss ${memAfter.rss}MB)`);
          _sessProgress = { ..._sessProgress, mem: { before: memBefore, peak: memPeak, after: memAfter } };
        }, 750);
      }).catch((e) => {
        if (runId !== _sessRunId || e?.cancelled) return;   // superseded / cancelled → silent
        _sessProgress = { phase: "error", done: 0, total: total0, runId, error: String(e && e.message || e) };
        broadcast("session_progress", { phase: "error", runId, error: String(e && e.message || e) });
        try { broadcast("session_result", { error: String(e && e.message || e), runId }); } catch {}
        setTimeout(() => {
          try { if (typeof globalThis.gc === "function") globalThis.gc(); } catch {}
          const memAfter = heapMB();
          console.log(`[session] run #${runId} failed · mem before=${memBefore.heap}MB after=${memAfter.heap}MB heap (rss ${memAfter.rss}MB)`);
        }, 750);
      });
      return;
    }
    // ── SHADOW A/B endpoints ──
    // UI feature flag: is the live shadow running? (lets the UI show/hide the shadow panel).
    if (url === "/api/flags") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ shadow: !!config.shadow }));
      return;
    }
    // SHADOW order's partial fills: ?slug=…&oid=N → per-order fill breakdown from data/<slug>.shadow.jsonl.
    if (url === "/api/shadow-order") {
      const sp = new URL(req.url, "http://x").searchParams;
      const slug = (sp.get("slug") || "").replace(/[^a-z0-9-]/gi, "");   // sanitize (no path traversal)
      const oid = sp.get("oid");
      if (!slug || oid == null || !Number.isFinite(Number(oid))) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing/invalid slug or oid" })); return;
      }
      (async () => {
        const out = { slug, oid: Number(oid), fills: [] };
        try {
          const rows = await (await fillsCol()).find({ slug }).toArray();
          rows.sort((a, b) => (a.tInto || 0) - (b.tInto || 0));   // chronological (match old append order)
          for (const r of rows) { if (String(r.oid) === String(oid)) out.fills.push(r); }
        } catch {}
        const f = out.fills;
        const ws = Number(slug.split("-").pop()) || 0;
        out.side = f[0] ? f[0].side : null;
        out.limitPx = f[0] ? f[0].effPx : null;
        out.fullSize = f[0] ? f[0].fullSize : null;
        out.nFills = f.length;
        out.totalFilled = +f.reduce((s, x) => s + (x.shares || 0), 0).toFixed(4);
        out.status = out.fullSize != null && out.totalFilled >= out.fullSize - 1e-6 ? "FULL" : "partial";
        out.partials = f.map((x) => {
          const ts = x.ts != null ? x.ts : (ws * 1000 + (x.tInto || 0) * 1000);
          return { tInto: x.tInto, ts, time: new Date(ts).toISOString(), shares: x.shares, effPx: x.effPx, usdc: x.usdc, status: x.status };
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(out, null, 2));
      })().catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // LIVE shadow strategy params — UI pushes its config (?p=<json> sets; no param reports current).
    if (url === "/api/shadow-params") {
      const raw = new URL(req.url, "http://x").searchParams.get("p");
      if (raw && setShadowParams) {
        try {
          const p = JSON.parse(raw);
          if (!("H_BINANCE_TREND_LOOKBACK_SEC" in p)) p.H_BINANCE_TREND_LOOKBACK_SEC = 30;
          delete p.H_BINANCE_TREND_LOOKBACK_MIN;
          if (!("H_BINANCE_COUNTERTREND_LOOKBACK_SEC" in p)
            || !("H_BINANCE_COUNTERTREND_MIN_PCT" in p)) {
            p.H_BINANCE_TREND_MIN_PCT = 0.05;
            p.H_BINANCE_COUNTERTREND_LOOKBACK_SEC = 60;
            p.H_BINANCE_COUNTERTREND_MIN_PCT = 0.075;
          }
          setShadowParams(p);
          patchConfigStore({ shadowParams: getShadowParams ? getShadowParams() : p });
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(getShadowParams ? getShadowParams() : {}));
      return;
    }
    // Disable/enable the tracked-wallet activity poll at runtime (the tracker's fill feed). The shadow's
    // market/book/window feeds are unaffected. ?disabled=1 stops the poll; =0 resumes it.
    if (url === "/api/tracker") {
      const d = new URL(req.url, "http://x").searchParams.get("disabled");
      if (d != null) config.trackerDisabled = (d === "1" || d === "true");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ trackerDisabled: !!config.trackerDisabled }));
      return;
    }
    // ── MANUAL ORDER PANEL (real orders; live mode only) ──
    // Place a manual GTC BUY on the current window's Up/Down side. POST { side:"Up"|"Down", price, size }.
    if (url === "/api/manual/buy") {
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", () => {
        let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
        const side = b.side === "Down" ? "Down" : "Up";
        Promise.resolve(manualOps && manualOps.buy({ side, price: Number(b.price), sizeShares: Number(b.size) }))
          .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r || { error: "manual disabled" })); })
          .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      });
      return;
    }
    // List all resting orders (annotated with Up/Down for the current window).
    if (url === "/api/manual/orders") {
      Promise.resolve(manualOps ? manualOps.list() : { orders: [] })
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(r)); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // Cancel one resting order by id: ?id=<orderId> (or POST { id }).
    if (url === "/api/manual/cancel") {
      const q = new URL(req.url, "http://x").searchParams;
      const doCancel = (id) => Promise.resolve(manualOps && manualOps.cancel(id))
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r || { error: "manual disabled" })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      if (q.get("id")) return void doCancel(q.get("id"));
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", () => { let b = {}; try { b = JSON.parse(raw || "{}"); } catch {} doCancel(b.id); });
      return;
    }
    // Cancel ALL resting orders.
    if (url === "/api/manual/cancel-all") {
      Promise.resolve(manualOps && manualOps.cancelAll())
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r || { error: "manual disabled" })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // Cumulative LIVE PnL from the A/B ledger (data/shadow-ab.jsonl) — seeds the foot "Session" cards.
    if (url === "/api/session-live") {
      // count from this boot by default (window count starts at 0 when the bot starts); a later user
      // Reset (?since=) raises the floor further. All-time is never shown unless explicitly asked.
      const reqSince = Number(new URL(req.url, "http://x").searchParams.get("since")) || 0;
      const since = reqSince > 0 ? reqSince : sessionFloorSec();   // honor the client's persisted Reset floor (survives restarts); else the persisted session start
      (async () => {
        let bot = 0, shadow = 0, real = 0, nb = 0, ns = 0, nr = 0; const slugs = [];
        try {
          const rows = await (await sessionsCol()).find({ windowStart: { $gte: since } }).toArray();
          for (const a of rows) {
            if (a.sim && a.sim.pnl != null) { shadow += a.sim.pnl; ns++; if (a.slug) slugs.push(a.slug); }
            if (a.real && a.real.pnl != null) { real += a.real.pnl; nr++; }   // REAL on-chain PnL (honest)
            if (a.bot && a.bot.pnl != null) { bot += a.bot.pnl; nb++; }
          }
        } catch {}
        const r2 = (x) => Math.round(x * 100) / 100;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ bot: r2(bot), shadow: r2(shadow), real: r2(real), nb, ns, nr, slugs, since, botStart: sessionFloorSec() }));
      })().catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // LIVE shadow per-window HISTORY + statistics (since boot or ?since=) — for the Session-card modal.
    if (url === "/api/shadow-history") {
      const reqSince = Number(new URL(req.url, "http://x").searchParams.get("since")) || 0;
      const since = reqSince > 0 ? reqSince : sessionFloorSec();   // honor the client's persisted Reset floor (survives restarts); else the persisted session start
      (async () => {
      const windows = [];
      try {
        const rows = await (await sessionsCol()).find({ windowStart: { $gte: since } }).toArray();
        for (const a of rows) {
          if (!a.sim) continue;
          windows.push({ slug: a.slug, ws: a.windowStart, winSide: a.winSide, status: a.status || (a.winSide ? "resolved" : "pending"), ts: a.ts, sim: a.sim, real: a.real || null, bot: a.bot || null, pnlErr: a.pnlErr });
        }
      } catch {}
      // DEDUP by windowStart — a restart re-settles already-resolved windows and appends a duplicate
      // (usually EMPTY: 0 fills / $0) entry, which doubled the rows and inflated the window count + diluted
      // the mean/win-rate. Keep ONE entry per window: the most-active (max nFills; tie → larger |pnl|, then latest ts).
      const byWs = new Map();
      for (const w of windows) {
        const prev = byWs.get(w.ws);
        if (!prev) { byWs.set(w.ws, w); continue; }
        const nf = (x) => (x.sim && x.sim.nFills) || 0, ap = (x) => Math.abs((x.sim && x.sim.pnl) || 0);
        const better = nf(w) > nf(prev) || (nf(w) === nf(prev) && ap(w) > ap(prev))
          || (nf(w) === nf(prev) && ap(w) === ap(prev) && (w.ts || 0) > (prev.ts || 0));
        if (better) byWs.set(w.ws, w);
      }
      const deduped = [...byWs.values()].sort((x, y) => x.ws - y.ws);
      windows.length = 0; windows.push(...deduped);
      const r2 = (x) => Math.round(x * 100) / 100;
      const pnls = windows.map((w) => w.sim.pnl || 0);
      const n = pnls.length, total = pnls.reduce((s, v) => s + v, 0);
      const wins = pnls.filter((v) => v > 1e-9).length, losses = pnls.filter((v) => v < -1e-9).length;
      let bal = 0, peak = 0, maxDD = 0;
      for (const v of pnls) { bal += v; if (bal > peak) peak = bal; if (peak - bal > maxDD) maxDD = peak - bal; }
      const stats = { n, total: r2(total), wins, losses, breakeven: n - wins - losses,
        winRate: n ? Math.round((100 * wins) / n) : 0, mean: n ? r2(total / n) : 0,
        best: n ? r2(Math.max(...pnls)) : 0, worst: n ? r2(Math.min(...pnls)) : 0, maxDrawdown: r2(maxDD),
        fees: r2(windows.reduce((s, w) => s + (w.sim.fee || 0), 0)), nFills: windows.reduce((s, w) => s + (w.sim.nFills || 0), 0),
        botTotal: r2(windows.reduce((s, w) => s + ((w.bot && w.bot.pnl) || 0), 0)) };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ since, botStart: sessionFloorSec(), windows, stats }));
      })().catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // All shadow (sim) FILLS for one window — the per-window trade history for the history modal.
    if (url === "/api/order-status") {   // stored Order-Status lifecycle events for a window → panel reloads them after refresh
      const slug = (new URL(req.url, "http://x").searchParams.get("slug") || "").replace(/[^a-z0-9-]/gi, "");
      if (!slug) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing slug" })); return; }
      orderStatusOf(slug).then((events) => {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ slug, events }));
      }).catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    if (url === "/api/shadow-window") {
      const slug = (new URL(req.url, "http://x").searchParams.get("slug") || "").replace(/[^a-z0-9-]/gi, "");
      if (!slug) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing slug" })); return; }
      (async () => {
        let fills = [];
        try {
          fills = await (await fillsCol()).find({ slug }).toArray();
        } catch {}
        fills.sort((a, b) => (a.tInto || 0) - (b.tInto || 0));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ slug, fills }));
      })().catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
      return;
    }
    // The exact per-tick series the live simulation decided on (asks + spot), recorded by shadow.js when
    // config.recordLiveTicks is on → data/live-ticks/<slug>.json. This is the ground truth for a live-vs-v2 diff
    // (the recorded chart's lines otherwise come from /api/window = the v2 feed, not what live actually saw).
    if (url === "/api/live-ticks") {
      const slug = (new URL(req.url, "http://x").searchParams.get("slug") || "").replace(/[^a-z0-9-]/gi, "");
      if (!slug) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing slug" })); return; }
      let out = { slug, ticks: [] };
      // CURRENT (unsettled) window → in-memory series (file not written until settle); else the persisted file.
      try { const mem = getLiveTicks && getLiveTicks(slug); if (mem && mem.ticks && mem.ticks.length) out = mem; } catch {}
      if (!out.ticks.length) { try { out = JSON.parse(fs.readFileSync(path.join(config.dataDir, "live-ticks", `${slug}.json`), "utf8")); } catch { /* not recorded (yet) → empty */ } }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(out));
      return;
    }
    // Current live window's shadow (sim) fills — seeds the Shadow group on join.
    if (url === "/api/sim-current") {
      let fills = [];
      try { if (typeof getShadowCurrent === "function") fills = getShadowCurrent() || []; } catch {}
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ fills }));
      return;
    }
    // Serve the registered strategy/simulation modules used by the dashboard backview.
    if (url.startsWith("/engine/") && url.endsWith(".js")) {
      const rf = path.join(ENGINE_DIR, url.slice("/engine/".length));
      if (!rf.startsWith(ENGINE_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
      fs.readFile(rf, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
        res.end(data);
      });
      return;
    }
    if (url === "/" || url === "") url = "/index.html";
    if (url === "/history-check") url = "/history-check.html";   // momentum-calibration page
    const file = path.join(PUBLIC_DIR, url);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(err.code === "ENOENT" ? 404 : 500); res.end("Not found"); return; }
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache, must-revalidate" });
      res.end(data);
    });
  });

  // WebSocket requires a valid session too (the upgrade request carries the cookie).
  const wss = new WebSocketServer({ server, verifyClient: (info, cb) => {
    if (isAuthed(info.req)) cb(true); else cb(false, 401, "auth required");
  } });
  wss.on("connection", (ws) => {
    clients.add(ws);
    // Prefer the authoritative current-window buy history from the tracker
    // (complete + survives server restarts); fall back to the in-memory buffer.
    let buys = recentBuys;
    if (typeof getSnapshotBuys === "function") {
      try { const a = getSnapshotBuys(); if (Array.isArray(a) && a.length) buys = a; } catch {}
    }
    ws.send(JSON.stringify({ type: "snapshot", tick: lastTick, window: activeWindow, recentBuys: buys }));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  server.on("error", (e) => console.warn(`[ui] server error: ${e.message}`));
  warnPassword();
  server.listen(port, () => console.log(`[ui] dashboard http://localhost:${port} (${authRequired() ? "password-protected" : "open — simulation"})`));

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, ...payload });
    const droppable = type === "tick" || type === "shadow_ladder";
    for (const ws of clients) if (ws.readyState === 1) {
      // A backgrounded or slow browser must not make the trading process retain
      // an unbounded native WebSocket send queue. State snapshots make these
      // high-rate visual frames safely droppable; fills/status events remain
      // lossless and are still sent.
      if (droppable && ws.bufferedAmount > 256 * 1024) continue;
      ws.send(msg, () => {});
    }
  }

  return {
    tick(t) { lastTick = t; broadcast("tick", t); },
    buy(b) {
      recentBuys.push(b);
      if (recentBuys.length > 200) recentBuys.shift();
      broadcast("buy", b);
    },
    windowStart(w) {
      activeWindow = w;
      recentBuys.length = 0;
      broadcast("window_start", w);
    },
    windowResolved(w) { broadcast("window_resolved", w); },
    // SHADOW A/B channel — the reverse-engineered strategy's own fills/PnL.
    shadowBuy(b) { broadcast("shadow_buy", b); },
    shadowPlaced(o) { broadcast("shadow_placed", o); }, // an order was PLACED (distinct from filled) → "placed" toast
    shadowLadder(o) { broadcast("shadow_ladder", o); }, // live resting-ladder snapshot for the status view
    shadowPending(w) { broadcast("shadow_pending", w); },   // window CLOSED, winner not settled yet → show ⏳ pending row now
    shadowResolved(w) { broadcast("shadow_resolved", w); },
    shadowMerge(m) { broadcast("shadow_merge", m); },   // a MERGE ON PROFIT fired → update the Merged card + reset if-up/down
    shadowReal(m) { broadcast("shadow_real", m); },     // REAL on-chain fill recorded → honest live position/PnL
    orderStatus(e) { broadcast("order_status", e); try { recordOrderStatus(e); } catch {} },   // per-order lifecycle stage (sim + real) → panel + Mongo (reload after refresh)
    circuitBreaker(e) { broadcast("circuit_breaker", e); },   // session drawdown breached → bot auto-halted
    // Tell connected browsers the tracked market/wallet changed → they reset + reload the live view.
    marketChanged(m) { lastTick = null; activeWindow = null; recentBuys.length = 0; broadcast("market_changed", m); },
    stop() { try { wss.close(); server.close(); } catch {} },
    toast(p) { broadcast("toast", p); },   // server-pushed UI notification ({text, level:"error"|"warn"} → toast)
    hasClients() { return clients.size > 0; },   // lets the sampler skip building payloads when nobody's watching
  };
}
