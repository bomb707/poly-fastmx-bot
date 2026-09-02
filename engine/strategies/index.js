// engine/strategies/index.js — the strategy REGISTRY.
//
// FastMX has one runtime policy: the evidence-backed wallet-75cc reconstruction.
// Helpme remains registered only so historical research scripts stay reproducible;
// it is not listed in the UI and the live shadow refuses strategy switches.
// shadow.js (live-sim + real-live) dispatch every per-tick decision + live-fill hook through getStrategy(), so a
// strategy is available to ALL execution paths the moment it's registered here.
//
// TO ADD A STRATEGY:
//   1. Copy _template.js → engine/strategies/<name>.js and implement step() (+ optional live hooks).
//   2. Import it below and call register(<mod>).
//   3. Add its NAME/LABEL to the UI strategy dropdown (public/index.html) if you want to pick it from the dashboard.
import * as helpme from "./helpme.js";
import * as target75cc from "./target75cc.js";

const REG = Object.create(null);
export function register(mod) {
  if (!mod || !mod.NAME || typeof mod.step !== "function") throw new Error("strategy must export NAME + step()");
  REG[mod.NAME] = mod;
}
register(helpme);
register(target75cc);

export const DEFAULT_STRATEGY = "target75cc";
const RUNTIME_STRATEGIES = new Set([DEFAULT_STRATEGY]);

// Returns the selected strategy module (falls back to the default for an unknown/absent name). Callers use
//   strat.step(...) (required) and strat.injectRealFill?.(...) etc. (optional — a strategy may omit live hooks).
export function getStrategy(name) { return REG[name] || REG[DEFAULT_STRATEGY]; }

// Only the single FastMX runtime strategy is exposed to UI/diagnostics.
export function listStrategies() { return Object.values(REG)
  .filter((strategy) => RUNTIME_STRATEGIES.has(strategy.NAME))
  .map((strategy) => ({ name: strategy.NAME, label: strategy.LABEL || strategy.NAME })); }

export function strategyParamKeys() {
  return new Set(Object.values(REG).filter((strategy) => RUNTIME_STRATEGIES.has(strategy.NAME))
    .flatMap((strategy) => Object.keys(strategy.STRAT || {})));
}
