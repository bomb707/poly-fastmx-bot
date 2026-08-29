/**
 * Authoritative window resolution via Polymarket's OWN crypto-price settlement API — the same
 * Chainlink-index source Polymarket actually settles on. Ported from meridian-system/bot poly_resolve.js.
 *
 *   GET https://polymarket.com/api/crypto/crypto-price
 *         ?symbol=BTC&variant=fiveminute
 *         &eventStartTime=<ISO windowStart>&endDate=<ISO windowEnd>
 *   → { openPrice, closePrice, completed, ... }
 *
 * KEY: `completed` is false (and closePrice null) until the window has ACTUALLY resolved on-chain. So
 * winSide stays null → the caller keeps the window "pending" and the lifecycle poll retries. Only once
 * Polymarket reports completed do we compute the winner from open vs close. This replaces the old
 * local-bapi `winSide` (which could lag or disagree with Polymarket's real settlement).
 */

const POLY_BASE = (process.env.POLY_CRYPTO_PRICE_BASE || "https://polymarket.com/api/crypto/crypto-price").replace(/\/+$/, "");
const VARIANT_BY_WINSEC = { 300: "fiveminute", 900: "fifteenminute" };
const UP_WINS_ON_TIE = String(process.env.BTC_UP_WINS_ON_TIE ?? "true").toLowerCase() !== "false";
// BTC/ETH Up/Down now settle on Chainlink's 60-second TWAP (btc-usd-twap-60s-streams). Both 5m and 15m use the
// 60s lookback. WITHOUT these flags the endpoint returns the non-TWAP reference pair, which around a tight close
// can imply the OPPOSITE side from Gamma's official outcome — so winSide could be recorded wrong. See screenshot.
const TWAP_LOOKBACK_SECONDS = 60;
// Match poly-mom-bot: Polymarket's crypto-price backfill can still change in
// the first few seconds of a window. Keep the boundary RTDS value provisional
// and do not make the first authoritative API request until this delay passes.
const parsedOpenDelaySec = Number(process.env.OPEN_PRICE_FETCH_DELAY_SEC ?? 10);
const OPEN_PRICE_FETCH_DELAY_MS = Math.max(0, Number.isFinite(parsedOpenDelaySec) ? parsedOpenDelaySec : 10) * 1000;
const CACHE_MS = 5000;          // re-poll an unresolved window at most this often
const BACKOFF_429_MS = Number(process.env.POLY_RESOLVE_429_BACKOFF_MS || 60000);

const isoNoMs = (sec) => new Date(Number(sec) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Settlement follows the row's slug, even after the dashboard hot-switches markets. */
export function marketSpecFromSlug(slug) {
  const match = String(slug || "").match(/^([a-z0-9]+)-updown-(5m|15m)-(\d+)$/i);
  if (!match) return null;
  return { asset: match[1].toLowerCase(), interval: match[2].toLowerCase(),
    windowSec: match[2].toLowerCase() === "15m" ? 900 : 300, windowStart: Number(match[3]) };
}

function buildUrl(asset, windowStartSec, winSec) {
  const ws2 = Number(winSec) === 900 ? 900 : 300;
  const u = new URL(POLY_BASE);
  u.searchParams.set("symbol", String(asset).toUpperCase());
  u.searchParams.set("eventStartTime", isoNoMs(windowStartSec));
  u.searchParams.set("variant", VARIANT_BY_WINSEC[ws2] || "fiveminute");
  u.searchParams.set("endDate", isoNoMs(Number(windowStartSec) + ws2));
  // Required on every request: read the 60-second TWAP settlement pair, never the raw reference pair.
  u.searchParams.set("twapEnabled", "true");
  u.searchParams.set("twapLookbackSeconds", String(TWAP_LOOKBACK_SECONDS));
  return u.toString();
}

/** Winner "Up" | "Down" | null from the chainlink open/close pair. */
function winnerFromOpenClose(open, close) {
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) return null;
  if (close > open) return "Up";
  if (close < open) return "Down";
  return UP_WINS_ON_TIE ? "Up" : "Down";   // exact tie → house convention
}

/** True once Polymarket's delayed window-open backfill is ready to be consumed. */
function polyOpenFetchReady(windowStartSec, nowMs = Date.now()) {
  const ws = Number(windowStartSec);
  return Number.isFinite(ws) && Number(nowMs) >= ws * 1000 + OPEN_PRICE_FETCH_DELAY_MS;
}

const _cache = new Map();     // slug → { data, ms }   (resolved data cached forever; unresolved briefly)
let _backoffUntil = 0;        // global 429 cool-off

/**
 * Open/final/winSide for a slug. Same shape the tracker expects, PLUS `completed`. winSide is null
 * (window "pending") until Polymarket settles. openBinance is null here — the live feed supplies it.
 */
export async function fetchResolution(slug) {
  const empty = { openPrice: null, finalPrice: null, openBinance: null, winSide: null, completed: false };
  const spec = marketSpecFromSlug(slug);
  const ws = spec?.windowStart;
  if (!spec || !Number.isFinite(ws)) return empty;
  const now = Date.now();
  // Do not fetch and cache the endpoint's early, still-refining open. The
  // RTDS boundary sample remains provisional until the same t+10s point used
  // by poly-mom-bot, after which the first valid API value becomes stable.
  if (!polyOpenFetchReady(ws, now)) return empty;
  const cached = _cache.get(slug);
  if (cached && (cached.data.completed || now - cached.ms < CACHE_MS)) return cached.data;   // fresh / already-settled
  if (now < _backoffUntil) return cached?.data || empty;                                     // rate-limited — hold

  let d;
  try {
    const res = await fetch(buildUrl(spec.asset, ws, spec.windowSec), { signal: AbortSignal.timeout(12000) });
    if (res.status === 429) { _backoffUntil = now + Math.max(BACKOFF_429_MS, 15000); return cached?.data || empty; }
    if (!res.ok) return cached?.data || empty;
    d = await res.json();
  } catch { return cached?.data || empty; }

  const open = Number(d?.openPrice), close = Number(d?.closePrice);
  const settled = !!d?.completed && Number.isFinite(close) && close > 0;
  const out = {
    openPrice: Number.isFinite(open) && open > 0 ? open : null,
    finalPrice: settled ? close : null,
    openBinance: null,                                        // Polymarket has no binance; feed provides it
    winSide: settled ? winnerFromOpenClose(open, close) : null,
    completed: settled,
  };
  _cache.set(slug, { data: out, ms: now });
  return out;
}

export { winnerFromOpenClose, buildUrl as buildPolyCryptoUrl, polyOpenFetchReady };
