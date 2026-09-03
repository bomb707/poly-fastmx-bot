# FastMX current state

_Updated: 2026-09-03 UTC_

- Runtime profile: `poly-fastmx-simulation`; no matching PM2 process was running at final verification
- Dashboard: `https://dev-fastmx.polywinbot.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Target wallet: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`
- Sole FastMX runtime strategy: `target75cc`, in `engine/strategies/target75cc.js`
- Retired offline baseline: `helpme`, retained only for historical research

FastMX now runs `target75cc` as its only runtime policy. It removes fixed-seven-share execution and the old momentum release chain, independently evaluating the next unused executable one-cent cell on both Up and Down menus using a frozen causal public-feature model. The validation-selected defaults are release score 0.900, 250ms evaluation cadence, 4,000ms cooldown, and one use per side/cap cell from T+4 through T+286.

After release selection, a causal trend/noise model estimates the selected side's win probability. The release cutoff remains globally fixed at 0.900, but the minimum entry probability is now selected by the market window's fixed UTC session: 00–04 `0.500`, 04–08 `0.750`, 08–12 `0.650`, 12–16 `0.500`, 16–20 `0.500`, and 20–24 `0.725`. Every session still requires nonnegative edge after ask price and modeled fee. Fixed UTC bins make live and replay behavior identical across daylight-saving changes. The runtime records continuation, temporary-noise, pullback-entry, possible-reversal, confirmed-reversal, or uncertain state. Accepted decisions retain the existing residual and partial-versus-cross trees, but fee-adjusted confidence scales the residual only downward from 1.00× toward 0.50×. The signed-order range remains 5–227 shares, cross cutoff 0.485064, and planned gross ceiling 300 shares. Orders remain fixed-USDC marketable FAK BUY intents, matching the observed target encoding at the level public data supports.

The complete implemented decision path, feature groups, inventory equations, execution semantics, gate names, and known boundary behavior are documented under [Current implemented FastMX strategy — exact runtime logic](TARGET_WALLET_STRATEGY_ANALYSIS.md#current-implemented-fastmx-strategy--exact-runtime-logic).

Those numbers have explicit provenance: 0.900/4,000ms/one-use and 0.485064 are fitted model-policy values; 250ms is engine resolution; T+4..286 is the frozen search support; five shares is the observed order floor; 227 and 300 are local model/risk clamps; and FAK, 520ms latency, and the session stop are assumptions or safeguards. None is evidence that the private target code contains the same named parameter. The dashboard and persisted schema now contain only this policy's controls.

Sizing/transition artifacts retain source hashes in `engine/strategies/target75cc-model.js`; the observable release model and discovery/evaluation hashes are frozen in `engine/strategies/target75cc-release-model.js`. The trend/noise feature extractor and frozen model are in `engine/strategies/target75cc-regime-features.js` and `engine/strategies/target75cc-regime-model.js`. The selected context-plus-token-path model reached validation/holdout AUC 0.8124/0.8182. Direct Binance/TWAP/basis and depth-pressure feature groups were rejected because they worsened validation log loss; two small composite trend scores still blend token, Binance, and TWAP movement.

This is not an exact target clone. Discovery holdout autonomous timing parity is 19.345% precision, 32.837% recall, and 24.347% F1; frozen partial OOS is 18.769% / 31.323% / 23.473%. The prior runtime replay lost $1,932.78 on 1,508 complete discovery markets and $1,190.50 on 1,651 partial-OOS markets. The global-0.50 trend/noise gate reduced those results to -$137.89 and -$33.85. The session policy was selected using Aug 20–24 train plus Aug 25 validation only; on Aug 26 holdout it improved PnL from +$37.95 to +$49.37 and drawdown from $32.53 to $26.94, while partial OOS improved from -$33.85 to +$52.52 with profit factor 1.0563. Partial-OOS drawdown increased modestly from $91.45 to $95.60, and 47 of the 48 holdout windows in the 04–08 UTC bin lack complete coherent L2 data, so execution remains hard-locked to simulation. The session result is reproducible in `research/wallet-75cc/results/session-entry-confidence-2026-09-02.md`; the base trend/noise evidence remains in `research/wallet-75cc/results/trend-noise-reversal-2026-09-02.md`.

## Retired Helpme baseline (offline research only)

The FastMX candidate/baseline exposes two direction-source toggles and the `poly-mom-bot` Binance trend-regime toggle. CLOB midpoint velocity uses
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
must agree with Binance spot versus the five-minute Binance open. Its code default is off.
In the Helpme baseline, every distinct qualified signal aligned with flat/current inventory creates a seven-share entry. Two independent
opposite-signal controls are available: partial hedge retains at least a one-share old-side lead, while reversal
requires CLOB + Binance fast momentum + strong trailing trend + window-gap confirmation, crosses only an old
imbalance up to 25 shares, and targets a ten-share new-side residual. Inventory orders are exact-share sized and
force live GTC plus immediate remainder cancellation. Both controls default off because partial hedging degraded
fit and holdout, while reversal improved holdout but failed fit. Executable-duration, cap-cell, order-count, and
per-window inventory-loss branches remain removed. Cooldown remains the sole release throttle at `1000` ms.
The external session circuit breaker remains at `-$25`.
Chainlink, ask differentials, imbalance, microprice, and weighted scores are not direction gates.

The checked-in PM2 profile runs `target75cc` with the frozen two-sided-menu defaults listed above. FastMX cannot select Helpme at runtime; opposite-side behavior comes from the frozen transition model.

Each simulated/backtested automatic BUY is a fixed-USDC FAK: `budget = signed cap × minimum shares`. Modeled matching is delayed 520 ms,
walks the future visible L2 ladder, can receive more shares through price improvement, books partials at actual
VWAP, and cancels any unspent remainder.

Real execution remains disabled in the PM2 process, but the isolated live executor was production-probed on
August 27. It now reads market-specific tick/minimum constraints, signs a true fixed-USD CLOB V2 market order
for FAK, prewarms that signer path, computes and fsync-journals the deterministic order ID before POST in the
probe harness, and maintains a renewable two-socket HTTPS reserve. The dashboard's **live order type** selector
chooses GTC with immediate unfilled-remainder cancellation or FAK and persists across restarts; FAK is the target-policy default,
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
