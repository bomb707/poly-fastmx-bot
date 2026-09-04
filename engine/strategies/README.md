# Strategies

The bot runs **one strategy at a time**, selected by the `STRATEGY` config field (default `"helpme"`). Every
execution path — backtest (`engine/simrun.js`), live-sim and real-live (`src/execution/shadow.js`) — dispatches
through the registry here, so a strategy works everywhere the moment it's registered.

## The contract

A strategy is an ES module exporting:

| export | required | purpose |
|---|---|---|
| `NAME` | ✓ | config id (`P.STRATEGY === NAME` selects it) |
| `LABEL` | – | UI dropdown label |
| `STRAT` | ✓ | default params; `mergedP = { ...STRAT, ...liveParams }` |
| `step(state, tk, P, dtMs, clockMs)` | ✓ | per-tick decision → array of intended fills |
| `injectRealFill(state, fill)` | – | real-live: book an on-chain fill into `state` |
| `applyManualHedge(state, side, shares, px)` | – | real-live: settle operator-placed hedges |
| `clearLivePending(state, oid)` | – | real-live: release a pending-order guard on reject/cancel |
| `shouldCancelResting(state, rec, tk, P, clockMs)` | – | sim/live-shadow: re-evaluate a resting order against current strategy economics |

Omitted optional hooks fall back to no-ops. A strategy is a **pure decision function** — it returns intended
fills and never places real orders or touches the DB; the execution layer handles sim vs real (`P.LIVE_FILLS`).

## Shared modules (import what you need)

- `../fees.js` — `fillFee`, `isFeeFill`, `isTakerFill`, `PARAMS` (fee model; keeps bot + sim PnL matched)
- `../intensity.js` — cross-round volatility (`roundExcursion`, `computeIntensity`, buffer helpers)
- `../fillsim.js` — sim fill model (`makerTouchFill`, `latencyFillPrice`)
- `../mergesim.js` — on-chain `$1`-set merge accounting

## Adding a strategy

1. `cp _template.js <name>.js` and implement `step()`.
2. In `index.js`: `import * as <name> from "./<name>.js"` and `register(<name>)`.
3. (optional) add `<name>`/label to the strategy dropdown in `public/index.html`.

That's it — it's instantly available to backtest, live-sim, and real-live.

## Files

- `index.js` — registry (`getStrategy`, `listStrategies`, `register`, `DEFAULT_STRATEGY`)
- `lockstep.js` — Lockstep adapter over `../strategy.js` (the implementation stays there, live-critical & unchanged)
- `gap_predictor.js` — imported Gap Predictor profile (linear completed-round gap lock + taker hedge with a
  fee-inclusive 0.03/share profit floor)
- `_template.js` — skeleton to copy
