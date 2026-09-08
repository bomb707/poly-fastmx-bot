const isBlank = (value) => typeof value === "string" && value.trim() === "";

export function finiteNumber(value) {
  return value !== null && value !== undefined && !isBlank(value)
    && Number.isFinite(Number(value));
}

export const validTimestamp = (value) => finiteNumber(value) && Number(value) > 0;
export const validPositive = (value) => finiteNumber(value) && Number(value) > 0;
export const validProbabilityPrice = (value) => finiteNumber(value)
  && Number(value) > 0 && Number(value) < 1;

const roundReport = (value) => finiteNumber(value) ? +Number(value).toFixed(8) : null;

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null;
  return { observed: sorted.length, p50Ms: roundReport(at(0.5)),
    p95Ms: roundReport(at(0.95)), maxMs: sorted.length ? roundReport(sorted.at(-1)) : null };
}

export function freshnessAtEvaluation(ticks, sourceKey, receiveKey, maximumMs) {
  const transport = [], sourceAge = [], receiveAge = [];
  let missingSource = 0, invalidSource = 0, missingReceive = 0, invalidReceive = 0;
  let missingEvaluation = 0, invalidEvaluation = 0, invalidClockOrder = 0;
  for (const tick of ticks) {
    const source = tick?.[sourceKey], receive = tick?.[receiveKey];
    const evaluation = tick?.evaluationAtMs ?? tick?.ms;
    if (source === null || source === undefined || isBlank(source)) missingSource++;
    else if (!validTimestamp(source)) invalidSource++;
    if (receive === null || receive === undefined || isBlank(receive)) missingReceive++;
    else if (!validTimestamp(receive)) invalidReceive++;
    if (evaluation === null || evaluation === undefined || isBlank(evaluation)) missingEvaluation++;
    else if (!validTimestamp(evaluation)) invalidEvaluation++;
    if (!validTimestamp(source) || !validTimestamp(receive) || !validTimestamp(evaluation)) continue;
    const sourceToReceive = Number(receive) - Number(source);
    const sourceToEvaluation = Number(evaluation) - Number(source);
    const receiveToEvaluation = Number(evaluation) - Number(receive);
    if (sourceToReceive < -1 || sourceToEvaluation < -1 || receiveToEvaluation < -1) {
      invalidClockOrder++;
      continue;
    }
    transport.push(Math.max(0, sourceToReceive));
    sourceAge.push(Math.max(0, sourceToEvaluation));
    receiveAge.push(Math.max(0, receiveToEvaluation));
  }
  const thresholdMs = Number(maximumMs);
  return { sourceKey, receiveKey, thresholdMs,
    missingSource, invalidSource, missingReceive, invalidReceive,
    missingEvaluation, invalidEvaluation, invalidClockOrder,
    receiveMinusSource: distribution(transport),
    evaluationMinusSource: { ...distribution(sourceAge),
      fresh: sourceAge.filter((age) => age <= thresholdMs).length,
      stale: sourceAge.filter((age) => age > thresholdMs).length },
    evaluationMinusLatestReceive: distribution(receiveAge) };
}

function parseLevel(row) {
  const price = Array.isArray(row) ? row[0] : row?.price;
  const quantity = Array.isArray(row) ? row[1] : row?.size;
  return validProbabilityPrice(price) && validPositive(quantity)
    ? { price: Number(price), quantity: Number(quantity) } : null;
}

export function inspectDepthBook(book) {
  const asksPresent = Array.isArray(book?.asks), bidsPresent = Array.isArray(book?.bids);
  const asks = asksPresent ? book.asks.map(parseLevel) : [];
  const bids = bidsPresent ? book.bids.map(parseLevel) : [];
  const invalidAskLevels = asks.filter((row) => row === null).length;
  const invalidBidLevels = bids.filter((row) => row === null).length;
  const validAsks = asks.filter(Boolean), validBids = bids.filter(Boolean);
  const sortedAsks = validAsks.every((row, index) => index === 0
    || row.price >= validAsks[index - 1].price);
  const sortedBids = validBids.every((row, index) => index === 0
    || row.price <= validBids[index - 1].price);
  const usable = book?.depthValid !== false && asksPresent && bidsPresent
    && validAsks.length > 0 && validBids.length > 0
    && invalidAskLevels === 0 && invalidBidLevels === 0 && sortedAsks && sortedBids;
  return { arraysPresent: asksPresent && bidsPresent, usable,
    askLevels: validAsks.length, bidLevels: validBids.length,
    invalidAskLevels, invalidBidLevels, sortedAsks, sortedBids };
}

const SOURCE_CLOCKS = [
  ["binance", "binanceAtMs", "binanceReceivedAtMs", "W3048_BINANCE_STALE_MS"],
  ["chainlink", "chainlinkAtMs", "chainlinkReceivedAtMs", "W3048_CHAINLINK_STALE_MS"],
  ["upQuote", "upQuoteAtMs", "upQuoteReceivedAtMs", "W3048_DEPTH_STALE_MS"],
  ["downQuote", "downQuoteAtMs", "downQuoteReceivedAtMs", "W3048_DEPTH_STALE_MS"],
  ["upDepth", "upDepthAtMs", "upDepthReceivedAtMs", "W3048_DEPTH_STALE_MS"],
  ["downDepth", "downDepthAtMs", "downDepthReceivedAtMs", "W3048_DEPTH_STALE_MS"],
];

export function buildRecorderInstrumentation(data, cfg = {}) {
  const ticks = Array.isArray(data?.ticks) ? data.ticks : [];
  const sequenceValues = ticks.map((tick) => finiteNumber(tick?.sequence)
    && Number.isInteger(Number(tick.sequence)) ? Number(tick.sequence) : null);
  let sequenceGaps = 0;
  for (let index = 0; index < sequenceValues.length; index++) {
    if (sequenceValues[index] !== index + 1) sequenceGaps++;
  }
  const monotonicEvaluationClock = ticks.every((tick, index) => index === 0
    || (validTimestamp(tick?.ms) && validTimestamp(ticks[index - 1]?.ms)
      && Number(tick.ms) >= Number(ticks[index - 1].ms)));
  const canonicalTicks = ticks.filter((tick) => validTimestamp(tick?.ms)
    && finiteNumber(tick?.t) && Number(tick.t) >= 0
    && validProbabilityPrice(tick?.upAsk) && validProbabilityPrice(tick?.dnAsk)).length;
  const depth = { up: { arraysPresent: 0, usable: 0, invalid: 0 },
    down: { arraysPresent: 0, usable: 0, invalid: 0 } };
  for (const tick of ticks) {
    for (const [name, book] of [["up", tick?.up], ["down", tick?.down]]) {
      const inspected = inspectDepthBook(book);
      if (inspected.arraysPresent) depth[name].arraysPresent++;
      if (inspected.usable) depth[name].usable++;
      if (inspected.arraysPresent && !inspected.usable) depth[name].invalid++;
    }
  }
  const freshness = Object.fromEntries(SOURCE_CLOCKS.map(([name, source, receive, threshold]) =>
    [name, freshnessAtEvaluation(ticks, source, receive, cfg[threshold])]));
  const missingOrInvalidSourceFields = Object.values(freshness).reduce((sum, item) => sum
    + item.missingSource + item.invalidSource + item.missingReceive + item.invalidReceive, 0);
  const staleAtEvaluation = Object.values(freshness).reduce((sum, item) => sum
    + item.evaluationMinusSource.stale, 0);
  const depthIdentityTicks = ticks.filter((tick) => tick?.upDepthEventId !== null
    && tick?.upDepthEventId !== undefined && String(tick.upDepthEventId).trim() !== ""
    && tick?.downDepthEventId !== null && tick?.downDepthEventId !== undefined
    && String(tick.downDepthEventId).trim() !== "").length;
  return { schema: 1, recorderSchema: finiteNumber(data?.schema) ? Number(data.schema) : null,
    ticks: ticks.length, canonicalTicks, monotonicEvaluationClock, sequenceGaps,
    sourceClockIssues: missingOrInvalidSourceFields, staleAtEvaluation,
    timestampCompleteTicks: ticks.filter((tick) => SOURCE_CLOCKS.every(([, source, receive]) =>
      validTimestamp(tick?.[source]) && validTimestamp(tick?.[receive]))
      && validTimestamp(tick?.ms)).length,
    depthIdentityTicks, depth,
    openingReferences: {
      binance: validPositive(data?.openBinance ?? data?.openBz
        ?? data?.openingReference?.binance),
      chainlink: validPositive(data?.openPrice ?? data?.openCl
        ?? data?.openingReference?.chainlink),
    },
    freshness };
}

export function assertOutcomeFreeInstrumentation(value) {
  const forbidden = /(winSide|winner|outcome|settlement|decision|fill|pnl|profit|performance)/i;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.test(key)) throw new Error(`sealed instrumentation contains forbidden field: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return true;
}
