# Signal-agreement persistence audit

Hypothesis: uninterrupted CLOB midpoint/Binance agreement supplies the missing sequential evidence. Direction always remains the required 3-second CLOB midpoint direction.

Selected config: `{"midLookbackMs":3000,"midMin":0.01,"binanceLookbackMs":3000,"binanceMinPct":0.01,"persistenceMs":0}`.

- Fit: 751 actions, 27.31% coverage, 82.16% precision.
- Validation: 511 actions, 47.49% coverage, 74.95% precision.
- Holdout Aug22-25: 695 actions, 31.79% coverage, 83.74% precision.
- Untouched exact Aug27: 84 actions, 28.57% coverage, 97.62% precision.

Runtime promotion: **no**.
