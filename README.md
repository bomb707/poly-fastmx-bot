# FastMX

Simulation-only BTC five-minute strategy reconstruction for target wallet
`0x75cc3b63a2f2423085e10706c78b494017b93ce1`.

- Dashboard: `https://dev-fastmx.polywinbot.com` or `http://localhost:4520`
- PM2 process: `poly-fastmx-simulation`
- Strategy: `engine/strategies/helpme.js`
- Mode: locked to simulation in code and process configuration
- Isolated runtime data: `data/fastmx-live` and `logs/fastmx-live`

## Active policy

The active strategy is a deliberately simple CLOB/Binance velocity policy plus inventory controls:

1. Direction is a normalized score of CLOB Up-token midpoint change and Binance spot change. CLOB price level is
   excluded. The checked-in profile uses a three-second lookback, scales of `0.05` and `$10`, equal `0.5/0.5`
   weights, an entry band of `0.35`, and a re-arm band of `0.15`. Both enabled velocities must be ready, nonzero,
   and agree in sign.
2. `H_CLOB_MID_VELOCITY_ON` and `H_BINANCE_GAP_MOMENTUM_ON` control the CLOB and Binance score components.
   At least one must be enabled. These score weights, scales, and thresholds are implementation assumptions; the
   conservative wallet analysis below validates signs, not this exact numerical score.
3. `H_BINANCE_TREND_ON` applies the `poly-mom-bot` regime filter. A fast signal opposing a strong 30-second trend
   needs a same-direction 60-second countertrend move. `H_BINANCE_GAP_AGREE_ON` optionally requires direction to
   agree with Binance spot versus the five-minute open; it is off in the checked-in PM2 profile.
4. A hysteresis latch, confirmation periods, role cooldowns, and score/price steps control release timing. Entry
   and opposite-side actions have separate seven-fill caps; pending intents count, while rejected/no-fill attempts
   re-arm and do not permanently consume capacity. Those release parameters have not been recovered from the
   public wallet history.
5. Signals aligned with flat/current inventory create fixed seven-share entries. Opposing signals can partially
   hedge while retaining at least one old-side share when worst-case loss strictly improves, or reverse to a
   four-share new-side residual after stricter score, persistence, depth, size, and projected-risk gates pass.
   Pair price remains diagnostic and is not a hard blocker for risk-improving opposite orders.
6. The selected side must have a current ask and enough visible depth under the one-cent marketable cap. Entries
   are fixed-USDC FAK intents (`cap × minimum shares`) in simulation; inventory orders are exact-share intents.
   Modeled orders match future visible L2 after 520 ms.
7. Chainlink, ask differentials, order-book imbalance, and microprice do not participate in direction. Session-loss
   auto-halting is disabled for unrestricted strategy testing.

The checked-in PM2 profile enables CLOB velocity, Binance velocity, partial hedge, and strong reversal; the optional
trend regime and window-gap agreement are off. It uses a `0–300s` entry window and a `2000ms` cooldown. Persisted dashboard
settings can override that profile at runtime.

The Order Release panel also exposes a **live order type** selector. `GTC + cancel remainder` is the measured-faster
default for real automatic execution; `FAK` is available for atomic immediate-or-cancel behavior. The selection is
durable and live-only, so it does not silently alter recorded:false or backtest accounting.

The canonical target-wallet study is now
`research/wallet-75cc/results/causal-entry-analysis.md`. It fixes the features and timestamp rules before scoring,
uses September 4 as a chronological holdout, and reports market-window cluster intervals. Historical grid searches,
fitted trees, threshold rankings, and sizing variants were removed because they encouraged selection on target
actions rather than genuine forward validation. Direction agreement is not release parity, causal attribution, or
profitability. FastMX therefore remains an instrumented forward simulation, not a profitability or exact-clone
claim. Only `helpme` is registered internally at runtime; copied experimental strategies are not selectable by this
app.

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

Daily v2 replay requires `BAPI_KEY` in the project-root `.env`. The runner
reproduces the application profile precedence (`STRAT` defaults, persisted
runtime settings, PM2 overrides, then explicit CLI overrides), rejects unknown
override names, and records a SHA-256 profile fingerprint in every result.
The key is used only for authenticated `*.polywinbot.com` requests and is never
written into result files.

The PM2 deployment auto-starts the live simulation; the dashboard **Stop/Start** controls disconnect and reconnect
its feeds. No real orders are submitted.

### HTTPS domain

`poly.360-techgroup.com` is served by Caddy, which terminates HTTPS and proxies
HTTP and WebSocket traffic to the dashboard on `127.0.0.1:4520`. Start it with:

```bash
docker compose -f deploy/compose.yaml up -d
```

The DNS `A` record must point `poly` to `157.90.182.161`. Caddy obtains and
renews the TLS certificate automatically. The Node process can be started with
either `npm start` or PM2; both use the same loopback dashboard address.

## Important limitation

This is a reconstruction from observable behavior, not the wallet owner's private source code. Live simulation
and forward validation can falsify the inferred policy, but cannot establish literal 100% certainty about hidden
logic. Keep profitability claims tied to out-of-sample and live-simulation evidence.
