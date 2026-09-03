# Session-specific entry-confidence evaluation — 2026-09-02

The policy was selected only from the Aug 20–24 train and Aug 25 validation splits. Aug 26 holdout and Aug 27–Sep 2 partial OOS were not used to choose cutoffs.

## Selected UTC schedule

| UTC hours | Market-session label | Minimum entry probability |
|---|---|---:|
| 00:00–04:00 | Asia morning / US evening | 0.500 |
| 04:00–08:00 | Asia afternoon / US midnight | 0.750 |
| 08:00–12:00 | Europe morning / US premarket | 0.650 |
| 12:00–16:00 | US morning | 0.500 |
| 16:00–20:00 | US afternoon | 0.500 |
| 20:00–24:00 | US evening / Asia open | 0.725 |

## Frozen evaluation

| Split | Global 0.500 PnL | Session PnL | Global drawdown | Session drawdown | Global fills | Session fills |
|---|---:|---:|---:|---:|---:|---:|
| train | -217.24 | -111.00 | 226.97 | 120.74 | 942 | 792 |
| validation | 41.40 | 73.94 | 34.17 | 34.17 | 279 | 229 |
| holdout | 37.95 | 49.37 | 32.53 | 26.94 | 187 | 172 |
| oos | -33.85 | 52.52 | 91.45 | 95.60 | 1320 | 1179 |

Research evaluation checks: **PASS**

Criteria: the runtime schedule must equal the train+validation selection; holdout PnL and drawdown cannot worsen; OOS PnL cannot worsen; OOS PnL must be positive; OOS profit factor must exceed one. These checks do not authorize live execution.

Partial-OOS settlement drawdown increased from 91.45 to 95.60. This was not a declared selection criterion and is reported as a risk caveat.

## Coherent-L2 coverage by split and UTC bin

| Split | UTC hours | Complete / expected | Coverage |
|---|---|---:|---:|
| train | 00:00–04:00 | 130 / 240 | 54.2% |
| train | 04:00–08:00 | 142 / 240 | 59.2% |
| train | 08:00–12:00 | 182 / 240 | 75.8% |
| train | 12:00–16:00 | 179 / 240 | 74.6% |
| train | 16:00–20:00 | 174 / 240 | 72.5% |
| train | 20:00–24:00 | 176 / 240 | 73.3% |
| validation | 00:00–04:00 | 48 / 48 | 100.0% |
| validation | 04:00–08:00 | 47 / 48 | 97.9% |
| validation | 08:00–12:00 | 48 / 48 | 100.0% |
| validation | 12:00–16:00 | 48 / 48 | 100.0% |
| validation | 16:00–20:00 | 45 / 48 | 93.8% |
| validation | 20:00–24:00 | 48 / 48 | 100.0% |
| holdout | 00:00–04:00 | 48 / 48 | 100.0% |
| holdout | 04:00–08:00 | 1 / 48 | 2.1% |
| holdout | 08:00–12:00 | 48 / 48 | 100.0% |
| holdout | 12:00–16:00 | 48 / 48 | 100.0% |
| holdout | 16:00–20:00 | 48 / 48 | 100.0% |
| holdout | 20:00–24:00 | 48 / 48 | 100.0% |
| oos | 00:00–04:00 | 290 / 336 | 86.3% |
| oos | 04:00–08:00 | 269 / 288 | 93.4% |
| oos | 08:00–12:00 | 256 / 288 | 88.9% |
| oos | 12:00–16:00 | 287 / 288 | 99.7% |
| oos | 16:00–20:00 | 282 / 288 | 97.9% |
| oos | 20:00–24:00 | 267 / 288 | 92.7% |

The Aug 26 holdout has only 1 of 48 complete windows in 04:00–08:00 UTC. A BAPI refetch returned 47 incomplete windows and zero request failures, so evidence for that session depends more heavily on train, validation, and untouched partial OOS than on the one-day holdout.

The release cutoff stays fixed at 0.900. This changes only the trend/noise model's minimum predicted win probability for entry by UTC session. The nonnegative after-fee edge gate, model coefficients, residual and cross trees, fees, latency, cooldown, and one-use-per-cell policy remain fixed.
