# FastMX

Simulation-only reconstruction of Polymarket wallet
`0x3048d65321be3497164cdfc2996f94f98a2e7537` on BTC five-minute Up/Down markets.

- Dashboard: `https://pair.360-techgroup.com` or `http://localhost:4520`
- PM2 process: `poly-fastmx-simulation`
- Sole strategy: `engine/strategies/wallet3048.js`
- Execution: hard-locked to simulation
- Runtime data: `data/fastmx-live`
- Runtime logs: `logs/fastmx-live`

## Strategy

For the full implemented decision logic, execution workflow, and September 7–9
entry-accuracy and round-P&L results, see
[Wallet3048 strategy algorithm](WALLET3048_STRATEGY_ALGORITHM.md).

The wallet3048 reconstruction uses a causal 0.5-second Binance signal confirmed
by a three-second ±0.02 CLOB UP-implied midpoint delta,
prebuilt 50/150-share GTC price rungs, FIFO lot accounting, economic
cancel/reprice rules, and bounded inventory risk. It can accumulate both outcome
legs below a profitable pair cap or retain a directional residual when the
estimated edge supports it. It can also acquire tokens offered at $0.01–$0.02
with a hard $0.02 execution cap. Orders may execute through t+298s; latency-aware
decisions stop early enough to arrive by that cutoff.

There is no cumulative session-loss breaker and no per-window dollar loss or
spend ceiling. Candidate orders remain bounded by the UP/DOWN share-imbalance
check, fixed parent sizes, pending-order cap, action cap, and available balance
in session replay.

The primary research execution policy is `strict-no-maker`: arrival-time taker
partials remain valid, but resting remainders receive no simulated fills.
`book-cross-inference`, `observed-flow-estimate`, and `optimistic-touch` are
separate, explicitly unverified sensitivity policies.

The coefficients are heuristic reconstruction parameters, not a calibrated
settlement-probability model. The correctness findings and validation limits are
documented in `research/wallet-3048/CORRECTNESS_AUDIT_2026-09-08.md`.

The implementation is selected unconditionally by the strategy registry.
Retired strategies are not available through the dashboard, live simulation,
or backtests.

## Feeds

| Feed | Use |
|---|---|
| Binance spot WebSocket | Fast momentum and fair-value features |
| Polymarket RTDS | Settlement-aligned reference prices |
| Polymarket CLOB WebSocket | Executable BBA and depth |
| Polymarket Gamma/data APIs | Market metadata and public wallet activity |
| Backtest API | Historical metadata and order-book replay |

## Run And Verify

```bash
npm install
npm run test:strategy
npm test
npm start
```

Research evidence, assumptions, and reproducibility details are in
`TARGET_WALLET_STRATEGY_ANALYSIS.md` and `research/wallet-3048/`.

## Limitation

This is a reconstruction from public behavior, not the wallet owner's source
code. Forward simulation can falsify the inferred policy, but cannot establish
that hidden release logic or private coefficients were recovered exactly.
