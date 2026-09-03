# Release BTC/CLOB and target-share audit — 2026-09-03

## Decision

Do not replace the frozen runtime release model with the finer BTC/CLOB candidate. The candidate gives BTC and CLOB substantially more model capacity and slightly improves pair ranking, but it reduces the chronologically selected autonomous timing F1 on both validation and untouched holdout. The production model and policy remain unchanged.

The more material weakness is the separate residual-share model: it is accurate near the median but under-identifies large target-wallet residuals. This should be addressed with a tail-aware sizing model, not by forcing larger release-model coefficients.

## Release-model feature allocation

Coefficient L1 is only a diagnostic because correlated and duplicated columns can redistribute weight; it is not causal feature importance. On standardized columns it nevertheless shows the intended change:

| Model | Features | CLOB L1 | BTC L1 | CLOB + BTC share of total L1 |
|---|---:|---:|---:|---:|
| Frozen runtime | 59 | 3.6475 | 0.7443 | 56.7% |
| Fine BTC/CLOB candidate | 103 | 5.9022 | 2.0241 | 71.3% |

The candidate adds directional Binance-open-gap hinge bands at 0.025%, 0.05%, 0.10%, and 0.20%. It expands CLOB midpoint/ask/bid/spread/depth-pressure and Binance moves to causal 0.5, 1, 2, 3, 5, 10, 15, 30, and 60 second horizons. TWAP and basis retain the coarser existing horizons.

## Chronological release results

The model was trained before 2026-08-25, selected on 2026-08-25, and evaluated on the untouched 2026-08-26 holdout.

| Metric | Frozen runtime | Fine BTC/CLOB | Change |
|---|---:|---:|---:|
| Validation pair AUC | 0.865147 | 0.867446 | +0.002299 |
| Holdout pair AUC | 0.867988 | 0.868830 | +0.000842 |
| Validation top-1 | 15.907% | 15.827% | -0.080 pp |
| Holdout top-1 | 11.377% | 12.176% | +0.799 pp |
| Validation autonomous timing F1 | **24.007%** | 23.510% | -0.497 pp |
| Holdout autonomous timing F1 | **24.347%** | 23.699% | -0.648 pp |
| Holdout side accuracy within timing matches | 90.030% | **91.513%** | +1.483 pp |

The fine candidate's validation-selected policy changed from one to two uses per cap cell. Despite slightly better conditional side accuracy, it emitted fewer matched releases and lost timing F1. That is insufficient evidence for runtime promotion.

## Target-wallet share model

The wallet evidence supports a residual target rather than a constant order size:

```text
signed shares = max(5, round(target residual - current oriented inventory))
```

An opposing action is separately classified as either a partial hedge, which retains a residual on the old side, or a cross, which creates a residual on the new side. The runtime mirrors this structure with `RESIDUAL_TREE` and `CROSS_TREE`.

The frozen residual model's chronological holdout has 2,188 actions:

| Statistic | Actual wallet residual | Predicted residual |
|---|---:|---:|
| p25 | 5.49 | 7 |
| p50 | 10.28 | 9 |
| p75 | 20 | 13 |
| p90 | 37.79 | 28 |

- Median absolute error is 3.45 shares versus 7.40 for a constant-median baseline.
- Exact size-tier accuracy is 52.70%.
- For residuals of at least 16 shares, precision is 85.80% but recall is only 57.12%.
- The cross classifier has holdout AUC 0.7929, 72.84% accuracy, 71.32% precision, and 83.14% recall. Its 117 false positives can incorrectly cross onto the losing side; its 59 false negatives can leave too much inventory on the obsolete side.
- Runtime confidence sizing scales the residual tree to 0.50x–1.00x. It reduces loss and drawdown in prior validation, but also compounds the residual model's large-size underprediction.

## Recommended next sizing model

Use a two-stage, chronologically fitted sizing policy:

1. Predict whether the required residual is at least 16 shares with a recall-aware classifier.
2. Predict conditional residual quantiles (median and upper quantile) rather than one leaf median.
3. Use the upper quantile only when the causal winner probability, after-fee edge, and path stability all clear frozen validation thresholds; otherwise use the median or abstain.
4. Optimize the final choice on complete-path PnL and drawdown, not share-imitation error alone, because copying a large target order does not prove that the same size is economical for this bot.

A meaningful accepted-side floor can be tested, but it cannot guarantee that the held side will be the eventual winner. A universal large-share floor would enlarge exactly the wrong-side losses the regime layer currently suppresses.

## Reproduction

```bash
W75CC_CAP_FEATURE_SET=fine-btc-clob \
  node research/wallet-75cc/fit-observable-cap-policy.mjs \
  data/wallet-75cc/exact-2026-08-20_2026-08-27 \
  data/wincache \
  data/wallet-75cc/exact-2026-08-20_2026-08-27/fine-btc-clob-candidate/observable-cap-policy-model.json

W75CC_CAP_FEATURE_SET=fine-btc-clob \
  node research/wallet-75cc/evaluate-observable-menu.mjs \
  data/wallet-75cc/exact-2026-08-20_2026-08-27 \
  data/wincache \
  data/wallet-75cc/exact-2026-08-20_2026-08-27/fine-btc-clob-candidate/observable-menu-evaluation.json \
  data/wallet-75cc/exact-2026-08-20_2026-08-27/fine-btc-clob-candidate
```

