# Wallet3048 correctness audit

Reviewed branch: `version2`

Reviewed commit: `e654426abb9c779ee5dc764df8e805c983f91485`

Repair specification: wallet3048 v3. Real-money execution remains disabled in
code. No credentials or execution-mode controls were changed.

## Confirmed defects

1. `buildFeatures` reused a nonzero Binance impulse after its source timestamp
   became stale and reused the last distinct price change indefinitely across
   fresh unchanged-price updates.
2. Shadow called `step` before resolving fills already due, while replay resolved
   due fills first.
3. Resting maker partials reduced `pending.remaining` but did not enter inventory,
   cost, fees, or FIFO state until the order completed or was canceled.
4. Shadow and replay mutated an order-decision object into its first fill record.
   Durable persistence also keyed legacy fills by order and timestamp, which could
   collapse distinct same-timestamp partial fills.
5. Risk projection assumed every pending UP and DOWN order filled together. An
   unconfirmed opposite order could therefore create fictional risk capacity.
6. Multiple pending complements could reuse the same confirmed unmatched FIFO
   inventory for pair attribution.
7. Time at the public bid generated maker fills without trade or queue evidence.
8. Candidate economics valued a full parent at best ask instead of executable
   level-by-level VWAP.
9. Pair edge was attributed to the full parent even when only part of that parent
   matched confirmed opposite inventory.
10. Replay omitted depth timestamps, used a different BBA fallback at arrival,
    and mixed epoch and window-relative clocks by clamping source timestamps.
11. `realizedVol` was event-sampled return dispersion, so identical price paths
    could produce different values at different message rates.

## Repairs

- Binance impulses now expire independently of socket/update cadence. Binance,
  Chainlink, UP depth, and DOWN depth have separate source-time gates.
- Recorder output now preserves full L2 plus source and receive timestamps.
- Replay normalizes epoch milliseconds, epoch seconds, and relative milliseconds
  explicitly. Missing causal source times fail closed by default.
- Due executions are processed before decisions in both engines. An execution
  implied by the current update is processed before cancellation.
- Order intents remain immutable. Every partial fill gets a separate `fillId` and
  is booked immediately and exactly once; only its own remainder is reduced.
  MongoDB idempotency now uses that fill identity when available.
- Simultaneous orders consume a shared per-update ask-liquidity pool.
- Default unverified maker credit is zero. `touch` remains available only as an
  explicitly optimistic sensitivity assumption. Explicit observed sell flow can
  produce a maker fill.
- Risk is checked over independent pending-order fill subsets with and without
  the proposed order. Existing violations can only admit bounded repairs that do
  not worsen lean or worst-case payout.
- Pending complements reserve confirmed FIFO-matchable shares once.
- Parent economics use L2 VWAP and distinguish immediate, resting, matched, and
  newly directional quantities. Matched shares do not also receive directional
  expected-PnL attribution.
- Risk-reducing repairs report expected-PnL sacrifice separately from worst-case
  improvement.
- Fixed 50/150 sizing remains the baseline. A configurable incremental mode is
  present for future simulation research and is not deployed or validated.
- Volatility is now fixed-grid realized variance. Its default coefficient remains
  zero, so it is not asserted as a current loss driver.

Window spending is defined as gross token purchase cost excluding fees. Scenario
payoff and loss limits include modeled fees exactly once.

The configured crypto taker curve matches Polymarket's
[official fee schedule](https://docs.polymarket.com/trading/fees):
`shares * 0.07 * price * (1 - price)`, rounded to five decimals, with no maker
fee. Maker rebates are not credited. A future live review must still query the
token-specific fee-rate endpoint instead of assuming a market category.

## Regression coverage

The test suite covers timestamp clock-domain normalization, stale/unchanged
Binance impulses, independent source
freshness, immediate partial booking, event order, duplicate fill events,
fill/cancel races, pending-order scenario risk, FIFO reservation, maker evidence,
liquidity conservation, VWAP, partial pair attribution, configurable sizing, and
sampling-invariant volatility.

## Frozen cohort

The frozen manifest is `correctness-cohort-manifest.json`. It contains 14
consecutive BTC five-minute windows from `2026-09-08T03:55:00Z` through
`2026-09-08T05:05:00Z`, split chronologically into 8 development, 3 validation,
and 3 holdout windows. SHA-256 validation is mandatory before evaluation.

The cohort does not contain original Binance/Chainlink source timestamps or CLOB
trade/queue events. It is suitable only for sensitivity analysis.

## Results

| Version/assumption | All PnL | Fees | Turnover | Drawdown | Validation PnL | Holdout PnL |
|---|---:|---:|---:|---:|---:|---:|
| A. Original `e654426`, implicit time-at-bid maker | -$42.09 | $110.42 | $7,209.47 | $77.57 | -$13.28 | -$31.26 |
| C. Corrected strict causal, zero unverified maker | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| D/E. Corrected, timestamps assumed, zero unverified maker | -$146.53 | $121.50 | $4,648.39 | $281.02 | -$95.49 | +$61.71 |
| D/E. Corrected, timestamps assumed, optimistic touch | +$53.18 | $110.47 | $7,094.37 | $190.86 | -$76.61 | +$198.59 |

The strict result is no-trade, not break-even evidence: the required source times
are absent. The sign reversal between zero-maker and optimistic-touch assumptions
shows that unverified execution dominates this tiny cohort. The positive
optimistic result is not evidence of achievable profitability.

### Corrected-policy diagnostics

For the timestamp-assumed, zero-unverified-maker run, actual arrival cost was
`$4,648.39`, versus `$4,738.24` estimated at decision time. The `$89.85` price
improvement did not overcome settlement selection and fees. Immediate fill
contribution was `-$110.53`; the seven resting fill events contributed `-$36.00`.

Settlement contribution grouped by the order's declared purpose was `+$202.62`
for first entry, `+$373.68` for reinforcement, `-$197.54` for pair-completion
orders, and `-$525.29` for repair orders. This is fill-purpose attribution, not
standalone causal PnL: a completed pair's earlier leg remains attributed to its
original purpose. The 50-share parents contributed `-$267.32`; 150-share parents
contributed `+$120.79` in this sample.

The 172 filled parents recorded 304 independent pending-fill scenario checks.
No emitted fixed-size parent was outside the ordinary configured scenario limits.
This count covers emitted orders, not candidates rejected before emission.

| Zero-maker sensitivity | All PnL | Validation | Holdout |
|---|---:|---:|---:|
| Fixed 50/150, 520 ms | -$146.53 | -$95.49 | +$61.71 |
| Incremental 5-150, 520 ms | -$470.21 | -$101.52 | -$75.69 |
| Evaluate both sides while flat | -$337.77 | -$135.07 | -$60.21 |
| Fixed, 0 ms latency | +$450.66 | -$55.46 | +$192.14 |
| Fixed, 1,000 ms latency | -$269.90 | -$112.78 | +$19.17 |

These are diagnostic ablations, not tuned alternatives. The large latency swing
is further evidence that the cohort cannot support a robust profitability claim.

On filled orders only, the heuristic score's Brier value was `0.2104`, versus
`0.2119` for the CLOB market-probability feature. That tiny descriptive difference
does not establish incremental predictive value: observations repeat outcomes
within a window, selection depends on the policy, and the sample contains only 14
settlements. A regularized residual model was not fit because doing so while
retaining meaningful chronological validation and untouched holdout sets is not
credible with this cohort.

Versions B through E were repaired as one reviewable correctness set rather than
tuned as successive profitable policies, so an isolated PnL claim for each
intermediate letter would be fabricated. Version F is not present: probability
coefficients were not refit.

## Model target and profitability conclusion

The current coefficients were assigned heuristically from public wallet analysis.
They were not fitted or calibrated to settlement outcomes, and they were not fit
as a wallet-side-choice classifier. `fairProbability` must therefore be treated
as a strategy score, not a validated settlement probability.

There is no defensible chronological out-of-sample profitability result. The
available cohort is only 70 minutes and one UTC day, strict causal replay cannot trade it, the
assumption-based baseline is negative, and optimistic maker credit changes the
sign. A defensible study needs a much larger predeclared chronological cohort with
source timestamps, full L2 sequence data, trades/order events, queue assumptions,
and a final holdout that does not influence implementation or tuning.

## Simulation-only next steps

1. Collect new v3 recorder files with source/receive timestamps and full L2.
2. Join public trades and, where available, private order events without enabling
   automated execution.
3. Freeze a multi-day development/validation/holdout manifest before fitting.
4. Compare the fixed market-logit baseline with a small training-only regularized
   residual model and report calibration plus net execution economics.
5. Run zero-maker, observed-flow, and explicitly optimistic execution scenarios at
   multiple latencies before considering any policy change.

Run `npm run research:wallet3048:correctness-audit` for the full per-window,
per-day, execution-role, purpose, size-block, scenario-risk, calibration, sizing,
flat-candidate, maker-assumption, and latency diagnostics. The manifest hashes are
verified before any replay begins.
