// Central config for the generic "Tracker" tool. The tracked market (asset +
// interval) and wallet are chosen live from the web UI (POST /api/set-market),
// which mutates the fields below at runtime. The values here are just the boot
// defaults. Feed URLs mirror the proven recorder (poly-price-backtrace-v2).

import { fileURLToPath } from "node:url";
// Resolve a path relative to this file → a proper OS path. (Windows fix: URL.pathname yields
// "/E:/…" with a leading slash, which fs then mangles to "E:\E:\…"; fileURLToPath returns "E:\…".)
const rel = (p) => fileURLToPath(new URL(p, import.meta.url));

// Load the project-root .env into process.env if present (Node ≥20.12). Best-effort: no file / older
// node → ignored, and any var already set in the real environment (pm2 env, shell) still wins.
try { process.loadEnvFile?.(rel("../../.env")); } catch {}

// Env readers that treat an UNSET **or EMPTY** var as "use the default". A blank line in .env (e.g.
// `WINDOW_SEC=`) sets the var to "", and `"" ?? default` keeps the "" (?? only catches null/undefined) —
// which then becomes `Number("")` = 0 or an empty URL. These helpers make a blank behave like unset.
const E   = (k, d) => { const v = process.env[k]; return (v == null || v === "") ? d : v; };
const ENUM = (k, d) => Number(E(k, d));
const EBOOL = (k, d = false) => { const v = E(k, null); return v == null ? d : /^(1|true|yes|on)$/i.test(String(v).trim()); };

const DEF_INTERVAL = E("INTERVAL", "5m").toLowerCase(); // 5m | 15m

// BACKTEST MODE (env BACKTEST_MODE): "v2" (default) | "v3" | "select". v2/v3 FIX the backtest API version and
// HIDE the picker in the config menu (the mode is fixed, nothing to change on the UI). "select" shows the
// picker so v2/v3 can be chosen live. Anything else falls back to v2.
const BACKTEST_MODE = (() => { const m = E("BACKTEST_MODE", "v2").toLowerCase(); return (m === "v3" || m === "select") ? m : "v2"; })();
// Normalize a backtest API version string to a known value (v2/v3); anything else → v2.
const NORM_VER = (v) => { const s = String(v || "").toLowerCase(); return (s === "v3" || s === "v2") ? s : "v2"; };

export const config = {
  // Tracked wallet — the bot's OWN Polymarket funder (track my live bot). Set in .env (TRACK_WALLET);
  // also settable live from the dashboard. No literal default here — an unset wallet just tracks nothing
  // until one is provided (via .env or the UI).
  wallet: E("TRACK_WALLET", "").toLowerCase().trim(),

  asset: E("ASSET", "btc").toLowerCase(),                 // btc | eth | sol | xrp
  interval: DEF_INTERVAL,                                  // 5m | 15m
  windowSec: ENUM("WINDOW_SEC", DEF_INTERVAL === "15m" ? 900 : 300),

  // ---- Live feeds (identical endpoints to the recorder) ----
  binanceWsUrl: E("BINANCE_WS_URL", "wss://stream.binance.com:9443").replace(/\/$/, ""),
  polyRtdsWsUrl: E("POLY_RTDS_WS_URL", "wss://ws-live-data.polymarket.com").trim(),
  polyClobWsUrl: E("POLY_CLOB_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market").trim(),

  // ---- REST ----
  gammaHost: E("GAMMA_HOST", "https://gamma-api.polymarket.com").replace(/\/$/, ""),
  dataApiHost: E("DATA_API_HOST", "https://data-api.polymarket.com").replace(/\/$/, ""),
  // Local backtest API (poly-price-backtrace-v2) — used for authoritative
  // open/final/winSide. Optional; tracker degrades gracefully if absent.
  backtestApi: E("BACKTEST_API", "https://bapi-v2.polywinbot.com").replace(/\/$/, ""),
  // Full-depth V2 recorder: 50 ms coherent Up/Down order-book frames used by
  // wallet3048's recorded:false replay. /snapshot-ticks remains the metadata source.
  v2OrderbookApi: E("BAPI_V2_OB_BASE", "https://bapi-v2-ob.polywinbot.com").replace(/\/$/, ""),
  // v3 backtest API (bapi-v3): GET /markets/{slug}/snapshots — camelCase fields, higher tick resolution,
  // per-tick binance spot native. Default domain below; override in .env with BAPI_V3_BASE.
  bapiV3: E("BAPI_V3_BASE", "https://bapi-v3.polywinbot.com").replace(/\/$/, ""),
  // API keys for the polywinbot backtest API. v3 has its own; legacy BAPI_KEY is a fallback for v2 / generic
  //   polywinbot hosts. Sent as X-API-Key (+Bearer) on every polywinbot request.
  bapiKey: E("BAPI_KEY", ""),
  bapiV3Key: E("BAPI_V3_KEY", ""),
  // Backtest mode: "v2" | "v3" (version fixed, UI picker hidden) | "select" (UI picks the version live). env: BACKTEST_MODE.
  backtestMode: BACKTEST_MODE,
  // Which tick source fetchWindowHistory uses: "v2" (bapi-v2 /snapshot-ticks) or "v3" (bapi-v3 /markets/*/snapshots).
  // Fixed by backtestMode when that's v2/v3; in "select" mode it starts from BACKTEST_API_VERSION and the UI/persisted
  // config can change it at runtime.
  backtestApiVersion: (BACKTEST_MODE === "v2" || BACKTEST_MODE === "v3")
    ? BACKTEST_MODE
    : NORM_VER(E("BACKTEST_API_VERSION", "v2")),
  // Polygon RPC — used to decode the REAL maker order behind a fill's transactionHash
  // (orderHash for grouping partials, full size, limit/cap price, GTC vs GTD via expiration).
  onchainRpc: E("ONCHAIN_RPC", "https://polygon-bor-rpc.publicnode.com").replace(/\/$/, ""),

  // SHOW the tracker view (tracked-wallet charts + wallet selector + Track button + view-mode picker +
  // "disable tracker" toggle). Default OFF → the whole tracker UI is hidden and the poll is disabled; the
  // dashboard shows the SHADOW strategy only. Set SHOW_TRACKER=1 to show + enable it. env: SHOW_TRACKER=1
  showTracker: EBOOL("SHOW_TRACKER", false),

  // ---- Polling / timing ----
  activityPollMs: ENUM("ACTIVITY_POLL_MS", 300),
  // Disable the tracked-wallet activity poll (the tracker's fill feed) to save CPU/network. The market /
  // book / window feeds keep running, so the SHADOW strategy is unaffected. Runtime-toggleable via the UI
  // (/api/tracker) — this is the boot default. Defaults to hidden-tracker ⇒ off. env: TRACKER_DISABLED=1
  trackerDisabled: EBOOL("TRACKER_DISABLED", !EBOOL("SHOW_TRACKER", false)),
  dashboardMs: ENUM("DASHBOARD_MS", 1000),
  // How many windows to keep tracking after they close (to capture settlement / redeem).
  keepClosedWindows: ENUM("KEEP_CLOSED_WINDOWS", 3),
  // Per-token rolling buffer of book snapshots, used to look up book state at a
  // fill's timestamp (activity polling lags the live feed by 1-2s).
  bookBufferMs: ENUM("BOOK_BUFFER_MS", 30000),

  // Staleness / reconnect (same defaults as recorder).
  chainlinkQuoteStaleReconnectMs: ENUM("CHAINLINK_STALE_MS", 90000),
  binanceQuoteStaleReconnectMs: ENUM("BINANCE_STALE_MS", 30000),
  // If the aggTrades REST window-open hasn't landed by this many seconds, seed a PROVISIONAL open from the WS feed for
  // dashboard/reference analytics. Binance gap velocity subtracts two gap levels,
  // so the opening value cancels and does not affect the strategy direction.
  binanceOpenFallbackS: ENUM("BINANCE_OPEN_FALLBACK_S", 10),
  // CLOB book feed: if no message/pong for this long the socket is silently dead → force reconnect ASAP.
  clobStaleReconnectMs: ENUM("CLOB_STALE_MS", 12000),
  // Don't place a LIVE order if the side-being-bought's book hasn't updated within this long (stale price).
  tradeFreshMs: ENUM("TRADE_FRESH_MS", 6000),
  // POST-FIRE RECONCILE: a marketable GTC order's unfilled remainder rests and can fill LATE; the POST response
  //   only reports the synchronous match. Poll getOrder/getTrades for up to reconcileFillMaxMs (every interval) to
  //   book any additional fills into the honest ledger. 0 = off (trust the POST response only).
  reconcileFillMaxMs: ENUM("RECONCILE_FILL_MAX_MS", 8000),
  reconcileFillIntervalMs: ENUM("RECONCILE_FILL_INTERVAL_MS", 800),
  // Track an order's STATUS transitions (order: live→partially_matched→matched; on-chain trade: MATCHED→MINED→
  //   CONFIRMED) after firing, up to this long, and emit each change (with a timestamp) to the Order Status panel.
  //   0 = off (only reconcile fills). Longer because on-chain confirmation can take tens of seconds.
  trackOrderMaxMs: ENUM("TRACK_ORDER_MAX_MS", 60000),
  trackOrderIntervalMs: ENUM("TRACK_ORDER_INTERVAL_MS", 1500),
  // STALE RESTING-ORDER ABANDON: a marketable entry/hedge should fill (or reject) fast; if it's still unfilled or only
  //   PARTIALLY filled after this long, abandon it — reconcileOrder fires UNFILLED_TIMEOUT early so the router CANCELS
  //   the resting remainder (closing the late-fill / double-position window) then frees the engine's pending guard.
  //   Median real fill ≈ 490ms, so 10s = a genuinely stuck order. 0 = off (fall back to the full track deadline).
  liveRestTimeoutMs: ENUM("LIVE_REST_TIMEOUT_S", 10) * 1000,

  dataDir: E("DATA_DIR", rel("../../data/")),
  // Structured per-run logging: logs/<instance>/<bootStamp>/ with per-window log files (3 MB each) + config.json
  // (boot config + change history). See src/logging/sessionLog.js.
  logDir: E("LOG_DIR", rel("../../logs/")),
  logMaxMb: ENUM("LOG_MAX_MB", 3),
  // Settled-window disk cache → reproducible backtests (recent windows still record, so live fetches diverge run-to-run).
  winCache: EBOOL("WIN_CACHE", true),
  winCacheStableSec: ENUM("WIN_CACHE_STABLE_SEC", 600),   // only cache a window this many seconds AFTER it ended (stable).
  // INSTANCE NAME — separates logs per process when several run at once (compare pm2 id 34 vs 52). pm2 sets pm_id/name;
  //   the session-log dir + verbose lines carry this tag. Override with INSTANCE_NAME=… ; default = "<name>-pm<id>" / "pid<pid>".
  instanceName: E("INSTANCE_NAME", process.env.pm_id != null ? `${process.env.name || "app"}-pm${process.env.pm_id}` : `pid${process.pid}`),

  // SHADOW strategy A/B: run research/strategy.js decide() on the same live feeds alongside the
  // bot and log a per-window bot-vs-sim PnL ledger (data/shadow-ab.jsonl). Set SHADOW=0 to disable.
  shadow: E("SHADOW", "1") !== "0",

  // ───── EXECUTION MODE ───────────────────────────────────────────────────────
  // This wallet3048 reconstruction has a CODE-LEVEL simulation lock. Environment values and copied secrets
  // cannot arm real execution; enabling money movement requires a separate, reviewed code change.
  simulationOnly: true,
  executionMode: "simulation",
  livePrivateKey: "",
  // OPTIONAL hard safety backstop: reject any single live order over this many USDC. This is NOT the order
  // size (that's the primary "$" / HEAP config) — just a ceiling that catches a typo/bug. 0 = disabled.
  liveMaxOrderUsd: ENUM("LIVE_MAX_ORDER_USD", 25),
  liveMinOrderUsd: ENUM("LIVE_MIN_ORDER_USD", 1),   // Polymarket rejects a BUY below $1 notional → bump sub-$1 orders up to this. 0 = off.
  // Fallback live automated taker transport for legacy/manual callers. GTC was
  // materially faster than FAK in the production probe and any unfilled
  // remainder is canceled immediately.
  // This changes live execution only; recorded:false simulation remains the
  // strategy's fixed-USD FAK model for apples-to-apples research.
  liveTakerOrderType: String(E("LIVE_TAKER_ORDER_TYPE", "GTC")).trim().toUpperCase() === "FAK" ? "FAK" : "GTC",
  liveGtcCancelRemainderMs: Math.max(0, ENUM("LIVE_GTC_CANCEL_REMAINDER_MS", 0)),
  // CIRCUIT BREAKER: if the running SESSION realized PnL (real in live, else sim) drops to −this many USDC,
  // auto-STOP the bot (halts new strategy fills). 0 = off. Re-arms when you Start the bot again. env: MAX_SESSION_LOSS
  maxSessionLoss: ENUM("MAX_SESSION_LOSS", 0),
  // Polymarket CLOB REST host (order placement) + chain id.
  clobHost: E("CLOB_HOST", "https://clob.polymarket.com").replace(/\/$/, ""),
  clobChainId: ENUM("CLOB_CHAIN_ID", 137),

  // RUN MODE: "ui" (default) serves the dashboard and the bot's feeds/engine are started/stopped by the
  // Start/Stop buttons. "console" runs headless (no dashboard) and auto-starts the engine at boot.
  mode: (E("MODE", "ui").toLowerCase() === "console") ? "console" : "ui",

  // VERBOSE LOGGING: detailed order-submission / live-routing logs (boot default; the UI 'verbose'
  // toggle flips it live). Off by default — when off it has ZERO hot-path cost (see src/logging/verbose.js).
  verboseLog: EBOOL("VERBOSE_LOG", false),

  // RECORD LIVE TICKS: persist the exact per-tick CLOB best bids/asks and spot
  // prices used by the live simulation. Both Up quotes reproduce its midpoint.
  recordLiveTicks: EBOOL("RECORD_LIVE_TICKS", true),
  recordLiveTicksKeep: ENUM("RECORD_LIVE_TICKS_KEEP", 10000),
  recorderCohortManifest: E("RECORDER_COHORT_MANIFEST", ""),

  // MANUAL BUY MODE: when on, the dashboard shows the manual-order panel (place a sim buy into the shadow ledger —
  //   draws a circle, counts in PnL + live history). Off (default) hides the panel entirely.
  manualBuyMode: EBOOL("MANUAL_BUY_MODE", false),

  // Visual dashboard (http + ws). Set UI_PORT=0 to disable.
  uiPort: ENUM("UI_PORT", 4520),   // FastMX dashboard; isolated from the source project
  // How often to push a spot/book sample to the UI (ms). Lower = smoother chart
  // (more points/sec). Feeds are sub-second, so 120ms tracks the book closely.
  uiSampleMs: ENUM("UI_SAMPLE_MS", 120),
};

// ── Backtest API version (v2 / v3), switchable at RUNTIME from the config-menu combobox ─────────
// The selection drives the backtest/backview tick source (bapi-v2 / bapi-v3).
export function setBacktestApiVersion(v) {
  config.backtestApiVersion = NORM_VER(v);
  return config.backtestApiVersion;
}
// Resolve the API key for a polywinbot backtest URL by host — v3 has its own key; v2/generic fall back to the
//   legacy key. Returns "" for non-polywinbot hosts.
export function bapiKeyForUrl(url) {
  const u = String(url || "");
  if (!u.includes("polywinbot.com")) return "";
  if (u.includes("bapi-v3")) return config.bapiV3Key || config.bapiKey;
  return config.bapiKey || config.bapiV3Key;
}
// Allowed market dimensions for the UI selector (asset × interval = 8 combos).
export const ASSETS = ["btc", "eth", "sol", "xrp"];
export const INTERVALS = { "5m": 300, "15m": 900 };

export const BINANCE_SYM = { btc: "btcusdt", eth: "ethusdt", sol: "solusdt", xrp: "xrpusdt" };
export const CL_PAIR = { btc: "btc/usd", eth: "eth/usd", sol: "sol/usd", xrp: "xrp/usd" };

export function assetFromBinanceSymbol(sym) {
  const s = String(sym).toLowerCase();
  return Object.keys(BINANCE_SYM).find((a) => BINANCE_SYM[a] === s) ?? null;
}
export function assetFromChainlinkSymbol(sym) {
  const s = String(sym).toLowerCase();
  return Object.keys(CL_PAIR).find((a) => CL_PAIR[a] === s) ?? null;
}
