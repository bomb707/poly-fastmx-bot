# Target75cc settlement-gap loss model — 2026-09-03

## Decision

Promote the independent settlement-gap model only as a conservative share-allocation modifier.
It does not select direction, bypass the CLOB/release gate, or increase an order. When the
settlement model opposes the selected side, it applies:

    scale = 1 - 0.10 * clamp(2 * (0.50 - settlement_probability), 0, 1)

The scale is always 0.90–1.00. Strong evidence for the selected side leaves the original
allocation unchanged; strong evidence against it cuts allocation by no more than 10%. This
preserves substantial winner-side participation.

Probability inputs are causal and side-oriented:

- Binance price relative to both the Binance open and settlement (Chainlink) open
- Chainlink/TWAP-60 relative to the settlement open
- Binance/TWAP direction agreement and disagreement
- gap in USD and basis points
- gap divided by seconds remaining (required reversal velocity)
- gap normalized by trailing 30-second Binance/TWAP volatility

Fine $10/$20/$50/$100/$150 hinges and UTC-session interactions were evaluated, but the
chronological validation criterion selected the 13-feature core model.

| Split | Rows | AUC | Log loss | Accuracy |
| --- | ---: | ---: | ---: | ---: |
| Train, Aug 14–24 | 24,910 | 0.7588 | 0.5852 | 69.27% |
| Validation, Aug 25 | 4,190 | 0.8193 | 0.5158 | 73.25% |
| Holdout, Aug 26 | 3,538 | 0.8415 | 0.4943 | 75.64% |
| OOS, Aug 27–Sep 3 12:00 UTC | 29,736 | 0.8012 | 0.5434 | 71.82% |

## Backtest protocol

- BTC 5-minute markets from cached causal V2 L2 data
- Range: 2026-08-22 00:00 UTC through 2026-09-03 12:00 UTC
- 3,337 markets
- 520 ms latency, visible-depth fixed-USDC FAK fills, modeled fees
- Regime enabled
- Baseline: previous target75cc regime, settlement downsize weight 0
- Enhanced: identical policy with settlement downsize weight 0.10
- Weight selected on Aug 25 only from 0.10, 0.25, 0.40, 0.60, 0.80, and 1.00
- Aug 26 holdout and Aug 27 onward OOS were not used to select the weight

## Aggregate result

| Metric | Baseline | Enhanced | Change |
| --- | ---: | ---: | ---: |
| Net PnL | $155.25 | **$184.09** | **+$28.84** |
| Return on filled cost + fees | 1.08% | **1.29%** | +0.21 pp |
| Profit factor | 1.0777 | **1.0942** | +0.0165 |
| Maximum drawdown | $113.91 | **$106.25** | **-$7.66** |
| Worst round | **-$19.40** | -$21.60 | -$2.20 |
| Traded rounds | 1,611 | 1,611 | 0 |
| Traded-round win rate | 71.26% | **71.51%** | +0.25 pp |
| Traded-round loss rate | 28.74% | **28.49%** | -0.25 pp |
| Fills | 2,530 | 2,515 | -15 |
| Average filled shares | 8.0167 | 7.9779 | -0.0388 |
| Reversal-related loss | -$1,483.69 | **-$1,451.77** | **+$31.92** |

Average allocation fell only 0.48%, while total PnL rose 18.58%. The candidate improves
aggregate and OOS economics, but is not an across-the-board tail-risk improvement because the
worst single round became $2.20 worse.

## Chronological checks

| Split | Baseline PnL | Enhanced PnL | Baseline / enhanced DD | Result |
| --- | ---: | ---: | ---: | --- |
| Validation, Aug 25 | $77.29 | **$80.15** | $34.17 / **$32.17** | pass |
| Holdout, Aug 26 | **$49.37** | $44.44 | **$26.94** / $27.33 | weak |
| OOS, Aug 27–Sep 3 12:00 | $75.43 | **$86.94** | $113.91 / **$106.25** | pass |

The holdout day is negative evidence and must remain visible. Promotion is based on the
validation-selected rule also improving the larger untouched OOS segment, not on holdout alone.

## Daily backtest

| UTC day | Baseline PnL | Enhanced PnL | Change | Enhanced traded rounds | Fills |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08-22 | -$23.13 | -$17.70 | +$5.42 | 108 | 183 |
| 2026-08-23 | $18.82 | $27.38 | +$8.57 | 125 | 185 |
| 2026-08-24 | -$42.53 | -$37.11 | +$5.41 | 127 | 216 |
| 2026-08-25 | $77.29 | $80.15 | +$2.86 | 141 | 240 |
| 2026-08-26 | $49.37 | $44.44 | -$4.93 | 115 | 171 |
| 2026-08-27 | $35.89 | $37.18 | +$1.29 | 126 | 189 |
| 2026-08-28 | $47.48 | $45.24 | -$2.24 | 125 | 175 |
| 2026-08-29 | $15.91 | $15.31 | -$0.60 | 154 | 226 |
| 2026-08-30 | $21.55 | $40.26 | +$18.71 | 152 | 225 |
| 2026-08-31 | $25.95 | $20.57 | -$5.38 | 116 | 188 |
| 2026-09-01 | -$91.03 | -$82.74 | +$8.28 | 128 | 207 |
| 2026-09-02 | $24.39 | $15.26 | -$9.13 | 116 | 187 |
| 2026-09-03 through 12:00 | -$4.72 | -$4.14 | +$0.58 | 78 | 123 |

Session PnL improved most in the US morning: $84.65 to $106.33. Early Morning improved
$68.69 to $71.46, Afternoon improved $46.36 to $51.82, and Evening weakened slightly from
-$44.44 to -$45.52.

## Remaining loss rounds and causes

The enhanced policy lost 459 of 1,611 traded rounds. Both-side final inventory accounts for
319 of those loss rounds (69.5%) and -$1,043.95 aggregate PnL. One-side final inventory
produced +$1,228.03 aggregate PnL. The dominant remaining loss mechanism is repeated late
crossing that leaves too much expensive inventory on both sides, especially the eventual loser.

| Round | Winner | PnL | Final Up / Down | What happened |
| --- | --- | ---: | ---: | --- |
| btc-updown-5m-1788263100 | Down | -$21.60 | 34.7 / 10.0 | Correct Down entry/top-up, then three late Up actions at 0.62–0.80. TWAP still opposed Up, but gap confidence was near 0.5 and the mild allocator could not prevent the false cross. |
| btc-updown-5m-1787517000 | Down | -$15.51 | 25.3 / 16.0 | Up entry at 0.81, Down reversal at 0.73, then a second Up reversal at 0.74; the last of three leader changes was wrong. |
| btc-updown-5m-1787611500 | Up | -$15.44 | 14.0 / 19.6 | Down entry at 0.81, correct Up reversal at 0.88, then late Down reversal at 0.89. High prices left little recovery margin. |
| btc-updown-5m-1787809200 | Up | -$14.59 | 9.2 / 21.4 | Correct Up entry followed by a late Down reversal and top-up; Binance and TWAP evidence opposed Down, but only reduced allocation about 2.7%. |
| btc-updown-5m-1788339300 | Up | -$13.83 | 18.2 / 26.0 | Three correct Up buys were overturned by one 26-share Down cross at 0.67; settlement probability for Down was 0.296, so the new model scaled that cross to 95.9%, which was insufficient. |

Common conditions were three or more CLOB leader changes, both-side terminal inventory,
late entries at $0.70–$0.89, Binance/TWAP disagreement or a small unstable gap, and a final
large cross overwhelming previously accumulated winner-side shares.

## Rejected alternatives

- Blending positive settlement probability into direction increased participation but worsened
  drawdown and tail losses.
- A negative-evidence log-odds veto looked better on validation but failed OOS: full PnL fell
  from $155.25 to $134.04 and drawdown rose from $113.91 to $118.57.
- Hard $20/$50/$100 settlement-gap vetoes removed few candidates and mostly removed winners.
- Downsize weights above 0.10 degraded validation PnL and drawdown.

The safe conclusion is to use gap evidence as a small, monotonic loss allocator, not as a
standalone trigger or a reason to buy more expensive shares.

## Next loss-control target

The unresolved tail risk is inventory transition, not settlement direction. A future model
should score a proposed reversal against preserving current winner-side shares and cap a cross
when it is late, expensive, still opposed by settlement evidence, and would make the new side
dominate gross inventory. That model must be trained and selected independently; this report
does not use OOS results to set such a threshold.
