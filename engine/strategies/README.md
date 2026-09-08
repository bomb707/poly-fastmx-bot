# Strategy

`wallet3048.js` is the sole registered strategy. Backtests, live simulation,
and all execution paths resolve missing or unknown strategy names to
`wallet3048`.

The module exports:

| Export | Purpose |
|---|---|
| `NAME` | Stable config id: `wallet3048` |
| `LABEL` | Dashboard and diagnostics label |
| `STRAT` | Versioned default parameters |
| `validateParams()` | Runtime parameter validation |
| `step()` | Per-tick order decisions |
| `injectRealFill()` | Confirmed-fill inventory updates |
| `clearLivePending()` | Pending-order cleanup |
| `shouldCancelResting()` | Economic cancel/reprice decisions |

Shared execution helpers remain in `engine/fees.js`, `engine/fillsim.js`, and
`engine/mergesim.js`. The `_template.js`, `lockstep.js`, and `gap_predictor.js`
files are unregistered development/research artifacts and cannot be selected at
runtime.
