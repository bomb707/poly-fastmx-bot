# Passive Maker V17 Independent Forward Audit — 2026-08-25

## Verdict

**Not validated and not eligible for deployment.** The frozen research cohort is healthy, immutable, and initially positive, but the available forward sample is far too small. More importantly, the pre-freeze selection record explicitly rejected V17 and contains no validated immediate-parameter neighborhood. Fresh results are not allowed to repair that historical failure.

This verdict does not change the running paper bot and does not place orders. The forward monitor remains a research-only PM2 process.

## Independent gate

`research/passive-maker-forward-audit-v17.mjs` verifies all of the following without changing or replaying the frozen cohort:

- SHA-256 hashes for every frozen manifest file;
- a research-only mode and identical cohort start across manifest, state, V2, and V4;
- at least 95% window coverage and at most 5% failed windows;
- separate V2-native and V4 order-book results (never summed);
- all eight enabled execution stress cells: 130/200 ms maker latency × 2.5/5/7.5/10% maker credit;
- positive PnL, positive window and daily bootstrap lower bounds, profit factor at least 1.5, maximum drawdown at most 10, at least 100 active windows, and three complete positive 10-day chronological folds in every enabled cell;
- exact-price public-trade fills, post-only orders, zero rebate dependency, no taker fills or fees, 520 ms taker latency, no automatic hedge/liquidation, and a five-share residual target;
- exact inactivity for all four 300 ms over-latency cells;
- at least 30 elapsed forward days; and
- pre-freeze historical approval plus a tested, passing immediate-parameter neighborhood.

The script exits with status 2 when the result is not validated, preventing an accidental green CI result. Its detailed machine-readable output is written to `data/research/passive-maker-forward-v17-independent-audit.json`.

## Evidence at 2026-08-25T17:55:00Z

The cohort began at 2026-08-25T12:55:00Z, so only 0.2083 days have elapsed.

| Reconstruction | Loaded / expected | Failures | Active windows | PnL range across enabled stress | Drawdown | Window lower 95% | Profit factor |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2 native | 59 / 60 (98.33%) | 0 | 2 | +3.036407 to +4.850000 | 0 | 0 | undefined |
| V4 | 59 / 60 (98.33%) | 0 | 2–3 | +2.257235 to +3.413020 | 0 | 0 | undefined |

All eight enabled cells are positive, and all four 300 ms cells are correctly paused with zero orders, fills, capital, fees, rebates, and PnL. These are encouraging diagnostics, not proof: two or three active windows cannot establish a loss distribution, which is why the bootstrap lower bound remains zero and profit factor is undefined.

## Historical constraint

The selected pre-freeze V17 record has positive aggregate PnL, positive aggregate bootstrap lower bounds, profit factor above 1.5, drawdown below 10, at least 75 active windows, and positive PnL in each of three chronological folds for both V2 and V4.

It still fails the selection gate because:

- the original selection recorded `historicalPassed: false` and `acceptedHistorical: false`; and
- its neighborhood has `tested: 0`, `passed: 0`, and `robust: false`.

Consequently, no amount of early forward PnL can promote V17. The cohort remains useful as untouched evidence about the model family and execution assumptions, while a future candidate must pass historical and neighborhood gates before its own new forward freeze.

## Reproduction

```bash
npm run research:maker:forward:test
node research/passive-maker-forward-audit-v17.mjs
```

Expected current result: tests pass, then the audit returns `not-validated` with exit status 2.
