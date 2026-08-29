// engine/strategy.lockstep.test.mjs — behavior tests for the LOCKSTEP decision core.
// Run: node engine/strategy.lockstep.test.mjs
import { STRAT, stepSignalHedge } from "./strategy.js";

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } }

// Minimal round driver: feed ticks to stepSignalHedge (like simrun, no latency), collect fills.
function runRound(ticks, over = {}) {
  // Most legacy behavior cases exercise the synchronous taker-hedge path.
  // Maker-specific cases override this explicitly; defaults are asserted below.
  const P = { ...STRAT, L_HEDGE_EXEC: "taker", ...over };
  const state = {};
  const fills = [];
  for (const tk of ticks) {
    const got = stepSignalHedge(state, tk, P, 120, tk.t * 1000);
    for (const f of got) fills.push({ ...f, _gate: state.gateReason });
  }
  return { state, fills };
}
// tick builder: gap in $, asks for up/down, intensity, t
const tick = (t, gap, upAsk, dnAsk, intensity) => ({
  t, bzGap: gap, intensity, winHour: 15, winDay: 3,
  up: { bestAsk: upAsk, bestBid: upAsk - 0.01 }, down: { bestAsk: dnAsk, bestBid: dnAsk - 0.01 },
});
const locks  = (f) => f.filter((x) => x.leg === "entry");
const hedges = (f) => f.filter((x) => x.leg === "hedge");

ok("default taker latency is 520ms", STRAT.LATENCY_MS === 520);
ok("validated defaults cap entries at 0.88", STRAT.L_ENTRY_CEIL === 0.88);
ok("validated defaults hedge as maker", STRAT.L_HEDGE_EXEC === "maker");
ok("entry-stop gate is disabled by default", STRAT.L_ENTRY_STOP_S === 0);
ok("entry-confirm gate is disabled by default", STRAT.L_ENTRY_CONFIRM_MS === 0);

// Submitted GTC limits must preserve the entry/hedge gates.  A decision made
// at 0.85 is not permission to buy at 0.99 after latency.
{
  const entry = runRound([tick(270, 50, 0.85, 0.16, 100)]).fills.find((fill) => fill.leg === "entry");
  ok("entry GTC ceiling equals the configured 0.88 entry cap", entry?.limitPx === 0.88);

  const delayed = tick(270, 50, 0.85, 0.16, 100);
  delayed.up.fillAsk = 0.90;
  ok("entry does not phantom-fill at the cap when delayed ask is above it", locks(runRound([delayed]).fills).length === 0);

  const hedgeTicks = [tick(240, 60, 0.82, 0.19, 100), tick(260, 60, 0.98, 0.02, 100)];
  const hedge = runRound(hedgeTicks, { L_HEDGE_EXEC: "taker" }).fills.find((fill) => fill.leg === "hedge");
  ok("price-gated taker hedge submits the 0.02 cap, not global 0.99", hedge?.limitPx === 0.02);

  hedgeTicks[1].down.fillAsk = 0.03;
  ok("hedge remains open when delayed ask moved above its submitted cap", hedges(runRound(hedgeTicks, { L_HEDGE_EXEC: "taker" }).fills).length === 0);
}

// ── 1. Core: no lock early (big possible move), lock late (tiny possible move) ──
{
  // intensity 100, WINDOW 300. early t=60 secsLeft=240 frac0.8 pMove80; gap 50 → no lock. late t=270 pMove10; gap50 → lock.
  const { fills } = runRound([
    tick(60, 50, 0.60, 0.42, 100),   // pMove=80, |gap|=50 → no lock
    tick(270, 50, 0.85, 0.16, 100),  // pMove=10, |gap|=50, winner Up ask 0.85 ≥ floor → LOCK
  ]);
  ok("no lock when |gap| ≤ possibleMove (early)", locks(fills).length === 1 && locks(fills)[0].tInto === 270);
  ok("locks the winning (Up) side on gap>0", locks(fills)[0]?.side === "Up");
  ok("lock reason = 'lock'", locks(fills)[0]?.reason === "lock");
  ok("lock size = SIZE (40)", locks(fills)[0]?.shares === 40);
}

// ── 2. Full round: lock the winner, then hedge the cheap loser → balanced $1 set ──
{
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.19, 100),  // pMove=100×0.2=20, |gap|=60 → LOCK Up @0.82
    tick(250, 60, 0.90, 0.10, 100),  // loser Down ask 0.10 > cap 0.02 → no hedge yet
    tick(260, 60, 0.98, 0.02, 100),  // loser Down ask 0.02 ≤ cap AND pair profits → HEDGE Down @0.02
  ]);
  ok("locks once", locks(fills).length === 1 && locks(fills)[0].side === "Up");
  ok("hedges the loser (Down) at the cap", hedges(fills).length === 1 && hedges(fills)[0].side === "Down");
  ok("hedge matches the leg's share count", hedges(fills)[0].shares === locks(fills)[0].shares);
  ok("position closed after hedge (balanced set booked)", state.positions.length === 0);
  ok("realizedWin ≈ (1−0.82−0.02)×40 − fees > 0", state.realizedWin > 0 && state.realizedWin < (1 - 0.82 - 0.02) * 40 + 1e-6);
}

// ── 3. Sign: negative gap → Down winner ──
{
  const { fills } = runRound([tick(270, -50, 0.16, 0.85, 100)]);   // gap<0 → Down leads, Down ask 0.85 ≥ floor
  ok("negative gap locks Down", locks(fills)[0]?.side === "Down");
}

// ── 4. Entry floor: winner below 0.50 → no lock even if gap>possibleMove ──
{
  const { fills } = runRound([tick(270, 50, 0.45, 0.55, 100)]);   // gap>0 Up leads but Up ask 0.45 < floor 0.50
  ok("no lock when winner ask < entry floor", locks(fills).length === 0);
}

// ── 5. Volatility warmup: intensity null → never lock ──
{
  const { fills } = runRound([tick(270, 500, 0.85, 0.16, null)]);
  ok("no lock while intensity not ready (null)", locks(fills).length === 0);
}

{
  const { fills } = runRound([tick(270, 50, 0.89, 0.12, 100)]);
  ok("default entry ceiling rejects a leader above 0.88", locks(fills).length === 0);
}

// ── 6. One-per-round: after a lock+hedge, a fresh signal does NOT re-lock ──
{
  const { fills } = runRound([
    tick(240, 60, 0.82, 0.02, 100),  // LOCK Up + HEDGE Down (loser already 0.02)
    tick(260, 60, 0.90, 0.05, 100),  // would qualify again, but one-per-round blocks
  ], { L_COOLDOWN_MS: 0 });
  ok("one winner per round (no second lock)", locks(fills).length === 1);
}

// ── 7. Skip-end: no NEW lock in the final L_SKIP_END_S seconds ──
{
  const { fills } = runRound([tick(297, 50, 0.85, 0.16, 100)]);   // secsLeft=3 ≤ 5 → skip-end
  ok("no lock inside the skip-end buffer", locks(fills).length === 0 && fills.length === 0);
}

// ── 8. Loser above the price cap → NO hedge (price-only: the winner rides unhedged) ──
{
  const { state, fills } = runRound([
    tick(240, 60, 0.80, 0.19, 100),  // LOCK Up @0.80
    tick(250, 60, 0.85, 0.10, 100),  // loser 0.10 > price cap 0.02 → no hedge; winner stays open
  ]);
  ok("no hedge while the loser's ask is above the cap", hedges(fills).length === 0 && state.positions.length === 1);
}

// ── 8b. Optional early-regime cutoff: allow the boundary, reject later locks ──
{
  const atBoundary = runRound([tick(120, 500, 0.85, 0.16, 100)], { L_ENTRY_STOP_S: 120 });
  const afterBoundary = runRound([tick(121, 500, 0.85, 0.16, 100)], { L_ENTRY_STOP_S: 120 });
  ok("entry-stop permits a qualifying lock at its boundary", locks(atBoundary.fills).length === 1);
  ok("entry-stop rejects a qualifying lock after its boundary", locks(afterBoundary.fills).length === 0 && afterBoundary.state.gateReason === "entry-stop");
}

// ── 8c. Confirmation requires the same qualified side to persist continuously ──
{
  const held = runRound([
    tick(100, 500, 0.85, 0.16, 100),
    tick(100.6, 500, 0.85, 0.16, 100),
  ], { L_ENTRY_CONFIRM_MS: 500 });
  const flipped = runRound([
    tick(100, 500, 0.85, 0.16, 100),
    tick(100.6, -500, 0.16, 0.85, 100),
  ], { L_ENTRY_CONFIRM_MS: 500 });
  ok("entry-confirm locks after the qualified side persists", locks(held.fills).length === 1);
  ok("entry-confirm resets instead of locking when the leader flips", locks(flipped.fills).length === 0 && flipped.state.gateReason === "entry-confirm");
}

// ── 9. End-hedge OFF by default: an unhedged winner RIDES to settlement (stays open) ──
{
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.30, 100),  // LOCK Up; loser never gets cheap (stays 0.30)
    tick(260, 60, 0.85, 0.30, 100),
    tick(298, 60, 0.90, 0.30, 100),  // near close — default L_END_HEDGE_S=0 → no force hedge
  ]);
  ok("no forced end-hedge by default", hedges(fills).length === 0);
  ok("unhedged winner rides to settlement (still open)", state.positions.length === 1 && state.positions[0].side === "Up");
}

// ── 10. Pause window: no lock during a blackout UTC hour ──
{
  const { fills } = runRound([tick(270, 50, 0.85, 0.16, 100)], { L_PAUSE: [[15, 15]] });  // winHour 15 blacked out
  ok("no lock during a pause window", locks(fills).length === 0);
}

// ── 11. MAKER HEDGE: rests a bid below the loser's ask, fills over ticks at the limit, completes the set fee-free ──
{
  const mk = { L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: 0.01, L_SIM_TOUCH_MS: 100, L_COOLDOWN_MS: 0 };  // touchMs≤dtMs(120) → fills at touch in one tick
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.05, 100),  // LOCK Up @0.82; Down 0.05 > cap → no hedge start
    tick(250, 60, 0.85, 0.02, 100),  // Down 0.02 ≤ cap → START maker rest at mlim = 0.02−0.01 = 0.01
    tick(260, 60, 0.85, 0.01, 100),  // ask touches the 0.01 bid → maker fills → set complete
  ], mk);
  const h = hedges(fills)[0];
  ok("maker hedge fills at the resting limit (below the ask)", h && h.exec === "maker" && h.side === "Down" && Math.abs(h.effPx - 0.01) < 1e-9);
  ok("maker hedge closes the position", state.positions.length === 0);
  // maker realized = (1−0.82−0.01)×40 − entryFee − 0 ≈ 6.39; the taker-at-0.02 equivalent (fee-paying) ≈ 5.93.
  ok("maker hedge is cheaper + fee-free (beats the taker-at-cap net)", state.realizedWin > 6.3 && state.realizedWin < 6.5);
}

// ── 12. MAKER hedge stays RESTING while the loser's ask is above the bid (adverse-selection / no-fill case) ──
{
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.02, 100),  // LOCK Up (hedging starts next tick — the lock returns before managing)
    tick(250, 60, 0.85, 0.02, 100),  // Down 0.02 ≤ cap → START maker rest at 0.01
    tick(260, 60, 0.85, 0.03, 100),  // ask 0.03 back above the 0.01 bid → no fill, still resting
  ], { L_HEDGE_EXEC: "maker", L_SIM_TOUCH_MS: 100, L_COOLDOWN_MS: 0 });
  ok("maker hedge rests unfilled while the ask is above the bid", hedges(fills).length === 0 && state.positions.length === 1 && !!state.positions[0].makerHedge);
}

// ── 13. END-HEDGE forces a TAKER even in maker mode (a resting bid might never fill before close) ──
{
  const { fills } = runRound([
    tick(240, 60, 0.82, 0.30, 100),  // LOCK; loser expensive → no maker rest started
    tick(290, 60, 0.85, 0.30, 100),  // secsLeft 10 ≤ end-hedge 15 → FORCE hedge as a taker at 0.30
  ], { L_HEDGE_EXEC: "maker", L_END_HEDGE_S: 15, L_COOLDOWN_MS: 0 });
  const h = hedges(fills)[0];
  ok("end-hedge forces a taker fill in maker mode", h && h.kind === "taker" && h.reason === "end-hedge" && Math.abs(h.effPx - 0.30) < 1e-9);
}

// ── 14. Taker mode unchanged by the maker plumbing (regression) ──
{
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.19, 100),
    tick(260, 60, 0.98, 0.02, 100),  // taker hedge at the 0.02 ask
  ], { L_HEDGE_EXEC: "taker" });
  ok("taker mode still hedges as a marketable taker", hedges(fills)[0]?.kind === "taker" && state.positions.length === 0);
}

// ── 15. HOUR GATE / WEEKDAY GATE: no NEW lock outside the active UTC hours / weekdays (ticks are winHour 15, winDay 3) ──
{
  const armed = tick(270, 50, 0.85, 0.16, 100);   // would lock (decisive), winHour 15 winDay 3
  ok("hour gate: no lock when winHour not in L_HOURS", runRound([armed], { L_HOURS: [12, 13, 14] }).fills.filter((f) => f.leg === "entry").length === 0);
  ok("hour gate: locks when winHour IS in L_HOURS", runRound([armed], { L_HOURS: [14, 15, 16] }).fills.filter((f) => f.leg === "entry").length === 1);
  ok("weekday gate: no lock when winDay not in L_DAYS", runRound([armed], { L_DAYS: [1, 2] }).fills.filter((f) => f.leg === "entry").length === 0);
  ok("weekday gate: locks when winDay IS in L_DAYS (Wed=3)", runRound([armed], { L_DAYS: [3, 4, 5] }).fills.filter((f) => f.leg === "entry").length === 1);
}

// ── 16. MAKER FILL TIMEOUT: a resting maker not fully filled past the timeout → taker-completes the UNFILLED remainder ──
{
  // touch fills 20%×(120/1000)×40 ≈ 0.96 sh/tick → still partial after 2s → taker the rest.
  const mk = { L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: 0.01, L_SIM_FILL_PCT: 20, L_SIM_TOUCH_MS: 1000,
               L_HEDGE_MAKER_TIMEOUT_S: 2, L_COOLDOWN_MS: 0 };
  const { state, fills } = runRound([
    tick(240, 60, 0.82, 0.19, 100),  // LOCK Up @0.82; loser 0.19 > cap → no hedge yet
    tick(241, 60, 0.82, 0.02, 100),  // loser 0.02 ≤ cap → START maker rest at 0.01 (startT=241), ask 0.02 > bid → no fill
    tick(242, 60, 0.82, 0.01, 100),  // ask 0.01 = bid → partial touch fill (~0.96); elapsed 1s < 2 → hold
    tick(243, 60, 0.82, 0.01, 100),  // elapsed 2s ≥ timeout, still partial → TAKER the remainder → set complete
  ], mk);
  const h = hedges(fills);
  const mkFill = h.find((x) => x.kind === "maker"), tkFill = h.find((x) => x.reason === "maker-timeout-taker");
  ok("partial-timeout emits a maker partial + a taker remainder", !!mkFill && !!tkFill && h.length === 2);
  ok("maker+taker shares sum to the winner size (set balanced)", !!mkFill && !!tkFill && Math.abs((mkFill.shares + tkFill.shares) - locks(fills)[0].shares) < 1e-6);
  ok("taker remainder pays the loser ask (0.01)", tkFill && Math.abs(tkFill.effPx - 0.01) < 1e-9);
  ok("position closed after partial-completion", state.positions.length === 0);

  // ZERO fill: the ask never comes back to the bid → 0 filled after 2s → NO taker completion (rides naked, still open)
  const { state: st0, fills: f0 } = runRound([
    tick(240, 60, 0.82, 0.19, 100),  // LOCK Up
    tick(241, 60, 0.82, 0.02, 100),  // loser 0.02 ≤ cap → START maker rest at 0.01
    tick(242, 60, 0.82, 0.05, 100),  // ask 0.05 back above the 0.01 bid → 0 filled; elapsed 1s
    tick(243, 60, 0.82, 0.05, 100),  // elapsed 2s but STILL 0 filled → timeout does NOT fire → rides naked
  ], mk);
  ok("zero-fill → timeout does NOT taker (rides naked)", hedges(f0).length === 0 && st0.positions.length === 1);

  // OFF by default (L_HEDGE_MAKER_TIMEOUT_S=0): the same round rests unfilled → NO taker completion, still open
  const off = runRound([
    tick(240, 60, 0.82, 0.19, 100), tick(241, 60, 0.82, 0.02, 100),
    tick(242, 60, 0.82, 0.01, 100), tick(243, 60, 0.82, 0.01, 100),
  ], { L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: 0.01, L_SIM_FILL_PCT: 20, L_SIM_TOUCH_MS: 1000, L_COOLDOWN_MS: 0 });
  ok("timeout OFF (0) → no taker completion, leg still resting", off.fills.filter((f) => f.reason === "maker-timeout-taker").length === 0 && off.state.positions.length === 1);
}

// ── 17. EAGER placement: rest the maker bid immediately after the lock — at the cap while the loser is still expensive ──
{
  const { state } = runRound([
    tick(240, 60, 0.82, 0.30, 100),  // LOCK Up; loser Down 0.30 > cap
    tick(241, 60, 0.82, 0.30, 100),  // eager → rest a maker bid AT the cap (0.02) now, even though the loser is still 0.30
  ], { L_HEDGE_EXEC: "maker", L_HEDGE_EAGER: true, L_COOLDOWN_MS: 0 });
  ok("eager rests at the cap while the loser is still expensive", state.positions[0]?.makerHedge?.limit === 0.02);
  const w = runRound([tick(240, 60, 0.82, 0.30, 100), tick(241, 60, 0.82, 0.30, 100)], { L_HEDGE_EXEC: "maker", L_COOLDOWN_MS: 0 });
  ok("WAIT mode (default) does NOT place while the loser is expensive", !w.state.positions[0]?.makerHedge);
  // eager, loser ALREADY ≤ cap at placement → tighten to 1¢-under (0.01), not the cap
  const cheap = runRound([tick(240, 60, 0.82, 0.30, 100), tick(241, 60, 0.82, 0.02, 100)], { L_HEDGE_EXEC: "maker", L_HEDGE_EAGER: true, L_COOLDOWN_MS: 0 });
  ok("eager tightens to 1¢-under when the loser is already ≤ cap", cheap.state.positions[0]?.makerHedge?.limit === 0.01);
}

console.log(`\nstrategy.lockstep.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
