# FastMX execution and inventory risk audit

Date: 2026-08-27 UTC

## Outcome

No tested configuration supports a claim of stable profitability. The deployed configuration is a loss-control
release that keeps the two current direction signals unchanged and remains simulation-only.

The exact final replay covers 2,875 settled BTC five-minute windows from August 16 through August 25. It uses the
same strategy code, causal V2 full-L2 frames, 520 ms delayed matching, actual visible depth, and modeled crypto
taker fees.

| Policy | PnL | ROI | Max drawdown | Positive days |
|---|---:|---:|---:|---:|
| Former declared crossing policy | about -$393.00 | -2.58% | about $489.23 | 5/10 |
| New safe policy, hedging on | -$212.20 | -3.15% | $294.85 | 4/10 |
| New safe policy, hedging off (default) | -$162.04 | -2.46% | $260.97 | 4/10 |

The new default reduced modeled loss by approximately 59% and drawdown by approximately 47% versus the former
declared policy. It still lost money, so those reductions are not evidence of a profitable edge.

## Mathematical safeguards

For a proposed hedge at cap `p_h`, the engine estimates the complete-set edge per paired share as:

`edge = 1 - averageHeldPrice - fee(averageHeldPrice) - p_h - fee(p_h)`

The hedge is rejected unless `edge >= $0.01`. The cap is the worst execution price, so price improvement can only
improve this cost bound. The fee curve is evaluated at the average held price; because `p(1-p)` is concave, this is
conservative relative to averaging the historical per-fill fee curve.

For every proposed order, worst-case settlement PnL is:

`worst = min(Up shares, Down shares) - total cost - estimated fees`

A risk-increasing order is rejected if `worst < -$7`. A hedge that improves an already-breached position remains
eligible. Same-side adds default off, reversal residual is fixed to zero, two orders is the hard maximum, and the
session breaker defaults to `-$25`.

An enabled hedge is share-denominated and forces marketable GTC transport with remainder cancellation. This fixes
the prior zero-residual bug and prevents a fixed-USDC price improvement from returning excess shares and silently
turning a hedge-to-flat into a reversal.

## Rejected research paths

- Taker threshold/value screens found candidates that were positive in fit and validation but failed the untouched
  August 22–25 holdout. The frozen finalist lost `$13.62` on the holdout.
- A conservative passive-maker screen required the recorded ask to trade strictly through the resting bid after a
  130 ms post-only arrival; a touch received zero credit and rebates were zero. No candidate was positive in both
  fit and validation.
- Safe hedging was worse than hedge-off in the final full replay, so it is exposed as an operator toggle but defaults
  off.

Source artifacts:

- `research/wallet-75cc/results/fastmx-execution-policy-screen-2026-08-27.json`
- `research/wallet-75cc/results/fastmx-execution-threshold-screen-2026-08-27.json`
- `research/wallet-75cc/results/fastmx-execution-hedge-screen-2026-08-27.json`
- `research/wallet-75cc/results/fastmx-execution-holdout-screen-2026-08-27.json`
- `research/wallet-75cc/results/fastmx-passive-screen-2026-08-27.json`
- `research/wallet-75cc/results/fastmx-execution-final-screen-2026-08-27.json`

Historical simulation cannot guarantee future returns. Promotion beyond paper simulation requires a new,
prospectively frozen forward cohort.
