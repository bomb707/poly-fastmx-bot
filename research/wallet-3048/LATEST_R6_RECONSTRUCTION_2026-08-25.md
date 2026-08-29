# Wallet 0x3048 reconstruction — R6 update (2026-08-25)

## Status

The public behavior is now reconstructed as a three-stage policy, but a stable-profit clone is **not confirmed**. The untouched R6 cohort is especially useful because the wallet itself changed from +$804.28 in the first 71 windows to -$102.10 in the next 71. Any model selected for first-half profit and failing the later half is rejected. No result in this report is promoted to live execution.

## Untouched cohort and source checks

- Range: 2026-08-24 21:35 UTC through 2026-08-25 09:30 UTC.
- 142 Gamma-verified BTC five-minute markets, 9,983 public fills, and 7,221 unique decoded signed orders.
- Native v2 and v4 full-depth orderbooks cover 142/142 markets.
- Fire inference is independent of on-chain publication time: v4 inferred 7,218 orders (6,499 high/medium confidence); v2 inferred 7,132 (6,147 high/medium).
- On 5,633 orders where both sources are high/medium confidence, the inferred method agrees 100%; median absolute fire-time difference is 360 ms.

## Reconstructed mathematical policy

### 1. Pre-signed menu

The wallet constructs two-sided GTC menus in approximately three waves per window. Median wave starts are t-89.724 s, t+40.820 s, and t+171.650 s. Filled signed sizes in R6 are exactly 25 or 75 shares. Limits form a cent ladder concentrated inside 0.12–0.89.

### 2. CLOB release clock

The immediate release clock is L2 liquidity, not the on-chain timestamp and not a slow spot trend. A causal release score has the qualitative form

`H = f(-askDepth1, -askDepth3, +topImbalance, +depth3Imbalance, +micropriceBias, -askDepth3Change1s, inventory, time)`.

The strongest single-variable R6 effects are lower three-level ask depth (AUC 0.2765), lower top ask depth (0.2997), higher top imbalance (0.6407), higher three-level imbalance (0.6380), higher microprice bias (0.6356), and one-second ask depletion (0.3694). Chronological release-tree holdout AUC is 0.7370 on v4 and 0.7311 on v2. This is the most source-stable part of the reconstruction.

### 3. Execution and cancellation

82.259% of releases are marketable at the inferred fire time and 73.150% use the exact pre-fire best ask. The compatible order is GTC with `postOnly=false`: it takes executable liquidity at its fixed cap and leaves a remainder resting. The replay uses 130 ms decision-to-queue latency and 520 ms decision-to-fill latency.

For publicly recoverable replace sequences, median resting lifetime is 1,719 ms, median cancel-to-replacement delay is 1,295 ms, and median replacement price change is +$0.01. Only 6.119% are same-limit retries.

### 4. Inventory/cycle state

R6 has 3,253 entry/top-up actions, 2,606 hedge actions, and 640 overhedge crossings. Median entry-to-hedge delay is 16.33 s; there are 4.752 inventory sign crossings per active window. This rules out a single entry/hedge pair. Multiple cycles and partial maker/taker fills coexist.

75-share actions are more common for inventory deficits, overhedge crossings, later signing waves, and late-window releases, but the causal large-size classifier transfers weakly (v4 AUC 0.5722; v2 0.5707). This branch is likely affected by live private configuration and is not safe to clone with a fixed threshold.

## Economics

The wallet earned $702.18 over R6 on $99,884.57 cost (0.703% ROI), before any maker rebates:

- first 71 windows: +$804.28 (1.838%);
- later 71 untouched windows: -$102.10 (-0.182%);
- 92,621.28 complete-set shares: +$1,189.36, or 1.2841 cents per set;
- 18,461.26 residual shares: -$487.17.

Thus the durable economic component is cheap complete-set cycling. Residual directional exposure is the unstable component. The target wallet itself does not demonstrate stable profit in both halves.

## Falsified clone hypotheses

- Frozen r5 release model plus old size tree: rejected; the size branch emitted 58–78% large actions versus the wallet's 33.6%, producing large losses.
- CLOB cycle grids: 15 variants were profitable on the fit half, zero on the untouched half. The closest was +$276.07 then -$282.93 on v4.
- The same closest-to-flat cycle on native v2: -$631.45 fit and -$1,235.52 holdout; rejected by cross-source validation.
- Terminal forced hedging: zero of 36 variants profitable in the untouched half.
- Pending-order replacement/reservation controls: reduced some exposure but zero variants profitable in both halves.
- Binance/Chainlink threshold permission: only one two-half-positive cell, but it had just 1 active fit window and 9 active holdout windows; rejected for inadequate support.
- Normal-CDF fair value, `P(side)=Phi(g/(sigma*sqrt(T)))`: outcome calibration transferred, but every adequately active execution policy lost in both halves because release-time adverse selection and residual fills dominated.

## Maker queue calibration

The expanded conditional audit covers 5,069 isolated maker orders across 941 windows and 12 UTC days. In the queue-consistent subset (2,226 orders), weighted raw capture is 11.9077% and the window-cluster bootstrap lower 95% bound is 11.1595%. The middle chronological fold, however, captures only 9.0951% (6.5636% lower bound). Therefore a universal 10% queue credit is rejected; maker capture is regime-dependent. Public data still cannot reveal unfilled private orders, so this remains a conditional calibration rather than an unconditional placement-to-fill probability.

## Current conclusion

The best-supported reconstruction is:

1. pre-sign a two-sided 25/75-share cent ladder in three waves;
2. release a branch when same-token ask liquidity becomes thin/depleted while bids and microprice support it;
3. submit exact-cap GTC, `postOnly=false`, allowing taker plus resting remainder;
4. cancel/reprice on an approximately 1–2 second, state-dependent clock;
5. run repeated inventory crossings, prioritizing fee-inclusive complete-set cost;
6. use Binance and corrected Chainlink TWAP as slower context/configuration inputs, not the millisecond fire clock.

The missing stable component is the private, changing inventory/size/menu policy—not the observable CLOB release gate. Research remains fail-closed: no live promotion until a frozen policy is positive on both native v2 and v4, across untouched chronological folds, latency and maker-credit stress, with bounded residual exposure.
