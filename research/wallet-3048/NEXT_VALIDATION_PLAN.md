# Wallet3048 predeclared forward-validation plan

Status: predeclared on 2026-09-08 before any fitting on the new recorder cohort.
No final-test result exists yet. The previously inspected 14-window cohort is
diagnostic only and is excluded from model selection and final evaluation.

## Cohort clock

The cohort anchor is the first 00:00 UTC after the reviewed recorder changes are
deployed. Deployment and PM2 restart are deliberately outside this change set.
The first complete UTC day is an instrumentation burn-in and is excluded.

All subsequent settled BTC five-minute windows are assigned chronologically and
without outcome-based filtering:

| Block | Consecutive duration | Permitted use |
|---|---:|---|
| Development | 14 UTC days (4,032 windows expected) | Fit coefficients and implement declared execution assumptions |
| Validation | next 7 UTC days (2,016 windows expected) | Select once among development-frozen candidates |
| Final test | next 7 UTC days (2,016 windows expected) | One sealed evaluation after policy and execution freeze |

An interrupted or incomplete calendar block is reported as collected, not
silently replaced. If validation causes any strategy, sizing, feature, fee,
latency, fill, cancellation, queue, or exclusion-rule change, that validation
block becomes development data and a newly collected chronological validation
and final-test sequence is required.

## Eligibility

A window remains listed even when ineligible. Eligibility is determined only by
instrumentation fields, never PnL, winner, signal direction, or trading activity:

- recorder schema 2 or newer and a complete monotonic evaluation sequence;
- full-precision canonical quotes and full UP/DOWN L2 at every evaluation;
- Binance, Chainlink, UP-depth, and DOWN-depth source and receive timestamps;
- stable UP/DOWN depth event identities;
- Binance and Chainlink opening references and the settlement outcome;
- authoritative decisions and fills with exact cost, fee, level, and timestamp data;
- exact shadow-versus-replay decisions, fills, inventory, fees, cost, and PnL.

The completeness command and every excluded filename are published. Missing
public trade/queue evidence does not exclude a window from the primary strict-no-maker
analysis; it makes the observed-flow scenario unavailable for that window.

## Frozen baseline

- Simulation only. Automated real-money execution remains code-disabled.
- Parent sizes remain fixed at 50 and 150 shares.
- The primary `strict-no-maker` result assigns no resting executions. An
  arrival-time taker partial may leave a reserved GTC remainder, but that
  remainder can only cancel or expire in the primary study.
- `book-cross-inference` credits an unverified resting execution when a later,
  identified public depth event crosses through the resting price.
- `observed-flow-estimate` requires identified, eligible public sell flow and an
  explicit front-of-queue assumption. The flow is consumed once and the result
  is never called verified.
- `optimistic-touch` is a time-at-bid sensitivity, never an observed execution.
- Fee, latency, arrival-book, liquidity conservation, FIFO reservation,
  expiry, cancellation-race, and final-cutoff rules must be frozen with the
  strategy before the final-test manifest is unsealed.

## Analysis protocol

Development fitting may use only the development block. Candidate definitions,
regularization, search bounds, metrics, and tie-breaking are committed before
validation. Validation selects at most once; it is not an iterative tuning set.

Primary reporting includes net settlement PnL after authoritative fees, turnover,
maximum drawdown, losing-window rate, fill rate by evidence label, inventory/lot
reconciliation, calibration, results by UTC day, and sensitivity to predeclared
latencies. Dependence within windows is preserved in uncertainty estimates.
Fill-purpose attribution is descriptive and cannot establish that removing a
repair or hedge would improve profitability.

Final-test payloads are routed under `sealed-final-test/`; outcome-free recorder
quality metadata is routed under `instrumentation/`. Ordinary validation uses
the protected final-test membership and payload root, not just the member's
split string, and never opens a protected payload. Final-test filenames,
outcomes, decisions, fills, PnL, aggregates, and plots remain unread and
unreported until:

1. strategy code and fixed 50/150 sizing are frozen by commit;
2. execution and exclusion assumptions are frozen by commit;
3. development and validation decisions are documented;
4. the final-test checksum manifest is created without running strategy replay.

Only then are payload byte checksums recorded without parsing the payloads, and
one exact final command is run. Any subsequent change invalidates that final
result for confirmatory purposes.

## Review-only collection changes

This correctness pass prepares recorder schema 2, depth event identities,
source/receive clocks, full-precision quotes and spot values, full L2, decision
and fill traces, opening references, settlement outcome, outcome-free
instrumentation files, separate sealed payload routing, and 10,000-window local
retention. It does not restart PM2 or deploy. Identified public aggressor trades
and private queue position are not currently collected; observed-flow validation
therefore remains unavailable until a separately reviewed collector is added.

After the recorder changes are reviewed for deployment, predeclare the next UTC
midnight and all 8,352 chronological members before collection:

```bash
ANCHOR="$(date -u -d 'tomorrow 00:00' +%FT%TZ)"
npm run research:wallet3048:build-recorder-manifest -- \
  --anchor "$ANCHOR" \
  --output data/fastmx-live/recorder-cohort-manifest.json
```

Exact simulation-only recorder activation command (prepared, not run here):

```bash
EXECUTION_MODE=simulation RECORD_LIVE_TICKS=1 RECORD_LIVE_TICKS_KEEP=10000 \
RECORDER_COHORT_MANIFEST=./data/fastmx-live/recorder-cohort-manifest.json \
pm2 restart ecosystem.config.cjs --only poly-fastmx-simulation --update-env
```

After the first complete UTC burn-in day, run the full checklist without reading
future protected final-test payloads:

```bash
npm run research:wallet3048:validate-recorder -- \
  --manifest data/fastmx-live/recorder-cohort-manifest.json \
  --recorder-root data/fastmx-live/live-ticks \
  --splits burn-in \
  --output data/reports/wallet3048-burn-in.json
```

The checklist reports expected/recorded windows, missing or invalid clocks,
decision-time staleness, sequence gaps, shadow/replay mismatches, ledger
discrepancies, disk usage, and retention coverage. No window is dropped for PnL
or trading activity. A material instrumentation defect requires a fix and a new
complete burn-in before the cohort anchor is accepted.

After strategy and execution assumptions are frozen, checksum the protected
payload bytes without parsing them:

```bash
npm run research:wallet3048:seal-final-test -- \
  --manifest data/fastmx-live/recorder-cohort-manifest.json \
  --recorder-root data/fastmx-live/live-ticks \
  --freeze-commit "$(git rev-parse HEAD)"
```

The only deliberate final-test evaluation command is:

```bash
npm run research:wallet3048:evaluate-final-test -- \
  --manifest data/fastmx-live/recorder-cohort-manifest.json \
  --recorder-root data/fastmx-live/live-ticks \
  --output data/reports/wallet3048-final-test.json \
  --confirm-freeze-commit "$(git rev-parse HEAD)" \
  --confirm-unseal UNSEAL_FINAL_TEST
```

That final command is documented only; it was not run in this pass.
