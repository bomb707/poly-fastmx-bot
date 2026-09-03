# Session release-threshold replay — 2026-09-03

The active release model was replayed on 3,399 settled BTC five-minute BAPI v2 coherent-L2 windows from 2026-08-20 00:00 UTC through 2026-09-03 01:10 UTC. Matching uses the runtime assumptions: 520 ms latency, visible-depth fixed-USDC FAK fills, modeled taker fees, 4,000 ms cooldown, one use per side/cap cell, the current UTC entry-confidence schedule, and confidence-scaled residual sizing.

The release-model coefficients were not refit. A wider-cutoff winner model trained on 41,713 candidate fills failed its untouched holdout (validation-selected filter P&L `-$38.13`; holdout AUC `0.7273`) and was rejected.

## Selected policy

Keep the global release base at `0.900`. Apply a `-0.015` offset only during 04:00–08:00 UTC, producing an effective cutoff of `0.885`. All other UTC sessions remain at `0.900`. The session was selected because 0.885 improved both train and validation P&L relative to 0.900. Holdout and later OOS were excluded from selection.

| Split | Markets | Global 0.900 P&L | Session policy P&L | Global traded | Session traded |
|---|---:|---:|---:|---:|---:|
| Train: Aug 20–24 | 983 | -$111.00 | -$99.53 | 463 | 483 |
| Validation: Aug 25 | 284 | +$73.94 | +$77.29 | 138 | 141 |
| Holdout: Aug 26 | 241 | +$49.37 | +$49.37 | 115 | 115 |
| OOS: Aug 27–Sep 3 partial | 1,891 | +$82.34 | +$85.58 | 891 | 925 |
| Full observed cache | 3,399 | +$94.65 | +$112.71 | 1,607 | 1,664 |

Full-period participation rises from `47.28%` to `48.96%` (+57 traded markets, +104 fills). Profit factor changes from `1.0461` to `1.0532`, modeled maximum settlement drawdown from `$153.17` to `$143.48`, and worst-market P&L remains `-$19.40`.

## Rejected broad relaxation

With the same 4-second runtime cooldown, lowering the release cutoff globally to 0.875 raised participation to 65.28% but produced `-$301.05`, profit factor `0.9042`, and `$395.36` maximum drawdown. Lowering the cutoff is therefore not a safe general solution to skipped rounds.

Coverage is 3,399 of 4,046 expected windows (84.01%). In particular, only one complete Aug 26 holdout window exists in the 04:00–08:00 UTC bin, so the policy remains simulation-only and needs additional forward monitoring.
