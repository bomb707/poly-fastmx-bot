# Wallet 0x3048 reconstruction — R7 update (2026-08-25)

## Scope and status

This is a new public-data cohort after the R6 cutoff. It covers 2026-08-25 09:30–10:55 UTC. The refreshed Gamma/v4 market set contains 17 BTC five-minute markets, 16 of which were settled at the final refresh, and 1,123 public wallet fills. Fire time is inferred independently from native v2 and v4 order-book transitions; signed timestamps are used only to group pre-built orders, and block publication time is not used.

The cohort strengthens the observable release model. It does **not** prove a stable-profit clone or reveal private unfilled orders/configuration.

## Grouped orders and fire timing

- 1,121 public transactions decode to 846 unique exact signed orders and 1,123 joined order appearances.
- Signed sizes are still exactly 25 or 75 shares: 533 observed 25-share orders and 313 observed 75-share orders.
- v4 infers 803 orders across the 15 markets that were resolved during feed collection: 687 high, 47 medium, and 69 low confidence.
- Native v2 independently infers the same 803 orders: 654 high, 37 medium, and 112 low confidence.
- The execution-method classification agrees on 100% of joined v2/v4 orders. The 803 methods are 575 immediate take, 102 take-plus-rest, and 126 rest.
- Among 647 orders that are high/medium confidence in both feeds, median absolute v2/v4 fire-time disagreement is 236 ms. Only 56.878% are within 500 ms or have overlapping transition intervals. This confirms that either source alone can select an optimistic transition; source disagreement must be treated as model risk.
- Same-side orders released within 300 ms collapse to 665 v4 action groups (323 entry/top-up, 275 hedge, 67 overhedge crossings) and 649 v2 action groups (320 entry/top-up, 260 hedge, 69 overhedge crossings).

## Menu, execution, and cycles

- The wallet again builds three major signing waves per window. Their median starts are approximately t−89.6 s, t+40.7 s, and t+171.5 s.
- 74.659% of v4 high/medium orders have a signed cap exactly equal to the pre-fire best ask; 7.357% are one tick above and 5.041% one tick below.
- 99.882% of signed limits are inside 0.12–0.89.
- The inferred first fire has median t+6.173 s; the last has median t+228.618 s; the median active window contains 56 inferred orders.
- Inventory reconstruction labels 353 exact orders as entry/top-up, 306 as pure hedge, and 75 as overhedge crossings. Median FIFO entry-to-hedge delay is 14.856 s. This again rejects a single entry/hedge cycle model.
- Among observed FIFO pairs, median raw pair cost is 0.98 and 64.028% are at or below 1.00. This remains the durable economic objective, while residual inventory is the unstable branch.

## Fresh release-signal replication

The new cohort reproduces the R6 release signature on both APIs. The strongest fire-versus-earlier-no-fire contrasts are:

| Causal feature | Native v2 AUC | v4 AUC | Fire direction |
|---|---:|---:|---|
| Three-level ask depth | 0.3035 | 0.3065 | lower |
| Top ask depth | 0.3269 | 0.3242 | lower |
| Top depth imbalance | 0.6313 | 0.6298 | higher |
| Microprice bias | 0.6289 | 0.6252 | higher |
| Three-level depth imbalance | 0.6219 | 0.6221 | higher |

The same direction holds separately for entry and hedge actions. Ask-depth depletion over 1–10 seconds and short time since the prior release also remain strong secondary features. Binance and RTDS are contextual controls, not the millisecond release clock.

## Fresh economics

After the final resolution refresh, the 16 settled windows earned an estimated fee-inclusive **+$244.67**. The first eight earned +$37.32 and the next eight +$207.35. This result is highly path-concentrated: using a seven/eight split before the eighth window resolved changes the early slice to −$43.92. A 16-window gain therefore is evidence that the wallet remained active and profitable in this short interval, not evidence of stable expectancy.

## Implication for Lockstep research

The observable wallet component is now highly repeatable: pre-signed 25/75-share ladders, three construction waves, a thin/depleting same-token ask book, positive same-token imbalance/microprice, exact-cap GTC with `postOnly=false`, and repeated inventory crossings. The missing piece remains the private menu/size/inventory controller.

For Lockstep, a safer capital-independent direction is to harvest fee-inclusive complete-set edge while failing closed on source disagreement and aggressively bounding unpaired exposure. The new dual-book research gate therefore requires both native v2 and v4 to satisfy the opening-cycle pair cap and uses the lower of their two bids. It remains research-only until latency, queue-credit, chronological, and fresh-forward gates all pass.
