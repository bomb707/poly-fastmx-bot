# Wallet3048: BAPI verification and calibration, September 3–10

Completed September 10, 2026. **Research results; runtime strategy unchanged.**

The study used BAPI V2 `/snapshot-ticks` metadata and BAPI V2 Order Book `/orderbooks` recordings from **September 3 at 00:00 through September 10 at 10:40 Europe/Berlin**, the last completed boundary frozen at the start of this request. The corresponding UTC range is September 2 at 22:00 through September 10 at 08:40, with an exclusive ending boundary.

**The market-data calibration does not yet validate a profitable inventory strategy.** The tested probability adjustment added little measurable improvement, the tested price extrapolations did not beat persistence on validation, and the fitted joint-touch predictor deteriorated on later periods. Actual maker fills remain unidentified from these book snapshots.

The [full report](data/reports/wallet3048-inventory-calibration-2026-09-03_10/report.md) contains daily coverage, model comparisons, price-error bands, joint opportunity measurements and the complete v5 replay baseline.

## 1. Data and chronological evaluation

| Item | Result |
|---|---:|
| Expected completed five-minute rounds | 2,144 |
| Rounds passing coverage and outcome checks | 2,081 |
| Excluded rounds | 63 |
| Raw book frames represented by retained feeds | 12,182,574 |
| Eligible model-state observations | 42,786 |
| API collection failures | 0 |

The model uses observations every ten seconds, with the latest available retained frame at or before that time. Feeds retain the last observation in each 120 ms bucket and the top three levels on each book side. Previously collected September 7–9 feeds were reused with recorded hashes. No missing book depth or intervening observations were invented.

Exclusions require a missing/unresolved outcome, missing clock fields, a start more than two seconds late, an end before t+298s, or an internal gap over six seconds. Reasons can overlap. Most exclusions occurred on September 3. The [coverage CSV](data/reports/wallet3048-inventory-calibration-2026-09-03_10/coverage-daily.csv) also identifies empty feeds and missing fields.

| Period | Purpose | Eligible rounds |
|---|---|---:|
| September 3–5 | Fit coefficients | 806 |
| September 6 | Select candidate models and estimate price-error bands | 288 |
| September 7–9 | Retrospective test; its earlier aggregate results already influenced the design | 859 |
| September 10 through 10:40 Berlin | New chronological test, partial day | 128 |

Model features use first-observed in-round reference/Binance values as opening proxies. They do not use finalized opening metadata, final prices or winners as inputs. These causal proxies are not an independently verified reconstruction of the contract's exact opening reference. Final labels come from BAPI `winSide`.

Repeated observations within one round share an outcome. Metrics give each round equal total weight, and uncertainty uses blocks of 12 consecutive available rounds rather than treating ticks as independent trials. The latest test remains a small partial-day sample.

## 2. Outcome probability: only a small adjustment was selected

The selected model was a logistic recalibration of normalized outcome midpoints. The richer tested state model added reference/Binance gaps, momentum, book depth and remaining-time features, but had worse validation Brier scores than the simpler alternatives.

The selected fitted equation, rounded for display, is:

```text
UpMid   = (UpBid + UpAsk) / 2
DownMid = (DownBid + DownAsk) / 2
p_market = clamp(UpMid / (UpMid + DownMid), 0.01, 0.99)

p_calibrated = sigmoid(-0.011305867 + 1.070818031 * logit(p_market))
```

Exact coefficients and standardization are in [selected-probability-model.json](data/reports/wallet3048-inventory-calibration-2026-09-03_10/selected-probability-model.json). This is a research candidate, not a replacement applied to v5.

| Evaluation | Raw midpoint Brier | Calibrated Brier | Interpretation |
|---|---:|---:|---|
| September 6 validation | 0.1518 | 0.1514 | Small improvement used for model selection |
| September 7–9 retrospective test | 0.1615 | 0.1614 | Difference's block interval includes zero |
| September 10 new test | 0.1531 | 0.1529 | Difference's block interval includes zero |

Lower Brier is better. These results provide **no clear evidence of a material improvement over the raw midpoint** in the later samples. They also do not prove that all possible momentum or reference models lack predictive value; they describe the tested feature/model family.

## 3. Target-price forecasting: uncertainty is large

Persistence, meaning the current ask as the future point forecast, beat the tested three-second velocity extrapolation and fitted ridge changes on validation at every horizon.

| Lookahead | Selected forecast | September 10 mean absolute ask error |
|---|---|---:|
| 1 second | Current ask | 1.27 cents |
| 5 seconds | Current ask | 4.08 cents |
| 15 seconds | Current ask | 7.42 cents |
| 30 seconds | Current ask | 11.26 cents |

Validation residuals supplied nominal 90% price bands. At 30 seconds, those bands had approximately 90.83% marginal coverage on September 10, but their average width after clipping to the outcome-price domain was about **46.03 cents**. That is substantial uncertainty relative to a planned few-cent acquisition margin. The bands describe endpoint best asks, not a guaranteed path or execution price.

Consequently, a target such as future UP at $0.30 and DOWN at $0.20 must remain a conditional scenario. The tested velocity extrapolation does not establish that such a sequence is reachable. See [price-model comparisons](data/reports/wallet3048-inventory-calibration-2026-09-03_10/price-forecast-metrics.csv) and [price-band coverage](data/reports/wallet3048-inventory-calibration-2026-09-03_10/price-forecast-intervals.csv).

## 4. Joint price paths and actual maker execution are separate

On September 10, for a 30-second horizon and targets one cent below each side's initial ask:

| Measured event | Frequency |
|---|---:|
| UP future ask reached its target | 78.16% |
| DOWN future ask reached its target | 74.83% |
| Both future asks reached their targets | 56.03% |
| Product of the two marginal frequencies | 58.49% |

Multiplying marginal frequencies overstated this measured joint event. However, the particular fitted joint predictor also failed to generalize: its Brier score was **0.1704** on September 10 versus **0.1674** for the separately fitted marginal-probability product. Its joint-minus-product error interval was positive. The fitted model therefore has no demonstrated advantage on this new test. The comparison model's better score does not establish statistical independence.

Under the 520 ms arrival probe, an ask-minus-one-cent post-only order would have crossed on arrival in **15.06% of UP observations** and **13.84% of DOWN observations**, implying rejection under post-only semantics. These are modeled arrival checks, not observed rejected orders. Historical tick metadata is absent, so the one-cent offset is a controlled probe rather than proof of the exact historical ask-minus-current-tick policy.

**Future ask touch is neither sufficient nor necessary to establish a maker fill.** Queue position may prevent a fill after a touch. Conversely, an aggressive seller can fill a resting bid while the displayed best ask stays above it. The touch frequencies are therefore not maker fill rates or universal bounds on them.

The checked BAPI responses lack aggressor-side trade flow, order acknowledgments, cancellation outcomes and queue positions. The [API schema audit](data/reports/wallet3048-inventory-calibration-2026-09-03_10/api-schema-audit.json) records the supplied endpoint fields and unsuccessful probes for additional trade routes. It does not rule out another service exposing such data.

These inputs support price-opportunity calibration. They do **not** identify the complete execution distribution needed to optimize staged quantities, target common payoff and DIFF. Recorded orders/fills and relevant trade-flow evidence would be needed to validate that part of the proposed controller.

## 5. Current bot: the profit/loss asymmetry still fails

Unchanged v5 was replayed over the same 2,081 usable rounds, with its existing 520 ms latency, modeled fees, fixed templates and strict-no-maker policy.

| Complete-round metric | Result |
|---|---:|
| First-entry correctness | 1,148 / 2,081 = 55.17% |
| Profitable rounds | 755 / 2,081 = 36.28% |
| Losing rounds | 1,326 / 2,081 = 63.72% |
| Average winning round | +$45.88 |
| Average losing round | −$58.67 |
| Average-win / average-loss ratio | 0.782 |
| Break-even profitable-round rate at these averages | 56.12% |
| Mean P&L per round | −$20.74 |
| Total simulated P&L | −$43,163.48 |
| Correct first entry but losing complete round | 547 rounds |

The observed profitable-round rate is below the break-even rate implied by its average win and loss. This directly tests the user's priority, **winning dollars per round relative to losing dollars per round**, and the current implementation fails that test in this cohort.

The mean-round-P&L block interval was approximately **−$23.89 to −$17.62**. It describes uncertainty within this historical replay treatment, not all future markets or live execution. Independent-round replay also does not establish a funded-account return curve. These results are a baseline for the proposed design, not a replay of that unimplemented design.

Daily results appear in the [full report](data/reports/wallet3048-inventory-calibration-2026-09-03_10/report.md) and [baseline CSV](data/reports/wallet3048-inventory-calibration-2026-09-03_10/baseline-daily.csv).

## 6. Calibration status and verification

The study produced fitted outcome probabilities, price-error bands and joint price-opportunity models, with chronological validation and later evaluation. It found limitations rather than selecting a demonstrated profitable full strategy. No optimal loss weight, payoff target, holdings ratio or order quantity follows from these forecast results alone.

The sizing algebra in the [proposed specification](WALLET3048_INVENTORY_OPTIMIZATION_SPEC.md) remains an exact accounting component. Its deployment as a profitable controller still depends on validated execution and target-selection behavior. No preset spending allocation was introduced, and no runtime strategy settings changed.

Verification included:

- All 2,144 feed hashes and raw pagination totals checked.
- Production-source and runtime-parameter hashes unchanged.
- All eligible baseline settlement payoffs reconciled exactly to shares, cost and fees; daily and aggregate totals reconciled.
- Saved calibration coefficients reproduced all stored probability predictions exactly in an independent calculation.
- Future-data and final-metadata mutation tests confirmed causal feature construction; missing/future clocks were rejected.
- Report links, model artifacts and the calibration plot inspected.

See [independent-verification.json](data/reports/wallet3048-inventory-calibration-2026-09-03_10/independent-verification.json), [study plan](data/reports/wallet3048-inventory-calibration-2026-09-03_10/study-plan.json), [feed manifest](data/reports/wallet3048-inventory-calibration-2026-09-03_10/manifest.json), and [code frozen before fitting](data/reports/wallet3048-inventory-calibration-2026-09-03_10/calibration-code-lock.json). Reproduction commands and dependency versions are in the full report.
