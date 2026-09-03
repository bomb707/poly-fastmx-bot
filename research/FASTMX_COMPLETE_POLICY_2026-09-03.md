# FastMX complete-policy validation — 2026-09-03

> Superseded for current sizing and fee-inclusive risk totals by
> `FASTMX_SIZING_AND_LOSS_AUDIT_2026-09-03.md`. This document preserves the earlier all-$2 policy evaluation.

## Method

- Exact registered FastMX strategy and fill simulator.
- Coherent V2 L2 replays sampled causally at 120ms.
- Range: 2026-08-22 00:00 UTC through 2026-09-03 13:30 UTC.
- Parameter selection: Aug 22–30 only (2,459 rounds).
- Sealed holdout: Aug 31–Sep 3 (894 rounds).
- Selected candidate: session policy, dynamic $2 entry/reversal risk, $10 worst-settlement-loss limit, four signal
  orders, fallback from second 90, and one-second strict reversal confirmation in Europe/late-US.

“100% participation” below means at least one modeled fill in every available replay. Runtime guarantees attempts,
not venue fills. P&L includes the strategy's configured taker fee model. It does not prove future profitability.

## Result

| Policy | Traded | Fills | Win rounds | Loss rounds | P&L | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|---:|
| Previous current | 3,317 / 3,353 (98.926%) | 62,539 | 1,992 | 1,325 | -$9,465.39 | 0.8856 | $12,149.43 |
| Selected complete policy | 3,353 / 3,353 (100%) | 6,735 | 1,974 | 1,379 | +$233.73 | 1.0461 | $258.99 |

Fit P&L was +$346.76 with a $125.33 maximum drawdown. The sealed holdout was -$113.03 with a $258.99 maximum
drawdown. The result therefore supports the large reduction in order frequency and loss severity more strongly
than it supports a stable profit claim.

## By UTC session

| Session | Rounds | Wins | Losses | P&L | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Asia 00–07 | 929 | 606 | 323 | +$78.91 | 1.0494 | $97.11 |
| Europe 07–13 | 873 | 569 | 304 | +$216.75 | 1.1653 | $85.61 |
| US 13–21 | 1,140 | 607 | 533 | -$138.85 | 0.9124 | $192.49 |
| late-US 21–24 | 411 | 192 | 219 | +$76.91 | 1.1333 | $92.09 |

US remains the weak regime. Its stricter 8-second CLOB/Binance lookbacks, gap-agreement requirement, 15-second
cooldown, and disabled reversal limit damage, but do not turn that session profitable while every round is forced
to participate.

## Daily

| UTC date | P&L | Win rounds | Loss rounds | Traded |
|---|---:|---:|---:|---:|
| Aug 22 | +$84.52 | 113 | 101 | 214 |
| Aug 23 | +$30.14 | 171 | 116 | 287 |
| Aug 24 | -$43.61 | 174 | 114 | 288 |
| Aug 25 | +$142.52 | 178 | 106 | 284 |
| Aug 26 | -$9.60 | 137 | 104 | 241 |
| Aug 27 | +$86.76 | 180 | 108 | 288 |
| Aug 28 | +$21.54 | 171 | 116 | 287 |
| Aug 29 | +$9.46 | 161 | 127 | 288 |
| Aug 30 | +$25.02 | 179 | 103 | 282 |
| Aug 31 | +$7.27 | 121 | 103 | 224 |
| Sep 1 | -$56.37 | 160 | 104 | 264 |
| Sep 2 | -$19.89 | 135 | 112 | 247 |
| Sep 3 partial | -$44.03 | 94 | 65 | 159 |
| **Total** | **+$233.73** | **1,974** | **1,379** | **3,353** |

## Feature attribution and limits

- Second-90 fallback was necessary for 100% replay participation. Second 60 also reached 100%, but forced all
  2,459 fit rounds immediately and lost $260.00 with reversal; it was rejected.
- One-second confirmed reversal generated 171 opposite-side fills. Against the same second-90 configuration without
  reversal, it improved full-period P&L by $104.53 and holdout P&L by $94.74, while reducing drawdown by $37.31.
- Dynamic sizing plus hard limits cut capital deployed from $304,923.35 to $19,113.50 and bounded repeated entries.
- The 0.02/0.01 passive rescue ladder produced zero qualifying fills in this sample. Its economics cannot be
  credited to the reported improvement. Unit/integration tests cover placement before touch, post-only rejection,
  later causal fill, and winner-inventory retention.
- The $25 session circuit breaker is external to independent-round backtesting and is therefore not credited in
  these totals.

Reproduce with `node research/fastmx-complete-policy-backtest.mjs`.
