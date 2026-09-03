# FastMX

Simulation-only BTC five-minute strategy reconstruction for target wallet
`0x75cc3b63a2f2423085e10706c78b494017b93ce1`.

- Dashboard: `https://dev-fastmx.polywinbot.com` or `http://localhost:4520`
- PM2 process: `poly-fastmx-simulation`
- Strategy: `engine/strategies/helpme.js`
- Mode: locked to simulation in code and process configuration
- Isolated runtime data: `data/fastmx-live` and `logs/fastmx-live`

## Active policy

The strategy combines two causal direction signals with the `poly-mom-bot` Binance trend regime:

1. `H_CLOB_MID_VELOCITY_ON` controls the CLOB family. Its primary velocity is
   `upMid(now) - upMid(at-or-before now - lookback)`, where `upMid = (best bid + best ask) / 2`.
   `H_MID_VELOCITY_LOOKBACK_MS` is required and defaults to `3000`; the fitted absolute threshold is `0.02`.
2. `H_BINANCE_GAP_MOMENTUM_ON` controls the Binance family. It uses the dev-tool raw-dollar gap velocity:
   `(priceNow - open) - (pricePrior - open) = priceNow - pricePrior`. Its lookback defaults to `3000` ms and its
   fitted absolute threshold is `$5`.
3. `H_BINANCE_TREND_ON` controls the Binance momentum regime copied from `poly-mom-bot`. Trend is
   `100 × (current Binance spot - Binance spot N seconds earlier) / prior spot`. The reference
   defaults are `30` seconds and `0.05%` for a strong trend. Range and trend-following Binance signals pass
   unchanged. A fast signal opposing a strong trend must also show a same-direction `60`-second Binance move,
   and both fast and sustained percentage moves must be at least `0.075%`.
4. Trend is a regime filter, not a standalone direction source, and therefore requires the Binance momentum
   source. At least one of CLOB or Binance momentum must be enabled. When both fast sources are enabled they
   must independently qualify and agree in sign.
5. UTC profiles independently override lookbacks, thresholds, cooldown, price floor, window-gap agreement,
   sizing targets, and reversal behavior for Asia 00–07, Europe 07–13, US 13–21, and late-US 21–24. The exact matrix is in
   `CURRENT-STATE.md`.
6. Normal entries use dynamic exact-share sizing from $2/$4/$2/$2 Asia/Europe/US/late-US targets. Global limits cap one order at 100 shares, a
   round at 500 gross shares and $250 cost, its modeled worse-settlement loss at $10, and its normal/fallback order
   count at four.
7. Europe and late-US permit an opposite-side inventory reversal only after CLOB, Binance velocity, strong trend,
   and Binance window-gap direction remain aligned for 1,000ms. Asia and US keep reversals off. Partial hedge is
   globally off.
8. If normal signals have not filled a round, $1 minimum-risk attempts start at second 90 and retry through second
   299. This guarantees attempts, not exchange fills.
9. At second 270, an eligible opposite/losing token receives resting post-only GTC bids at $0.02 and $0.01 before
   either level is reached. Complete fills must retain a 25-share predicted-winner lead and pass all hard limits.
10. The session circuit breaker remains an external emergency stop at `-$25`. Chainlink, ask differentials,
    imbalance, microprice, and weighted scores do not participate in direction.

The corrected selected policy traded all 3,353 available Aug 22–Sep 3 replays with 6,516 fills, `+$279.44` P&L,
`$20,520.72` cost, and a `$264.94` maximum drawdown. Its Aug 31–Sep 3 segment remained `-$83.24`; because that
segment informed the latest Europe sizing decision, it is not a sealed holdout. The rescue maker ladder had zero
credited historical fills. Treat
this as risk-control evidence, not proof of future profit. See `research/FASTMX_COMPLETE_POLICY_2026-09-03.md`.

The Order Release panel also exposes a **live order type** selector. `GTC + cancel remainder` is the measured-faster
default for real automatic execution; `FAK` is available for atomic immediate-or-cancel behavior. The selection is
durable and live-only, so it does not silently alter recorded:false or backtest accounting.

The older trailing-day fit covers 2026-08-26 11:25 UTC through 2026-08-27 11:25 UTC. That historical study used
the now-retired hard three-direction agreement rule; with the required three-second CLOB lookback it matched
`98.48%` of eligible target directions on the untouched final 12 hours and `98.55%` over the full day, at `27.40%`
and `30.11%` target-action coverage respectively. Those figures must not be attributed to the replacement
poly-mom trend regime without a fresh replay.
Full formulas, splits, Wilson intervals, and candidate rankings are in
`research/wallet-75cc/results/three-signal-last24h-2026-08-27.md`.
Direction precision is not release parity or profitability. The final 2,875-window risk audit found the safe
retired guarded policy still lost `$162.04` after fees (`-2.46%` modeled ROI; `$260.97` max drawdown; four of ten days
positive). That result does not validate the new entry-every-signal action rule or prove an edge.
The retired paired inventory replay is in
`research/wallet-75cc/results/fastmx-inventory-mode-backtest-2026-08-27.md`: partial hedging worsened fit and
holdout, while its earlier immediate reversal improved holdout but worsened fit and the combined period. That
result was superseded by the persistent, session-limited reversal evaluation above.
FastMX therefore remains an instrumented forward simulation, not a profitability or exact-clone claim. Only `helpme` is registered internally at runtime;
copied experimental strategies are not selectable by this app.

## Feeds

| Feed | Endpoint | Use |
|---|---|---|
| Binance spot websocket + boundary REST open | `wss://stream.binance.com:9443/...` | raw-dollar velocity, current-window gap, and poly-mom trailing trend/countertrend regime |
| Polymarket RTDS | `wss://ws-live-data.polymarket.com` | settlement-aligned dashboard/reference data; not a strategy signal |
| Polymarket CLOB market websocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | switchable midpoint-velocity family plus executable depth |
| Polymarket Gamma/data APIs | official public APIs | market metadata and public wallet activity |
| Backtest v2 metadata API | configured `BACKTEST_API` | open/final/settlement metadata |
| Backtest v2 orderbook API | configured `BAPI_V2_OB_BASE` | coherent 50 ms full-L2 frames, replayed causally at 120 ms |

The CLOB client subscribes to both outcome token IDs with `custom_feature_enabled`, applies `book` snapshots and
absolute `price_change` updates to an in-memory L2 book, and uses the documented text `PING`/`PONG` heartbeat.
The dashboard draws bid and ask as step functions because quotes remain constant between book events.

## Run and verify

```bash
npm install
npm run test:depth
npm run test:strategy
node --test engine/simrun.helpme.test.mjs src/sources/history.test.mjs
npm start
```

The PM2 deployment auto-starts the live simulation; the dashboard **Stop/Start** controls disconnect and reconnect
its feeds. No real orders are submitted.

## Important limitation

This is a reconstruction from observable behavior, not the wallet owner's private source code. Live simulation
and forward validation can falsify the inferred policy, but cannot establish literal 100% certainty about hidden
logic. Keep profitability claims tied to out-of-sample and live-simulation evidence.
