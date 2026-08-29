# Helpme live execution probe — 2026-08-27 UTC

## Scope and safety

- Production PM2 remained code-locked to simulation.
- A separate CLI process temporarily enabled live execution only inside that process.
- Every order used the current BTC five-minute market, live book constraints, and a hard `$2.50` principal cap.
- Prepared order IDs were persisted before POST; authenticated order/trade reads reconciled every response.
- Final authenticated open-order count: `0`.

## Official execution semantics checked

- Book `tick_size` and `min_order_size` are authoritative per market.
- A market BUY is a fixed-USD maker amount with a worst-price cap.
- FAK fills available liquidity and kills the remainder.
- A non-post-only GTC can cross immediately and leave only an unfilled remainder resting.
- Only an unmatched remainder can be canceled; a marketable order cannot be canceled during its taker-delay hold.
- This BTC market reported `itode: true` and fee details `{r: 0.07, e: 1, to: true}`.

## Observations

| Probe | Type | Principal | Result | Sign ms | POST ms | Total ms | Cancel ms |
|---|---:|---:|---|---:|---:|---:|---:|
| Baseline | crossing GTC | `$1.45` | 5 shares matched | 3.61 | 289.16 | 292.87 | — |
| Correct fixed-USD | FAK | `$1.75` | 5 shares matched | 4.39 | 716.31 | 724.21 | — |
| Network/cancel control | post-only GTC | `$1.0005` reserved | 0 fill, canceled | 4.24 | 55.04 | 61.86 | 54.40 |
| Crossing GTC | GTC | `$1.50` | 5 shares matched | 4.31 | 159.55 | 166.57 | — |
| Repeat fixed-USD | FAK | `$1.00` | 16.666665 shares matched | 4.99 | 298.23 | 308.69 | — |
| Final crossing | GTC | `$2.35` | 5 shares matched | 4.62 | 363.94 | 371.47 | — |
| Internal remainder branch | GTC | `$1.80` reserved | 0 fill, auto-canceled | 4.97 | 58.96 | 66.71 | 53.21 |

Matched GTC (`n=3`): mean `276.97 ms`, median `292.87 ms`.

Matched FAK (`n=2`): mean/median `516.45 ms`.

On this small production sample, crossing GTC reduced mean acknowledgement latency by `46.4%`. The no-fill
control shows the reusable connection path itself is about `55 ms`; most remaining matched-order latency is in
the venue's taker path. All five matched trades reached `CONFIRMED` during the probe.

The final non-post-only resting control directly exercised the engine's new automatic remainder branch: the GTC
acknowledged `live` with zero fill, then the engine positively canceled it in `53.21 ms`; authenticated follow-up
reported `CANCELED`, zero matched shares, and no trades.

The five filled probes spent `$8.05` principal. The collateral balance changed from `$70.774808` to `$62.346659`;
the `$0.378149` difference is exactly consistent with the documented crypto taker-fee formula across these fills.
The purchased outcome shares were intentionally not sold or hedged, matching the operator's buy-only policy.

## Implemented decision

- Default isolated live taker transport: `GTC`.
- If the acknowledgement reports fewer shares than the signed size, cancel the remainder immediately and let
  the existing authenticated reconciler adopt any fill that races cancellation.
- Override: `LIVE_TAKER_ORDER_TYPE=FAK` restores true fixed-USD FAK.
- `LIVE_GTC_CANCEL_REMAINDER_MS` can add an intentional delay; default `0`.
- The simulation/backtest strategy remains fixed-USD FAK so this execution experiment does not rewrite its
  historical model.

This establishes a measured execution improvement, not a profitability claim. The order-type comparison is
small and should continue to be monitored if real strategy execution is later enabled.
