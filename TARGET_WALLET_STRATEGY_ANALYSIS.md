# Empirical Strategy Reconstruction: Polymarket Wallet `0x3048…7537`

**Wallet:** `0x3048d65321be3497164cdfc2996f94f98a2e7537`  
**Market studied:** Polymarket BTC Up/Down, 5-minute rounds  
**Analysis snapshot cutoff:** Unix `1788019630` (2026-08-29 16:07:10 UTC)  
**Report date:** 2026-08-30  

> This is a behavioral reconstruction from public fills, synchronized market data,
> and decoded Polygon transactions. It is not the wallet's source code. Statements
> are classified as **observed**, **strong inference**, or **hypothesis** so that
> measured facts are not confused with implementation guesses. Gross PnL figures
> exclude fees and rebates unless explicitly stated.

> **Correctness status (2026-09-08):** this behavioral research does not establish
> that the reconstructed runtime policy is profitable. The repaired simulator,
> chronological sensitivity results, and data limitations are documented in
> [`research/wallet-3048/CORRECTNESS_AUDIT_2026-09-08.md`](research/wallet-3048/CORRECTNESS_AUDIT_2026-09-08.md).

## 1. Executive conclusion

The target is almost certainly an automated, buy-oriented execution system. The
best-supported description is:

> **A pre-signed, signal-skewed, cross-and-rest limit-order ladder that begins with
> the side favored by fast Binance information, subsequently accumulates both legs
> when their economics are attractive, and deliberately retains bounded directional
> inventory when the estimated edge is stronger than the value of completing the pair.**

It is not well described as any one of the following in isolation:

- a pure predictor of the final winner;
- a pure market maker;
- a pure `UP + DOWN < $1` arbitrageur;
- a bot with privileged same-price FIFO access;
- or a simple momentum taker.

Instead, its observed profit combines two components:

1. **Pair or inventory-spread edge.** It buys both outcomes at an average combined
   cost below $1 often enough to create a positive paired component.
2. **Directional residual.** Quantities are normally unequal. The unpaired remainder
   is an outright bet whose result depends on the winning outcome.

Across 125 resolved BTC rounds in the broad frozen sample, gross PnL was about
**+$2,152.94**. The paired component was about **+$2,846.76**, while the residual
directional component was about **−$693.82**. The main profit engine in this sample
was therefore pair accumulation; directional selection improved execution and
inventory construction, but did not itself produce the aggregate profit.

The strongest defensible upstream source is **ultra-short Binance momentum**, not a
long Chainlink or CLOB EMA. An initial block-time join suggested 5-second Binance
momentum and Binance-minus-Chainlink relative lead. A later timing audit showed that
the public activity time is the Polygon block time, about 2.5 seconds after the
off-chain match in a clean L2 subset, so block-time CLOB measurements contained the
wallet's own execution. After locating exact pre-fill depth drops and using only the
preceding frame, 0.5-second Binance momentum agreed with the first taker side in
**68.2% (15/22)** of nonzero observations; the latest distinct Binance update agreed
in **60.0% (33/55)**. Pre-fill CLOB EMA was near chance and Chainlink EMA was weak or
opposite. This points to a fast Binance trigger, possibly smoothed or confirmed by
other microstructure features, rather than one proven standalone EMA formula.

The wallet also has an important latency architecture. Exact V2 order decoding found
that **149 of 164 first-entry fill rows (90.9%)** used orders signed before their
market opened, with a median lead of **89.776 seconds**. The original signed sizes
were only **50 or 150 shares**. The bot appears to prepare a grid in advance, then
select and submit the suitable pre-signed order after the signal arrives. This avoids
putting EIP-712 signing on the critical reaction path.

Finally, the queue-priority hypothesis must be narrowed. The data supports fast
submission, aggressive limits, price improvement, and possible cross-and-rest
behavior. It does **not** prove that the wallet is always first among orders already
at the same price. The available historical order books contain aggregate depth, not
order IDs or FIFO rank.

### 1.1 Fresh re-research update (2026-08-30)

The wallet was re-examined after the initial report using a moving latest-5,500-row
activity sample, the Orbscan profile/trade views, current BAPI snapshots and native
L2, and fresh V2 calldata decoding.

Orbscan's live profile reported approximately:

- **$311,244.94 total PnL**;
- **$3.93 million total profit** and **−$3.62 million total loss**;
- **50.12% win rate** across **20,335 markets**;
- average size per market **$428.71**;
- **700,590 executions** shown in its trade view.

The near-50% win rate across more than 20,000 markets is powerful independent support
for pair accumulation as the core. A strategy earning this PnL through winner
prediction alone would need a materially better-than-random market win rate, while a
pair accumulator can profit regardless of which outcome wins.

The fresh BTC-only sample covered about 9.4 hours and produced:

| Fresh metric | Result |
|---|---:|
| BTC markets with both outcomes bought | 109 |
| Final average-price sum below 1 | 80/109 (73.4%) |
| Mean / median average-price sum | 0.9372 / 0.9375 |
| FIFO-matched pair shares | 45,885.1 |
| Average FIFO pair cost | 0.9306 |
| Gross FIFO pair edge | $3,186.38 |
| FIFO pair shares formed at combined cost >=1 | 16,309.5 (35.5%) |
| Later shares bought below that side's prior average | 49,214.4 / 104,626.7 (47.0%) |

For 104 synchronized settled markets in that rolling sample:

- gross PnL was **+$3,019.67** before complete fee/rebate accounting;
- FIFO pair component was **+$2,840.80**;
- residual directional component was **+$178.87**;
- the final majority-inventory side won only **47.1%**.

The paired component again explains nearly all profit, while the directional residual
was small. The fresh sample also refines two hypotheses:

1. **“It always buys below its current average” is false as a literal fill rule.**
   Only 47.0% of eligible later share volume was below the same side's prior average.
   The bot's economic test is more likely marginal pair cost plus inventory value,
   not a simple comparison with one global average.
2. **“It never forms an above-$1 marginal pair” is also false.** 35.5% of
   FIFO-matched shares had a combined acquisition cost at or above $1. Such purchases
   can still reduce outcome risk, complete inventory acquired under a different
   accounting convention, or reflect signal/risk decisions. The aggregate cheap
   pairs more than offset them.

Fresh exact role decoding over 1,254 recent BTC fill rows found:

| Role | Rows | Filled shares |
|---|---:|---:|
| Maker | 820 | 13,481.44 |
| Taker | 434 | 16,714.24 |

Maker fills were more numerous, but taker fills were larger: **55.4% of filled share
volume was taker**, with **$243.25** of decoded taker fees. First entry remains more
aggressive than the full accumulation stream. The best description is therefore
“taker for urgency, maker for patience,” while allowing either role throughout.

The current BTC five-minute market queried through the public CLOB metadata had
`itode: true`. Under current Polymarket documentation this activates a **250-ms taker
delay**: a marketable order is held, revalidated, then matched or placed on the book.
This strengthens the cross-and-rest interpretation and means speed comparisons must
include the venue's delay, not just network submission time.

#### Corrected EMA/source test

The first EMA scan joined signals at public activity time and found a 2–3 second CLOB
EMA associated with the first side in roughly 72–76% of observations. That result was
not causal: activity time exactly matched Polygon block time, while identifiable L2
depth drops occurred earlier.

For 57 exact taker-entry markets where a cumulative ask-depth drop matched the decoded
fill size within 8%, the inferred match-to-block lag was:

- median **2.494 seconds**;
- p10 **1.399 seconds**;
- p90 **4.167 seconds**.

Signals recomputed from the frame immediately **before** the candidate fill gave:

| Strictly pre-fill signal | First-side agreement | Coverage |
|---|---:|---:|
| Binance 0.5-second momentum | **68.2%** | 15/22 |
| Binance latest distinct price update | **60.0%** | 33/55 |
| Best Binance time-based EMA (0.25s) | 56.0% | 28/50 |
| Best CLOB EMA (1s) | 53.6% | 30/56 |
| Best CLOB momentum (2s) | 55.3% | 21/38 |
| Best Chainlink EMA | 39.6% | 21/53 |

The 0.5-second result has limited coverage and a wide statistical interval, so it is
evidence rather than proof of the exact rule. Nevertheless, the source ranking is
clearer:

```text
most likely upstream trigger: sub-second Binance price change
secondary filters: spread/depth, current Polymarket price, inventory economics
settlement anchor: Chainlink 60s TWAP/open reference
not supported as primary trigger: Chainlink EMA or a 2-3s CLOB EMA
```

An EMA can still be present inside the private implementation—for noise filtering,
volatility, fair value, or cancel/reprice logic—but the evidence does not identify
“EMA” as the core source. The more specific supported claim is that the bot reacts to
the latest fast Binance update before the slower Chainlink TWAP and Polymarket book
fully adjust.

## 2. Evidence hierarchy

| Level | Meaning | Examples in this report |
|---|---|---|
| **Observed** | Directly measured from public activity, BAPI snapshots/L2, or decoded V2 transaction input | Filled side, price, size, exact maker/taker role, signed timestamp, original order size |
| **Strong inference** | Multiple observations support the mechanism, but an off-chain field or unfilled state is unavailable | Pre-sign-and-select ladder, `postOnly=false`/omitted behavior, cross-and-rest use |
| **Hypothesis** | Plausible implementation that fits the evidence and should be backtested | Exact probability formula, coefficients, risk thresholds, cancel/replace cadence |

This distinction is especially important for Polymarket orders. `postOnly` and API
`orderType` are off-chain submission settings. They are not fields in the signed V2
order struct and are not preserved in `matchOrders` calldata. Exact maker/taker role
can be decoded; exact historical `postOnly` cannot.

## 3. Materials and methodology

### 3.1 Public wallet activity

The analysis froze the wallet activity stream at Unix `1788019630` and pulled up to
5,500 activity rows from Polymarket's Data API. BTC five-minute trades were grouped
by the timestamp encoded in each market slug. Redeem activity supplied the resolved
winner where available.

The broad sample contained:

- **126** BTC five-minute markets with fills on both sides;
- **125** resolved markets for aggregate position/PnL analysis;
- **118** entries with a non-tied first acquired side; seven markets had both first
  sides in the same public timestamp second;
- median observed entry **13 seconds after open**, with p10 **4 seconds** and p90
  **51 seconds**.

Public activity timestamps are second-resolution/block-oriented records. They should
not be interpreted as precise CLOB submission or matching latency.

### 3.2 BAPI synchronized market data

The supplied V2 BAPI guide describes three relevant feeds:

- Slug discovery: `https://bapi-v2.polywinbot.com/slugs`
- Snapshot/tick data: `https://bapi-v2.polywinbot.com/snapshot-ticks`
- Full synchronized L2: `https://bapi-v2-ob.polywinbot.com/orderbooks`

The snapshots provide the market opening reference, final reference, winner, Binance
aggregate price, Chainlink price, and outcome best asks. Full L2 provides compact
approximately 50-ms synchronized frames with aggregate depth.

The supplied safe data cutoffs were:

- Chainlink 60-second TWAP complete from Unix `1786923600`;
- authoritative native full L2 from Unix `1787388900`;
- imported older L2 cutoff Unix `1786665600`.

The studied August 29 sample is after those cutoffs. Every signal comparison used a
**causal as-of join**: the most recent tick/frame with `capturedAtMs <= fill decision
time`. Future ticks were never joined backward into an earlier decision.

The synchronized subset contained **111** usable markets and **105** non-tied first
acquisitions.

### 3.3 Polygon V2 transaction decoding

For first-entry trades, transaction input was fetched from Polygon and decoded using
the official V2 Exchange `matchOrders` ABI. The signed order contains:

`salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side`,
`signatureType`, `timestamp`, `metadata`, `builder`, and `signature`.

`matchOrders` identifies one taker order and one or more maker orders, their fill
amounts, and maker/taker fees. This made role classification exact for the decoded
sample and supersedes any role label inferred solely from trade price versus midpoint.

All **164** selected first-entry fill rows across **119** markets decoded successfully.

### 3.4 Risk sample

The intraround risk analysis used **123 complete resolved markets**. It excluded a
truncated market at the oldest activity boundary and any latest market not fully
observable through settlement. This is why its denominator differs from the broad
125-resolved-market summary.

## 4. Binary-market accounting

The observed strategy is buy-only in the studied fills: it does not show a
conventional sell-based stop, futures hedge, or external BTC hedge. This report uses
**pair completion** for buying the opposite Polymarket outcome. Economically that
purchase reduces outcome exposure, but operationally it is part of the same pair-
accumulation strategy, consistent with the user's terminology that the bot “does not
hedge.”

Let:

- `qU`, `qD` = final UP and DOWN shares;
- `CU`, `CD` = cost paid for UP and DOWN;
- `C = CU + CD` = total cost before fees;
- `aU = CU/qU`, `aD = CD/qD` = average prices, when quantities are nonzero.

At settlement:

```text
PnL if UP wins   = qU - C
PnL if DOWN wins = qD - C
Worst-case PnL   = min(qU, qD) - C
```

Fees must be subtracted and rebates added for net PnL.

The paired and directional decomposition is:

```text
paired quantity      m = min(qU, qD)
directional residual d = qU - qD
```

The `m` matched pairs pay exactly `$m` at resolution regardless of the winner. The
sign and payout of `d` depend on the winner. This is the cleanest way to understand
the target wallet.

For equal quantities, `aU + aD < 1` means the matched pair has gross locked profit.
For unequal quantities, however, the sum of the two global averages is not sufficient
to determine risk or PnL. The authoritative quantities are `qU - C` and `qD - C`.

This also explains why a round can be profitable even when `aU + aD >= 1`: if the
larger inventory side wins and its share count exceeds total cost, the directional
remainder more than offsets the expensive pairs.

## 5. What the aggregate behavior proves

### 5.1 Pair accumulation is real, but not complete arbitrage

In the broad 126-market sample:

- `aU + aD < 1` in **90/126 markets (71.4%)**;
- mean average-price sum **0.9399**;
- median **0.9453**;
- minimum **0.6531**;
- maximum **1.1679**.

For the 125 resolved markets:

- gross spend: **$60,147.39**;
- gross realized PnL: **+$2,152.94**;
- paired component: **+$2,846.76**;
- residual directional component: **−$693.82**.

Therefore, “accumulate undervalued tokens to form pairs” captures the central
economic engine, but “always lock arbitrage” does not. The strategy permits
meaningful unpaired exposure and sometimes ends with a negative worst-case payout.

### 5.2 It is not accurately predicting every five-minute winner

- First acquired side matched the final winner in **52.5%** of the broad 118-entry
  sample and **54.3%** in the 105-market synchronized BAPI subset.
- The final majority-inventory side matched the winner only **40.8%** of resolved
  markets in the broad sample.

Those values are inconsistent with a bot whose primary edge is simply picking the
final winner. They are consistent with a bot selecting which leg is temporarily
cheap/fast-moving, then managing the complementary leg and residual inventory later.

### 5.3 The apparent “below-market” entry has two explanations

In the BAPI subset, the first fill averaged **2.77 cents below the contemporaneous
token midpoint**. Price-only classification found 81% of first fills compatible with
the observed bid and 19% with the observed ask. That does **not** mean 81% were makers.

Exact on-chain decoding found:

| First-entry metric | Result |
|---|---:|
| Fill rows | 164 |
| Taker rows | 98 (59.8%) |
| Maker rows | 66 (40.2%) |
| Taker-filled shares | 3,741.20 |
| Maker-filled shares | 1,232.06 |
| Taker share of decoded first-entry volume | 75.2% |
| Decoded taker fees | $60.82 |

A fill can look cheap relative to a later or coarsely aligned midpoint and still have
been the taker against stale asks. The exact role data therefore replaces the earlier
“mostly maker” interpretation.

## 6. Reconstructed signal

### 6.1 Initial block-time signal agreements

For 105 non-tied first acquisitions, the initial as-of join produced:

| Comparison | First side agreement |
|---|---:|
| Official eventual winner | 54.3% |
| Current Chainlink displacement from open | 44.8% |
| Current Binance displacement from open | 61.0% |
| Chainlink prior-5s momentum | 45.7% |
| Binance prior-5s momentum | **66.7%** |
| Binance-minus-Chainlink relative return lead | **63.8%** |
| CLOB-implied side | 56.2% |

When the first side followed the relative lead, that side eventually won **58.2%**
of markets (`n=67`). When it opposed the relative lead, it won **47.4%** (`n=38`).
This conditional difference is suggestive but is not a clean causal estimate because
the wallet chooses whether and when to enter. More importantly, these were causal
relative to the **public block timestamp**, not the earlier off-chain match. The fresh
depth-drop audit in Section 1.1 supersedes this table for source attribution. It
retains value as a description of the market state around on-chain settlement.

### 6.2 Most likely information chain

The best-supported information flow is:

```text
Binance spot/aggregate trades move
              ↓
sub-second Binance momentum becomes nonzero
              ↓
Polymarket CLOB and Chainlink TWAP have not fully incorporated the move
              ↓
bot chooses the corresponding pre-signed outcome/price rung
              ↓
marketable part takes stale liquidity; remainder may rest
              ↓
later fills add the complement or reinforce the residual position
```

Because settlement is based on the specified Chainlink reference, Binance is useful
as a fast price-discovery feed, while Chainlink is the relevant anchor. Relative lead
and distance-to-open remain plausible confirmation/fair-value features, but the
strictly pre-fill sample did not reproduce relative lead as the strongest first-side
classifier.

### 6.3 Candidate feature definitions

A reasonable reconstruction uses log returns:

```text
momentum_fast(t) = log(B(t) / B(t-delta)), delta approximately 0.25-1.0s

binance_displacement(t) = log(B(t) / B(open))
chainlink_displacement(t) = log(C(t) / C(open))

relative_lead(t)
    = binance_displacement(t) - chainlink_displacement(t)
```

where `B` is Binance and `C` is Chainlink TWAP. Useful control features include:

- distance of Chainlink from the official opening/price-to-beat reference;
- time remaining;
- short realized volatility;
- current UP/DOWN midpoint or microprice;
- spread and depth imbalance;
- recent CLOB velocity;
- current inventory imbalance;
- order-book staleness and estimated fill probability.

One practical probability model is:

```text
P(UP | x) = sigmoid(
    beta0
  + beta1 * z(momentum_fast)
  + beta2 * z(relative_lead)
  + beta3 * z(chainlink_distance_to_open)
  + beta4 * z(CLOB_microprice_signal)
  + beta5 * z(volatility)
  + beta6 * time_controls
)
```

The corrected timing evidence makes `beta1` the best-supported directional term.
`beta2` remains economically sensible but is not reliably identified in the clean
pre-fill subset. None of the tests reveal the target's exact coefficients,
nonlinearities, or thresholds.

### 6.4 How the weights should be estimated

Weights should not be assigned in proportion to standalone agreement rates because
momentum, displacement, relative lead, and CLOB movement are correlated. The correct
workflow is:

1. Build one causal feature row immediately before each first order/fill. Include
   rounds in which the wallet did not trade if entry/no-entry is also being modeled.
2. Standardize continuous features using statistics learned only from the training
   period.
3. Fit an L2-regularized logistic model for first side, or a two-stage model:
   `P(entry | state)` followed by `P(side | entry,state)`.
4. Use chronological walk-forward folds, never random cross-validation across time.
5. Select the penalty and probability threshold using out-of-sample log loss or
   Brier score, then calibrate probabilities.
6. Run feature ablations and block-bootstrap confidence intervals by market/day.
7. For actual trading, tune the final policy on net PnL after taker fees, rebates,
   spread, adverse selection, partial fills, and inventory risk—not classification
   accuracy alone.

To reconstruct the wallet rather than merely predict first side, the target variable
should eventually be its chosen signed rung, limit price, and 50/150 size. Public
fills are selection-biased: unfilled and canceled orders are absent. Exact private
weights cannot be identified without historical order submissions/cancellations or a
reliable full-order-state archive.

## 7. Pre-signing and latency architecture

### 7.1 Exact observations

From 164 decoded first-entry fill rows:

- **149/164 (90.9%)** were signed before market open;
- median pre-open signing lead: **89,776 ms**;
- p10: **89,546 ms**;
- p90: **89,929 ms**;
- median signed-order age at the recorded block: **99,690 ms**;
- p10 age at block: **93,613 ms**;
- p90 age at block: **122,816 ms**.

The tight cluster near T−90 seconds is too regular to be a human workflow. It strongly
supports scheduled preparation for the next five-minute market while the current one
is still active.

The block-age statistic is **not execution latency**. The signed timestamp records
order creation; the activity/block time records on-chain settlement after matching.
Neither exposes the exact time the order reached the CLOB.

### 7.2 Reconstructed critical path

```text
about T-90s: discover next market and token IDs
             construct/sign a ladder of candidate orders

after T+0:   observe Binance, Chainlink, and CLOB
             calculate side, fair value, and economic limit
             select an already-signed 50- or 150-share rung
             submit immediately
             cancel/reuse/replace residual intent as state changes
```

Pre-signing removes key construction and EIP-712 signing from the post-signal path.
It does not by itself establish CLOB queue position; submission time still matters.

## 8. Maker, taker, `postOnly`, and queue priority

### 8.1 Exact role findings

The first-entry fills were hybrid:

- 59.8% of rows were exact taker matches;
- 40.2% were exact maker matches;
- taker executions represented 75.2% of filled first-entry shares;
- 124 unique signed orders produced the 164 rows;
- 24 signed-order groups filled more than once;
- 16 exact signed orders were observed in both maker and taker roles.

This last fact is highly consistent with a limit order that can cross and later rest,
or with the same signed payload being resubmitted in different matching contexts.

### 8.2 Is `postOnly=false` valid?

**Strong inference, not directly provable.** A post-only order is rejected if it
would immediately cross. The wallet's first-entry volume is predominantly taker and
some exact signed orders later appear as maker. That is consistent with `postOnly`
being false or omitted for those submissions, probably with GTC-like residual
behavior.

However:

- `postOnly` is an API request flag, not part of the signed order;
- `orderType` is also not in the on-chain signed struct;
- historical API request bodies are unavailable.

The defensible statement is therefore: **the wallet's behavior requires orders that
are allowed to take liquidity; it does not prove the literal historical flag value
for every submission.**

### 8.3 Cross-and-rest explains apparent priority

Suppose the book is:

```text
best bid 0.62
best ask 0.65 for 30 shares
```

and the bot submits a non-post-only 50-share buy limit at 0.66. It can:

1. take the 30 shares at 0.65 (or receive price improvement according to matching
   rules);
2. leave 20 shares resting at 0.66 if the order remains live;
3. become the best bid and the first order at the newly created 0.66 price level.

That creates effective priority by **paying a better price**, not by jumping ahead of
older orders at 0.62 or older orders already at 0.66.

### 8.4 Assessment of the “always ahead in queue” hypothesis

| Claim | Assessment |
|---|---|
| The bot prepares faster than a bot that signs only after the signal | **Strongly supported** |
| It frequently takes stale liquidity before slower competitors | **Supported by exact taker roles and signal alignment** |
| A residual limit may establish a new best price level | **Strong inference** |
| It actively cancels/reprices to maintain an aggressive quote | **Plausible but unverified without order-event history** |
| It is always first at an already-existing identical price | **Not demonstrated** |
| It receives privileged FIFO treatment | **No evidence** |

BAPI full L2 is aggregated by price. It lacks order IDs, arrival timestamps, cancels,
and same-price queue ranks. Signed order time is preparation time, not CLOB arrival.
On-chain settlement time is later than matching. Consequently, literal FIFO priority
cannot be recovered from the present materials.

The refined hypothesis is:

> **The bot wins races through precomputation, rapid selection/submission, and
> aggressive price levels. It may often appear first because it creates or improves
> the best price, not because it defeats FIFO at the same price.**

### 8.5 Cancel cheap orders and remove expensive orders?

This is plausible in spirit but cannot be verified literally from Orbscan or the
public activity API. Orbscan's `#open` tab shows **open positions**, not open CLOB
orders. Filled transactions do not reveal canceled orders, and cancellation is an
off-chain CLOB action unless a separate order-event archive captured it.

There is evidence that the bot sometimes leaves or reuses residual intent:

- partially filled original orders are common;
- exact signed orders were observed filling repeatedly;
- some exact signed orders appeared in both taker and maker roles.

But the fresh path analysis does not support “current side average” as the sole
cancel threshold: only 47.0% of eligible later share volume filled below its side's
prior average. A better reconstruction is:

```text
currentEconomicCap(side)
    = min(signalFairValueCap,
          marginalPairCompletionCap when applicable,
          inventory/risk cap)

keep or re-submit bid if orderPrice <= currentEconomicCap
cancel/reprice if orderPrice > currentEconomicCap
```

The cap can rise or fall as Binance moves, opposite lots fill, and inventory changes.
Consequently, an order above the historical average can remain rational, while a
nominally cheap order below the average can be canceled after its signal expires.

## 9. How it likely chooses the order price

The order is best understood as an economic limit, not “market price minus a fixed
number of cents.” Let:

- `F_i` = model fair probability for leg `i`;
- `h` = minimum expected edge/adverse-selection buffer;
- `fee(p)` = expected taker fee at limit `p`;
- `q_i`, `q_j` = current quantities;
- `avg_j` = cost basis of the opposite inventory;
- `g` = desired gross pair profit.

Two caps matter.

### 9.1 Signal cap

```text
P_signal,i = F_i - h - feeReserve - inventoryPenalty_i
```

The inventory term lowers the cap for the already-overweight side and can raise
urgency for the underweight complement.

### 9.2 Pair-completion cap

For a new share that will match an existing opposite share:

```text
P_pair,i = 1 - oppositeLotPrice - g - feeReserve
```

Using lot-level opposite cost is better than using one global average because an
expensive opposite lot should not be hidden by a cheap one.

### 9.3 Final limit

```text
P_limit,i = floor_to_tick(min(P_signal,i, P_pair,i when pairing is intended))
```

If `P_limit >= bestAsk`, the order becomes marketable and takes available asks up to
the limit. If it is below the ask, it rests. If it takes only part of the requested
quantity and remains live, the residual can become maker liquidity.

At initial entry there may be no opposite lot, so the signal cap dominates. This is
why the first leg can be bought at a level that looks “under market”: the bot is
targeting stale liquidity or a fair-value discount and is willing to wait/rest if the
market does not meet its limit.

The exact tick offset, edge threshold, inventory penalty, and cancel/reprice rule
cannot be recovered from filled trades alone.

## 10. Initial entry size

### 10.1 Exact original sizes

The decoded signed orders reveal a simple fact that fill history obscures:

| Original signed order size | Count |
|---|---:|
| 50 shares | 118 |
| 150 shares | 46 |

There were no other original sizes in the 164 decoded first-entry rows. Median
original size was 50 shares.

Observed first acquisitions looked much more varied:

- p10 **5 shares**;
- p25 **17.37**;
- median **43**;
- p75 **50**;
- p90 **82.38**;
- mean **42.78**;
- median first-entry notional about **$17.50**.

The apparent odd sizes are mainly partial executions of 50- and 150-share parents.
Median decoded fill fraction was **0.297**, and only **40/164** decoded rows were full
fills.

### 10.2 Fixed shares, not fixed dollars

The observed first-entry share count had essentially zero correlation with token
price (`corr ≈ -0.009`). Together with the exact 50/150 modes, this rejects a simple
fixed-dollar sizing rule.

### 10.3 Likely template selector

The most plausible reconstruction is:

```text
if signal/edge is ordinary or depth is limited:
    select 50-share parent
if signal/edge is stronger and risk/depth allow:
    select 150-share parent
actual recorded shares = whatever portion fills
```

The choice likely depends on some combination of:

- signal strength or expected cents/share edge;
- visible executable depth up to the price cap;
- current paired/unpaired inventory;
- round and account exposure caps;
- adverse-selection risk and time remaining;
- whether the order is intended as an initial directional leg or complement.

The data proves the two templates, but not the threshold separating them.

## 11. Intraround position construction

### 11.1 Likely sequence

The round-level pattern is:

1. **Prepare (around T−90s).** Sign 50/150-share candidate orders for the upcoming
   market.
2. **Detect initial lead.** Compare fast Binance movement with Chainlink/open and
   CLOB state.
3. **Acquire the favored or underpriced leg.** Often use a marketable limit; sometimes
   rest as maker.
4. **Re-evaluate continuously.** Monitor the complementary price, the signal, and
   current inventory.
5. **Accumulate complements.** Buy the other leg where matched-pair economics or loss
   reduction justify it.
6. **Permit a directional remainder.** Do not force equal quantities if expected
   directional value is better than the hedge cost.
7. **Reduce activity before settlement.** In this sample, no public trades were
   observed in the final 30 seconds.

### 11.2 Why it uses both maker and taker

Taker execution is rational when:

```text
expected short-lived edge > spread + taker fee + adverse-selection buffer
```

Maker execution is rational when urgency is lower, pair completion can wait, or the
desired cap is below the ask. A single non-post-only limit architecture can support
both behaviors without separate strategy identities.

This hybrid is particularly useful in a five-minute market: the signal may decay in
seconds, but complementary accumulation may remain economical for minutes.

## 12. Risk management before the round ends

### 12.1 The wallet does not fully pair every round

In 123 complete resolved markets:

- gross realized PnL: **+$1,977.31**;
- aggregate sum of final per-market worst cases: **−$7,330.17**;
- guaranteed-profitable final positions: **25**;
- profitable only because the realized side won: **41**;
- realized losing markets: **57**.

Only 25/123 final positions were guaranteed profitable before resolution. This is
therefore an expected-value strategy under an inventory/risk limit, not pure
risk-free pair arbitrage.

There were **16** markets with `aU + aD >= 1` but positive realized PnL; in all
**16/16**, the winning outcome was the majority-inventory side. This directly
confirms the user's observation about asymmetric inventory rescuing an apparently
expensive pair book.

### 12.2 Marginal effect of buying one side

If the wallet buys `x` additional UP shares at price `p`, before fees:

```text
change in PnL if UP wins   = x(1-p)
change in PnL if DOWN wins = -xp
```

If UP is currently the minority side, the purchase matches existing DOWN exposure
until the quantities equalize. For that matched portion:

```text
change in worst-case PnL = x(1-p) > 0
```

This can improve the worst case even when the resulting historical average-price sum
is at or above 1. The relevant question is not “is the new global average pair below
1?” but “how much does this marginal complement reduce the loss on the currently
bad outcome?”

If UP is already the majority side, buying more UP changes worst case by `-xp`; it is
a directional risk increase and should require positive expected edge.

### 12.3 Activity by time bucket

| Seconds after open | Spend | Shares | Share flow that reduced imbalance | Aggregate change in worst-case PnL |
|---:|---:|---:|---:|---:|
| 0–60 | $15,457.96 | 32,749.5 | 32.9% | −$4,690.54 |
| 60–120 | $13,944.85 | 29,591.5 | 41.8% | −$1,585.22 |
| 120–180 | $12,428.77 | 26,812.4 | 45.9% | −$127.72 |
| 180–240 | $9,450.12 | 21,541.3 | 45.1% | **+$260.72** |
| 240–270 | $7,707.39 | 15,070.8 | 43.3% | −$1,187.41 |
| 270–300 | $0.00 | 0.0 | — | $0.00 |

Interpretation:

- The first minute creates the largest directional exposure.
- Pairing/rebalancing becomes more prominent in minutes 2–4.
- The 180–240 second bucket is the only one that improved aggregate worst-case PnL.
- The 240–270 second bucket is not a pure hedge phase; it combines pair completion
  with a fresh/final directional overlay.
- No observed trades in the final 30 seconds suggests a trading/cancellation cutoff,
  although this is based on one approximately 11-hour frozen sample and public
  timestamps are coarse.

### 12.4 Last active half-minute tactics

For trades from T+240 through T+269, shares were classified by their marginal
function:

| Tactic | Shares |
|---|---:|
| Cheap complement/pair completion (`p < 0.5`) | 4,367.4 |
| Expensive complement/loss cap (`p >= 0.5`) | 2,152.6 |
| Add favored directional inventory (`p >= 0.5`) | 5,398.4 |
| Add underdog directional inventory (`p < 0.5`) | 3,152.4 |

Last-minute trades occurred in **32** markets. Worst-case PnL improved in **14** and
worsened in **18**; ex-post realized PnL improved in **19**. Aggregate late changes
were **−$1,187.41** to worst-case PnL and **−$358.27** to ex-post realized PnL on
**$7,707.39** of spend.

This shows that late behavior is not simply “close every pair.” It still makes
directional bets when its estimate says the expected edge exceeds the additional
tail risk.

### 12.5 Likely risk objective

Let `pi` be the estimated probability of UP:

```text
Expected PnL = pi * (qU - C) + (1-pi) * (qD - C)
```

For `x` new UP shares at price `p`, the incremental expected value is:

```text
Delta EV = x * (pi - p) - fees - adverseSelectionCost
```

A plausible policy is:

```text
accept candidate only if:
    Delta EV > minimumEdge(time, role)
    and projected worstCasePnL >= -lossLimit(time)
    and abs(projected qU-qD) <= inventoryLimit(time)
    and spend/executable-depth constraints pass
```

The loss and inventory limits likely tighten with time. Complementary purchases can
be accepted even with low or negative standalone directional EV when they materially
improve worst-case PnL. Conversely, same-side additions require a stronger signal.

### 12.6 What risk controls are and are not visible

Supported controls:

- complementary buying instead of conventional selling;
- progressive pairing/rebalancing during minutes 2–4;
- discrete 50/150-share parent sizes;
- bounded rather than unlimited directional residual;
- a likely cutoff before the final 30 seconds;
- economic rejection when price exceeds signal/pair value.

Not directly observable:

- exact maximum loss per round;
- account-level collateral limits;
- live outstanding exposure from unfilled orders;
- canceled orders and cancel/replace frequency;
- whether the bot hedges BTC elsewhere;
- exact inventory or volatility thresholds.

## 13. End-to-end reconstructed algorithm

The following pseudocode is a research reconstruction, not recovered code:

```text
for each upcoming BTC 5m market:
    at about open_time - 90s:
        discover condition and UP/DOWN token IDs
        construct/sign 50-share and 150-share limit templates/rungs

    while current_time < open_time + cutoff:
        read latest causal Binance, Chainlink and CLOB state
        update filled UP/DOWN quantities and cost basis

        features = {
            binance_momentum_5s,
            binance_minus_chainlink_relative_lead,
            chainlink_distance_to_open,
            CLOB_mid/microprice/velocity,
            volatility,
            time_remaining,
            inventory_imbalance
        }

        fair_up = probability_model(features)
        fair_down = 1 - fair_up

        for each side:
            signal_cap = fair_side - edge_buffer - fee_reserve

            if buying this side matches opposite inventory:
                pair_cap = 1 - opposite_lot_cost - pair_profit_target - fee_reserve
                price_cap = min(signal_cap, pair_cap)
            else:
                price_cap = signal_cap - inventory_risk_penalty

            size_template = 150 if strong_edge_and_depth_and_risk_capacity else 50

        choose highest-value candidate:
            initial fast-information leg,
            economic complement,
            or justified same-side reinforcement

        if candidate passes EV, depth, inventory and worst-case limits:
            submit selected pre-signed limit with taking permitted
            immediate marketable quantity executes as taker
            possible remainder rests as maker

        cancel/reprice stale intent as signal, book and inventory change

    before settlement:
        cancel live orders
        retain confirmed inventory through resolution
```

## 14. Concrete decoded example

For market `btc-updown-5m-1788019200`, the wallet had two first-entry UP orders:

- 50 UP at limit **0.65**, signed at `1788019110143`—**89.857 seconds before open**;
  it was the exact taker and filled all 50 shares; decoded taker fee **$0.79625**.
- 50 UP at limit **0.66**, signed one millisecond later—**89.856 seconds before
  open**; it was the exact taker and filled 10 of 50 shares; decoded fee **$0.15708**.

Transactions:

- <https://polygonscan.com/tx/0xf47acb4d2dee4a69a4ef82c77cc114086308179a630b7c49cdef9c2dc85c51bb>
- <https://polygonscan.com/tx/0x969c8d7b135c751cb3ddfa304274e2ff216adcc3a34e6108fe43df0f6e90bd71>

This is a compact illustration of the architecture: pre-sign multiple adjacent price
rungs, submit after open, take available liquidity, and accept partial fill on a
larger intended parent.

## 15. Main conclusions by question

### Which signal does it use?

Most likely sub-second Binance momentum, conditioned on CLOB price/depth,
Chainlink/open distance, time, volatility, and inventory economics. A Binance-versus-
Chainlink lead remains a plausible fair-value feature, but it weakened after exact
pre-fill timing correction. The evidence does not identify a single EMA as the
primary source. The signal is better interpreted as a short-term stale-price/entry
signal than as a standalone settlement predictor.

### How should signal weights be determined?

Use standardized causal features, regularized logistic or nonlinear models,
chronological walk-forward validation, calibration, ablation, and a final objective
of net execution PnL. Agreement percentages alone cannot identify weights.

### How does it place orders?

It uses both roles. Exact first-entry volume was 75.2% taker and 24.8% maker. Behavior
is consistent with non-post-only, likely persistent limit orders that can take and
then rest. The signed order does not expose the historical API `postOnly` or
`orderType` fields.

### How does it choose the limit?

Likely by the lower of a signal/fair-value cap and, when matching existing inventory,
a pair-completion cap, after fees and risk buffers. The limit may cross stale asks or
rest below them.

### How is the initial share count chosen?

Original parents are discretized to exactly 50 or 150 shares in the decoded sample.
Odd public fill sizes are partial fills. The 150-share template likely requires
stronger edge, sufficient depth, and risk capacity; its exact trigger is unknown.

### Does it always obtain queue priority?

No such conclusion is supported. It likely gains effective priority through
pre-signing, fast submission, taking stale liquidity, and sometimes establishing a
new better price. Same-price FIFO rank is not present in the available data.

### How does it manage end-of-round risk?

It buys complements to improve the bad-outcome payout, but it does not force every
round into guaranteed profit. It retains a residual directional position when model
edge is judged sufficient, uses discrete size/risk capacity, becomes more pair-focused
through minutes 2–4, may add a final directional overlay through T+269, and appears to
stop trading for the last 30 seconds in this sample.

## 16. Limitations and next tests

The most important unresolved evidence is the off-chain order-event stream. A stronger
replication or attribution study should collect, from T−100 through resolution:

- every order submission acknowledgement and client/order ID;
- `postOnly`, order type, limit, original size, and expiration;
- every cancel/replace event;
- every fill with sub-second exchange time and exact role;
- full L2 frames with sequence numbers;
- Binance trade/aggTrade data and the exact Chainlink/RTDS stream;
- account inventory after each event.

Then test:

1. Whether 50 versus 150 is a threshold on predicted cents/share edge.
2. Whether first submit latency following a Binance move is consistently lower than
   competitors' book changes.
3. Whether unfilled remainders actually rest after taker fills.
4. Whether cancels maintain top price or merely enforce an economic cap.
5. Whether complement orders use FIFO lot cost, average opposite cost, or a blended
   risk objective.
6. Whether the apparent final-30-second cutoff persists across weeks and regimes.
7. Net profitability after exact taker fees and maker rebates.

Any backtest must simulate queueing and partial fills. Assuming every touched limit is
fully filled would materially overstate this strategy: the observed median first-order
fill fraction was only 29.7%.

## 17. Reproducibility files

The workspace contains the analysis scripts used for this reconstruction:

- `analyze_wallet.ps1` — broad wallet-position, entry, paired/residual PnL analysis;
- `analyze_wallet_bapi.ps1` — causal BAPI signal and contemporaneous-price joins;
- `analyze_wallet_v2_orders.py` — exact V2 signed-order, maker/taker, size, timestamp,
  and fee decoding;
- `analyze_wallet_risk.py` — intraround inventory and marginal risk analysis.
- `research_wallet_fresh.py` — rolling latest-sample FIFO pair economics, settlement
  decomposition, and exploratory EMA sensitivity;
- `analyze_wallet_prefill_signal.py` — exact-taker L2 depth-drop alignment and
  strictly pre-fill Binance/Chainlink/CLOB signal tests.

The supplied external BAPI guide is:

- `C:\Users\Polestar\.codex\attachments\c7f2e0bb-c3ba-4650-82b9-c16d12514676\pasted-text.txt`

## 18. Primary technical references

- [Orbscan wallet profile and aggregate statistics](https://orbscan.com/profile/0x3048d65321be3497164cdfc2996f94f98a2e7537)
- [Polymarket user activity API](https://docs.polymarket.com/api-reference/core/get-user-activity)
- [Polymarket market-making overview](https://docs.polymarket.com/trading/market-making)
- [Polymarket order lifecycle and maker/taker semantics](https://docs.polymarket.com/concepts/order-lifecycle)
- [Polymarket L2 client methods](https://docs.polymarket.com/trading/clients/l2)
- [Polymarket post-order endpoint](https://docs.polymarket.com/api-reference/trade/post-a-new-order)
- [Polymarket trading fees](https://docs.polymarket.com/trading/fees)
- [Polymarket maker rebates](https://docs.polymarket.com/market-makers/maker-rebates)
- [Official CTF Exchange V2 repository](https://github.com/Polymarket/ctf-exchange-v2)
- [Official V2 signed-order struct](https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/libraries/Structs.sol)
- [Example BTC five-minute market rules](https://polymarket.com/event/btc-updown-5m-1785779100)
- [Polymarket Chainlink TWAP feed documentation](https://docs.polymarket.com/market-data/chainlink-twap)
- [Binance Spot REST market-data documentation](https://developers.binance.com/en/docs/binance-spot-api-docs/rest-api/market-data-endpoints)

---

**Bottom line:** the observable edge is best modeled as *latency-aware inventory
acquisition*. The bot detects fast Binance information before it is fully reflected in
Chainlink/CLOB prices, uses pre-signed 50/150-share limit orders to capture that edge,
then monetizes part of the position through complementary purchases while allowing a
bounded directional remainder. Its advantage is the combination of signal, prepared
execution, price discipline, partial-fill handling, and risk-aware inventory—not one
secret predictor or guaranteed queue privilege.
