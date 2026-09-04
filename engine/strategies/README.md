# FastMX strategy

The repository has one registered strategy: `helpme`. Live simulation, real-live
execution, and historical replay all resolve it through `index.js`, so they use
the same decision code and defaults.

## Files

- `helpme.js` — state machine, risk controls, and order intents.
- `fastmx-signal-policy.js` — causal CLOB/Binance direction signal.
- `index.js` — deliberately small registry with `helpme` as the only strategy.

The execution layer owns order placement and accounting. Strategy code only
returns intents and processes confirmed fills.

## Anti-overfitting guardrails

- Keep one production strategy and one canonical parameter set.
- Do not add wallet-specific branches, round IDs, timestamps, or fitted lookup
  tables to production code.
- Evaluate changes chronologically: discovery data first, then untouched
  holdout rounds. Report all tested rounds, including losses.
- Run candidate logic through the same `helpme` path used by live execution.
- Add a parameter only when it represents a stable market or risk mechanism,
  not merely because it improves an in-sample result.
- Keep discarded experiments in Git history rather than in the runtime tree.
