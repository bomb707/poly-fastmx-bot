// The main Helpme strategy is shared by the live simulation and backtests.
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
