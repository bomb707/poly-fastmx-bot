# Signal parity audit — 98% target

Target: `0x75cc3b63a2f2423085e10706c78b494017b93ce1`. This is a causal direction audit at target action times, not a claim of exact release-time cloning. Features are observed 520 ms before the inferred match.

## Current runtime rule

- Fit: 231 actions, 8.4% coverage, 96.1% precision, Wilson-95 lower 92.76%.
- Validation: 85 actions, 7.9% coverage, 96.47% precision, Wilson-95 lower 90.13%.
- Holdout Aug 22–25: 190 actions, 8.69% coverage, 97.89% precision, Wilson-95 lower 94.71%.
- External Aug 26: 7 actions, 9.72% coverage, 100% precision, Wilson-95 lower 64.57%.
- Fresh exact Aug 27: 30 actions, 10.2% coverage, 100% precision, Wilson-95 lower 88.65%.
- Combined forward: 227 actions, 8.89% coverage, 98.24% precision, Wilson-95 lower 95.56%.

## Validation-selected strict momentum consensus

Config: `{"clob3Min":0.1,"clob1Min":0.01,"requireClob5Agreement":false,"binanceHorizon":3,"binanceMin":0.02,"requireOtherBinanceAgreement":false}`.

- Fit: 139 actions, 5.05% coverage, 94.96% precision, Wilson-95 lower 89.97%.
- Validation: 72 actions, 6.69% coverage, 95.83% precision, Wilson-95 lower 88.45%.
- Holdout Aug 22–25: 132 actions, 6.04% coverage, 93.18% precision, Wilson-95 lower 87.55%.
- External Aug 26: 4 actions, 5.56% coverage, 100% precision, Wilson-95 lower 51.01%.

## Multi-horizon momentum likelihood-ratio gate

The learned log-likelihood ratio may abstain but cannot override the required 3-second CLOB midpoint direction or Binance-3 agreement.

- Fit: 31 actions, 1.13% coverage, 100% precision, Wilson-95 lower 88.97%.
- Validation: 3 actions, 0.28% coverage, 100% precision, Wilson-95 lower 43.85%.
- Holdout Aug 22–25: 15 actions, 0.69% coverage, 100% precision, Wilson-95 lower 79.61%.
- External Aug 26: 0 actions, 0% coverage, n/a precision, Wilson-95 lower n/a.

## Conclusion

- Best held-out candidate: momentum likelihood-ratio gate.
- 98% point estimate on holdout and external: **no**.
- 98% Wilson-95 lower confidence bound on both: **no**.
- Exact direction + release/action clone established: **no**.
- Selective direction gate enabled experimentally: **yes**; exact release/action promotion remains **no**.

The active selective gate clears 98% combined forward point precision, but not a 98% Wilson lower bound; exact release/action parity remains unproven.
