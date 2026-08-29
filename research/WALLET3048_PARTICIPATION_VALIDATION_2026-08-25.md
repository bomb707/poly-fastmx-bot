# Wallet 3048 every-market participation validation

Generated 2026-08-25 UTC. This report evaluates the request to make trades
active in every BTC five-minute market. It is a simulation/backtest report, not
live realized PnL or a profitability guarantee.

## Causal execution assumptions

- V4 full L2 order books plus aligned V2 Binance/Chainlink RTDS.
- Polymarket Chainlink window open remains TWAP-60; spot feeds were unchanged.
- Taker decision-to-fill latency: 520 ms.
- Marketable GTC, `postOnly=false`; participation limit is decision ask + 0.02,
  capped at 0.89 and bounded below by 0.12.
- A fill is credited only if the first V4 L2 snapshot at/after arrival is
  executable within the submitted limit.
- An unmarketable arrival receives no fill credit, is canceled after three
  seconds, and may retry; maximum three participation attempts.
- Taker fees are included. Outcomes are consulted only at settlement.
- Requested range: Aug 16 through Aug 25. Available aligned data ended Aug 24
  04:25 UTC: 2,355 discovered, 2,104 normalized, 251 rejected.

## Result

| Policy | Attempt coverage | Fill coverage | Gross spend | PnL | ROI |
|---|---:|---:|---:|---:|---:|
| Existing L2 release only | 99.952% | 99.477% | $296,383.53 | -$18,039.57 | -6.087% |
| Existing release + participation floor | 100.000% | 99.952% | $296,873.47 | -$17,039.74 | -5.740% |
| Minimum-size participation floor only | 99.715% | 99.620% | $6,646.09 | -$241.72 | -3.637% |

The release strategy's repeated large entries dominate turnover and loss. The
isolated participation layer substantially reduces risk but remains negative
after fees.

## Residual mathematical screen

The one-trade screen evaluated 1,584 causal policies:

- Entry start: 5, 15, 30, 45, 60, 90, 120, 150, 180, 210, or 240 seconds.
- Brownian terminal probability from 70% Chainlink TWAP-60 gap and 30% Binance
  gap, with six volatility floors.
- Four spot logit weights and six CLOB-market logit weights.
- The chosen side maximized fee-adjusted expected value; the strategy still had
  to trade even when both choices had negative expected value.
- Aug 16–20 selected the formula. Aug 21 onward was untouched holdout.

No policy was profitable on both selection and holdout. The best train-selected
formula itself lost $35.01 on selection and $185.25 on holdout, with 99.76% full
coverage and -$220.26 total PnL.

## Decision

Every eligible market now supports a bounded participation attempt through
`W3048_PARTICIPATE_EVERY_MARKET`. Normal L2 release orders retain priority; the
fallback uses minimum size and retries only after cancellation. This capability
must remain in simulation until forward data demonstrates a positive edge.

The evidence rejects the stronger claim that guaranteed taker fills in every
market can currently deliver stable profit. Selective positive-EV residual
trading and universal fills are different objectives; forcing the latter removes
the EV gate and creates a fee/adverse-selection drag.

Reproduce with:

```bash
npm run research:wallet3048:participation
npm run research:wallet3048:participation-screen
```
