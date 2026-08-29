# Lockstep stop-90 challenger — 2026-08-25

## Status

The 90-second entry cutoff is retained as a **paper challenger**, not promoted to the runtime bot.
The deployed paper candidate remains frozen at 120 seconds so its forward cohort stays honest.

## Identical-cohort comparison

All policies were replayed over `2026-08-16T00:00:00Z` through
`2026-08-25T00:05:00Z` with native v2 full depth, v4 full depth, Gamma outcomes, 130 ms maker
queue latency, and 520 ms taker fill latency.

| Cutoff | Source | Active | PnL | Profit factor | Max drawdown | Fixed folds |
|---|---|---:|---:|---:|---:|---|
| 120s | v2 | 64 | +$13.92 | 1.590 | $9.38 | +$5.97 / +$2.57 / +$5.39 |
| 120s | v4 | 60 | +$14.82 | 1.723 | $6.38 | +$7.00 / +$0.03 / +$7.79 |
| **90s** | **v2** | **49** | **+$11.85** | **1.716** | **$7.23** | **+$3.71 / +$3.52 / +$4.62** |
| **90s** | **v4** | **50** | **+$12.38** | **1.739** | **$6.38** | **+$5.73 / +$2.34 / +$4.31** |
| 60s | v2 | 24 | +$5.36 | 1.645 | $4.27 | +$0.56 / +$6.04 / **-$1.25** |
| 60s | v4 | 29 | +$8.51 | 2.002 | $4.39 | +$1.83 / +$6.37 / +$0.31 |

The 60-second policy is rejected because it is too sparse, diverges substantially by source, and
loses its final v2 chronological block. The 90-second policy sacrifices headline PnL but improves
the worst middle fold, profit factor, entry accuracy, and v2 drawdown. Its 49–50 active windows are
still too few for promotion.

## Continuing evaluation

The daily PM2 research process now explicitly replays both frozen 120-second and 90-second policies,
independent of the dashboard's mutable configuration. A separate research-only stop-90 forward
cohort begins at `2026-08-25T01:30:00Z`. Its manifest pins the policy, replay engine, strategy, and
fold logic by SHA-256. The monitor cannot import the live order executor or submit orders.

Stable profit remains unconfirmed until the forward gate passes independently on v2 and v4.
