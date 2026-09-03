# Reversal risk-gate screen — 2026-09-03

## Decision

Do not promote an inventory-reversal cap, reversal confidence floor, reversal edge floor,
or repeat-reversal floor. The tested rules preserved the number of entered markets, but no
candidate improved the chronological partitions and drawdown together. The current release
and trading model remains unchanged.

## Method

- BAPI V2 L2 cache from `2026-08-20T00:00:00Z` through `2026-09-03T01:35:00Z`
- 3,407 resolved markets; 1,669 markets traded by the current model
- Existing release policy, session confidence schedule, 4,000 ms cooldown, 520 ms latency,
  visible-depth fixed-USD FAK fills, fees, and sizing held constant
- Preselected chronological partitions:
  - train: August 20–24
  - validation: August 25
  - holdout: August 26
  - OOS: August 27–September 3
- Screened 17 alternatives: one/two-reversal caps; global reversal probability floors;
  global reversal edge floors; and probability/edge floors applied only after the first reversal

## Representative results

| Policy | Fills | Total P&L | PF | Max DD | Train | Validation | Holdout | OOS | Aug 24 | Sep 1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Current model | 2,665 | $97.27 | 1.0455 | $143.48 | -$99.53 | $77.29 | $49.37 | $70.14 | -$42.53 | -$91.03 |
| Maximum one reversal | 2,417 | $135.92 | 1.0635 | $180.02 | -$135.78 | $100.21 | $64.53 | $106.96 | -$32.81 | -$34.47 |
| Global reversal edge >= 0.005 | 2,624 | $74.86 | 1.0351 | $134.18 | -$89.53 | $76.92 | $43.15 | $44.32 | -$20.48 | -$88.54 |
| One reversal + edge >= 0.005 | 2,414 | $98.36 | 1.0455 | $155.04 | -$101.17 | $87.47 | $37.16 | $74.90 | -$6.16 | -$43.54 |
| Repeat reversal probability >= 0.80 | 2,565 | $172.10 | 1.0836 | $164.47 | -$129.82 | $88.67 | $63.61 | $149.63 | -$68.02 | -$45.35 |
| Repeat reversal edge >= 0.005 | 2,646 | $84.01 | 1.0394 | $157.10 | -$114.93 | $81.30 | $47.92 | $69.72 | -$34.99 | -$82.24 |

All alternatives kept 1,669 entered markets. They changed only later inventory handling.

## Interpretation

- A one-reversal cap fixed much of September 1, but worsened train P&L by $36.26 and max
  drawdown by $36.54. Its benefit is regime-dependent rather than stable.
- A 0.005 global edge floor improved train P&L and drawdown slightly, but reduced holdout,
  OOS, total P&L, and profit factor.
- The most attractive aggregate result, an 0.80 probability floor only on repeated reversals,
  improved total and OOS P&L but worsened train P&L by $30.29, max drawdown by $20.99, and
  August 24 by $25.50. Promoting it would tune toward the known September 1 loss.
- Higher confidence or edge is not a sufficient whipsaw detector. The next model iteration
  needs features describing path instability before the order—such as side-change count,
  short-horizon sign flips, realized token-mid volatility, spread/depth deterioration, and
  time since the previous cross—then a new chronological fit and untouched OOS evaluation.

## Verification

The experimental runtime knobs were removed after the screen. `npm test` passes all 88 tests.
