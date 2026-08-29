# Passive Maker V17–V28 Research Update — 2026-08-25

## Decision

**Stable profitability is not validated. Do not promote V17, V27, or V28 to live execution.**

The frozen V17 forward cohort remains healthy and initially positive, but it has only 0.25 elapsed days and 2–3 active windows per execution cell. V27 is a proven no-op. V28 fails its conservative screen and is closed without full-stress or neighborhood testing.

The production-style PM2 bot remains in simulation mode. No strategy in this report was deployed to it.

## Frozen V17 forward checkpoint

Untouched checkpoint target: `2026-08-25T18:55:00Z`.

| Source | Loaded / expected | Failed | Active windows | Enabled-cell PnL range | Max DD | Window lower 95% | PF |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2 native | 72 / 72 | 0 | 2 | +3.036407 to +4.850000 | 0 | 0 | undefined |
| V4 | 72 / 72 | 0 | 2–3 | +2.257235 to +3.413020 | 0 | 0 | undefined |

All eight enabled 130/200 ms cells remain positive. All four 300 ms cells remain exactly paused. There are zero taker fills, fees, or maker rebates. This is encouraging but statistically insufficient: the window lower bound is zero, PF cannot be estimated without a losing observation, 100 active windows have not accumulated, the three fixed 10-day folds are incomplete, and fewer than 30 days have elapsed.

The independent audit also rejects V17 on pre-freeze evidence. Its aggregate historical core metrics pass the current PnL/PF/DD thresholds, but the original selection recorded `historicalPassed: false`, `acceptedHistorical: false`, and no tested immediate neighborhood.

## Exact loss attribution

`analyze-passive-maker-v17-losses.mjs` first reproduces every authoritative V17 summary metric exactly before reading per-window features.

| Source | Active | Wins | Losses | Spend | PnL | ROI | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V2 | 79 | 53 | 26 | 149.849568 | +37.894817 | 25.29% | 1.9481 | 9.141869 |
| V4 | 79 | 54 | 25 | 156.964886 | +44.246556 | 28.19% | 2.0474 | 6.691869 |

Among 2,464 windows common to both normalized reconstructions, 71 are active on both. The first maker side agrees in all 71; 47 win on both, 23 lose on both, and one has a mixed PnL sign.

The most important descriptive signature is overconfidence, not Binance/Chainlink disagreement:

- Binance and Chainlink support the first-fill side in every active V17 window.
- First-fill expected edge of at least 0.12 produces only +5.541184 with PF 1.4263 on V2 and loses 2.679954 with PF 0.8398 on V4.
- Up-first windows are much weaker than Down-first windows in this short sample, but that directional asymmetry is regime-sensitive and is not used as a new rule.
- First-fill price below 0.30 is weak on both sources, but contains only three or four active observations and is not enough to justify a fitted price cutoff.

These bins are descriptive only. V19 already tested the corresponding spot/market-disagreement cap. It improved nominal 130 ms results but failed the full 200 ms/low-credit stress, so the finding is not being recycled into another fitted cap.

## V27: constant-size hypothesis

Hypothesis: eliminating the 15-share “large order” menu might reduce tail loss.

The rerun uses an exact slug allowlist from the authoritative corpus and frozen archive precedence. The V25 control reproduces every audited summary metric exactly for V2/V4 at 130/200 ms and 2.5% conserved maker credit.

Result: **V27 is an exact no-op.** Setting `residualLargeOrderShares` to 5, 7.5, or 10 produces identical per-window placements, cancellations, fills, inventory, spend, and PnL to the 15-share control in all four source/latency cells.

Reason: `residualTargetShares=5` and `residualBaseOrderShares=5`; the large menu requires directional need of at least two base orders. That condition is unreachable in ordinary directional entry under the bounded target. V27 is closed without further testing.

## V28: market calibration plus partial-fill cancellation

V28 combines two previously specified components without fitting a new threshold:

- V20 residual calibration: market weight 0.70, maximum spot/market probability gap 0.20, and directional cutoff 220 seconds;
- V25 execution control: cancel overweight outstanding orders after partial fills and use one-tick repricing;
- post-only maker orders, 500 ms cancellation, 520 ms taker assumption, zero automatic hedge, zero taker fills, zero rebates, and five-share target remain unchanged.

Both V20 and V25 controls reproduce their authoritative 2.5%-credit metrics exactly before V28 is assessed.

| Source | Latency | Active | Spend | PnL | ROI | PF | Window lower 95% | Day lower 95% | Max DD | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| V2 | 130 ms | 78 | 70.652866 | +17.401395 | 24.63% | 1.8047 | -3.087173 | -1.818687 | 6.948140 | Fail |
| V2 | 200 ms | 69 | 66.521481 | +23.819793 | 35.81% | 2.5410 | +6.632819 | +6.216987 | 5.731498 | Fail: activity |
| V4 | 130 ms | 82 | 87.611732 | +22.545576 | 25.73% | 1.8130 | +0.019962 | +0.185948 | 8.442202 | Pass |
| V4 | 200 ms | 78 | 81.371891 | +20.017036 | 24.60% | 1.7888 | -0.989545 | +2.217478 | 7.194890 | Fail |

All twelve chronological fold totals are positive, and cancellation is exercised 59–106 times per cell. Nevertheless, only one of four cells passes every gate. V28 also reduces PnL relative to V25 in all four cells, by 0.137754 to 8.628167, and increases drawdown on both V4 cells. It is rejected before full credit stress or neighborhood testing.

## Archive-integrity correction

An initial research replay was discarded because a later R6 re-collection preceded the frozen forward-v15 public-trade shard and one full-depth R4/legacy order-book shard was omitted. Four historical windows changed and the control checksum failed.

The corrected runner:

- uses the authoritative per-source slug allowlist;
- places the frozen forward-v15 trade archive before the later R6 re-collection;
- places full-depth R4 and legacy V2 sources before compact fallbacks;
- records all source directory precedence, allowlist SHA-256, and allowlist size in replay provenance; and
- requires exact control reproduction before evaluating a challenger.

This prevents changing archive availability from silently changing a historical strategy result.

## Paper operation

The PM2 bot remains online in `EXECUTION_MODE=simulation`. The bounded participation floor was directly checked for five consecutive windows beginning with `btc-updown-5m-1787682300`: each recorded exactly one 5-share paper fill, with the participation-floor reason, and no repeated action in the same window. This confirms operational participation, not profitability; forced participation can lose and is protected by the five-unit session breaker.

## Reproduction

```bash
npm run research:maker:forward:test
node research/passive-maker-forward-audit-v17.mjs
node research/analyze-passive-maker-v17-losses.mjs
npm run research:maker:v27:screen
npm run research:maker:v27:evaluate
npm run research:maker:v28:screen
npm run research:maker:v28:evaluate
```

The current independent forward audit intentionally exits with status 2 because the cohort is not validated.
