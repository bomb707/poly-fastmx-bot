# FastMX toggle-velocity parity audit

Binance gap velocity is rebuilt from raw feed prices with the exact formula `price(t)-price(t-3000ms)`.

## both

- Fit: 409 actions, 14.87% coverage, 91.93% precision, Wilson-95 lower 88.89%.
- Validation: 171 actions, 15.89% coverage, 82.46% precision, Wilson-95 lower 76.06%.
- Holdout Aug 22–25: 355 actions, 16.24% coverage, 90.14% precision, Wilson-95 lower 86.6%.
- External Aug 26: 12 actions, 16.67% coverage, 91.67% precision, Wilson-95 lower 64.61%.
- Fresh exact Aug 27: 57 actions, 19.39% coverage, 98.25% precision, Wilson-95 lower 90.71%.
- Combined forward: 424 actions, 16.61% coverage, 91.27% precision, Wilson-95 lower 88.2%.

## clobOnly

- Fit: 653 actions, 23.75% coverage, 90.96% precision, Wilson-95 lower 88.52%.
- Validation: 217 actions, 20.17% coverage, 82.03% precision, Wilson-95 lower 76.38%.
- Holdout Aug 22–25: 514 actions, 23.51% coverage, 88.72% precision, Wilson-95 lower 85.69%.
- External Aug 26: 14 actions, 19.44% coverage, 78.57% precision, Wilson-95 lower 52.41%.
- Fresh exact Aug 27: 72 actions, 24.49% coverage, 97.22% precision, Wilson-95 lower 90.43%.
- Combined forward: 600 actions, 23.51% coverage, 89.5% precision, Wilson-95 lower 86.79%.

## binanceOnly

- Fit: 873 actions, 31.75% coverage, 80.3% precision, Wilson-95 lower 77.53%.
- Validation: 578 actions, 53.72% coverage, 72.66% precision, Wilson-95 lower 68.89%.
- Holdout Aug 22–25: 861 actions, 39.39% coverage, 81.3% precision, Wilson-95 lower 78.56%.
- External Aug 26: 34 actions, 47.22% coverage, 85.29% precision, Wilson-95 lower 69.87%.
- Fresh exact Aug 27: 102 actions, 34.69% coverage, 96.08% precision, Wilson-95 lower 90.35%.
- Combined forward: 997 actions, 39.07% coverage, 82.95% precision, Wilson-95 lower 80.49%.

Caveat: Retrospective direction precision at target action times is not market participation, release-time parity, profitability, or a prospectively locked result.
