# Wallet 3048: native v2/v4 reconstruction update

Generated from the 2026-08-24 04:35–21:40 UTC cohort. This report uses on-chain data only to recover and group exact signed orders. It infers order-fire time independently from order-book transitions.

## Sources and coverage

- Wallet: `0x3048d65321be3497164cdfc2996f94f98a2e7537`
- Markets: 204; Gamma condition, winner, and token verification: 204/204, zero discrepancies.
- Public fills: 15,078; exact decoded signed orders: 12,926.
- Native v2 depth: `GET /orderbooks`, 50 ms frames, 20 levels, 204/204 markets.
- Native v4 full depth: 204/204 markets.
- The v2 API is treated as a first-class order-book source, not as a top-of-book proxy.

## Grouping before timing

The current signing menu is stable at 25-share base and 75-share large orders. Exact high/medium v4 hashes collapse from 11,607 orders to 10,337 same-side 300 ms action groups; 10.97% of actions contain multiple signed hashes. The roles reconstructed from inventory are 5,123 entry/top-up, 4,186 hedge, and 1,028 over-hedge/cross actions.

Signing happens in three recurring waves: approximately 89.7 seconds before open, t+40.6 seconds, and t+171.6 seconds, with a median spacing near 130.3 seconds. Those timestamps describe order construction, not submission.

## Fire-time inference

| Metric | v2 | v4 |
|---|---:|---:|
| Inferred exact orders | 12,926 | 12,907 |
| High/medium confidence | 11,645 | 11,607 |
| Median uncertainty interval | 50 ms | 43 ms |
| Taker / take+rest / rest | 10,705 / 1,032 / 1,189 | 10,693 / 1,028 / 1,186 |

Across the 10,593 hashes with high/medium confidence in both sources, execution-method agreement is 100%. Median absolute fire-time difference is 442 ms; 42.453% are within 250 ms and 51.695% are within 500 ms. This timing disagreement is retained as model uncertainty instead of selecting whichever source gives the best PnL.

## Reconstructed mathematical policy

For side `s` at time `t`, using the first three price levels:

```text
A1(s,t) = size at best ask
B1(s,t) = size at best bid
A3(s,t) = sum of first 3 ask sizes
B3(s,t) = sum of first 3 bid sizes
I1(s,t) = (B1 - A1) / (B1 + A1)
I3(s,t) = (B3 - A3) / (B3 + A3)
D1(s,t) = A3(s,t) - A3(s,t - 1 second)
M(s,t)  = (B1*ask + A1*bid)/(B1 + A1) - (ask + bid)/2
```

The source-stable release approximation implemented in the paper strategy is:

```text
eligible(s,t) =
    0.12 <= ask(s,t) <= 0.89
    and 4 <= t <= 270 seconds
    and A1 <= 100 and A3 <= 650
    and I1 >= 0.50 and I3 >= 0.20
    and (D1 <= -150 or M >= 0.0025)
```

Simultaneous sides are ranked by thinner ask depth, stronger bid support, greater depletion, and microprice bias. Binance `aggTrade` and RTDS Chainlink TWAP-60 are small tie-breakers, not the immediate fire trigger. The selected side submits a persistent GTC buy at the exact decision ask with `postOnly=false`.

Inventory rules use `Q=25`, `L=3Q=75`, a six-base-size lean ceiling, and a 1.5 second decision cooldown. Opposite inventory is prioritized only when its FIFO, fee-inclusive completed-set cost is at most 1.00. A large order is used for catch-up when the imbalance is at least `3Q`. This matches the observable two-size menu and entry/hedge cycles while placing capital under configuration control.

## Chronological imitation accuracy

The first 102 markets train the release tree; the later 102 are untouched.

| Source | All-action train AUC | All-action later AUC | Entry later AUC | Hedge later AUC |
|---|---:|---:|---:|---:|
| v2 | 0.7919 | 0.7850 | 0.7787 | 0.7830 |
| v4 | 0.7825 | 0.7804 | 0.7627 | 0.7743 |

This supports the L2 release model. It does not imply profitable settlement economics.

## Economics at 130 ms maker / 520 ms taker latency

The target wallet itself reversed from +$1,557.69 in the first 102 markets to -$2,086.27 in the later 102, ending at -$528.58 (-0.321% ROI). Therefore exact imitation of this cohort is not a stable-profit target.

The best frozen risk variant was the fee-inclusive 1.00 hedge cap:

| Replay source | First half | Later half | Full | Full ROI |
|---|---:|---:|---:|---:|
| v2 native orderbook | +$70.91 | -$22.19 | +$48.72 | +0.171% |
| v4 native orderbook | -$767.28 | +$616.66 | -$150.62 | -0.645% |

Its sign changes by source and half. It fails the promotion gate and remains paper-only. No stable-profit claim is made.

## Implementation status

- Added an isolated `wallet3048` strategy; Lockstep's Binance and Chainlink feed semantics are unchanged.
- Fixed the live CLOB depth state to apply both full `book` snapshots and absolute `price_change` deltas.
- The strategy receives evolving Up/Down ladders and rejects stale depth.
- Exact-ask GTC, `postOnly=false`, 25/75 sizing, multiple cycles, fee-inclusive hedge cap, cooldown, price bounds, and runtime configuration are implemented.
- Strategy, depth-state, Lockstep, RTDS TWAP-60, resolution-URL, and fast-order-path tests pass.

The implementation is a research candidate, not the active live strategy. Promotion requires positive later-half results on both v2 and v4 plus forward paper confirmation.
