# Passive Maker V29–V31 Research — 2026-08-25

## Decision

**Stable profitability is not validated. Do not deploy V29, V30, or V31.**

V31's signed geometric aggregation of Binance and Chainlink moves is the
strongest historical challenger in this round. It passes every full V2/V4,
130/200 ms, and 2.5%–10% conserved maker-credit cell and improves the
conservative tail. It nevertheless fails the predeclared immediate-neighborhood
gate. Three of eight neighbors fail, so the result is not a robust local
plateau and no new forward cohort is frozen.

The PM2 execution bot remains in simulation on its existing bounded
every-market profile. None of these research policies was deployed.

## Frozen corpus and invariants

Range: `2026-08-16T00:00:00Z` through the frozen boundary
`2026-08-25T12:55:00Z`.

| Reconstruction | Allowed / loaded | Failed |
|---|---:|---:|
| V2 executable, V4 confirm | 2,478 / 2,478 | 0 |
| V4 executable, V2 confirm | 2,664 / 2,664 | 0 |

The allowed slugs and source precedence are taken from the authoritative
corpus. The older forward-v15 public-trade shard precedes the later R6
re-collection. Every experiment requires exact V25 control reproduction.

All candidates retain post-only GTC makers, exact-price public taker prints,
FIFO volume-conserved queue credit, 130 ms target maker latency, 200 ms stress,
500 ms cancellation, 520 ms taker latency, no automatic hedge, no terminal
liquidation, zero maker rebates, and a five-share residual target. V2 and V4
are alternative reconstructions and their PnL is never added.

## V29: cancel when modeled value disappears

V29 makes a resting directional order invalid as soon as the original causal
entry predicates stop passing, even when Binance and Chainlink still point in
the same direction. This is a threshold-free adverse-selection hypothesis.

The branch is heavily exercised: 3,332–3,584 value-loss cancellation requests
per cell. It is still harmful. Only one of eight screen cells passes. V29 loses
1.120763–6.960400 of PnL versus V25, reduces activity by five to seven windows,
and increases drawdown in every cell. V29 is rejected without full stress.

## V30: weaker-feed intersection

For same-direction feed moves, V30 replaces the weighted gap with:

```text
gap = sign × min(abs(chainlinkGap), abs(binanceGap))
```

It materially improves V2 ROI, confidence, and drawdown, but becomes too
sparse and source-sensitive. Activity is only 61–73 windows. V4 at 200 ms also
has negative daily lower bounds (`-2.725305` and `-7.725496`). No screen cell
passes every gate, so V30 is rejected.

## V31: signed geometric feed aggregation

V31 uses a standard scale-symmetric consensus rather than a fitted cutoff:

```text
gap = sign × sqrt(abs(chainlinkGap × binanceGap))
```

The value is zero when the two feeds disagree. The existing directional
support gate remains unchanged.

### Full stress result

All 16 enabled cells pass. All eight 300 ms cells are exactly paused.

| Source | Latency | Credit range | Active | PnL range | Max DD | Minimum PF | Minimum window lower 95% |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2 | 130 ms | 2.5%–10% | 92 | +33.272246 to +50.849411 | 7.999111 | 2.005618 | +11.573644 |
| V2 | 200 ms | 2.5%–10% | 80 | +28.208137 to +40.143966 | 6.372370 | 1.881923 | +5.921883 |
| V4 | 130 ms | 2.5%–10% | 95 | +36.353748 to +60.265415 | 8.123464 | 2.047153 | +10.706472 |
| V4 | 200 ms | 2.5%–10% | 90 | +30.924705 to +54.549386 | 5.651970 | 2.080761 | +6.569526 |

Every chronological fold is positive; the worst fold is `+7.182152`. Every
daily bootstrap lower bound is positive. There are zero taker fills, fees, or
rebates, and partial-fill cancellation is exercised in every enabled cell.

At the hardest 2.5% credit, V31 improves PnL versus V25 by 2.279502–8.724430,
improves the window lower bound by 2.147100–9.941049, and reduces drawdown by
1.117531–2.360661. At higher V2 credits some PnL deltas turn slightly negative,
but all absolute gates remain positive and drawdown remains lower.

### Immediate-neighborhood failure

The neighborhood uses 2.5% conserved credit on both source orientations and
both latencies. Controls and the V31 center reproduce exactly. Five symmetric
numeric neighbors pass, but three neighbors fail:

| Neighbor | Result | Binding failure | Worst active | Worst window lower 95% |
|---|---|---|---:|---:|
| harmonic aggregation | Fail | activity | 70 | +5.330003 |
| arithmetic aggregation | Fail | confidence | 89 | -1.926767 |
| minimum edge 0.035 | Fail | activity | 74 | +3.454489 |
| TTL 700 ms | Pass | — | 81 | +4.693472 |
| TTL 800 ms | Pass | — | 81 | +3.154537 |
| market weight 0.20 | Pass | — | 79 | +4.198335 |
| market weight 0.30 | Pass | — | 80 | +5.526374 |
| minimum edge 0.025 | Pass | — | 87 | +5.403790 |

Geometric aggregation is therefore a strong center but not a complete robust
plateau across immediate signal-model and entry-edge perturbations. Adjusting
the activity gate or fitting a narrower aggregation family after seeing these
results would be post-selection overfit. V31 is closed without a forward
freeze or runtime change.

## Existing untouched forward and paper operation

The frozen V17 monitor remains research-only and hash-valid. At its
`2026-08-25T19:55:00Z` target it has 84/84 windows loaded with zero failures
on each source, 0.2917 elapsed days, and only two active windows per source.
V2 remains `+4.85`; V4 remains `+3.01454`. Lower window bounds are zero and
the 30-day, 100-active-window, and fixed-fold gates remain incomplete.

The PM2 paper bot is online in `EXECUTION_MODE=simulation`. A direct MongoDB
check of the latest ten BTC five-minute windows through
`btc-updown-5m-1787689800` shows exactly one five-share
`participation-floor` fill per window at approximately `t+30.52s`.
This proves bounded participation, not profitability; the session breaker can
and should halt future participation after its configured loss limit.

## Reproduction

```bash
npm run research:maker:v29:screen
npm run research:maker:v29:evaluate
npm run research:maker:v30:screen
npm run research:maker:v30:evaluate
npm run research:maker:v31:screen
npm run research:maker:v31:evaluate
npm run research:maker:v31:full
npm run research:maker:v31:evaluate-full
npm run research:maker:v31:neighborhood
npm run research:maker:v31:evaluate-neighborhood
npm run research:maker:forward:test
```

The generated JSON evidence is kept under `data/research/` and is intentionally
not treated as a profitability guarantee.
