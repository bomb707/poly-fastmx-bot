import WebSocket from "ws";
import { config, BINANCE_SYM, assetFromBinanceSymbol } from "../config/config.js";
import { logFeedEvent } from "../logging/sessionLog.js";

/**
 * Binance spot WS — @aggTrade for the tracked asset (matches the v3 backtest DB, which
 * is built from @aggTrade). This is the FAST/true price; the bot reads it to anticipate
 * where the laggy Chainlink settlement will land. Mirrors recorder/src/feeds/binanceSpotWs.js.
 */
export function startBinanceSpotFeed(state, assets = [config.asset]) {
  let ws = null;
  let stopped = false;
  let pingTimer = null;
  let staleTimer = null;
  let lastDataTs = 0;            // when we last applied a FRESH binance trade
  let reconnectDelay = 2500;     // reconnect backoff — grows on repeated failures, resets when trades flow again

  // FEED HEALTH — mutate the shared health object so the UI/logs can SEE failures (silent WS deaths, rate-limit
  //   drops, stale sticks). state.binanceHealth is created empty in createLiveState; guard in case it's absent.
  const H = state.binanceHealth || (state.binanceHealth = {
    status: "init", lastDataTs: 0, connectedSince: 0, connects: 0, reconnects: 0,
    staleReconnects: 0, errors: 0, lastError: null, downSince: 0, totalDownMs: 0, lastChangeTs: 0 });
  const setStatus = (s, why) => {
    if (H.status === s) return;
    const now = Date.now();
    if (s === "live" && H.downSince) { H.totalDownMs += now - H.downSince; H.downSince = 0; }   // recovered
    else if (s !== "live" && !H.downSince) H.downSince = now;                                     // went down
    H.status = s; H.lastChangeTs = now;
    (s === "live" ? console.log : console.warn)(`[binance] feed ${s}${why ? " — " + why : ""} (reconn ${H.reconnects}, stale ${H.staleReconnects}, err ${H.errors})`);
    const downMs = H.totalDownMs + (H.downSince ? now - H.downSince : 0);
    try { logFeedEvent("binance", s, why, { reconnects: H.reconnects, staleReconnects: H.staleReconnects, errors: H.errors, downMs }); } catch {}
  };

  const applyTrade = (data, slot) => {
    const asset = assetFromBinanceSymbol(data?.s);
    if (!asset) return;
    const price = Number(data.p);
    if (!Number.isFinite(price) || price <= 0) return;
    const tradeTs = Number(data.T);
    state[slot][asset] = { value: price, payloadTs: tradeTs > 0 ? tradeTs : null, recvTs: Date.now() };
    lastDataTs = Date.now();     // feed is alive
    H.lastDataTs = lastDataTs;
    reconnectDelay = 2500;       // healthy again → reset the reconnect backoff
    if (H.status !== "live") setStatus("live", "trades resumed");
  };

  const handle = (txt) => {
    let msg;
    try { msg = JSON.parse(txt); } catch { return; }
    const stream = msg?.stream, data = msg?.data;
    if (typeof stream !== "string" || !data) return;
    if (stream.endsWith("@aggTrade")) applyTrade(data, "binance");
  };

  const url = () => {
    const subs = [];
    for (const a of assets) {
      const s = BINANCE_SYM[a];
      if (s) subs.push(`${s}@aggTrade`);
    }
    return `${config.binanceWsUrl}/stream?streams=${subs.join("/")}`;
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url());
    ws.on("open", () => {
      console.log(`[binance] connected (${assets.join(",")})`);
      H.connects++; H.connectedSince = Date.now(); setStatus("live", "connected");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { if (ws?.readyState === WebSocket.OPEN) ws.ping(); } catch {} }, 60000);
      // STALE WATCHDOG: socket can stay OPEN while trades stop arriving (silent stick). If no fresh
      // trade for staleMs, force a reconnect (terminate → 'close' → reconnect).
      lastDataTs = Date.now();
      const staleMs = config.binanceQuoteStaleReconnectMs;
      clearInterval(staleTimer);
      staleTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN && Date.now() - lastDataTs > staleMs) {
          H.staleReconnects++; setStatus("stale", `no trades ${Math.round((Date.now() - lastDataTs) / 1000)}s`);
          try { ws.terminate(); } catch { try { ws.close(); } catch {} }
        }
      }, Math.max(5000, Math.floor(staleMs / 3)));
    });
    ws.on("message", (b) => handle(b.toString()));
    ws.on("ping", (d) => { try { ws.pong(d); } catch {} });
    ws.on("close", () => {
      clearInterval(pingTimer); pingTimer = null;
      clearInterval(staleTimer); staleTimer = null; ws = null;
      if (!stopped) {   // reconnect forever, with capped backoff so a sustained outage doesn't hammer Binance
        H.reconnects++; if (H.status === "live") setStatus("down", "socket closed");
        const d = reconnectDelay; reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
        setTimeout(connect, d);
      }
    });
    ws.on("error", (e) => { H.errors++; H.lastError = (e && e.message) || String(e); setStatus("down", "ws error"); try { ws?.close(); } catch {} });
  };

  connect();
  return () => { stopped = true; clearInterval(pingTimer); clearInterval(staleTimer); try { ws?.close(); } catch {} };
}
