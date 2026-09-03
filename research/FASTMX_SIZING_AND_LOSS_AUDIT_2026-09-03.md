# FastMX sizing and loss audit — 2026-09-03

## Decision

The blanket sizing increase is rejected. The implemented sizing targets are:

| UTC session | Normal entry | Reversal residual | Mandatory fallback |
|---|---:|---:|---:|
| Asia 00–07 | $2 | $2 (reversal off) | $1 |
| Europe 07–13 | $4 | $4 | $1 |
| US 13–21 | $2 | $2 (reversal off) | $1 |
| late-US 21–24 | $2 | $2 | $1 |

Each target is divided by the order's worst-price cap to obtain exact shares. Venue minimums still apply. Every
candidate order is then bounded by 100 shares/order, 500 gross shares, $250 round cost, four signal/fallback
orders, and a fee-inclusive $10 worse-settlement-loss ceiling. Europe is the only session where enlargement
remained profitable in fit, validation, and the later evaluation period; $4 produced the best Europe full-period
and later-period result among the tested targets. The later period was inspected while
making this decision and is therefore no longer a sealed holdout; fresh forward validation is required.

## Backtest method

- Coherent BAPI v2 L2 replays, causally sampled at 120 ms.
- Range: 2026-08-22 00:00 UTC through 2026-09-03 13:30 UTC; 3,353 five-minute BTC rounds.
- Actual registered FastMX strategy, 520 ms taker-arrival model, configured fee model, and visible L2 depth only.
- 100% participation means a modeled fill in every replay, not a guarantee that a live venue must fill an order.
- Replay fee state was corrected before the final run. Resolved taker fees now remain in inventory state for the
  next order's risk projection, matching shadow/live behavior. Maximum observed losing-round P&L is exactly
  -$10.00 after this correction.

## Sizing comparison

| Policy | Traded | Fills | P&L | Cost | Cost/round | Later-period P&L |
|---|---:|---:|---:|---:|---:|---:|
| All sessions $2 / fallback $1 | 3,353/3,353 | 6,701 | +$227.85 | $19,006.53 | $5.6685 | -$113.38 |
| **Implemented $2/$4/$2/$2** | **3,353/3,353** | **6,516** | **+$279.44** | **$20,520.72** | **$6.1201** | **-$83.24** |
| Aggressive pre-holdout optimizer | 3,353/3,353 | 5,726 | +$378.22 | $23,254.76 | $6.9355 | -$145.72 |

The implemented policy increases average deployed capital by 7.97% and full-period P&L by $51.59 (22.64%)
versus the corrected all-$2 baseline. It does not raise the loss ceiling. The aggressive optimizer is not
promoted because its later-period loss and drawdown are worse despite its higher retrospective total.

Session rejection details: Asia $4 was +$176.93 in fit but -$8.42 in validation and -$7.34 later; late-US $4
was +$145.02 / +$45.27 / -$75.14 across the same segments; every tested US target remained negative on fit and
over the full range. Europe $4 was +$137.84 / +$67.76 / +$44.19 and therefore passed the stability screen.
Fallback remains $1: raising it to $4 changed full-period US P&L from -$133.76 to -$299.80 and late-US from
+$76.22 to -$3.88.

## Final result by session

| UTC session | Rounds | Initial accuracy | Wins | Losses | P&L | Cost/round | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| Asia 00–07 | 929 | 65.231% | 606 | 323 | +$87.18 | $5.8408 | 1.0549 |
| Europe 07–13 | 873 | 66.781% | 571 | 302 | +$249.80 | $9.0108 | 1.1443 |
| US 13–21 | 1,140 | 53.246% | 607 | 533 | -$133.76 | $4.5552 | 0.9151 |
| late-US 21–24 | 411 | 45.985% | 192 | 219 | +$76.22 | $4.9519 | 1.1321 |
| **Total** | **3,353** | **59.201%** | **1,976** | **1,377** | **+$279.44** | **$6.1201** | **1.0511** |

The all-round initial accuracy includes forced fallbacks. Normal-signal entries alone were correct in
1,364/2,054 rounds (66.407%); fallbacks were correct in only 621/1,299 (47.806%). The weak overall US and late-US
figures are mainly caused by the forced minimum-risk fallback, whose accuracy was 30.444% and 26.733%
respectively. Increasing fallback size therefore increases losses and is rejected.

Normal-entry accuracy by session was 62.086% Asia, 66.667% Europe, 70.807% US, and 64.593% late-US. Accuracy
alone is misleading: the US signal token's average first price was 0.7043, leaving only 0.38 percentage point of
raw probability-minus-price edge before fees. US signal-led rounds consequently lost $59.90 despite 70.807%
direction accuracy. Europe averaged 0.6417 against 66.667% accuracy and late-US averaged 0.5997 against 64.593%,
leaving materially more room for payout and fees. This is the economic reason to enlarge Europe, not US.

## Daily result

| UTC date | P&L | Cost | Cost/round | Wins | Losses | Traded |
|---|---:|---:|---:|---:|---:|---:|
| Aug 22 | +$52.10 | $1,297.00 | $6.0608 | 116 | 98 | 214 |
| Aug 23 | +$32.33 | $1,707.01 | $5.9478 | 170 | 117 | 287 |
| Aug 24 | -$51.52 | $2,049.61 | $7.1167 | 175 | 113 | 288 |
| Aug 25 | +$122.94 | $2,164.17 | $7.6203 | 176 | 108 | 284 |
| Aug 26 | -$11.74 | $1,525.69 | $6.3307 | 136 | 105 | 241 |
| Aug 27 | +$141.89 | $1,893.21 | $6.5736 | 180 | 108 | 288 |
| Aug 28 | +$35.72 | $1,661.55 | $5.7894 | 171 | 116 | 287 |
| Aug 29 | +$16.11 | $1,111.43 | $3.8591 | 161 | 127 | 288 |
| Aug 30 | +$24.83 | $1,340.50 | $4.7535 | 179 | 103 | 282 |
| Aug 31 | +$4.21 | $1,328.97 | $5.9329 | 121 | 103 | 224 |
| Sep 1 | -$36.16 | $1,756.58 | $6.6537 | 160 | 104 | 264 |
| Sep 2 | -$6.33 | $1,474.92 | $5.9713 | 136 | 111 | 247 |
| Sep 3 partial | -$44.96 | $1,210.07 | $7.6105 | 95 | 64 | 159 |
| **Total** | **+$279.44** | **$20,520.72** | **$6.1201** | **1,976** | **1,377** | **3,353** |

## Why losing rounds lost

| Causal classification | Rounds | Loss P&L | Average loss | Interpretation |
|---|---:|---:|---:|---|
| Initial market direction later reversed | 341 | -$1,960.70 | -$5.7499 | Signal and absolute CLOB side agreed at entry; the final outcome flipped later. |
| Fallback followed market, outcome reversed | 161 | -$664.53 | -$4.1275 | No qualifying signal; forced entry followed CLOB, then the outcome flipped. |
| Initial signal opposed the CLOB side | 241 | -$1,322.10 | -$5.4859 | Both velocity sources agreed, but on a counter-move against the absolute CLOB favorite. |
| Wrong initial side, later corrected too little/late | 114 | -$388.67 | -$3.4094 | Opposite-side inventory was added, but not enough or early enough to make winner settlement positive. |
| False reversal after a correct entry | 39 | -$252.64 | -$6.4779 | Strict reversal fired, but the initial side ultimately won. |
| Cheap-side fallback was wrong | 481 | -$882.72 | -$1.8352 | The 100%-participation rule forced a low-cost long-shot position, mainly in US/late-US. |

The 502 market-aligned-then-flipped losses account for -$2,625.23. Another 722 losses started with a wrong
signal/fallback side and account for -$2,204.82. The remaining 153 are correction/reversal failures. This is why
larger global sizing is inappropriate: it magnifies the same non-stationary failure modes.

Momentum opposing the absolute CLOB favorite is not automatically a defect. Those entries had low win counts but
large cheap-token payouts and were profitable in aggregate over this sample. A new absolute-side agreement gate
would therefore delete both 241 losing rounds and a material set of profitable contrarian rounds; it must not be
promoted from loss-only inspection.

## Largest losing rounds after the fix

| UTC start | Session | Winner | P&L | First action | First price | CLOB midpoint | Mid/Binance velocity | Cause |
|---|---|---|---:|---|---:|---:|---|---|
| Aug 22 08:30 | Europe | Down | -$10.00 | Up entry @ 60.092s | 0.17 | 0.215 | +0.10 / +$40.99 | Signal opposed CLOB side |
| Aug 24 09:55 | Europe | Down | -$10.00 | Up entry @ 60.097s | 0.63 | 0.625 | +0.06 / +$13.75 | Market direction later reversed |
| Aug 27 09:30 | Europe | Down | -$10.00 | Up entry @ 63.082s | 0.1755 | 0.165 | +0.02 / +$10.00 | Signal opposed CLOB side |
| Aug 27 10:20 | Europe | Down | -$10.00 | Up fallback @ 90.083s | 0.74 | 0.735 | +0.04 / +$8.29 | Market-following fallback reversed |
| Sep 1 11:15 | Europe | Up | -$10.00 | Down entry @ 61.543s | 0.44 | 0.565 | -0.11 / -$13.92 | Signal opposed CLOB side |
| Sep 2 09:15 | Europe | Down | -$10.00 | Up entry @ 79.555s | 0.29 | 0.275 | +0.09 / +$14.17 | Signal opposed CLOB side |
| Sep 2 10:55 | Europe | Up | -$10.00 | Down entry @ 60.099s | 0.25 | 0.745 | -0.11 / -$41.04 | Signal opposed CLOB side |

The complete loss ledger is `data/research/fastmx-loss-rounds-2026-09-03.csv`; the JSON report includes all
rounds and classifications. Both are generated by `research/fastmx-loss-cause-analysis.mjs` and intentionally
remain local data artifacts. The sizing grid is generated by `research/fastmx-session-sizing-search.mjs`.
