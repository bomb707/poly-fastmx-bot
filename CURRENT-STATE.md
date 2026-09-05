# FastMX current state

_Updated: 2026-09-05 UTC_

- Runtime: `poly-fastmx-simulation`, registered under PM2 (currently stopped)
- Dashboard: `https://dev-fastmx.polywinbot.com`
- Local port: `4520`
- Execution: hard-locked simulation; no real orders
- Wallet-specific research: removed; optional self-tracker has no configured wallet
- Active strategy: only `helpme`, in `engine/strategies/helpme.js`

The active direction is a normalized score of three-second CLOB Up-midpoint velocity and three-second Binance spot
velocity. CLOB price level is excluded. Both enabled feeds must be ready, nonzero, and agree in sign. Their weights
are deliberately equal (`0.5/0.5`), their normalization scales are `0.05/$10`, and the enter/re-arm bands are
`0.35/0.15`. These magnitudes are explicit baseline assumptions that require forward validation.

Binance trend uses the `poly-mom-bot` formula
`100 × (current Binance spot - Binance spot 30 seconds earlier) / prior spot`. At `0.05%` or stronger, a fast signal
opposing that trend also needs a same-direction 60-second move and both moves must clear `0.075%`. Weak/range or
missing trend history leaves the score unchanged. `H_BINANCE_GAP_AGREE_ON` optionally requires the selected side to
match Binance spot versus the five-minute open; it is off in the checked-in profile.

A hysteresis latch and role-specific timing gates control releases. An aligned release creates a fixed seven-share
entry. An opposing release may hedge while preserving one old-side share only if that purchase strictly improves
projected worst-case portfolio loss. A reversal requires score confidence `0.95`, a persistent one-second opposite
candidate, agreeing velocities, sufficient depth, a maximum 50-share order, and projected worst loss no greater
than `$10` or an improvement over current risk. It targets a four-share residual. Pair price is retained as a
diagnostic but no longer blocks a risk-improving opposite order. These release and inventory parameters are
deliberate baseline choices. Both adaptive controls default on.

Entry/top-up fills and opposing hedge/reversal fills have independent seven-action caps. The counters include
successful fills and currently pending latency intents, not historical attempts. A no-fill re-arms its release and
does not consume the cap. Sizing remains fixed rather than fitted from historical actions.
Inventory orders are exact-share sized and force live GTC plus immediate remainder cancellation. The ordinary
cooldown default is `1000` ms. Session-loss auto-halting is removed for unrestricted strategy testing. Chainlink,
ask differentials, order-book imbalance, and microprice are not direction gates.

Configured PM2 simulation profile (effective after process restart): agreeing CLOB/Binance velocity direction ON
at `3000ms`, Binance trend regime OFF (still available as an optional filter), ordinary window-gap
agreement OFF so a qualified counter-move can de-risk inventory before crossing the open, active through
`T+300`, `2000ms` cooldown, and both bounded hedging and confirmed reversal ON.

Each simulated/backtested automatic BUY is a fixed-USDC FAK: `budget = signed cap × minimum shares`. Modeled matching is delayed 520 ms,
walks the future visible L2 ladder, can receive more shares through price improvement, books partials at actual
VWAP, and cancels any unspent remainder.

Real execution remains disabled in the PM2 process, but the isolated live executor was production-probed on
August 27. It now reads market-specific tick/minimum constraints, signs a true fixed-USD CLOB V2 market order
for FAK, prewarms that signer path, computes and fsync-journals the deterministic order ID before POST in the
probe harness, and maintains a renewable two-socket HTTPS reserve. The dashboard's **live order type** selector
chooses GTC with immediate unfilled-remainder cancellation or FAK and persists across restarts; GTC is the default,
while `LIVE_TAKER_ORDER_TYPE` remains the legacy/fallback setting. This live-only choice cannot change the frozen
FAK simulation/backtest model. Three matched GTC
probes averaged 276.97 ms versus 516.45 ms for two matched FAK probes. Every prepared hash matched the venue
order ID, every fill reached `CONFIRMED`, and the final open-order count was zero. Full evidence is in
`research/LIVE_EXECUTION_PROBE_2026-08-27.md`.

Past-window `recorded:false` backview uses coherent V2 50 ms order-book frames, causally sampled at 120 ms. It
feeds completed fills back into the same inventory state before later decisions; BBA-only data cannot create
synthetic liquidity. The UI badge explicitly displays `BACKVIEW · RECORDED:FALSE`.

The CLOB feed follows Polymarket's documented market-channel protocol: full `book` snapshots, absolute
`price_change` updates, optional `best_bid_ask` events, and text `PING`/`PONG`. The dashboard renders bid and ask
as step functions. Obsolete experimental overlays, controls, training endpoints, and artifacts have been
removed.

Wallet-specific analyses and generated datasets have been removed from the working tree. Historical parameter
grids, fitted trees, threshold rankings, inventory-mode screens, and sizing variants are retained only in Git
history so they cannot be mistaken for forward evidence or silently reused by tooling. Exact trigger and sizing
claims require a preregistered protocol and a later untouched period. The process remains simulation-only.
