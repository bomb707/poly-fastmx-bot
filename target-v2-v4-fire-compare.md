# v2 versus v4 order-fire inference

Generated: 2026-08-26T03:44:50.658Z

- v2 inferred orders: **4736**
- v4 inferred orders: **2313**
- joined signed orders: **2285**
- high/medium in both sources: **1524** (66.696%)
- median v2 - v4 fire time: **57 ms**
- median absolute fire difference: **425 ms**
- within 100 / 250 / 500 ms: **32.808% / 43.438% / 52.034%**
- execution-method agreement: **100%**
- pre-fire best-ask agreement: **73.491%**
- conservative 250 ms consensus events: **665** (43.635% of dual-confidence events)

The comparison uses the same exact signed order hash in both histories. On-chain placement time is not used.
