// UTC session-specific FastMX signal regimes.
//
// These are the previously validated UTC session regimes. Experimental
// source-subset and return-efficiency candidates remain research-only because
// the complete all-round replay did not pass validation.

export const FASTMX_SESSION_PROFILES = Object.freeze({
  asia: Object.freeze({
    H_START_S: 60,
    H_STOP_S: 239,
    H_COOLDOWN_MS: 10_000,
    H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000,
    H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 12_000,
    H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_TREND_LOOKBACK_SEC: 60,
    H_BINANCE_TREND_MIN_PCT: 0.10,
    H_BINANCE_GAP_AGREE_ON: false,
    H_MIN_ASK: 0.01,
    H_ENTRY_RISK_USD: 2,
    H_REVERSAL_RISK_USD: 2,
    H_PARTICIPATION_RISK_USD: 1,
    H_REVERSAL_ON: false,
    H_PARTICIPATION_START_S: 90,
    H_PARTICIPATION_SIDE: "clob",
  }),
  europe: Object.freeze({
    H_START_S: 60,
    H_STOP_S: 239,
    H_COOLDOWN_MS: 5_000,
    H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true,
    H_MID_VELOCITY_LOOKBACK_MS: 5_000,
    H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000,
    H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_TREND_LOOKBACK_SEC: 30,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_GAP_AGREE_ON: false,
    H_MIN_ASK: 0.01,
    H_ENTRY_RISK_USD: 4,
    H_REVERSAL_RISK_USD: 4,
    H_PARTICIPATION_RISK_USD: 1,
    H_REVERSAL_ON: true,
    H_REVERSAL_CONFIRM_MS: 1_000,
    // A separate pair-edge gate rejected reversals that improved both fit and
    // holdout. The global post-order worst-settlement-loss check remains the
    // binding economic/risk gate.
    H_REVERSAL_ECONOMIC_GATE_ON: false,
    H_REVERSAL_RESIDUAL_SH: 15,
    H_REVERSAL_MAX_IMBALANCE_SH: 40,
    H_PARTICIPATION_START_S: 90,
    H_PARTICIPATION_SIDE: "clob",
  }),
  us: Object.freeze({
    H_START_S: 60,
    H_STOP_S: 239,
    H_COOLDOWN_MS: 15_000,
    H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true,
    H_MID_VELOCITY_LOOKBACK_MS: 8_000,
    H_MID_VELOCITY_MIN: 0.03,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 8_000,
    H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_TREND_LOOKBACK_SEC: 30,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_GAP_AGREE_ON: true,
    H_MIN_ASK: 0.05,
    H_ENTRY_RISK_USD: 2,
    H_REVERSAL_RISK_USD: 2,
    H_PARTICIPATION_RISK_USD: 1,
    H_REVERSAL_ON: false,
    H_PARTICIPATION_START_S: 90,
    H_PARTICIPATION_SIDE: "cheap",
  }),
  late_us: Object.freeze({
    H_START_S: 60,
    H_STOP_S: 239,
    H_COOLDOWN_MS: 15_000,
    H_CLOB_MID_VELOCITY_ON: true,
    H_BINANCE_GAP_MOMENTUM_ON: true,
    H_BINANCE_TREND_ON: true,
    H_MID_VELOCITY_LOOKBACK_MS: 3_000,
    H_MID_VELOCITY_MIN: 0.02,
    H_BINANCE_GAP_VELOCITY_LOOKBACK_MS: 5_000,
    H_BINANCE_GAP_VELOCITY_MIN: 10,
    H_BINANCE_TREND_LOOKBACK_SEC: 15,
    H_BINANCE_TREND_MIN_PCT: 0.05,
    H_BINANCE_GAP_AGREE_ON: false,
    H_MIN_ASK: 0.05,
    H_CAP_HEADROOM: 0.02,
    H_ENTRY_RISK_USD: 2,
    H_REVERSAL_RISK_USD: 2,
    H_PARTICIPATION_RISK_USD: 1,
    H_REVERSAL_ON: true,
    H_REVERSAL_CONFIRM_MS: 1_000,
    H_REVERSAL_ECONOMIC_GATE_ON: false,
    H_REVERSAL_RESIDUAL_SH: 15,
    H_REVERSAL_MAX_IMBALANCE_SH: 15,
    H_PARTICIPATION_START_S: 90,
    H_PARTICIPATION_SIDE: "cheap",
  }),
});

export function fastMxSessionOfHour(hour) {
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 0 || value > 23) return null;
  if (value < 7) return "asia";
  if (value < 13) return "europe";
  if (value < 21) return "us";
  return "late_us";
}

function isOn(value) {
  if (value == null || value === "") return false;
  return !(value === false || value === 0 || value === "0"
    || String(value).toLowerCase() === "false");
}

export function resolveFastMxSessionParams(params, tick = {}) {
  const base = params || {};
  const session = fastMxSessionOfHour(tick.winHour);
  if (!session || !isOn(base.H_SESSION_POLICY_ON)) {
    return { params: base, session, applied: false, overrides: null };
  }
  const profiles = base.H_SESSION_PROFILES && typeof base.H_SESSION_PROFILES === "object"
    ? base.H_SESSION_PROFILES : FASTMX_SESSION_PROFILES;
  const overrides = profiles[session];
  if (!overrides || typeof overrides !== "object") {
    return { params: base, session, applied: false, overrides: null };
  }
  return { params: { ...base, ...overrides }, session, applied: true, overrides };
}
