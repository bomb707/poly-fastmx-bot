# FastMX current state

_Updated: 2026-09-03 UTC_

- Runtime: local simulation process online on port 4520; PM2 entry currently stopped
- Dashboard: `https://dev-fastmx.polywinbot.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Target wallet: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`
- Active strategy: FastMX (`helpme`) in `engine/strategies/helpme.js`

## Active FastMX policy

The 2026-09-03 entry review tested source ablation, price/timing/threshold/lookback combinations, a 10-share
minimum, one/two-entry limits, and unlimited return-efficiency sizing. None passed all temporal splits while
also preserving 100% replay participation and loss control. The strongest minimum-10 candidate made only
`+$62.16` and lost `-$195.32` in the later segment. Unlimited return sizing made `+$949.12` retrospectively but
lost `-$184.07` later, increased the worst round from `-$10.00` to `-$80.99`, and increased maximum drawdown to
`$1,363.74`. Those candidates are not active. See
`research/FASTMX_ENTRY_SIGNAL_REVIEW_2026-09-03.md`.

An optional ordinary-entry cap (`H_MAX_ENTRY_ORDERS`) and `return-efficiency` sizing implementation now exist,
but both remain inactive in the validated default (`H_MAX_ENTRY_ORDERS=null`, `H_ENTRY_SIZE_MODE=risk-usd`).
The active minimum remains 4 shares; changing it to 10 is not promoted because every tested minimum-10 variant
failed the later-period screen.

The strategy remains simulation-only. The selected policy uses separate UTC signal and sizing regimes while
keeping one global hard-risk envelope:

| UTC session | CLOB velocity | Binance velocity | Trend | Gap agree | Entry/reversal target | Reversal | Cooldown |
|---|---:|---:|---:|:---:|---:|:---:|---:|
| Asia 00–07 | 3s / $0.02 | 12s / $10 | 60s / 0.10% | off | $2 / $2 | off | 10s |
| Europe 07–13 | 5s / $0.02 | 8s / $10 | 30s / 0.05% | off | $4 / $4 | 1s confirmed | 5s |
| US 13–21 | 8s / $0.03 | 8s / $10 | 30s / 0.05% | on | $2 / $2 | off | 15s |
| late-US 21–24 | 3s / $0.02 | 5s / $10 | 15s / 0.05% | off | $2 / $2 | 1s confirmed | 15s |

CLOB velocity is `mid(now) - mid(at-or-before now-lookback)`, where midpoint is `(best bid + best ask) / 2`.
Binance velocity is the raw-dollar spot move over its causal lookback. Binance trend is
`100 × (spotNow - spotPrior) / spotPrior`; it is a regime/filter, not an independent direction source.
Normal signal entry is active from second 60 through 239. Opposing signals only reverse in the Europe and late-US
profiles, and only while CLOB direction, Binance velocity, strong Binance trend, and spot versus the window open
continuously agree for 1,000ms. The separate pair-edge filter is off because it rejected reversals that improved
both fit and holdout; the post-order worst-settlement-loss constraint remains mandatory.

Normal and reversal order size is dynamic: the session target is divided by the worst-price cap to obtain exact
shares. Europe uses $4; the other sessions use $2. A
single order is capped at 100 shares; a round is capped at 500 gross shares, $250 cost, $10 modeled loss in its
worse settlement, and four signal/fallback orders. An untouched round begins $1 minimum-risk attempts at second
90, retrying until second 299. This produced fills in every available historical replay round; it guarantees order
attempts in operation, not an exchange fill when data, connectivity, or liquidity is unavailable. The session
circuit breaker remains `-$25`.

At second 270, an eligible losing/opposite token receives two resting post-only GTC bids at $0.02 and $0.01 only
while its ask remains above both prices. The combined allocation is $2 (at least 50 and 100 shares to satisfy the
$1 per-order minimum). The ladder is skipped unless complete fills at both levels preserve a 25-share lead on the
currently predicted winner and pass every global risk limit. The simulator models 130ms maker arrival and a
250ms touch interval; a bid that would cross when it reaches the venue is rejected rather than treated as a maker.

The corrected exact Aug 22–Sep 3 BAPI v2 replay traded all 3,353 rounds with 6,516 fills: 1,976 wins, 1,377 losses,
`+$279.44` P&L, `$20,520.72` cost, and `$264.94` maximum drawdown. Average cost was `$6.1201` per round and the
maximum observed loss was exactly `$10.00`. The Aug 31–Sep 3 segment remained `-$83.24`; it was inspected for the
Europe sizing decision and is no longer a sealed holdout. This is not proof of future profitability. The passive
rescue ladder still has no credited P&L. See `research/FASTMX_SIZING_AND_LOSS_AUDIT_2026-09-03.md`, the generated
loss CSV, and `research/fastmx-loss-cause-analysis.mjs`.

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
