import { config } from "../config/config.js";
import { getJson } from "../util/util.js";

/** Parse gamma's clobTokenIds (JSON-string array) → [upToken, downToken]. */
function parseTokenIds(raw) {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a market slug → { conditionId, upTokenId, downTokenId } via Gamma.
 * tokens[0] = Up, tokens[1] = Down (recorder convention).
 */
export async function resolveMarket(slug) {
  const url = `${config.gammaHost}/markets/slug/${encodeURIComponent(slug)}`;
  let m;
  try {
    m = await getJson(url);
  } catch {
    return null;
  }
  const market = Array.isArray(m) ? m[0] : m;
  const conditionId = typeof market?.conditionId === "string" ? market.conditionId : "";
  const tokens = parseTokenIds(market?.clobTokenIds);
  if (!conditionId || tokens.length < 2) return null;
  return {
    slug,
    conditionId,
    upTokenId: tokens[0],
    downTokenId: tokens[1],
    closed: Boolean(market?.closed),
  };
}
