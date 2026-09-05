# Main strategy

`helpme.js` is the sole registered FastMX strategy. `index.js` supplies the same module to the live simulation and historical replay; an unknown strategy name falls back to Helpme.

The strategy exports its `NAME`, `LABEL`, default `STRAT` parameters, `validateParams`, and `step(state, tick, params, dtMs, clockMs)`. A step produces order intents; the execution layer handles fills, accounting, and persistence. The strategy does not submit orders or access the database.

`helpme.test.mjs` covers signals, trend filtering, sizing, inventory controls, and validation. `index.test.mjs` covers strategy selection. Run them with `npm test`; use `npm run test:strategy` for the main strategy behavior tests.
