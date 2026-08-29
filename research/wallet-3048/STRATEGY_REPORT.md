# Wallet 0x3048 strategy reconstruction

Wallet: `0x3048d65321be3497164cdfc2996f94f98a2e7537`
Observed range: 2026-08-14 00:00 through 2026-08-22 17:00 UTC
Current strategy epoch: E8, 2026-08-21 19:55 through 2026-08-22 17:00 UTC
Market: BTC Up/Down five minute

## Result

The wallet is a pre-signed, two-sided CLOB liquidity-momentum cycler. It constructs a ladder of 30- and 90-share BUY choices, selects the token whose Polymarket book shows the stronger near-term imbalance, and releases the exact-ask branch when ask liquidity has thinned/depleted. Orders are marketable and compatible with `GTC, postOnly=false`: they can consume the ask and leave a passive remainder. Inventory is allowed to hedge, cross neutral, and begin another cycle repeatedly. Binance gives a secondary fast directional tie-break; Chainlink RTDS TWAP-60 is the window reference and a weaker regime/hedge input, not the primary millisecond fire trigger.

The strongest recovered current-policy branch is:

```text
candidate side s must have 0.12 <= ask(s) <= 0.89
choose the signed price cell whose cap == current ask(s)

side strength(s) is dominated by:
    top/depth-3 bid-vs-ask imbalance
    microprice bias toward the ask
    one-second ask-depth depletion

high-confidence release leaf:
    bidMove1(s) > -0.01
    askDepth1(s) <= 151.60 shares
    depth3Imbalance(s) > 0.247946
    askDepth3Change1(s) <= -188.64 shares

cadence form of the same gate:
    exact-ask price cell
    executable continuously for about 0.4-0.6 seconds
    askDepth1(s) <= 74.47 shares is the strongest leaf

size:
    normally 30 shares
    choose the pre-signed 90-share branch late (especially t > 211s),
    or for a catch-up/overbuy when |inventory| is about 103+ shares

execution:
    BUY at the selected cap, marketable, postOnly=false-compatible
    take visible ask; rest any remainder
    cancel/reprice stale remainder; repeat until the late-window stop
```

Those thresholds describe the strongest tree leaves, not a claim that every action must satisfy one hard conjunction. The complete learned trees are in `data/wallet-3048/order-hazard-analysis.json`, `side-choice-analysis.json`, and `fire-gate-tree.json`.

## 1. On-chain grouping first

The reconstruction starts with exchange calldata, not public trade timestamps:

- 119,021 public trade rows cover 2,259 wallet-traded windows.
- Settlement calldata yields 93,106 exact signed order hashes.
- Signed size modes are 30 (59,322 orders), 50 (13,130), 80 (9,777), 90 (6,634), 60 (3,921), and 20 (322).
- 99.976% of exact signed limits are within 0.12–0.89.
- The signed EIP-712 `timestamp` is order-construction time. Local CLOB-client source confirms it is populated from `Date.now()`; it is not submit, match, or on-chain placement time.

Exact hashes are grouped twice:

1. a gap of more than 60 seconds separates major signing waves;
2. same-side hashes independently released within 300 ms are one observable action.

This produces 4,961 major signing waves in 2,237 windows and, in E8, 12,136 high/medium exact orders collapsed into 10,992 actions. 9.507% of E8 actions contain multiple hashes, so treating every hash as a separate signal decision would overcount.

## 2. Off-chain fire time from v4

Each exact hash is aligned to the pre-consumption and post-consumption v4 L2 snapshots. On-chain block time and the later public match timestamp are excluded from the decision time.

- 86,808 of 93,106 exact orders receive an inferred v4 fire: 73,212 high confidence, 4,933 medium, 8,663 low.
- High/medium inference interval width is 48 ms median.
- Public match time trails the high/medium v4 fire by 2,577 ms median.
- Methods: 66,680 take, 9,315 take-plus-rest, and 10,813 rest fingerprints.
- 79.543% of high/medium limits equal the pre-fire ask; another 6.401% are one tick above.
- The order was already within its cap for 1.514 seconds median before release, proving that price executability alone is insufficient.

The conditioned hazard test is stricter: it compares an actual fire only with earlier 250 ms ticks where that same signed action was already executable, after the previous wallet action, under the same inventory interval.

- 5,407 marketable actions have 39,636 such no-fire controls.
- Actual cap headroom is 0.00 median versus 0.02 at eligible no-fire moments.
- Actual askDepth1 is 65 versus 152.06 shares; askDepth3 is 527.17 versus 798.04.
- Actual top imbalance is 0.6131 versus 0.1233.
- Actual one-second depth change is -183.325 versus -12.36 shares.
- Equal-action-weight matched AUC is 0.9143 in training and 0.8975 on the untouched holdout.
- Removing all clock/cadence fields still gives 0.8752 holdout AUC.

This establishes the immediate trigger as exact-ask ladder selection plus CLOB depletion/bid support, not Binance, RTDS, or an on-chain timestamp.

## 3. Side selection

At 9,529 non-simultaneous fires, the selected token was compared with the opposite token at exactly the same pre-consumption tick:

| Feature | Selected token | Other token | Paired selection rate |
|---|---:|---:|---:|
| askDepth3 median | 537.66 | 904.25 | lower 71.508% |
| bidDepth3 median | 904.25 | 537.66 | higher 71.508% |
| depth3 imbalance median | +0.23489 | -0.23489 | higher 71.508% |
| askDepth1 median | 72.18 | 251.91 | lower 71.351% |
| top imbalance median | +0.52612 | -0.52612 | higher 71.351% |
| one-second ask-depth change median | -186.18 | +126.13 | lower 68.863% |

The relationship is not caused by inventory alone. In the 284 flat-inventory choices, the selected token has the stronger depth-3 imbalance 73.944% of the time. A market-only tree scores 0.7336 train and 0.7319 on untouched holdout; adding inventory fields does not improve it.

The role-dependent secondary signals are:

- Flat/first choice: follows one-second Binance direction 61.796% paired; CLOB depth remains stronger.
- Entry/top-up: usually keeps the existing lean, buys the cheaper token (median 0.44 versus 0.57), and is contrarian to both the Binance window gap (60.338%) and Chainlink window gap (60.073%).
- Hedge: buys opposite existing inventory, tends to fade five-second Binance direction (57.883%), and weakly follows the Chainlink gap (54.233%).
- Within the exact-order hazard set, one-second Binance movement has AUC 0.5918, while Chainlink one- to five-second movement is only about 0.513–0.515. Binance is a tie-break/release confirmation; live RTDS movement is not the main trigger.

## 4. Action menu and live configuration

Major signing waves start near these phases:

- pre-open: modes around t-85 to t-90 seconds;
- middle refresh: usually t+40 to t+65 seconds;
- late refresh: usually t+170 to t+200 seconds.

Median spacing is 134.578 seconds. In E8, 77.85% of waves contain repeated filled orders at the same side/cap/size, and 47.883% contain both 30- and 90-share filled choices at the same side/cap. Because only filled candidates become public, these are lower bounds. This proves a pre-signed action menu: live state selects among sizes and duplicate retry/catch-up choices instead of calculating one size from price.

Eight observed size/config epochs are recoverable:

| Epoch | UTC interval | Filled size modes | Median first/last fire | Interpretation |
|---|---|---:|---:|---|
| E1 | Aug 14 00:00–Aug 15 20:05 | 80 | 20.056 / 197.554s | original passive-heavy setup |
| E2 | Aug 15 20:05–Aug 18 05:10 | 50 | 21.349 / 184.176s | first retune |
| E3 | Aug 18 05:10–06:15 | 20 | 12.671 / 163.020s | short experiment |
| E4 | Aug 18 06:15–20:35 | 30 | 60.145 / 120.139s | sparse 30-share phase |
| E5 | Aug 18 20:35–Aug 19 12:25 | 30/60 | 8.340 / 182.285s | faster cycling |
| E6 | Aug 19 12:25–Aug 20 15:30 | 30/90 | 5.558 / 197.129s | catch-up size enabled |
| E7 | Aug 20 15:30–Aug 21 19:55 | 30/60/90 | 5.870 / 208.467s | all size branches |
| E8 | Aug 21 19:55–Aug 22 17:00 | 30/90 | 6.167 / 203.974s | 60 removed; pair-priority retune |

The 60-share branch disappears for 27.2 hours, returns, and disappears again at E8. That is direct evidence of live configuration changes.

## 5. Maker/taker and cancel/replace

- 10,048 exact hashes settle as both taker and maker; 7,959 also have high/medium v4 take-plus-rest fingerprints.
- This is direct behavioral evidence for a marketable persistent order compatible with `GTC/GTD, postOnly=false`, although time-in-force itself is not part of the public signed payload.
- 12,111 maker-seen hashes remain partially filled.
- 8,931 cancel/removal candidates are inferred; 4,499 are high/medium confidence.
- High/medium passive lifetime is 1.026 seconds median.
- Cancel-to-next-same-side replacement lag is 1.604 seconds median.
- Replacement price change is +0.01 median; only 7.402% reuse the exact limit.

The operating loop is therefore take, optionally rest, remove stale remainder, select a fresh exact-ask ladder cell, and retry. Duplicate 30/90 candidates explain how it can overbuy configured shares after a partial or failed order.

## 6. Cycles and economics

This is not a fixed “cycle 1 then cycle 2” strategy. Inventory labels recover 39,092 entry/top-up orders, 31,314 pure hedge orders, and 7,739 hedge orders that cross neutral into a new lean. Median FIFO opposite-side delay is 13.305 seconds. The current regime repeatedly crosses sides; a median-window ordinal pairing is ambiguous because only 4.798% of high/medium adjacent construction pairs have a unique possible mate.

The robust model is FIFO inventory:

```text
entry/top-up: selected side adds to the current residual lean
hedge: selected side reduces opposite inventory
overhedge: a configured 30/90 action consumes the remaining hedge need and crosses neutral
new cycle: inventory sign crosses; the same selector continues immediately
```

From Aug 19 onward, public fills decompose into:

- 797,709.52 completed-set shares, +$3,421.71, or +0.4289 cents/set;
- 136,612.02 residual shares at 0.479037 average cost, +$4,844.37;
- +$8,266.08 combined FIFO-attributed PnL.

The terminal residual follows the t+270 Binance direction only 48.416% and Chainlink only 46.832%. It is a cheap contrarian residual produced by cycling, not a final trend bet.

## 7. Screenshot checkpoint

The supplied Aug 22 12:10–12:15 PM ET screenshot is `btc-updown-5m-1787415000`, winner Up. It is an exact checkpoint after the first two signing waves:

| Outcome | Exact checkpoint shares | Average | Bet | Fee |
|---|---:|---:|---:|---:|
| Down | 333.716490 | 68.5499c | $228.762193 | $3.794070 |
| Up | 233.583246 | 25.5421c | $59.662052 | $2.698640 |

- Pre-open wave: eight filled signed orders fire t+4.966 through t+32.173.
- Middle wave: 21 fire t+43.875 through t+151.155.
- A 52.464-second pause follows.
- Late orders are signed at t+170.627 and 18 fire t+203.619 through t+240.370.
- Inventory crossed sides twice by the screenshot and twice more afterward.
- The visible checkpoint leaves 100.133244 excess Down; the complete window ends with 126.470388 excess Down.
- Final gross buys are 620.002190 Up and 746.472578 Down.

So the screenshot is total logic for the first two action-menu waves, not the whole window. Its exact match validates the grouping method and confirms multiple concurrent/repeated cycles.

## 8. Chainlink RTDS and window open

The strategy must use the same Polymarket crypto-price convention as the corrected lockstep feed:

```text
twapEnabled=true
twapLookbackSeconds=60
```

The true RTDS TWAP-60 open and v4 `coinPriceStart` differ by more than $0.01 in 75.93% of sampled windows, so they are not interchangeable. In this wallet, however, the Chainlink reference primarily defines window state and contributes to entry/hedge regime logic. The v4 CLOB depth transition is the immediate order-release signal.

## 9. Backtest and falsification

All replays use executable v4 asks rather than midpoint fields and charge the crypto taker fee on taker fills.

Rejected models:

- Static Binance/CLOB reversion state machine: untouched Aug 21–22 holdout -$4,180.44 (-0.937%).
- Profit-fit Binance proxy: train +$2,314.30, holdout -$1,425.89 (-1.500%).
- E8 token-price dip/pendulum clone: holdout -$5,566.43 (-7.127%).
- Applying the conditioned release hazard as a stand-alone side selector: holdout -$10,885.15 (-4.235%). This fails because hazard is stage two, after branch selection.

Full E8 L2 uses 125 markets for fitting and 125 later markets as untouched holdout. Target holdout behavior is 5,846 actions, 50.992% hedges, 5.367 crossings/active window, 21.827% 90-share actions, and -$169.95 (-0.167%). Two source windows lacking resolved winners are excluded from this L2 target; their provisional zero-payout loss explains the difference from the broader epoch summary.

Frozen diagnostics:

| Replay | Holdout actions | Crossings/window | Holdout PnL | Interpretation |
|---|---:|---:|---:|---|
| Transparent L2 behavior gate | 4,021 | 4.175 | -$220.67 (-0.409%) | closest simple economic/behavior clone |
| Strict L2 depletion gate | 2,440 | 2.521 | +$360.96 (+1.344%) | profitable but materially undertrades |
| Learned generic release tree | 4,853 | 3.869 | -$467.60 (-0.804%) | close mechanics, misses private menu/queue economics |
| Explicit side-choice + release | 4,847 | 3.697 | -$748.61 (-1.280%) | confirms structure, not exact economics |

The transparent behavior formula is:

```text
askDepth3 <= 800
depth3Imbalance >= 0.20
askDepth3Change1 <= -300
cooldown 500 ms
max absolute lean about 180
30 shares normally; 90 when catch-up state is active
```

It is the closest compact replay, but the target’s maker queue, unfilled private menu branches, and exact partial-fill reconciliation remain economically important. Therefore the holdout results validate the selector/release structure while rejecting a claim that the remaining private state has been cloned exactly.

## Confidence ledger

High confidence:

- exact signed hashes, sizes, caps, construction waves, public fills, and settlement roles;
- off-chain fire intervals from v4 pre/post depth transitions;
- exact-ask ladder selection and low/falling ask-depth release gate;
- CLOB imbalance as the primary side selector;
- 30/90 E8 menu, multiple inventory crossings, take-plus-rest lifecycle, and rapid replacement;
- RTDS TWAP-60 as the correct Chainlink window reference.

Medium confidence:

- `GTC` rather than another persistent TIF; `postOnly=false` is strongly implied by mixed take/rest behavior;
- the simplified numerical thresholds outside the strongest leaves;
- FIFO cycle attribution and the precise 90-share catch-up boundary.

Not promoted to fact:

- ownership of every aggregate cancellation, exact queue priority, unfilled signed candidates, authenticated user-channel events, and the live UI config values that never produced a fill.

These remaining items explain the replay gap; they do not change the recovered architecture or immediate CLOB trigger.
