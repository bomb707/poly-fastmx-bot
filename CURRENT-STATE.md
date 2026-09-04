# FastMX current state

_Updated: 2026-08-27 UTC_

- Runtime: `poly-fastmx-simulation`, online under PM2
- Dashboard: `https://dev-fastmx.polywinbot.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Tracked wallet: unset by default; optionally supplied by the operator
- Active strategy: only `helpme`, in `engine/strategies/helpme.js`

The active policy exposes two direction-source toggles and the `poly-mom-bot` Binance trend-regime toggle. CLOB midpoint velocity uses
`mid(now) - mid(at-or-before now - lookback)`, with `mid = (best bid + best ask) / 2`, a required configurable
lookback fixed at the required `3000` ms default and a configured absolute threshold of `0.02`. Binance gap momentum uses the dev-tool raw-dollar formula
`(priceNow-open)-(pricePrior-open) = priceNow-pricePrior`, with a three-second lookback and
`$5` minimum. Binance trend uses the `poly-mom-bot` formula
`100 × (current Binance spot - Binance spot 30 seconds earlier) / prior spot`. At `0.05%` or stronger,
a trend-following Binance signal passes normally; an opposing fast signal must also clear `0.075%` on both its fast
clock and a causal 60-second Binance clock in the same direction. Weak/range trend and missing trend history leave
the fast signal unchanged, matching `poly-mom-bot`. Trend is not a standalone direction source and requires Binance
momentum. UI and server validation guarantee at least one fast source is enabled and enforce that dependency.
`H_BINANCE_GAP_AGREE_ON` independently applies the `poly-mom-bot` window-gap rule: selected velocity direction
must agree with Binance spot versus the five-minute Binance open. It is currently off.
Every distinct qualified signal aligned with flat/current inventory creates a seven-share entry. Two independent
opposite-signal controls are available: partial hedge retains at least a one-share old-side lead, while reversal
requires CLOB + Binance fast momentum + strong trailing trend + window-gap confirmation, crosses only an old
imbalance up to 25 shares, and targets a ten-share new-side residual. Inventory orders are exact-share sized and
force live GTC plus immediate remainder cancellation. Both controls default off conservatively. Executable-duration, cap-cell, order-count, and
per-window inventory-loss branches remain removed. Cooldown remains the sole release throttle at `1000` ms.
The external session circuit breaker remains at `-$25`.
Chainlink, ask differentials, imbalance, microprice, and weighted scores are not direction gates.

Current deployed PM2 profile: CLOB velocity OFF, Binance velocity ON at `3000ms/$5`, Binance trend regime ON at
`30s/0.05%` with `60s/0.075%` countertrend confirmation, window-gap agreement ON, active through `T+300`,
`2000ms` cooldown, hedge OFF, and reversal OFF.

Each simulated/backtested automatic BUY is a fixed-USDC FAK: `budget = signed cap × minimum shares`. Modeled matching is delayed 520 ms,
walks the future visible L2 ladder, can receive more shares through price improvement, books partials at actual
VWAP, and cancels any unspent remainder.

Real execution remains disabled in the PM2 process, but the isolated live executor was production-probed on
August 27. It now reads market-specific tick/minimum constraints, signs a true fixed-USD CLOB V2 market order
for FAK, prewarms that signer path, computes and fsync-journals the deterministic order ID before POST in the
probe harness, and maintains a renewable two-socket HTTPS reserve. The dashboard's **live order type** selector
chooses GTC with immediate unfilled-remainder cancellation or FAK and persists across restarts; GTC is the default,
while `LIVE_TAKER_ORDER_TYPE` remains the legacy/fallback setting. This live-only choice cannot change the frozen
FAK simulation/backtest model. Three matched GTC
probes averaged 276.97 ms versus 516.45 ms for two matched FAK probes. Every prepared hash matched the venue
order ID, every fill reached `CONFIRMED`, and the final open-order count was zero. Full evidence is in
`research/LIVE_EXECUTION_PROBE_2026-08-27.md`.

Past-window `recorded:false` backview uses coherent V2 50 ms order-book frames, causally sampled at 120 ms. It
feeds completed fills back into the same inventory state before later decisions; BBA-only data cannot create
synthetic liquidity. The UI badge explicitly displays `BACKVIEW · RECORDED:FALSE`.

The CLOB feed follows Polymarket's documented market-channel protocol: full `book` snapshots, absolute
`price_change` updates, optional `best_bid_ask` events, and text `PING`/`PONG`. The dashboard renders bid and ask
as step functions. Obsolete experimental overlays, controls, training endpoints, and artifacts have been
removed.

The process remains simulation-only. Any profitability or stability claim requires fresh out-of-sample and forward evidence.
