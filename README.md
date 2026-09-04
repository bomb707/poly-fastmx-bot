# FastMX

Simulation-only BTC five-minute momentum strategy and execution dashboard.

- Dashboard: `https://dev-fastmx.polywinbot.com` or `http://localhost:4520`
- PM2 process: `poly-fastmx-simulation`
- Strategy: `engine/strategies/helpme.js`
- Mode: locked to simulation in code and process configuration
- Isolated runtime data: `data/fastmx-live` and `logs/fastmx-live`

## Active policy

The strategy has two independently switchable causal direction signals plus
the `poly-mom-bot` Binance trend regime:

1. `H_CLOB_MID_VELOCITY_ON` controls the CLOB family. Its primary velocity is
   `upMid(now) - upMid(at-or-before now - lookback)`, where `upMid = (best bid + best ask) / 2`.
   `H_MID_VELOCITY_LOOKBACK_MS` is required and defaults to `3000`; the configured absolute threshold is `0.02`.
2. `H_BINANCE_GAP_MOMENTUM_ON` controls the Binance family. It uses the dev-tool raw-dollar gap velocity:
   `(priceNow - open) - (pricePrior - open) = priceNow - pricePrior`. Its lookback defaults to `3000` ms and its
   configured absolute threshold is `$5`.
3. `H_BINANCE_TREND_ON` controls the Binance momentum regime copied from `poly-mom-bot`. Trend is
   `100 × (current Binance spot - Binance spot N seconds earlier) / prior spot`. The reference
   defaults are `30` seconds and `0.05%` for a strong trend. Range and trend-following Binance signals pass
   unchanged. A fast signal opposing a strong trend must also show a same-direction `60`-second Binance move,
   and both fast and sustained percentage moves must be at least `0.075%`.
4. Trend is a regime filter, not a standalone direction source, and therefore requires the Binance momentum
   source. At least one of CLOB or Binance momentum must be enabled. When both fast sources are enabled they
   must independently qualify and agree in sign.
5. `H_BINANCE_GAP_AGREE_ON` remains an independent optional `poly-mom-bot` window-gap toggle. It is currently
   off by default and can be enabled without changing either fast signal or the trend-regime definition.
6. Every distinct qualifying signal aligned with flat/current inventory emits one seven-share `entry`.
   `H_HEDGE_ON` and `H_REVERSAL_ON` independently control opposing signals. A partial hedge is exact-share sized
   so the old inventory leader retains at least one share of lead. A reversal requires CLOB, Binance fast momentum,
   a strong aligned Binance trend, and Binance spot versus window-open to agree; it crosses only an old imbalance
   of at most 25 shares and targets a ten-share new-side residual. Both controls default off conservatively.
7. The selected side must have a current ask and enough visible depth under the one-cent marketable cap. There is
   no persistence timer. Cooldown is the only release throttle and defaults to `1000` ms.
8. Chainlink, ask differentials, imbalance, microprice, and weighted scores do not participate in direction.
9. Entries are fixed-USDC FAK intents (`cap × minimum shares`) in simulation. Inventory-control orders are
   exact-share intents and force live GTC plus immediate remainder cancellation so price improvement cannot cross
   a hedge accidentally. All modeled orders match future visible L2 after 520 ms.
10. The session circuit breaker remains an external emergency stop and defaults to `-$25`.

The PM2 environment currently deploys Binance velocity ON, CLOB velocity OFF, the trend regime and window-gap
agreement ON, a `0–300s` entry window, and a `2000ms` cooldown. Partial hedge and strong reversal are OFF.

The Order Release panel also exposes a **live order type** selector. `GTC + cancel remainder` is the measured-faster
default for real automatic execution; `FAK` is available for atomic immediate-or-cancel behavior. The selection is
durable and live-only, so it does not silently alter recorded:false or backtest accounting.

FastMX remains an instrumented forward simulation, not a profitability claim. Only `helpme` is registered internally at runtime;
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

Live simulation and forward validation can falsify the configured policy, but cannot establish future profitability.
Keep profitability claims tied to out-of-sample and live-simulation evidence.
