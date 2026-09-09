# FastMX Current State

_Updated: 2026-09-08 UTC_

- Runtime: `poly-fastmx-simulation` under PM2
- Dashboard: `https://pair.360-techgroup.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Target wallet: `0x3048d65321be3497164cdfc2996f94f98a2e7537`
- Sole strategy: `wallet3048` in `engine/strategies/wallet3048.js`

The active reconstruction uses causal 0.5-second Binance momentum confirmed by
a three-second ±0.02 CLOB UP-implied midpoint delta, a prebuilt
one-cent GTC ladder with 50/150-share parents, FIFO lot caps, pair/loss-cap
repair, economic cancellation and bounded inventory. The code-level defaults
and current strategy are versioned with `W3048_SPEC_VERSION=5`. Cheap-token
orders are capped at $0.02, and the latency-aware execution cutoff is t+298s.
Session-loss, per-window loss, and per-window spend ceilings are removed; the
strategy retains its share-imbalance, pending-order, and action-count bounds.

The reviewed code defaults to strict no-maker execution. Book-cross inference,
observed-flow estimates, and optimistic touch are separately labeled simulation
sensitivities. This pass did not issue a PM2 restart or deployment command.

Retired strategies, their dashboard options, tests, and dedicated research
artifacts have been removed.

The authoritative evidence and current policy are documented in
`TARGET_WALLET_STRATEGY_ANALYSIS.md`, `research/wallet-3048/STRATEGY_REPORT.md`,
and `research/wallet-3048/RECONSTRUCTED_POLICY.md`.
