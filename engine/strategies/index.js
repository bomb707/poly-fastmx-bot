// engine/strategies/index.js — the strategy REGISTRY.
//
// FastMX intentionally exposes one active strategy. Experimental strategies live
// in version history, not beside production code.
// shadow.js (live-sim + real-live) dispatch every per-tick decision + live-fill hook through getStrategy(), so a
// strategy is available to ALL execution paths the moment it's registered here.
//
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
