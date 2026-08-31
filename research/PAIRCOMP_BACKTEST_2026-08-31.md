# Pair-completion engine — first backtest

_2026-08-31 · `engine/strategies/paircomp.js` · reproduce with `node research/backtest-paircomp.mjs --split`_

Offline replay over the settled-window disk cache (`data/wincache`), 2,340 windows spanning
2026-08-14T05:55Z → 2026-08-31T01:10Z. No bankroll scaling and no session circuit breaker, so the numbers
measure strategy edge rather than a truncated range.

## 1. Why this was built

`TARGET_WALLET_STRATEGY_ANALYSIS.md` decomposes the target wallet's gross PnL into a **paired** component
(+$2,846.76 broad / +$2,840.80 fresh) and a **directional** residual (−$693.82 broad / +$178.87 fresh). The
deployed `helpme` strategy implements only the directional half. This module implements the paired half so the
two can be measured separately.

## 2. Results

| strategy | turnover | paired | directional | fees | NET | $/window | worst window |
|---|---:|---|---:|---:|---:|---:|---:|
| `helpme` fit | $128,940 | — | −$4,408 | $2,537 | **−$6,944.91** | −$5.94 | −$350.75 |
| `helpme` holdout | $85,957 | — | +$681 | $1,499 | **−$818.48** | −$0.70 | −$349.29 |
| `wallet3048` fit | $629,987 | 559,209 sh @ 0.9777 = +$12,464 | −$13,059 | $13,966 | **−$14,560.87** | −$12.46 | −$353.06 |
| `paircomp` fit | $10,479 | 9,834 sh @ 0.9399 = +$591 | −$848 | $190 | **−$447.73** | −$0.38 | −$15.88 |
| `paircomp` holdout | $5,332 | 4,804 sh @ 0.9301 = +$336 | −$593 | $93 | **−$350.38** | −$0.30 | −$17.05 |

## 3. What is established

**The pair mechanism reproduces.** `paircomp` forms pairs at a **0.9301** combined cost on the untouched
holdout half, against the wallet's measured **0.9306** (§1.1). Fit → holdout drift is 0.9399 → 0.9301, so this
is not a fitted artefact. The paired component is positive in both halves.

**`upAsk + dnAsk` is pinned at ~1.01** — below 1.00 in 0.00% of 4.44M cached ticks. A pair therefore cannot be
formed by crossing both asks at one instant; it is necessarily time-separated, which is what the lot-aware cap
`P_pair = 1 - oppositeLotPrice - g - feeReserve` (§9.2) exists to price.

**Risk profile is an order of magnitude better than `helpme`.** Worst window −$17.05 vs −$350.75; p05 −$3.86
vs −$98.31; median per-window turnover $10 vs $55–93.

## 4. What is NOT established — the open problem

**Every configuration is still net negative, and the directional seed is why.** Each pair must be seeded by a
directional leg, and the seed is adversely selected under every acquisition method measured:

- **Crossing the ask** — pays the spread plus a taker fee, and the mid drifts against the fill at every
  horizon measured (−0.23c @2s, −0.40c @10s, −0.53c @30s).
- **Resting under the ask** — no taker fee, but a resting bid only fills when its side is *falling*. Measured
  at −5.5% of turnover versus −1.3% for crossing, so it is strictly worse.

Seed legs won **51.4% / 51.9%** of shares at an average price of **0.522 / 0.527** — a hit rate equal to the
price paid, i.e. no edge over the market before fees.

The unpaired remainder is adversely selected for the same reason: completion requires your side to rally, so
you stay unpaired precisely when it does not. Seeds that never paired won 0–10% of the time.

**Flattening the residual does not help.** The complement's price already equals the residual's implied loss,
so closing at market converts a variance into a certainty of the same expected size. The residual's cost is
fixed at entry; only a seed with genuine edge can change it.

## 5. Parameter sensitivity (600-window subsample)

| override | paired cost | NET |
|---|---:|---:|
| `PC_PAIR_PROFIT_TARGET=0.03` | 0.9715 | −$269.17 |
| `PC_PAIR_PROFIT_TARGET=0.06` | 0.9532 | −$184.97 |
| `PC_PAIR_PROFIT_TARGET=0.10` (default) | 0.9290 | −$104.94 |
| `PC_LOSS_CAP_ON=true` | 0.9755 | −$152.23 |
| `PC_SEED_BZ_MIN_USD=10` | 0.9737 | −$638.50 |
| `PC_SEED_BZ_MIN_USD=40` | 0.9420 | −$79.48 |

A thinner pair margin buys more pairs at a worse combined cost and loses more. The late loss-cap branch
(§12.4) only adds expensive pairs and dilutes, so it defaults off. Loss scales with seed volume, which is the
signature of negative per-unit edge on the seed.

## 6. Where the remaining edge would have to come from

The wallet's paired:directional ratio is roughly **4:1** (+$2,846 vs −$694). `paircomp` achieves **0.57:1**
(+$336 vs −$593) on the holdout. Closing that gap requires either far more pair volume per unit of residual
exposure, or a seed that is not adversely selected.

The report attributes the wallet's seed advantage to sub-second reaction: pre-signed orders released on a
0.5s Binance move (§7), inside the ~2.5s median lag before the CLOB reprices (§1.1). This backtest models
520 ms latency against books sampled at 120 ms, so that advantage is not reproducible from this data —
confirming or refuting it needs the off-chain order-event stream listed in §16.

## 7. Measurement fix shipped alongside

`src/execution/session.js` halted the shadow permanently on the first `MAX_SESSION_LOSS` breach and reported
every subsequent window as $0, making a dashboard backtest indistinguishable from "traded the whole range and
broke even". The run result now carries `halted`, `haltedAtWindow`, `haltedAfter`, `haltedWindows` and
`maxSessionLoss`; the dashboard prints a warning banner; the backtest manifest header records the halt. Set
the session-stop field to **0** when measuring strategy edge.
