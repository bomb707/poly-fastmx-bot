# Wallet3048 correctness audit

Reviewed branch: `version2`

Original comparison commit: `e654426abb9c779ee5dc764df8e805c983f91485`

Focused correctness-pass base: `166f71c1591a612782907b719d6b18d195e32751`

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
12. A deferred shadow order used a saved book but consumed the current callback's
    newly created liquidity pool, then stamped the earlier due time.
13. Pending complements reserved only aggregate quantity, allowing FIFO cost to
    be recomputed from a different lot during later decisions and reevaluation.
14. Strategy synchronization recomputed cost and fees from average price instead
    of accepting authoritative execution `usdc`, `fee`, and level allocations.
15. Replay recreated liquidity inside each processing phase, so one unchanged
    external snapshot could be consumed more than once.
16. Resting fills were attempted after effective expiry/final cancellation, and
    rollover converted unmatched latency intents into synthetic full fills.
17. Scalar public sell volume lacked event identity, aggressor direction, event
    time, price eligibility, queue allocation, and single-consumption accounting.

## Repairs

- Binance impulses now expire independently of socket/update cadence. Binance,
  Chainlink, UP depth, and DOWN depth have separate source-time gates.
- Recorder schema 2 is prepared to preserve every evaluation, full-precision
  values, full L2, depth identity, source/receive timestamps, decisions, fills,
  opening references, and settlement outcome. Existing files predate the schema.
- Replay normalizes epoch milliseconds, epoch seconds, and relative milliseconds
  explicitly. Missing causal source times fail closed by default.
- Due executions are processed before decisions in both engines. An execution
  implied by the current update is processed before cancellation.
- Order intents remain immutable. Every partial fill gets a separate `fillId` and
  is booked immediately and exactly once; only its own remainder is reduced.
  MongoDB idempotency now uses that fill identity when available.
- All phases and orders consume a shared pool keyed by identified external depth
  event. Repeated processing or unrelated callbacks do not replenish it.
- Default unverified maker credit is zero. `touch` remains available only as an
  explicitly optimistic sensitivity assumption. Explicit observed sell flow can
  produce a maker fill.
- Risk is checked over independent pending-order fill subsets with and without
  the proposed order. Existing violations can only admit bounded repairs that do
  not worsen lean or worst-case payout.
- Pending complements reserve named FIFO lot slices. Partial fills consume only
  their slices; cancellation releases the remainder; own-order reevaluation uses
  remaining quantity and distinguishes its slices from other reservations.
- Recorded execution cost and fee fields are authoritative. Level amounts are
  preserved or allocated consistently into FIFO lot basis.
- Arrival uses the same last-known book and due timestamp in shadow and replay.
  Effective expiry/cutoff races permit same-time evidence but reject later events.
- Maker estimates require identified sell-aggressor events, eligible event time
  and price, an explicit front-of-queue assumption, and cohort-wide one-time flow
  consumption. They remain labeled estimates, never verified fills.
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

The frozen diagnostic manifest is `correctness-cohort-manifest.json`. It contains 14
consecutive BTC five-minute windows from `2026-09-08T03:55:00Z` through
`2026-09-08T05:05:00Z`, split chronologically into 8 development, 3 validation,
and 3 previously inspected diagnostic "holdout" windows. SHA-256 validation is
mandatory before evaluation. None of these 14 windows is an untouched final test.

The cohort does not contain original Binance/Chainlink source timestamps or CLOB
trade/queue events. It is suitable only for sensitivity analysis.

## Results

| Version/assumption | All PnL | Fees | Turnover | Drawdown | Validation PnL | Holdout PnL |
|---|---:|---:|---:|---:|---:|---:|
| A. Original `e654426`, implicit time-at-bid maker | -$42.09 | $110.42 | $7,209.47 | $77.57 | -$13.28 | -$31.26 |
| C. Corrected strict causal, zero unverified maker | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| D/E. Corrected, timestamps assumed, zero unverified maker | -$233.49 | $121.91 | $4,721.77 | $295.38 | -$95.49 | -$62.51 |
| D/E. Corrected, timestamps assumed, optimistic touch | -$17.16 | $112.97 | $7,353.71 | $210.44 | -$77.16 | +$147.55 |

The strict result is no-trade, not break-even evidence: the required source times
are absent. The large shift between zero-maker and optimistic-touch assumptions
shows that unverified execution dominates this tiny cohort. Even the optimistic
result remains negative and is not evidence of achievable profitability.

### Corrected-policy diagnostics

For the timestamp-assumed, zero-unverified-maker run, actual arrival cost was
`$4,721.77`, versus `$4,815.59` estimated at decision time. The `$93.82` price
improvement did not overcome settlement selection and fees. Immediate fill
contribution was `-$169.77`; the seven resting fill events contributed `-$63.72`.

Settlement contribution grouped by the order's declared purpose was `+$202.62`
for first entry, `+$62.36` for reinforcement, `-$122.17` for pair-completion
orders, and `-$376.30` for repair orders. This is fill-purpose attribution, not
standalone causal PnL: a completed pair's earlier leg remains attributed to its
original purpose. It does not imply that removing any repair improves profit.
The 50-share parents contributed `-$108.99`; 150-share parents contributed
`-$124.50` in this sample.

The 168 filled parents recorded 298 independent pending-fill scenario checks.
No emitted fixed-size parent was outside the ordinary configured scenario limits.
This count covers emitted orders, not candidates rejected before emission.

| Zero-maker sensitivity | All PnL | Validation | Holdout |
|---|---:|---:|---:|
| Fixed 50/150, 520 ms | -$233.49 | -$95.49 | -$62.51 |
| Incremental 5-150, 520 ms | -$523.20 | -$99.12 | -$75.69 |
| Evaluate both sides while flat | -$345.73 | -$135.07 | -$69.88 |
| Fixed, 0 ms latency | +$621.30 | -$56.53 | +$184.06 |
| Fixed, 1,000 ms latency | -$319.71 | -$112.77 | -$71.65 |

These are diagnostic ablations, not tuned alternatives. The large latency swing
is further evidence that the cohort cannot support a robust profitability claim.

On filled orders only, the heuristic score's Brier value was `0.1715`, versus
`0.1718` for the CLOB market-probability feature. That tiny descriptive difference
does not establish incremental predictive value: observations repeat outcomes
within a window, selection depends on the policy, and the sample contains only 14
settlements. A regularized residual model was not fit because this cohort cannot
retain meaningful chronological validation and an untouched final-test block.

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

1. Collect new schema-2 recorder files with source/receive timestamps and full L2.
2. Join public trades and, where available, private order events without enabling
   automated execution.
3. Follow the chronology predeclared in `NEXT_VALIDATION_PLAN.md` before fitting.
4. Compare the fixed market-logit baseline with a small training-only regularized
   residual model and report calibration plus net execution economics.
5. Run zero-maker, observed-flow, and explicitly optimistic execution scenarios at
   multiple latencies before considering any policy change.

Run `npm run research:wallet3048:correctness-audit` for the full per-window,
per-day, execution-role, purpose, size-block, scenario-risk, calibration, sizing,
flat-candidate, maker-assumption, and latency diagnostics. The manifest hashes are
verified before any replay begins.

Run `npm run research:wallet3048:correctness-audit:original` to extract the
original comparison commit into a temporary directory and reproduce its reference
result with the same checksum-verified files. Run
`npm run research:wallet3048:validate-recorder -- data/fastmx-live/live-ticks`
for per-window completeness, freshness, reconciliation, and replay parity.
