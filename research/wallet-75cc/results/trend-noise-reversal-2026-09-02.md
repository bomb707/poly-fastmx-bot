# FastMX trend/noise/reversal enhancement — 2026-09-02

## Verdict

The causal trend/noise layer materially improves the existing `target75cc` simulation, but it does not make the strategy profitable on the frozen partial-OOS cohort and does not reproduce the target wallet. The selected candidate reduces partial-OOS loss from **-$1,190.50 to -$33.85**, maximum settlement-boundary drawdown from **$1,300.52 to $91.45**, and worst-window loss from **-$83.50 to -$22.06**. It remains simulation-only.

The improvement comes primarily from fee-adjusted trade selection and scaling risk downward. Adding all proposed external-feed and book-depth features hurt validation. Explicit pullback entries were profitable on the one-day discovery holdout but lost on validation and partial OOS, so they are not independently validated as an edge.

## Data and no-lookahead controls

- Source: the same cached BAPI v2 coherent 120ms BTC five-minute L2 windows used by the current strategy backtest.
- Discovery: `[2026-08-20T00:00:00Z, 2026-08-27T00:00:00Z)`, 1,508 complete windows.
- Model fit: Aug 20–24 only; 4,116 current-strategy candidate fills.
- Model/feature selection: Aug 25 only; 1,195 fills across 284 complete windows.
- Untouched discovery holdout: Aug 26; 835 fills across 241 complete windows.
- Frozen partial OOS: `[2026-08-27T00:00:00Z, 2026-09-02T04:00:00Z)`, 1,651 complete windows.
- Every model feature is built only from snapshots timestamped at or before the decision. Whole market windows stay within one chronological split.
- The final market winner is the supervised target, never a feature. Forward 5s/15s paths and settlement outcomes are used only for evaluation labels and MAE/MFE reporting.
- Baseline and improved policies use identical windows, 520ms latency, fixed-USDC FAK semantics, visible-depth ladder walking, and fee accounting.

Generated research artifacts are `data/wallet-75cc/exact-2026-08-20_2026-08-27/trend-noise-model.json`, its compressed row dataset, and the discovery/OOS `trend-noise-backtest.json` files. Those large outputs are intentionally ignored; the generator, frozen browser-safe model, and this compact result are tracked.

## Model and implemented decision logic

The research evaluated 112 causal columns covering 0.5, 1, 2, 3, 5, 10, 15, 30, and 60 seconds:

- token ask, bid, and midpoint changes;
- Binance and Chainlink/TWAP changes and cross-market basis;
- short-versus-medium acceleration;
- directional persistence and path efficiency;
- volatility-normalized short moves;
- trailing-range position and discount from the local high;
- spread, depth imbalance, and depth-pressure changes; and
- time, price, pair ask, and causal dominant/short trend scores.

The frozen model estimates `P(candidate side wins)`. Runtime then calculates:

```text
fee per share = 0.07 × ask × (1-ask)
expected edge = P(candidate side wins) - ask - fee per share
```

An order is eligible only when probability is at least 0.50 and expected edge is nonnegative. The existing residual tree still determines the base inventory target. Confidence can only reduce it:

```text
confidence = normalized distance above fee-adjusted break-even
size scale = 0.50 + 0.50 × sqrt(confidence)
final residual = round(base residual × size scale)
```

The enhancement never scales above the existing residual target. Filled plus pending inventory, partial-versus-cross logic, 5–227 order bounds, 300 planned-gross ceiling, release menu, cooldown, and fill simulation remain unchanged.

The categorical interpretation is separate from execution value:

- `TREND_CONTINUATION`: candidate agrees with the causal dominant trend and is not in a significant short pullback.
- `TEMPORARY_NOISE`: a counter-trend move lacks sufficient reversal probability, or a likely pullback lacks tradable edge.
- `PULLBACK_ENTRY_OPPORTUNITY`: candidate follows the dominant trend, the short score opposes it, and the probability/edge gate passes.
- `POSSIBLE_REVERSAL`: candidate opposes the dominant trend and has probability from 0.50 to 0.70.
- `CONFIRMED_REVERSAL`: candidate opposes the dominant trend with probability at least 0.70.
- `UNCERTAIN`: no strong causal dominant/counter-trend structure is present.

These names describe the implemented observable classifier. They are not recovered target-wallet states.

## Feature ablation

Feature-set selection used validation log loss; holdout was excluded.

| Feature set | Validation AUC | Validation log loss | Holdout AUC | Holdout log loss | Result |
|---|---:|---:|---:|---:|---|
| Context + composite trend scores | 0.8111 | 0.4809 | 0.8157 | 0.4831 | Strong baseline dominated by time/price/pair context; the two small composite scores also blend token/Binance/TWAP movement. |
| Context + token path | **0.8124** | **0.4775** | **0.8182** | **0.4767** | Selected. Multi-timescale token path adds a small stable gain. |
| Context + external feeds | 0.7969 | 0.4927 | 0.7992 | 0.4950 | Rejected. Binance/TWAP additions did not improve this candidate-level target. |
| Context + microstructure | 0.8017 | 0.4868 | 0.8044 | 0.4901 | Rejected. Depth/spread changes did not improve validation. |
| Context + token + external | 0.7974 | 0.4906 | 0.8020 | 0.4911 | Rejected. |
| All 112 features | 0.7953 | 0.4928 | 0.7950 | 0.4961 | Rejected as overfit/noisy. |

The source cache has snapshot depth changes but not aggressor-attributed trade flow. The implementation therefore calls these features depth-pressure proxies and does not claim to measure aggressive buy/sell flow. Direct Binance/TWAP/basis columns were rejected, but the selected context bucket retains the small `dominantScore` and `shortScore` composites, which blend token, Binance, and TWAP movement. Thus external feeds are not literally absent; their standalone feature family added no validation value beyond those composites.

## Baseline versus improved

“Win rate” below uses traded windows; zero-trade windows are excluded from that denominator. Profit/loss per trade attributes each BUY independently at binary settlement. “False reversal” means an order explicitly labeled `reversal` crossed inventory toward the eventual losing side; partial hedges are excluded from that rate but included in reversal/hedge loss. Drawdown is still measured at settlement boundaries, matching the existing harness rather than intrawindow marked equity.

### Validation — Aug 25, 284 complete windows

| Metric | Baseline | Improved |
|---|---:|---:|
| Total PnL | -$92.05 | **+$41.40** |
| PnL/window | -$0.3241 | **+$0.1458** |
| Traded-window win rate | 58.74% | **72.41%** |
| Maximum drawdown | $178.58 | **$34.17** |
| Worst window | -$50.76 | **-$18.56** |
| Trades | 1,195 | 279 |
| Average entry cost/share | $0.6587 | $0.6575 |
| Average filled position/trade | 11.82 shares | 8.26 shares |
| Profit factor | 0.8925 | **1.2113** |
| Average profit/winning trade | $2.6226 | $2.6314 |
| Average loss/losing trade | -$6.3386 | **-$5.2410** |
| Reversal/hedge losing-trade sum | -$1,186.60 | **-$232.12** |
| False-reversal rate | 41.45% | **31.33%** |

### Untouched discovery holdout — Aug 26, 241 complete windows

| Metric | Baseline | Improved |
|---|---:|---:|
| Total PnL | -$273.62 | **+$37.95** |
| PnL/window | -$1.1354 | **+$0.1575** |
| Traded-window win rate | 59.91% | **72.88%** |
| Maximum drawdown | $305.44 | **$32.53** |
| Worst window | -$37.66 | **-$13.00** |
| Trades | 835 | 187 |
| Average entry cost/share | $0.6918 | $0.6688 |
| Average filled position/trade | 11.89 shares | 8.09 shares |
| Profit factor | 0.6670 | **1.2861** |
| Average profit/winning trade | $2.4228 | $2.1762 |
| Average loss/losing trade | -$6.5486 | **-$5.3543** |
| Reversal/hedge losing-trade sum | -$771.33 | **-$109.59** |
| False-reversal rate | 38.75% | **34.21%** |

### Frozen partial OOS — Aug 27 through Sep 2 04:00Z, 1,651 complete windows

| Metric | Baseline | Improved |
|---|---:|---:|
| Total PnL | -$1,190.50 | **-$33.85** |
| PnL/window | -$0.7211 | **-$0.0205** |
| Traded-window win rate | 62.71% | **67.03%** |
| Maximum drawdown | $1,300.52 | **$91.45** |
| Worst window | -$83.50 | **-$22.06** |
| Trades | 5,850 | 1,320 |
| Average entry cost/share | $0.7077 | **$0.6708** |
| Average filled position/trade | 11.81 shares | **8.16 shares** |
| Profit factor | 0.7585 | **0.9686** |
| Average profit/winning trade | $2.3505 | $2.2751 |
| Average loss/losing trade | -$6.8496 | **-$5.0784** |
| Reversal/hedge losing-trade sum | -$5,213.38 | **-$819.29** |
| False-reversal rate | 37.22% | **30.41%** |

The candidate removes about 77% of fills. This is selective risk reduction, not higher-frequency alpha. OOS profit factor remains below one and PnL remains negative.

## Noise/reversal diagnostics

Noise accuracy is evaluated on current-model candidate actions where the causal dominant score and short score clearly oppose each other. The “outcome proxy” calls the move a reversal when the counter-trend candidate ultimately wins the binary market. The stricter “structural” label requires the counter move to continue coherently at both +5s and +15s; ambiguous paths are excluded. Future values are used only to score past predictions.

| Interval | Candidate events | Outcome-proxy accuracy | Structurally labeled events | Structural accuracy |
|---|---:|---:|---:|---:|
| Validation | 71 | 76.06% | 41 | 75.61% |
| Discovery holdout | 32 | 56.25% | 20 | 45.00% |
| Partial OOS | 219 | 74.89% | 131 | 59.54% |

Outcome-proxy accuracy is useful but structural accuracy is unstable. The classifier should not be described as solved. The economic gate improves false-reversal losses even though fine-grained short-horizon structural labels remain difficult.

## Pullback-entry audit

Entry improvement is the candidate-token midpoint discount from its trailing 15-second high. MAE/MFE use future best bids relative to fill price for evaluation only.

| Interval | Pullback entries | Success | Avg entry improvement | Avg PnL | Avg MAE | Avg MFE | Actually resolved against dominant side |
|---|---:|---:|---:|---:|---:|---:|---:|
| Validation | 24 | 54.17% | $0.0530 | -$1.2091 | -$0.3863 | +$0.1928 | 45.83% |
| Discovery holdout | 14 | 100.00% | $0.0679 | +$2.7177 | -$0.1791 | +$0.3008 | 0.00% |
| Partial OOS | 99 | 61.62% | $0.0502 | -$0.7942 | -$0.3491 | +$0.1862 | 38.38% |

High-confidence pullbacks are not independently profitable across periods. An integrated validation screen found that raising the pullback probability cutoff changed later inventory/menu state and reduced total strategy PnL: cutoff 0.50 produced +$41.40, 0.70 +$16.47, 0.80 +$24.98, 0.85 +$23.71, and 0.90 +$8.46. The 0.50 probability plus nonnegative expected-edge gate is retained because it produced the best complete-path validation result. This does not establish pullbacks as a standalone signal.

## Sizing and reversal policy selection

Validation-only confidence-size screening held the provisional reversal threshold at 0.65 while comparing size curves:

| Size policy | Validation PnL | Drawdown | Conclusion |
|---|---:|---:|---|
| Existing residual, no confidence scaling | +$36.10 | $74.71 | Improved by selection, but retains larger tail risk. |
| 0.50×–1.00× | +$38.05 | **$34.17** | Selected for risk-adjusted behavior. |
| 0.75×–1.00× | +$40.39 | $54.05 | Slightly more PnL, materially more drawdown. |
| 0.75×–1.25× | +$17.26 | $72.36 | Rejected. |
| 1.00×–1.50× | -$48.64 | $130.65 | Rejected; confidence must not lever the base residual. |

The separate reversal gate selected 0.50 on validation: 0.50 produced +$41.40, 0.60–0.70 +$38.05, 0.75 +$37.62, and 0.80 +$35.12. A stronger reversal-only veto was rejected because it reduced complete-path PnL and risks recreating stranded one-sided exposure. The 0.70 boundary remains only the label between `POSSIBLE_REVERSAL` and `CONFIRMED_REVERSAL`; trade permission still requires probability at least 0.50 plus nonnegative expected edge.

## Limitations and promotion status

- The model is trained at decisions generated by the current release policy. It does not solve the wallet's low release-time parity.
- Context and token price dominate. Direct Binance/TWAP/basis and snapshot depth-pressure additions failed validation and have zero direct weights; the two low-weight composite trend scores still blend token, Binance, and TWAP movement.
- The strategy can still buy the wrong side; partial-OOS PnL and profit factor remain negative.
- Pullback entries do not show stable standalone profitability.
- Noise/reversal outcome accuracy is better than structural 5s/15s accuracy; the latter remains unstable.
- No aggressor-attributed trade-flow feature exists in the cached BAPI material.
- Drawdown is settlement-boundary drawdown, not marked intrawindow equity.
- Results cover complete cached BTC five-minute windows and do not validate other assets or intervals.

The correct operational status is **improved simulation candidate, not live-ready**.

## Reproduction

```bash
node research/wallet-75cc/fit-trend-noise-model.mjs

TARGET_EXACT_FIRE_FILE=data/wallet-75cc/exact-2026-08-20_2026-08-27/exact-fire-dataset.json.gz \
  node research/backtest-target75cc.mjs \
  2026-08-20T00:00:00Z 2026-08-27T00:00:00Z data/wincache

TARGET_EXACT_FIRE_FILE=data/wallet-75cc/oos-partial-2026-08-27_2026-09-02/exact-fire-dataset.json.gz \
  node research/backtest-target75cc.mjs \
  2026-08-27T00:00:00Z 2026-09-02T04:00:00Z data/wincache
```
