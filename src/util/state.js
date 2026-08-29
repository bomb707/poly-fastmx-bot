import { config } from "../config/config.js";

const emptySpot = () => ({ value: null, payloadTs: null, recvTs: 0 });

/**
 * Shared live state written by the feeds, read by the tracker/dashboard.
 *  - binance / chainlink: latest price per asset (Binance = @aggTrade; Chainlink = RTDS TWAP-60)
 *  - bbaByToken: latest best bid/ask per CLOB token id
 *  - depthByToken: unthrottled current L2 snapshot for live strategy decisions
 *  - bookHistory: ring buffer of {ts,bestBid,bestAsk} per token, so we can
 *    reconstruct the order book at a (lagged) fill timestamp.
 */
const emptyFeedHealth = () => ({
  status: "init",       // init | live | stale | down
  lastDataTs: 0,        // last FRESH trade applied
  connectedSince: 0,    // ws open time of the current connection
  connects: 0,          // successful opens
  reconnects: 0,        // close→reconnect cycles
  staleReconnects: 0,   // watchdog-forced reconnects (socket open but no trades)
  errors: 0,            // ws 'error' events
  lastError: null,      // last error message
  downSince: 0,         // when the feed went not-live (0 = currently live)
  totalDownMs: 0,       // cumulative downtime this run
  lastChangeTs: 0,      // last status transition (for the UI)
});

export function createLiveState() {
  const assets = ["btc", "eth", "sol", "xrp"];
  return {
    binance: Object.fromEntries(assets.map((a) => [a, emptySpot()])),
    chainlink: Object.fromEntries(assets.map((a) => [a, emptySpot()])),   // Chainlink TWAP-60 settlement series

    binanceHealth: emptyFeedHealth(),   // @aggTrade feed health — tracked by binanceSpotWs, surfaced in the UI
    chainlinkHealth: emptyFeedHealth(), // (parallel; RTDS chainlink feed can wire the same way)
    bbaByToken: new Map(), // tokenId -> { bestBid, bestAsk, recvTs }
    depthByToken: new Map(), // tokenId -> { ts, asks:[[price,size]], bids:[[price,size]] } (latest, never throttled)
    bookHistory: new Map(), // tokenId -> [{ ts, bestBid, bestAsk }]
    depthHistory: new Map(), // tokenId -> [{ ts, asks:[[price,size]], bids:[[price,size]] }] (full ladder)
  };
}

/**
 * Drop ALL per-token state for tokens that are no longer tracked (their window rolled off). Without
 * this, bbaByToken/depthByToken/bookHistory/depthHistory accumulate one entry per token forever (2 new tokens every
 * window) → unbounded memory growth. Called periodically with the set of still-live token ids.
 * @returns {number} entries removed
 */
export function pruneTokens(state, keepSet) {
  let removed = 0;
  for (const m of [state.bbaByToken, state.depthByToken, state.bookHistory, state.depthHistory]) {
    for (const k of m.keys()) if (!keepSet.has(k)) { m.delete(k); removed++; }
  }
  return removed;
}

/** Push a depth (ladder) snapshot, throttled to ~250ms and trimmed by age. */
export function recordDepth(state, tokenId, asks, bids, ts) {
  state.depthByToken.set(tokenId, { ts, asks, bids });
  let buf = state.depthHistory.get(tokenId);
  if (!buf) { buf = []; state.depthHistory.set(tokenId, buf); }
  if (buf.length && ts - buf[buf.length - 1].ts < 250) return; // throttle
  buf.push({ ts, asks, bids });
  const cutoff = ts - config.bookBufferMs;
  while (buf.length && buf[0].ts < cutoff) buf.shift();
}

/** Depth snapshot at-or-before `ts` for a token (the ladder the order faced). */
export function depthAround(state, tokenId, ts) {
  const buf = state.depthHistory.get(tokenId);
  if (!buf || !buf.length) return null;
  let before = null;
  for (const s of buf) { if (s.ts <= ts) before = s; else break; }
  return before;
}

/** Push a book snapshot into the per-token ring buffer (trimmed by age). */
export function recordBook(state, tokenId, bestBid, bestAsk, ts) {
  let buf = state.bookHistory.get(tokenId);
  if (!buf) {
    buf = [];
    state.bookHistory.set(tokenId, buf);
  }
  const previous = buf.at(-1);
  // A depth-only update often leaves BBA unchanged. One identical heartbeat
  // per second is sufficient to retain a current at-or-before state while
  // bounding the fill-attribution ring buffer under native feed bursts.
  if (previous && previous.bestBid === bestBid && previous.bestAsk === bestAsk
    && ts - previous.ts < 1000) return;
  buf.push({ ts, bestBid, bestAsk });
  const cutoff = ts - config.bookBufferMs;
  while (buf.length && buf[0].ts < cutoff) buf.shift();
}

/** Book snapshot at-or-before `ts` (and the very next one after) for a token. */
export function bookAround(state, tokenId, ts) {
  const buf = state.bookHistory.get(tokenId);
  if (!buf || !buf.length) return { before: null, after: null };
  let before = null;
  let after = null;
  for (const s of buf) {
    if (s.ts <= ts) before = s;
    else {
      after = s;
      break;
    }
  }
  return { before, after };
}
