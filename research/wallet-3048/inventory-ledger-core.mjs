const EPS = 1e-9;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 8) => Number.isFinite(value) ? +value.toFixed(digits) : null;

export function emptyInventory() {
  return {
    upShares: 0,
    downShares: 0,
    upNotional: 0,
    downNotional: 0,
    upCost: 0,
    downCost: 0,
  };
}

const dataWord = (data, index) => {
  const raw = String(data || "");
  const word = raw.slice(2 + index * 64, 2 + (index + 1) * 64);
  return word.length === 64 ? BigInt(`0x${word}`) : null;
};

/** Decode exact target-order fills from Exchange OrderFilled receipt logs. */
export function decodeTargetReceiptFills(receipt, wallet) {
  const normalized = String(wallet || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return [];
  const makerTopic = `0x${"0".repeat(24)}${normalized.slice(2)}`;
  const rows = [];
  for (const log of receipt?.logs || []) {
    if (log?.topics?.length !== 4
      || String(log.topics[2] || "").toLowerCase() !== makerTopic
      || String(log.data || "").length < 2 + 5 * 64) continue;
    const makerAsset = dataWord(log.data, 0);
    const takerAsset = dataWord(log.data, 1);
    const makerFilled = dataWord(log.data, 2);
    const takerFilled = dataWord(log.data, 3);
    const fee = dataWord(log.data, 4);
    if ([makerAsset, takerAsset, makerFilled, takerFilled, fee].some((value) => value == null)) continue;
    const isBuy = makerAsset === 0n;
    const tokenId = (isBuy ? takerAsset : makerAsset).toString();
    const shares = Number(isBuy ? takerFilled : makerFilled) / 1e6;
    const notional = Number(isBuy ? makerFilled : takerFilled) / 1e6;
    rows.push({
      orderHash: String(log.topics[1] || "").toLowerCase(),
      isBuy,
      tokenId,
      shares,
      notional,
      fee: Number(fee) / 1e6,
      allInCost: notional + Number(fee) / 1e6,
      logIndex: Number.parseInt(log.logIndex || "0x0", 16),
    });
  }
  return rows;
}

export function inventorySnapshot(state, winner = null) {
  const upShares = finite(state?.upShares);
  const downShares = finite(state?.downShares);
  const upNotional = finite(state?.upNotional);
  const downNotional = finite(state?.downNotional);
  const upCost = finite(state?.upCost);
  const downCost = finite(state?.downCost);
  const totalCost = upCost + downCost;
  const ifUp = upShares - totalCost;
  const ifDown = downShares - totalCost;
  const pairedShares = Math.min(upShares, downShares);
  const lean = upShares - downShares;
  return {
    upShares: round(upShares),
    downShares: round(downShares),
    lean: round(lean),
    absLean: round(Math.abs(lean)),
    upNotional: round(upNotional),
    downNotional: round(downNotional),
    upCost: round(upCost),
    downCost: round(downCost),
    totalNotional: round(upNotional + downNotional),
    totalCost: round(totalCost),
    fees: round(totalCost - upNotional - downNotional),
    averageUp: upShares > EPS ? round(upNotional / upShares) : null,
    averageDown: downShares > EPS ? round(downNotional / downShares) : null,
    allInAverageUp: upShares > EPS ? round(upCost / upShares) : null,
    allInAverageDown: downShares > EPS ? round(downCost / downShares) : null,
    grossAveragePairCost: upShares > EPS && downShares > EPS
      ? round(upNotional / upShares + downNotional / downShares) : null,
    allInAveragePairCost: upShares > EPS && downShares > EPS
      ? round(upCost / upShares + downCost / downShares) : null,
    pairedShares: round(pairedShares),
    residualSide: Math.abs(lean) <= EPS ? null : lean > 0 ? "Up" : "Down",
    residualShares: round(Math.abs(lean)),
    payoutUp: round(upShares),
    payoutDown: round(downShares),
    guaranteedPayout: round(pairedShares),
    ifUp: round(ifUp),
    ifDown: round(ifDown),
    worstCaseProfit: round(Math.min(ifUp, ifDown)),
    bestCaseProfit: round(Math.max(ifUp, ifDown)),
    actualPnl: winner === "Up" ? round(ifUp) : winner === "Down" ? round(ifDown) : null,
  };
}

/**
 * Apply one exact on-chain parent-order execution to the inventory ledger.
 * The reverse calculation deliberately uses only cumulative shares/averages:
 *   q = Q1-Q0, p = (Q1*A1-Q0*A0)/q.
 */
export function applyParentExecution(state, event, winner = null) {
  const before = inventorySnapshot(state, winner);
  const side = event?.outcome === "Down" ? "Down" : "Up";
  const shares = Math.max(0, finite(event?.shares));
  const notional = Math.max(0, finite(event?.notional));
  const fee = Math.max(0, finite(event?.fee));
  const allInCost = Number.isFinite(Number(event?.allInCost))
    ? Math.max(0, Number(event.allInCost)) : notional + fee;

  if (side === "Up") {
    state.upShares = finite(state.upShares) + shares;
    state.upNotional = finite(state.upNotional) + notional;
    state.upCost = finite(state.upCost) + allInCost;
  } else {
    state.downShares = finite(state.downShares) + shares;
    state.downNotional = finite(state.downNotional) + notional;
    state.downCost = finite(state.downCost) + allInCost;
  }
  const after = inventorySnapshot(state, winner);
  const beforeShares = side === "Up" ? before.upShares : before.downShares;
  const afterShares = side === "Up" ? after.upShares : after.downShares;
  const beforeAverage = side === "Up" ? before.averageUp : before.averageDown;
  const afterAverage = side === "Up" ? after.averageUp : after.averageDown;
  const beforeSideNotional = beforeShares * (beforeAverage ?? 0);
  const afterSideNotional = afterShares * (afterAverage ?? 0);
  const reverseShares = afterShares - beforeShares;
  const reversePrice = reverseShares > EPS
    ? (afterSideNotional - beforeSideNotional) / reverseShares : null;

  return {
    ...event,
    outcome: side,
    shares: round(shares),
    notional: round(notional),
    fee: round(fee),
    allInCost: round(allInCost),
    vwap: shares > EPS ? round(notional / shares) : null,
    before,
    after,
    delta: {
      upShares: round(after.upShares - before.upShares),
      downShares: round(after.downShares - before.downShares),
      lean: round(after.lean - before.lean),
      pairedShares: round(after.pairedShares - before.pairedShares),
      cost: round(after.totalCost - before.totalCost),
      payoutUp: round(after.payoutUp - before.payoutUp),
      payoutDown: round(after.payoutDown - before.payoutDown),
      ifUp: round(after.ifUp - before.ifUp),
      ifDown: round(after.ifDown - before.ifDown),
      worstCaseProfit: round(after.worstCaseProfit - before.worstCaseProfit),
    },
    reverseCalculation: {
      shares: round(reverseShares),
      price: round(reversePrice),
      shareError: round(reverseShares - shares),
      priceError: shares > EPS ? round(reversePrice - notional / shares) : null,
    },
  };
}

export function buildInventoryLedger(events, winner = null) {
  const ordered = [...(events || [])].sort((a, b) =>
    finite(a.executionTimestamp) - finite(b.executionTimestamp)
    || String(a.transactionHash || "").localeCompare(String(b.transactionHash || ""))
    || String(a.orderHash || "").localeCompare(String(b.orderHash || "")));
  const countsBySecond = new Map();
  for (const event of ordered) {
    const timestamp = finite(event.executionTimestamp);
    countsBySecond.set(timestamp, (countsBySecond.get(timestamp) || 0) + 1);
  }
  const state = emptyInventory();
  const rows = ordered.map((event, index) => applyParentExecution(state, {
    ...event,
    sequence: index + 1,
    sameSecondExecutions: countsBySecond.get(finite(event.executionTimestamp)) || 1,
    sequenceAmbiguous: (countsBySecond.get(finite(event.executionTimestamp)) || 1) > 1,
  }, winner));
  return { rows, final: inventorySnapshot(state, winner) };
}

const CHECKPOINT_SCALES = {
  upShares: .1,
  downShares: .1,
  averageUp: .001,
  averageDown: .001,
  totalCost: .01,
  ifUp: .01,
  ifDown: .01,
};

/** Match a delayed UI/API checkpoint by its inventory vector, never by cursor time. */
export function matchInventoryCheckpoint(ledgerRows, checkpoint) {
  const supplied = Object.keys(CHECKPOINT_SCALES).filter((key) => Number.isFinite(Number(checkpoint?.[key])));
  if (!supplied.length || !(ledgerRows || []).length) return null;
  let best = null;
  for (const row of ledgerRows) {
    const residuals = {};
    let normalizedError = 0;
    for (const key of supplied) {
      const residual = Number(row.after?.[key]) - Number(checkpoint[key]);
      residuals[key] = round(residual);
      normalizedError += Math.abs(residual) / CHECKPOINT_SCALES[key];
    }
    const score = normalizedError / supplied.length;
    if (!best || score < best.score) best = { row, score, residuals };
  }
  const displayT = Number(checkpoint?.displayTInto);
  return {
    sequence: best.row.sequence,
    executionTInto: best.row.tInto,
    executionTimestamp: best.row.executionTimestamp,
    displayTInto: Number.isFinite(displayT) ? displayT : null,
    displayLagSeconds: Number.isFinite(displayT) && Number.isFinite(Number(best.row.tInto))
      ? round(displayT - Number(best.row.tInto)) : null,
    meanNormalizedError: round(best.score),
    exactAtDisplayedPrecision: best.score <= 1.05,
    residuals: best.residuals,
    state: best.row.after,
  };
}

const valueAtOrBefore = (ticks, t) => {
  let found = null;
  for (const tick of ticks || []) {
    if (finite(tick.t, Infinity) > t) break;
    found = tick;
  }
  return found;
};

const midpoint = (ask, bid) => Number.isFinite(Number(ask)) && Number.isFinite(Number(bid))
  ? (Number(ask) + Number(bid)) / 2 : Number.isFinite(Number(ask)) ? Number(ask)
    : Number.isFinite(Number(bid)) ? Number(bid) : null;

export function signalAt(capture, tInto, lookbackSeconds = 2.5) {
  if (!capture || !Number.isFinite(Number(tInto))) return null;
  const now = valueAtOrBefore(capture.ticks, Number(tInto));
  const prior = valueAtOrBefore(capture.ticks, Number(tInto) - lookbackSeconds);
  if (!now) return null;
  const upMid = midpoint(now.ua ?? now.upAsk, now.ub ?? now.upBid);
  const downMid = midpoint(now.da ?? now.dnAsk, now.db ?? now.dnBid);
  const priorUpMid = prior ? midpoint(prior.ua ?? prior.upAsk, prior.ub ?? prior.upBid) : null;
  const priorDownMid = prior ? midpoint(prior.da ?? prior.dnAsk, prior.db ?? prior.dnBid) : null;
  const bz = Number(now.bz), priorBz = Number(prior?.bz), cl = Number(now.cl), priorCl = Number(prior?.cl);
  return {
    observedT: round(finite(now.t)),
    lookbackSeconds,
    binance: Number.isFinite(bz) ? round(bz) : null,
    binanceGap: Number.isFinite(bz) && Number.isFinite(Number(capture.openBz))
      ? round(bz - Number(capture.openBz)) : null,
    binanceMove: Number.isFinite(bz) && Number.isFinite(priorBz) ? round(bz - priorBz) : null,
    chainlink: Number.isFinite(cl) ? round(cl) : null,
    chainlinkGap: Number.isFinite(cl) && Number.isFinite(Number(capture.openCl))
      ? round(cl - Number(capture.openCl)) : null,
    chainlinkMove: Number.isFinite(cl) && Number.isFinite(priorCl) ? round(cl - priorCl) : null,
    upAsk: Number.isFinite(Number(now.ua ?? now.upAsk)) ? round(Number(now.ua ?? now.upAsk)) : null,
    downAsk: Number.isFinite(Number(now.da ?? now.dnAsk)) ? round(Number(now.da ?? now.dnAsk)) : null,
    upMid: round(upMid),
    downMid: round(downMid),
    upMidMove: Number.isFinite(upMid) && Number.isFinite(priorUpMid) ? round(upMid - priorUpMid) : null,
    downMidMove: Number.isFinite(downMid) && Number.isFinite(priorDownMid) ? round(downMid - priorDownMid) : null,
  };
}

export function summarizeLedger(slug, ledger, metadata = {}) {
  const rows = ledger?.rows || [];
  const sizes = new Map();
  for (const row of rows) {
    const size = finite(row.parentSignedShares, null);
    if (Number.isFinite(size)) sizes.set(String(round(size, 4)), (sizes.get(String(round(size, 4))) || 0) + 1);
  }
  const uniqueParents = new Set(rows.map((row) => row.orderHash).filter(Boolean));
  const signCrossings = rows.reduce((count, row) => {
    const a = Math.sign(row.before.lean), b = Math.sign(row.after.lean);
    return count + (a && b && a !== b ? 1 : 0);
  }, 0);
  const maxOf = (selector, fallback = null) => rows.length ? Math.max(...rows.map(selector)) : fallback;
  const minOf = (selector, fallback = null) => rows.length ? Math.min(...rows.map(selector)) : fallback;
  return {
    slug,
    winner: metadata.winner ?? null,
    executions: rows.length,
    parentOrders: uniqueParents.size,
    makerExecutions: rows.filter((row) => row.role === "maker").length,
    takerExecutions: rows.filter((row) => row.role === "taker").length,
    parentSizeAppearances: Object.fromEntries([...sizes]),
    firstExecutionS: rows.length ? round(rows[0].tInto) : null,
    lastExecutionS: rows.length ? round(rows.at(-1).tInto) : null,
    inventoryCrossings: signCrossings,
    maxAbsoluteLean: maxOf((row) => row.after.absLean, 0),
    minimumIfUp: minOf((row) => row.after.ifUp, 0),
    minimumIfDown: minOf((row) => row.after.ifDown, 0),
    minimumWorstCaseProfit: minOf((row) => row.after.worstCaseProfit, 0),
    maximumWorstCaseProfit: maxOf((row) => row.after.worstCaseProfit, 0),
    final: ledger?.final || inventorySnapshot(emptyInventory(), metadata.winner),
  };
}
