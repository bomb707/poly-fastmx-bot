# FastMX

Simulation-only BTC five-minute bot for target wallet `0x75cc3b63a2f2423085e10706c78b494017b93ce1`.

The sole runtime strategy is **Helpme**, implemented in `engine/strategies/helpme.js`. The dashboard, live simulation, and historical backtests use this strategy through `engine/strategies/index.js`. Execution is locked to simulation in code and in the PM2 configuration.

## Run and verify

```bash
npm ci
cp .env.example .env
# Configure feed/API and database settings in .env.
npm test
npm start
```

The dashboard defaults to `http://localhost:4520`. The checked-in PM2 profile is `ecosystem.config.cjs`, with process name `poly-fastmx-simulation`. It starts the simulation automatically and uses `data/fastmx-live` and `logs/fastmx-live`. Dashboard Stop/Start controls disconnect and reconnect the feeds.

Focused checks: `npm run test:strategy`, `npm run test:depth`, `npm run test:rtds`, and `npm run test:resolution`.

## Main strategy

Helpme combines configurable CLOB midpoint velocity and Binance price velocity with a Binance trend filter. At least one fast signal must be enabled; the trend filter requires Binance velocity. When both fast signals are enabled, they must qualify and agree in direction.

- CLOB velocity measures midpoint change over a trailing lookback, defaulting to 3000 ms and a 0.02 minimum absolute move.
- Binance velocity measures raw-dollar price change, defaulting to 3000 ms and a $5 minimum absolute move.
- The Binance trend filter measures percentage change over 30 seconds, with a 0.05% strong-trend threshold. A fast move opposing a strong trend must also pass the causal 60-second countertrend check; both moves require 0.075%.
- Optional window-gap agreement requires the selected direction to agree with Binance spot versus the window opening price.
- Aligned signals emit seven-share-minimum entries. Optional partial hedging and reversal are disabled by default.
- Entries use fixed-USDC intents: cap × minimum shares. Modeled execution walks visible order-book depth after 520 ms; price improvement can fill additional shares. Inventory-control orders use exact-share sizing.
- The default session-loss circuit breaker is $25.

The PM2 profile enables Binance velocity, the trend filter, and window-gap agreement; disables CLOB velocity; uses a 0–300 second entry interval and a 2000 ms cooldown. Base strategy defaults use a 1000 ms cooldown. Runtime controls and saved overrides can affect the effective configuration.

Chainlink supports settlement and reference displays; it is not a direction gate for Helpme. The application is an observable-behavior reconstruction and simulation, with no claim of exact private-wallet logic or proven profitability.

## Code layout

| Path | Purpose |
|---|---|
| `engine/strategies/helpme.js` | Main strategy and parameter validation |
| `engine/simrun.js` | Browser/server historical simulation |
| `engine/fees.js`, `engine/fillsim.js`, `engine/mergesim.js` | Shared fee, fill, and ledger accounting |
| `engine/momentum.js` | Midpoint and chart/history momentum utilities |
| `src/index.js` | Feed, simulation, persistence, and dashboard orchestration |
| `src/feeds` | Binance, Chainlink RTDS, and CLOB feeds |
| `src/execution` | Simulation ledger, sessions, settlement, and circuit breaker |
| `src/sources` | Market metadata, history, database, and wallet data |
| `src/server`, `public` | Dashboard, history page, authentication, and APIs |
| `src/lib`, `src/keys` | Execution/status adapters still imported by the app |
| `.env.example`, `ecosystem.config.cjs` | Configuration reference and PM2 deployment |

Offline research, fitted-model artifacts, alternate strategies, and standalone execution probes have been removed. The main strategy needs no research directory. Runtime caches belong under the configured `DATA_DIR`; the history page uses `onchain-cache.json`, `tracker-buys.json`, and `mids/` there. Historical research remains available in Git history.

Dependencies, `.env`, runtime data, and logs are ignored by Git. Keep private credentials in `.env` or the configured key store.
