# Target wallet strategy reconstruction — exact-week audit

_Audit date: 2026-09-02; live public-data re-review through approximately 11:19Z_  
_Target: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`_  
_Scope: original reconstruction on BTC 5-minute Up/Down markets; live re-review expanded to BTC/ETH/SOL/XRP 5-minute and BTC 15-minute markets; repository commit `537b9ca`_  
_Status: autonomous policy plus causal trend/noise and session-calibrated entry gate implemented; simulation-only_

## Executive verdict

FastMX now runs the autonomous `target75cc` strategy as its sole runtime policy. It evaluates both outcome-token menus, selects a one-cent price-cap cell, applies a causal trend/noise and fee-adjusted value gate with a UTC-session-specific minimum entry probability, buys with a fixed-USDC taker intent, dynamically targets post-action residual inventory, and chooses partial reduction versus a full inventory cross. Confidence can reduce the residual target from 1.00× toward 0.50×, but cannot lever it above the existing model target. The former Helpme implementation remains only as an offline historical comparison artifact.

It is still **not an identical clone**. Exact autonomous release parity remains only 24.35% F1 on the untouched discovery holdout and 23.47% on the partial next-week sample because the new layer filters the existing release stream rather than recovering the target's private release program. The session schedule improved the frozen partial-OOS result from -$33.85 to +$52.52 after modeled fees, but partial-OOS settlement drawdown increased from $91.45 to $95.60 and one holdout session has sparse source coverage. Public filled orders expose what filled, but not the wallet's private menu creation state, canceled orders, confidence, or release program; those missing variables are material. The truthful status remains a simulation candidate, not a recovered private strategy or authorization for live trading.

The target's taker behavior is well supported for the two local cohorts: all 12,963 decoded orders in the first cohort and all 14,971 in the second were BUY orders found in the taker tuple of the V2 `matchOrders` settlement transaction and joined to public fills. This confirms marketable taker behavior for those observed BTC 5-minute fills. It does **not** identify the API order type (FAK/FOK/GTC), because that lifetime instruction is not encoded in the signed V2 order tuple, and it does not reveal orders that never filled.

The exact requested discovery dataset is now built:

- Discovery is exactly `[2026-08-20T00:00:00Z, 2026-08-27T00:00:00Z)`: 2,016 enumerated BTC-5m markets and 15,760 target fills/orders.
- The strict runtime completeness rule accepts 1,508 markets (74.80%). It accounts for every missing/incomplete market rather than silently dropping it. Of 12,009 target orders in complete markets, 11,994 (99.875%) receive an inferred L2-consumption interval.
- Those orders become 10,802 chronologically ordered actions: 1,539 entries, 5,534 top-ups, 1,578 partial repairs, and 2,151 inventory reversals. Ordering by inferred consumption fixes the former same-public-second inventory-label corruption.
- The generator and wrappers are tracked in `weekly-parity-core.mjs`, `build-exact-fire-dataset.mjs`, and `collect-v2-cache-range.mjs`. Generated data retains source paths and SHA-256 hashes.
- OOS is defined as `[2026-08-27T00:00:00Z, 2026-09-03T00:00:00Z)`. As of this audit date, Sep 3 has not occurred. The frozen partial sample ends at `2026-09-02T04:00:00Z`: 1,776 markets, 1,651 complete (92.96%), 13,322/13,322 eligible orders inferred, and 10,973 actions. It was not used for fitting or selection.

The remaining exact-clone work is not configuration tuning. The missing private release/menu state must be found from an additional observable source, or literal identity must be declared unachievable. The full Sep 3 OOS close and additional forward monitoring are still required before any live consideration.

## Direct comparison: target wallet versus the prior Helpme bot

The reported failure was real in the **prior effective Helpme configuration**, although that source contained dormant hedge and reversal branches. The PM2 profile did not enable either branch, and both code defaults remain `false` for the preserved baseline. When Helpme already holds the side opposite a new signal, [`helpme.step`](engine/strategies/helpme.js) computes `oppositeSignal`, reaches the disabled inventory branch, records `opposite-signal-disabled`, and returns no order. Therefore, a later Down signal could be valid while `DOWN SHARES` remained zero, exactly as shown in the supplied dashboard capture.

| Feature | Target wallet evidence | Prior Helpme implementation | Consequence |
|---|---|---|---|
| Market coverage | BTC/ETH/SOL/XRP 5m plus BTC 15m; roughly nine in ten available tracked windows in the live interval. | PM2 runs BTC 5m only. | The target is a shared multi-product system; current behavior is calibrated to one product. |
| Transaction side | Observed actions are BUY-only. | Automatic orders are BUY-only. | Broad execution orientation matches. “Two-sided” means buying both outcome tokens, not selling. |
| Direction source | Exact private release rule remains unknown; public price/book state, time, inventory, and pre-signed menu state are implicated. | Two-sided learned cap-cell scorer using only causal public book/spot/TWAP features. | Architecture is closer, but the omitted private menu state prevents exact release parity. |
| Reaction to an aligned signal | Repeatedly adds or resizes the predicted side. | Repeated distinct signals add a fixed-budget seven-share entry after cooldown. | Qualitative behavior matches, sizing and release cadence do not. |
| Reaction to an opposite signal | About 29.72% of live actions buy against pre-action inventory. Of 14,901 such actions, 7,932 cross to the new side and 6,969 partially reduce the old lean. | **Effective profile skips the signal completely** because hedge and reversal are both off. | This is the direct cause of stranded one-sided exposure. |
| Partial reduction | Common: an opposite buy can leave the original side dominant. | Dormant opt-in hedge buys at most seven shares while retaining a fixed one-share old-side lead. | Primitive exists, but is disabled and uses a heuristic not cloned from the target. |
| Full reversal | Common: an opposite buy can cross balance and leave the newly predicted side dominant. | Dormant opt-in reversal requires both fast feeds, a strong aligned trend, and window-gap agreement; it rejects old imbalances above 25 shares and targets a fixed ten-share new residual. | Primitive exists, but is disabled and its thresholds are assumptions. |
| Inventory objective | Dynamic post-action residual depending on product, time, price, confidence, and existing inventory. | No target inventory in normal operation; aligned orders accumulate and opposite orders are discarded. | Current policy manages signals, not portfolio state. |
| Order size | Strongly variable; median rises late in the window and the saved cohorts have p90 minimum sizes of 29–37 shares. | Seven-share base; hedge capped at seven; reversal uses `old imbalance + 10`. | Fixed sizing cannot reproduce target exposure transitions. |
| Timing/cadence | Repeated updates throughout a window; median five actions per traded market and p90 twelve in the live snapshot. | One order per distinct signal snapshot, throttled by a two-second deployed cooldown, through T+300. | Both can act repeatedly, but target release timing is not cloned. |
| Price cap/menu | Evidence supports many cent-cap, integer-share orders prepared near open and released later; saved median signed cap is 0.78. | Builds a cap from current ask plus one cent, capped at 0.98. | Current bot reacts with one contemporaneous order instead of selecting from a prepared state/menu. |
| Execution | Latest and saved observed fills are marketable taker BUYs; exact order lifetime is unknown. | Simulation assumes a fixed-USDC FAK filled 520 ms later against visible depth. | Taker style is similar; FAK and 520 ms are unverified assumptions. |
| Holding/exit | No SELLs in the reviewed activity; both token inventories are generally held to resolution. | Holds purchases to resolution; Helpme does not actively sell. | Broadly consistent. |
| Session/time behavior | Size and inventory-changing frequency vary by elapsed time, product, and ET session. | Static thresholds and size across the full window; one global session loss breaker. | Important conditioning variables are absent. |
| Observed profitability | Live leaderboard and resolved-position pulls are positive over the reviewed ranges. | Retained current-engine replays are negative after modeled fees; hedge/reversal variants did not validate consistently. | Copying isolated target features does not transfer the target's edge. |

### Why the screenshot loses

The visible state has approximately 44.6 Up shares, zero Down shares, and $22.19 already spent. If Down resolves, the position pays zero and loses essentially all cost plus fees, matching the displayed `IF DOWN -22.89`. A qualifying Down signal does not repair this because the effective strategy exits through `opposite-signal-disabled`.

Blindly enabling an opposite buy is not sufficient. At the displayed prices, the existing average Up cost is about 0.497 and Down costs about 0.86. Matching one Up share with one newly bought Down share would cost about 1.357 before fees for a pair that pays only $1 at resolution. That action reduces directional variance but locks roughly $0.357 loss per paired share. Buying enough Down at 0.86 to make the Down outcome break even would require roughly 159 shares before fees, while making the Up outcome much worse.

The needed feature is therefore an **inventory-target transition policy**, not “buy both whenever direction changes.” On every qualified decision it should calculate the desired signed residual, compare it with filled plus pending inventory, and choose one of four explicit actions: aligned add, partial reduction, full cross, or abstain. The target evidence can label those transitions and their sizes; it does not yet provide a sufficiently validated public rule for when to release them profitably.

## Experimental implementation — 2026-09-02

[`target75cc`](engine/strategies/target75cc.js) implements that transition policy and is the only FastMX runtime strategy. It independently scores the next unused executable one-cent cell on both Up and Down menus, then predicts an absolute post-action residual and uses the chronological partial-versus-cross classifier when the chosen side opposes effective filled-plus-pending inventory. It emits a fixed-USDC marketable BUY sized as:

`signed minimum shares = ceil(desired oriented residual - current oriented inventory)`

The residual is positive for an entry/top-up or cross and negative for a partial reduction. Model-sized orders default to 5–227 signed minimum shares rather than seven, with a planned gross-inventory ceiling of 300 shares. Every decision records model hashes, features, predicted residual, cross score, current orientation, uncapped size, capped size, role, and skip/fire reason. The source trees and their original holdout metrics are frozen in [`target75cc-model.js`](engine/strategies/target75cc-model.js).

Focused tests prove that a flat qualifying signal produces a nine-share modeled entry in the fixture, and the following opposite menu selection produces a fourteen-share reversal that covers the nine-share old-side imbalance and leaves a five-share new-side residual. Other tests cover partial reduction, gross-cap abstention, parameter validation, model provenance, and preservation of the Helpme baseline.

The original autonomous replay correctly **failed the exact-clone/profitability gate**. A second controlled experiment then added the causal trend/noise layer while holding the BAPI windows, latency, fixed-USDC FAK fill model, and fees constant:

| Cached interval | Coverage | Policy | PnL | Worst market | Actions/traded market | Both-side markets | Opposite actions | Size p50 / p90 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| Aug 20–27 discovery | 74.80% | observed target actions | +$1,081.33 | -$125.92 | 7.27 | 67.56% | 34.52% | 8 / 29 |
| Aug 20–27 discovery | 74.80% | Helpme baseline | -$2,316.10 | -$137.25 | 7.67 | 0% | 0% | 7 / 7 |
| Aug 20–27 discovery | 74.80% | `target75cc` | -$1,932.78 | -$79.53 | 4.45 | 57.83% | 32.59% | 9 / 19 |
| Aug 20–27 discovery | 74.80% | enhanced `target75cc` | -$137.89 | -$18.56 | — | — | — | — |
| Aug 27–Sep 2 partial OOS | 92.96% | observed target actions | +$2,886.51 | -$131.59 | 6.85 | 58.39% | 26.85% | 12 / 48 |
| Aug 27–Sep 2 partial OOS | 92.96% | Helpme baseline | -$1,413.94 | -$136.13 | 5.27 | 0% | 0% | 7 / 7 |
| Aug 27–Sep 2 partial OOS | 92.96% | `target75cc` | -$1,190.50 | -$83.50 | 3.85 | 51.38% | 28.46% | 9 / 19 |
| Aug 27–Sep 2 partial OOS | 92.96% | enhanced `target75cc` | -$33.85 | -$22.06 | — | — | — | — |

The enhanced policy cuts partial-OOS loss by 97.2%, maximum settlement-boundary drawdown from $1,300.52 to $91.45, and worst-window loss from $83.50 to $22.06. It does so by rejecting about 77% of the original fills and reducing accepted residual targets according to confidence. Partial-OOS profit factor is still only 0.9686, however, and pullback entries are not independently profitable across validation and OOS. The full controlled report, ablations, reversal/noise diagnostics, and pullback MAE/MFE audit are in [`trend-noise-reversal-2026-09-02.md`](research/wallet-75cc/results/trend-noise-reversal-2026-09-02.md).

Autonomous event parity also remains weak: discovery holdout precision 19.35%, recall 32.84%, F1 24.35%; frozen partial-OOS precision 18.77%, recall 31.32%, F1 23.47%. Side accuracy conditional on a ±2-second timing match is about 90–92%, but exact cap recovery is only 12–14%. Market-level P&L correlation is 0.027 on discovery and 0.072 on partial OOS. Filtering the approximate release stream reduces losses but does not reproduce the target's edge. The repeatable comparison command is [`research/backtest-target75cc.mjs`](research/backtest-target75cc.mjs).

## Current implemented FastMX strategy — exact runtime logic

This section describes what the repository executes now. It is an implementation specification, not a claim that the target wallet has these exact named parameters or uses these exact fitted models. The runtime registry forces FastMX to `target75cc`; a saved legacy strategy name is ignored. `helpme` remains callable only by explicit offline research code. The shadow engine also overwrites `LIVE_FILLS` to `false`, and the application execution mode is hard-coded to `simulation`, so the current policy cannot submit a real order.

### Active configuration

| Control | Current persisted value | Function | Provenance |
|---|---:|---|---|
| Active interval | T+4 through T+286 | No model decision outside this inclusive interval. | Frozen model-search support, not an observed wallet dead-zone or stop time. |
| Evaluation cadence | 250 ms | At most one release evaluation per cadence interval. | Local engine resolution. |
| Global cooldown | 4,000 ms | Minimum time between fired decisions, regardless of side. | Validation-selected release policy. |
| Release cutoff | 0.900 | The highest-scoring Up/Down menu candidate must reach this probability. | Validation-selected fitted value. |
| Cell uses | 1 | Each `side:cent-cap` cell can fire once per market window. | Validation-selected approximation. |
| Trend/noise probability / edge | UTC schedule / 0 | Requires 0.500 (00–04), 0.750 (04–08), 0.650 (08–12), 0.500 (12–16), 0.500 (16–20), or 0.725 (20–24), plus edge above ask and modeled fee. | BAPI train+validation-selected economic gate. |
| Reversal / confirmed-reversal probability | 0.500 / 0.700 | The first is the executable counter-trend gate; the second is a diagnostic class boundary only. | Validation-selected gate / interpretation boundary. |
| Dominant / short-score threshold | 0.200 / 0.080 | Separates continuation, short pullback, temporary noise, and counter-trend structure. | Local causal classifier thresholds. |
| Confidence residual scaling | 0.50×–1.00× | Downscales the residual-tree target as fee-adjusted confidence falls; never increases it. | Validation-selected risk scaling. |
| Residual scale | 1.0 | Multiplies the residual-tree prediction before rounding. | Trained calibration. |
| Cross cutoff | 0.485064 | Opposite-side selection crosses inventory when the cross-tree score reaches this value. | Fitted classification threshold. |
| Minimum / maximum order | 5 / 227 shares | Rejects smaller changes and clamps larger model requests. | Observed floor / discovery-support safety clamp. |
| Gross ceiling | 300 shares | Limits filled plus pending minimum shares planned in one window. | Local safety control, not a target-wallet maximum. |
| Maximum price | 0.99 | Highest permitted cent cap. | Local execution bound. |
| Simulated latency | 520 ms | Defers matching to the future visible book. | Execution assumption, not inferred wallet latency. |
| Order lifetime | FAK | Cancels an unfilled simulated remainder at the latency deadline. | Assumption; public settlement data cannot reveal the target API lifetime instruction. |
| Session stop | $100 persisted; $25 code default | Stops after resolved cumulative session P&L breaches the negative limit. | Local risk guard, unrelated to the fitted wallet models. |

### Per-window inputs and state

Every eligible CLOB update supplies full Up and Down bid/ask ladders, Binance spot, Chainlink/RTDS TWAP, the available window-open reference prices, and seconds elapsed in the five-minute market. Each ladder is sanitized, sorted, and summarized into best bid/ask plus top-one and top-three depth. The policy retains approximately 65 seconds of causal feature history.

The window state separately tracks:

- filled Up and Down shares and cost;
- every still-pending order's requested minimum shares;
- unmatched filled lots by side in FIFO order, including an estimated fee per share;
- the last global fire, last fire by side, last evaluation, per-cell use counts, and order count; and
- persisted decisions and fills restored after a process restart, which rebuild fire timing, filled inventory, and FIFO lots.

For decisions, **effective inventory includes both fills and pending minimum shares**. This prevents the model from repeatedly ordering toward the same target during the 520 ms simulated latency. FIFO price lots include completed fills only and are used to estimate the pair cost of an opposite-side action.

### Decision pipeline

1. **Runtime and data gates.** The engine must be running, both outcome books must exist, the market must be unsettled, and `t < 300`. The strategy records the current feature snapshot, then requires T+4 through T+286.
2. **Cadence gate.** Calls closer than 250 ms to the previous evaluation abstain with `target-decision-cadence`.
3. **Cooldown gate.** A fired order blocks either side for 4,000 ms and reports `target-cooldown` until the interval expires.
4. **Construct one candidate per side.** For each of Up and Down, start at the current ask rounded upward to a cent. Search upward through 0.99 for the first cap whose `side:cent` cell has remaining uses. Thus an ask already on a cent can use that exact cap; the implementation does not blindly add one cent.
5. **Score release candidates.** A frozen standardized logistic model scores the Up candidate and Down candidate independently. The higher score wins; ties prefer the lower cap, then the lexical side name. Available ask depth through the cap is recorded for diagnostics but does not determine release or requested size.
6. **Apply release cutoff.** If neither side has an eligible menu cell, or the winning score is below 0.900, no order is emitted.
7. **Evaluate causal trend/noise and value.** A separate frozen model estimates the selected side's win probability from information timestamped no later than the decision. Based on the window-start UTC hour, the candidate must clear the session floor: 0.500 / 0.750 / 0.650 / 0.500 / 0.500 / 0.725 for consecutive four-hour bins starting at 00:00 UTC. It must also satisfy `probability - ask - feePerShare >= 0`; otherwise it abstains with `target-regime-rejected`. The release cutoff itself remains globally fixed at 0.900.
8. **Classify market structure.** Multi-timescale token paths produce `TREND_CONTINUATION`, `TEMPORARY_NOISE`, `PULLBACK_ENTRY_OPPORTUNITY`, `POSSIBLE_REVERSAL`, `CONFIRMED_REVERSAL`, or `UNCERTAIN`. The 0.70 confirmed-reversal boundary is diagnostic; a stronger reversal veto was rejected on validation because it worsened complete-path PnL and could strand old exposure.
9. **Predict and confidence-scale the desired residual.** A frozen regression tree predicts a non-negative absolute post-action residual. Fee-adjusted confidence scales it within 0.50×–1.00× before rounding; it is never levered above the prior tree target.
10. **Classify the inventory transition.** If the chosen side is currently behind, a second tree decides between a partial hedge and a full reversal. If the side is flat or already ahead, the action is an entry or top-up and the cross tree is not used.
11. **Calculate and clamp size.** The order covers the distance from current oriented inventory to desired oriented inventory, then is capped by 227 shares and the remaining planned gross room. A result below five shares abstains.
12. **Fire a fixed-budget BUY.** The decision emits a marketable FAK BUY with cent cap `C`, minimum shares `q`, and `budgetUsd = C × q`. The selected menu cell is consumed when the decision fires, even if the later simulated FAK receives no fill.

The release model uses 59 columns grouped as follows:

| Group | Implemented release features |
|---|---|
| Time and cap geometry | Fraction of window elapsed, ask, cap, cap headroom, whether cap is effectively the ask, spread, and sum of both asks. |
| Current liquidity | Top-one and top-three bid/ask depth, top-level and depth-three imbalance, and microprice bias. |
| Reference markets | Side-oriented Binance gap from open, Chainlink/TWAP gap from open, and Binance-minus-TWAP basis. |
| Price movement | Side ask, side bid, Binance, TWAP, and basis movement over 1, 3, 5, 15, 30, and 60 seconds. Spot/TWAP values are sign-flipped for Down so positive always means movement toward the candidate side. |
| Liquidity movement | Top-three ask and bid depth changes over 1, 3, and 5 seconds. |

Six additional schema fields—executable-run duration, time since global/same-side fire, absolute inventory, oriented inventory, and opposite inventory—are populated but have **zero weights** in the frozen release model. Consequently, filled/pending inventory does not directly choose Up versus Down in the current release score. Inventory affects the action only after a side wins, through residual sizing and partial-versus-cross classification.

The trend/noise research evaluated 112 causal columns over 0.5, 1, 2, 3, 5, 10, 15, 30, and 60 seconds: token ask/bid/mid paths, Binance and TWAP paths and basis, acceleration, persistence, path efficiency, volatility-normalized moves, trailing-range position, discount from the local high, spread, depth imbalance, and depth-pressure changes. Validation log loss selected time/price/pair context plus the token path. Adding the direct Binance/TWAP/basis group reduced validation AUC from 0.8124 to 0.7974; adding all features reduced it to 0.7953. Direct rejected inputs remain computed for diagnostics but have zero frozen weight. Two small composite `dominantScore`/`shortScore` inputs still blend token, Binance, and TWAP movement, so external feeds are not literally absent from the selected model. The BAPI cache does not contain aggressor-attributed trade flow, so depth changes are not described as buy/sell aggression.

The sizing and transition trees use a smaller private-state-aware feature set: elapsed seconds, selected-side ask/spread and pair ask, top-one/top-three depths, imbalance, top ask's share of depth, one- and five-second depth changes, ten-second bid/Binance movement, side-oriented Chainlink gap from open, absolute/oriented inventory, hedge flag, FIFO estimated pair cost, and time since global and same-side fire. The exact frozen tree nodes and hashes are in [`target75cc-model.js`](engine/strategies/target75cc-model.js); the exact standardized release coefficients and hashes are in [`target75cc-release-model.js`](engine/strategies/target75cc-release-model.js).

### Inventory transition and sizing equations

Let `U` and `D` be effective Up and Down shares, including pending minimum shares. For candidate side `S`, define `s = +1` for Up and `s = -1` for Down, then:

```text
net inventory       I = U - D
oriented inventory  x = s × I
base residual       B = max(0, residualTree(features) × residualScale)
confidence scale    k = 0.50 + 0.50 × sqrt(fee-adjusted confidence)
predicted residual  R = round(B × k)
```

The desired oriented inventory is:

```text
x >= 0                         -> +R  (flat entry or same-side top-up)
x < 0 and crossScore >= cutoff -> +R  (full reversal)
x < 0 and crossScore < cutoff  -> -R  (partial reduction; old side remains ahead)
```

The minimum requested shares are then:

```text
raw q = ceil(desired oriented inventory - x)
q     = min(raw q, max order, gross ceiling - effective gross shares)
```

For example, if the bot effectively owns nine more Down than Up, an Up candidate has `x = -9`. A reversal with `R = 5` requests `ceil(5 - (-9)) = 14` Up shares: nine neutralize the old lean and five create a new Up residual. If the policy instead selects partial reduction with `R = 5`, it requests `ceil(-5 - (-9)) = 4`; that falls below the five-share floor and is skipped. With a 20-share old lean, the same partial target requests 15 opposite shares and leaves the old side ahead by five.

This logic fixes the former one-direction failure: Up and Down are evaluated on every eligible release cycle, and an opposite selection can reduce or cross the existing position. It does **not** guarantee a hedge, balanced outcomes, or a profitable pair. The policy deliberately holds a directional residual unless its model target is zero.

### Simulated execution, accounting, and known boundary behavior

At decision time the simulator schedules the order for `decision time + 520 ms`. While it is pending, the live shadow path tracks the latest full ladder at or before that deadline. At the deadline it walks visible asks no higher than the signed cent cap, spends at most the fixed USDC budget, books actual VWAP and shares, and cancels any remainder. Price improvement can produce more than the requested minimum shares, so the 300-share control is a **planned-minimum gross bound**, not a guaranteed post-fill hard ceiling. No BBA-only fallback invents depth in the replay path.

Every filled action is a BUY and is held to resolution; this strategy emits no SELL or merge. Modeled taker fee is `0.07 × price × (1-price) × shares`. The two outcome views are:

```text
if Up wins   = Up shares   - total cost - modeled fee
if Down wins = Down shares - total cost - modeled fee
resolved PnL = winning shares - total cost - modeled fee
```

The session circuit breaker accumulates resolved window P&L and stops the bot once cumulative loss crosses its configured limit. It cannot prevent a loss already present inside the currently unresolved window.

There are two important state/execution boundaries:

- Normal latency matching walks the arrival ladder, but `settle()` and `recordPending()` directly book any still-deferred record if a window closes before its deadline instead of re-walking that final arrival ladder. With the model stopping at T+286 and latency at 520 ms this should not occur during ordinary automatic operation, but it remains a correctness boundary for manual orders or changed stop/latency settings.
- Restart hydration rebuilds fills, FIFO lots, and last-fire timing, but does not reconstruct the per-cell-use map or a sub-second in-flight simulated order. A mid-window restart can therefore make a previously used `side:cent` cell eligible again. This is a restart-parity limitation, not target-wallet behavior.

### Decision observability

Every call leaves a machine-readable gate in `state.strategyStatus`: outside interval, cadence, cooldown, no menu cell, below release threshold, regime unavailable/rejected, gross cap, residual already satisfied, or fired. A fired record also stores the chosen side/cap/cell, release score and model hash, UTC confidence session and applied probability floor, regime class/probability/edge/confidence/model hash, dominant and short scores, base and scaled residual, oriented/absolute inventory, cross score and hash, uncapped/capped size, action role (`entry`, `topup`, `hedge`, or `reversal`), and all sizing/tree/regime features. The window settlement record snapshots the active configuration and a histogram of these gates, so a later replay can identify the actual policy settings rather than relying on the current UI.

### What this implementation does not reproduce

- It does not know the wallet's private pre-signed order menu, canceled and unfilled attempts, confidence state, bankroll, or cross-product inventory.
- It is calibrated only to BTC five-minute reconstruction data even though the target trades several assets and intervals.
- It approximates release with public book/spot/TWAP features; exact autonomous release parity remains about 24% F1.
- The trend/noise layer is trained on candidates emitted by that approximate release policy; it reduces bad exposure but does not repair release-time parity.
- Its selected model is dominated by public price/time context and token price paths. Direct Binance/TWAP/basis and snapshot-depth additions failed validation; only the small blended dominant/short scores retain external-feed information.
- Pullback entries were positive on the one-day discovery holdout but negative on validation and partial OOS, so pullback profitability is not established.
- FAK, 520 ms latency, 227 maximum order, 300 gross ceiling, and the session stop are local execution/risk assumptions, not recovered wallet constants.
- It buys both directions across time, but it is not a guaranteed two-leg arbitrage strategy and does not force outcome-neutral exposure.
- It remains simulation-only because the OOS interval is partial, settlement drawdown worsened modestly under the session schedule, one holdout session has sparse coherent-L2 coverage, and exact action parity remains weak.

## Live wallet re-review — expanded scope

The linked Polymarket profile resolves to `asdaefef`, joined in April 2026, and displayed 155,699 predictions when reviewed: [official profile](https://polymarket.com/profile/0x75cc3b63a2f2423085e10706c78b494017b93ce1). The page and portfolio values are live and changed during this audit, so the API counts below carry explicit observation times rather than being treated as permanent profile statistics.

The new evidence materially expands the earlier BTC-5m conclusion. This wallet is a high-participation, multi-asset automated strategy running BTC, ETH, SOL, and XRP 5-minute markets plus BTC 15-minute markets in parallel. It is not best described as a single BTC momentum bot.

### Current public-activity snapshot

For activity from 2026-08-26 00:00Z through approximately 2026-09-02 11:19Z:

| Product | Actions | Traded markets | All-in USDC | Actions/market | Both-side markets | Opposite-inventory actions | Median / p90 fill shares |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC 5m | 16,077 | 1,926 | $163,677 | 8.35 | 59.40% | 25.19% | 8.74 / 32.00 |
| ETH 5m | 13,050 | 1,942 | $87,318 | 6.72 | 64.21% | 30.15% | 7.00 / 20.00 |
| XRP 5m | 8,544 | 1,922 | $59,402 | 4.45 | 63.68% | 33.70% | 7.14 / 22.00 |
| SOL 5m | 6,731 | 1,858 | $53,960 | 3.62 | 54.04% | 28.41% | 8.50 / 26.62 |
| BTC 15m | 5,740 | 657 | $36,607 | 8.74 | 73.67% | 37.07% | 6.56 / 18.00 |

The snapshot contains about 50.1k BUY activity rows across more than 8.3k markets and roughly $401k all-in spend. There were no SELL rows. The latest 10,000 rows from `takerOnly=false` matched the latest 10,000 from `takerOnly=true` as a multiset, extending the all-taker finding beyond the saved BTC cohort. This is direct evidence for the latest public rows, not proof that the wallet has never used a maker order in its lifetime.

The system participates in roughly nine out of ten available tracked product windows during this interval. A typical market has five activity rows; p90 is twelve and the observed maximum is 36. This is a repeated-inventory-update policy, not one prediction and one order per market.

### Revised behavioral interpretation

Across the live snapshot, about 61% of traded markets contain both Up and Down buys. Reconstructing inventory chronologically from the beginning of each market gives 14,901 opposite-inventory actions, or 29.72% of all actions: 7,932 cross the position into the new side and 6,969 leave the prior side dominant. That independently reproduces the older BTC study's approximately 30.5% opposite-inventory rate.

Only about 6% of market-final inventories would be profitable under either outcome after the reported all-in cost. Most positions are therefore not complete-set arbitrage. Buying both sides is predominantly a way to resize, reduce, or reverse a directional lean. The strategy's edge must come from choosing the ultimately winning residual more often and sizing it effectively; it does not come from routinely locking a sub-$1 pair.

Size rises with elapsed time. In 5-minute products, median observed fill size increases from about 6.75 shares in minute one to 12.38 in minute five, while p90 rises from 14.74 to 58.26. BTC 15m shows the same late escalation: median size is about 6–8 through most of the window and 13.41 in the final minute, with p90 at 53. This strongly supports a time/confidence-dependent target residual or pre-sized menu and rejects a constant seven-share clone.

The product policies are related but not identical. BTC 5m uses the most capital and leaves the largest residuals; SOL trades least often per market; BTC 15m buys both sides and changes inventory most frequently. A faithful model therefore needs shared policy structure plus asset/interval-specific calibration, rather than one set of BTC-5m thresholds copied across every market.

ET activity also differs: the Morning and Afternoon sessions have more actions per market and more opposite-inventory actions than Early Morning and Evening. This validates retaining ET session as a feature, but activity differences alone do not justify four independently optimized strategies.

### Current profitability evidence

The official crypto leaderboard returned the following live snapshots for this address:

| Period | Volume | PnL | PnL / volume | Crypto rank |
|---|---:|---:|---:|---:|
| Day | $42,873 | $771 | 1.80% | 107 |
| Week | $315,567 | $5,243 | 1.66% | 40 |
| All | $12,174,771 | $275,143 | 2.26% | 104 |

`PnL / volume` is a turnover efficiency ratio, not bankroll ROI. The leaderboard's `WEEK` and `MONTH` periods use their own service boundaries and should not be mixed with the fixed UTC cohort below. The endpoint and fields are documented by Polymarket: [trader leaderboard](https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings).

A separate fixed-range pull of resolved position records whose last activity was at or after 2026-08-26 00:00Z grouped 13,390 outcome rows into 8,294 markets. Their reported realized PnL summed to approximately +$11,230, with 5,222 positive and 3,072 negative markets, a 62.96% non-zero win rate, and profit factor about 1.39. Every observed product was positive over this particular range:

| Product | Resolved markets | Realized PnL | Win rate | Profit factor |
|---|---:|---:|---:|---:|
| BTC 5m | 1,923 | +$3,766 | 67.76% | 1.31 |
| XRP 5m | 1,920 | +$2,956 | 59.17% | 1.77 |
| ETH 5m | 1,940 | +$2,556 | 64.85% | 1.42 |
| SOL 5m | 1,855 | +$1,465 | 58.87% | 1.34 |
| BTC 15m | 656 | +$487 | 66.01% | 1.22 |

This is materially stronger evidence that the wallet policy is profitable than the third-party profile scrape cited by search engines. It remains an observational, overlapping, still-moving interval—not the frozen Aug 20–27 discovery and Aug 27–Sep 3 OOS experiment. It also does not tell us which public signal caused each release.

### Fee-field validation

The prior audit treated Data API `usdcSize` fee inclusion as unverified because the schema does not define the arithmetic. A current 500-row reconciliation resolves it empirically for this wallet: every row satisfied

`usdcSize - price * size = 0.07 * price * (1-price) * size`

within 0.00001 USDC, Polymarket's documented fee-rounding quantum. Thus the current tracker/history interpretation of `usdcSize` as all-in taker cost is correct for this sample. This should become a regression test and historical cohorts should still be checked rather than relying on an undocumented field contract.

### Revised strategy thesis

The most defensible current thesis is:

1. A shared cross-asset model prepares or selects fixed-budget, price-capped BUY orders.
2. A release policy reacts repeatedly during each window, with activity throughout the interval rather than at one fixed clock.
3. Order size represents movement toward a time-, asset-, interval-, price-, confidence-, and inventory-dependent residual.
4. Same-side orders add conviction; opposite-side orders either partially reduce the old lean or cross into a new lean.
5. The system normally holds both outcome inventories to resolution; its profitability comes from the final directional residual, not frequent risk-free pairing.
6. The exact public-price trigger remains unidentified. Taker role, fixed-budget encoding, dynamic residual behavior, and profitability are better established than the release signal.

The exact-week reconstruction core and CLI wrappers are now present in the workspace and covered by the repository test/run instructions. Large raw and derived datasets remain under ignored `data/`; their summaries and hashes must be retained with any archived experiment.

## What was reviewed

The review covered the repository's runtime entry point, strategy registry and all strategy modules, live feeds, history adapters, execution and shadow simulation, fill and fee models, settlement/session accounting, persistence and UI/server seams, tests, configuration, documentation, target-wallet collectors/decoders/modeling/backtests, retained result reports, and the local weekly artifacts. `node_modules`, generated logs, caches, and secret values were excluded; configuration key names and external interfaces were inspected without reading or exposing credentials.

The project contains hundreds of source/data-index files outside `node_modules`. Much of `research/` concerns retired Lockstep, passive-maker, wallet-3048, and earlier target-75cc experiments. These remain research-only. [`engine/strategies/index.js`](engine/strategies/index.js) exposes only `target75cc` to FastMX; `helpme` remains registered solely for explicit offline research compatibility.

The effective flow is:

```text
LIVE
Binance aggTrade + RTDS TWAP + CLOB full book/BBA
                    -> shared live state
                    -> every current-token CLOB update
                    -> shadow.tick -> target75cc.step -> target release + inventory models
                    -> 520 ms pending fill -> visible ladder walk
                    -> position/fee/PnL -> Mongo + local logs + dashboard

REPLAY
BAPI v2 metadata + orderbooks -> top-3-level normalization -> 120 ms last-frame buckets
                    -> selected strategy step -> 520 ms causal ladder walk
                    -> per-window settlement -> session aggregation

TARGET RESEARCH
BAPI v4/Gamma market universe + Data API trades + Polygon V2 calldata + BAPI v2 L2
                    -> signed orders -> inferred fire intervals -> feature/control datasets
                    -> direction/release/transition/size models and replay summaries
```

## Prior Helpme baseline strategy

### Configuration drift

The preserved Helpme code defaults and its prior PM2 profile did not describe the same baseline configuration.

| Parameter | `helpme` default | Prior PM2 profile | Consequence |
|---|---:|---:|---|
| CLOB midpoint velocity | on | off | Deployed direction comes from Binance, not dual-source agreement. |
| Binance 3s raw move | on, $5 | on, $5 | Active direction source. |
| Binance 30s trend regime | on, 0.05% | on, 0.05% | Only gates strong countertrend signals. |
| 60s countertrend threshold | 0.075% | 0.075% | Required with a 0.075% fast move against a strong trend. |
| Binance direction vs window open | off | on | Deployed signal must agree with spot versus open. |
| Entry interval | `T+0..285s` | `T+0..300s` | PM2 permits orders through the close boundary. |
| Cooldown | 1,000 ms | 2,000 ms | Every distinct qualifying snapshot may refire after this delay. |
| Partial hedge / reversal | off / off | off / off | Deployed strategy skips every opposite-inventory signal. |
| Base/minimum shares | 7 / 4 | 7 / 4 | Entry budget is cap × 7, subject to at least four visible shares. |
| Session stop | -$25 | -$25 | Checked only after a window settles. |
| Modeled latency | 520 ms | 520 ms | Fill uses a later book. |

The code-level safety lock is genuine: [`src/config/config.js`](src/config/config.js) fixes `simulationOnly=true`, `executionMode="simulation"`, and an empty private key. Environment settings cannot arm real trading without a code change.

### Signal math and release logic

The exact default calculations in [`engine/strategies/helpme.js`](engine/strategies/helpme.js) are:

1. CLOB midpoint is the Up-token midpoint:

   `m(t) = (bestBidUp(t) + bestAskUp(t)) / 2`

   `vClob(t) = m(t) - m(t0)`, where `t0` is the latest changed midpoint at or before `t-3s`. It qualifies when `|vClob| >= 0.02`.

2. Binance gap velocity algebraically cancels the opening price:

   `vBz(t) = [B(t)-Bopen] - [B(t0)-Bopen] = B(t)-B(t0)`

   The prior is at or before `t-3s`; it qualifies when `|vBz| >= $5`.

3. If both fast sources are enabled, both must qualify independently and select the same Up/Down direction. If one is disabled, the other can act alone.

4. The trend regime uses:

   `trend30 = 100 * [B(t)-B(t-30s)] / B(t-30s)`

   If `|trend30| < 0.05%`, or trend history is missing, the fast signal passes unchanged. If the fast signal opposes a strong trend, both the 3-second Binance move and a 60-second Binance move must be at least `0.075%` in the new direction.

5. The optional deployed window-gap gate requires the selected direction to equal the sign of `B(t)-Bopen`; an exact tie is classified Up.

6. A qualifying event then passes cooldown, exact-signal deduplication, ask range, and visible depth checks. The buy cap is:

   `cap = min(LIMIT, H_MAX_ASK, ceilCent(bestAsk + H_CAP_HEADROOM))`

   With the PM2 settings this is normally the next cent above the ask, capped at 0.98.

7. An aligned/flat entry is a fixed-USDC intent:

   `budgetUsd = cap * minimumShares`, normally `cap * 7`

   Price improvement can therefore yield more than seven shares. Replay labels this FAK and cancels the unused budget. The isolated live router can use FAK or a marketable GTC whose remainder is immediately canceled, but live routing is unreachable under the safety lock.

8. Repeated qualifying events are not limited to the onset of a regime. A changed signal snapshot may place another entry whenever cooldown permits. There is no per-window order limit or exposure cap.

9. Opposite-inventory behavior is disabled in the effective profile. Optional code can either retain a one-share old-side lead or, under stricter confirmation, cross the old imbalance and leave ten shares on the new side. Neither branch is an empirically complete target model.

The Helpme baseline has no sells, stop losses, take profits, expected-value gates, bankroll sizing, session/time-of-day specialization, volatility sizing, pair-cost rule, TWAP signal, microprice/imbalance signal, or maximum market exposure. The current target policy adds model-based inventory sizing, a fee-adjusted expected-value gate, multi-timescale trend/noise confidence, a UTC-session entry-probability schedule, and a planned gross-share ceiling. It still has no active sell/stop-loss/take-profit or bankroll allocation. The $25 circuit breaker only sees realized window PnL after settlement, so it cannot contain a large loss building inside the current five-minute window.

## External and local data inventory

| Source | Fields used | Runtime/research use | Audit result and limitation |
|---|---|---|---|
| Binance spot WebSocket `@aggTrade` | price, event/receive time | Active 3s/30s/60s signal | Live history uses receive timestamps. A stale last value can remain available to the strategy; reconnect health is displayed but not a decision gate. |
| Binance REST `/api/v3/aggTrades` | first trade after window boundary | Window-open reference | Used for the optional open-gap gate; provisional WS fallback after 10s. |
| Polymarket RTDS `crypto_prices_twap_sixty` | Chainlink TWAP-60 price | Dashboard, metadata/open fallback | Not an active Helpme direction input. There is no direct Chainlink on-chain read. |
| Polymarket CLOB market WebSocket | `book`, absolute-size `price_change`, `best_bid_ask` | Live BBA, depth, trigger cadence | Protocol handling matches the public market-channel schema. The two token snapshots can have different ages, and a BBA-only event can be paired with older depth. |
| Gamma API | slug, condition ID, token IDs, outcomes/winner fallback | Window discovery and identity | Useful metadata, not authoritative execution history. |
| Data API `/activity` | type, side, outcome, size, price, `usdcSize`, tx hash | Live target tracker and history cards | Official schema does not define the arithmetic, but all 500 current sampled rows matched notional plus the 0.07 crypto taker fee within 0.00001 USDC. Historical regression checks are still required. |
| Data API `/trades` with `takerOnly` true/false | size, price, side, asset, tx hash | Target research | Weekly collection shards by condition ID and classifies roles by multiset subtraction. `/trades` has no `usdcSize`; weekly target PnL therefore models fees separately. |
| BAPI v2 `/snapshot-ticks` | open/final prices, Binance open/final, winner | Runtime/replay metadata | Used unconditionally by `fetchWindowHistory`. |
| BAPI v2 orderbook `/orderbooks` | coherent Up/Down L2 plus Binance/TWAP | Replay and target reconstruction | Downsampled to the last frame per 120ms bucket, then truncated to three levels on each side. This is not full L2 after normalization. |
| BAPI v3 | configured base/key/version selector | Intended replay alternative | Dead configuration: `fetchWindowHistory` always calls the v2 path. UI/status can report v3 while v2 is used. |
| BAPI v4 | market universe and some legacy snapshots | Target collector/research | The current target collector uses v4 to enumerate markets, despite the primary requested replay source being v2. Gamma is a fallback. |
| Polygon RPC | transactions, receipts, blocks, calldata/logs | V2 signed-order decoding and runtime transaction detail | Target decoder identifies tuple 0 as taker and maker-array tuples as makers. This strongly verifies settlement role but not order lifetime or unfilled orders. |
| Polymarket crypto-price endpoint | TWAP open/close resolution pair | Settlement fallback | Correctly requests the 60-second TWAP pair for 5m/15m resolution. |
| CLOB REST/user WebSocket | order placement/status/fills | Isolated real-execution seam | Present and tested, but disabled by the code-level simulation lock. |
| Credential service | API credentials/signing material | Isolated live seam | Present but irrelevant while simulation-only. Secret values were not inspected. |
| MongoDB and local JSON/GZIP/logs | fills, decisions, sessions, cached ticks | Persistence/replay | Local weekly research data are ignored by Git; raw coverage and generator code are incomplete. |

Official Polymarket documentation confirms that market WebSocket price changes carry absolute sizes, FAK may partially fill and cancel the remainder, GTC can rest, and only takers pay the category fee. The current crypto fee formula is `shares * 0.07 * p * (1-p)`, rounded to five decimal places: [market channel](https://docs.polymarket.com/api-reference/wss/market), [order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle), and [fees](https://docs.polymarket.com/trading/fees).

## Target-wallet evidence

### Saved weekly cohorts

| Measure | 2026-08-16 04:00Z–08-23 04:00Z | 2026-08-26 04:00Z–09-02 04:00Z |
|---|---:|---:|
| Expected BTC 5m markets | 2,016 | 2,016 |
| Public trade rows | 12,963 | 14,971 |
| Traded markets | 1,835 | 1,801 |
| Data API role/action audit | 12,963 taker BUY; 0 maker/sell | 14,971 taker BUY; 0 maker/sell |
| Decoded transactions/errors | 12,963 / 0 | 14,971 / 0 |
| Target signed orders joined | 12,963 / 12,963 | 14,971 / 14,971 |
| On-chain tuple roles | 100% taker | 100% taker |
| Median signed cap | $0.78 | $0.78 |
| Median signed minimum shares | 7 | 9 |
| p90 / p99 minimum shares | 29 / 92 | 37 / 125 |
| Median fixed budget | $5.46 | $6.16 |
| p90 / p99 fixed budget | $17.35 / $65.10 | $22.31 / $83.16 |
| Max fixed budget | $224.73 | $236.61 |
| Inferred fire orders | 10,919 | 14,910 |
| High+medium fire confidence | 63.08% | 64.04% |
| Executable at exact cap | 34.71% | 31.57% |
| Median inferred fire-to-public lead | 2,172 ms | 2,010 ms |
| Hazard groups / matched controls | 6,823 / 160,203 | 9,472 / 223,431 |
| Burst classifier validation/holdout AUC | 0.6448 / 0.6434 | 0.6881 / 0.6840 |

The fire timestamp is inferred from L2 consumption; it is not observed directly. About 36% of inferred orders are low confidence. Exact-cap executability at the inferred boundary is only about one third, and some public timestamps precede the inferred interval. Fire-level analyses therefore require sensitivity bands, confidence-stratified results, and an “unresolved” category rather than a single ground-truth timestamp.

### Confirmed, inferred, and unknown

| Confidence | Finding | Basis |
|---|---|---|
| Confirmed for the saved cohorts | Observed BTC 5m activity is BUY-only and taker-side. | Independent Data API role audit plus 100% V2 calldata decode/join. |
| Confirmed | BUY order encoding is fixed budget: `makerAmount=USDC`, `takerAmount=minimum shares`, `cap=budget/minimum shares`. Better execution can increase shares. | Signed V2 tuple and joined fills. |
| Confirmed | Size is not a constant seven shares. | Minimum shares span 5–227 and 5–267; budgets have large tails. |
| Confirmed in the older 6,025-action study | 1,837 actions (30.49%) were opposite the pre-order inventory; 833 were partial hedges and 1,004 crossed inventory. | Chronological signed-order/inventory reconstruction. |
| Strong inference | A menu of integer-share, cent-cap orders is signed near market open and selected later. | In the older study, 93.645% were signed within 15s of open and 87.975% released at least 20s later; weekly cohorts show similar early signing. |
| Strong inference | Entry sizing targets a time/price/confidence-dependent post-action inventory residual. | Median signed shares rise from 6 in minute 1 to 13 in minute 5; residual model holdout median absolute error 3.45 shares versus 7.40 for a constant. |
| Moderate inference | The target release decision uses public price/book state plus inventory and private menu state. | Matched hazard controls and release models improve over chance, but AUC and exact-time metrics remain weak. |
| Unknown | Exact release rule, confidence state, canceled/unfilled menu, whether a market was intentionally skipped, and the order lifetime instruction. | These are private/off-chain or absent from filled-order data. |
| Unknown | A stable profitable causal policy reproducible from public inputs alone. | Existing exact parity is weak and current-engine backtests lose after fees. |

Signed `timestamp` must not be treated as fire time. It is an order-construction field in the V2 signed payload; the repository correctly uses it only as a lower bound. Polymarket's V2 migration reference documents that added timestamp field: [CLOB V2 migration](https://docs.polymarket.com/v2-migration).

### Parameter provenance and current configuration

The target wallet is **not evidenced to use the FastMX controls shown in the old dashboard screenshot**. In particular, no observation establishes a 2-second CLOB lookback, `$0.02` midpoint threshold, 3-second / `$5` Binance trigger, 30-second trend threshold, 60-second countertrend threshold, gap-agreement toggle, or fixed base size of seven. Those fields belong only to the retired `helpme` research baseline and are absent from FastMX runtime configuration.

The target strategy now uses the following narrower configuration. “Fitted” means selected or estimated from the frozen discovery data; it does not mean the wallet literally contains that named constant.

| Runtime control | Value | Provenance and interpretation |
|---|---:|---|
| Residual scale | `1.0` | Fitted sizing-tree calibration. Order size is dynamic; exact action medians/p90s were 8/29 and 12/48 shares in discovery/partial OOS. |
| Cross cutoff | `0.485064` | Chronological holdout calibration for partial reduction versus inventory crossing. Both behaviors are directly observed; this probability cutoff is model-specific. |
| Release cutoff | `0.900` | Selected by discovery-validation timing F1 for the autonomous public-feature release model. It is not an observed wallet threshold. |
| Trend/noise probability / minimum edge | `0.500 / 0` | Candidate must clear 0.50 and fee-adjusted expected edge `p - ask - fee >= 0`; validation-selected local policy, not a wallet constant. |
| Reversal / confirmed label | `0.500 / 0.700` | 0.50 permits a counter-trend action after the value gate; 0.70 changes its diagnostic label only. |
| Confidence residual range | `0.50×–1.00×` | Validation-selected downscaling of the residual-tree target; no confidence leverage above baseline. |
| Evaluation cadence | `250ms` | Replay/runtime sampling resolution. Public fills do not expose the wallet's internal evaluation loop. |
| Global cooldown | `4000ms` | Validation-selected approximation. It is not a wallet fact: observed inter-action times reached zero for simultaneous opposite-side action groups, with p1 about 351ms and medians about 9.1s / 6.6s. |
| Uses per side/cent cell | `1` | Validation-selected approximation. Roughly 3% of observed filled cells repeated, up to three times in discovery and four in partial OOS. |
| Model support interval | `T+4..286s` | The frozen release-policy search interval. Actual inferred target actions span approximately T+0.23..298.16 and T+0.71..297.70; the runtime bounds must not be described as target stop times. |
| Minimum / maximum order | `5 / 227` shares | Five is the observed floor. The maximum is the discovery-model support clamp; partial OOS signed orders reached 267 and grouped actions reached 278, so 227 is not a universal wallet cap. |
| Planned gross ceiling | `300` shares | Local risk guard only. Observed cumulative signed gross reached 970 and 1,032 shares, so the target does not support claiming a 300-share cap. |
| Live order type | `FAK` | Execution assumption. Taker BUY role is confirmed, but FAK/FOK/GTC lifetime is absent from the signed order tuple. |
| Modeled latency | `520ms` | Local fill-simulation assumption, not an inferred target parameter. |
| Session stop | `$25` default | Local circuit breaker, not cloned wallet logic. |

The release model consumes causal CLOB depth/price, Binance spot, Chainlink/TWAP, basis, time, and multiple 1/3/5/15/30/60-second changes. The second-stage trend/noise layer evaluates horizons from 500ms through 60s, applies fee-adjusted value, and confidence-scales size. Neither uses the old threshold chain. The dashboard exposes one fixed FastMX strategy identity and only the wallet-model controls; the persisted runtime schema rejects legacy Helpme parameters.

### What is and is not cloned today

Cloned or substantially represented:

- marketable BUY/taker intent;
- fixed-USDC BUY encoding with a cap and price-improved share expansion;
- causal latency and visible-ladder partial-fill mechanics in the strict historical path;
- basic binary settlement arithmetic;
- dynamic post-action residual sizing through the frozen chronological model;
- model-based partial-reduction versus inventory-cross selection;
- explicit entry, top-up, hedge, reversal, and abstention roles with filled-plus-pending inventory.

Assumed rather than cloned:

- 520ms as the target decision-to-fill latency;
- the fitted public-feature release model and its score/cadence/cell-use policy as a proxy for the private release program;
- the fitted trend/noise probability, structural labels, and fee-adjusted confidence curve as a local risk filter rather than recovered wallet state;
- FAK as the target's exact order type;
- autonomous enumeration of executable one-cent cap cells;
- the 5–227 per-order and 300 planned-gross safety bounds;
- fixed 0.07 crypto fees without per-market fee lookup;
- that all relevant private state is inferable from public fills.

Not cloned:

- the target's pre-signed menu generation;
- exact release timing and abstention;
- full dynamic sizing tails outside the training support;
- exact partial-hedge versus cross parity beyond the model's measured holdout accuracy;
- the target's session/time-of-day policy;
- maximum exposure and capital allocation;
- non-fired/canceled orders;
- a validated next-week PnL distribution.

## Strategy audit table

| Component | Prior Helpme baseline | Target evidence | Status |
|---|---|---|---|
| Entry direction | CLOB and/or Binance 3s momentum; PM2 uses Binance only plus window-open agreement. | Direction can be predicted selectively from public features, but no exact stable rule is recovered. | Assumed; not cloned. |
| Entry timing | Every distinct qualifying snapshot after cooldown, through T+300 in PM2. | Target uses delayed release of pre-signed orders; exact held-out ±2s precision is 3.52–4.09% in existing searches. | Material mismatch. |
| Price cap | Ask plus 1 cent, ceiled to a cent, max 0.98. | Target cap median 0.78 with wide, time-varying headroom; signed caps extend to 0.99. | Partial shape only. |
| Size | Fixed cap × 7-share budget. | Dynamic residual target; p90 minimum shares 29–37 and p99 92–125 in saved weeks. | Material mismatch. |
| Execution | Fixed-USDC FAK replay at T+520ms; strict visible walk in historical simulator. | Marketable taker confirmed. Exact lifetime and decision latency unknown. | Taker style cloned; details assumed. |
| Opposite signal | Skip by default; optional partial hedge/reversal. | 30.49% of older reconstructed actions are opposite inventory. | Replacement target policy can reduce or cross; parity remains approximate. |
| Position management | Add aligned entries; no exposure/order cap, sell, or target residual. | Target behaves like dynamic inventory rebalancing. | Replacement adds target residual and planned cap; exact sizing still mismatches. |
| Exit logic | Settlement only; optional complete-set merge infrastructure is not active in Helpme. | Saved cohorts have no observed sells, supporting buy-and-settle behavior for filled trades. | Broadly consistent, but missing unfilled/canceled evidence. |
| Session control | Global $25 realized-loss breaker after settlement. | No target session policy recovered. | Risk control, not clone logic. |
| Time/session | Six fixed UTC entry-probability floors; no session-specific model coefficients or sizing tree. | Strong time-dependent sizing and likely behavior differences. | Entry selectivity is calibrated; broader target session behavior remains missing. |
| Regime adaptation | One Binance trend/countertrend gate. | Public multi-timescale price/book/feed state is informative, but the private state is unknown. | Replacement causal layer improves risk in end-to-end replay; partial OOS still loses. |
| Liquidity | Minimum four shares within cap. | Target fire inference uses cap executability, runs, depth and consumption. | Too shallow/simple. |
| Fees | Generic 700bps crypto formula; no venue rounding or market fee lookup in main engine. | Official crypto formula matches, but fee application to target activity is inconsistent. | Formula right; accounting/config incomplete. |
| Drawdown | Session curve at settlement boundaries. | Requested daily/session/max drawdowns require intrawindow deployment/equity accounting. | Inadequate metric. |
| Stop conditions | Ask/cooldown/gate checks and delayed session loss. | Target abstention rule unknown; no per-market exposure stop. | Not cloned. |

## Correctness and reproducibility findings

### Blockers

1. **The private release/menu state is absent from public filled-order data.** Exact discovery data and the generator now exist, but the wallet's unfilled/canceled orders, menu creation time, confidence state, and release program do not. Observable-only autonomous timing F1 remains about 24% across discovery holdout and partial OOS.

2. **Historical feed coverage is incomplete.** The exact discovery manifest contains all 2,016 expected rows, but only 1,508 reach the strict T+298s runtime rule; one source slug returns 404 and 507 are incomplete. Results use the eligible 74.80% and keep the missing rows in the coverage denominator.

3. **Release timestamps are inferred intervals, not observed decisions.** The exact-week join infers 99.875% of orders in complete markets, but 4,552 orders are low confidence. Policy fitting excludes low-confidence actions and reports interval/tolerance-based parity; it cannot turn inferred L2 consumption into private decision ground truth.

### High severity

4. **“Full L2” is truncated to three bid/ask levels.** [`src/sources/history.js`](src/sources/history.js) normalizes each outcome with `limit=3`. A cap can span more levels, especially at sub-cent tick sizes, so replay can understate available size, partial fills, slippage, and queue consumption.

5. **End-of-window pending orders can become synthetic fills.** [`engine/simrun.js`](engine/simrun.js) calls `resolveDue(Infinity)` after the last tick, using a preselected last available arrival frame even when the latency deadline lies beyond recorded coverage. [`src/execution/shadow.js`](src/execution/shadow.js) books every still-pending decision at settlement without rechecking the arrival ladder. PM2 permits decisions through T+300, making this reachable.

6. **Live shadow and historical matching disagree on absent depth.** Historical replay passes `allowBbaFallback:false`; live shadow calls the walker with its default `true`, which treats a BBA-only quote as unlimited depth. A simulated live fill can therefore exist when the strict historical replay would reject it.

7. **Feed freshness/coherence is not a simulation decision gate.** The real-money router has a bought-side BBA freshness check, but the shadow strategy may evaluate fresh data for one token with stale BBA/depth for the other and a stale Binance value. Depth timestamps are passed but not checked. This can distort both midpoint signals and fills.

8. **Fee configuration is disconnected from PnL.** `helpme.STRAT` exposes `FEE_BPS`, `FEE_USE_MIN`, and `FEE_ALL_FILLS`, but `positionFromFills`, shadow booking, and session accounting normally call fee helpers with module defaults, not the active strategy parameters. Changing the UI/config fee fields does not reliably change reported PnL.

9. **Missing windows are excluded, not represented in performance denominators.** Session replay uses only successfully fetched, settled windows. A result can silently improve if difficult/missing windows are dropped. Coverage, missingness by day/session, and bounds for missing windows must accompany every metric.

The earlier `usdcSize` uncertainty is no longer a high-severity blocker for current wallet activity: the live 500-row reconciliation confirms fee-inclusive cost. It remains a schema-contract and historical-regression risk.

### Medium severity

10. **Backtest version selection is misleading.** Config/UI can select v3, but history fetch is fixed to v2. Manifests can report a version different from the data actually used.

11. **Live and replay decision cadence differ.** Live acts on every book event; history uses the last frame in each 120ms bucket. This changes threshold crossings, dedup keys, cooldown timing, and order count. Parity must be measured, not assumed.

12. **Session bankroll scaling is not chronological execution.** If a window's peak deployment exceeds balance, every fill in that window is uniformly scaled after the fact. A venue would accept or reject/resize orders chronologically. Uniform scaling changes inventory, fees, and settlement PnL.

13. **Drawdown and session breaker are too coarse.** Drawdown uses post-settlement balances only; the recorded `troughBal` is not used to capture intrawindow equity/deployment. The loss breaker also checks only after each resolution. Requested max/daily/session drawdown needs marked intrawindow equity and explicit capital-at-risk.

14. **Venue fee precision is omitted.** Official fees round to five decimal places with a 0.00001 minimum quantum. The main fee helper returns unrounded floats. This is small per fill but systematic across many orders.

15. **Documentation has stale assertions.** README calls normalized replay “full L2”; strategy documentation still contains retired-default language; BAPI v3 comments imply a working selector. These can cause experiment/config misidentification.

16. **Tie labels are misleading.** Session and shadow summaries label equal Up/Down holdings as Down rather than flat. This affects direction-match counts for balanced positions.

## Existing verification results

The repository's configured test command now passes all 84 Node tests. The added target tests cover model provenance, exact causal feature invariance when future snapshots are mutated, regime classification, economic rejection/admission, and parameter validation. The broader suite still covers strict historical L2 walking, current Helpme gates, target two-sided transitions, private-state exclusion, circuit-breaker generation, WebSocket depth updates, order status, and resolution URLs, but cannot test private wallet state.

Existing research must be interpreted narrowly:

- Current fire-confirmation search: validation-selected held-out precision 4.09%, target-action coverage 31.23%, ±2s.
- Exact release/action search: held-out precision 3.52%, recall 7.50%, ±2s.
- Selective current direction rule: 97.89% point precision at 8.69% holdout coverage; combined forward 98.24% at 8.89%, but Wilson-95 lower bound 95.56%. This is neither 98% lower-bound confidence nor action parity.
- Paired toggle replay over 2,875 markets: CLOB+Binance lost $393.00; Binance-only lost $863.69 after modeled fees.
- Current entry/top-up engine in the inventory-mode replay: 52,268 orders and -$9,812.84 over all 2,875 markets. Partial hedge and reversal variants were also negative; reversal improved holdout relative to entry-only but degraded fit.
- Weekly hazard burst AUC is 0.64–0.68 out of sample. The second weekly multi-head policy file contains fitted coefficients but no stored evaluation metrics or end-to-end fills/PnL table.

The new exact-week artifacts add a stable observable cap-ranking result and an autonomous replay, but still do not support profitability or a 98% behavior-clone claim. The selected observable model has pairwise AUC 0.868 and only 11.38% exact top-cell recovery on discovery holdout. Autonomous holdout timing F1 is 24.35%; partial-OOS timing F1 is 23.47%.

The causal trend/noise model was fitted on Aug 20–24 baseline candidates, selected on Aug 25, and left Aug 26 untouched. Context plus token path achieved validation/holdout AUC 0.8124/0.8182 and log loss 0.4775/0.4767. In integrated replay the enhanced policy produced +$41.40 on validation, +$37.95 on the untouched one-day holdout, and -$33.85 on frozen partial OOS versus -$92.05, -$273.62, and -$1,190.50 for the prior runtime policy. The OOS result is a large risk reduction, not profitability proof.

## Proposed ET sessions

Use `America/New_York`, not a fixed UTC offset, and assign by window start. The four disjoint sessions are:

| Session | Local interval | August 2026 UTC equivalent |
|---|---|---|
| Early Morning | 00:00–06:00 ET | 04:00–10:00Z |
| Morning | 06:00–12:00 ET | 10:00–16:00Z |
| Afternoon | 12:00–18:00 ET | 16:00–22:00Z |
| Evening | 18:00–24:00 ET | 22:00–04:00Z next day |

This matches the four equal 504-window labels found in each local seven-day cohort. All reports must include the UTC interval and ET label so daylight-saving transitions remain deterministic.

## Gated implementation plan

### Phase 2 — immutable exact-week data foundation

1. Define discovery as `[2026-08-20T00:00:00Z, 2026-08-27T00:00:00Z)` and untouched OOS as `[2026-08-27T00:00:00Z, 2026-09-03T00:00:00Z)`. If BAPI's first valid complete frame begins later than 00:00Z, record the exact boundary and shift both seven-day intervals rather than mixing partial days.
2. Add a tracked `research/wallet-75cc/weekly-parity-core.mjs` plus small CLI wrappers. Inputs, API versions, schema versions, retry policy, timestamps, and git/code hashes must be explicit.
3. Archive raw BAPI v2 metadata and every orderbook page before normalization. Retain all levels, source capture times, Binance spot, Chainlink/TWAP, opens/finals, and winners. Do not accept a window unless it covers the strategy's latest possible decision plus latency; for full-window research require at least T+298s and report the exact last frame.
4. Build a 2,016-row market manifest for each seven-day interval. Each row records source availability, first/last timestamps, tick counts, sequence gaps, one-sided frames, settlement status, trade count, and a SHA-256 hash. Missing windows remain rows with reasons.
5. Collect Data API `/trades` with both `takerOnly=false` and `true`, sharded below endpoint caps. Decode all unique settlement transactions. Require one-to-one public/on-chain reconciliation or explicitly quarantine unmatched records.
6. Validate fee/cost semantics on matched samples using CLOB trade `fee_rate_bps`, signed amounts, and on-chain transfers. Store notional, fee, and all-in cost as separate fields. Never infer role solely from a positive fee delta.
7. Persist raw and derived data outside Git if size requires, but commit schemas, manifests, checksums, compact summaries, and reproducible commands. A clean checkout with authorized API access must regenerate the same fingerprints.

**Phase 2 acceptance gate:** 2,016 enumerated markets; 100% rows accounted for; no silent drops; full coverage rate reported by feed/day/session; target fills and signed orders reconciled; exact discovery/OOS boundaries frozen; all generator code tracked.

### Phase 3 — causal reconstruction and model selection

1. Infer fire **intervals**, not point timestamps. Preserve high/medium/low/unresolved confidence and evaluate conclusions under the earliest and latest causal boundary.
2. Construct features only from information available before each candidate decision: full L2 state/changes, spread, microprice, depth/imbalance, executable duration, Binance moves/gap, TWAP gap, basis, time remaining, ET session, previous public target fills, reconstructed inventory, and available signed-menu cells.
3. Create matched negative controls within the same market/side/cap and near the action in time. Include earlier executable moments, later non-action moments, opposite-side cells, and neighboring caps. Prevent the same order/market from crossing train/validation boundaries.
4. Model the policy as separate conditional components:
   - release hazard/abstention;
   - side choice;
   - signed cap/menu-cell choice;
   - partial hedge versus cross transition;
   - target residual and minimum-share sizing;
   - optional session-specific calibration.
5. Use days 1–4 for fitting, days 5–6 for model/config selection, and day 7 as an internal untouched discovery holdout. Compare interpretable rules, regularized logistic models, and trees. Do not optimize on OOS-week PnL.
6. Benchmark against current Helpme, constant/clock baselines, public winner-following baselines, and oracle target-side/action/cap ceilings. Report calibration and confidence intervals, not only AUC.

**Phase 3 acceptance gate:** every label has provenance/confidence; feature-time assertions prove no future reads; selected model improves exact action precision/recall and end-to-end replay over simple baselines on discovery day 7; unresolved/private-state limitations remain explicit.

### Phase 4 — integrity fixes and simulation-only implementation

Before introducing the new policy:

1. Preserve all L2 levels needed by a cap walk and add coverage/coherence timestamps.
2. Cancel pending orders whose latency deadline is after the last causal frame; never auto-book them at settlement.
3. Make live shadow and replay use the same strict depth rule and same freshness gates for both tokens and Binance.
4. Centralize fee calculation, pass active parameters explicitly, apply five-decimal venue rounding, query/store market fee rate where available, and keep notional/fee/all-in cost separate.
5. Replace uniform window scaling with chronological balance checks and add intrawindow equity/deployment drawdown.
6. Make actual data-source version part of every returned payload and manifest; either implement v3 or remove the inactive selector.

The implemented consolidation uses the target-policy module as the sole FastMX runtime strategy while retaining `helpme` only for offline reproducibility. Preserve the code-level simulation lock, deterministic models, model/data hashes, and per-decision features, scores, gates, intended menu cell, inventory before/after, cap, budget, and confidence.

### Phase 5 — verification

Add tests for:

- full-depth multi-level cap walks and one-sided books;
- stale complementary token, stale Binance, and incoherent BBA/depth;
- pending order past final data/settlement;
- fee parameter propagation, per-market rate, and five-decimal rounding;
- chronological capital constraints and intrawindow drawdown;
- ET session boundaries and DST;
- signed BUY amount orientation, taker tuple role, partial fills, price improvement, hedges, and crossings;
- no-future-data assertions by mutating all post-decision frames and requiring identical decisions;
- identical live-event and replay-sampled decisions on a shared canonical event stream;
- missing-window denominators and deterministic dataset/model hashes.

Run the exact discovery week twice from immutable inputs and require byte-identical decisions and metrics.

### Phase 6 — required discovery report

For the whole week, every UTC day, and each ET session, report both target and bot:

- all 2,016 windows, usable windows, missing/unresolved windows, and active-market participation;
- target and bot action counts, exact release/side/cap/size matches, precision, recall, F1, and timing-error quantiles;
- Up/Down shares, number of trades, orders per active market, partial-fill/cancel rate, and fill fraction;
- deployed capital, peak concurrent capital, gross traded notional, modeled/observed fees, all-in cost, and utilization;
- realized PnL, fee-adjusted PnL, ROI on deployed capital, win rate with its denominator, profit factor, max intrawindow/settlement drawdown, and confidence intervals;
- complete session outcomes with no profitable-only filtering;
- results by fire-confidence tier and worst-case/unknown bounds for missing data.

### Phase 7 — frozen next-week out-of-sample test

1. Freeze the discovery dataset fingerprint, model coefficients/tree, thresholds, session calibration, strategy code hash, fee model, latency, and capital rules before reading OOS labels or PnL.
2. Run `[2026-08-27T00:00:00Z, 2026-09-03T00:00:00Z)` once with no retuning.
3. Produce the same whole-week/day/ET-session table plus degradation from discovery holdout.
4. If data are incomplete, publish the incomplete result and bounded sensitivity analysis; do not slide the interval or silently exclude windows.

**Promotion gate:** no live trading. The simulation default may be described as replicated or considered for live execution only after reproducible OOS improvement over Helpme and simple baselines, acceptable worst-session and drawdown behavior, stable fee/capital sensitivity, and materially better action parity. A 98% claim requires a predeclared metric and confidence bound; a selective 98% direction point estimate is not a 98% strategy clone.

## Current conclusion

The audit establishes a solid factual core—BUY-only observed activity, taker settlement role, fixed-budget signed orders, a two-sided cent-cap menu, dynamic sizing, and inventory rebalancing. The simulation policy implements all of those observable components. It now also uses a causal, no-lookahead trend/noise probability and fee-adjusted value gate plus confidence-downscaled residual sizing. Model/data provenance, ablations, autonomous parity, and the controlled baseline comparison are reproducible.

It nevertheless fails the user's “identical” requirement. On the same 1,508 complete discovery markets, observed target actions model to +$1,081.33 while the original autonomous runtime loses $1,932.78 and the global-0.50 trend/noise version loses $137.89. The UTC-session schedule changes that discovery total to +$12.31. On 1,651 partial-OOS markets, the target produces +$2,886.51, the original runtime loses $1,190.50, the global-0.50 enhancement loses $33.85, and the session schedule produces +$52.52 with profit factor 1.0563. That improvement is promising but small relative to missing private state; partial-OOS settlement drawdown rises from $91.45 to $95.60 and 47 of 48 Aug 26 holdout windows in the 04–08 UTC bin lack complete coherent L2. Keep execution hard-locked to simulation, complete forward monitoring, and do not claim an exact clone.
