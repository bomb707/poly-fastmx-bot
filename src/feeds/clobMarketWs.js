import WebSocket from "ws";
import { config } from "../config/config.js";
import { recordBook, recordDepth } from "../util/state.js";
import { MarketDepthBook } from "./marketDepthBook.js";

/**
 * Public CLOB "market" channel — best bid/ask per outcome token. We subscribe
 * to the current window's Up + Down token ids (and keep recently-closed ones so
 * late fills still resolve). Every update is also pushed into a per-token ring
 * buffer (state.bookHistory) so the tracker can read the book at a fill's
 * timestamp. Mirrors recorder/src/feeds/clobMarketWs.js + adds the buffer hook.
 *
 * @param {ReturnType<import('../util/state.js').createLiveState>} state
 * @param {() => string[]} getAssetIds  current token ids to subscribe to
 * @param {(assetId:string, bestBid:number|null, bestAsk:number|null, ts:number)=>void} [onBook]
 *        called on EVERY best_bid/ask update — lets the caller drive an event-driven consumer
 *        (the live shadow sim) off each book change rather than a fixed sampler.
 */
export function startClobMarketFeed(state, getAssetIds, onBook) {
  let ws = null;
  let stopped = false;
  let pingIv = null;
  let staleTimer = null;
  let lastDataMs = Date.now();   // last actual market payload (used by the trading freshness guard)
  let lastHeartbeatMs = Date.now();
  const heartbeatTimeoutMs = () => Math.max(30000, config.clobStaleReconnectMs);
  const sourceTimeMs = (message) => {
    const value = Number(message?.timestamp ?? message?.ts);
    if (!Number.isFinite(value)) return null;
    return value >= 1e12 ? value : value >= 1e9 ? value * 1000 : null;
  };

  const connect = () => {
    if (stopped) return;
    const depthBooks = new Map();
    const depthBook = (assetId) => {
      const id = String(assetId);
      let book = depthBooks.get(id);
      if (!book) { book = new MarketDepthBook(); depthBooks.set(id, book); }
      return book;
    };
    const publishDepth = (assetId, sourceTs, recvTs) => {
      const id = String(assetId || "");
      if (!id) return;
      const snapshot = depthBook(id).snapshot(12);
      if (!snapshot.synchronized) return;
      const depth = recordDepth(state, id, snapshot.asks, snapshot.bids, { sourceTs, recvTs });
      const bestBid = snapshot.bids[0]?.[0] ?? null;
      const bestAsk = snapshot.asks[0]?.[0] ?? null;
      state.bbaByToken.set(id, { bestBid, bestAsk, sourceTs, recvTs,
        depthEventId: depth.eventId });
      recordBook(state, id, bestBid, bestAsk, recvTs);
      if (onBook) { try { onBook(id, bestBid, bestAsk, recvTs); } catch {} }
    };
    ws = new WebSocket(config.polyClobWsUrl);
    ws.on("open", () => {
      lastHeartbeatMs = Date.now();
      const ids = [...new Set(getAssetIds())].filter(Boolean);
      if (ids.length) {
        // Do not expose a previous connection's cached quote as initialized on
        // this connection; the opening `book` snapshot will repopulate it.
        for (const id of ids) { state.bbaByToken.delete(String(id)); state.depthByToken.delete(String(id)); }
        ws.send(JSON.stringify({ assets_ids: ids, type: "market", custom_feature_enabled: true }));
        console.log(`[clob] subscribed ${ids.length} tokens`);
      }
      clearInterval(pingIv);
      // Polymarket's market-channel heartbeat is the TEXT message "PING", not a
      // WebSocket protocol ping frame. The server responds with text "PONG".
      pingIv = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
      // A quiet order book is valid. Reconnect only when the documented heartbeat
      // stops responding; market-data age remains available separately via isFresh().
      clearInterval(staleTimer);
      staleTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN && Date.now() - lastHeartbeatMs > heartbeatTimeoutMs()) {
          console.warn(`[clob] heartbeat silent for ${Math.round((Date.now() - lastHeartbeatMs) / 1000)}s → reconnecting`);
          try { ws.terminate(); } catch { try { ws.close(); } catch {} }
        }
      }, 5000);
    });
    ws.on("message", (buf) => {
      const txt = buf.toString();
      lastHeartbeatMs = Date.now();
      if (txt === "PONG") return;
      let msg;
      try { msg = JSON.parse(txt); } catch { return; }
      lastDataMs = Date.now();
      const rows = Array.isArray(msg) ? msg : [msg];
      for (const m of rows) {
        // Full order-book ladder → depth ring buffer (throttled in recordDepth).
        if (m?.event_type === "book") {
          const id = String(m.asset_id ?? "");
          if (!id) continue;
          depthBook(id).replace({ bids: m.bids, asks: m.asks });
          const recvTs = Date.now();
          publishDepth(id, sourceTimeMs(m), recvTs);
          continue;
        }
        if (m?.event_type === "price_change" && Array.isArray(m.price_changes)) {
          const changed = new Set();
          for (const change of m.price_changes) {
            const id = String(change?.asset_id ?? "");
            if (id && depthBook(id).apply(change)) changed.add(id);
          }
          const recvTs = Date.now(), sourceTs = sourceTimeMs(m);
          for (const id of changed) publishDepth(id, sourceTs, recvTs);
          continue;
        }
        // A tick-size change does not invalidate the current aggregated book.
        if (m?.event_type === "tick_size_change") continue;
        if (m?.event_type !== "best_bid_ask") continue;
        const assetId = String(m.asset_id ?? "");
        if (!assetId) continue;
        const bb = parseFloat(String(m.best_bid ?? ""));
        const ba = parseFloat(String(m.best_ask ?? ""));
        if (!Number.isFinite(bb) && !Number.isFinite(ba)) continue;
        const bestBid = Number.isFinite(bb) ? bb : null;
        const bestAsk = Number.isFinite(ba) ? ba : null;
        const recvTs = Date.now(), sourceTs = sourceTimeMs(m);
        state.bbaByToken.set(assetId, { bestBid, bestAsk, sourceTs, recvTs });
        recordBook(state, assetId, bestBid, bestAsk, recvTs);
        if (onBook) { try { onBook(assetId, bestBid, bestAsk, recvTs); } catch {} }
      }
    });
    ws.on("close", () => {
      clearInterval(pingIv); pingIv = null; clearInterval(staleTimer); staleTimer = null; ws = null;
      if (!stopped) setTimeout(connect, 2500);
    });
    ws.on("error", () => ws?.close());
  };

  connect();
  return {
    stop: () => { stopped = true; clearInterval(pingIv); clearInterval(staleTimer); ws?.close(); },
    // Close so the next open re-sends an updated assets_ids list (window rollover).
    resubscribe: () => { try { ws?.close(); } catch {} },
    // Market-data freshness (heartbeats intentionally do not make a stale book tradable).
    isFresh: (ms = config.clobStaleReconnectMs) => Date.now() - lastDataMs < ms,
    // Connection health follows the documented text PING/PONG heartbeat. A quiet
    // delta book can remain fully current even when no price level changes.
    isAlive: () => ws?.readyState === WebSocket.OPEN && Date.now() - lastHeartbeatMs <= heartbeatTimeoutMs(),
    heartbeatAgeMs: () => Date.now() - lastHeartbeatMs,
  };
}
