# Wallet3048: proposed inventory optimization specification

Reviewed and refined: **September 10, 2026**.

**Status: proposed design, not the implemented strategy.** This review refines the supplied continuous-inventory text and [inventory-sizing PDF](BTC_5M_Inventory_Sizing_Analysis.pdf). The implementation comparison uses repository commit `ff914256184c6f3a873a58e611b3aa1e863939c6`. The [current algorithm document](WALLET3048_STRATEGY_ALGORITHM.md) remains the description of v5.

The controller chooses purchases by their effect on the complete round's two settlement payoffs. It derives quantities, acquisition ceilings and execution sequence together. There is **no preset per-round spending allocation, fixed holdings ratio, or 50/150-share sizing template** in this proposed formulation. Expenditure is an output; actual executable opportunities and the selected payoff objectives constrain quantities.

The accounting equations in the supplied text are consistent under their stated assumptions. They do not, by themselves, select optimal targets or establish profitability. The principal refinement is to distinguish **future payoff targets**, **payoff floors that apply before completion**, and **the initial exposed position**.

## 1. Review findings and required clarifications

| Finding | Refined requirement |
|---|---|
| Exact sizing and predictive optimization are different problems. | Keep a deterministic accounting/feasibility calculation separate from the model used to rank uncertain plans. |
| A zero common-payoff floor would prevent the first ordinary purchase. | Define entry exposure separately from preservation of profit already acquired. A future hedge cannot justify claiming that an entry is currently protected. |
| Final targets do not establish a safe execution sequence. | Check each independently possible partial fill and pending-order combination against the applicable intermediate floors. |
| The initially favored side is fixed in this text. | Preserve that identity after the first confirmed entry. A changing forecast changes its probability, not its name. A policy that switches the favored side would be a separate variant. |
| Strict average reduction is a substantive constraint. | Apply it consistently to later buys, including rising-price taker orders. The first fill on an empty side establishes its average. |
| Penalizing negative P&L does not directly enforce average win greater than average loss. | Treat the loss weight as an objective preference. Measure the realized payoff ratio and positive/negative round frequencies separately. |
| Maker execution is central to the proposed workflow. | Model post-only arrival rejection, queue/flow uncertainty and partial fills. The existing strict-no-maker studies cannot validate this policy's maker contribution. |
| The 51.48% figure has a recoverable denominator in this workspace. | Label it as target-wallet first-observed-buy accuracy: 2,279/4,427. It is a different cohort from the current bot's 453/860 replay result. |

## 2. State and exact accounting

Before any entry, retain a tentative signal side. Set the immutable favored side `F` from the first positive confirmed entry fill; `O` is its opposite. Do not authorize an opposing leg using an unfilled entry as share backing. An unfilled entry that is canceled does not establish first-entry accuracy.

For confirmed holdings:

```text
N_F, N_O = net credited shares on the favored and opposing outcomes
C_F, C_O = acquisition costs allocated to each side, including execution fees
C_other  = any additional round costs not allocated to either side
C        = C_F + C_O + C_other
A_F      = C_F / N_F, defined only when N_F > 0
A_O      = C_O / N_O, defined only when N_O > 0

P_F      = N_F - C
P_O      = N_O - C
Delta    = N_F - N_O
H        = min(P_F, P_O)
```

Use unrounded ledger values. Track raw token-price averages separately if needed for display. Count a fee once, in cost or its equivalent net-share adjustment according to the actual ledger, without double charging it. The formulas here describe BUY-only holdings carried to settlement; sales, merges and rebates would require an explicit extension of the cash-flow ledger.

While `Delta > 0`:

```text
H = P_O
P_F = H + Delta
P_O = H
```

For that fixed inventory, with no more trading and favored-outcome probability `p`:

```text
Expected P&L = H + p * Delta
Variance     = p * (1-p) * Delta^2
```

Positive settlement P&L under both outcomes requires `C < min(N_F, N_O)`.

When all costs are allocated to sides, `N_O > 0`, `A_F > 0`, and favored dominance holds, this is equivalent to:

```text
r = N_F / N_O
r * A_F + A_O < 1
r < (1 - A_O) / A_F
```

If `C_other` is separate, include `C_other / N_O` on the left. Do not use the simplified ratio condition with incomplete cost averages. The boundary is a feasibility consequence, not a recommended fixed ratio.

## 3. Entry, accumulation, protection and close

The following phases describe current confirmed inventory; they do not presume successful future fills.

| Phase | Controller behavior |
|---|---|
| Flat | Evaluate the initial signal, possible first quantities and their exposed payoffs. Waiting is admissible. There is no existing side average or positive common payoff to preserve. |
| Exposed accumulation: `H < 0` | Evaluate reinforcement and opposing purchases using the complete payoff distribution, including failure to complete the plan. Apply any explicitly selected intermediate payoff floors. |
| Nonnegative inventory: `H >= 0` | Both settlement outcomes are nonnegative. A preservation policy may protect a selected part of this achieved common payoff; further directional buying consumes that room. |
| Execution cutoff | Stop new executions under the configured cutoff, cancel remaining orders and reconcile outstanding fills. Record settlement only when the final outcome is known. |

**Entry example:** buying 10 favored shares at all-in cost $0.50 from an empty position gives `P_F = +$5`, `P_O = -$5`. Requiring both payoffs to remain at least zero would reject it. Ordinary sequential entry therefore requires accepting an exposed position under the chosen objective, or waiting; the profitable staged example in the PDF does not solve this entry decision.

Use two distinct sets of quantities:

- `G_F, G_O`: targets for a selected future inventory point, conditional on the proposed fills.
- `L_F, L_O`: optional floors required at every intermediate confirmed or independently possible pending-fill state.

Do not apply the final positive targets as if they were already achieved. Do not silently introduce a fixed negative dollar floor, a zero floor from entry, or a fixed spending allocation. The loss-weighted objective in section 6 can rank entry exposure without imposing such a floor.

Once common profit exists, full preservation would set `L_F = L_O = H_locked`. If full preservation is selected, `H_locked` cannot be lowered merely to admit a new order. A different policy may deliberately surrender some common profit, but that policy and the resulting trade-off must be recorded. Full preservation from an exactly balanced position can make every unilateral positive-cost purchase infeasible; waiting is then a valid result even if a hypothetical simultaneous pair looks profitable.

## 4. Deterministic acquisition and sizing equations

Let `K_F(x)` and `K_O(y)` be the all-in costs for **actual quantities acquired**. For an order that might fill partially, use the cost of each possible partial quantity, not the full parent order's forecast VWAP.

```text
Favored-only purchase:
    P_F' = P_F + x - K_F(x)
    P_O' = P_O     - K_F(x)

Opposing-only purchase:
    P_F' = P_F     - K_O(y)
    P_O' = P_O + y - K_O(y)

Joint purchase, K = K_F(x) + K_O(y):
    P_F' = P_F + x - K
    P_O' = P_O + y - K
    Delta' = Delta + x - y
```

### 4.1 Average reduction

For an existing side with `N > 0` and fee-inclusive average `A`, acquiring `q > 0` at constant all-in cost `a` gives:

```text
A' = (N*A + q*a) / (N+q)
A' < A exactly when a < A
q_to_target = N*(A-A_target) / (A_target-a)
```

The target formula applies when `a < A_target < A`. If the current average already satisfies an upper target, no purchase is needed to reach that target. If the target is below the current average but `a >= A_target`, no finite positive purchase reaches it. An empty side's average is undefined until its first fill.

For depth-dependent costs, average reduction requires `K(q) < q*A`. If every independently possible execution must reduce the contemporaneous average, enforce this from the then-confirmed state after each fill. A favorable full-order VWAP cannot excuse an expensive prefix or a pending remainder that would increase the average after another cheaper order fills first.

Lower average cost is an inventory objective, not evidence of positive marginal expected P&L. Retaining strict average reduction can exclude otherwise positive-EV reinforcement after prices rise; that is an explicit consequence of this specification.

### 4.2 A single-side target and an opposing floor

For a favored buy at constant all-in cost `0 < a < 1`:

```text
x_min = max(0, (G_F - P_F)/(1-a), applicable average-target minimum)
x_max = (P_O - L_O)/a
```

The candidate is infeasible if `x_max < 0` or `x_min > x_max`. If the opposing requirement is a same-step target rather than an intermediate floor, substitute `G_O` for `L_O`.

For an opposing buy, swap the payoff roles and also enforce favored dominance. With no other pending orders this requires `y < Delta`. Apply venue quantity precision to implement strict dominance; do not round a permitted quantity up to equality. Pending opposing remainders also consume the available dominance room.

### 4.3 Joint targets expressed as common payoff and DIFF

Choose a candidate future `H_target` and positive `Delta_target`:

```text
G_O = H_target
G_F = H_target + Delta_target
h   = H_target - P_O
d   = Delta_target - Delta

y = (h + a*d) / (1-a-b)
x = y + d
```

These inverse equations use constant all-in candidate prices `a, b`. Require nonnegative quantities, valid precision, executable opportunities and an admissible sequence. For positive improvements in both payoffs, such a BUY-only plan requires `a+b < 1`.

At `a+b = 1`, do not divide by zero: the target system may be incompatible or have multiple solutions. For `a+b > 1`, buying cannot improve both payoffs at once, though a one-sided trade-off can still be evaluated. Near one, very large calculated quantities must be checked against actual opportunities; they are not authority to assume unlimited fills.

When exact targets require negative quantities, consider the target **inequalities** if overachievement is permitted. For arbitrary depth-dependent costs the joint target condition is:

```text
K_F(x) + K_O(y) <= min(P_F + x - G_F, P_O + y - G_O)
```

The inverse solution is a way to calculate or verify quantities. It does not select the best targets independently of the objective and forecasts.

## 5. Sequence and pending-order feasibility

A plan may submit only a currently admissible next leg. Opposing buys cannot borrow dominance from unfilled favored orders, and favored buys cannot borrow payoff room from a projected opposing fill.

To prepare for a favored buy `x` at cost `a`, preliminary opposing shares `z` at cost `b` must satisfy, when preserving common floor `H_0`:

```text
z >= max(0, (a*x - (P_O-H_0))/(1-b))
z < Delta
b*z <= P_F-H_0
```

This is only the local preparation calculation. Every later leg and its partial fills must also pass.

Retain pending exposure until a terminal order status and associated fills have been reconciled. Requesting cancellation does not immediately free its reservation. Before authorizing another order, consider independently possible fills/no fills and execution order for all pending remainders and the proposed order.

For constant-cost affine payoff constraints, extrema over independent fill intervals occur at interval endpoints. Endpoint enumeration can therefore prove those particular constraints. With price levels, fee rounding, changing averages or sequence-dependent costs, use the relevant execution prefixes and breakpoints, or a justified conservative bound. Do not assume that final full-fill and no-fill positions cover every constraint automatically.

Reserve exposure for feasibility, but value realized inventory only from confirmed fills. Reconcile first, then re-solve. Cancel or reduce a stale remainder through the order lifecycle; do not submit the original full quantity again after a partial fill.

## 6. Objective, target choice and finite quantities

One explicit selectable preference from the supplied text is:

```text
psi(z) = z - lambda * max(-z, 0), lambda >= 0
J(plan | state) = E[psi(actual terminal round P&L) | current information, plan]
```

Compare feasible plans with waiting, including the future exposure of already pending orders. A proposed change should improve the selected score relative to that alternative. `lambda` is a preference about loss versus return; it is neither a spending allocation nor an empirically discovered universal constant.

For certain immediate fills and a fixed calibrated favored probability `p`, away from payoff-zero crossings:

```text
w_F = p     * (1 + lambda * indicator(P_F < 0))
w_O = (1-p) * (1 + lambda * indicator(P_O < 0))

dJ/dx = w_F - (w_F+w_O)*a
dJ/dy = w_O - (w_F+w_O)*b
```

When `w_F+w_O > 0`, positive local marginal score requires:

```text
a < w_F/(w_F+w_O)
b < w_O/(w_F+w_O)
```

At `lambda = 0`, these reduce to `a < p` and `b < 1-p`. If both weights are zero, the ratio shortcut is undefined; compare candidate scores directly. At payoff zero, evaluate the score on each side of the crossing rather than reusing the previous weights.

These ceilings must intersect the average constraint, intermediate floors, dominance, valid quote prices and execution feasibility. A repair can improve the loss-weighted score while sacrificing expected dollar P&L relative to the current position. Record both effects; do not relabel a risk preference as a pricing edge.

Select quantities through actual depth or explicit modeled fill opportunities. Relevant candidate boundaries include price-level changes, payoff-zero crossings, dominance/floor boundaries, selected average targets and venue quantity increments. A certain-fill marginal calculation cannot rank an uncertain maker or multi-leg plan without its execution distribution.

`H_target` and `Delta_target` may be outputs of the winning feasible plan. There are no fixed production values of `$100/$70`, `1.2`, or `lambda=1` established by the examples. Additional favorable opportunity may support higher targets. Unlimited persistent positive-margin liquidity would make profit unbounded; finite actual opportunities must not be replaced by an invented universal optimal size.

## 7. Forecast and execution model

Track two different horizons: time remaining until the contract's outcome reference is determined, and time remaining for a new order to execute. For comparison with v5, its execution cutoff is t+298 seconds with 520 ms modeled latency; that is earlier than the end of the five-minute round. Later official resolution is another event.

A state-dependent model should use point-in-time reference gap, uncertainty, Binance features, both token books, token and gap changes, timestamps, inventory and pending orders. The fixed initial label means `p_F = p_UP` for an UP entry and `p_F = 1-p_UP` for a DOWN entry, even if `p_F` later falls below one half.

The supplied Gaussian expression is a candidate baseline only:

```text
p_UP = Phi((gap + drift*tau)/(volatility*sqrt(tau)))
```

It assumes a particular conditional terminal reference-change distribution. Match the actual contract's reference, averaging window and tie rule; handle zero remaining time and invalid/zero volatility separately. Polymarket distinguishes Chainlink observation timestamps from RTDS publication timestamps. Its custom TWAP must not be replaced by an assumed reconstruction. [Chainlink TWAP documentation](https://docs.polymarket.com/market-data/chainlink-twap).

For an adaptive plan, evaluate the joint distribution of:

- Terminal outcome and reference path.
- Arrival prices and executable depth.
- Maker fill quantities, timing and adverse selection.
- Cancellation races and post-only rejection.
- Leg sequence, completion before cutoff and terminal inventory when completion fails.

Do not multiply independent cheap-UP and cheap-DOWN hit probabilities. Do not calculate adaptive expected P&L as `E[N_F]*p + E[N_O]*(1-p) - E[C]` unless the required independence is justified. Instead evaluate `E[N_F*Y + N_O*(1-Y) - C]` on the joint paths. Here `Y` indicates that the fixed favored outcome wins.

Future simulated decisions must use only information observed by that time. Scenarios with the same observed history must take the same action. A rolling forecast submits only its first admissible action and recomputes after observations arrive.

Fixed initial-side dominance remains a hard policy in this draft. On a forecast reversal, the controller can wait or make permitted opposing purchases while preserving that dominance. Switching the label to authorize a reversed position would change the specification and its evaluation.

## 8. Maker and taker placement

| Condition from the supplied policy | Eligible order |
|---|---|
| Favored token rises and entry/directional signal passes | A bounded marketable BUY limit, subject to all economic and inventory constraints. |
| Favored token falls | A post-only maker BUY at current best ask minus the current tick, if admissible. |
| Opposing token falls | The same maker rule, with opposing-side constraints. |
| No eligible beneficial action | Wait. |

For the initial entry, use the tentative signal side until its first fill. The exact definitions of rises/falls and the entry gate must be frozen before evaluation. Retaining v5's Binance/CLOB entry gate is a possible comparison variant; it is not evidence that its heuristic probability score is calibrated.

Under the exact maker rule, if `bestAsk - tick` exceeds the economic ceiling or is outside valid prices, wait. Do not silently substitute a deeper standing bid. If post-only would cross on arrival, the venue rejects it; model that rejection instead of recording a taker fill. Post-only applies with GTC/GTD order types. Current tick size and minimum order size come from the market. [Order placement](https://docs.polymarket.com/trading/place-orders).

For taker candidates, use level-dependent all-in costs and a bounded limit. The lifetime of an unfilled remainder must be explicit. An immediate-cancel remainder policy such as FAK is one candidate; keeping it as GTC introduces a separate resting exposure and must be modeled accordingly. This choice remains to be frozen for implementation.

The currently documented crypto formula is `quantity * 0.07 * price * (1-price)`, with market-specific parameters and rounding; maker trading fees are zero. Read the actual applicable parameters rather than treating the category example as a permanent constant. [Fees](https://docs.polymarket.com/trading/fees).

Visible quote touch is not a maker fill. A maker parent's quantity must have a supported fill model; visible bid depth is not proof that an equal-sized buy can execute. Repeated internal evaluations must not reuse the same external liquidity or trade-flow evidence.

The existing `strict-no-maker` policy remains useful as a no-resting-fill sensitivity case. It cannot establish the expected maker contribution of this proposal, and it is not necessarily a lower bound on whole-strategy P&L because missing fills also change future decisions and exposure.

## 9. Checked examples

The supplied profitable-position example uses rounded quantities and displayed total cost:

```text
N_F = 652.2, N_O = 628.3, C = 580.05
P_F = 72.15, P_O = 48.25, Delta = 23.9
H_target = 70, Delta_target = 30
a = 0.30, b = 0.20
```

The inverse solution is `x = 53.26`, `y = 47.16`, adding `$25.41` of cost and reaching `P_F = $100`, `P_O = $70`.

| Confirmed purchase | Favored shares | Opposing shares | Favored P&L | Opposing P&L |
|---|---:|---:|---:|---:|
| Initial | 652.20 | 628.30 | $72.150 | $48.250 |
| 20 opposing at $0.20 | 652.20 | 648.30 | $68.150 | $64.250 |
| 53.26 favored at $0.30 | 705.46 | 648.30 | $105.432 | $48.272 |
| 27.16 opposing at $0.20 | 705.46 | 675.46 | $100.000 | $70.000 |

Conditional on those staged prices and sequential fills, the minimum common payoff is `$48.25` and the minimum favored share advantage is `3.9`. Each constant-price leg has affine payoffs and dominance, so checking its endpoints establishes those constraints for its partial fills as well.

After only 20 opposing and 20 favored shares fill, confirmed payoffs are `$82.15/$58.25` and DIFF is `23.9`. Re-solving for the same final targets gives:

| Remaining favored/opposing costs | Favored quantity | Opposing quantity | Incremental cost |
|---|---:|---:|---:|
| $0.30 / $0.20 | 33.260000 | 27.160000 | $15.410000 |
| $0.35 / $0.20 | 36.955556 | 30.855556 | $19.105556 |

These are mathematical quantities before venue rounding and a new sequence check. The second row cannot simply execute its full favored leg first while preserving the original `$48.25` floor. Hypothetical completion prices remain uncertain.

## 10. Difference from the current implementation

| Component | Current v5 | Proposed specification |
|---|---|---|
| Sizing | Fixed 50/150 templates; optional bounded incremental utility search. | Quantities from joint payoffs, costs, constraints and finite execution opportunities. |
| Favored-side identity | Trading direction can update; complements follow current net inventory. | Initial favored side fixed after first entry fill, with continuing strict dominance. |
| Acquisition averages | Lot costs and inventory economics; no universal average-reduction condition. | Later purchases must satisfy the specified average-reduction condition. |
| Risk feasibility | Primarily absolute share imbalance, tightening from 500 to 350. | Dollar settlement payoffs, selected intermediate floors and signed dominance, including pending sequences. |
| Target objective | Heuristic utility with pair and risk-relief bonuses. | Explicit expected terminal score and separate dollar P&L/downside reporting. |
| Cheap token | Prioritized exception that bypasses normal economic acceptance. | No price-only exception: probability, average and inventory conditions still apply. |
| Maker submission | GTC intentions use `postOnly=false`. | Exact ask-minus-current-tick post-only placement when eligible. |
| Execution evidence | Main research policy credits no resting maker fills. | Maker opportunities require their own defensible execution model and sensitivity analysis. |
| Round budget | No hard per-round spending ceiling in strategy rules. | Still no preset per-round spending allocation. |

Sources: [strategy](engine/strategies/wallet3048.js), [fill simulator](engine/fillsim.js), [historical harness](engine/simrun.js), and [live-data simulation](src/execution/shadow.js).

Changing only `W3048_SIZE_MODE` would not implement this specification. Conversely, the existing exact ledger, latency handling, source-clock checks and identified-liquidity accounting are useful foundations to preserve and verify.

## 11. Evaluation and evidence

For completed rounds, define `p_plus`, `p_minus` and `p_zero` over the same declared cohort. With `W` the mean positive P&L and `L` the magnitude of mean negative P&L:

```text
Mean round P&L = p_plus*W - p_minus*L
Profitability requires p_plus*W > p_minus*L
When p_plus > 0 and L > 0: W/L > p_minus/p_plus
```

First-entry accuracy is a separate directional statistic. A desired conditional payoff ratio on planned positions does not guarantee the realized average-win/average-loss ratio, especially if unsuccessful plans accumulate different sizes.

The two historical cohorts must remain distinct:

| Cohort | Entry correctness | Other evidence |
|---|---:|---|
| Target wallet, August 22 through September 9 at 19:35 UTC | 2,279/4,427 = 51.48% | First observed BUY side against Bapi winner; ambiguous first-second sides excluded. Public timestamps do not recover exact exchange execution order. |
| Current v5, September 7–9 Berlin-day research replays | 453/860 = 52.67% | 316/860 profitable; mean win +$51.11, mean loss -$65.83, mean scored round -$22.86. |

Sources: [target-wallet cohort](data/reports/wallet3048-first-entry-2026-08-22/summary.json) and [v5 replay analysis](WALLET3048_STRATEGY_ALGORITHM.md). These figures are existing evidence, not a replay of the proposed controller. Neither is a calibrated per-order probability. The v5 replay's timestamp proxies, incomplete-feed exclusions and maker assumptions continue to apply.

Report at least:

- Mean net P&L per eligible round and per traded round, with participation and unresolved/incomplete counts.
- Positive, negative and zero-round frequencies; mean winning and losing dollars; payoff ratio and profit factor when defined.
- Loss quantiles and mean P&L in the worst tail, with the cohort and tail definition stated.
- First-entry accuracy, including correct-first-but-losing rounds.
- Planned versus realized payoffs, completion frequency, time exposed and failed-completion P&L.
- Maker/taker quantities, rejects, partial fills, cancellation outcomes and execution evidence class.
- Peak deployed funds as an observed consequence of the strategy, without turning it into a preset sizing allocation.
- Probability calibration by remaining time and execution state, including conditioning on maker fills.

Choose forecasting parameters on chronological training/validation data and freeze them before testing. September 7–9 and the screenshot have already informed this design; results on them are development comparisons, not an untouched final test. Use contiguous-round/day resampling for uncertainty and do not count repeated ticks in one round as independent settlement observations.

## 12. Decisions to freeze before an implementation can be evaluated

The following are open model or policy selections, not algebraic omissions to fill with arbitrary constants:

| Selection | What must be recorded |
|---|---|
| Entry and velocity gates | Exact features, lookbacks, thresholds and behavior when prerequisites are missing. |
| Probability and execution models | Training periods, data provenance, calibration, joint-path construction and treatment of missing maker evidence. |
| Loss/return preference | The chosen `lambda` or an explicit alternative objective, plus expected-dollar and downside effects. |
| Intermediate floors | Whether any apply during exposed entry/accumulation, and the preservation policy after common profit is acquired. |
| Plan search | Candidate opportunities, horizon, venue precision, sequence rules and deterministic tie-breaking. |
| Remainder lifecycle | Taker remainder treatment, maker expiry/cancellation rules and acknowledgment handling. |
| Evaluation contract | Frozen variants, baseline, final test period, cohort rules and reported uncertainty. |

The fixed initial-side dominance, strict later average reduction, exact maker placement rule and absence of a preset spending allocation are retained from the supplied text. Any change to those requirements should be identified as a separate strategy variant.

## 13. Verification performed for this review

The two-leg inverse equations were independently evaluated on 2,000 generated feasible constant-price cases, including targets derived from nonnegative purchases. Maximum reconstruction error across quantities and payoffs was approximately `2.53e-11` in floating-point arithmetic.

The staged example was checked at its endpoints and 1,001 fill fractions per leg. The reported minimum common payoff and dominance matched `$48.25` and `3.9` shares. Both remaining-quantity examples and the `0.37931/0.62069` loss-weighted price thresholds at `p=0.55`, `lambda=1` were recomputed.

These checks validate the stated arithmetic and expose the flat-entry constraint. They do not validate future price availability, queue fills, probability calibration, live profitability, or a unique optimal policy. No runtime strategy, execution policy or parameters were changed by this review.

## 14. Subsequent BAPI calibration

The [September 3–10 empirical study](WALLET3048_BAPI_CALIBRATION_2026-09-03_10.md) evaluated 2,081 usable rounds from BAPI V2 metadata and order-book recordings. It fitted and tested outcome probabilities, future best-ask forecasts and joint price-target opportunities. The selected probability adjustment had no clear material improvement on later periods, persistence beat the tested price extrapolations on validation, and the joint-touch predictor deteriorated on the new test.

Book snapshots did not identify actual maker fills. The study therefore does not establish optimal payoff targets, a complete joint execution model or profitable operation of this proposed controller. The unchanged v5 baseline averaged +$45.88 on positive rounds and −$58.67 on negative rounds, producing −$20.74 per round over that cohort. These results refine the empirical status of the proposal; they do not change its runtime implementation status.
