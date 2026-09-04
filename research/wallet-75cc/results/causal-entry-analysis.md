# Conservative target-wallet entry-direction analysis

Generated: 2026-09-04T16:15:00.003Z

## Design

- Wallet: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`
- Evidence: exact BAPI v2 L2 replays for 376/429 target BTC windows
- Split: September 3 discovery; September 4 chronological holdout at `2026-09-04T00:00:00.000Z`
- Clock rule: features end 1000 ms before the wallet's reported whole-second timestamp
- No parameter, threshold, weight, lookback, or feature-combination search is performed
- 95% intervals resample whole market windows, not correlated actions

## Descriptive wallet behavior

On September 4, the target bought both outcomes in 123/184 traded markets (66.85%) and made 331 observed side-to-side action transitions. This confirms that a one-direction-per-market bot is structurally different from the target; it does not identify the target's hedge or sizing rule.

## September 4 holdout — all target actions

| Predeclared signal | Direction agreement (95% cluster CI) | Usable actions | Coverage |
|---|---:|---:|---:|
| CLOB Up midpoint change, 3s | 92.62% (90.55%–94.67%) | 827 | 97.18% |
| CLOB Up midpoint change, 5s | 93.27% (91.18%–95.18%) | 832 | 97.77% |
| Binance BTC spot change, 3s | 93.86% (92.08%–95.57%) | 782 | 91.89% |
| Binance BTC spot change, 5s | 93.47% (91.28%–95.47%) | 796 | 93.54% |
| CLOB Up midpoint minus 0.50 | 83.43% (79.87%–86.89%) | 851 | 100.00% |
| Binance spot minus window open | 77.92% (73.89%–81.65%) | 847 | 99.53% |
| Chainlink change, 3s (control) | 60.52% (56.08%–64.99%) | 803 | 94.36% |
| Binance change minus Chainlink change, 3s (control) | 88.19% (85.73%–90.51%) | 847 | 99.53% |
| CLOB Up top-3 bid/ask depth imbalance (control) | 40.31% (36.86%–43.57%) | 841 | 98.82% |
| CLOB 3s and Binance 3s agree | 97.43% (96.35%–98.50%) | 700 | 82.26% |

## September 4 holdout — first target action per market

| Predeclared signal | Direction agreement (95% cluster CI) | Usable markets | Coverage |
|---|---:|---:|---:|
| CLOB Up midpoint change, 3s | 93.80% (89.92%–97.67%) | 129 | 96.99% |
| CLOB Up midpoint change, 5s | 93.80% (89.15%–97.67%) | 129 | 96.99% |
| Binance BTC spot change, 3s | 96.55% (93.10%–99.14%) | 116 | 87.22% |
| Binance BTC spot change, 5s | 92.50% (87.50%–96.67%) | 120 | 90.23% |
| CLOB 3s and Binance 3s agree | 98.13% (95.33%–100.00%) | 107 | 80.45% |

## Timestamp sensitivity — September 4 holdout

| Pre-event offset | CLOB 3s | Binance 3s | Both agree |
|---:|---:|---:|---:|
| 500 ms | 88.78% (86.35%–90.96%) | 91.99% (90.08%–93.86%) | 95.40% (93.94%–96.83%) |
| 1000 ms | 92.62% (90.47%–94.76%) | 93.86% (92.14%–95.47%) | 97.43% (96.29%–98.53%) |
| 1500 ms | 92.78% (90.55%–94.86%) | 93.59% (91.76%–95.32%) | 97.40% (96.11%–98.53%) |

## Interpretation

CLOB midpoint velocity and Binance spot velocity remain the strongest predeclared directional correlates if their holdout accuracy and intervals exceed the controls. Agreement between them is stronger evidence of direction than either signal alone.

This cannot establish which feed the wallet actually reads: CLOB and Binance co-move, the sample is conditioned on times when the wallet traded, and a public trade timestamp may follow the wallet's private decision. It also does not recover the release trigger or token sizing. Those require evaluating candidate signals at every eligible timestamp, including non-entry times, on a later untouched period.

