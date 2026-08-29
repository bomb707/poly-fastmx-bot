// verbose.js — zero-overhead verbose logger (ported from the proven polystack-bot pattern).
//
// Invariants:
//   1. OFF ⇒ zero hot-path cost. `verbose` is bound to `noopVerbose` (V8 inlines it away). Callers that
//      guard with `if (verboseOn) verbose('e', {...})` ALSO skip the payload-object allocation entirely
//      (~1ns: a boolean read + branch) — important for any call that could fire many times per tick.
//   2. ON  ⇒ writes a single timestamped line to the console (→ pm2 logs). No file I/O on the caller's
//      thread beyond console.log, which is already what the rest of the bot uses.
//
// The flag is a live ES-module binding, so toggling it at runtime (the UI's "verbose" switch →
// setVerbose) is reflected at every call site without re-importing.

function noopVerbose(_event, _payload) { /* intentionally empty — inlined away when off */ }

function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function stamp() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
let _inst = "";   // instance tag (e.g. "app-pm34 ") prefixed to every verbose line so merged pm2 logs stay attributable
export function setVerboseInstance(name) { _inst = name ? `${name} ` : ""; }
function realVerbose(event, payload) {
  try {
    let line = `[v ${stamp()}] ${_inst}${event}`;
    if (payload !== undefined) line += " " + (typeof payload === "string" ? payload : safeJson(payload));
    console.log(line);
  } catch { /* logging must never throw into the hot path */ }
}
function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }

/** Live binding — swapped by setVerbose. Default OFF (noop). */
export let verbose = noopVerbose;
/** Fast-path flag — read it before building a payload so the alloc is skipped when off. */
export let verboseOn = false;

/** Toggle verbose logging at runtime (UI switch / startup). Returns the new state. */
export function setVerbose(on) {
  verboseOn = !!on;
  verbose = verboseOn ? realVerbose : noopVerbose;
  return verboseOn;
}
export function isVerbose() { return verboseOn; }
