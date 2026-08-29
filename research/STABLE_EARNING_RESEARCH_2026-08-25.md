# Stable-earning research status — 2026-08-25

## Decision

Stable future earnings are **not confirmed**, and no new strategy is promoted to live execution.
The bot remains in PM2-managed simulation mode. This is fail-closed: a profitable historical
aggregate is insufficient when either order-book source, a chronological slice, or a confidence
bound fails.

## Runtime safeguards applied

- Active strategy remains `lockstep`; Binance and Polymarket RTDS/Chainlink feeds are unchanged.
- Paper order size is five shares.
- The session loss breaker is `$5`.
- The dormant real-order hard cap is `$10` per order.
- Maker and taker timing assumptions remain 130 ms decision-to-queue and 520 ms decision-to-fill.

## New net-edge model tested

The candidate `net_edge_pair_q093_ttl750_stop120_postonly_v16`:

- admits two-sided post-only bids only while the visible bid pair totals at most `$0.93`;
- uses five-share orders and caps each outcome at ten shares;
- quotes from `t+5s` through `t+120s`, with a 750 ms quote TTL and modeled 500 ms cancel acknowledgement;
- never treats crossing during maker flight as a maker fill;
- consumes public exact-price taker prints against visible FIFO queue ahead with one shared,
  volume-conserved fill allowance;
- attempts an imbalance hedge every tick, but only below a fee-inclusive `$0.99` pair cap;
- after five seconds unpaired, permits bounded completion only up to `$1.00`;
- assumes zero maker rebate, so profitability does not depend on an incentive payment.

## Aug 16–25 replay

| Source | Loaded windows | Active windows | PnL | ROI | Profit factor | Max drawdown | Window lower 95% | Day lower 95% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Native v2 full order books | 2,320 | 96 | +$6.525 | 2.584% | 2.146 | $3.014 | **-$0.177** | +$1.479 |
| v4 full order books + Gamma | 2,509 | 105 | +$8.916 | 2.830% | 2.240 | $3.263 | +$0.450 | +$4.421 |

The aggregate is positive in both sources, but the v2 window-bootstrap lower bound is negative.
The v2 replay also loses `$0.957` on Aug 16, while v4 loses `$0.405` that day. The candidate is
therefore rejected for promotion. Its positive result is research evidence, not a stable-profit
claim.

## Why the revised architecture is safer

The important structural correction is `postOnly=true` for maker entries. With
`postOnly=false`, a bid that becomes marketable during the 130 ms flight can fill only one side as
a taker and destroy the intended complete-set edge. In the revised model, only the explicit,
fee-bounded imbalance hedge may take liquidity. This separates queue earning from emergency risk
reduction and makes the loss source measurable as paired PnL versus residual PnL.

## Ongoing promotion gate

Research-only PM2 monitors and the daily continuous-research job remain online. They cannot import
the order executor or submit CLOB orders. Promotion remains disabled until an untouched 30-day
forward cohort passes native v2 and v4 independently, including coverage, activity, positive fixed
chronological folds, positive lower confidence bounds, profit factor, drawdown, fee, latency, and
bounded-completion checks.

No mathematical strategy can guarantee profit in every market window. The practical target is
positive expected value with bounded downside, verified out of sample before risking capital.
