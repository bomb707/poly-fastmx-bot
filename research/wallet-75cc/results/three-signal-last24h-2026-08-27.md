# FastMX three-signal trailing-day fit

Target: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`. Exact UTC range: 2026-08-26T11:25:00.000Z through 2026-08-27T11:25:00.000Z.

## Chronologically selected config

CLOB 5000 ms ≥ 0; Binance 3000 ms ≥ $5; trend 20 min ≥ 0%; Binance window-gap agreement OFF

- Fit (first 8h): 223 actions, 35.57% target-action coverage, 98.21% direction match, Wilson-95 lower 95.48%.
- Selection (next 4h): 84 actions, 32.56% target-action coverage, 100% direction match, Wilson-95 lower 95.63%.
- Untouched holdout (final 12h): 242 actions, 33.66% target-action coverage, 98.76% direction match, Wilson-95 lower 96.42%.
- Full trailing day: 549 actions, 34.23% target-action coverage, 98.72% direction match, Wilson-95 lower 97.39%.

## Required 3000 ms CLOB lookback

CLOB 3000 ms ≥ 0.02; Binance 3000 ms ≥ $5; trend 15 min ≥ 0%; Binance window-gap agreement OFF

- Fit (first 8h): 205 actions, 32.7% target-action coverage, 98.05% direction match, Wilson-95 lower 95.09%.
- Selection (next 4h): 81 actions, 31.4% target-action coverage, 100% direction match, Wilson-95 lower 95.47%.
- Untouched holdout (final 12h): 197 actions, 27.4% target-action coverage, 98.48% direction match, Wilson-95 lower 95.62%.
- Full trailing day: 483 actions, 30.11% target-action coverage, 98.55% direction match, Wilson-95 lower 97.04%.

## Same three signals without window-gap agreement

CLOB 5000 ms ≥ 0; Binance 3000 ms ≥ $5; trend 20 min ≥ 0%; Binance window-gap agreement OFF

- Untouched holdout: 242 actions, 33.66% target-action coverage, 98.76% direction match, Wilson-95 lower 96.42%.
- Full trailing day: 549 actions, 34.23% target-action coverage, 98.72% direction match, Wilson-95 lower 97.39%.

## Reference defaults

CLOB 3000 ms ≥ 0.08; Binance 3000 ms ≥ $6; trend 30 min ≥ 0.05%; Binance window-gap agreement ON

- Untouched holdout: 73 actions, 10.15% target-action coverage, 100% direction match, Wilson-95 lower 95%.
- Full trailing day: 157 actions, 9.79% target-action coverage, 100% direction match, Wilson-95 lower 97.61%.

Caveat: This is an in-day signal-direction imitation audit. It does not prove stable earnings, execution quality, event-time recall, or future performance.
