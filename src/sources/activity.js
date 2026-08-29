import { config } from "../config/config.js";
import { getJson } from "../util/util.js";

/**
 * Polls the bot's public activity feed and emits each NEW event once.
 * Captures every type: TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION.
 *
 * data-api /activity fields: type, side(BUY/SELL), outcome(Up/Down),
 * outcomeIndex, size(shares), usdcSize(USDC), price(VWAP), timestamp(sec),
 * slug, conditionId, asset(tokenId), transactionHash.
 *
 * @param {(ev: object) => void} onEvent
 */
export function startActivityPoller(onEvent) {
  const seen = new Set();
  let stopped = false;
  let timer = null;

  const key = (a) =>
    `${a.transactionHash}:${a.asset}:${a.side}:${a.type}:${a.timestamp}:${a.size}`;

  const poll = async () => {
    if (stopped) return;
    if (config.trackerDisabled) {   // tracker disabled → skip the wallet-activity fetch, keep the loop alive
      if (!stopped) timer = setTimeout(poll, Math.max(1000, config.activityPollMs));
      return;
    }
    try {
      // Wide-ish recent window; dedupe handles overlap. 'limit' only (no offset → 403).
      const url = `${config.dataApiHost}/activity?user=${config.wallet}&limit=200`;
      const rows = await getJson(url, 12000);
      if (Array.isArray(rows)) {
        // oldest first so position math applies in order
        const ordered = [...rows].sort((x, y) => x.timestamp - y.timestamp);
        for (const a of ordered) {
          const k = key(a);
          if (seen.has(k)) continue;
          seen.add(k);
          onEvent(a);
        }
        // keep the seen-set bounded
        if (seen.size > 5000) {
          const arr = [...seen];
          seen.clear();
          for (const k of arr.slice(-2000)) seen.add(k);
        }
      }
    } catch (e) {
      // transient network/API hiccup — keep polling
    } finally {
      if (!stopped) timer = setTimeout(poll, config.activityPollMs);
    }
  };

  poll();
  const stop = () => { stopped = true; clearTimeout(timer); };
  // Clear the dedup set so a wallet switch re-emits the new wallet's recent events fresh.
  stop.reset = () => seen.clear();
  return stop;
}
