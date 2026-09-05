import { config } from "./config/config.js";
import { STRAT } from "../engine/strategies/helpme.js";
import { initSessionLog, setLogWindow, logConfigChange, logFeedEvent, refreshEnvSnapshot, setStrategySnapshot } from "./logging/sessionLog.js";
initSessionLog(config.logDir, { config, strat: STRAT, maxMb: config.logMaxMb, instance: config.instanceName });   // per-INSTANCE per-run session dir + per-window logs + config history — do this FIRST
import { createLiveState, pruneTokens } from "./util/state.js";
import { startRtdsChainlinkFeed } from "./feeds/rtdsChainlinkWs.js";
import { startBinanceSpotFeed } from "./feeds/binanceSpotWs.js";
import { startClobMarketFeed } from "./feeds/clobMarketWs.js";
import { startClobUserFeed } from "./feeds/clobUserWs.js";
import { startActivityPoller } from "./sources/activity.js";
import { resolveMarket } from "./sources/gamma.js";
import { fetchResolution } from "./execution/resolution.js";
import { createTracker } from "./execution/tracker.js";
import { createShadow } from "./execution/shadow.js";
import * as live from "./lib/executor.js";
import { STAGES } from "./lib/orderstatus.js";
import { isRunning, setRunning, onRunChange, isTradeEnabled, setTradeEnabled, isWindowSkipped } from "./execution/botState.js";
import { verbose, verboseOn, setVerbose, setVerboseInstance } from "./logging/verbose.js";
import { render, renderHeadless } from "./server/dashboard.js";
import { startUiServer } from "./server/ui-server.js";
import { clearCache as clearOnchainCache } from "./sources/onchain.js";
import { startBinanceSpotFeed as _startBinance } from "./feeds/binanceSpotWs.js";
import { currentWindowStart, slugFor } from "./util/util.js";
import { INTERVALS, setBacktestApiVersion } from "./config/config.js";
import { loadConfigStore } from "./config/configStore.js";
import { fillsOfWindow, finalizePendingSession, orderStatusOf, pendingSessionsBefore } from "./sources/db.js";

// ── Restore the LAST-APPLIED runtime config from disk (survives restarts; no .env edit / browser needed) ──
// Applied here so the live bot boots with the operator's saved settings. Absent file → code defaults (unchanged).
const _savedCfg = loadConfigStore();
// backtestMode v2/v3 → version is FIXED (config.js already set it); "select" → restore the UI/persisted choice.
if (config.backtestMode === "select" && _savedCfg.backtestApiVersion) setBacktestApiVersion(_savedCfg.backtestApiVersion);
if (typeof _savedCfg.tradeEnabled === "boolean") setTradeEnabled(_savedCfg.tradeEnabled);   // restore the live-trade kill switch
if (_savedCfg.verbose != null) config.verboseLog = !!_savedCfg.verbose;   // picked up by setVerbose() below
console.log(`[config] restored: api=${config.backtestApiVersion}`
  + (_savedCfg.shadowParams ? " +shadow-params" : ""));
refreshEnvSnapshot(config);

const state = createLiveState();

// ---- visual dashboard (http + ws) ----
// `currentWindowBuys` (hoisted below) feeds the snapshot the AUTHORITATIVE
// current-window buy history straight from the tracker, so a browser refresh
// always shows every prior trade of the live window — even right after a
// server restart (not dependent on the ephemeral recentBuys buffer).
// `setMarket` (hoisted function below) hot-swaps the tracked market + wallet.
// Last three args feed the SHADOW A/B: current sim fills + live strategy-param get/set.
// UI mode serves the dashboard; console mode is headless (no UI server).
// Manual-order panel backend (real orders; live mode only). Functions below are hoisted declarations.
const manualOps = {
  // LIVE → real on-chain order; SIM → book a fill into the shadow ledger (chart + PnL + history). `shadow` is
  //   defined below but this arrow only runs at request time, so the closure resolves it fine.
  buy: (a) => (live.isLive() ? manualBuy(a)
    : (!config.manualBuyMode ? { error: "manual buy mode off (set MANUAL_BUY_MODE=on)" }
      : (shadow ? shadow.manualBuy({ side: a.side, shares: a.sizeShares, limit: a.price }) : { error: "shadow disabled" }))),
  list: () => manualOpenOrders(),
  cancel: (id) => live.cancelById(id),
  cancelAll: () => live.cancelAll(),
  status: () => live.liveStatus(),
};

const ui = (config.mode !== "console" && config.uiPort > 0)
  ? startUiServer(config.uiPort, () => currentWindowBuys(), (opts) => setMarket(opts),
    () => currentShadowFills(),
    (p) => { if (shadow) { const before = shadow.getParams(); shadow.setParams(p); logConfigChange("shadow-params", before, shadow.getParams()); } },
    () => (shadow ? shadow.getParams() : {}),
    manualOps,   // 7th arg: manual-order panel backend (place / list / cancel real orders)
    (slug) => currentLiveTicks(slug))   // 8th arg: in-memory live-tick series for the CURRENT (unsettled) window
  : null;

// Authoritative window-open Binance price from the Binance aggTrades REST API — the FIRST aggTrade at/after the
// window boundary (windows are minute-aligned). Same value the @aggTrade WS feed + the v3 backtest DB use, so the
// open is aggTrade-consistent end-to-end. Bounded to the opening minute (startTime..+60s) so limit=1 = the first print.
const BINANCE_SYM = { btc: "BTCUSDT", eth: "ETHUSDT", sol: "SOLUSDT", xrp: "XRPUSDT" };
// Returns { px } on success, or { retryMs, rate? } describing how long to back off before the next attempt.
//   Distinguishes RATE-LIMIT (429/418 → long backoff, respect Retry-After) from empty (aggTrade not landed yet →
//   quick retry) from transient errors (medium backoff), so a Binance REST hiccup doesn't hammer or give up early.
async function fetchBinanceOpen(windowStartSec) {
  try {
    const sym = BINANCE_SYM[config.asset] || "BTCUSDT";
    const startMs = windowStartSec * 1000;
    const url = `https://api.binance.com/api/v3/aggTrades?symbol=${sym}&startTime=${startMs}&endTime=${startMs + 60000}&limit=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.status === 429 || r.status === 418) {   // rate-limited / IP-banned → honor Retry-After (secs), else long backoff
      const ra = Number(r.headers.get("retry-after")); return { retryMs: Math.min(30000, (ra > 0 ? ra * 1000 : 10000)), rate: true };
    }
    if (!r.ok) return { retryMs: 3000 };
    const d = await r.json();
    if (Array.isArray(d) && d[0] && d[0].p != null) return { px: +d[0].p };   // first aggTrade's price = window open
    return { retryMs: 1200 };   // empty — the first aggTrade hasn't been indexed yet (first ~250ms); retry soon
  } catch { return { retryMs: 3000 }; }   // network / timeout
}

// WINDOW OPEN (Binance) = aggTrades REST as the AUTHORITATIVE source (same value the v3 DB stores, queryable ~250ms
//   after the boundary). The open is IMMUTABLE + recoverable at ANY point, so on failure we KEEP RETRYING (backoff,
//   never giving up) for the WHOLE window. WS-OPEN FALLBACK: if the REST open still hasn't landed by
//   BINANCE_OPEN_FALLBACK_S, seed a PROVISIONAL open for dashboard/reference analytics. The active strategy uses
//   Binance gap velocity, not distance from this open. The open cancels when
//   two gap levels are subtracted. REST keeps trying and replaces the provisional when it lands.
function ensureBinanceOpen(w) {
  if (!w || w.openInFlight) return;
  if (w.openBinance != null && !w.openBinanceProvisional) return;   // AUTHORITATIVE REST open already set → nothing to do
  const bzNow = state.binance[config.asset]?.value;
  if (w.firstBz == null && bzNow > 0) w.firstBz = bzNow;            // earliest observed WS price (≈ the true open) for the fallback
  const now = Date.now();
  const tInto = now / 1000 - w.windowStart;
  // WS-OPEN FALLBACK — REST hasn't landed in time → seed a provisional dashboard/reference open. Uses firstBz
  // (earliest WS price ≈ open), not the current price. REST still replaces it with the authoritative value.
  if (w.openBinance == null && tInto >= (config.binanceOpenFallbackS || 10) && w.firstBz > 0) {
    w.openBinance = w.firstBz; w.openBinanceProvisional = true;
    console.warn(`[binance] window-open REST not landed by t+${Math.round(tInto)}s — seeded PROVISIONAL open ${w.firstBz} from WS — ${w.slug}`);
    try { logFeedEvent("binance-open", "stale", `provisional WS open ${w.slug}`, { tInto: Math.round(tInto), provisional: w.firstBz }); } catch {}
  }
  if (w.openNextTs && now < w.openNextTs) return;                  // REST backoff window not elapsed yet
  if (!w.openWarned && (w.openTries || 0) >= 5 && tInto > 15) {    // persistently failing → surface once, keep retrying
    w.openWarned = true;
    console.warn(`[binance] window-open REST still fetching after ${w.openTries} tries (${Math.round(tInto)}s) — ${w.slug}${w.openBinanceProvisional ? " (running on provisional WS open)" : ""}`);
    try { logFeedEvent("binance-open", "stale", `open fetch retrying ${w.slug}`, { tries: w.openTries }); } catch {}
  }
  w.openTries = (w.openTries || 0) + 1;
  w.openInFlight = true;
  fetchBinanceOpen(w.windowStart)
    .then((res) => {
      if (res && res.px != null) {
        if (w.openBinance == null || w.openBinanceProvisional) {   // SET, or REPLACE the provisional with the authoritative open
          const wasProv = w.openBinanceProvisional;
          w.openBinance = res.px; w.openBinanceProvisional = false;
          if (wasProv || w.openTries > 3) { console.log(`[binance] window-open ${wasProv ? "replaced provisional with REST" : "recovered after " + w.openTries + " tries —"} ${res.px} — ${w.slug}`);
            try { logFeedEvent("binance-open", "live", `open ${wasProv ? "replaced-provisional" : "recovered"} ${w.slug}`, { tries: w.openTries }); } catch {} }
        }
      } else {   // schedule the next attempt with backoff (longer on rate-limit; capped so we keep trying all window)
        const backoff = (res && res.retryMs) || 3000;
        w.openNextTs = Date.now() + (res && res.rate ? backoff : Math.min(8000, backoff * (1 + Math.floor(w.openTries / 5))));
      }
    })
    .catch(() => { w.openNextTs = Date.now() + 3000; })
    .finally(() => { w.openInFlight = false; });
}

/**
 * Window meta provider for the tracker: gamma (token ids) + backtest API
 * (open/final/winSide). Called once per slug, then refreshed for settlement.
 */
async function resolveWindow(slug) {
  const [m, r] = await Promise.all([resolveMarket(slug), fetchResolution(slug)]);
  if (!m && !r.openPrice) return null;
  return {
    upTokenId: m?.upTokenId ?? null,
    downTokenId: m?.downTokenId ?? null,
    conditionId: m?.conditionId ?? null,
    openPrice: r.openPrice,
    openBinance: r.openBinance,
    winSide: r.winSide,
  };
}

// Build the UI buy payload from a tracker event record. `mtm` is an optional
// live mark (only known at fire time); historical replays pass null.
function recToBuy(slug, r, mtm = null) {
  return {
    slug, side: r.side, tInto: r.tInto, shares: r.size, usdc: r.usdc, effPx: r.effPx,
    bz: r.binance ?? null, cl: r.chainlink ?? null,   // absolute spot price at fill (coin price)
    bzGap: r.binanceDopen, bzGapPct: r.binanceDopenPct, clGap: r.chainlinkDopen, clGapPct: r.chainlinkDopenPct,
    spread: r.spread, spreadPct: r.spreadPct, posClass: r.posClass, orderHint: r.orderHint,
    depth: r.depth, // ask/bid ladder the order faced (live-captured only)
    tx: r.tx, // on-chain settlement tx hash → verifiable OrderFilled event on Polygonscan
    pos: { upShares: r.upShares, downShares: r.downShares, totalCost: r.totalCost,
           upCost: r.upCost, downCost: r.downCost, posBefore: r.posBefore,
           ifUpWins: r.upShares - r.totalCost, ifDownWins: r.downShares - r.totalCost, mtm },
  };
}

// Every BUY of the CURRENT live window, chronological — used to seed a freshly
// connected/refreshed browser with the window's prior trades.
function currentWindowBuys() {
  const cur = currentWindowStart();
  const w = [...tracker.windows.values()].find((x) => x.windowStart === cur);
  if (!w) return [];
  return w.events.filter((e) => e.type === "TRADE" && e.action === "BUY").map((r) => recToBuy(w.slug, r));
}

// Current live window's SHADOW (sim) fills — seeds the /sim page on join.
function currentShadowFills() {
  if (!shadow) return [];
  const cur = currentWindowStart();
  const w = [...shadow.windows.values()].find((x) => x.windowStart === cur);
  return w ? w.fills.slice() : [];
}

// In-memory live-tick series for a window still in progress (the recorded file is only written at settle).
// Lets the chart seed the current live window from the exact CLOB BBA and spot values the simulation saw instead
// of /api/window (the v2 feed) — so live marks/lines match what the engine actually saw. Null → fall to file.
function currentLiveTicks(slug) {
  if (!shadow || !slug) return null;
  const w = shadow.windows.get(slug);
  if (!w || !w.recTicks || !w.recTicks.length) return null;
  return { slug, ws: w.windowStart, winSide: w.winSide || null, cfg: w.cfgAtOpen || null,
           openBz: w.openBinance,
           openCl: w.openChainlink ?? null, ticks: w.recTicks };
}

const fmt = (v) => (v == null ? "—" : Number(v).toFixed(2));

setVerboseInstance(config.instanceName);   // tag every verbose line with this process's instance name
setVerbose(config.verboseLog);   // boot default for the verbose order/route logger (UI toggle flips it live)
if (config.verboseLog) console.log("[v] verbose logging ON (order submission + live routing detail)");
if (live.isLive()) console.log(`[live] ⚠ EXECUTION_MODE=live — strategy PRIMARY entries will place REAL orders (cap $${config.liveMaxOrderUsd}/order). configured=${live.liveStatus().configured}`);
// resolve a tracked window's outcome token for a side (Up/Down) — for routing live orders
function tokenForSlugSide(slug, side) {
  for (const w of tracker.windows.values()) if (w.slug === slug) return side === "Up" ? w.upTokenId : w.downTokenId;
  return null;
}
// SHADOW A/B: the reverse-engineered strategy running live alongside the bot on the same feeds.
// (Forced ON in live mode — it's what DECIDES the entries that become real orders.)
// Place ONE real live buy WITH the stale-book guard. Returns the placeBuy promise (resolves to
// {orderId,filled,...} or {error}), or null if it was guarded out (not live / stopped / no token / stale).
// `leg` is retained in telemetry for entry, partial-hedge, and reversal buys.
function liveBuyGuarded({ slug, side, price, sizeShares, amountUsd, expireS, leg, postOnly, orderType, liveOrderType }) {
  const tag = String(slug).split("-").pop();
  if (!live.isLive()) { if (verboseOn) verbose("route.skip", { leg, reason: "executionMode != live (simulation only)" }); return null; }
  if (!isRunning()) { if (verboseOn) verbose("route.skip", { leg, reason: "bot is STOPPED (Start the bot)" }); return null; }
  if (!isTradeEnabled()) { if (verboseOn) verbose("route.skip", { leg, reason: "live auto-trading DISABLED (manual panel toggle)" }); return null; }
  if (isWindowSkipped(Number(String(slug).split("-").pop()))) { if (verboseOn) verbose("route.skip", { leg, reason: "this window PAUSED (manual panel)" }); return null; }
  const tokenId = tokenForSlugSide(slug, side);
  const bk = tokenId ? state.bbaByToken.get(tokenId) : null;        // STALE-DATA GUARD: book must be fresh
  const ageMs = bk ? Date.now() - bk.recvTs : Infinity;
  if (!tokenId) {
    if (verboseOn) verbose("route.skip", { leg, reason: "no tokenId for this slug/side (window not registered?)", slug, side });
    console.warn(`[live] SKIP ${leg} ${side} — no token id for ${slug}`); return null;
  }
  if (ageMs > config.tradeFreshMs) {
    if (verboseOn) verbose("route.skip", { leg, reason: "book stale", side, bookAgeMs: bk ? Math.round(ageMs) : null, freshMs: config.tradeFreshMs, hasBook: !!bk, bestAsk: bk?.bestAsk ?? null });
    console.warn(`[live] SKIP ${leg} ${side} — book stale (${bk ? Math.round(ageMs / 1000) + "s old" : "no book"}); not buying on stale data`); return null;
  }
  const selectedLiveOrderType = !postOnly
    ? (String(liveOrderType || "").toUpperCase() === "FAK" ? "FAK"
      : String(liveOrderType || "").toUpperCase() === "GTC" ? "GTC"
        : String(orderType || "").toUpperCase() === "FAK" ? config.liveTakerOrderType : orderType)
    : orderType;
  if (verboseOn) verbose("route.place", { leg, slug: tag, side, tokenId, price, sizeShares: +sizeShares.toFixed(4), expireS: expireS ?? null,
    orderType: selectedLiveOrderType || "GTC", strategyOrderType: orderType || null,
    bestAsk: bk?.bestAsk ?? null, bookAgeMs: Math.round(ageMs) });
  return live.placeBuy({ tokenId, price, sizeShares, amountUsd, expireS, postOnly, orderType: selectedLiveOrderType, fillPx: bk?.bestAsk,
    cancelRemainderAfterMs: selectedLiveOrderType === "GTC" ? config.liveGtcCancelRemainderMs : undefined,
    label: `${tag} ${side} ${String(leg || "entry").toUpperCase()}${postOnly ? " ◌REST" : ""}` })
    .then((r) => { if (r?.error) { console.error(`[live] ${leg} NOT placed:`, r.error); notifyOrderError(r.error); } return r; });
}

// Surface an order-placement error to the dashboard as a toast. Insufficient-balance rejections get the clear
//   "Insufficient balance" message (live mode only); other errors pass through so failures are never silent.
function notifyOrderError(err) {
  if (!ui) return;
  const s = String(err || "");
  const insuff = /insufficient|not enough|balance|collateral|allowance/i.test(s);
  try { ui.toast({ text: insuff ? "Insufficient balance" : ("Order rejected: " + s.slice(0, 80)), level: "error" }); } catch {}
}


// ---- manual-order panel backend ----------------------------------------------------------------
// Resolve the CURRENT live window (slug + up/down token ids) for manual actions.
function currentLiveWindow() {
  const cur = currentWindowStart();
  let w = (_liveW && _liveW.windowStart === cur) ? _liveW : null;
  if (!w) for (const x of tracker.windows.values()) if (x.windowStart === cur) { w = x; break; }
  return w || null;
}

// Operator GTC buy from the panel — a REAL order on the current window's chosen side. Independent of the
// strategy/run state (it's a manual action); still requires live mode + a resolved token. Price is a
// CEILING (fills at the live ask ≤ price; rests otherwise). Default 0.99 = marketable. Cap still applies.
async function manualBuy({ side, price, sizeShares }) {
  if (!live.isLive()) return { error: "not live (EXECUTION_MODE=live required)" };
  const w = currentLiveWindow();
  if (!w) return { error: "no live window resolved yet — wait for the next window" };
  const tokenId = side === "Up" ? w.upTokenId : w.downTokenId;
  if (!tokenId) return { error: `no ${side} token for the current window` };
  const px = Math.max(0.01, Math.min(0.99, Math.round((+price || 0.99) * 100) / 100));
  const size = +sizeShares || 0;
  if (!(size > 0)) return { error: "size must be > 0" };
  const tag = String(w.slug).split("-").pop();
  if (verboseOn) verbose("manual.buy", { slug: tag, side, tokenId, price: px, sizeShares: size });
  console.log(`[live] ✋MANUAL BUY ${side} ${size}sh @ ${px} (${tag})`);
  const r = await live.placeBuy({ tokenId, price: px, sizeShares: size, expireS: 0, fillPx: state.bbaByToken.get(tokenId)?.bestAsk, label: `${tag} ${side} ✋MANUAL` });
  if (r?.error) { notifyOrderError(r.error); return { ...r, slug: w.slug, side, tokenId }; }
  // Record the REAL fill into the real ledger so the manual position remains visible.
  if (shadow && r.filled > 0) {
    shadow.recordRealFill(w.slug, w.windowStart, { side, shares: r.filled, spent: r.spent, price: r.avgPx, leg: "entry", oid: null, latencyMs: null });
    const tInto = Math.max(0, Math.floor(Date.now() / 1000) - w.windowStart);   // draw the fill circle on the chart
    shadow.emitManualFill(w.slug, { tInto, decidedT: tInto, placedT: tInto, side, shares: +(+r.filled).toFixed(2), effPx: r.avgPx, usdc: r.spent,
      exec: "marketable", kind: "taker", leg: "entry", reason: "manual", manual: true, status: "full", oid: Date.now(), ts: Date.now(), limitPx: px });
  }
  return { ...r, slug: w.slug, side, tokenId };
}

// List ALL resting orders (so nothing is orphaned), annotating each with Up/Down if it matches the
// current window's tokens. Includes the funder for the panel header.
async function manualOpenOrders() {
  const w = currentLiveWindow();
  const orders = await live.getOpenOrders();
  const up = w ? String(w.upTokenId) : null, dn = w ? String(w.downTokenId) : null;
  const rows = orders.map((o) => ({ ...o, sideLabel: o.tokenId === up ? "Up" : (o.tokenId === dn ? "Down" : null) }));
  return { funder: live.liveAddress(), slug: w?.slug ?? null, orders: rows };
}

const shadow = (config.shadow || live.isLive()) ? createShadow((e) => {
  // LIVE EXECUTION: route every strategy entry to a REAL CLOB order at the decision instant
  // (the `shadow_order` event), NOT the shadow's display fill. This DECOUPLES order routing from the shadow's
  // (optionally latency-deferred) display/PnL, so real orders always go out immediately even when LATENCY_MS>0.
  // Marketable FAK at price=LIMIT (ceiling): consume visible asks ≤ LIMIT and cancel any remainder. Guarded by isLive()+
  // isRunning()+fresh-book. The real fill (below) feeds the honest real ledger.
  if (e.kind === "shadow_order" && live.isLive() && isRunning()) {
    const rec = e.rec;
    if (rec && rec.shares > 0) {
      const params = shadow.getParams();
      // ORDER STATUS (real leg) → the Order Status panel. Keyed by window:oid so it lines up with the SIM stages.
      const osKey = `${e.windowStart}:${rec.oid}`;
      const emitOS = (stage, extra) => { try { ui?.orderStatus?.({ kind: "order_status", stage, key: osKey, slug: e.slug,
        ws: e.windowStart, oid: rec.oid, side: rec.side, leg: rec.leg, reason: rec.reason,
        tInto: rec.tInto, reqShares: rec.shares, mode: "live", ts: Date.now(), ...(extra || {}) }); } catch {} };
      // FastMX executable legs are marketable BUYs; inventory-control legs use
      // exact-share GTC while ordinary entries may use the selected transport.
      let p, placedPx = null;
      {
      // Use the exact cap computed by Helpme, with the strategy ceiling as a defensive fallback.
      const price = rec.limitPx != null ? rec.limitPx : (params.LIMIT ?? 0.98);
      if (verboseOn) verbose("route.fill", { slug: String(e.slug).split("-").pop(), side: rec.side, leg: rec.leg, reason: rec.reason,
        shares: rec.shares, shadowPx: rec.effPx, ceiling: price, tInto: Math.round(rec.tInto ?? 0) });
      placedPx = price;
      p = liveBuyGuarded({ slug: e.slug, side: rec.side, price, sizeShares: rec.shares, amountUsd: rec.budgetUsd, expireS: 0,
        leg: rec.leg || "entry", postOnly: !!rec.postOnly, orderType: rec.orderType || "FAK",
        liveOrderType: rec.liveOrderType });
      }
      // PLACED → the real order left the bot (or was guard-skipped before submit).
      if (p) emitOS(STAGES.PLACED, { ceiling: placedPx, decPx: rec.effPx });
      else { emitOS(STAGES.SKIPPED, { note: "guarded (stale book / trade disabled / paused)" });
             try { shadow.cancelLivePending?.(e.slug, rec.oid); } catch {} }   // order never went out → release the pending guard (retry)
      // HONEST PnL: feed the REAL fill (shares + USDC) back into the shadow's real ledger. placeBuy returns {filled, spent}.
      if (p && shadow) p.then((r) => {
        if (!r || r.error) { emitOS(STAGES.REJECTED, { error: (r && r.error) || "no response" }); try { shadow.cancelLivePending?.(e.slug, rec.oid); } catch {} return; }
        const shares = r.filled, cash = r.spent;
        // REAL latency (ms): decision (rec.ts, stamped in shadow.js at the strategy step) → order MATCHED (now).
        const latencyMs = (rec.ts != null) ? (Date.now() - rec.ts) : null;
        // Register this real order id so user-channel WS pushes (status/price/shares) attribute to THIS panel row.
        if (r.orderId) registerOsOrder(r.orderId, { emitOS, slug: e.slug, oid: rec.oid, reqShares: rec.shares });
        if (shares > 0) {
          shadow.recordRealFill(e.slug, e.windowStart, { side: rec.side, shares, spent: cash, price: r.avgPx, leg: rec.leg, oid: rec.oid, latencyMs, tInto: rec.tInto });
          if (verboseOn) verbose("route.realfill", { slug: String(e.slug).split("-").pop(), side: rec.side, shares, cash, avgPx: r.avgPx, shadowPx: rec.effPx });
          emitOS(STAGES.REAL_FILLED, { orderId: r.orderId || null, realShares: shares, realSpent: cash, realAvgPx: r.avgPx ?? null,
            realStatus: r.status || null, realLatencyMs: latencyMs, full: shares >= rec.shares - 1e-6 });
        } else if (r.orderId) {
          // accepted by the CLOB but NOTHING filled synchronously → the limit order is SUBMITTED, resting on the book
          //   (maker / delta-below-ask). The reconcile poll below then tracks LIVE → matched as it fills.
          emitOS(STAGES.SUBMITTED, { orderId: r.orderId, realStatus: r.status || "live", realLatencyMs: latencyMs });
        }
        // POST-FIRE TRACKING: poll the accepted order to verify any delta not present in the POST response and surface
        //   STATUS transitions — order
        //   (live→partially_matched→matched→canceled/expired) + on-chain trade (MATCHED→MINED→CONFIRMED) — to the
        //   Order Status panel, each timestamped. Runs for every real order so the on-chain confirm is tracked too.
        if (r.orderId) {
          live.reconcileOrder(r.orderId, { seedShares: shares, seedSpent: cash, restTimeoutMs: config.liveRestTimeoutMs,
            onDelta: ({ shares: ds, spent: dc, avgPx: dpx, matched }) => {
              if (!(ds > 1e-6)) return;
              shadow.recordRealFill(e.slug, e.windowStart, { side: rec.side, shares: ds, spent: dc, price: dpx, leg: rec.leg, oid: rec.oid, latencyMs: null, tInto: rec.tInto });
              if (verboseOn) verbose("route.reconcile", { slug: String(e.slug).split("-").pop(), side: rec.side, deltaShares: +ds.toFixed(4), deltaCash: +dc.toFixed(4), avgPx: dpx });
              emitOS(STAGES.RECONCILED, { deltaShares: ds, deltaSpent: dc, realAvgPx: dpx ?? null, matched });
            },
            onStatus: ({ phase, status, ts, matched, orig }) => {
              // DISPLAY: the user-channel WS is the single status source while it's live (earlier + carries price/shares).
              //   The poll emits status only as a FALLBACK when the WS is stale/down — no duplicate rows otherwise.
              if (!(clobUser && clobUser.isFresh && clobUser.isFresh())) emitOS(STAGES.STATUS, { phase, statusRaw: status, matched, orig, ts, src: "poll" });
              if (phase !== "order") return;
              // STALE ABANDON: reconcileOrder already CANCELED the resting remainder (past LIVE_REST_TIMEOUT_S). Free the
              //   pending transport state so a later distinct signal can proceed normally.
              if (status === "CANCELED_STALE") {
                if (verboseOn) verbose("route.stale_cancel", { slug: String(e.slug).split("-").pop(), oid: rec.oid, orderId: r.orderId, matched: matched || 0 });
                emitOS(STAGES.CANCELED_STALE, { orderId: r.orderId, matched: matched || 0 });
                try { shadow.cancelLivePending?.(e.slug, rec.oid); } catch {}
                return;
              }
              // cancel LOST the race (order matched in-flight) → DON'T free the guard; the real fill clears it. Display only.
              if (status === "CANCEL_RACED") { emitOS(STAGES.CANCEL_RACED, { orderId: r.orderId }); return; }
              // venue-terminal (already canceled/expired/unmatched, or the old poll-deadline UNFILLED_TIMEOUT with zero fill)
              //   → just free the guard so the strategy retries.
              if (status === "CANCELED" || status === "CANCELLED" || status === "EXPIRED" || status === "UNMATCHED" || status === "UNFILLED_TIMEOUT") {
                try { shadow.cancelLivePending?.(e.slug, rec.oid); } catch {}
              }
            } }).catch(() => {});
        }
      }).catch((err) => { emitOS(STAGES.REJECTED, { error: String(err && err.message || err) }); try { shadow.cancelLivePending?.(e.slug, rec.oid); } catch {} });
    }
  }
  if (!ui) return;
  if (e.kind === "shadow_buy") ui.shadowBuy(e);
  else if (e.kind === "shadow_placed") ui.shadowPlaced(e);
  else if (e.kind === "shadow_ladder") ui.shadowLadder(e);
  else if (e.kind === "shadow_pending") ui.shadowPending?.(e);
  else if (e.kind === "shadow_resolved") ui.shadowResolved(e);
  else if (e.kind === "shadow_merge") ui.shadowMerge(e);
  else if (e.kind === "shadow_real") ui.shadowReal(e);
  else if (e.kind === "order_status") ui.orderStatus?.(e);   // sim leg stages (decided / sim_filled) → Order Status panel
}, () => !!(ui && ui.hasClients && ui.hasClients())) : null;   // uiActive → shadow skips the UI-only ladder payload when no browser is watching
// Restore the last-applied Helpme strategy parameters from the config store.
if (shadow && _savedCfg.shadowParams && typeof _savedCfg.shadowParams === "object") shadow.setParams(_savedCfg.shadowParams);
// General strategy-param override for unattended runs (pm2): a JSON blob of
// current Helpme STRAT keys. Unknown/obsolete keys are discarded.
//   SHADOW_PARAMS_JSON='{"H_CLOB_MID_VELOCITY_ON":true,"H_MID_VELOCITY_LOOKBACK_MS":3000,"H_MID_VELOCITY_MIN":0.02,"H_BINANCE_GAP_MOMENTUM_ON":true,"H_BINANCE_GAP_VELOCITY_LOOKBACK_MS":3000,"H_BINANCE_GAP_VELOCITY_MIN":5,"H_BINANCE_TREND_ON":true,"H_BINANCE_TREND_LOOKBACK_SEC":30,"H_BINANCE_TREND_MIN_PCT":0.05,"H_BINANCE_COUNTERTREND_LOOKBACK_SEC":60,"H_BINANCE_COUNTERTREND_MIN_PCT":0.075,"H_BINANCE_GAP_AGREE_ON":false,"LATENCY_MS":520}'
if (shadow && process.env.SHADOW_PARAMS_JSON) {
  try {
    const p = JSON.parse(process.env.SHADOW_PARAMS_JSON);
    shadow.setParams(p);
    console.log(`[boot] SHADOW_PARAMS_JSON applied → ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  } catch (e) { console.error("[boot] bad SHADOW_PARAMS_JSON:", e.message); }
}
// initSessionLog runs before persisted/runtime overrides are available. Replace its
// code-default snapshot with the strategy that will actually drive this process.
if (shadow) setStrategySnapshot(shadow.getParams());

const tracker = createTracker(state, resolveWindow, (e) => {
  if (e.kind === "window_resolved") {
    // settle the shadow window against the bot's summary → append the A/B ledger row
    const ab = shadow?.settle(e.slug, e.summary.winSide, e.summary);
    if (ab && ab.bot) console.log(`[shadow A/B] ${String(e.slug).split("-").pop()} win=${ab.winSide} bot=$${fmt(ab.bot.pnl)} sim=$${fmt(ab.sim.pnl)} netMatch=${ab.netMatch} |Δ|=$${fmt(ab.pnlErr)}`);
  }
  if (!ui) return;
  if (e.kind === "bot_event" && e.rec.type === "TRADE" && e.rec.action === "BUY") {
    ui.buy(recToBuy(e.slug, e.rec, e.pnl.mtm));
  } else if (e.kind === "window_resolved") {
    ui.windowResolved({ slug: e.slug, summary: e.summary });
  }
});

// CLOB feed subscribes to the union of token ids across tracked windows.
function currentTokenIds() {
  const ids = [];
  for (const w of tracker.windows.values()) {
    if (w.upTokenId) ids.push(w.upTokenId);
    if (w.downTokenId) ids.push(w.downTokenId);
  }
  return ids;
}
// condition ids for the user-channel WS (it subscribes by market = conditionId, not token)
function currentConditionIds() {
  const ids = [];
  for (const w of tracker.windows.values()) if (w.conditionId) ids.push(w.conditionId);
  return ids;
}
// realOrderId → Order Status context, so a pushed WS order/trade event can be attributed to the right panel row.
//   Populated when a real order returns an id; pruned with a bounded LRU so it can't grow unbounded.
const osByOrderId = new Map();
// A CLOB WS push can arrive BEFORE the POST response returns and registers the order id (race). Buffer those events
//   as apply-fns keyed by orderId; flush them the moment the id registers, so no early status is dropped (display-only).
const osWsPending = new Map();
function bufferWsEvent(orderId, applyFn) {
  const k = String(orderId); let arr = osWsPending.get(k);
  if (!arr) { arr = []; osWsPending.set(k, arr); if (osWsPending.size > 200) { const old = osWsPending.keys().next().value; osWsPending.delete(old); } }
  if (arr.length < 30) arr.push(applyFn);
}
function registerOsOrder(orderId, ctx) {
  if (!orderId) return;
  const k = String(orderId);
  osByOrderId.set(k, ctx);
  if (osByOrderId.size > 400) { const kk = osByOrderId.keys().next().value; osByOrderId.delete(kk); }   // LRU cap
  const pend = osWsPending.get(k);   // flush any WS events that raced ahead of registration
  if (pend) { osWsPending.delete(k); for (const fn of pend) { try { fn(ctx); } catch {} } }
}

// ---- ENGINE: feeds + intervals, started/stopped as a unit by the Start/Stop switch ----
let stopChainlink = null, stopBinance = null, clob = null, clobUser = null, stopActivity = null;
let lastCondSig = "";
let lifecycleTimer = null, samplerTimer = null, engineOn = false;
let _liveW = null, _liveWStart = -1;   // cached live window for the per-book-update callback
// LIVE shadow is EVENT-DRIVEN off the CLOB feed: momentum, placement AND fill are re-evaluated on
// EVERY best_bid/ask update for the current window's Up/Down token (the backtest stays on recorded
// snapshot ticks). Node is single-threaded, so this never races the UI sampler. dt-normalized fills
// make this strictly more accurate than sampling (no missed intra-sample ask crossings).
function driveShadowForWindow(w, nowMs) {
  if (!shadow || !w) return;
  const a = config.asset;
  const bzSlot = state.binance[a];
  const bz = bzSlot?.value ?? null;
  const cl = state.chainlink[a]?.value ?? null;   // Polymarket RTDS Chainlink TWAP-60
  const tInto = nowMs / 1000 - w.windowStart;   // ms-precision (distinct mid timestamps per book update)
  if (tInto >= 0) {
    ensureBinanceOpen(w);   // Binance open: aggTrades REST (authoritative) + WS provisional fallback after BINANCE_OPEN_FALLBACK_S
    if (tInto <= 6 && w.openPrice == null && cl != null) { w.openPrice = cl; w.openProvisional = true; }   // RTDS boundary seed; delayed poly API replaces it
  }
  const upA = w.upTokenId ? state.bbaByToken.get(w.upTokenId) : null;
  const dnA = w.downTokenId ? state.bbaByToken.get(w.downTokenId) : null;
  const upDepth = w.upTokenId ? state.depthByToken.get(w.upTokenId) : null;
  const dnDepth = w.downTokenId ? state.depthByToken.get(w.downTokenId) : null;
  const upAsk = upA ? upA.bestAsk : null;
  const dnAsk = dnA ? dnA.bestAsk : null;
  shadow.tick({
    slug: w.slug, windowStart: w.windowStart, openBinance: w.openBinance,
    openChainlink: w.openPrice, tInto,
    bzPrice: bz, binanceAtMs: bzSlot?.recvTs ?? null, clPrice: cl, nowMs,
    up: upA ? { bestBid: upA.bestBid, bestAsk: upAsk, asks: upDepth?.asks || null, bids: upDepth?.bids || null, depthTs: upDepth?.ts || null } : null,
    down: dnA ? { bestBid: dnA.bestBid, bestAsk: dnAsk, asks: dnDepth?.asks || null, bids: dnDepth?.bids || null, depthTs: dnDepth?.ts || null } : null,
  });
}
// Resolve + cache the live window for "now" (handles rollover + token prewarm). Shared by the book-update
// handler.
function ensureLiveWindow() {
  const curStart = currentWindowStart();
  if (_liveWStart !== curStart || !_liveW || _liveW.windowStart !== curStart) {   // rollover → re-resolve once
    const prev = _liveW;   // the window that just closed (if any)
    _liveW = null; for (const x of tracker.windows.values()) if (x.windowStart === curStart) { _liveW = x; break; }
    _liveWStart = curStart;
    if (_liveW) live.prewarm([_liveW.upTokenId, _liveW.downTokenId], _liveW.conditionId);   // warm complete signing metadata + socket
    // record the JUST-CLOSED window as pending IMMEDIATELY (next tick after close) — don't wait for the 5s lifecycle
    if (prev && shadow && prev.windowStart < curStart && !prev.settled) shadow.recordPending(prev.slug);
  }
  return _liveW;
}
// per CLOB book update: drive the live window's shadow strategy on the NATIVE feed cadence (per-tick).
function onBook(assetId) {
  const w = ensureLiveWindow();
  if (!w || (assetId !== w.upTokenId && assetId !== w.downTokenId)) return;   // only the live window's tokens
  driveShadowForWindow(w, Date.now());
}

// ---- live market/wallet switch (POST /api/set-market → ui-server → here) ----
// Hot-swap the tracked market + wallet without restarting the process: mutate config,
// restart the Binance feed for the new asset, reset tracker state + on-chain cache, and
// let the lifecycle/CLOB re-arm the new market's windows on the next tick.
async function setMarket({ asset, interval, wallet }) {
  config.asset = asset;
  config.interval = interval;
  config.windowSec = INTERVALS[interval] ?? 300;
  // WALLET: apply a passed-in address (validated 0x…40hex) so the optional
  // tracker can re-point live. An empty value explicitly disables tracking.
  // The window/wallet-scoped reset below flushes the previous wallet's fills.
  const _w = String(wallet || "").toLowerCase().trim();
  if (wallet != null && (_w === "" || /^0x[0-9a-f]{40}$/.test(_w))) config.wallet = _w;
  // restart Binance spot feed on the new asset (chainlink is all-assets; CLOB re-subs per window)
  if (engineOn) { try { stopBinance?.(); } catch {} stopBinance = _startBinance(state, [config.asset]); }
  // reset everything window/wallet-scoped so stale data from the old market can't bleed through
  tracker.windows.clear();
  stopActivity?.reset?.();
  clearOnchainCache();
  lastTokenSig = "";
  // CRITICAL: drop the cached live window + decimation buffers. Without this, a SAME-interval hot-swap (asset- or
  //   wallet-only — e.g. the editable wallet field) leaves _liveWStart == curStart, so ensureLiveWindow never
  //   re-resolves → the engine keeps driving/ordering against the stale previous-market window until the next
  //   rollover (wrong-market signals and manual orders routed to the old asset's token ids). stopEngine resets
  //   these; a hot-swap must too.
  _liveW = null; _liveWStart = -1;
  console.log(`[switch] now tracking ${config.wallet} on ${config.asset} ${config.interval}`);
  if (engineOn) await lifecycle();
  ui?.marketChanged({ asset: config.asset, interval: config.interval, windowSec: config.windowSec, wallet: config.wallet });
}

// ---- window lifecycle: register current + next, refresh settlement, prune ----
let lastTokenSig = "";
let pendingRecoveryBusy = false;
let pendingRecoveryAfterMs = 0;

// A process can restart after a market closes but before Polymarket publishes
// the winner. Its position is already durable in MongoDB; finish those rows
// from the official resolution feed so history cannot remain pending forever
// merely because the original in-memory Shadow window is gone.
async function recoverPersistedPending(cur) {
  const now = Date.now();
  if (pendingRecoveryBusy || now < pendingRecoveryAfterMs) return;
  pendingRecoveryBusy = true;
  pendingRecoveryAfterMs = now + 15000;
  try {
    const rows = await pendingSessionsBefore(cur, 50);
    for (const row of rows) {
      // A normal live window remains in Shadow memory until its tracker settles
      // it. Let that authoritative path emit the UI event and write its replay.
      // Recovery is only for orphan rows
      // whose process disappeared before resolution.
      if (shadow?.windows?.has(row.slug)) continue;
      const resolution = await fetchResolution(row.slug).catch(() => null);
      if (!resolution?.winSide) continue;
      const ab = await finalizePendingSession(row, resolution.winSide);
      if (!ab) continue;
      console.log(`[shadow recovery] ${String(row.slug).split("-").pop()} win=${ab.winSide} sim=$${fmt(ab.sim?.pnl)} — finalized persisted pending row`);
      try { ui?.shadowResolved?.({ slug: row.slug, ab }); } catch {}
    }
  } finally { pendingRecoveryBusy = false; }
}

async function lifecycle() {
  const cur = currentWindowStart();
  void recoverPersistedPending(cur);
  try { setLogWindow(slugFor(cur)); } catch {}   // point the session log at the current window's file
  const slugs = [slugFor(cur), slugFor(cur + config.windowSec)]; // current + next (pre-arm)
  for (const s of slugs) {
    const w = await tracker.register(s);
    // Start complete CLOB metadata/signing/connection prewarm as soon as each
    // window resolves. Current is launched before we wait for next-window
    // Gamma metadata; both stay outside the decision → POST path.
    if (live.isLive()) {
      if (w) void live.prewarm([w.upTokenId, w.downTokenId], w.conditionId);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Record just-CLOSED shadow windows as "pending" FIRST (before we settle) so the history shows a ⏳ pending
  // row immediately on close; settle() below overwrites it with the resolved winner/PnL once we settle.
  if (shadow) for (const w of shadow.windows.values()) {
    if (w.windowStart < cur && !w.settled) shadow.recordPending(w.slug);
  }
  // refresh meta for not-yet-settled windows (pull winSide once available), then settle — but HOLD OFF for a
  // few seconds after close so the pending row is actually visible before it flips (Polymarket often resolves
  // within one poll of the close). POLY_RESOLVE_FIRST_DELAY_MS controls the visible pending window.
  const firstDelayS = Math.max(0, (Number(process.env.POLY_RESOLVE_FIRST_DELAY_MS) || 12000) / 1000);
  for (const w of tracker.windows.values()) {
    if (!w.winSide || w.openPrice == null || w.openProvisional) {
      const meta = await resolveWindow(w.slug).catch(() => null);
      tracker.updateMeta(w, meta);
    }
    const closedForS = nowSec - (w.windowStart + config.windowSec);
    if (w.winSide && closedForS >= firstDelayS) tracker.settle(w);
  }
  // ORPHAN CLEANUP (live only): a just-CLOSED window can leave a resting GTC remainder on its tokens — a partial
  //   entry that never fully filled. Cancel any open orders on a closed window's tokens ONCE, so a late seller
  //   cannot fill a stray order after the engine has moved to the next market. No-op in simulation.
  if (live.isLive()) {
    for (const w of tracker.windows.values()) {
      if (w.windowStart < cur && !w._orphansSwept) {
        w._orphansSwept = true;
        for (const tok of [w.upTokenId, w.downTokenId]) {
          if (tok) live.getOpenOrders({ tokenId: tok }).then((os) => { for (const o of (os || [])) live.cancelOrder(o.orderId).catch(() => {}); }).catch(() => {});
        }
      }
    }
  }
  tracker.prune(Math.floor(Date.now() / 1000));
  shadow?.prune(Math.floor(Date.now() / 1000));
  // drop per-token book/depth/bba state for windows that have rolled off → bounds long-run memory.
  const keepTokens = new Set();
  for (const w of tracker.windows.values()) { if (w.upTokenId) keepTokens.add(w.upTokenId); if (w.downTokenId) keepTokens.add(w.downTokenId); }
  if (keepTokens.size) pruneTokens(state, keepTokens);

  // if the set of token ids changed, re-subscribe the CLOB socket
  const sig = currentTokenIds().sort().join(",");
  if (sig && sig !== lastTokenSig) {
    lastTokenSig = sig;
    clob?.resubscribe();
  }
  const csig = currentConditionIds().sort().join(",");
  if (csig && csig !== lastCondSig) {
    lastCondSig = csig;
    clobUser?.resubscribe();   // re-send the updated markets list on window rollover
  }
}

// ---- UI tick sampler: push live spot/gap/book/position to the browser every uiSampleMs.
//      (The shadow strategy is event-driven off the CLOB feed, not sampled here.) ----
let lastUiSlug = null;
function samplerTick() {
  if (!ui || !ui.hasClients()) return;   // no browser watching → skip the payload build entirely (≈ console mode)
  const a = config.asset;
  const bzSlot = state.binance[a];
  const bz = bzSlot?.value ?? null;
  const cl = state.chainlink[a]?.value ?? null;   // Polymarket RTDS Chainlink TWAP-60
  const curStart = currentWindowStart();
  const w = [...tracker.windows.values()].find((x) => x.windowStart === curStart);
  if (!w) return;
  const sampleNowMs = Date.now();
  const tInto = sampleNowMs / 1000 - w.windowStart;
  // Binance open = aggTrades REST only (fires here too in case the CLOB feed is quiet); chainlink open provisional from WS.
  if (tInto >= 0) {
    ensureBinanceOpen(w);
    if (tInto <= 6 && w.openPrice == null && cl != null) { w.openPrice = cl; w.openProvisional = true; }   // delayed poly API replaces it
  }
  const upA = w.upTokenId ? state.bbaByToken.get(w.upTokenId) : null;
  const dnA = w.downTokenId ? state.bbaByToken.get(w.downTokenId) : null;
  const upBookAgeMs = upA?.recvTs ? sampleNowMs - upA.recvTs : null;
  const dnBookAgeMs = dnA?.recvTs ? sampleNowMs - dnA.recvTs : null;
  const clobAgeMs = upBookAgeMs == null || dnBookAgeMs == null ? null : Math.max(upBookAgeMs, dnBookAgeMs);
  const clobFresh = clobAgeMs != null && clobAgeMs <= config.tradeFreshMs;
  const clobLive = !!(upA && dnA && clob?.isAlive?.());
  const clobHeartbeatAgeMs = clob?.heartbeatAgeMs?.() ?? null;
  if (w.slug !== lastUiSlug) {
    lastUiSlug = w.slug;
    try { setLogWindow(w.slug); } catch {}   // switch the session log to this window immediately on rollover
    ui.windowStart({ slug: w.slug, windowStart: w.windowStart, openPrice: w.openPrice, openBinance: w.openBinance });
  }
  const gap = (cur, open) => (cur != null && open != null && open !== 0
    ? { g: cur - open, pct: ((cur - open) / Math.abs(open)) * 100 } : { g: null, pct: null });
  const bzG = gap(bz, w.openBinance);
  const clG = gap(cl, w.openPrice);
  const pnl = tracker.pnlView(w);
  // BINANCE FEED HEALTH — age of the last @aggTrade + the running failure counters, so the UI can flag a dead/stale
  //   feed even while the last price lingers (the gap would otherwise show a frozen value with no hint it's stale).
  const H = state.binanceHealth || null;
  const bzAgeMs = bzSlot?.recvTs ? Date.now() - bzSlot.recvTs : null;
  const staleMs = config.binanceQuoteStaleReconnectMs || 30000;
  const binHealth = H ? {
    status: bzAgeMs != null && bzAgeMs > staleMs ? "stale" : H.status,
    ageMs: bzAgeMs, reconnects: H.reconnects, staleReconnects: H.staleReconnects,
    errors: H.errors, downMs: H.totalDownMs + (H.downSince ? Date.now() - H.downSince : 0),
  } : null;
  // STRATEGY STATUS — Helpme's live gate for this window, surfaced so
  // "what's the bot doing / why isn't it entering" is visible at a glance.
  let strat = null; try { strat = shadow ? shadow.liveStatus() : null; } catch {}
  const openProvisional = !!w.openBinanceProvisional;
  ui.tick({
    window: { slug: w.slug, windowStart: w.windowStart, tInto, openPrice: w.openPrice, openBinance: w.openBinance },
    bzPrice: bz, clPrice: cl, bzAgeMs, binHealth, strat, openProvisional,
    clobAgeMs, clobFresh, clobLive, clobHeartbeatAgeMs,
    bzGap: bzG.g, bzGapPct: bzG.pct, clGap: clG.g, clGapPct: clG.pct,
    spread: bz != null && cl != null ? bz - cl : null,
    spreadPct: bz != null && cl != null && cl ? ((bz - cl) / cl) * 100 : null,
    up: upA ? { bestBid: upA.bestBid, bestAsk: upA.bestAsk, quoteT: upA.recvTs / 1000 - w.windowStart } : null,
    down: dnA ? { bestBid: dnA.bestBid, bestAsk: dnA.bestAsk, quoteT: dnA.recvTs / 1000 - w.windowStart } : null,
    pos: { upShares: w.upShares, downShares: w.downShares, totalCost: w.totalCost,
           ifUpWins: pnl.ifUpWins, ifDownWins: pnl.ifDownWins, mtm: pnl.mtm },
  });
}

// ---- start / stop the ENGINE (all feeds + intervals). Driven by the Start/Stop switch. ----
async function startEngine() {
  if (engineOn) return;
  engineOn = true;
  await live.ensureReadyOrDowngrade();   // live mode: connect the wallet or DOWNGRADE to simulation (no real orders)
  // Restore this market's durable simulation ledger/release guards before the
  // first new CLOB event can make a decision. This closes the mid-window PM2
  // restart gap without inventing unavailable pre-restart momentum samples.
  if (shadow) {
    const ws = currentWindowStart(), slug = slugFor(ws);
    const [fills, status] = await Promise.all([fillsOfWindow(ws), orderStatusOf(slug)]);
    shadow.hydrateWindow({ slug, windowStart: ws, fills, orderStatus: status });
  }
  stopChainlink = startRtdsChainlinkFeed(state);
  stopBinance = startBinanceSpotFeed(state, [config.asset]);
  clob = startClobMarketFeed(state, currentTokenIds, onBook);
  // USER-channel WS (LIVE only): real-time push of OUR order/trade status → Order Status panel. Display-only
  //   (the reconcile poll stays the single money-booking source, so no double-count). See clobUserWs.js.
  if (live.isLive()) clobUser = startClobUserFeed(live.getApiCreds, currentConditionIds, {
    onOrder: (o) => {
      // Panel-friendly order status: PARTIALLY_MATCHED when 0 < matched < orig, else the raw status.
      const st = (o.matched != null && o.orig != null && o.matched > 1e-6 && o.matched < o.orig - 1e-6) ? "PARTIALLY_MATCHED" : o.status;
      const apply = (ctx) => ctx.emitOS(STAGES.STATUS, { phase: "order", statusRaw: st, matched: o.matched, orig: o.orig, price: o.price, ts: o.ts, src: "ws" });
      const ctx = osByOrderId.get(o.orderId); if (ctx) apply(ctx); else bufferWsEvent(o.orderId, apply);   // buffer if the id hasn't registered yet
      live.nudgeReconcile(o.orderId);   // WS-AS-TRIGGER: this order changed → poll it NOW (books the real fill ~1.5s sooner); poll stays the money source
    },
    onTrade: (t) => {
      const apply = (ctx) => ctx.emitOS(STAGES.STATUS, { phase: "trade", statusRaw: t.status, price: t.price, size: t.size, ts: t.ts, src: "ws" });
      const ctx = osByOrderId.get(t.orderId); if (ctx) apply(ctx); else bufferWsEvent(t.orderId, apply);
      live.nudgeReconcile(t.orderId);   // WS-AS-TRIGGER: a fill on this order landed → immediate reconcile books it (no double-count: bookedShares dedups)
    },
  });
  stopActivity = startActivityPoller((ev) => { tracker.onActivity(ev).catch(() => {}); });
  await lifecycle().catch(() => {});
  lifecycleTimer = setInterval(() => lifecycle().catch(() => {}), 5000);
  if (ui) samplerTimer = setInterval(samplerTick, config.uiSampleMs);
  // Decisions are driven per-tick by onBook on the native CLOB feed.
  console.log("[engine] STARTED — feeds connected" + (live.isLive() ? " (LIVE: real orders armed)" : ""));
}
function stopEngine() {
  if (!engineOn) return;
  engineOn = false;
  // Cancel ALL resting orders on stop so nothing keeps filling after the engine is halted (real-money safety).
  if (live.isLive()) { try { live.getOpenOrders().then((os) => { for (const o of (os || [])) live.cancelOrder(o.orderId).catch(() => {}); }).catch(() => {}); } catch {} }
  try { stopChainlink?.(); } catch {}
  try { stopBinance?.(); } catch {}
  try { clob?.stop(); } catch {}
  try { clobUser?.stop(); } catch {}
  try { stopActivity?.(); } catch {}
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  if (samplerTimer) clearInterval(samplerTimer);
  stopChainlink = stopBinance = clob = clobUser = stopActivity = null;
  lifecycleTimer = samplerTimer = null;
  _liveW = null; _liveWStart = -1; lastTokenSig = ""; lastCondSig = ""; lastUiSlug = null;
  console.log("[engine] STOPPED — feeds disconnected");
}
// the Start/Stop switch (UI buttons → /api/bot/start|stop → setRunning) drives the whole engine
onRunChange((on) => { if (on) startEngine().catch((e) => console.error("[engine] start failed:", e)); else stopEngine(); });

// render runs regardless of engine state: TTY → clear-screen TUI; non-TTY → 10s heartbeat line.
if (process.stdout.isTTY) setInterval(() => render(state, tracker), config.dashboardMs);
else setInterval(() => renderHeadless(state, tracker, shadow), 10000);

console.log(`tracking wallet ${config.wallet}  asset ${config.asset} ${config.interval} · mode=${config.mode}`);
// CONSOLE mode auto-runs the engine; UI mode waits for the Start button (unless AUTO_START=1, e.g. an
// unattended pm2 collector that must reconnect feeds after any restart without a manual click).
if (config.mode === "console" || process.env.AUTO_START === "1") setRunning(true);
else {
  console.log("[bot] UI mode — engine idle; press Start to connect feeds & run");
  // BOOT-TIME wallet check (live mode, UI): verify the trading wallet connects NOW. On failure DOWNGRADE
  // to simulation at boot (no real orders until a restart fixes the creds); on success stay REAL LIVE.
  // (Console mode already verifies via startEngine's ensureReadyOrDowngrade, which is awaited before feeds.)
  if (live.isLive()) {
    live.ensureReadyOrDowngrade()
      .then(() => console.log(`[boot] wallet check → ${live.isLive() ? "REAL LIVE armed (wallet connected)"
        : "DOWNGRADED to SIMULATION — " + (live.liveStatus().downgradeReason || "wallet connect failed")}`))
      .catch((e) => console.error("[boot] wallet check error:", e?.message || e));
  }
}

// ---- graceful shutdown ----
function shutdown() {
  stopEngine(); ui?.stop();
  process.stdout.write("\n[shutdown] stopped\n");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
