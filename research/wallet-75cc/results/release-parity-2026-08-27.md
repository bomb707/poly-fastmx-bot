# Exact release/action parity audit

Exact registered-engine replay over 2875 BTC 5-minute markets and 6025 target actions. Config selection uses Aug 21 only; the table uses a ±2 second causal decision-time tolerance.

| Variant | Val predictions | Val precision | Val recall | Val F1 | Holdout predictions | Holdout precision | Holdout recall | Holdout F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| current-5s | 1431 | 5.66% | 7.51% | 6.45% | 3856 | 3.89% | 6.86% | 4.96% |
| hazard-7.5s | 863 | 6.49% | 5.19% | 5.77% | 2332 | 3.34% | 3.56% | 3.45% |
| hazard-9.75s | 465 | 6.67% | 2.87% | 4.02% | 1307 | 2.83% | 1.69% | 2.12% |
| hazard-10s | 420 | 7.38% | 2.87% | 4.14% | 1220 | 2.62% | 1.46% | 1.88% |
| hazard-12.5s | 235 | 5.96% | 1.3% | 2.13% | 720 | 2.92% | 0.96% | 1.44% |
| repeat-menu-5s | 1913 | 5.44% | 9.64% | 6.95% | 4656 | 3.52% | 7.5% | 4.79% |
| repeat-menu-9.75s | 488 | 6.35% | 2.87% | 3.96% | 1347 | 2.75% | 1.69% | 2.09% |

Selected on validation: **repeat-menu-5s**. Held-out exact precision 3.52%, recall 7.5%.

98% exact direction + release/action parity: **no**. No runtime clock/config is promoted by this audit.
