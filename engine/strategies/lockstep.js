// engine/strategies/lockstep.js — Lockstep, exposed as a registered strategy.
//
// The IMPLEMENTATION stays in engine/strategy.js (unchanged, live-critical). This module is a thin adapter that
// maps it onto the shared strategy CONTRACT (see ./README.md) so the registry + dispatcher can treat every
// strategy uniformly. `getStrategy("lockstep").step === stepSignalHedge` and `.STRAT === STRAT`, so the live
// and backtest paths stay byte-identical when Lockstep is selected (the default).
import { STRAT, stepSignalHedge, injectRealFill, applyManualHedge, clearLivePending, passesGate } from "../strategy.js";

export const NAME = "lockstep";
export const LABEL = "Lockstep";
export { STRAT, injectRealFill, applyManualHedge, clearLivePending, passesGate };
export const step = stepSignalHedge;   // the per-tick decision → fills[]  (the contract's one required method)
