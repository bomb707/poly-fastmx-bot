# Passive-maker v25 validation — 2026-08-25

## Decision

Do **not** promote v25. Partial-fill cancellation materially improves the
low-fill-credit tail, but the candidate does not pass the complete stress and
immediate-neighbor gates. It remains a historical research candidate only.

The production PM2 bot was not switched to this policy. Frozen v17 continues
unchanged in its separate research-only forward cohort.

## Causal policy tested

- Post-only residual maker; one-cent repricing threshold.
- 5-share target, 750 ms maker TTL, 500 ms cancellation latency.
- Cancel same-side outstanding orders after a partial residual fill.
- Chainlink/Binance residual fair value with current CLOB probability.
- Maximum spot/market probability disagreement: 0.400.
- No automatic hedge, forced terminal liquidation, or taker fill.
- Maker target latency 130 ms; 200 ms stress; trading disabled above 250 ms.
- Taker latency fixed at 520 ms, though this policy generated zero taker fills.
- Maker rebate fixed at zero.

Decisions use only information available at the historical decision time.
Maker fills require exact-price public market taker prints to consume visible
queue ahead. Fill volume is FIFO and conserved across simulated orders.

## Authoritative replay coverage

| Reconstruction | Discovered | Loaded | Rejected |
|---|---:|---:|---:|
| V2 primary / V4 confirmation | 2,712 | 2,478 | 234 |
| V4 primary / V2 confirmation | 2,712 | 2,664 | 48 |

Range: `2026-08-16T00:00:00Z` through the frozen forward boundary
`2026-08-25T12:55:00Z`.

V2 and V4 are alternative executable-book reconstructions. Their PnL must
never be added together.

## Conservative 2.5% fill-credit stress

| Source | Maker latency | Active windows | Spend | PnL | ROI | Window 95% lower | Daily 95% lower | Max DD | PF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V2 | 130 ms | 100 | $101.93 | +$24.55 | 24.08% | +$1.63 | +$5.83 | $7.16 | 1.81 |
| V2 | 200 ms | 88 | $93.54 | +$23.96 | 25.61% | +$1.59 | +$4.13 | $6.85 | 1.89 |
| V4 | 130 ms | 99 | $114.66 | +$27.79 | 24.24% | +$2.06 | +$2.57 | $7.26 | 1.78 |
| V4 | 200 ms | 94 | $104.80 | +$28.65 | 27.33% | +$4.42 | +$5.40 | $6.87 | 1.94 |

All twelve chronological fold totals in these four cells are positive. There
are zero taker fills, zero maker rebates, and 122–191 exercised partial-fill
cancellation triggers. At 300 ms, all eight kill-switch cells have exactly
zero placements, fills, spend, and PnL.

## Nominal focus versus frozen v17

At 130 ms and 7.5% fill credit, v25 improves historical PnL on both source
orientations but increases drawdown:

| Source | v25 PnL | PnL delta | v25 max DD | DD delta | Active-window delta |
|---|---:|---:|---:|---:|---:|
| V2 | +$45.19 | +$7.29 | $10.08 | +$0.94 | +21 |
| V4 | +$47.29 | +$3.04 | $8.68 | +$1.99 | +20 |

V2 therefore misses the strict `$10` drawdown cap. The 10% credit V2 cell
also reaches `$10.89` drawdown.

## Immediate-neighbor audit

Each policy below is evaluated over V2/V4 and 130/200 ms at 2.5% conserved
fill credit. A pass requires positive PnL, window and daily bootstrap lower
bounds, all chronological folds positive, PF at least 1.5, drawdown at most
`$10`, at least 75 active windows, zero takers/rebates, and exercised partial
cancellation in every cell.

| Policy | Result | Worst window lower | Worst daily lower | Max DD | Worst fold |
|---|---|---:|---:|---:|---:|
| Center: TTL 750 / cap .400 / reprice 1 | Pass | +$1.60 | +$2.25 | $7.26 | +$3.58 |
| TTL 700 | Fail | -$3.36 | -$3.62 | $9.39 | +$3.07 |
| TTL 800 | Pass | +$0.40 | +$2.59 | $9.00 | +$2.40 |
| Disagreement cap .375 | Fail | -$0.59 | +$2.28 | $8.25 | +$2.20 |
| Disagreement cap .425 | Pass | +$0.86 | +$1.42 | $7.56 | +$3.58 |
| Reprice 2 ticks | Fail | -$7.00 | -$2.51 | $10.34 | -$1.76 |

The configured zero-tick reprice case is equivalent to the one-tick minimum in
the replay engine and is not an independent lower neighbor.

## Frozen forward status

At the 18:01 UTC checkpoint, frozen v17 has approximately five hours of fresh
post-freeze evidence:

- V2: 2 active windows, `+$4.85`.
- V4: 2 active windows, `+$3.01`.

This is directionally positive but statistically insufficient: the window
bootstrap lower bound is still zero and the minimum-duration/activity gates are
not met. It is not evidence of guaranteed or stable profit.

## V26 upper-plateau follow-up

V26 tests whether the passing upper-side neighbors form a plateau centered on
TTL 800 ms and disagreement cap 0.425. It also fails promotion:

- The center's V2 200 ms window lower bound is `-$0.09`.
- TTL 850 ms fails both reconstructions; V2 200 ms falls to `+$10.95` PnL,
  `-$13.41` window lower, `-$6.76` daily lower, PF `1.30`, and a negative
  first chronological fold.
- Disagreement cap 0.450 retains positive PnL/folds but its V2 200 ms window
  lower bound is `-$0.48`.
- The cap-0.400/TTL-800 cell passes, but the adjacent 0.425 and TTL-850 cells
  do not, so this is not a robust local plateau.

The v25/v26 partial-cancellation branch is therefore closed without a freeze.
Further historical parameter search on the same boundary would add overfit
risk. The next admissible evidence is the untouched frozen-v17 forward cohort
or a materially different causal model with predeclared gates.
