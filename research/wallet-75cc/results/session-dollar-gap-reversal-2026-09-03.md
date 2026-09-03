# Session-conditioned BTC/TWAP dollar-gap reversal audit — 2026-09-03

## Verdict

The main hypothesis is supported: a larger causal BTC/TWAP distance from the opening reference is associated with a sharply lower probability that the eventual Polymarket side reverses. The relationship is nonlinear and depends materially on time remaining, session, CLOB activity, and whether Binance and the Chainlink TWAP stream point to the same side.

This evidence belongs primarily in the winner-probability/regime and confidence-sizing model. The release model answers a different question—when the target wallet releases a pre-signed menu cell—and should not be forced to carry the directional objective.

## Data and definitions

- 4,222 usable BTC five-minute markets from `[2026-08-14T00:00:00Z, 2026-09-03T12:00:00Z)`.
- 20,690 causal observations at 60, 120, 180, 240, and 270 seconds into each market.
- Each observation uses the latest coherent snapshot no more than 2.5 seconds old and never reads a later snapshot.
- The final winner is used only as the evaluation label.
- All 4,222 final Chainlink price directions matched the recorded market winner.
- `Binance-own gap`: current Binance minus its own boundary open.
- `Settlement-reference gap`: current Binance minus the Chainlink TWAP-60 opening reference.
- `TWAP gap`: current Chainlink TWAP-60 value minus the Chainlink opening reference.
- “Reversal” means the eventual winner is opposite the side implied by the causal gap.

Polymarket's market rules specify that resolution uses the Chainlink BTC/USD TWAP-60 stream relative to the beginning of the range, not Binance spot.

## Gap magnitude at 180 seconds

The table uses Binance relative to the Chainlink settlement opening reference. Confidence intervals are 95% Wilson intervals.

| Absolute dollar gap | Markets | Direction correct | Reversal | Reversal 95% CI | BTC/TWAP agreement |
|---|---:|---:|---:|---:|---:|
| $0–10 | 524 | 55.15% | 44.85% | 40.64–49.13% | 59.35% |
| $10–20 | 451 | 69.18% | 30.82% | 26.74–35.23% | 69.40% |
| $20–50 | 1,202 | 70.05% | 29.95% | 27.43–32.60% | 76.29% |
| $50–100 | 1,373 | 78.81% | 21.19% | 19.11–23.44% | 83.10% |
| $100–150 | 371 | 94.88% | 5.12% | 3.30–7.86% | 98.65% |
| $150+ | 271 | 97.42% | 2.58% | 1.26–5.23% | 98.15% |

This directly supports the proposed 100–150 dollar safety-margin region at this point in the market.

## Time remaining changes the meaning of the same gap

| Elapsed | Seconds left | $50–100 reversal | $100–150 reversal | $150+ reversal |
|---:|---:|---:|---:|---:|
| 60s | 240s | 33.39% | 21.57% | 14.29% |
| 120s | 180s | 27.53% | 9.97% | 4.47% |
| 180s | 120s | 21.19% | 5.12% | 2.58% |
| 240s | 60s | 15.04% | 0.25% | 0.00% |
| 270s | 30s | 13.19% | 0.00% | 0.00% |

A static `$100 = safe` gate is therefore too coarse. At 60 seconds elapsed, even a $100–150 gap reversed more than one market in five; after 240 seconds elapsed, the same band almost never reversed.

## Session effect at 180 seconds

| UTC session | Label | $50–100 reversal | $100–150 reversal |
|---|---|---:|---:|
| 00:00–04:00 | Asia morning / US evening | 21.39% | 4.55% |
| 04:00–08:00 | Asia afternoon / US midnight | 19.63% | 2.22% |
| 08:00–12:00 | Europe morning / US premarket | **19.59%** | 7.04% |
| 12:00–16:00 | US morning | **29.06%** | 8.82% |
| 16:00–20:00 | US afternoon | 20.36% | 3.03% |
| 20:00–24:00 | US evening / Asia open | **15.77%** | 0.00% |

The `$50 is safer outside active US morning` claim is supported in this sample. For the $50–100 band, the US-premarket reversal estimate was 19.59% (95% CI 15.11–25.02%) versus 29.06% (23.92–34.79%) in US morning.

## BTC/TWAP agreement is essential

At 180 seconds:

| Absolute settlement-reference gap | Reversal when BTC/TWAP agree | Reversal when they disagree |
|---|---:|---:|
| $10–20 | 23.32% | 47.83% |
| $20–50 | 21.16% | 58.25% |
| $50–100 | **14.29%** | **55.17%** |
| $100–150 | 4.92% | 20.00% (only 5 disagreements) |
| $150+ | 2.26% | 20.00% (only 5 disagreements) |

For a medium $50–100 gap, using BTC direction without requiring the settlement TWAP to agree was worse than a coin flip in the disagreement subset. The model should retain Binance movement, TWAP gap, and Binance/TWAP basis as separate values and add their nonlinear interaction.

## Activity qualification

The cache does not contain reliable traded-volume attribution. A trailing 30-second CLOB midpoint range was used as an activity/volatility proxy.

| Gap | Low activity reversal | High activity reversal |
|---|---:|---:|
| $20–50 | 24.44% | 34.33% |
| $50–100 | 17.78% | 27.02% |
| $100–150 | 3.80% | 12.73% |
| $150+ | 1.98% | 11.11% (only 18 high-activity markets) |

Large gap remains directionally valuable, but “regardless of activity” is too strong. High activity materially increases the reversal tail, especially around the proposed $100 boundary.

## Direction is not automatically economic edge

At 180 seconds, the available leader ask averaged 0.9414 for a $100–150 gap and 0.9637 for $150+. Despite 94.88% and 97.42% directional accuracy, buying every available leader produced approximately -$0.0166 and -$0.0248 per share after the modeled fee. Quote availability becomes selective in nearly settled markets, so these figures are indicative rather than a standalone executable backtest.

The gap should strengthen direction confidence and preserve winning-side residual size only when the market ask remains below the model's fee-adjusted fair value. Large gap alone must not bypass the expected-edge gate.

## Recommended feature design

Add these causal inputs to the winner-probability/regime model, not directly as fixed release weights:

1. Signed Binance return from its own open, in both dollars and basis points.
2. Signed Binance distance from the Chainlink settlement opening reference.
3. Signed current Chainlink TWAP-60 distance from its opening reference.
4. Binance/TWAP direction agreement and signed basis.
5. Piecewise gap bands around $10, $20, $50, $100, and $150.
6. Time interaction: gap divided by remaining-time volatility, plus required reversal velocity `abs(TWAP gap) / seconds left`.
7. Session interaction using the existing fixed UTC bins.
8. Trailing realized volatility/activity so high-gap, high-volatility cases are not treated as locked.

Prefer a volatility-normalized safety score over a permanent dollar threshold:

```text
safety = abs(current TWAP - opening TWAP) / expected remaining TWAP movement
```

The dollar bands remain useful for interpretation, but BTC price level and volatility changed materially even within this 20-day sample. Any sizing increase should be selected chronologically and capped by fee-adjusted edge and drawdown constraints.

