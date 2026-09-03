# FastMX entry-signal and sizing review — 2026-09-03

## Decision

The user's return calculation is correct: 60 shares bought at $0.60 cost $36 and return $60 at settlement, so
gross profit is $24 and gross return on expenditure is 66.67% before fees. Share count scales dollars, but does
not change that percentage. Entry price and conditional win probability determine whether scaling is rational.

No tested minimum-10, unlimited-size candidate is promoted. The best retrospective unlimited return-efficiency
candidate earned +$949.12, but lost -$184.07 in the later period, reached -$80.99 in one round, and had a
$1,363.74 maximum drawdown. The active defaults therefore remain the previously validated fixed-expenditure
policy. The new `return-efficiency` size mode and ordinary-entry-count limit are implemented but inactive.

## Data and method

- 3,353 five-minute BTC rounds, 2026-08-22 00:00 UTC through 2026-09-03 13:30 UTC.
- Coherent BAPI-v2 L2 order books, native approximately 120ms frames, 520ms modeled taker arrival, visible depth,
  and configured taker fees.
- Time splits: fit through Aug 27, validation Aug 28-30, later Aug 31-Sep 3.
- All factor screens held primary size at 10 shares and reported primary signals separately from compulsory
  fallback fills.
- “100%” is 3,353/3,353 modeled replay fills. Live code can guarantee repeated attempts, not exchange liquidity,
  connectivity, or a fill.

## What actually affects entry quality

| Factor | Historical finding | Decision |
|---|---|---|
| Signal source | Usefulness changes by UTC session. Requiring every source often enters later at a higher price. | Do not require all parameters globally. |
| Entry price | Europe was positive in every split with a $0.65 ceiling; $0.98 increased accuracy but lost -$65.85 in the later primary segment. | Price must be part of edge, not only an execution limit. |
| Start time | Isolated primary signals favored Europe 90s and late-US 30s. Asia/US had no stable start. | Session-specific timing is material. |
| Velocity threshold | Europe and late-US favored the current threshold scale; halving US thresholds reduced damage but did not create a stable edge. | Never share one threshold across sessions. |
| Lookback | Europe favored 3.75s CLOB / 6s Binance; late-US favored 7.5s Binance. Asia improved at 4.5s but still failed validation. | Lookback is significant, but only in combination with source and timing. |
| Trend/gap confirmation | Helpful in Europe, unnecessary or harmful in Asia and late-US. US remained unstable even with full confirmation. | Treat these as conditional filters, not mandatory ingredients. |
| Repeated same-side entry | One-entry and two-entry caps reduced fills but lost -$377.28 and -$109.32 respectively. | The cap is implemented but inactive; the tested limits were not return-neutral. |

The strongest isolated primary combinations were:

| Session | Isolated primary combination | Fit / validation / later P&L at 10 shares | Status |
|---|---|---:|---|
| Asia | CLOB only; 60s; max ask $0.65; 4.5s / $0.015 | +$97.75 / -$29.33 / +$42.44 | Unstable |
| Europe | CLOB + Binance + trend + window-gap; 90s; max ask $0.65; 3.75s/6s | +$55.83 / +$4.57 / +$31.25 | Stable in isolation |
| US | Full confirmation; 60s; weaker thresholds; 6s lookbacks | -$8.74 / +$24.22 / -$4.17 | Unstable |
| late-US | Binance only; 30s; 7.5s / $10 | +$63.14 / +$21.91 / +$34.50 | Stable in isolation |

Those isolated combinations cannot simply be promoted. Requiring a modeled fill in every archive forces the
fallback to 120s Asia, 90s Europe, 60s US, and 90s late-US. In Europe that cutoff removes most of the 90-239s
primary opportunity. The combined compulsory-participation candidate produced only +$4.25 before reversal.

## Sizing result

The implemented experimental mode is anchored exactly to the example:

`shares = max(minShares, 60 × ((1-price)/price) / ((1-0.60)/0.60))`

Thus $0.60 requests 60 shares, $0.40 requests 135, and sufficiently high prices fall to the minimum. There is no
explicit payout target in that experimental formula. It is not active because price-only size has a causal flaw:
cheap contracts often have low win probability, so the formula places its largest orders on some of the least
likely outcomes. A valid next sizing model must require an out-of-sample estimate of `P(win | session, signal,
price, time)` and scale only when that probability exceeds all-in price plus fees.

| Candidate | Coverage | Fills | P&L | Cost | ROI | Later P&L | Max loss | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Minimum 10, one entry | 100% | 3,669 | -$377.28 | $23,553.67 | -1.60% | -$208.27 | -$10.00 | $474.82 |
| Minimum 10, two entries | 100% | 3,973 | -$109.32 | $25,114.51 | -0.44% | -$184.67 | -$10.00 | $329.44 |
| Minimum 10, up to four total signals | 100% | 4,182 | +$62.16 | $25,624.70 | +0.24% | -$195.32 | -$10.00 | $355.10 |
| Minimum 10, unlimited return sizing | 100% | 3,796 | +$949.12 | $62,326.14 | +1.52% | -$184.07 | -$80.99 | $1,363.74 |
| Previously validated active policy | 100% | 6,516 | +$279.43 | $20,520.72 | +1.36% | -$83.24 | -$10.00 | $264.93 |

The unlimited candidate has higher retrospective profit but fails the temporal stability and loss-minimization
requirements. Historical P&L cannot select a finite “unlimited” share count: when estimated edge is positive,
unconstrained expected P&L grows linearly without a mathematical optimum.

## Minimum-10 daily result (best tested variant)

| UTC date | P&L | Wins | Losses | Cost |
|---|---:|---:|---:|---:|
| Aug 22 | +$47.19 | 116 | 98 | $1,669.72 |
| Aug 23 | -$41.78 | 167 | 120 | $2,169.60 |
| Aug 24 | -$21.94 | 175 | 113 | $2,445.32 |
| Aug 25 | +$130.38 | 173 | 111 | $2,469.64 |
| Aug 26 | -$42.69 | 135 | 106 | $1,784.27 |
| Aug 27 | +$153.89 | 181 | 107 | $2,312.86 |
| Aug 28 | +$28.67 | 171 | 116 | $2,012.45 |
| Aug 29 | -$21.79 | 161 | 127 | $1,755.81 |
| Aug 30 | +$25.55 | 178 | 104 | $1,952.69 |
| Aug 31 | -$35.66 | 122 | 102 | $1,621.52 |
| Sep 1 | -$47.39 | 159 | 105 | $2,101.26 |
| Sep 2 | -$59.01 | 134 | 113 | $1,917.59 |
| Sep 3 partial | -$53.26 | 94 | 65 | $1,411.95 |
| **Total** | **+$62.16** | **1,966** | **1,387** | **$25,624.70** |

## Why the minimum-10 candidate loses

| Causal class | Loss rounds | Loss P&L |
|---|---:|---:|
| Wrong primary entry, never corrected | 568 | -$3,920.33 |
| Wrong compulsory fallback, never corrected | 637 | -$2,793.03 |
| Wrong primary entry, correction insufficient | 102 | -$449.99 |
| Correct primary entry, false reversal | 40 | -$287.62 |
| Wrong fallback, correction insufficient | 33 | -$126.39 |
| Correct fallback, false reversal | 7 | -$62.38 |

The dominant problem is not insufficient share size. It is 1,205 wrong and uncorrected initial decisions. Raising
size increases both winning and losing dollars; it does not repair that conditional edge. The complete loss-round
ledger is in the generated JSON report.

## Reproduction

- `node research/fastmx-signal-ablation.mjs`
- `FASTMX_SCREEN=price|start|threshold|lookback|fallback-rule|fallback-time node research/fastmx-entry-economics-screen.mjs`
- `node research/fastmx-reviewed-strategy-backtest.mjs`

