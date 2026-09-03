// Fixed UTC bins and the BAPI-selected minimum probability required for a
// target75cc entry candidate. UTC keeps live and replay behavior deterministic
// across daylight-saving changes.

export const ENTRY_CONFIDENCE_SESSIONS = Object.freeze([
  Object.freeze({ id: "utc00_04", startHour: 0, endHour: 4,
    label: "Asia morning / US evening" }),
  Object.freeze({ id: "utc04_08", startHour: 4, endHour: 8,
    label: "Asia afternoon / US midnight" }),
  Object.freeze({ id: "utc08_12", startHour: 8, endHour: 12,
    label: "Europe morning / US premarket" }),
  Object.freeze({ id: "utc12_16", startHour: 12, endHour: 16,
    label: "US morning" }),
  Object.freeze({ id: "utc16_20", startHour: 16, endHour: 20,
    label: "US afternoon" }),
  Object.freeze({ id: "utc20_24", startHour: 20, endHour: 24,
    label: "US evening / Asia open" }),
]);

// Selected on Aug 20-24 train + Aug 25 validation BAPI v2 coherent L2 data;
// Aug 26 holdout and Aug 27-Sep 2 partial OOS were evaluation-only.
export const SESSION_ENTRY_MIN_PROBABILITY = Object.freeze({
  utc00_04: .500,
  utc04_08: .750,
  utc08_12: .650,
  utc12_16: .500,
  utc16_20: .500,
  utc20_24: .725,
});

const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const clampHour = (value) => ((Math.floor(Number(value)) % 24) + 24) % 24;

export function entryConfidenceSession(hour) {
  if (!finite(hour)) return null;
  const utcHour = clampHour(hour);
  return ENTRY_CONFIDENCE_SESSIONS.find((session) =>
    utcHour >= session.startHour && utcHour < session.endHour) || null;
}

export function resolveSessionEntryConfidence({ winHour, windowStart, enabled = true,
  schedule = SESSION_ENTRY_MIN_PROBABILITY, fallback = .5 } = {}) {
  const utcHour = finite(winHour) ? clampHour(winHour)
    : finite(windowStart) ? new Date(Number(windowStart) * 1_000).getUTCHours() : null;
  const session = entryConfidenceSession(utcHour);
  const configured = enabled && session && schedule && typeof schedule === "object"
    ? Number(schedule[session.id]) : Number.NaN;
  const minimumProbability = Number.isFinite(configured) ? configured : Number(fallback);
  return {
    enabled: enabled === true,
    utcHour,
    sessionId: session?.id ?? null,
    sessionLabel: session?.label ?? null,
    minimumProbability,
  };
}
