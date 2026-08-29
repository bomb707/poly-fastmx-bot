# Lockstep early-value v1 — research decision, 2026-08-25

## Decision

`lockstep-early-value-v1` is the new **paper challenger**. It replaces the losing broad-entry
paper profile, but it is not approved for real-money execution. Historical replay is positive on
both native order-book sources; the untouched forward sample is still empty and the historical
bootstrap lower bounds are negative.

The bot remains fail-closed in PM2 simulation mode. Real order submission is disabled.

## Strategy

The price feeds are unchanged: Binance spot `aggTrade` plus the Binance REST window open drive the
signal, while Polymarket RTDS supplies the Chainlink-compatible TWAP-60 reference. CLOB prices are
used for execution, not as a replacement spot signal.

For each five-minute window, let `gap` be Binance spot minus the Binance window-open price, `I` be
the largest completed-window excursion over the preceding six windows, and `R` be seconds left.
The strategy admits the current leading outcome only when:

```text
abs(gap) > I * sqrt(R / 300) + $8
current-leader ask is in [0.80, 0.88]
seconds from window open <= 120
```

It buys five shares once per window with a marketable GTC order. The replay applies 520 ms from
decision to taker fill and walks the recorded ask depth. An existing entry may be paired only when
the opposite outcome can be acquired at no more than $0.02, using the existing post-only maker
hedge path and its 130 ms decision-to-queue assumption. The session loss breaker is $5 and the
dormant real-order hard cap remains $10.

The main improvement is selectivity. Entries after `t+120s` and low-confidence outcome prices
below $0.80 caused most of the baseline losses. Requiring a 500–2,000 ms confirmation and requiring
Binance/RTDS directional agreement were separately tested and rejected because both reduced
performance on the paired sources.

## Aug 16–25 full-depth replay

Range: `2026-08-16T00:00:00Z` through `2026-08-25T00:05:00Z`, half-open. Outcomes were verified
with Gamma. The run requested 2,593 windows; 2,338 were usable on both sources, with no winner
disagreements.

| Model | Source | Active | PnL | ROI | Profit factor | Max drawdown |
|---|---|---:|---:|---:|---:|---:|
| old broad-entry baseline | native v2 full depth | 132 | -$1.20 | -0.222% | 0.987 | $22.42 |
| old broad-entry baseline | v4 full depth | 125 | -$2.92 | -0.564% | 0.966 | $25.91 |
| early-value v1 | native v2 full depth | 64 | +$13.92 | +5.044% | 1.590 | $9.38 |
| early-value v1 | v4 full depth | 60 | +$14.82 | +5.697% | 1.723 | $6.38 |

The three fixed chronological blocks were positive on both sources:

| Block | v2 PnL | v4 PnL |
|---|---:|---:|
| Aug 16–18 | +$5.97 | +$7.00 |
| Aug 19–21 | +$2.57 | +$0.03 |
| Aug 22–25 | +$5.39 | +$7.79 |

The result also survived slower execution assumptions (maker/taker 250/750 ms): v2 +$12.23 and
v4 +$14.71. With **zero resting-maker fill credit**, it produced v2 +$14.27 and v4 +$14.82, so
the aggregate result does not depend on optimistic queue fills or maker rebates.

## Why this is not yet “stable profit”

Only 60–64 windows traded. Resampled 95% lower bounds remain negative: v2 -$9.12 per-window and
-$4.56 per-day; v4 -$7.75 per-window and -$4.72 per-day. Two individual UTC days were negative on
both sources, and Aug 18 has only 92/288 usable windows. Those facts prevent an honest stability
claim despite the positive total and chronological blocks.

## Frozen forward gate

A research-only PM2 monitor started a frozen cohort at `2026-08-25T01:10:00Z`. It imports no order
client and cannot submit CLOB orders. It verifies file hashes and evaluates native v2 and v4
independently. Promotion requires at least 30 elapsed days, at least 95% coverage, 100 active
windows per source, PnL above zero, profit factor at least 1.25, positive window-bootstrap lower
bounds, drawdown no greater than 5% of deployed capital, and three complete positive ten-day
folds. The earliest duration gate is `2026-09-24T01:10:00Z`.

Until all gates pass, this candidate stays in paper mode.
