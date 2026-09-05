# Runtime libraries

These modules remain imported by the application for execution status, account integration, and shared infrastructure. Application configuration enforces simulation mode.

| Module | Purpose |
|---|---|
| `executor.js` | CLOB client adapter, account status, order lifecycle, and reconciliation |
| `clobFastPath.js` | Prepared-order signing and submission support |
| `clobHttpTransport.js` | Dedicated CLOB HTTP transport |
| `clobOrderHash.js` | Deterministic signed-order hashes and amount helpers |
| `orderstatus.js` | Order-stage definitions shared with dashboard events |

Fee and simulation accounting live in `engine/fees.js`, `engine/fillsim.js`, and `engine/mergesim.js`. Their browser-compatible imports also support historical replay through `engine/simrun.js`.

Run the library and dashboard event-compatibility tests with `npm test`.
