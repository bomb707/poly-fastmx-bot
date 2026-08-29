# Passive Maker V33 Market-Implied Research — 2026-08-25

## Decision

**Reject V33. Stable profitability is not validated.**

V33 removes the V31/V32 spot-magnitude aggregation weakness exactly: weighted,
conservative, harmonic, geometric, and arithmetic Binance/Chainlink gap
aggregators produce identical placements, cancellations, fills, inventory,
spend, and PnL. The resulting market-implied policy is profitable in every
screen cell and every chronological fold, but it fails the predeclared profit
factor and window-bootstrap gates on V4 at 200 ms.

The nine-neighbor and full-stress configurations were specified before the
screen, but the screen failure means neither was executed. V33 was not frozen
or deployed. The PM2 bot remains in simulation on the existing bounded
every-market policy.

## Causal model

V33 gives the two public spot feeds a deliberately limited job:

1. Binance and Chainlink must agree on direction and each clear the unchanged
   0.002% support floor.
2. Their move magnitudes do not determine terminal probability.
3. The contemporaneous CLOB midpoint is the complete fair-probability input.
4. A post-only order still requires at least 0.03 modeled edge and every
   existing depth, confirmation, price, inventory, and cancellation gate.

In replay parameters this is `residualMarketWeight=1` and
`residualMaxSpotMarketProbabilityGap=1`. All execution invariants remain
unchanged: exact-price public trade fills, FIFO conserved maker credit,
130/200 ms maker latency, 500 ms cancellation, 520 ms taker assumption, no
automatic hedge, no terminal liquidation, zero maker rebates, and a
five-share residual target.

The screen, neighborhood, and full-stress files were fixed before the result:

| Design file | SHA-256 |
|---|---|
| `passive-maker-v33-market-implied-screen.json` | `1b30e28ef1a54e58962fbff4b75308fe06ae2827f5c188649d3b8c55443826f8` |
| `passive-maker-v33-market-implied-neighborhood.json` | `6ea558a08a78e0641ebcccf519af9b8bf3c8ea9619d8442f5f14d7889e7f9632` |
| `passive-maker-v33-market-implied-full.json` | `a5c7e82dfae41221d756e4e5e50bebf5738c80c5ab58e742d8481113abc95ce0` |

## Corpus and controls

Range: `2026-08-16T00:00:00Z` through the frozen boundary
`2026-08-25T12:55:00Z`.

| Reconstruction | Allowed / loaded | Failed |
|---|---:|---:|
| V2 executable, V4 confirmation | 2,478 / 2,478 | 0 |
| V4 executable, V2 confirmation | 2,664 / 2,664 | 0 |

Every V25 weighted control and V31 geometric control reproduces its
authoritative summary and per-window decision/economic rows exactly. V2 and V4
remain alternative executable-book reconstructions; their PnL is never added.

## Screen result

| Source | Latency | Credit | Active | Spend | PnL | ROI | PF | Max DD | Window lower 95% | Day lower 95% | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| V2 | 130 ms | 2.5% | 202 | 319.098792 | +43.730907 | 13.70% | 1.7019 | 6.193797 | +10.219798 | +21.535895 | Pass |
| V2 | 130 ms | 5.0% | 202 | 444.567290 | +56.449222 | 12.70% | 1.6793 | 6.773808 | +15.753413 | +22.695451 | Pass |
| V2 | 200 ms | 2.5% | 203 | 329.691277 | +39.648534 | 12.03% | 1.6344 | 7.820725 | +5.936871 | +15.242749 | Pass |
| V2 | 200 ms | 5.0% | 203 | 445.941773 | +56.815754 | 12.74% | 1.7334 | 6.182278 | +17.743154 | +25.703166 | Pass |
| V4 | 130 ms | 2.5% | 225 | 367.899743 | +42.294254 | 11.50% | 1.5417 | 7.811428 | +6.184450 | +21.831830 | Pass |
| V4 | 130 ms | 5.0% | 225 | 493.203089 | +57.009568 | 11.56% | 1.5678 | 8.256770 | +14.011799 | +25.875075 | Pass |
| V4 | 200 ms | 2.5% | 221 | 380.565930 | +30.378386 | 7.98% | 1.3492 | 9.837123 | -7.495840 | +6.858450 | **Fail** |
| V4 | 200 ms | 5.0% | 221 | 500.866719 | +38.842780 | 7.76% | 1.3556 | 8.200000 | -5.598991 | +6.369070 | **Fail** |

All 24 fixed chronological fold totals are positive. The two failed rows bind
only on PF below 1.5 and a non-positive window-bootstrap lower bound. There are
zero taker fills, fees, or maker rebates, and partial-fill cancellation is
exercised in every cell.

An initial evaluator output incorrectly called aggregation identity false
because one V4 window differed only in the unused
`residualSignalReversals` diagnostic count. The predeclared requirement was
economic identity. A stricter economic-row comparison confirms exact identity
for placements, cancellations, fills, inventory, capital, and PnL across all
five aggregation modes. This reporting correction does not change either V4
profitability failure or the rejection decision.

## What the result means

Removing spot magnitude makes V33 much less selective. At 2.5% credit it adds
110–131 active windows relative to V31. Total PnL rises in three cells, but
profit quality falls in all four:

| Source | Latency | Active delta vs V31 | PnL delta | PF delta | Window-lower delta |
|---|---:|---:|---:|---:|---:|
| V2 | 130 ms | +110 | +10.458661 | -0.809583 | -1.353846 |
| V2 | 200 ms | +123 | +11.440397 | -0.580754 | -0.422370 |
| V4 | 130 ms | +130 | +5.940506 | -0.675031 | -4.522022 |
| V4 | 200 ms | +131 | -0.546319 | -0.731571 | -14.065366 |

The V4/200 ms win rate is 71.04% (157 wins, 64 losses), yet the loss tail is
large enough to erase confidence. CLOB midpoint plus spot direction is
therefore too permissive under conservative execution timing. A future model
must retain a causal measure of spot-move strength while making that measure
less aggregation-sensitive than V31/V32; fitting a cutoff to remove V33's
observed losing windows would be post-selection overfit and is not attempted.

## Forward and runtime status

The untouched V17 forward cohort is hash-valid and research-only. At its
`2026-08-25T21:00:00Z` target it has 0.3368 elapsed days, 2 active windows per
source, V2 PnL `+4.85`, V4 PnL `+3.01454`, and zero window lower bounds. The
30-day, 100-active-window, fixed-fold, and positive confidence gates remain
incomplete.

The execution PM2 process remains online in `EXECUTION_MODE=simulation`. No
V33 setting was applied to it.

## Reproduction

```bash
npm run research:maker:v33:screen
npm run research:maker:v33:evaluate
```

The generated evidence is under `data/research/`. The gated neighborhood and
full-stress commands are intentionally not listed as completed work because
the screen did not qualify.
