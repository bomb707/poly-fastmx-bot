# FastMX current state

_Updated: 2026-08-27 UTC_

- Runtime: `poly-fastmx-simulation`, online under PM2
- Dashboard: `https://dev-fastmx.polywinbot.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Target wallet: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`
- Active strategy: only `helpme`, in `engine/strategies/helpme.js`

The active policy exposes two direction-source toggles and the `poly-mom-bot` Binance trend-regime toggle. CLOB midpoint velocity uses
`mid(now) - mid(at-or-before now - lookback)`, with `mid = (best bid + best ask) / 2`, a required configurable
lookback fixed at the required `3000` ms default and a fitted absolute threshold of `0.02`. Binance gap momentum uses the dev-tool raw-dollar formula
`(priceNow-open)-(pricePrior-open) = priceNow-pricePrior`, with a three-second lookback and
`$5` minimum. Binance trend uses the `poly-mom-bot` formula
`100 × (current Binance spot - Binance spot 30 seconds earlier) / prior spot`. At `0.05%` or stronger,
a trend-following Binance signal passes normally; an opposing fast signal must also clear `0.075%` on both its fast
clock and a causal 60-second Binance clock in the same direction. Weak/range trend and missing trend history leave
the fast signal unchanged, matching `poly-mom-bot`. Trend is not a standalone direction source and requires Binance
momentum. UI and server validation guarantee at least one fast source is enabled and enforce that dependency.
`H_BINANCE_GAP_AGREE_ON` independently applies the `poly-mom-bot` window-gap rule: selected velocity direction
must agree with Binance spot versus the five-minute Binance open. It is currently off.
Every distinct qualified signal aligned with flat/current inventory creates a seven-share entry. When an opposite
candidate appears, old-side top-ups pause for a three-second reset interval and a bounded exact-share hedge may
immediately reduce the old-side lead without worsening projected worst-case loss. A reversal requires persistent
one-second CLOB + Binance fast momentum + strong trailing trend + window-gap confirmation, a minimum `-0.03`
pair edge, and either a projected worst-case loss no greater than `$10` or a strict reduction from current risk.
It targets a ten-share new-side residual and caps a single reversal order at 50 shares; there is no fixed old-
imbalance exclusion, so larger positions de-risk through partial hedges instead of disabling adaptation. Both
adaptive controls default on. Inventory orders are exact-share sized and force live GTC plus immediate remainder
cancellation. Executable-duration, cap-cell, total-order-count, and total-cost branches remain removed.
Cooldown remains the ordinary release throttle at `1000` ms.
The external session circuit breaker remains at `-$25`.
Chainlink, ask differentials, imbalance, microprice, and weighted scores are not direction gates.

Configured PM2 simulation profile (effective after process restart): CLOB and Binance velocity ON at `3000ms` with `0.02/$5` thresholds,
Binance trend regime ON at `30s/0.05%` with `60s/0.075%` countertrend confirmation, ordinary window-gap
agreement OFF so a qualified counter-move can de-risk inventory before crossing the open, active through
`T+300`, `2000ms` cooldown, and both bounded hedging and confirmed reversal ON.

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

The exact 2,875-window audit of the retired guarded policy is in
`research/wallet-75cc/results/fastmx-execution-final-screen-2026-08-27.json`; it lost `$162.04` after modeled fees.
That result does not validate the new entry-every-signal rule or establish profitability. The process therefore
remains simulation-only.

The paired current-engine hedge/reversal replay is in
`research/wallet-75cc/results/fastmx-inventory-mode-backtest-2026-08-27.md`. On the untouched holdout, partial
hedging changed PnL by `-$599.41` versus entry/top-up-only; reversal changed it by `+$349.28`, but reversal lost
`-$1,389.19` versus entry/top-up-only on fit. Both together lost `-$1,136.67` on holdout. The realized hedge
crossing audit recorded zero violations. These results reject automatic promotion and do not establish profit.

The exact trailing-day retired hard-three-direction audit spans 2026-08-26 11:25 UTC through 2026-08-27 11:25 UTC: 2,210 BTC buys,
1,604 non-simultaneous choices, and 287 complete causal 50 ms feeds. The selected configuration was ranked only on
the first 12 hours. With the required three-second CLOB lookback it matched `98.48%` of eligible target directions
on the untouched final 12 hours at `27.40%` coverage, and `98.55%` over the full day at `30.11%` coverage. Full
splits and Wilson intervals are in `research/wallet-75cc/results/three-signal-last24h-2026-08-27.md`. Those match
figures do not describe the replacement poly-mom trend regime and require a fresh replay before comparison. This is
selective direction agreement at target action times, not 98% market participation, exact release-time cloning, or
proof of profit. The private release state remains unidentified, so frozen forward monitoring is still required.
