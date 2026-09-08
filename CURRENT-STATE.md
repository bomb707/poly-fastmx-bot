# FastMX Current State

_Updated: 2026-09-08 UTC_

- Runtime: `poly-fastmx-simulation` under PM2
- Dashboard: `https://poly.360-techgroup.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Target wallet: `0x3048d65321be3497164cdfc2996f94f98a2e7537`
- Sole strategy: `wallet3048` in `engine/strategies/wallet3048.js`

The active reconstruction uses causal 0.5-second Binance momentum, a prebuilt
one-cent GTC ladder with 50/150-share parents, FIFO lot caps, pair/loss-cap
repair, economic cancellation and bounded inventory. The code-level defaults
and current deployed strategy are versioned with `W3048_SPEC_VERSION=3`.

Retired strategies, their dashboard options, tests, and dedicated research
artifacts have been removed.

The authoritative evidence and current policy are documented in
`TARGET_WALLET_STRATEGY_ANALYSIS.md`, `research/wallet-3048/STRATEGY_REPORT.md`,
and `research/wallet-3048/RECONSTRUCTED_POLICY.md`.
