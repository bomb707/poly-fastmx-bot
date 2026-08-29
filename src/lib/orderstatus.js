// lib/orderstatus.js — the canonical ORDER-STATUS PROTOCOL (the single source of the lifecycle stage vocabulary).
//
// ── LIB BOUNDARY ─────────────────────────────────────────────────────────────────────────────────────
// One place that DEFINES every order_status stage a bot emits. The server EMITS these (src/index.js emitOS,
// src/execution/shadow.js); the browser Order Status panel CONSUMES them (public/index.html: stageText labels,
// ev() reducer, statusOf() badge). A stage-name typo on either side silently drops the event — so both sides
// reference this vocabulary. The panel's rendering (labels/reducer/badge) stays in the UI (it uses browser
// px/esc/lat helpers + panel state); only the NAMES + their meaning/payload contract live here.
//
// LIFECYCLE (typical order): DECIDED → PLACED → (SIM_FILLED | SUBMITTED) → REAL_FILLED → RECONCILED → STATUS…
//   with terminal/side branches REJECTED · SKIPPED · CANCELED_STALE · CANCEL_RACED.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const STAGES = Object.freeze({
  DECIDED:        "decided",         // strategy decided to place this order. payload: {decPx, reason, side, leg, reqShares, simLatencyMs, mode}
  SIM_FILLED:     "sim_filled",      // the MODELED (sim/shadow) fill booked. payload: {simFillPx, shares, maker, simFilledLate}
  PLACED:         "placed",          // the REAL order left the bot to the CLOB. payload: {ceiling, decPx}
  SUBMITTED:      "submitted",       // accepted, resting on the book (nothing filled synchronously). payload: {orderId, realStatus, realLatencyMs}
  REAL_FILLED:    "real_filled",     // REAL synchronous fill. payload: {orderId, realShares, realSpent, realAvgPx, realStatus, realLatencyMs, full}
  RECONCILED:     "reconciled",      // a LATE fill of a resting remainder booked by the poll. payload: {deltaShares, deltaSpent, realAvgPx, matched}
  STATUS:         "status",          // an order/on-chain status transition. payload: {phase:"order"|"trade", statusRaw, matched, orig, price, size, src}
  REJECTED:       "rejected",        // the venue rejected the order. payload: {error}
  SKIPPED:        "skipped",         // guarded before submit (stale book / trade disabled / paused / nothing to do). payload: {note}
  CANCELED_STALE: "canceled-stale",  // resting remainder canceled past LIVE_REST_TIMEOUT_S (any partial kept). payload: {orderId, matched}
  CANCEL_RACED:   "cancel-raced",    // a stale-cancel lost the race to a fill → the fill path books it. payload: {orderId}
});

/** All stage strings, for consistency checks (server-emitted must match browser-consumed). */
export const STAGE_LIST = Object.freeze(Object.values(STAGES));

/** True if `s` is a known stage. */
export function isStage(s) { return STAGE_LIST.includes(s); }
