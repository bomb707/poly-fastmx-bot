// botState.js — the bot's run switch (Start/Stop). Default STOPPED. In UI mode the engine (all feeds,
// the sampler, order placement) is started/stopped by this flag; in console mode index.js flips it true
// at boot. index.js registers onRunChange() to actually connect/disconnect the feeds.
let _running = false;
let _onChange = null;

// LIVE-TRADE kill switch (separate from the Start/Stop run flag). When false, the AUTO strategy places NO real
//   orders — but the shadow sim, feeds and MANUAL panel keep working. Default true (trade when running).
let _tradeEnabled = true;
export function isTradeEnabled() { return _tradeEnabled; }
export function setTradeEnabled(on) { _tradeEnabled = !!on; console.log(`[bot] live auto-trading ${_tradeEnabled ? "ENABLED" : "DISABLED"}`); return _tradeEnabled; }

// PER-WINDOW pause: hold auto-trading for ONE specific window (its windowStart). Unlike the global kill switch this
//   auto-resets — the next window trades normally. null = no window paused. (Not persisted: windows are short-lived.)
let _skipWs = null;
export function skippedWindow() { return _skipWs; }
export function setSkippedWindow(ws) { _skipWs = (ws == null ? null : +ws); console.log(`[bot] window auto-trading ${_skipWs ? "PAUSED (" + _skipWs + ")" : "resumed"}`); return _skipWs; }
export function isWindowSkipped(ws) { return _skipWs != null && +ws === _skipWs; }

export function isRunning() { return _running; }
export function onRunChange(fn) { _onChange = fn; }   // index.js wires this to startEngine/stopEngine
export function setRunning(on) {
  const v = !!on;
  if (v === _running) return _running;
  _running = v;
  console.log(`[bot] ${v ? "STARTED" : "STOPPED"}`);
  try { _onChange?.(v); } catch (e) { console.error("[bot] onChange error:", e); }
  return _running;
}
