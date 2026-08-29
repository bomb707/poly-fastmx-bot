# Target-wallet order sizing and last-hedge extraction

Strict consensus analysis of 6,025 BTC five-minute actions with 100% decoded signed-order coverage. This is research-only and is not wired into FastMX.

## Core finding: a pre-signed order menu

The target does not appear to calculate a new arbitrary quantity at fire time. 93.645% of decoded orders were signed within 15 seconds of market open, and 87.975% were released at least 20 seconds after signing. For hedge/cross orders specifically, 97.353%/96.237% were released at least 20 seconds later. The fire selects a pre-sized integer-share order at a cent price cap.

For every BUY: `budgetUsd = signedPriceCap * signedMinimumShares`. Actual shares can differ because `filledShares = spentBudget / executionPrice` or because the order partially fills.

## Entry/top-up sizing

The entry size is best represented as a target inventory residual, not a constant order size:

`Q_min = max(5, round(R_target(time, price, confidence) - orientedInventory))`

| Fire time | Actions | Median signed shares | Median post-action residual | Median signed cap |
|---|---:|---:|---:|---:|
| 0-60s | 1209 | 6 | 8 | 0.68 |
| 60-120s | 1070 | 7 | 11.070587 | 0.75 |
| 120-180s | 805 | 8 | 16.753663 | 0.81 |
| 180-240s | 703 | 10 | 23 | 0.88 |
| 240-300s | 401 | 13 | 35.056172 | 0.86 |

The strict held-out residual model has median absolute error 3.446799 shares versus 7.401494 for one constant residual. Its >=16-share precision is 85.802%, but recall is 57.123%; the private tail-sizing state is not fully observable.

## Hedge and cross sizing

An opposite-side signal first creates `I = orientedInventory < 0`. The selected order then implies one of two transitions:

- Partial hedge: `desiredFill = abs(I) - oldSideResidual`. Median old imbalance 18, fill/imbalance ratio 0.506189, and remaining old-side residual 8.21 shares.
- Overhedge-cross: `desiredFill = abs(I) + newSideResidual`. Median old imbalance 6.779089, fill/imbalance ratio 2.379012, and new-side residual 10.444446 shares.

The simple signed-order test `I + Q_min > 0` identifies realized cross versus partial hedge with 91.049% held-out accuracy, 89.674% precision, and 94.286% recall. The remaining errors are mostly price improvement or partial fills moving the realized transition across zero.

This is signal-driven inventory rebalancing, not a guaranteed pair-value hedge: only 28.691% of partial hedges and 28.088% of crosses had reconstructed FIFO pair cost <= $1.

## Last opposite-side action in each market

Across 893 markets with a reversal, the last reversal was a partial hedge in 356 (39.866%) and a cross in 537 (60.134%). It was also the market's final action only 60.246% of the time.

- Last partial hedge: median time 208.393s, signed size 9, and old-side residual 8.991. Its order side ultimately won 60.674%, while the remaining old lean won only 37.921%. This is usually a risk reduction without crossing.
- Last cross: median time 191.578s, signed size 22, and new-side residual 11.003836. Its new side ultimately won 81.378%.

## Extraction boundary

The position arithmetic, fixed-budget encoding, and selected-order branch are recovered. The exact private menu-generation/confidence rule is not: public data exposes only orders that fired. The causal branch classifier reaches held-out AUC 0.792915 and 72.84% accuracy, so this should be treated as an approximation, not a 98% clone. No runtime logic was changed.
