# Window 1787831700 signal-match test

This is a deliberately single-window, research-only calibration. It is not a
production parameter recommendation and was not applied to the running bot.

## Target groups

The target wallet has six visible side/time groups. Four are directional
entry/top-up groups: `28 Up`, `75 Up`, `94 Up` (two simultaneous orders), and
`211 Up`. The other two, `40 Down` and `244 Down`, reduce the wallet's existing
Up imbalance and are therefore hedge groups. FastMX cannot reproduce those two
without restoring the explicitly removed inventory-dependent hedge branch.

## Entry-only test profile

- CLOB midpoint velocity: on, 5000 ms, minimum 0.12
- Binance gap velocity: on, 3000 ms, minimum $0.01
- Rolling trend regime: on, 10 seconds, strong threshold 0.05%
- Countertrend confirmation: 60 seconds, 0.075%
- Binance window-gap agreement: off
- Active interval: 27 through 245 seconds
- Minimum selected ask: 0.54
- Cooldown: 10000 ms

The exact registered-engine V2-L2 replay emits four and only four decisions:

| Target group | FastMX decision | Absolute difference |
|---|---:|---:|
| 28 Up | 27.593 Up | 0.407 s |
| 75 Up | 77.271 Up | 2.271 s |
| 94 Up | 92.618 Up | 1.382 s |
| 211 Up | 209.116 Up | 1.884 s |

At a three-second tolerance this is 4/4 entry-group precision and 4/4
entry-group recall, with no additional entry fires. The target timestamps are
whole-second on-chain fill-block times, not millisecond decision timestamps,
so sub-three-second comparison is the defensible resolution for this window.

The fit is intentionally overfit to one historical window. In particular, the
$0.01 Binance threshold and 0.54 minimum ask should not be promoted without a
chronological multi-window holdout test.
