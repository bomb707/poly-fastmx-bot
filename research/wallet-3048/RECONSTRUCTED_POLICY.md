# Reconstructed current policy (capital-independent R2)

This is the smallest implementable specification consistent with exact signed orders, v4 fire timing, the screenshot checkpoint, the later 30/90 to 25/75 live size change, and untouched holdout tests. Detailed evidence and capital examples are in `CAPITAL_INDEPENDENT_R2.md`.

## State

```text
openCL = Polymarket RTDS Chainlink TWAP60 window open
openBZ = Binance aggTrade-derived window open
Q = configurable base shares
L = configurable large shares, default 3Q
inventoryQ = (upShares - downShares) / Q
fifoLots = unmatched effective-price lots by token
lastActionMs, lastSideActionMs
active signed menu = Q/L BUY orders by side and 0.01 price cell
```

## Construction schedule

```text
build wave A near t-89.7s
refresh/build wave B near t+40.7s
refresh/build wave C near t+170.9s

for both Up and Down:
    prepare Q-share choices at multiple cells across the 0.12..0.89 range
    prepare duplicate/retry choices
    prepare L-share alternatives at many identical cells
```

The construction timestamp never starts a trade. It only proves when a candidate existed.

## Decision loop

```text
for every CLOB L2 update while roughly 0.1s <= t <= 294.4s:
    for side in [Up, Down]:
        a1 = ask depth at best level
        b1 = bid depth at best level
        a3 = ask depth over best 3 levels
        b3 = bid depth over best 3 levels
        I1 = (b1 - a1) / (b1 + a1)
        I3 = (b3 - a3) / (b3 + a3)
        micro = (b1*ask + a1*bid)/(b1+a1) - (ask+bid)/2
        depletion1 = a3(t) - a3(t-1s)

        strength(side) = tree(I1, I3, micro, depletion1,
                              bid/ask moves, ask, short Binance,
                              weak Chainlink tie-breaks)

    side = argmax strength(side)
    if ask(side) outside 0.12..0.89: continue

    cap = ask(side)                         # select exact-ask signed cell
    if no active signed choice(side, cap): continue

    releaseGate = low ask depth
                  and falling ask depth
                  and supportive same-side bids
                  and cadence/rearm satisfied

    strongest transparent leaf:
        bidMove1 > -0.01
        a1 <= 151.60
        I3 > 0.247946
        depletion1 <= -188.64

    if !releaseGate: continue

    size = Q
    if the independently configurable large-menu branch passes:
        size = L                         # normally 3Q

    submit signed BUY(side, cap, size), persistent and marketable
    allow immediate taker fill plus resting remainder

    track visible queue ahead at the exact resting price
    if remainder survives about 1.3s median or branch/state changes:
        cancel remainder
        choose fresh same-side price cell
        replace after roughly 1.2s median, commonly one tick higher

    update FIFO inventory
    permit the action to stop at neutral or cross neutral
    after a cross, continue the identical loop as the next cycle
```

## External feed role

```text
Binance 1s impulse:
    useful for flat/first choice and as a secondary release tie-break

Chainlink RTDS live TWAP60:
    correct window reference and weak hedge/regime confirmation
    not the immediate millisecond fire clock

CLOB token L2:
    primary side selector and primary release trigger
```

## Calibration targets

For the latest stable Q=25 period, a faithful implementation should approach:

```text
active windows:       210 / 214
actions:              9,974
hedge actions:        51.013%
inventory crossings: 4.662 per active window
3Q actions:           25.216%
maker shares:         15.369%
first fire median:    t+3.073s
last fire median:     t+196.565s
```

The current simple replay matches the architecture but not the private remainder queue or exact action-menu availability. A queue-aware three-second model nearly matches maker volume but remains $2,974.56 below observed PnL. Selective cancel/retain state is the next calibration layer, not a reason to replace the CLOB selector/release formula with a Binance-only or price-dip strategy.
