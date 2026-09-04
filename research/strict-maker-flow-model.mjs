import { MATCH_ORDERS_IFACE } from "./signed-orders.mjs";

const lower = (value) => String(value || "").toLowerCase();
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

/**
 * The public Data API reports integer-second timestamps. Treat each timestamp
 * as an interval, not as an exact instant. A trade is causally usable for an
 * order only when that entire interval is contained inside the order's live
 * interval.
 */
export function publicTradeInterval(trade) {
  const endMs = Number(trade?.intervalEndMs ?? trade?.ms);
  const startMs = Number(trade?.intervalStartMs ?? (endMs - 1_000));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

export function intervalFullyInsideOrder(order, tradeOrInterval) {
  const interval = Object.hasOwn(tradeOrInterval || {}, "startMs")
    ? tradeOrInterval : publicTradeInterval(tradeOrInterval);
  if (!interval) return false;
  return interval.startMs + 1e-9 >= Number(order?.effectiveArrivalMs)
    && interval.endMs <= Number(order?.expiresMs) + 1e-9;
}

/**
 * Decode the exact resting maker legs from a CLOB V2 matchOrders transaction.
 * matchOrders calldata contains one fill amount per maker order, so a receipt
 * or on-chain block timestamp is unnecessary. The signed timestamp is ignored.
 */
export function decodeMakerLegsFromTransaction(transaction) {
  const input = String(transaction?.input || transaction?.data || "");
  if (!input.startsWith("0x") || input.length <= 10) {
    return { status: "unsupported", reason: "missing-input", makerLegs: [] };
  }
  let parsed;
  try { parsed = MATCH_ORDERS_IFACE.parseTransaction({ data: input }); }
  catch { return { status: "unsupported", reason: "not-matchOrders-v2", makerLegs: [] }; }
  if (!parsed || parsed.name !== "matchOrders") {
    return { status: "unsupported", reason: "not-matchOrders-v2", makerLegs: [] };
  }
  const orders = Array.from(parsed.args[2] || []);
  const fills = Array.from(parsed.args[4] || []);
  if (orders.length !== fills.length) {
    return { status: "invalid", reason: "maker-order-fill-length-mismatch", makerLegs: [] };
  }
  const makerLegs = [];
  for (let index = 0; index < orders.length; index++) {
    const tuple = orders[index];
    const makerAmount = Number(tuple[4]);
    const takerAmount = Number(tuple[5]);
    const makerFilled = Number(fills[index]);
    const isBuy = Number(tuple[6]) === 0;
    if (!finitePositive(makerAmount) || !finitePositive(takerAmount) || !finitePositive(makerFilled)) continue;
    const price = isBuy ? makerAmount / takerAmount : takerAmount / makerAmount;
    const shares = isBuy ? makerFilled / price / 1e6 : makerFilled / 1e6;
    if (!(price > 0 && price < 1) || !(shares > 0)) continue;
    makerLegs.push({
      tupleIndex: index,
      tokenId: String(tuple[3]),
      makerAddress: lower(tuple[1]),
      isBuy,
      price,
      shares,
    });
  }
  return { status: "decoded", makerLegs };
}

/**
 * Convert a signed maker leg into the economic BUY queue it consumes. A SELL
 * on one outcome is the mirrored BUY queue on the complementary outcome.
 */
export function economicBuyFlow(makerLeg, { upToken, downToken }) {
  const tokenId = String(makerLeg?.tokenId || "");
  const tokenOutcome = tokenId === String(upToken || "") ? "Up"
    : tokenId === String(downToken || "") ? "Down" : null;
  if (!tokenOutcome || !(Number(makerLeg?.shares) > 0)) return null;
  if (makerLeg.isBuy === true) {
    return { outcome: tokenOutcome, price: Number(makerLeg.price), size: Number(makerLeg.shares) };
  }
  return {
    outcome: tokenOutcome === "Up" ? "Down" : "Up",
    price: 1 - Number(makerLeg.price),
    size: Number(makerLeg.shares),
  };
}

export function exactPriceMatches(left, right, tolerance = 1e-7) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}
