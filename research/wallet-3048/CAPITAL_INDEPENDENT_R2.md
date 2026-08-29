# Capital-independent reconstruction, round 2

This round extends the exact-order/v4 reconstruction through the last resolved BTC five-minute market before `2026-08-24T00:50:00Z`. Its purpose is to separate the wallet's trading policy from its capital allocation.

## Result

The evidence supports one capital-independent loop with a live base-size parameter `Q`:

```text
base action  = Q shares
large action = L shares, normally 3Q in a stable configuration
price cells  = absolute $0.12..$0.89 in $0.01 increments
inventory and catch-up thresholds = multiples of Q
CLOB depth, imbalance, price, and depletion thresholds = absolute market units
```

The wallet changed from exactly `30/90` to exactly `25/75` shares without a corresponding change in its observable side selector or release gate. An old model frozen before the change scored as follows on later, untouched data:

| Test | Q=30 | Q=25 | Combined |
|---|---:|---:|---:|
| Fire versus one-second controls AUC | 0.7580 | 0.7621 | 0.7610 |
| Same-order release hazard AUC | 0.8948 | 0.8974 | 0.8963 |
| Structural hazard, no clocks AUC | 0.8808 | 0.8770 | 0.8786 |
| Fired-side choice AUC | 0.7072 | 0.7286 | 0.7203 |

Raw and capital-normalized scores are identical for fire, hazard, and side choice. The large-order branch is less deterministic: the old model reaches only `0.6117` AUC after normalization on Q=25. Treat `L` as an independently configurable menu choice, defaulting to `3Q`, rather than claiming a perfect public formula.

## Dataset and reconstruction

- 382 resolved five-minute markets from `2026-08-22T17:00:00Z` onward.
- 25,316 public fill rows: 18,250 taker and 7,066 maker rows.
- 25,299 settlement transactions decoded; 20,378 unique exact signed orders.
- 20,220 orders aligned to v4 L2 transitions; 18,213 are high- or medium-confidence fire observations.
- Median public reporting lag after the inferred CLOB fire is 2,562 ms; median inferred interval width is 55 ms.
- 15,789 collapsed observable actions and 2,052 multi-order action clusters.

The embedded signed-order timestamp is used only to reconstruct the private candidate menu. Fire time comes from consecutive v4 order-book states, not the on-chain or public activity timestamp.

## Current policy

### 1. Build a reusable signed menu

The wallet signs three main waves per window:

```text
pre-open: approximately t - 89.7s
middle:   approximately t + 40.7s
late:     approximately t + 170.9s
```

For each token it prepares one-cent cap cells in the observed `$0.12..$0.89` band, with base and large quantities and repeated cells for retry/partial-fill handling. In the middle and late waves, signing time and cap are almost perfectly ordered: at least 91% of sufficiently populated side groups have correlation >= 0.7, with median correlation 0.999. Opposite-side candidates signed within 3 ms sum to $1 within one tick 63.72% of the time.

This proves an ordered, two-sided action menu. It cannot expose signed candidates that never filled.

### 2. Select the pressured token from CLOB L2

Up and Down books are binary-complement mirrors, not independent signals. One side's ask is the complement of the other side's bid. A compact selector can therefore use one token book and choose the orientation with:

- thinner top and three-level ask depth;
- stronger same-side bid depth and positive imbalance;
- positive microprice pressure;
- rapidly depleting asks over one to five seconds.

On 14,281 simultaneous comparisons, the fired side had lower top ask depth 71.61% of the time and lower three-level ask depth 70.45% of the time. The new untouched side-choice AUC is 0.7169.

Binance aggTrade and Chainlink RTDS TWAP60 remain secondary context/tie-breakers. This research does not change those feeds. The immediate release clock is CLOB L2, not a Binance-only or RTDS-only direction rule.

### 3. Release an exact executable menu cell

The candidate cap normally equals the current executable ask: 81.78% of high/medium-confidence orders fire at the ask and another 6.05% fire one tick above it. A representative current high-probability release leaf is:

```text
exact cap == current ask
executable for > 0.525s
top ask depth <= 93.92 shares
three-level ask depth <= 408.02 shares
one-second three-level ask depletion <= -114.486 shares
```

That leaf has observed conditional probability 0.9617 in the matched hazard sample. It is one tree leaf, not the whole strategy. The full same-order hazard model scores 0.8974 AUC on its untouched late split, and a version without time/cadence fields still scores 0.8751. This is direct evidence that low and falling ask liquidity is the main release trigger.

The current stable period starts near the open and can run almost to expiry:

```text
first fire: median t+3.073s; p90 t+8.463s
last fire:  median t+196.565s; p90 t+257.762s
observed overall active envelope: about t+0.1s through t+294.4s
median inter-action time: 2.181s
```

### 4. Execute taker plus resting maker remainder

Submit a persistent marketable GTC buy with `postOnly=false` at the selected cap. It may consume the ask immediately and leave the unfilled quantity resting as a bid. The observed Q=25 share mix is 15.37% maker.

If the remainder does not receive opposing flow, remove it and select another signed cell. Inferred Q=25 cancellation lifetime is 1,347 ms median, replacement lag is 1,197 ms median, and the replacement cap moves up by $0.01 median. Same-cap retries exist, but are only 6.55% of inferred Q=25 replacements.

### 5. Cycle inventory rather than stop at the first hedge

Each fill is classified against current inventory:

```text
entry/top-up       48.99%
hedge              41.20%
over-hedge/cross    9.82%
```

The Q=25 median is four inventory crossings per active window. Thus the observable unit is not one entry plus one hedge; multiple entry/hedge/cross cycles can run in the same five-minute window. FIFO pairing has median delay 14.91 seconds, and 64.34% of raw pairs cost at most $1 before fees.

Large `3Q` actions occur 25.22% of the time. They are more common for hedge/cross actions and late in the window, but no public deterministic threshold explains them fully. Keep `largeSize` separately configurable even when its default is `3Q`.

## Implementable pseudocode

```text
config:
    Q = base shares
    L = large shares, default 3Q
    capMin = 0.12
    capMax = 0.89

before/during each window:
    build or refresh both-side signed menus near -89.7s, +40.7s, +170.9s
    include one-cent cap cells, Q/L quantities, and retry cells

for each L2 update from approximately t+0.1s to t+294.4s:
    derive bid/ask depth, imbalance, microprice, and 1s/3s/5s depletion
    orient the binary-complement book toward the stronger/thinner-ask token

    cap = current ask for that token
    if cap outside [0.12, 0.89]: continue
    if no active signed candidate at (token, cap): continue
    if CLOB release classifier and cadence/rearm state do not pass: continue

    quantity = Q
    if private large-menu branch passes: quantity = L

    submit GTC BUY at cap with postOnly=false
    record immediate taker fill; leave any remainder resting at cap

    monitor the exact-price queue:
        opposing flow first consumes visible queue ahead
        credit maker fills only after queue ahead clears
        cancel/reprice selectively when state changes or timeout fires

    update token inventory and FIFO lots
    allow hedge to neutral or cross through neutral
    after a cross, continue the same loop as a new cycle
```

## Capital scaling

The latest stable Q=25 sample used an average `28.97Q` of turnover per active window. Its observed spend distribution was median `26.95Q`, p90 `51.74Q`, p99 `71.61Q`, and maximum `79.56Q`.

| Q | Base / large shares | Mean spend per active window | Observed p99 | Observed maximum | Historical mean PnL/window* |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 / 3 | $29 | $72 | $80 | $0.43 |
| 5 | 5 / 15 | $145 | $358 | $398 | $2.17 |
| 10 | 10 / 30 | $290 | $716 | $796 | $4.34 |
| 25 | 25 / 75 | $724 | $1,790 | $1,989 | $10.86 |

`*` Linear scaling of the historical Q=25 mean, not a forecast or guarantee. Only 48.57% of Q=25 windows were profitable, despite positive aggregate PnL.

A conservative first sizing bound for one active window is:

```text
Q <= deployable_bankroll_per_active_window / 80
```

Reserve additional capital for overlapping/unsettled windows and live resting remainders. Down-scaling is much safer to infer than up-scaling because minimum order rules, quantity precision, fees, and finite visible depth break perfect linearity.

## Economics and replay boundary

Observed stable epochs:

| Period | Q / L | Active windows | Cost | Payout | PnL | ROI |
|---|---:|---:|---:|---:|---:|---:|
| Aug 22 17:00–Aug 23 06:15 | 30 / 90 | 146 | $114,861.72 | $116,990.65 | +$2,128.93 | +1.853% |
| Aug 23 07:00–Aug 24 00:50 | 25 / 75 | 210 | $152,088.06 | $154,367.62 | +$2,279.56 | +1.499% |

The isolated 45-minute live transition lost $36.20 and temporarily used 50/90, then 25, before stabilizing at 25/75. This is strong evidence that base and catch-up sizes can be changed independently in real time.

The frozen simple clone does not yet reproduce the wallet's PnL. On the new Q=25 range:

- observed wallet: `+2,279.56`;
- frozen all-taker replay: `-$1,908.84`;
- queue-aware 3-second remainder model: `-$695.00`, with 46,385 maker shares versus the wallet's 47,632;
- queue-aware 5-second model: `-$17.18`, but with too much maker volume;
- queue-aware 10-second model: `+$437.15`, also with too much maker volume.

Matching aggregate maker volume is therefore insufficient. The remaining PnL gap is concentrated in private action-menu availability and selective remainder lifecycle: which partials are left in queue to receive opposing flow, which are cancelled, and how that changes residual inventory. Public aggregate L2 cannot identify another order's exact queue position, but the gap is now isolated and measurable. It is not evidence for replacing the verified CLOB release mechanism with another spot signal.

## Files

- `data/wallet-3048-r2/capital-invariance.{json,md}`
- `data/wallet-3048-r2/frozen-capital-validation.{json,md}`
- `data/wallet-3048-r2/menu-topology.{json,md}`
- `data/wallet-3048-r2/frozen-scale-backtest.json`
- `data/wallet-3048-r2/order-hazard-analysis.{json,md}`
- `data/wallet-3048-r2/side-choice-analysis.{json,md}`

This is the closest public-data reconstruction currently supported by exact signed orders and v4 L2. It is an implementable approximation, not a claim to possess the wallet's private configuration or unfilled/cancelled signed menu.
