# FastMX

Simulation-only BTC five-minute strategy reconstruction for target wallet
`0x75cc3b63a2f2423085e10706c78b494017b93ce1`.

- Dashboard: `https://dev-fastmx.polywinbot.com` or `http://localhost:4520`
- PM2 process: `poly-fastmx-simulation`
- FastMX runtime strategy: `engine/strategies/target75cc.js`
- Retired offline baseline: `engine/strategies/helpme.js`
- Mode: locked to simulation in code and process configuration
- Isolated runtime data: `data/fastmx-live` and `logs/fastmx-live`

## FastMX runtime policy

FastMX now runs `target75cc` as its only runtime strategy. It replaces both the disproven fixed seven-share action and the inherited momentum trigger. Every 250ms it independently evaluates the next unused executable one-cent cap cell on both Up and Down, selects the strongest public-feature score above 0.900, and applies a 4-second release cooldown. It then predicts the desired inventory residual and chooses an aligned entry/top-up, a partial opposite-side reduction, a full inventory crossing, or abstention. Every emitted order retains the target's observed fixed-USDC BUY encoding: `budget = cap × signed minimum shares`, so price improvement may fill additional shares.

The partial-versus-cross tree and residual tree are frozen in `engine/strategies/target75cc-model.js`; the release model is frozen in `engine/strategies/target75cc-release-model.js`, all with source/evaluation hashes. Configurable parameters are `T_RELEASE_THRESHOLD`, `T_DECISION_STEP_MS`, `T_COOLDOWN_MS`, `T_MAX_CELL_USES`, `T_START_S`, `T_STOP_S`, `T_RESIDUAL_SCALE`, `T_CROSS_THRESHOLD`, `T_MIN_ORDER_SH`, `T_MAX_ORDER_SH`, and `T_MAX_GROSS_SH`. They are labeled as fitted model values, engine resolution, or local safety guards; they are not presented as observed constants from the wallet. The old momentum fields, fixed base shares, and hedge/reversal toggles have been removed from the runtime UI and persisted runtime schema.

The exact private release rule is not recovered. The autonomous observable model reaches only 24.35% timing F1 on discovery holdout and 23.47% on partial OOS, and its runtime replay is loss-making. It is a two-sided behavioral imitation, not an exact or profitable clone, and remains hard-locked to simulation. The former Helpme implementation is retained only for reproducible offline research.

## Retired Helpme research baseline (not runtime-selectable)

The strategy has two independently switchable causal direction signals plus
the `poly-mom-bot` Binance trend regime:

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
5. `H_BINANCE_GAP_AGREE_ON` remains an independent optional `poly-mom-bot` window-gap toggle. It is currently
   off by default and can be enabled without changing either fast signal or the trend-regime definition.
6. Every distinct qualifying signal aligned with flat/current inventory emits one seven-share `entry`.
   `H_HEDGE_ON` and `H_REVERSAL_ON` independently control opposing signals. A partial hedge is exact-share sized
   so the old inventory leader retains at least one share of lead. A reversal requires CLOB, Binance fast momentum,
   a strong aligned Binance trend, and Binance spot versus window-open to agree; it crosses only an old imbalance
   of at most 25 shares and targets a ten-share new-side residual. Both controls default off after failing the
   stability requirement in paired train/holdout replay.
7. The selected side must have a current ask and enough visible depth under the one-cent marketable cap. There is
   no persistence timer. Cooldown is the only release throttle and defaults to `1000` ms.
8. Chainlink, ask differentials, imbalance, microprice, and weighted scores do not participate in direction.
9. Entries are fixed-USDC FAK intents (`cap × minimum shares`) in simulation. Inventory-control orders are
   exact-share intents and force live GTC plus immediate remainder cancellation so price improvement cannot cross
   a hedge accidentally. All modeled orders match future visible L2 after 520 ms.
10. The session circuit breaker remains an external emergency stop and defaults to `-$25`.

The checked-in PM2 environment runs the sole FastMX `target75cc` policy and supplies the frozen `4–286s`, 0.900 threshold, 250ms cadence, 4000ms cooldown, and one-use-per-cell menu policy. Runtime configuration cannot switch back to Helpme.

The Order Release panel also exposes a **live order type** selector. `FAK` is the target-policy default for atomic immediate-or-cancel behavior; `GTC + cancel remainder` remains available. The selection is
durable and live-only, so it does not silently alter recorded:false or backtest accounting.

The exact trailing-day fit covers 2026-08-26 11:25 UTC through 2026-08-27 11:25 UTC. That historical study used
the now-retired hard three-direction agreement rule; with the required three-second CLOB lookback it matched
`98.48%` of eligible target directions on the untouched final 12 hours and `98.55%` over the full day, at `27.40%`
and `30.11%` target-action coverage respectively. Those figures must not be attributed to the replacement
poly-mom trend regime without a fresh replay.
Full formulas, splits, Wilson intervals, and candidate rankings are in
`research/wallet-75cc/results/three-signal-last24h-2026-08-27.md`.
Direction precision is not release parity or profitability. The final 2,875-window risk audit found the safe
retired guarded policy still lost `$162.04` after fees (`-2.46%` modeled ROI; `$260.97` max drawdown; four of ten days
positive). That result does not validate the new entry-every-signal action rule or prove an edge.
The current paired inventory replay is in
`research/wallet-75cc/results/fastmx-inventory-mode-backtest-2026-08-27.md`: partial hedging worsened fit and
holdout, while reversal improved holdout but worsened fit and the combined period. Neither control was promoted.
The application therefore remains an instrumented forward simulation, not a profitability or exact-clone claim. Only the wallet-75cc policy is exposed and accepted by the FastMX runtime; Helpme and other experiments remain offline research artifacts.

## Feeds

| Feed | Endpoint | Use |
|---|---|---|
| Binance spot websocket + boundary REST open | `wss://stream.binance.com:9443/...` | current/window-open spot plus frozen multi-horizon release features |
| Polymarket RTDS | `wss://ws-live-data.polymarket.com` | Chainlink/TWAP level, gap, movement, and settlement-aligned reference data |
| Polymarket CLOB market websocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | executable cap cells, price/depth, imbalance, microprice, and multi-horizon changes |
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
TARGET_EXACT_FIRE_FILE=data/wallet-75cc/exact-2026-08-20_2026-08-27/exact-fire-dataset.json.gz \
  node research/backtest-target75cc.mjs 2026-08-20T00:00:00Z 2026-08-27T00:00:00Z
node --test engine/simrun.helpme.test.mjs src/sources/history.test.mjs
npm start
```

The PM2 deployment auto-starts the live simulation; the dashboard **Stop/Start** controls disconnect and reconnect
its feeds. No real orders are submitted.

## Important limitation

This is a reconstruction from observable behavior, not the wallet owner's private source code. Live simulation
and forward validation can falsify the inferred policy, but cannot establish literal 100% certainty about hidden
logic. Keep profitability claims tied to out-of-sample and live-simulation evidence.
