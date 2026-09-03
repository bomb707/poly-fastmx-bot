// Causal multi-timescale features for the target75cc trend/noise layer.
//
// `history` may contain the complete market in offline research, but every
// lookup is explicitly bounded at or before `clockMs`. Runtime passes only
// snapshots observed so far. No forward value is read by this module.

export const REGIME_HORIZONS_MS = [500, 1_000, 2_000, 3_000, 5_000,
  10_000, 15_000, 30_000, 60_000];
export const SETTLEMENT_GAP_KNOTS_USD = [10, 20, 50, 100, 150];
export const SETTLEMENT_SESSION_IDS = ["utc00_04", "utc04_08", "utc08_12",
  "utc12_16", "utc16_20", "utc20_24"];

const BASE_FEATURES = [
  "timeFraction", "ask", "spread", "pairAsk",
  "askDepth1Log", "askDepth3Log", "bidDepth1Log", "bidDepth3Log",
  "topDepthImbalance", "depth3Imbalance", "micropriceBias",
  "binanceGap", "twapGap", "binanceTwapBasis",
];
const MOVE_FEATURES = REGIME_HORIZONS_MS.flatMap((ms) => [
  `midMove${ms}`, `askMove${ms}`, `bidMove${ms}`,
  `binanceMove${ms}`, `twapMove${ms}`, `basisMove${ms}`,
  `spreadChange${ms}`, `depthPressureChange${ms}`,
]);
const PATH_FEATURES = [
  "midPersistence5", "midPersistence15", "midPersistence30",
  "binancePersistence5", "binancePersistence15", "binancePersistence30",
  "twapPersistence15", "crossFeedAgreement",
  "midEfficiency15", "midEfficiency30", "binanceEfficiency15", "binanceEfficiency30",
  "midVolatility15", "midVolatility30", "binanceVolatility15", "binanceVolatility30",
  "shortMidZ", "shortBinanceZ", "positionInRange15", "positionInRange30",
  "discountFromHigh15", "discountFromHigh30",
  "midAcceleration", "binanceAcceleration", "dominantScore", "shortScore",
];
const SETTLEMENT_FEATURES = [
  "binanceOwnGapUsd", "binanceSettlementGapUsd", "twapSettlementGapUsd",
  "binanceSettlementGapBps", "twapSettlementGapBps", "settlementDirectionAgreement",
  "binanceSettlementGapWhenAgree", "binanceSettlementGapWhenDisagree",
  "twapSettlementGapWhenAgree", "twapSettlementGapWhenDisagree", "secondsLeftFraction",
  "binanceSettlementRequiredVelocity", "twapSettlementRequiredVelocity",
  "twapVolatility30", "binanceSettlementSafetyZ", "twapSettlementSafetyZ",
  ...SETTLEMENT_GAP_KNOTS_USD.flatMap((knot) => [
    `binanceSettlementAboveUsd${knot}`, `binanceSettlementBelowUsd${knot}`,
    `twapSettlementAboveUsd${knot}`, `twapSettlementBelowUsd${knot}`,
  ]),
  ...SETTLEMENT_SESSION_IDS.flatMap((id) => [
    `session_${id}`, `binanceSettlementGap_${id}`, `twapSettlementGap_${id}`,
  ]),
];

export const REGIME_FEATURE_NAMES = [...BASE_FEATURES, ...MOVE_FEATURES, ...PATH_FEATURES,
  ...SETTLEMENT_FEATURES];

const EPS = 1e-9;
const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const value = (input, fallback = 0) => finite(input) ? Number(input) : fallback;
const otherSide = (side) => side === "Up" ? "Down" : "Up";
const midpoint = (book) => finite(book?.ask) && finite(book?.bid)
  ? (Number(book.ask) + Number(book.bid)) / 2 : null;
const spread = (book) => finite(book?.ask) && finite(book?.bid)
  ? Number(book.ask) - Number(book.bid) : 0;
const pressure = (book) => {
  const bid = value(book?.bidDepth3), ask = value(book?.askDepth3);
  return (bid - ask) / Math.max(EPS, bid + ask);
};
const pctMove = (current, prior) => current > 0 && prior > 0
  ? (current - prior) / prior * 100 : 0;
const basisPct = (snapshot) => value(snapshot?.bz) > 0 && value(snapshot?.cl) > 0
  ? (Number(snapshot.bz) - Number(snapshot.cl)) / Number(snapshot.cl) * 100 : 0;
const clamp = (input, low, high) => Math.max(low, Math.min(high, input));
const sessionId = (hour) => {
  const normalized = ((Math.floor(value(hour)) % 24) + 24) % 24;
  return SETTLEMENT_SESSION_IDS[Math.floor(normalized / 4)];
};

export function regimePriorAt(history, targetMs) {
  let low = 0, high = history.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(history[middle]?.ms) <= targetMs) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer >= 0 ? history[answer] : null;
}

function path(history, current, side, clockMs, seconds, field) {
  const rows = [];
  for (let offset = seconds; offset >= 1; offset--) {
    const snapshot = regimePriorAt(history, clockMs - offset * 1_000);
    if (snapshot && snapshot.ms <= clockMs && rows.at(-1)?.ms !== snapshot.ms) rows.push(snapshot);
  }
  if (!rows.length || rows.at(-1)?.ms !== current.ms) rows.push(current);
  const sign = side === "Up" ? 1 : -1;
  return rows.map((snapshot) => {
    if (field === "mid") return midpoint(snapshot[side]);
    if (field === "bz") return value(snapshot.bz) > 0 ? Math.log(Number(snapshot.bz)) * 100 * sign : null;
    if (field === "cl") return value(snapshot.cl) > 0 ? Math.log(Number(snapshot.cl)) * 100 * sign : null;
    return null;
  }).filter(finite).map(Number);
}

function pathStats(rows) {
  if (rows.length < 2) return { persistence: 0, efficiency: 0, volatility: 0,
    position: .5, discount: 0 };
  const changes = rows.slice(1).map((entry, index) => entry - rows[index]);
  const mean = changes.reduce((sum, entry) => sum + entry, 0) / changes.length;
  const variance = changes.reduce((sum, entry) => sum + (entry - mean) ** 2, 0) / changes.length;
  const traveled = changes.reduce((sum, entry) => sum + Math.abs(entry), 0);
  const persistence = changes.reduce((sum, entry) => sum + Math.sign(entry), 0) / changes.length;
  const low = Math.min(...rows), high = Math.max(...rows), current = rows.at(-1);
  return {
    persistence,
    efficiency: Math.abs(current - rows[0]) / Math.max(EPS, traveled),
    volatility: Math.sqrt(variance),
    position: high - low > EPS ? (current - low) / (high - low) : .5,
    discount: high - current,
  };
}

function tanhEvidence(input, scale) { return Math.tanh(value(input) / scale); }

/**
 * Return a finite, side-oriented causal feature object and vector.
 * Positive price/trend values always favor `side`.
 */
export function regimeFeatures({ history = [], current, tk = {}, side, clockMs } = {}) {
  if (!current || !["Up", "Down"].includes(side) || !finite(clockMs)) return null;
  const book = current[side], opposite = current[otherSide(side)];
  if (!(value(book?.ask) > 0 && value(book?.bid) > 0 && value(opposite?.ask) > 0)) return null;
  const sign = side === "Up" ? 1 : -1;
  const mid = midpoint(book);
  const openBinance = value(tk.openBinance), openChainlink = value(tk.openChainlink);
  const binanceOwnGapUsd = value(current.bz) > 0 && openBinance > 0
    ? (value(current.bz) - openBinance) * sign : 0;
  const binanceSettlementGapUsd = value(current.bz) > 0 && openChainlink > 0
    ? (value(current.bz) - openChainlink) * sign : 0;
  const twapSettlementGapUsd = value(current.cl) > 0 && openChainlink > 0
    ? (value(current.cl) - openChainlink) * sign : 0;
  const binanceSettlementGapPct = openChainlink > 0
    ? binanceSettlementGapUsd / openChainlink * 100 : 0;
  const twapSettlementGapPct = openChainlink > 0
    ? twapSettlementGapUsd / openChainlink * 100 : 0;
  const settlementDirectionAgreement = Math.sign(binanceSettlementGapUsd)
    === Math.sign(twapSettlementGapUsd) ? 1 : -1;
  const secondsLeft = clamp(300 - value(tk.t), 1, 300);
  const derivedUtcHour = finite(tk.winHour) ? value(tk.winHour)
    : Number(clockMs) > 1e11 ? new Date(Number(clockMs) - value(tk.t) * 1_000).getUTCHours() : 0;
  const currentSessionId = sessionId(derivedUtcHour);
  const raw = {
    timeFraction: value(tk.t) / 300,
    ask: value(book.ask),
    spread: spread(book),
    pairAsk: value(book.ask) + value(opposite.ask),
    askDepth1Log: Math.log1p(Math.max(0, value(book.askDepth1))),
    askDepth3Log: Math.log1p(Math.max(0, value(book.askDepth3))),
    bidDepth1Log: Math.log1p(Math.max(0, value(book.bidDepth1))),
    bidDepth3Log: Math.log1p(Math.max(0, value(book.bidDepth3))),
    topDepthImbalance: (value(book.bidDepth1) - value(book.askDepth1))
      / Math.max(EPS, value(book.bidDepth1) + value(book.askDepth1)),
    depth3Imbalance: pressure(book),
    micropriceBias: (value(book.bidDepth1) * value(book.ask)
      + value(book.askDepth1) * value(book.bid))
      / Math.max(EPS, value(book.bidDepth1) + value(book.askDepth1)) - mid,
    binanceGap: value(current.bz) > 0 && value(tk.openBinance) > 0
      ? pctMove(value(current.bz), value(tk.openBinance)) * sign : 0,
    twapGap: value(current.cl) > 0 && value(tk.openChainlink) > 0
      ? pctMove(value(current.cl), value(tk.openChainlink)) * sign : 0,
    binanceTwapBasis: basisPct(current) * sign,
    binanceOwnGapUsd,
    binanceSettlementGapUsd,
    twapSettlementGapUsd,
    binanceSettlementGapBps: binanceSettlementGapPct * 100,
    twapSettlementGapBps: twapSettlementGapPct * 100,
    settlementDirectionAgreement,
    binanceSettlementGapWhenAgree: settlementDirectionAgreement > 0 ? binanceSettlementGapUsd : 0,
    binanceSettlementGapWhenDisagree: settlementDirectionAgreement < 0 ? binanceSettlementGapUsd : 0,
    twapSettlementGapWhenAgree: settlementDirectionAgreement > 0 ? twapSettlementGapUsd : 0,
    twapSettlementGapWhenDisagree: settlementDirectionAgreement < 0 ? twapSettlementGapUsd : 0,
    secondsLeftFraction: secondsLeft / 300,
    binanceSettlementRequiredVelocity: binanceSettlementGapUsd / secondsLeft,
    twapSettlementRequiredVelocity: twapSettlementGapUsd / secondsLeft,
  };

  for (const knot of SETTLEMENT_GAP_KNOTS_USD) {
    raw[`binanceSettlementAboveUsd${knot}`] = Math.max(0, binanceSettlementGapUsd - knot);
    raw[`binanceSettlementBelowUsd${knot}`] = Math.max(0, -binanceSettlementGapUsd - knot);
    raw[`twapSettlementAboveUsd${knot}`] = Math.max(0, twapSettlementGapUsd - knot);
    raw[`twapSettlementBelowUsd${knot}`] = Math.max(0, -twapSettlementGapUsd - knot);
  }
  for (const id of SETTLEMENT_SESSION_IDS) {
    const active = Number(id === currentSessionId);
    raw[`session_${id}`] = active;
    raw[`binanceSettlementGap_${id}`] = active * raw.binanceSettlementGapBps;
    raw[`twapSettlementGap_${id}`] = active * raw.twapSettlementGapBps;
  }

  for (const lookbackMs of REGIME_HORIZONS_MS) {
    const prior = regimePriorAt(history, Number(clockMs) - lookbackMs);
    const priorBook = prior?.[side], priorMid = midpoint(priorBook);
    raw[`midMove${lookbackMs}`] = finite(priorMid) ? mid - priorMid : 0;
    raw[`askMove${lookbackMs}`] = finite(priorBook?.ask) ? value(book.ask) - value(priorBook.ask) : 0;
    raw[`bidMove${lookbackMs}`] = finite(priorBook?.bid) ? value(book.bid) - value(priorBook.bid) : 0;
    raw[`binanceMove${lookbackMs}`] = prior ? pctMove(value(current.bz), value(prior.bz)) * sign : 0;
    raw[`twapMove${lookbackMs}`] = prior ? pctMove(value(current.cl), value(prior.cl)) * sign : 0;
    raw[`basisMove${lookbackMs}`] = prior ? (basisPct(current) - basisPct(prior)) * sign : 0;
    raw[`spreadChange${lookbackMs}`] = priorBook ? spread(book) - spread(priorBook) : 0;
    raw[`depthPressureChange${lookbackMs}`] = priorBook ? pressure(book) - pressure(priorBook) : 0;
  }

  const mid5 = pathStats(path(history, current, side, clockMs, 5, "mid"));
  const mid15 = pathStats(path(history, current, side, clockMs, 15, "mid"));
  const mid30 = pathStats(path(history, current, side, clockMs, 30, "mid"));
  const bz5 = pathStats(path(history, current, side, clockMs, 5, "bz"));
  const bz15 = pathStats(path(history, current, side, clockMs, 15, "bz"));
  const bz30 = pathStats(path(history, current, side, clockMs, 30, "bz"));
  const cl15 = pathStats(path(history, current, side, clockMs, 15, "cl"));
  const cl30 = pathStats(path(history, current, side, clockMs, 30, "cl"));
  raw.midPersistence5 = mid5.persistence;
  raw.midPersistence15 = mid15.persistence;
  raw.midPersistence30 = mid30.persistence;
  raw.binancePersistence5 = bz5.persistence;
  raw.binancePersistence15 = bz15.persistence;
  raw.binancePersistence30 = bz30.persistence;
  raw.twapPersistence15 = cl15.persistence;
  raw.crossFeedAgreement = (Math.sign(raw.midMove15000) + Math.sign(raw.binanceMove15000)
    + Math.sign(raw.twapMove15000)) / 3;
  raw.midEfficiency15 = mid15.efficiency;
  raw.midEfficiency30 = mid30.efficiency;
  raw.binanceEfficiency15 = bz15.efficiency;
  raw.binanceEfficiency30 = bz30.efficiency;
  raw.midVolatility15 = mid15.volatility;
  raw.midVolatility30 = mid30.volatility;
  raw.binanceVolatility15 = bz15.volatility;
  raw.binanceVolatility30 = bz30.volatility;
  raw.twapVolatility30 = cl30.volatility;
  raw.binanceSettlementSafetyZ = clamp(binanceSettlementGapPct
    / Math.max(.005, bz30.volatility * Math.sqrt(secondsLeft)), -20, 20);
  raw.twapSettlementSafetyZ = clamp(twapSettlementGapPct
    / Math.max(.002, cl30.volatility * Math.sqrt(secondsLeft)), -20, 20);
  raw.shortMidZ = raw.midMove1000 / Math.max(.0025, mid15.volatility);
  raw.shortBinanceZ = raw.binanceMove1000 / Math.max(.0005, bz15.volatility);
  raw.positionInRange15 = mid15.position;
  raw.positionInRange30 = mid30.position;
  raw.discountFromHigh15 = mid15.discount;
  raw.discountFromHigh30 = mid30.discount;
  raw.midAcceleration = raw.midMove1000 - raw.midMove5000 / 5;
  raw.binanceAcceleration = raw.binanceMove1000 - raw.binanceMove5000 / 5;

  const dominantHorizons = [[15_000, .5], [30_000, .3], [60_000, .2]];
  raw.dominantScore = dominantHorizons.reduce((sum, [ms, weight]) => sum + weight * (
    .45 * tanhEvidence(raw[`midMove${ms}`], .05)
    + .35 * tanhEvidence(raw[`binanceMove${ms}`], .05)
    + .20 * tanhEvidence(raw[`twapMove${ms}`], .05)), 0);
  const shortHorizons = [[500, .15], [1_000, .35], [2_000, .3], [3_000, .2]];
  raw.shortScore = shortHorizons.reduce((sum, [ms, weight]) => sum + weight * (
    .5 * tanhEvidence(raw[`midMove${ms}`], .02)
    + .35 * tanhEvidence(raw[`binanceMove${ms}`], .02)
    + .15 * tanhEvidence(raw[`twapMove${ms}`], .02)), 0);
  raw.dominantScore = clamp(raw.dominantScore, -1, 1);
  raw.shortScore = clamp(raw.shortScore, -1, 1);

  const vector = REGIME_FEATURE_NAMES.map((name) => finite(raw[name]) ? Number(raw[name]) : 0);
  return { raw, vector };
}
