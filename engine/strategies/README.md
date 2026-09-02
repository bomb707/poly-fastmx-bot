# Strategies

FastMX runs **one runtime strategy**, `target75cc`. Every
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
3. Explicitly add its name to `RUNTIME_STRATEGIES` and replace the fixed UI identity if it should become the FastMX runtime policy.

That's it — it's instantly available to backtest, live-sim, and real-live.

## Files

- `index.js` — registry (`getStrategy`, `listStrategies`, `register`, `DEFAULT_STRATEGY`)
- `target75cc.js` — default simulation-only target-wallet imitation: autonomous two-sided cap menu plus tracked residual-size and partial-versus-cross models
- `target75cc-release-model.js` — frozen observable release model, policy, hashes, and exact-week parity metrics
- `target75cc-model.js` — browser-safe frozen trees generated from the tracked target model artifacts, including their source hashes and holdout metrics
- `target75cc-regime-features.js` — causal 0.5–60s trend, path, volatility, and liquidity feature construction shared by research and runtime
- `target75cc-regime-model.js` — generated winner-probability model, chronological metrics, and frozen confidence policy
- `target75cc-regime.js` — trend/noise/reversal interpretation, fee-adjusted expected-edge gate, and confidence size scaling
- `helpme.js` — retired fixed-seven-share baseline retained for offline historical research only
- `lockstep.js` — Lockstep adapter over `../strategy.js` (the implementation stays there, live-critical & unchanged)
- `gap_predictor.js` — imported Gap Predictor profile (linear completed-round gap lock + taker hedge with a
  fee-inclusive 0.03/share profit floor)
- `_template.js` — skeleton to copy

`target75cc` is branded as FastMX and is the only UI/live-shadow policy. It implements observable two-sided menu, sizing, and inventory-transition structure plus a causal trend/noise layer selected on a chronological validation day. The enhancement materially reduces losses and drawdown, but partial-OOS PnL remains slightly negative and it does not recover the wallet's unknown private release program. It remains simulation-only and must not be described as an exact or profitable clone.
