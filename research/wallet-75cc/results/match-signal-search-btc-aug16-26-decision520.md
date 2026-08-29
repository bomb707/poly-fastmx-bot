# 90% signal search — BTC 5m

Target: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`. All inputs are frozen at inferred match minus 520 ms. Models were fit through Aug 20, selected and confidence-calibrated on Aug 21, then frozen for Aug 22–25. Aug 26 is a later external check.

- Pairwise logistic: holdout 80.42%; Aug 26 83.33%.
- Market-only pairwise logistic: holdout 80.05%; Aug 26 86.11%. At its validation-selected 90% cutoff: holdout 94.11% precision/26.4% coverage; Aug 26 93.33%/20.83%.
- Native-v2-only market model (train Aug 22 08:55–Aug 23, calibrate Aug 24): Aug 25 full accuracy 76.77%, cutoff precision/coverage 90.04%/43.71%; Aug 26 96%/34.72%.
- Extra-tree forest: holdout 79.19%; Aug 26 86.11%.
- Validation-selected 90% cutoff (pairwise logistic): holdout precision 93.84% at 26.72% coverage; Aug 26 precision 93.33% at 20.83% coverage.
- Best confidence frontier on holdout (pairwise logistic): 10% coverage: 95.87%; 20% coverage: 94.97%; 30% coverage: 93.13%; 40% coverage: 91.53%; 50% coverage: 90.48%; 60% coverage: 88.56%; 70% coverage: 86.73%; 80% coverage: 84.9%; 90% coverage: 82.71%; 100% coverage: 80.42%.
- Full-coverage 90% direction match: **not achieved**.
