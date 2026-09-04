# Lockstep active profitability validation — 2026-08-24

## Status

`NOT YET CONFIRMED STABLE` is the current result.

All active execution research uses maker `130ms` from decision to queue and taker `520ms` from decision to fill. The main Lockstep PM2 bot remains in `simulation` mode. The v13b and v14 forward monitors are research-only and cannot submit CLOB orders.

## Unchanged market feeds

- Binance spot remains the `aggTrade` WebSocket feed, with the Binance spot aggregate-trades REST source used for the window-open price.
- Chainlink spot remains Polymarket RTDS.
- The five-minute Polymarket crypto-price request retains `twapEnabled=true` and `twapLookbackSeconds=60`.
- The passive v13b candidate does not replace either spot feed; its entry and hedge decisions use public CLOB complete-set economics and own inventory.

## Corrected full-depth corpus

The current replay covers `2026-08-14T00:00:00Z` through the latest archived Aug 24 window:

- 2,920 discovered windows;
- 2,869 usable full-depth v4 windows;
- 51 windows rejected for insufficient aligned ticks (1.75%);
- exact normalized market-wide public taker prints;
- maker queue arrival at 130ms and taker book execution at 520ms;
- strict chronological ordering of public maker prints before later executable snapshots;
- equal-time maker arrival and cancel boundaries excluded from fills;
- FIFO, volume-conserved public trade allocation after visible queue ahead;
- post-only maker arrival checks and exact crypto taker fees.

Compact-book results are excluded from strategy selection because an overlap audit found material sampling bias versus raw full-depth books.

## Frozen v13b challenger

The historical candidate in `passive-maker-maker130-selected-v13.json`:

- quotes post-only buys on both outcomes only when the two best bids total at most `$0.88`;
- uses five-share orders with at most ten shares per outcome (two cycles);
- quotes from `t+5s` through `t+150s`;
- maker TTL is 500ms plus the modeled 500ms cancel acknowledgement;
- after imbalance, taker-completes only under a fee-inclusive pair cap of `$0.97`;
- after five seconds unpaired, uses a bounded `$1.01` completion or liquidates excess inventory;
- credits the documented 20% crypto maker rebate separately from trading PnL.

At the exact 130ms maker and 520ms taker timings:

| FIFO credit | PnL | PF | drawdown | window lower 95% | day lower 95% | positive dates | active windows |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 7.5% | +$11.277 | 1.873 | $3.005 | +$0.264 | +$5.000 | 10/11 | 108 |
| 10% | +$12.463 | 2.014 | $2.638 | +$2.137 | +$5.711 | 10/11 | 108 |

The five equal-window chronological PnLs are:

- 7.5% credit: `+$3.356, +$2.999, +$4.219, +$0.064, +$0.640`;
- 10% credit: `+$1.945, +$5.166, +$4.458, +$0.041, +$0.853`.

The economics remain a paired-edge-versus-residual-risk tradeoff. At 7.5% credit, paired PnL is `+$23.673`, residual PnL is `-$13.513`, and modeled maker rebate is `+$1.118`.

Polymarket currently documents zero maker fees, a 20% crypto maker rebate pool, and fee-curve-weighted allocation using the same `0.07 × p × (1-p)` curve. The percentage can change, so zero-rebate results remain a required sensitivity rather than being hidden inside trade costs: [Maker Rebates Program](https://docs.polymarket.com/programs/maker-rebates), [Fees](https://docs.polymarket.com/trading/fees).

## Why this is not stable yet

- The newly downloaded-window 7.5% bootstrap lower bound is `-$1.119` even though all five new-window folds are positive.
- A 200ms maker-arrival jitter stress fails, while 130ms and 300ms cells differ materially; public one-second print timestamps and subsecond queue snapshots create phase sensitivity.
- The adjacent three-second timeout loses its 7.5% aggregate bootstrap gate under 20,000 samples.
- A Binance-plus-Chainlink aligned residual-hold branch changes only a few fills and does not repair the 200ms stress; it is rejected.
- A latency-adaptive 300ms maker TTL repairs the 200ms row but fails the 300ms and 520ms rows; it is rejected.
- A queue-qualified exception to the v14 balanced-inventory cap raises activity to 46–123 windows, but restores negative late folds and negative window/day lower-95 bounds at 200ms; queue minima 5/10/20/50 are rejected.
- The historical candidate was selected during research. It therefore needs a fresh, untouched forward cohort before any stable-profit claim.
- No strategy can guarantee profit in every future window or day.

## Forward paper gate

PM2 process `poly-lockstep-maker-research-v13b` records a frozen cohort beginning `2026-08-24T11:35:00Z` into `data/passive-maker-forward-v13b`. It executes the immutable `passive-maker-walkforward-v13.mjs` copy, so continued experimental work cannot change the cohort's engine.

The monitor requires all of the following before its state can pass:

- exact SHA-256 matches for policy, replay, fill allocator, collectors, fold logic, and monitor;
- 30 elapsed days and all three predeclared ten-UTC-date folds complete and positive at both 7.5% and 10% credit;
- at least 95% expected-window coverage and no more than 5% failed windows;
- at least 100 active windows;
- positive aggregate PnL and window lower-95 bound in both credit stresses;
- profit factor at least 1.25, at least 80% positive represented dates, and drawdown no more than 5% of gross buy spend;
- maker 130ms, taker 520ms, exact-price attribution, valid five-share orders, fees charged, and bounded taker pair completion.

The earliest 30-day duration gate is `2026-09-23T11:35:00Z`. Until every gate passes, v13b is a challenger only and real execution remains disabled.

## Frozen v14 structural challenger

The v14 candidate adds one causal order-admission invariant to v13b: while actual Up/Down inventory is still balanced, asymmetric outstanding orders may not cause a new quote when the two visible best bids exceed the existing `$0.88` pair-entry cap. The restriction applies only to pending/rejecting/cancelling quote imbalance. Once a real maker fill creates inventory imbalance, the bounded hedge lifecycle remains unrestricted by this veto.

The selected v14 cap is not an independently optimized threshold: `balancedInventoryPairBidCap` is exactly equal to the existing `pairQuoteCap` of `$0.88`. A broad `$0.88–$0.96` neighborhood was also evaluated.

At 130ms maker arrival:

| FIFO credit | PnL | PF | drawdown | window lower 95% | day lower 95% | active windows |
|---:|---:|---:|---:|---:|---:|---:|
| 7.5% | +$10.438 | 9.766 | $0.981 | +$3.229 | +$3.326 | 26 |
| 10% | +$11.869 | 21.040 | $0.382 | +$4.676 | +$3.939 | 26 |

The same strict `$0.88` cap repairs the former 200ms jitter failure:

| FIFO credit | PnL | PF | drawdown | window lower 95% | day lower 95% | active windows |
|---:|---:|---:|---:|---:|---:|---:|
| 7.5% | +$10.692 | 9.979 | $0.981 | +$4.244 | +$2.623 | 34 |
| 10% | +$13.424 | 23.664 | $0.382 | +$5.960 | +$4.445 | 34 |

All tested aggregate cells across maker arrival `130/200/300/520ms`, FIFO credit `7.5/10%`, and balanced-inventory caps `$0.88/$0.92/$0.94/$0.96` are positive with PF above 1.25. Every 200–520ms selected-cap cell also has positive window and day lower-95 bounds. On the independent 2,146-window partition, the selected v14 policy earns `+$10.442` at 7.5% credit and `+$11.805` at 10% credit, with positive window and day bounds.

This does not establish stable profit. At 130ms, the five full-corpus fold activity counts are `9, 11, 5, 0, 1`; the independent partition's final fold has zero active windows. Some 300ms/520ms tail-fold PnLs are also slightly negative. V14 therefore demonstrates substantially better adverse-selection control, but current-regime activity and untouched forward expectancy remain unproven.

PM2 process `poly-lockstep-maker-research-v14` records a separately frozen cohort beginning `2026-08-24T12:25:00Z` into `data/passive-maker-forward-v14`. Its 11-file manifest pins the policy, immutable replay, FIFO allocator, collectors, fold logic, and monitor. The earliest 30-day duration gate is `2026-09-23T12:25:00Z`. V13b remains online as an unchanged comparator.

## Evidence artifacts

- `data/research/passive-maker-maker130-latency-stress-grid.json`
- `data/research/passive-maker-maker130-q088-t3-candidate.json`
- `data/research/passive-maker-maker130-candidate-500-5-full-depth-corrected.json`
- `research/passive-maker-walkforward-v13.mjs`
- `data/research/passive-maker-forward-v13b-state.json`
- `data/research/passive-maker-balanced-inventory-pair-cap-maker130.json`
- `data/research/passive-maker-balanced-inventory-pair-cap-maker200.json`
- `data/research/passive-maker-balanced-inventory-pair-cap-latency-stress.json`
- `data/research/passive-maker-balanced-tight-queue-grid.json`
- `research/passive-maker-maker130-selected-v14.json`
- `research/passive-maker-walkforward-v14.mjs`
- `data/research/passive-maker-v14-validation.json`
