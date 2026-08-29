import WebSocket from "ws";
import { config, assetFromChainlinkSymbol } from "../config/config.js";

/**
 * Polymarket RTDS — Chainlink's 60-second TWAP settlement feed.
 *
 * `state.chainlink` is intentionally the TWAP-60 series consumed by the live engine,
 * recorder, dashboard, and provisional Chainlink window-open fallback. Binance @aggTrade remains
 * the Helpme confirmation signal; this is the settlement-aligned Chainlink comparison series.
 */
const TOPIC_TWAP = "crypto_prices_twap_sixty";
const RECONNECT_BASE_MS = 2_500;
const RECONNECT_MAX_MS = 60_000;
const RATE_LIMIT_MIN_MS = 15_000;
const STABLE_MS = 30_000;
const PING_MS = 5_000;

/**
 * Decode the RTDS Chainlink payload shapes used by poly-mom-bot.
 *
 * Snapshot rows do not repeat the symbol: it lives at `payload.symbol`. The
 * shared `crypto_prices` fallback can also carry Binance symbols, so only
 * slash-form symbols are accepted as Chainlink values.
 */
export function parseRtdsChainlinkMessage(input, fallbackAsset = null) {
  let msg = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try { msg = JSON.parse(String(input)); } catch { return []; }
  }

  const topic = msg?.topic;
  if (topic !== "crypto_prices" && !String(topic).startsWith("crypto_prices_twap")) return [];

  const payload = msg?.payload;
  const frameSymbol = payload?.symbol;
  const updates = [];
  const apply = (row, symbol) => {
    let asset;
    if (symbol == null || symbol === "") asset = fallbackAsset;
    else if (String(symbol).includes("/")) asset = assetFromChainlinkSymbol(symbol);
    else return; // Binance-shaped symbol on the shared topic.
    if (!asset) return;

    const raw = row?.value;
    if (raw == null || raw === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;

    const rawTs = row?.timestamp != null ? Number(row.timestamp) : null;
    let payloadTs = null;
    if (Number.isFinite(rawTs)) payloadTs = rawTs < 1e12 ? Math.round(rawTs * 1000) : Math.round(rawTs);
    updates.push({ asset, value, payloadTs });
  };

  if (Array.isArray(payload?.data)) {
    for (const row of payload.data) apply(row, frameSymbol);
  } else if (payload && typeof payload === "object" && payload.value != null) {
    apply(payload, payload.symbol);
  }
  return updates;
}

export function startRtdsChainlinkFeed(state) {
  let ws = null;
  let stopped = false;
  let pingTimer = null;
  let staleTimer = null;
  let reconnectTimer = null;
  let lastDataTs = 0;
  let lastAnyMsgTs = 0;
  let openedAt = 0;
  let reconnectAttempts = 0;
  let lastCloseWas429 = false;

  const clearConnectionTimers = () => {
    clearInterval(pingTimer); pingTimer = null;
    clearInterval(staleTimer); staleTimer = null;
  };

  const apply = ({ asset, value, payloadTs }) => {
    const prev = state.chainlink[asset];
    if (prev?.payloadTs != null && payloadTs != null && payloadTs <= prev.payloadTs) return;
    const recvTs = Date.now();
    state.chainlink[asset] = { value, payloadTs, recvTs };
    lastDataTs = recvTs;
  };

  const handle = (txt) => {
    if (txt) lastAnyMsgTs = Date.now();
    if (!txt || txt === "PONG" || txt === "pong") return;

    let msg;
    try { msg = JSON.parse(txt); } catch { return; }
    if (typeof msg?.message === "string" && /too many requests|rate.?limit/i.test(msg.message)) {
      lastCloseWas429 = true;
      console.warn(`[chainlink] RTDS throttled: ${msg.message}`);
      try { ws?.close(); } catch {}
      return;
    }

    for (const update of parseRtdsChainlinkMessage(msg)) apply(update);
  };

  const connect = () => {
    if (stopped) return;
    openedAt = 0;
    lastCloseWas429 = false;
    ws = new WebSocket(config.polyRtdsWsUrl);

    ws.on("open", () => {
      openedAt = Date.now();
      lastAnyMsgTs = openedAt;
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
          // RTDS expects `filters` to be present and encoded as a string. An
          // empty string subscribes all supported assets for instant UI switches.
          { topic: TOPIC_TWAP, type: "update", filters: "" },
        ],
      }));

      clearConnectionTimers();
      // RTDS application heartbeats are lowercase; PONGs count as socket
      // liveness, but only real values refresh the quote-freshness watchdog.
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          try { ws.send("ping"); } catch {}
        }
      }, PING_MS);

      lastDataTs = Date.now();
      const staleMs = config.chainlinkQuoteStaleReconnectMs;
      staleTimer = setInterval(() => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        const quoteAge = Date.now() - lastDataTs;
        const socketAge = Date.now() - lastAnyMsgTs;
        if (quoteAge <= staleMs && socketAge <= staleMs) return;
        console.warn(`[chainlink] RTDS stale (quote=${Math.round(quoteAge / 1000)}s, socket=${Math.round(socketAge / 1000)}s) -> reconnecting`);
        try { ws.terminate(); } catch { try { ws.close(); } catch {} }
      }, Math.max(5_000, Math.floor(staleMs / 3)));
      console.log("[chainlink] connected (RTDS TWAP-60)");
    });

    ws.on("message", (b) => handle(b.toString()));
    ws.on("pong", () => { lastAnyMsgTs = Date.now(); });
    ws.on("ping", () => { lastAnyMsgTs = Date.now(); });
    ws.on("close", () => {
      clearConnectionTimers();
      ws = null;
      if (stopped) return;

      const wasStable = openedAt && Date.now() - openedAt > STABLE_MS;
      reconnectAttempts = wasStable ? 0 : reconnectAttempts + 1;
      const step = Math.min(Math.max(0, reconnectAttempts - 1), 5);
      let delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** step);
      if (lastCloseWas429) delay = Math.max(delay, RATE_LIMIT_MIN_MS);
      delay = Math.round(delay * (0.7 + Math.random() * 0.6));
      reconnectTimer = setTimeout(connect, delay);
    });
    ws.on("error", (err) => {
      const message = String(err?.message || "");
      if (/\b429\b|rate.?limit|too many/i.test(message)) lastCloseWas429 = true;
      try { ws?.close(); } catch {}
    });
  };

  connect();
  return () => {
    stopped = true;
    clearConnectionTimers();
    clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
  };
}
