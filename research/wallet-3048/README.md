# Wallet 0x3048 research pipeline

This directory reconstructs wallet `0x3048d65321be3497164cdfc2996f94f98a2e7537` from exact exchange calldata first, then independently times those order hashes from v4 order-book transitions. Generated API data is kept under the ignored `data/wallet-3048/` directory.

## Reproduce

```bash
npm run research:wallet3048:collect -- 2026-08-14T00:00:00Z 2026-08-22T17:00:00Z
npm run research:wallet3048:rebates -- 2026-08-14 2026-08-22 data/wallet-3048/maker-rebates.json
npm run research:wallet3048:analyze -- data/wallet-3048/trades-2026-08-14_2026-08-22.json data/wallet-3048
npm run research:wallet3048:align -- data/wallet-3048/trades-2026-08-14_2026-08-22.json data/wallet-3048
npm run research:wallet3048:v4top -- data/wallet-3048 data/wallet-3048/trades-2026-08-14_2026-08-22.json
npm run research:wallet3048:orders -- data/wallet-3048/trades-2026-08-14_2026-08-22.json data/wallet-3048
npm run research:wallet3048:fires -- data/wallet-3048 data/wallet-3048/signed-orders.json.gz
npm run research:wallet3048:v2controls -- data/wallet-3048/trades-2026-08-14_2026-08-22.json data/wallet-3048/feeds/v2
npm run research:wallet3048:exact -- data/wallet-3048
npm run research:wallet3048:cancels -- data/wallet-3048
npm run research:wallet3048:cycles -- data/wallet-3048
npm run research:wallet3048:waves -- data/wallet-3048
npm run research:wallet3048:epochs -- data/wallet-3048
npm run research:wallet3048:economics -- data/wallet-3048
npm run research:wallet3048:case -- data/wallet-3048 btc-updown-5m-1787415000
npm run research:wallet3048:e8-l2 -- data/wallet-3048
npm run research:wallet3048:gates -- data/wallet-3048
npm run research:wallet3048:hazard -- data/wallet-3048
npm run research:wallet3048:side-choice -- data/wallet-3048
npm run research:wallet3048:tree -- data/wallet-3048
npm run research:wallet3048:l2-backtest -- data/wallet-3048
npm run research:wallet3048:capital -- data/wallet-3048-r2 data/wallet-3048/trades-2026-08-22T17_2026-08-24.json
npm run research:wallet3048:menu -- data/wallet-3048-r2
npm run research:wallet3048:validate-capital -- data/wallet-3048 data/wallet-3048-r2
npm run research:wallet3048:test
npm run research:wallet3048:inventory-ledger -- data/live-ticks data/research/wallet3048-inventory-ledger 6 1788105600
```

One of `BAPI_V4_KEY`, `BAPI_V3_KEY`, `BAPI_KEY`, or `BACKTEST_API_KEY` is required for v4 collection.

## Main outputs

- `STRATEGY_REPORT.md`: consolidated evidence, formula, confidence, and backtests.
- `CAPITAL_INDEPENDENT_R2.md`: latest capital-independent reconstruction, scaling table, and fresh replay boundary.
- `RECONSTRUCTED_POLICY.md`: concise current policy specification and pseudocode.
- `data/wallet-3048/signed-orders.json.gz`: 93,106 exact signed-order groups decoded from settlement calldata. The embedded EIP-712 timestamp is construction time only.
- `data/wallet-3048/order-fires.json.gz`: exact hashes aligned to consecutive v4 book states for off-chain fire timing.
- `data/wallet-3048/fire-actions.json.gz`: same-side hashes released within 300 ms collapsed into one observable action.
- `data/wallet-3048/signature-waves.{json,md}`: pre-built price/size action menus and release thresholds.
- `data/wallet-3048/order-hazard-analysis.{json,md}`: actual fire versus earlier executable no-fire moments for the same signed action.
- `data/wallet-3048/side-choice-analysis.{json,md}`: fired token versus the opposite token at the same pre-consumption tick.
- `data/wallet-3048/fire-gate-tree.{json,md}`: train-only release trees and untouched holdout AUC.
- `data/wallet-3048/cancel-replacements.json.gz`: inferred passive remainder removal and next same-side replacement.
- `data/wallet-3048/config-epochs.{json,md}`: eight observed runtime size/configuration epochs.
- `data/wallet-3048/window-case-btc-updown-5m-1787415000.{json,md}`: exact reconstruction of the screenshot window.
- `data/wallet-3048/l2-gate-backtest.{json,md}`: E8 full-L2 train/holdout replays and rejected alternatives.
- `data/wallet-3048-r2/capital-invariance.{json,md}`: stable Q=30/Q=25 comparison and normalized economics.
- `data/wallet-3048-r2/frozen-capital-validation.{json,md}`: old, frozen models evaluated after the size change.
- `data/wallet-3048-r2/menu-topology.{json,md}`: one-cent signed ladder, retry cells, and wave topology.
- `data/wallet-3048-r2/frozen-scale-backtest.json`: latest untouched Q=25 behavior/economics replay, including queue-aware remainder diagnostics.
- `data/research/wallet3048-inventory-ledger/inventory-ledger.json.gz`: exact receipt-level inventory, payout, IF-UP/IF-DOWN, average-price, and marginal-order ledger.
- `data/research/wallet3048-inventory-ledger/parent-executions.csv`: flat execution audit with before/after inventory, reverse-calculated price/size, and 2.5-second Binance/CLOB context.
- `data/research/wallet3048-inventory-ledger/inventory-ledger.md`: multi-window summary plus inventory-vector matches for manually transcribed screenshots.

The full-range top-book cache covers 2,505 settled control markets. The original E8 deep-book cache contains all 250 resolved markets in that interval; the R2 cache contains 382 later resolved markets. Always use `include_orderbook=true` asks; v4 `priceUp` and `priceDown` are midpoint-style fields, not executable prices.
