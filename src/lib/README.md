# src/lib — reusable engine libraries

Hard-won, strategy-agnostic pieces kept as a clean library so future bots reuse them instead of copy-drifting. Each module is a self-contained boundary; the host bot supplies config/logging/keys.

## `executor.js` — Polymarket CLOB order executor + order-status watch
The real-order engine: placement, cancellation, and the **status watch** that follows an order through its lifecycle.

**Public API**
- `placeBuy({ tokenId, price, sizeShares, expireS, label, postOnly, fillPx })` → `{ orderId, filled, spent, avgPx }` (min-order bump at `fillPx`/limit; hard `LIVE_MAX_ORDER_USD` cap; lazy CLOB client; never falls back to sim on error).
- `cancelOrder(id)` · `cancelById(id)` · `cancelAll()` · `getOpenOrders({ market, tokenId })` — `cancelOrder` returns `{ canceled }` (positive-confirmation from the CLOB `{canceled, not_canceled}` response).
- **`reconcileOrder(id, { seedShares, seedSpent, onDelta, onStatus, restTimeoutMs })`** — the watcher. Polls after firing to (1) book **late fills** of a resting remainder (`getOrder.size_matched` + exact `getTrades` pricing) → `onDelta`, and (2) emit **status transitions** — order-level `LIVE → partially_matched → matched → canceled/expired` **and** on-chain `MATCHED → MINED → CONFIRMED/RETRYING/FAILED` → `onStatus`, each timestamped. `restTimeoutMs > 0` arms the **stale-cancel**: cancel a stuck order, keep partials, adopt a fill that races the cancel.
- `isLive` · `liveAddress` · `getApiCreds` · `resolveFunder` · `ensureReadyOrDowngrade` · `prewarm` · `getDep` · `liveStatus`.

**Host seam (the only external deps):**
- `../config/config.js` — `executionMode`, `clobHost`/`clobChainId`, `livePrivateKey`, `liveMinOrderUsd`/`liveMaxOrderUsd`, `reconcileFillMaxMs`/`reconcileFillIntervalMs`, `trackOrderMaxMs`/`trackOrderIntervalMs`, `liveRestTimeoutMs`.
- `../keys/dk.js` — key/funder/sig-type resolver.
- `../logging/verbose.js` — diagnostic trace.

No strategy or engine coupling. To reuse in another bot, provide those three modules (or injected equivalents).

## `fillsim.js` → moved to `engine/fillsim.js`
The sim fill model lives in **`engine/fillsim.js`** (not here): `engine/strategy.js` + `engine/simrun.js` import it *and* are served to the browser (`/engine/*.js`), so a `src/lib/` path wouldn't resolve there. It's now the wired **single source** — see below for the API. (`orderstatus.js`, planned, will stay here since it's node/UI, not engine.)

### `engine/fillsim.js` — the sim fill model (maker touch-fill · taker crossing · latency)
Pure, dependency-free functions that are the **canonical, unit-tested** source of truth for *when/at-what-price a modeled order fills* (SIM/backtest only; real live books the real CLOB fill via `executor.js`).

**Public API**
- `makerTouchFill({ askNow, limit, filled, target, dtMs, touchMs, fillPct })` → new `filled` — resting GTC accrual: above limit = no fill · at the touch = `fillPct`% of target per `touchMs` · crossed = fills fully. **Used by the MAKER HEDGE mode** (`L_HEDGE_EXEC="maker"`): the sim accrues a resting bid `L_HEDGE_MAKER_OFFSET` below the loser's ask via this function (`L_SIM_FILL_PCT`/`L_SIM_TOUCH_MS` = the `touch %`/`touch ms` knobs on the dashboard SIMULATION card). No effect on the taker hedge or on real live (which books the real CLOB fill).
- `latencyFillPrice(sideAsk, limitPx)` → the buy side's ask capped at the limit (the fill price; under latency `sideAsk` is the ask at decision+latency).
- `futureAsks(book, latSec)` → per-tick Up/Down ask **LATENCY_MS in the future** + exact fill times (two-pointer, O(n)); `null` when latency is off.
- `stampLatencyDisplay(f, fillT)` → restamp a marketable fill's display times (fill at decision+latency, `decidedT` kept). Display-only.

Verified: 13/13 unit tests (`engine/fillsim.test.mjs`). Browser still loads `/engine/strategy.js`, `/engine/simrun.js`, `/engine/fillsim.js` (all HTTP 200).

Currently wired into: `engine/simrun.js` (`futureAsks` + `stampLatencyDisplay`) and `src/execution/shadow.js` (`latencyFillPrice`). `makerTouchFill` is preserved for research, but Helpme is taker-only.

## `orderstatus.js` — the order-status protocol (canonical stage vocabulary)
The **single source** of the 11 lifecycle stage names + their meaning/payload contract:
`DECIDED · SIM_FILLED · PLACED · SUBMITTED · REAL_FILLED · RECONCILED · STATUS · REJECTED · SKIPPED · CANCELED_STALE · CANCEL_RACED`.

- **`STAGES`** — frozen constants (a typo on either side silently drops the event, so both sides reference these).
- `STAGE_LIST` · `isStage(s)`.

**Wired:** the server EMIT side (`src/index.js` `emitOS`, `src/execution/shadow.js`) now emits `STAGES.X` instead of string literals. The browser panel's *rendering* (`stageText` labels, `ev` reducer, `statusOf` badge) stays in `public/index.html` — it's render-specific (uses browser `px`/`esc`/`lat` + panel state) and switches on the same stage strings. `orderstatus.test.mjs` asserts **every `STAGES` value is handled by the browser panel** (0 unhandled) — so a stage added on the server can't silently go unrendered.
