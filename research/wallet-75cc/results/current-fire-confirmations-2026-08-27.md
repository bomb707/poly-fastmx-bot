# Current FastMX order-fire confirmation audit

Causal replay over 2875 BTC five-minute markets. The score below matches the entry-only FastMX decision to the target wallet's 4188 entry/top-up actions by market, side, and ±2 seconds. Aug 21 selects a candidate; Aug 22-25 is untouched holdout.

| Candidate | Val fires | Val precision | Val coverage | Val F1 | Holdout fires | Holdout precision | Holdout coverage | Holdout F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deployed-binance | 6463 | 3.91% | 37.7% | 7.09% | 17271 | 3.18% | 35.65% | 5.84% |
| dual-clob-binance | 5473 | 4.49% | 36.66% | 8.01% | 14909 | 3.65% | 35.32% | 6.61% |
| binance-without-window-gap | 10851 | 3.2% | 51.71% | 6.02% | 27672 | 2.46% | 44.22% | 4.66% |
| dual-without-window-gap | 9119 | 3.68% | 50.07% | 6.86% | 23947 | 2.82% | 43.9% | 5.3% |
| binance-strict-trend | 5367 | 3.69% | 29.51% | 6.56% | 13366 | 3.11% | 27.01% | 5.58% |
| dual-strict-trend | 4566 | 4.23% | 28.76% | 7.37% | 11552 | 3.58% | 26.82% | 6.31% |
| binance-qualification-onset | 3760 | 5.21% | 29.21% | 8.85% | 9535 | 4.88% | 30.19% | 8.4% |
| dual-qualification-onset | 3970 | 5.24% | 31% | 8.96% | 10458 | 4.6% | 31.23% | 8.02% |
| binance-first-side-price-cell | 4331 | 4.85% | 31.3% | 8.4% | 12702 | 3.82% | 31.49% | 6.81% |
| dual-first-side-price-cell | 3974 | 5.38% | 31.89% | 9.21% | 11766 | 4.09% | 31.23% | 7.23% |
| binance-stronger-impulse | 3649 | 4.77% | 25.93% | 8.06% | 8117 | 4.07% | 21.43% | 6.83% |
| dual-stronger-impulse | 2790 | 5.45% | 22.65% | 8.78% | 6225 | 4.75% | 19.22% | 7.62% |
| binance-onset-strict-trend | 3127 | 4.73% | 22.06% | 7.79% | 7377 | 4.74% | 22.73% | 7.85% |
| dual-onset-strict-trend | 3327 | 4.84% | 23.99% | 8.05% | 8175 | 4.44% | 23.57% | 7.47% |

Validation selected **dual-first-side-price-cell**. Holdout precision 4.09%, coverage 31.23%, and F1 7.23%.

Structural limit: the target has 1837 hedge/overhedge actions (30.49% of all actions). All 1837 occur opposite its pre-order inventory. An entry-only public-price signal cannot reproduce that private inventory-dependent branch.

No runtime confirmation was changed by this research audit.
