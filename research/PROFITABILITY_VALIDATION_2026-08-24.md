# Lockstep profitability validation — 2026-08-24

## Status

`NOT YET CONFIRMED STABLE` remains the only defensible status.

> **Latency-assumption retirement (2026-08-24 08:08 UTC):** maker placement is `130ms` from decision to queue, while taker execution is `520ms` from decision to fill. The former `2733ms` maker assumption is retired. Both PM2 monitors based on it were stopped before any strategy could be promoted, and every v11/v12 result below is retained only as a rejected audit trail. It must not be used for strategy selection, profitability claims, or forward confirmation. Current evidence restarts from the corrected `130ms maker / 520ms taker` model.

No strategy can guarantee profit in every future window or day. Final evidence still requires robust fee-inclusive historical tests followed by an untouched 30-day forward-paper cohort and all three predeclared chronological forward folds.

The existing Lockstep runtime remains `EXECUTION_MODE=simulation`. The retired maker-research PM2 processes are stopped.

## Authoritative 130ms-maker / 520ms-taker restart

The corrected same-snapshot FIFO replay was rerun across all 739 discovered archive windows (734 usable, five failed normalizations). Maker orders enter the simulated queue `130ms` after decision; taker exits consume the first recorded v4 book at or after decision plus `520ms` and pay the crypto taker fee. The stress grid uses maker placement delays `130/200/300/520ms` and queue credits `7.5%/10%/25%`.

The former p90/timeout-10 policy fails every actual-130ms cell:

```text
maker credit       net PnL    profit factor    window lower95    profitable dates
7.5%                -$9.95          0.92            -$50.66              5/11
10%                 +$0.25          1.00            -$41.45              5/11
25%                +$10.70          1.07            -$38.10              7/11
```

Only one of the full 12 stress cells passes all development gates, and it requires both a non-authoritative `520ms` maker delay and optimistic `25%` credit. Therefore the old policy is rejected under the corrected latency semantics. Machine-readable evidence is `data/research/passive-maker-maker130-baseline-full-stress.json`; reproduce the fail-closed verdict with `npm run research:maker:130:baseline:validate`.

Replacement research must pass at the exact `130ms` maker latency and conservative `7.5%` credit before any new forward cohort is frozen.

## Rejected legacy 2733ms audit trail

Everything from this heading through the old v11/v12 forward sections is retained for reproducibility only and is not current profitability evidence.

## Why v8 was rejected

The earlier replay could reuse one public exact-price trade independently across overlapping simulated maker orders. The corrected allocator now shares one FIFO, volume-conserved maker-credit budget across all matching own orders. Under that harder model v8 fell from 45/45 to 42/45 positive chronological stress cells, so its earlier headline result is not accepted.

The allocator and its regression tests are in `research/passive-maker-fill-model.mjs` and `research/passive-maker-fill-model.test.mjs`.

## Frozen v11 candidate

- Quote post-only GTC buys at both best bids only while their sum is at most `$0.90`.
- After an asymmetric fill, quote only the missing outcome while average held cost plus its bid remains at most `$0.90`.
- Submit valid 5-share orders and cap inventory at 10 shares per outcome (up to two cycles).
- Operate in the `$0.12..$0.89` band from `t+5s` through `t+255s`.
- If at least five excess shares remain one-sided for 15 seconds, stop refreshing, let outstanding maker orders clear, then sell only the excess using the first v4 book at or after decision plus `520ms`. Sub-five-share residuals cannot use this exit and settle normally.
- Normalize faster maker submissions to a deliberate `2733ms` decision-to-arrival target. If measured maker latency exceeds `3500ms`, place no orders.
- Binance aggTrade/REST-open and Polymarket RTDS Chainlink TWAP-60 feeds remain unchanged. Entry uses CLOB complete-set economics and own inventory, not a newly fitted directional spot signal.

Frozen configuration: `research/passive-maker-pair-selected-v11.json`.

## Conservative execution model

A maker fill requires a normalized public market-wide taker print at the exact one-cent maker price. The print first consumes visible same-price queue ahead; only 10%, 25%, or 50% of the remaining volume is credited, shared FIFO across overlapping own orders. Public timestamps have one-second precision and are moved to the end of their reported second.

An archive-wide audit found zero literal duplicates among 1,354,565 collected prints. Forward collector schema 3 nevertheless drops any future exact duplicate conservatively while preserving distinct fills that merely share a transaction hash.

Polymarket's exchange supports matching complementary BUY orders through a CTF mint. The full v4 corpus also shows that complementary liquidity is one mirrored queue: across 739 files, 1,324,223 snapshots, and 52,970,265 checked levels, outcome asks and opposite-outcome bids match 100% in both complementary price and size. The reproducible artifact is `data/research/v4-complement-mirroring-audit.json`.

Every taker sell is limited by visible v4 bid depth at `decision + 520ms` and pays `0.07 × price × (1-price) × shares`, rounded to five decimals at each consumed level. Maker rebates are not credited. Settlement outcome is used only for PnL.

The exact-price interpretation is supported empirically: normalized public prints match 308/308 audited target-wallet transaction hashes and 306/308 exact outcome/prices within 1.1 cents. BTC five-minute `orderMinSize` is enforced at five shares.

## Maker-credit calibration and safety margin

The 10% credit is no longer only an arbitrary sensitivity row. A separate calibration joins the tracked wallet's public maker fills to independently inferred v4 order arrivals and normalized market-wide exact-price taker flow. It accepts only high/medium-confidence, maker-only resting orders; matches the exact transaction, outcome, and one-cent price; excludes overlapping target orders at the same token/price; and reports visible pre-arrival queue separately.

An earlier per-order settlement join was unsuitable for this purpose because a transaction containing multiple target orders could assign the transaction's whole public fill to each order. The calibration instead uses the wallet's direct public maker-fill rows and rejects any order whose target shares exceed total exact-price market flow.

The stricter queue-consistent subset contains 1,369 isolated orders across 493 windows and 11 UTC dates:

```text
target maker shares                         37,535.86
market-wide exact-price volume             311,047.49
volume after visible queue                 239,868.36
weighted raw capture                           12.07%
weighted post-queue capture                    15.65%
window-cluster bootstrap raw lower95           11.04%
window-cluster bootstrap post-queue lower95    14.20%
```

Three contiguous chronological calibration folds have raw capture of `25.34%`, `10.86%`, and `11.87%`. Thus the chosen 10% replay credit lies below every fold and below the clustered lower bound. The calibration is still conditional on a fill becoming public: another wallet's never-filled or privately cancelled orders cannot be enumerated, so this does **not** establish an unconditional placement-to-fill probability.

A separate volume-conserved replay searched the historical credit floor at measured `2733ms` maker and `520ms` taker latency. All stable-development gates pass at 7.5% credit but the 7.0% row fails the requirement for at least 80% profitable UTC dates. At 7.5%:

```text
net PnL                         +$79.00
profit factor                     1.95
window-bootstrap lower95        +$35.83
day-bootstrap lower95            +$0.77
profitable UTC dates               9/11
five chronological regimes          5/5 positive
```

This provides a roughly 32% haircut from the 11.04% conditional lower bound to the 7.5% historical gate floor. Credits from 1% through 5% do not satisfy the stable gates, so the result remains materially dependent on achieving real maker fills.

Machine-readable artifacts are `data/research/wallet-maker-credit-calibration.json` and `data/research/passive-maker-pair-v11-credit-floor.json`. Reproduce the calibration with `npm run research:maker:credit:calibrate`; reproduce the floor with `npm run research:maker:credit:floor`.

## Historical development evidence

The replay covers 734 usable BTC five-minute windows from 2026-08-14 00:00 UTC through 2026-08-24 04:35 UTC. Five chronological regimes are crossed with four network latency rows (`500/1500/2733/5000ms`) and three maker-credit rows (`0.1/0.25/0.5`). Enabled maker arrivals normalize to 2733ms; 5000ms rows must remain inactive.

- 9/9 enabled aggregate cells have positive PnL, paired PnL, window-bootstrap lower-95%, and day-bootstrap lower-95%.
- 45/45 enabled chronological regime × stress cells have positive PnL.
- 3/3 degraded-latency cells have zero placements, fills, and PnL.
- Each enabled cell has at least 9/11 profitable historical UTC dates.
- Maximum drawdown is at most 1.21% of gross buy spend across enabled cells.
- Neighboring `p90/e15/t15` and `p92/e10/t5` policies also pass all 15 chronological-credit cells, providing parameter-neighborhood evidence.

At measured network latency, conservative `0.1` queue credit, and `520ms` taker latency:

```text
settled windows             734
active windows              239
net PnL                +$100.56
ROI on gross buys         12.50%
profit factor               2.23
maximum drawdown           $9.68
drawdown / gross buys       1.20%
window-bootstrap lower95  +$54.06
day-bootstrap lower95      +$4.57
paired PnL                +$66.09
residual PnL              +$34.47
taker fees                 $10.03
profitable UTC dates          9/11
```

The five chronological PnLs are `+$33.38`, `+$40.91`, `+$22.20`, `+$2.46`, and `+$0.54`. Because v11 was chosen after the historical neighborhood audit, these are development robustness checks, not untouched final OOS evidence.

Machine-readable report: `data/research/passive-maker-pair-v11-volume-conserved-full-stress.json`. Reproduce all historical assertions with `npm run research:maker:v11:validate`.

## Forward confirmation gate

The clean v11 cohort starts at `2026-08-24T06:40:00Z`, writing `data/research/passive-maker-forward-v11.json` and `data/research/passive-maker-forward-v11-state.json`. Its first 30 expected UTC dates are frozen into three ten-date folds (`Aug 24–Sep 2`, `Sep 3–12`, and `Sep 13–22`). Stable paper profitability requires all of the following simultaneously:

- at least 30 elapsed days, all 30 expected UTC dates present, at least 95% expected-window data coverage, no more than 5% failed normalizations, and at least 100 active windows;
- positive PnL in every enabled stress within each of the three predeclared chronological forward folds;
- positive aggregate PnL, paired PnL, and window-bootstrap lower-95% in every enabled stress;
- zero placements/fills/PnL in every paused latency stress;
- measured-latency profit factor at least 1.25, at least 80% profitable represented UTC dates, and drawdown no more than 5% of gross buy spend;
- exact-price attribution, FIFO volume conservation, five-share minimums, normalized 2733ms maker arrivals, configured 520ms taker latency, rounded taker fees, and no taker buys.
- an exact SHA-256 match to the frozen v11 strategy, replay engine, fill allocator, fold logic, and collector manifest on every monitoring cycle.

Until every forward gate passes, v11 remains research-only and real orders remain disabled.

## Frozen timeout-10 challenger

The first active v11 forward window passively bought five shares at `$0.35`; its missing side did not fill, so the frozen 15-second timeout sold at `$0.33` and paid `$0.07739` in fees for a `$0.17739` loss. The market later resolved against the original inventory, so the risk exit prevented a larger loss. This observation was not removed from v11.

A pre-existing timeout neighborhood was then audited at the calibrated 7.5% and 10% credits. Ten and fifteen seconds pass every historical gate. Five seconds fails the newest chronological regime, while 20 and 30 seconds fail daily robustness. Timeout-10 would have exited the first v11 event near breakeven, so it was frozen as a **separate** challenger rather than retroactively replacing v11.

At 10% credit, measured maker latency, and 520ms taker latency, timeout-10 has historical PnL `+$104.36`, profit factor `2.36`, maximum drawdown `$9.33`, window lower-95% `+$59.77`, day lower-95% `+$5.33`, and 9/11 profitable UTC dates. All 45 chronological stress cells pass, all high-latency pause cells remain inactive, and its own stable credit floor is also 7.5%.

The challenger configuration is `research/passive-maker-pair-selected-v12.json`. Its untouched cohort starts at `2026-08-24T07:25:00Z` in PM2 process `poly-lockstep-maker-research-v12`, writing `data/research/passive-maker-forward-v12-state.json`. It uses the same three forward date folds and all the same gates as v11. Both processes are research-only, contain no CLOB order client, and run with `EXECUTION_MODE=simulation`.

Reproduce its assertions with `npm run research:maker:v12:validate`. Neither candidate can be called stable until one complete frozen 30-day cohort passes every gate.
