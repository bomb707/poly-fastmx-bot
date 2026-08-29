import { config, bapiKeyForUrl } from "../config/config.js";

export const now = () => Date.now();

/** Window start unix (seconds) that contains time `tSec`. */
export function windowStartFor(tSec) {
  return Math.floor(tSec / config.windowSec) * config.windowSec;
}
export function currentWindowStart() {
  return windowStartFor(Math.floor(Date.now() / 1000));
}
export function slugFor(windowStartUnix) {
  return `${config.asset}-updown-${config.interval}-${windowStartUnix}`;
}

export const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
export const sign = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Backtest-API health counters (shared across session fetches) ──────────────────────────────
// Surfaced in the session backtest UI instead of a bare progress bar: req/s, 429s, latency, quota.
const _api = {
  reqs: 0, ok: 0, fail: 0, http429: 0, http5xx: 0, timeouts: 0, retries: 0,
  lastMs: 0, sumMs: 0, nMs: 0,
  limit: null, remaining: null, reset: null,   // from X-RateLimit-* when present
  lastStatus: null, lastAt: 0,
};
export function apiHealth() {
  const avg = _api.nMs ? Math.round(_api.sumMs / _api.nMs) : null;
  return { ..._api, avgMs: avg };
}
export function resetApiHealth() {
  _api.reqs = _api.ok = _api.fail = _api.http429 = _api.http5xx = _api.timeouts = _api.retries = 0;
  _api.lastMs = _api.sumMs = _api.nMs = 0;
  _api.limit = _api.remaining = _api.reset = null;
  _api.lastStatus = null; _api.lastAt = 0;
}
function _noteHeaders(res) {
  const lim = res.headers.get("x-ratelimit-limit");
  const rem = res.headers.get("x-ratelimit-remaining");
  const rst = res.headers.get("x-ratelimit-reset");
  if (lim != null && lim !== "") _api.limit = Number(lim) || lim;
  if (rem != null && rem !== "") _api.remaining = Number(rem);
  if (rst != null && rst !== "") _api.reset = Number(rst) || rst;
}

/**
 * Fetch JSON with a browser UA (Polymarket REST 403s the default node UA).
 * RESILIENT: retries on rate-limit (429), transient 5xx, an HTML/non-JSON body (rate-limit pages), a timeout, or a
 *   network blip — with exponential backoff + jitter, respecting Retry-After. A real 4xx (e.g. 404) does NOT retry.
 *   This keeps range backtests (thousands of window fetches) from failing when the backtest API rate-limits.
 */
export async function getJson(url, timeoutMs = 15000, tries = 8) {
  const bk = bapiKeyForUrl(url);
  let lastErr;
  for (let attempt = 0; attempt <= tries; attempt++) {
    if (attempt > 0) {
      _api.retries++;
      await sleep(lastErr?.retryAfterMs ?? (Math.min(10000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250)));
    }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    let retry = false;
    const t0 = Date.now();
    _api.reqs++;
    try {
      const headers = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
      // Auth the polywinbot backtest API (v2/v3/v4) with the version-appropriate key (resolved by host). Scoped to the
      //   polywinbot host so the key is never sent to Polymarket / Binance / other endpoints.
      if (bk) { headers["X-API-Key"] = bk; headers.Authorization = `Bearer ${bk}`; }
      const res = await fetch(url, { signal: ctrl.signal, headers });
      _noteHeaders(res);
      _api.lastStatus = res.status;
      _api.lastAt = Date.now();
      const dt = Date.now() - t0;
      _api.lastMs = dt; _api.sumMs += dt; _api.nMs++;
      if (res.status === 429 || res.status >= 500) {   // rate-limited / transient → retry
        if (res.status === 429) _api.http429++; else _api.http5xx++;
        const ra = Number(res.headers.get("retry-after"));
        const raMs = Number(res.headers.get("retry-after-ms") || res.headers.get("x-ratelimit-retry-after-ms"));
        lastErr = Object.assign(new Error(`HTTP ${res.status} for ${url}`), {
          retryAfterMs: raMs > 0 ? raMs : (ra > 0 ? ra * 1000 : undefined),
        });
        retry = true;
      } else if (!res.ok) {
        _api.fail++;
        throw new Error(`HTTP ${res.status} for ${url}`);   // real 4xx → not retryable
      } else {
        const text = await res.text();
        try { _api.ok++; return JSON.parse(text); }
        catch { lastErr = new Error(`non-JSON response (rate-limit/HTML?) for ${url}`); retry = true; }   // HTML error page → retry
      }
    } catch (e) {
      if (e.name === "AbortError") { _api.timeouts++; lastErr = new Error(`timeout for ${url}`); retry = true; }
      else if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(e?.message || e))) { lastErr = e; retry = true; }
      else { _api.fail++; throw e; }   // non-retryable
    } finally {
      clearTimeout(to);
    }
    if (!retry) break;
  }
  _api.fail++;
  throw lastErr || new Error(`getJson failed for ${url}`);
}

/** clock HH:MM:SS for a unix-seconds value, UTC. */
export function hms(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(11, 19);
}
