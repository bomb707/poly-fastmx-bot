# Wallet3048 validation readiness

Reviewed commit: `4aa5707eae3a7fba426c88ce46437a09b5d87aa7`

This pass changed execution and instrumentation correctness only. It did not
change signal coefficients, sizing thresholds, the fixed 50/150 parent sizes,
or the simulation-only lock. No PM2 restart, deployment, real-money execution,
or final-test evaluation command was issued.

## Confirmed changes

- Resting execution is selected by one of four explicit policies:
  `strict-no-maker`, `book-cross-inference`, `observed-flow-estimate`, or
  `optimistic-touch`.
- Strict no-maker never emits a maker fill. Arrival-time taker partials remain
  authoritative; their resting remainder retains its FIFO reservation until
  normal cancellation or expiry releases it.
- Book-cross, observed-flow, and touch fills remain `verified: false` and carry
  distinct evidence and policy labels. Legacy `zero` snapshots are accurately
  translated to book-cross inference.
- Recorder numeric validation rejects null, undefined, blank, non-finite, and
  semantically invalid timestamps, prices, and quantities.
- Freshness reports transport lag, source age at evaluation, and latest-receive
  age at evaluation separately. Missing source clocks remain missing.
- Unavailable depth is recorded as null. Present arrays are reported separately
  from valid, nonempty, sorted, usable ladders. Invalid source depth triggers a
  clean-snapshot reconnect instead of becoming fabricated liquidity.
- Replay payloads, outcome-free instrumentation, and structurally protected
  final-test payloads use separate paths. Ordinary validation requires explicit
  manifest membership and cannot open protected payloads.

## Regression evidence

- Main suite: 87 passed, 0 failed.
- Wallet research suite: 12 passed, 0 failed.
- Shadow/replay parity passes for all four maker policies.
- Synthetic schema-2 recorder data preserves full JavaScript numeric precision,
  source/receive/evaluation clocks, depth identities, and a multi-level partial
  execution. Decisions, fills, fees, costs, inventory, levels, and settlement
  reconcile exactly after replay.
- A prompt message followed by a stopped feed becomes stale at later
  evaluations even though its original transport lag remains low.
- A malformed sealed payload is not parsed by ordinary validation, and changing
  only its split label cannot move it out of structural protection.

## Pre-anchor diagnostic

All five locally available recorder files were explicitly manifested and
reported; none was excluded for profitability or trading activity. This is not
the planned burn-in or research cohort.

- 5 expected, 5 present, approximately 107.37 MB.
- 1 legacy file has no schema-2 decisions, fills, clocks, or depth identity.
- 4 schema-2 files reconcile their recorded ledgers exactly.
- 0 files are ready for exact parity because collection began late or contained
  honest one-sided/unavailable depth and source-clock gaps.
- Aggregate diagnostic flags: 1,332 sequence gaps (all from the legacy file),
  16,480 missing/invalid source fields, and 12,095 stale-at-evaluation checks.
- No identified public aggressor/queue evidence is present, so observed-flow is
  unavailable. This does not block strict no-maker.

The pre-anchor files are diagnostic only. The fixed recorder must complete a new
full UTC burn-in day after reviewed activation. Any material failure requires a
fix and another full burn-in; the research anchor must not move forward to hide
missing windows.

## Diagnostic cohort rerun

The checksum-verified 14-window cohort remains already inspected and cannot be
described as a final test.

| Execution policy | PnL | Fees | Turnover | Resting fills |
|---|---:|---:|---:|---:|
| Strict causal, strict no-maker | $0.00 | $0.00 | $0.00 | 0 |
| Timestamps assumed, strict no-maker | -$248.67 | $120.95 | $4,613.80 | 0 |
| Historical `zero`, relabeled book-cross inference | -$233.49 | $121.91 | $4,721.77 | 7 |
| Timestamps assumed, optimistic touch | -$17.17 | $112.97 | $7,353.72 | 2,837 |
| Original implicit time-at-bid reference | -$42.09 | $110.42 | $7,209.47 | not comparable |

The strict-causal row is no-trade because source timestamps are unavailable, not
break-even evidence. Observed-flow was not run. These results are execution
sensitivity diagnostics and provide no defensible profitability conclusion.

## Commands

The exact manifest creation, simulation-only recorder activation, burn-in,
checksum sealing, and deliberate final-test commands are frozen in
`NEXT_VALIDATION_PLAN.md`. The deliberate final-test command is documentation
only and remains unexecuted.
