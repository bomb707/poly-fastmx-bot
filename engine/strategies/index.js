// engine/strategies/index.js — the strategy REGISTRY.
//
// Helpme intentionally exposes ONE active strategy. Legacy modules remain in the copied repository only as
// research artifacts; they cannot be selected by the runtime or dashboard.
// shadow.js (live-sim + real-live) dispatch every per-tick decision + live-fill hook through getStrategy(), so a
// strategy is available to ALL execution paths the moment it's registered here.
//
// TO ADD A STRATEGY:
//   1. Copy _template.js → engine/strategies/<name>.js and implement step() (+ optional live hooks).
//   2. Import it below and call register(<mod>).
//   3. Add its NAME/LABEL to the UI strategy dropdown (public/index.html) if you want to pick it from the dashboard.
import * as helpme from "./helpme.js";

const REG = Object.create(null);
export function register(mod) {
  if (!mod || !mod.NAME || typeof mod.step !== "function") throw new Error("strategy must export NAME + step()");
  REG[mod.NAME] = mod;
}
register(helpme);

export const DEFAULT_STRATEGY = "helpme";

// Returns the selected strategy module (falls back to the default for an unknown/absent name). Callers use
//   strat.step(...) (required) and strat.injectRealFill?.(...) etc. (optional — a strategy may omit live hooks).
export function getStrategy(name) { return REG[name] || REG[DEFAULT_STRATEGY]; }

// For the UI selector / diagnostics: [{ name, label }] of every registered strategy.
export function listStrategies() { return Object.values(REG).map((s) => ({ name: s.NAME, label: s.LABEL || s.NAME })); }
