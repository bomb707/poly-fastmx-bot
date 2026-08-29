import WebSocket from "ws";
import { config } from "../config/config.js";

/**
 * Private CLOB "user" channel — real-time lifecycle of OUR OWN orders/trades (auth'd with the derived L2 API
 * creds). Every placement / update / cancellation / match is PUSHED here, each carrying price + size_matched,
 * so the Order Status panel can show the play-by-play WITHOUT waiting on the 1.5s reconcile poll.
 *
 * DISPLAY-ONLY by design: the reconcile poll remains the single money-booking source (onDelta → real ledger),
 * so nothing here can double-count. This feed only emits STATUS transitions (order + on-chain trade) with the
 * price/shares attached.
 *
 * Message shapes (Polymarket CLOB user channel):
 *   order: { event_type:"order", id, market, asset_id, side, price, original_size, size_matched, status, type }
 *          type ∈ PLACEMENT | UPDATE | CANCELLATION ; status ∈ LIVE | MATCHED | CANCELED | ...
 *   trade: { event_type:"trade", id, taker_order_id, maker_orders:[{order_id,matched_amount,price}],
 *          market, asset_id, price, size, side, status }  status ∈ MATCHED | MINED | CONFIRMED | RETRYING | FAILED
 *
 * @param {() => {apiKey:string,secret:string,passphrase:string}|null} getCreds  derived L2 creds (null until live-ready)
 * @param {() => string[]} getMarkets  current condition ids to subscribe to (window rollover → resubscribe)
 * @param {{ onOrder?: (o)=>void, onTrade?: (t)=>void }} handlers
 */
export function startClobUserFeed(getCreds, getMarkets, { onOrder, onTrade } = {}) {
  const userUrl = String(config.polyClobWsUrl || "").replace(/\/market\/?$/, "/user");
  let ws = null, stopped = false, pingIv = null, staleTimer = null;
  let lastDataMs = Date.now();

  const num = (v) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };

  const connect = () => {
    if (stopped) return;
    const creds = getCreds && getCreds();
    if (!creds || !creds.apiKey) { setTimeout(connect, 3000); return; }   // not live-ready yet → retry
    const markets = [...new Set((getMarkets && getMarkets()) || [])].filter(Boolean);
    ws = new WebSocket(userUrl);
    ws.on("open", () => {
      lastDataMs = Date.now();
      ws.send(JSON.stringify({ auth: { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase }, markets, type: "user" }));
      console.log(`[clob-user] subscribed ${markets.length} market(s)`);
      clearInterval(pingIv);
      pingIv = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 10000);
      const staleMs = config.clobStaleReconnectMs;
      clearInterval(staleTimer);
      staleTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN && Date.now() - lastDataMs > staleMs) {
          console.warn(`[clob-user] no data for ${Math.round((Date.now() - lastDataMs) / 1000)}s (STALE) → reconnecting`);
          try { ws.terminate(); } catch { try { ws.close(); } catch {} }
        }
      }, Math.max(3000, Math.floor(staleMs / 3)));
    });
    ws.on("pong", () => { lastDataMs = Date.now(); });
    ws.on("message", (buf) => {
      lastDataMs = Date.now();
      const txt = buf.toString();
      if (txt === "PONG") return;
      let msg; try { msg = JSON.parse(txt); } catch { return; }
      const rows = Array.isArray(msg) ? msg : [msg];
      for (const m of rows) {
        const et = m?.event_type;
        if (et === "order" && onOrder) {
          try {
            onOrder({
              orderId: String(m.id ?? m.order_id ?? ""),
              status: String(m.status ?? "").toUpperCase(),   // LIVE | MATCHED | CANCELED | ...
              changeType: String(m.type ?? "").toUpperCase(), // PLACEMENT | UPDATE | CANCELLATION
              price: num(m.price),
              matched: num(m.size_matched),
              orig: num(m.original_size),
              side: String(m.side ?? ""),
              ts: Date.now(),
            });
          } catch {}
        } else if (et === "trade" && onTrade) {
          // A trade can involve us as the taker (taker_order_id) AND/OR as a maker (maker_orders[]). Report each
          // of OUR order ids that participated, with the slice's price/size, so the panel can attribute per order.
          try {
            const status = String(m.status ?? "").toUpperCase();
            const legs = [];
            if (m.taker_order_id) legs.push({ orderId: String(m.taker_order_id), price: num(m.price), size: num(m.size) });
            if (Array.isArray(m.maker_orders)) for (const mo of m.maker_orders) if (mo?.order_id) legs.push({ orderId: String(mo.order_id), price: num(mo.price), size: num(mo.matched_amount) });
            for (const lg of legs) onTrade({ ...lg, status, tradeId: String(m.id ?? ""), ts: Date.now() });
          } catch {}
        }
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
    stop: () => { stopped = true; clearInterval(pingIv); clearInterval(staleTimer); try { ws?.close(); } catch {} },
    resubscribe: () => { try { ws?.close(); } catch {} },   // close → reopen re-sends the current markets list
    isFresh: (ms = config.clobStaleReconnectMs) => Date.now() - lastDataMs < ms,
  };
}
