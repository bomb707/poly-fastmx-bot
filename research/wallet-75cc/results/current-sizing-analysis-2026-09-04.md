# Target-wallet sizing analysis — 2026-09-04

## Scope and causal boundary

- Target: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`.
- Market: BTC Up/Down five-minute markets.
- Collection range: 2026-09-02 00:00 UTC through 2026-09-04 09:00 UTC.
- BAPI/Gamma market universe: 684 deterministic windows.
- Public BUY fills: 6,770.
- Exact Exchange V2 signed orders decoded from Polygon transactions: 6,770/6,770, with every order joined to its public fill.
- Discovery ends at 2026-09-04 00:00 UTC. Later orders are held out.

The signed transaction reveals the fixed USDC budget, integer minimum tokens,
and cent-denominated limit cap. It does not reveal the wallet's private forecast,
unreleased menu choices, or bankroll rule. Those components cannot be claimed as
an exact clone from public data.

## Reconstructed sizing mechanism

Every decoded target BUY uses an integer minimum-share quantity:

`budgetUsd = signedCap × minimumShares`

When execution improves below the signed cap, the fixed budget buys more tokens:

`actualFilledShares = budgetUsd / executionPrice`

Across all 6,770 orders, the signed minimum-share quantiles are 5 (p10), 7
(p25), 10 (median), 17 (p75), 42 (p90), and 171 (p99). The median fixed budget
is $6.84. This is a cap-indexed order menu, not one constant quantity.

The robust discovery-period median curve is U-shaped: approximately 32 shares
at a 5-cent cap, 27 at 10 cents, 8–10 through most of the 40–90-cent region,
and 14/15/18/19 at 95/96/97/98 cents. Low-cap quantities partly enforce a
minimum notional; high-cap quantities allocate more capital to high-confidence
states.

The runtime implementation normalizes this shape to the configured base size.
With a seven-share anchor it requests about 28 shares at 5 cents, seven around
70 cents, 12 at 95 cents, and 17 at 98 cents. It keeps the target's fixed-budget
execution semantics and clamps one adaptive order to 50 shares.

On 1,247 untouched Sep 4 target orders, the discovery curve reduced mean
absolute signed-size error from 12.97 shares for fixed seven to 11.81 and p90
error from 32 to 26. Median error was 3 versus 2, confirming that public cap
alone explains some tail allocation but not the private tier selection.

## Implemented direction and release policy

The wallet-side audit supports a five-second scored direction rather than the
old requirement that two threshold signals fire simultaneously. The score uses
three causal values available before an order:

`0.20 × CLOB level + 0.30 × CLOB 5s impulse + 0.50 × Binance 5s impulse`

Each component is normalized and clipped before weighting. A direction enters
at absolute score 0.35 and exits below 0.15. On the untouched target actions,
CLOB level and CLOB five-second impulse agreed on 81.7% of observations and the
agreed side was correct 91.5% of the time. By contrast, choosing momentum when
those two disagreed was only 43.4% accurate. The fitted three-source score was
87.8% accurate on the chronological holdout at target action times.

The implementation separates first entry, top-up, partial hedge, and strong
reversal. It starts first entries no earlier than t+15 seconds, requires signal
confirmation, latches one action per impulse, re-arms only after the exit band
or a material same-side price/score step, and caps a market at seven actions.
Opposing inventory is hedged only at score 0.60 or stronger and when estimated
pair edge is at least -$0.03/share. A reversal requires score 0.95, confirming
CLOB state plus a same-direction CLOB or Binance impulse, pair edge of at least
-$0.10/share, and crosses to a four-share residual.

## Exact final-policy replay

The final policy and sizing variants were replayed on the same 604 complete,
settled BAPI v2 L2 windows at 520 ms latency. Session-stop behavior was disabled
to compare the underlying strategies over the entire range. Sep 4 00:00–09:00
UTC was untouched while choosing the policy.

| Policy | Orders | Full-range PnL | ROI | Sep 4 holdout PnL | Holdout ROI |
|---|---:|---:|---:|---:|---:|
| Previous FastMX fixed seven | 10,168 | -$935.90 | -2.09% | — | — |
| Final signal/controllers, fixed seven | 3,541 | +$473.36 | +2.79% | +$80.57 | +2.63% |
| Target sizing, scale 0.50, max 20 | 3,539 | +$260.97 | +2.61% | +$40.01 | +2.23% |
| Target sizing, scale 0.75, max 20 | 3,541 | +$289.88 | +2.42% | +$46.42 | +2.15% |
| Target sizing, scale 1.00, max 20 | 3,543 | +$370.75 | +2.34% | +$73.78 | +2.58% |
| Target sizing, scale 1.00, max 50 | 3,543 | +$357.98 | +2.25% | +$72.14 | +2.52% |

The fixed-seven final policy produced 3,471 entry/top-up actions, 54 hedges,
and 16 reversals. Its 5.86 actions per market are materially closer to the
target's grouped-action rate than the previous bot's roughly 17 actions per
market.

Exact private release timing is not reconstructed. In 562 comparable markets,
the final policy emitted 3,309 actions against 3,594 target actions. On the Sep
4 holdout, one-to-one same-market/same-side matching within ±750 ms yielded
7.09% precision and 6.37% recall; matched decision time had a +113 ms median
delta. Of the 31 releases aligned in time without first requiring the side, 30
(96.77%) selected the target side. At ±2 seconds, precision was 16.08%, recall
14.44%, and matched-release side accuracy was 97.14%. This shows that
the observable direction relationship and action frequency improved, but the
wallet's exact release clock remains latent.

## Deployment decision

The scored direction, hysteresis, role-specific controllers, hedge economics,
and reversal rules are the new simulation defaults. The extracted sizing
mechanism is implemented as a persisted dashboard/config toggle but remains off
by default: every adaptive variant reduced untouched holdout PnL versus fixed
seven. Live simulation was not started. These results are historical and need
forward shadow validation before any live-capital use.
