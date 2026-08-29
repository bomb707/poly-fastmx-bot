# Passive Maker V32 Power-Ensemble Research — 2026-08-25

## Decision

**Do not promote V32. Stable profitability is not validated.**

The equal-weight harmonic/geometric/arithmetic signal ensemble passes every
V2/V4, 130/200 ms, and 2.5%/5% maker-credit screen cell. Its mandatory upper
model neighbor also passes every cell. The mandatory lower neighbor misses the
predeclared activity gate in both V2 200 ms cells, so the aggregation family is
not promoted to full stress or a forward freeze.

The PM2 bot remains in simulation on its existing bounded every-market policy.
V32 was never deployed.

## Model

For same-direction Binance and Chainlink percentage gaps, define the signed
harmonic (`H`), geometric (`G`), and arithmetic (`A`) means. Feed-direction
disagreement maps to zero. V32 predeclares three ensembles:

```text
lower neighbor = (H + G) / 2
center         = (H + G + A) / 3
upper neighbor = (G + A) / 2
```

This is a model-uncertainty ensemble, not a fitted numeric threshold. The
center is ineligible unless both leave-one-side-out neighbors pass every gate.

The aggregation implementation has direct unit tests for historical weighted
compatibility, disagreement handling, signed power-mean ordering, the ensemble
identity, and scale equivariance.

## Corpus and controls

Range: `2026-08-16T00:00:00Z` through the frozen boundary
`2026-08-25T12:55:00Z`.

| Reconstruction | Allowed / loaded | Failed |
|---|---:|---:|
| V2 executable, V4 confirmation | 2,478 / 2,478 | 0 |
| V4 executable, V2 confirmation | 2,664 / 2,664 | 0 |

Every V25 weighted control and V31 geometric control reproduces its
authoritative summary and per-window economic rows exactly. Source precedence,
slug allowlists, exact-price public trade fills, FIFO conserved maker credit,
post-only execution, 130/200 ms maker latency, 500 ms cancellation, 520 ms
taker latency, five-share residual target, zero automatic hedge, and zero
maker rebates remain unchanged.

V2 and V4 are alternative order-book reconstructions; their PnL is never
added.

## Center result

The center passes all eight source/latency/credit combinations:

| Source | Latency | Active | Credit | Spend | PnL | ROI | PF | Max DD | Window lower 95% | Day lower 95% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V2 | 130 ms | 91 | 2.5% | 85.986220 | +33.210888 | 38.62% | 2.5087 | 4.800000 | +11.511174 | +13.572149 |
| V2 | 130 ms | 91 | 5.0% | 131.839964 | +41.485002 | 31.47% | 2.1463 | 5.771070 | +12.039865 | +15.620599 |
| V2 | 200 ms | 79 | 2.5% | 82.633229 | +30.958137 | 37.46% | 2.5128 | 4.938855 | +9.889413 | +12.762861 |
| V2 | 200 ms | 79 | 5.0% | 125.432599 | +36.877819 | 29.40% | 2.1145 | 5.270287 | +9.047916 | +14.018772 |
| V4 | 130 ms | 94 | 2.5% | 105.282575 | +36.292389 | 34.47% | 2.2147 | 5.753792 | +10.663625 | +12.497179 |
| V4 | 130 ms | 94 | 5.0% | 158.381213 | +48.058767 | 30.34% | 2.1375 | 7.560287 | +15.667592 | +15.288774 |
| V4 | 200 ms | 88 | 2.5% | 98.029582 | +33.613347 | 34.29% | 2.2996 | 4.653627 | +10.193014 | +11.981059 |
| V4 | 200 ms | 88 | 5.0% | 147.971433 | +45.899552 | 31.02% | 2.2715 | 5.374577 | +16.197195 | +16.290615 |

All fixed chronological folds are positive. There are zero taker fills, fees,
or maker rebates, and partial-fill cancellation is exercised in every cell.

## Mandatory-neighbor result

The upper ensemble passes every cell with 84–98 active windows, positive
confidence bounds, PF of at least 1.8620, and drawdown no greater than 7.5603.

The lower ensemble passes six of eight cells. Its two V2 200 ms rows have:

| Credit | Active | PnL | PF | Max DD | Window lower 95% | Day lower 95% | Worst fold |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.5% | 73 | +27.233528 | 2.4609 | 4.938855 | +7.462346 | +8.836076 | +6.446308 |
| 5.0% | 73 | +31.888802 | 2.0757 | 7.382017 | +6.376638 | +7.804120 | +6.565913 |

Only activity fails, but 73 is below the predeclared minimum of 75. Lowering
the gate or choosing a blend between the lower ensemble and center after
observing this result would be post-selection overfit. V32 is therefore closed
without full stress, numeric-neighborhood search, forward freeze, or runtime
change.

## Reproduction

```bash
npm run research:maker:gap:test
npm run research:maker:v32:screen
npm run research:maker:v32:evaluate
npm run research:maker:forward:test
```

Generated machine-readable evidence is under `data/research/` and is not a
live-profit claim.
