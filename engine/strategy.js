/**
 * strategy.js — LOCKSTEP strategy: end-of-round certainty LOCK + cheap-loser HEDGE (volatility-bound).
 *
 * THE IDEA (full write-up: research/lockstep-spec.txt). As a 5-minute BTC "Up or Down" round runs down, less
 * time remains for the price to move. If BTC has already moved further from the round's OPEN than it could
 * realistically move back in the time left, the current leader is very likely the final winner even though
 * the market hasn't settled. Lockstep detects that moment, BUYS THE WINNING side (the "lock"), then buys the
 * near-dead LOSING side for pennies (the "hedge") — a paired $1 set that pays out no matter how the round
 * settles, for a combined cost below $1. The signal is pure price + recent realized volatility.
 *
 *   GAP           = current BTC spot − round OPEN            (tk.bzGap; its sign is the current leader)
 *   POSSIBLE MOVE = INTENSITY × timeLeftFraction(secsLeft)  (tk.intensity, from the volatility sensor)
 *   LOCK when      |GAP| > POSSIBLE MOVE                     (a reversal is improbable in the time left)
 *
 * This ONE function is the single source of truth: driven live by src/execution/shadow.js AND replayed by the
 * backtest in engine/simrun.js, so live and backtest can never diverge.
 *
 * Reused, strategy-agnostic execution libs stay intact: engine/fillsim.js (latency), engine/mergesim.js
 * (merge-on-profit), src/lib/executor.js (real orders + status watch). injectRealFill / applyManualHedge /
 * clearLivePending below are leg-based and unchanged. Earlier experimental cores remain in git history.
 */

import { maybeMerge } from "./mergesim.js";      // merge-sim model (MERGE ON PROFIT decision)
import { makerTouchFill } from "./fillsim.js";   // resting-maker fill sim (maker hedge mode; taker hedge doesn't use it)

// ── FEES ── framework infra (bot + sim PnL use this so they match). Leave as-is unless changing the fee model.
export const PARAMS = {
  FEE_BPS: 700,          // taker fee (bps of symmetric notional): 700 = 7%
  FEE_USE_MIN: false,    // symmetric notional = px·(1−px) (false) vs min(px,1−px) (true)
  FEE_ALL_FILLS: false,  // charge every fill? (else only takers)
};

// ── STRATEGY PARAMS ── the UI menu / setParams override these. Framework knobs first, then the Lockstep knobs.
export const STRAT = {
  // framework
  SIZE: 40,              // shares per LOCK (winning side). Hedge matches the leg's share count.
  LIMIT: 0.99,           // hard buy ceiling — fill at ask only when ask ≤ LIMIT (both legs are marketable takers).
  MIN_ORDER_USD: 1,      // POLYMARKET MIN ORDER — bump an order's share count so shares×fillPx ≥ this $ (venue rejects
                         //   < $1). Applied to the LOCK here; the HEDGE min is handled downstream by executor.placeBuy
                         //   (bump) + injectRealFill (books the matched p.shares) so the tracked set stays balanced. 0 = off.
  TICK: 0.01,            // price tick
  LATENCY_MS: 520,       // SIM/backtest TAKER fill latency (ms). A marketable order fills at the ask this long AFTER
                         //   the decision. No effect on REAL live (books the real fill). Passive-maker queue placement
                         //   is modeled independently at 130ms.
  WINDOW_SEC: 300,       // round length (s); set by the UI per market (BTC 5m = 300).

  // ── LOCKSTEP ──
  L_ON: true,            // enable the strategy.

  // VOLATILITY SENSOR (the "possible remaining move" estimate — see engine/intensity.js). The buffer of recent
  //   completed-round excursions is owned upstream (shadow live / backtest driver) and INTENSITY is stamped on the
  //   tick as tk.intensity; these knobs tell the sensor how to compute it.
  L_VOL_ROUNDS: 6,       // # of most-recent COMPLETED rounds in the volatility window (6 × 5m ≈ 30 min).
  L_VOL_MODE: "max",     // "max" (cautious: largest recent per-round excursion) | "smooth" (drop hi+lo of the window,
                         //   average the rest — steadier, usually smaller ⇒ more entries).
  L_SCALING: "sqrt",     // time-left scaling: "linear" (frac = secsLeft/WINDOW_SEC) | "sqrt" (frac = √(secsLeft/WIN)).
                         //   DEFAULT sqrt: a random walk's range grows as √time, so this is the physically-correct model
                         //   — it keeps POSSIBLE MOVE larger mid-round, locking only GENUINELY-decided rounds.
  L_EDGE_BUFFER: 8,      // extra $ cushion added to POSSIBLE MOVE before locking (demands a larger gap ⇒ fewer, higher-
                         //   confidence locks ⇒ the un-hedgeable "naked winner" legs win more often, cutting their drag).
                         //   ⚠ In $ of the UNDERLYING — revalidate per asset and under the current latency model. 0 = off.

  // ENTRY (the lock)
  L_MIN_GAP: 0,          // require |GAP| ≥ this many $ before considering a lock (filters marginal signals). 0 = off.
  L_ENTRY_FLOOR: 0.50,   // do NOT lock if the winner's ask < this — below 0.50 the market treats it as a coin flip
                         //   (no certainty edge to capture).
  L_ENTRY_CEIL: 0.88,    // do NOT lock if the winner's ask > this — the 2026-08-24 frozen 30d replay was positive at
                         //   0.88 and negative with the formerly persisted high-cap profile. 0 = off.
  L_ENTRY_STOP_S: 0,     // optional seconds-from-open cutoff for NEW locks. 0 = disabled. Unlike SKIP-END, this is an
                         //   early-regime gate: e.g. 120 permits entries only during the first two minutes.
  L_ENTRY_CONFIRM_MS: 0, // optional continuous qualification time before entry. A side flip, lock-inequality failure,
                         //   or price-band failure resets the timer. 0 = immediate decision.
  L_SKIP_END_S: 5,       // no NEW locks in the final this-many seconds (too little time to also hedge/fill). Hedging of
                         //   an EXISTING leg still runs in this window.
  L_SKIP_OPEN_S: 0,      // ignore the first this-many seconds of a round (gap tiny, estimate least meaningful). 0 = off.
  L_MIN_TIME_S: 1,       // require at least this many seconds left to act at all.
  L_ONE_PER_ROUND: true, // buy the winning side only ONCE per round; after that only hedging is permitted.
  L_MAX_ENTRIES: 8,      // hard cap on buys (locks + hedges) per round — over-trade backstop.
  L_COOLDOWN_MS: 1500,   // minimum time between any two buys.

  // HEDGE (grab the cheap loser → complete a $1 set): hedge when the loser's ask ≤ L_HEDGE_CAP AND the completed
  //   pair still nets at least L_HEDGE_MIN_PROFIT per share after fees.
  L_HEDGE_CAP: 0.02,     // max ask to pay for the losing side.
  L_HEDGE_MODE: "price", // "price" = require the ask cap + profit floor | "profit" = ignore the cap and use only
                         //   the fee-inclusive profit floor. Lockstep defaults to price mode.
  L_HEDGE_MIN_PROFIT: 0, // minimum guaranteed completed-pair profit PER SHARE after fees. 0 preserves Lockstep's
                         //   original strictly-positive-profit gate; Gap Predictor overrides this to 0.03.
  L_HEDGE_EXEC: "maker", // HOW to hedge. "taker" (marketable — pay the loser's ask, fills now, pays the taker fee) |
                         //   "maker" (rest a passive bid L_HEDGE_MAKER_OFFSET below the loser's ask → fills cheaper AND
                         //   fee-free IF it fills, but may not fill / adverse-selects — fills mostly when the loser is
                         //   about to WIN). The end-of-round force-hedge ALWAYS uses taker (a rest might never fill).
  L_HEDGE_MAKER_OFFSET: 0.01,  // maker mode: rest the bid this far ($, price) below the loser's ask (≥ 0.01 floor).
  L_HEDGE_MAKER_TIMEOUT_S: 0,  // maker mode: if the resting hedge is only PARTIALLY filled after this many seconds,
                               //   cancel it and TAKER-buy the UNFILLED remainder to complete the set now. Fires only
                               //   when SOME filled (the loser reached the bid) — a ZERO fill rides naked. 0 = off.
  L_HEDGE_EAGER: false,        // maker mode: place the resting bid IMMEDIATELY after the lock — at the cap while the
                               //   loser is still expensive (ask > cap), tightening to 1¢-under once ask ≤ cap. false =
                               //   WAIT until the loser's ask is ≤ cap before resting (bids 1¢-under). Eager catches
                               //   faster collapses but tends to fill AT the cap (0.02) vs 0.01 — backtest before enabling.
  // NOTE: a "trailing peg" (ratcheting the bid down to follow the ask) is a mechanical NO-OP here — a bid below the
  //   ask only fills when the ask comes DOWN to it, so trailing it down never gets hit (30d backtest: byte-identical to
  //   fixed). A margin-guarded maker→taker fallback HURT (−$82/30d @ 15s). And a STOP-LOSS hedge (winner ask ≤ entry×frac
  //   → taker the loser) LOST at every threshold (30d @500ms: −$213..−$621/30d) — even at 65% correct flips, the
  //   dip→recover false triggers cost ~1.5× what the flips save; it caps per-trade tail loss but raises TOTAL loss.
  //   Every "buy the loser / complete the set" variant forgoes the higher-EV naked winner. Verdict: fixed maker@1¢ +
  //   ride-naked-on-unfilled is the hedge optimum. Do not re-add.
  L_SIM_FILL_PCT: 100,   // SIM/backtest ONLY (maker hedge): % of the resting order that fills per L_SIM_TOUCH_MS while the
                         //   loser's ask sits AT the bid; the whole remainder when the ask crosses BELOW it; nothing above.
                         //   100 = fills in one interval. No effect on real live (books the real CLOB fill) or taker mode.
  L_SIM_TOUCH_MS: 250,   // SIM/backtest ONLY (maker hedge): the time to accrue one L_SIM_FILL_PCT chunk at the touch.
  L_END_HEDGE_S: 0,      // force-HEDGE any still-open winner this many s before close (TAKER). 0 = OFF (Lockstep
                         //   DELIBERATELY rides an unhedged winner — the likely winner — to settlement).

  // PAUSE WINDOWS (UTC)
  // SCHEDULE (whitelist gates) — restrict WHEN new locks may open (open positions still hedge/settle regardless).
  L_HOURS: [],           // HOUR GATE — array of active UTC hours (0-23) in which to OPEN new locks. [] = every hour.
  L_DAYS: [],            // WEEKDAY GATE — array of active UTC weekdays (0=Sun … 6=Sat) to OPEN new locks. [] = every day.
  L_PAUSE: [],           // blackout UTC hour ranges, e.g. [[0,5],[7,7]] = pause 00:00–05:59 and 07:00–07:59. No new
                         //   locks in these hours. [] = never pause.
  L_PAUSE_HEDGE: false,  // also pause HEDGING during a blackout? false = keep hedging (finish balancing open sets).

  // ── REAL-FILL-DRIVEN STATE (live only) — advance state.positions on REAL fills (shadow.injectRealFill) instead of
  //   the modeled sim fill, so live decisions reflect what actually filled. No-op off live (sim/backtest byte-identical).
  LIVE_FILLS: false,
  // NAKED-timing guard (live only): pull the no-new-lock cutoff (and any end-hedge) this many seconds EARLIER,
  //   giving an order time to reach the book before the close. The active taker model is 520ms; margin remains
  //   deliberately wider for network jitter and venue processing. No-op off live.
  L_LIVE_CLOSE_MARGIN_S: 8,
};

// passesGate — retained for import compatibility (simrun re-exports it). No gate.
export function passesGate() { return true; }

// Shares a `usd` taker slice buys at `ask`, fee carved out of the slice. Helper for USD-budget sizing.
export function takerShares(ask, usd) { return usd / (ask + fillFee(ask, 1, true)); }

// inPauseWindow — is `hour` inside any [start,end] UTC range (inclusive)? Ranges may wrap midnight (start > end).
function inPauseWindow(hour, ranges) {
  if (hour == null || !Array.isArray(ranges) || !ranges.length) return false;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const a = +r[0], b = +r[1];
    if (!isFinite(a) || !isFinite(b)) continue;
    if (a <= b) { if (hour >= a && hour <= b) return true; }
    else { if (hour >= a || hour <= b) return true; }   // wraps midnight
  }
  return false;
}

/**
 * stepSignalHedge — advance the LOCKSTEP strategy ONE tick. Mutate `state`, return the fills booked this tick ([] = none).
 *
 *   state : per-round causal state — self-initialized here; the harness gives a fresh object each round, so the
 *           per-round counters (lockedThisRound / entriesThisRound / lastBuyMs) reset automatically.
 *   tk    : the live tick —
 *             tk.t         seconds into the round
 *             tk.up/tk.down  { bestBid, bestAsk, fillAsk? }   the CLOB Up/Down token books
 *             tk.bzGap     Binance spot − round OPEN ($) = GAP; its SIGN is the current leader
 *             tk.intensity the volatility sensor's INTENSITY ($) from recent COMPLETED rounds (attached upstream);
 *                          null/undefined ⇒ the volatility window isn't ready ⇒ do not lock
 *             tk.winHour / tk.winDay   UTC hour / weekday of the round (constant per round)
 *   P     : merged params (STRAT + UI/live overrides).   dtMs / clockMs: tick spacing / wall clock (ms).
 */
export function stepSignalHedge(state, tk, P, dtMs = 120, clockMs = tk.t * 1000) {
  if (state.placedThisTick) state.placedThisTick.length = 0; else state.placedThisTick = [];
  state.orders = state.orders || [];
  state.seq = state.seq || 0;
  if (!Array.isArray(state.positions)) state.positions = [];   // OPEN winner legs — { side, shares, entryPx, oid }
  if (state.realizedWin === undefined) state.realizedWin = 0;   // this round's closed (realized) PnL — diagnostics
  if (state.entriesThisRound === undefined) state.entriesThisRound = 0;   // buys (locks+hedges) this round → L_MAX_ENTRIES
  if (state.lastBuyMs === undefined) state.lastBuyMs = -1e12;   // last buy wall-clock → L_COOLDOWN_MS
  // MERGE accounting (hedge completes a balanced $1-set): track the accumulated sets' cost basis so maybeMerge can
  //   reclaim them (fee-free CTF merge) once locked profit ≥ MERGE_X. Ledger banks mergedRealized, not here.
  if (state.mUpSh === undefined) { state.mUpSh = 0; state.mDnSh = 0; state.mUpCost = 0; state.mDnCost = 0; state.mFee = 0; }

  const out = [];
  // MERGE re-check EVERY tick: a complete balanced set is mergeable anytime (its profit is fixed once it forms).
  if (P.MERGE_ON) maybeMerge(state, out, tk, P);

  const up = tk.up, dn = tk.down;
  if (!P.L_ON || !up || !dn || up.bestAsk == null || dn.bestAsk == null) { state.gateReason = "off"; return out; }

  const upAsk = up.bestAsk, dnAsk = dn.bestAsk;
  const absCap = P.LIMIT ?? 0.99;
  // FILL prices: a marketable order lands ~LATENCY_MS after the DECISION → it fills at the ask THEN, not now. simrun
  //   attaches fillAsk (the ask LATENCY_MS in the future); live has none (undefined) → current ask, and shadow.js
  //   defers/re-prices the booking. DECISIONS/gates always use bestAsk; only the booked effPx uses the delayed ask.
  const upFill = up.fillAsk != null ? up.fillAsk : upAsk, dnFill = dn.fillAsk != null ? dn.fillAsk : dnAsk;

  const winSec = P.WINDOW_SEC || 300;
  const secsLeft = winSec - tk.t;
  const liveFills = P.LIVE_FILLS === true || P.LIVE_FILLS === 1 || P.LIVE_FILLS === "true";
  const liveMargin = liveFills ? (+P.L_LIVE_CLOSE_MARGIN_S || 0) : 0;
  const hedgePaused = P.L_PAUSE_HEDGE === true && inPauseWindow(tk.winHour, P.L_PAUSE);

  // ── MANAGE THE OPEN WINNER LEG: hedge the cheap loser (complete the $1 set) or hold it (ride to settlement). ──
  //   One-at-a-time: with L_ONE_PER_ROUND (default) there is at most one winner leg. Runs BEFORE the lock gate.
  if (state.positions.length) {
    const keep = [];
    const makerHedge = String(P.L_HEDGE_EXEC || "taker").toLowerCase() === "maker";
    // Books a COMPLETED $1-set into the ledger (sim path). hpx = the hedge fill price; hIsTaker = pays the taker fee.
    const bookSet = (p, hpx, hIsTaker) => {
      const efee = fillFee(p.entryPx, p.shares, !p.maker);          // winner entry fee (fee-free if it was a maker fill)
      const hfee = hIsTaker ? fillFee(hpx, p.shares, true) : 0;     // hedge fee: taker pays, maker is fee-free
      state.realizedWin += (1 - p.entryPx - hpx) * p.shares - efee - hfee;
      const eCost = +(p.entryPx * p.shares).toFixed(4), oCost = +(hpx * p.shares).toFixed(4);
      if (p.side === "Up") { state.mUpSh += p.shares; state.mUpCost += eCost; state.mDnSh += p.shares; state.mDnCost += oCost; }
      else { state.mDnSh += p.shares; state.mDnCost += eCost; state.mUpSh += p.shares; state.mUpCost += oCost; }
      state.mFee += efee + hfee;
      if (P.MERGE_ON) maybeMerge(state, out, tk, P);
    };
    // Books a set whose HEDGE is BLENDED: mkSh @ mkPx as a fee-free maker fill + tkSh @ tkPx as a taker (fee-paying)
    //   fill (the L_HEDGE_MAKER_TIMEOUT_S partial-completion). Same accounting as bookSet, blended hedge cost.
    const bookSetBlended = (p, mkSh, mkPx, tkSh, tkPx) => {
      const efee = fillFee(p.entryPx, p.shares, !p.maker);
      const hfee = fillFee(tkPx, tkSh, true);                        // taker fee on the remainder only (maker part free)
      const hedgeCost = mkSh * mkPx + tkSh * tkPx;
      state.realizedWin += (p.shares - p.entryPx * p.shares - hedgeCost) - efee - hfee;
      const eCost = +(p.entryPx * p.shares).toFixed(4), oCost = +hedgeCost.toFixed(4);
      if (p.side === "Up") { state.mUpSh += p.shares; state.mUpCost += eCost; state.mDnSh += p.shares; state.mDnCost += oCost; }
      else { state.mDnSh += p.shares; state.mDnCost += eCost; state.mUpSh += p.shares; state.mUpCost += oCost; }
      state.mFee += efee + hfee;
      if (P.MERGE_ON) maybeMerge(state, out, tk, P);
    };
    for (const p of state.positions) {
      // LIVE: this leg's hedge order is already out (taker OR resting maker), awaiting its REAL fill → hold, don't re-decide.
      if (liveFills && p.hedgePending) { keep.push(p); continue; }
      // LIVE: don't hedge until the LOCK is FULLY filled — a partial lock would produce a lopsided set (and a late
      //   lock fill would then over-fill vs the hedge). Wait for the resting remainder to fill. reqShares is set
      //   from the requested lock size on the real fill; absent in sim (synchronous full fill) → this is a no-op.
      if (liveFills && p.reqShares != null && p.shares < p.reqShares - 1e-6) { keep.push(p); state.gateReason = "lock-partial"; continue; }
      const loseSide = p.side === "Up" ? "Down" : "Up";
      const loseAsk = loseSide === "Up" ? upAsk : dnAsk;     // decision uses bestAsk
      const loseArrivalAsk = loseSide === "Up" ? upFill : dnFill;   // sim/backtest: ask at decision+latency
      const cap = (P.L_HEDGE_CAP != null && isFinite(+P.L_HEDGE_CAP)) ? +P.L_HEDGE_CAP : 0.02;
      const off = (P.L_HEDGE_MAKER_OFFSET != null && +P.L_HEDGE_MAKER_OFFSET >= 0) ? +P.L_HEDGE_MAKER_OFFSET : 0.01;
      // Optional end-of-round force-hedge (OFF by default). ALWAYS a taker — a resting maker might never fill before close.
      const endS = (+P.L_END_HEDGE_S || 0);
      const endHedge = endS > 0 && !hedgePaused && secsLeft <= endS + liveMargin;
      const overCap = state.entriesThisRound >= (+P.L_MAX_ENTRIES || 8);   // buy-count backstop still applies to hedges

      // ── SIM MAKER HEDGE (accrual): a resting bid on the loser fills over ticks. endHedge overrides → taker below. ──
      if (!liveFills && makerHedge && p.makerHedge && !endHedge) {
        const mh = p.makerHedge;
        mh.filled = makerTouchFill({ askNow: loseAsk, limit: mh.limit, filled: mh.filled, target: p.shares, dtMs, touchMs: P.L_SIM_TOUCH_MS, fillPct: P.L_SIM_FILL_PCT });
        if (mh.filled >= p.shares - 1e-6) {                  // fully filled at the maker limit → complete the set (fee-free hedge)
          const hOid = ++state.seq;
          out.push({ tInto: tk.t, side: loseSide, shares: p.shares, effPx: mh.limit, usdc: +(mh.limit * p.shares).toFixed(4),
                     exec: "maker", limitPx: mh.limit, kind: "maker", leg: "hedge", reason: "lockstep-maker", status: "full", oid: hOid, maker: true });
          state.entriesThisRound++; state.lastBuyMs = clockMs;
          bookSet(p, mh.limit, /*hIsTaker*/ false);
          state.gateReason = "hedged-maker";
          continue;                                          // leg complete → dropped
        }
        // MAKER FILL TIMEOUT: the resting maker got SOME but not all (a PARTIAL fill) and has rested past
        //   L_HEDGE_MAKER_TIMEOUT_S → cancel it and TAKER the UNFILLED remainder (marketable) to finish the set now.
        //   Gated on filled>0: a partial means the loser DID hit the bid (was genuinely cheap), so the remainder is
        //   completed near that price. A ZERO fill (ask never reached the bid) is NOT completed — the winner rides
        //   naked, exactly as without the timeout. The maker portion books fee-free; the remainder pays the taker ask.
        const toS = +P.L_HEDGE_MAKER_TIMEOUT_S || 0;
        if (toS > 0 && mh.filled > 1e-6 && (tk.t - (mh.startT ?? tk.t)) >= toS && !overCap) {
          const timeoutLimit = Math.min(absCap, cap);
          if (loseArrivalAsk == null || loseArrivalAsk > timeoutLimit + 1e-9) {
            keep.push(p); state.gateReason = "hedge-limit-resting"; continue;
          }
          const loseFill = loseArrivalAsk;
          const rem = p.shares - mh.filled;
          const mOid = ++state.seq;                           // book the already-filled maker portion (fee-free)
          out.push({ tInto: tk.t, side: loseSide, shares: +mh.filled.toFixed(4), effPx: mh.limit, usdc: +(mh.limit * mh.filled).toFixed(4),
                     exec: "maker", limitPx: mh.limit, kind: "maker", leg: "hedge", reason: "lockstep-maker", status: "full", oid: mOid, maker: true });
          const tOid = ++state.seq;                           // taker the unfilled remainder at the current ask
          out.push({ tInto: tk.t, side: loseSide, shares: +rem.toFixed(4), effPx: loseFill, usdc: +(loseFill * rem).toFixed(4),
                     exec: "marketable", limitPx: timeoutLimit, kind: "taker", leg: "hedge", reason: "maker-timeout-taker", status: "full", oid: tOid });
          state.entriesThisRound++; state.lastBuyMs = clockMs;
          bookSetBlended(p, mh.filled, mh.limit, rem, loseFill);
          state.gateReason = "hedged-timeout-taker";
          continue;                                          // set complete → dropped
        }
        keep.push(p); state.gateReason = "maker-resting"; continue;   // still resting → hold
      }

      // Completed-pair economics for the DECISION. A balanced set pays exactly $1.
      const efee = fillFee(p.entryPx, p.shares, !p.maker);
      const hfee = fillFee(loseAsk, p.shares, true);
      const pairNet = (1 - p.entryPx - loseAsk) * p.shares - efee - hfee;   // causal decision economics at the current ask
      const minPairNet = Math.max(0, +P.L_HEDGE_MIN_PROFIT || 0) * p.shares;
      const pairMeetsProfit = pairNet > 0 && pairNet + 1e-12 >= minPairNet;
      const hedgeMode = String(P.L_HEDGE_MODE || "price").toLowerCase() === "profit" ? "profit" : "price";
      // MAKER bid price. EAGER: rest immediately after the lock — at the cap while the loser is still expensive
      //   (ask > cap), else 1¢-under. WAIT (default): only rest once the loser's ask is ≤ cap, at 1¢-under. Floor 0.01.
      const eager = !!P.L_HEDGE_EAGER && makerHedge;
      const mlim = eager ? (loseAsk > cap ? cap : Math.max(0.01, +(loseAsk - off).toFixed(4)))
                         : Math.max(0.01, +(loseAsk - off).toFixed(4));
      let wantHedge = false;
      if (!hedgePaused && loseAsk != null && loseAsk < 1) {
        if (eager) wantHedge = ((1 - p.entryPx - mlim) * p.shares - efee) > 0;   // place ASAP; skip only if the capped set can't profit
        else if (hedgeMode === "profit") wantHedge = pairMeetsProfit;             // fee-inclusive profit floor alone determines the max viable ask
        else wantHedge = loseAsk <= cap && pairMeetsProfit;                       // price mode: cheap ask AND the required guaranteed profit
      }
      if ((wantHedge || endHedge) && !overCap) {
        // MAKER hedge (not for the end-of-round force-hedge, which must guarantee a fill): rest a passive bid below the ask.
        if (makerHedge && !endHedge) {
          if (!liveFills) { p.makerHedge = { limit: mlim, filled: 0, startT: tk.t }; keep.push(p); state.gateReason = "maker-place"; continue; }
          // LIVE: place a resting POST-ONLY limit; reconcile books partial/full fills; hedgePending guards; stale-cancel frees it to re-hedge (taker near close).
          const hOid = ++state.seq;
          out.push({ tInto: tk.t, side: loseSide, shares: p.shares, effPx: mlim, usdc: +(mlim * p.shares).toFixed(4),
                     exec: "maker", limitPx: mlim, kind: "maker", leg: "hedge", reason: "lockstep-maker", status: "full", oid: hOid, maker: true, postOnly: true });
          state.entriesThisRound++; state.lastBuyMs = clockMs;
          p.hedgePending = hOid; keep.push(p); state.gateReason = "hedge-pending"; continue;
        }
        // TAKER hedge (default, or the forced end-hedge): pay the loser's ask now.
        // The submitted GTC limit must preserve the gate's economics.  A hedge
        // triggered at a 2¢ cap may not silently become a 99¢ buy while the
        // order is in flight.  End-hedge is the deliberate exception: it is an
        // emergency balance action and retains the global ceiling.
        const takerLimit = endHedge ? absCap : (hedgeMode === "price" ? Math.min(absCap, cap) : Math.min(absCap, loseAsk));
        if (loseArrivalAsk == null || loseArrivalAsk > takerLimit + 1e-9) {
          keep.push(p); state.gateReason = "hedge-limit-resting"; continue;
        }
        const loseFill = loseArrivalAsk;
        const hOid = ++state.seq;
        out.push({ tInto: tk.t, side: loseSide, shares: p.shares, effPx: loseFill, usdc: +(loseFill * p.shares).toFixed(4),
                   exec: "marketable", limitPx: takerLimit, kind: "taker", leg: "hedge",
                   reason: endHedge ? "end-hedge" : "lockstep", status: "full", oid: hOid });
        state.entriesThisRound++; state.lastBuyMs = clockMs;
        if (liveFills) { p.hedgePending = hOid; keep.push(p); state.gateReason = "hedge-pending"; }
        else { bookSet(p, loseFill, /*hIsTaker*/ true); state.gateReason = "hedged"; }
      } else { keep.push(p); state.gateReason = "hold"; }   // hold the winner (hedge not cheap enough yet, or paused)
    }
    state.positions = keep;
    return out;   // one-at-a-time: never lock a new winner on a tick where one is managed
  }

  // REAL-FILL guard: a live lock order is out but its real fill hasn't injected yet → don't fire another (the async gap).
  if (liveFills && state.livePendingEntry) { state.gateReason = "live-pending"; return out; }

  // ── LOCK GATES ──
  const intensity = tk.intensity;
  if (intensity == null || !(intensity > 0)) { state.gateReason = "vol-warmup"; return out; }   // sensor not ready
  if (secsLeft < (+P.L_MIN_TIME_S || 1)) { state.gateReason = "no-time"; return out; }
  if ((+P.L_SKIP_OPEN_S || 0) > 0 && tk.t < (+P.L_SKIP_OPEN_S)) { state.gateReason = "skip-open"; return out; }
  if ((+P.L_ENTRY_STOP_S || 0) > 0 && tk.t > (+P.L_ENTRY_STOP_S)) { state.gateReason = "entry-stop"; return out; }
  const skipEnd = (+P.L_SKIP_END_S || 0) + liveMargin;
  if (skipEnd > 0 && secsLeft <= skipEnd) { state.gateReason = "skip-end"; return out; }   // no NEW locks late
  if (inPauseWindow(tk.winHour, P.L_PAUSE)) { state.gateReason = "pause"; return out; }
  // SCHEDULE whitelist gates — only OPEN new locks during the configured UTC hours / weekdays (open legs still hedge).
  if (Array.isArray(P.L_HOURS) && P.L_HOURS.length && tk.winHour != null && !P.L_HOURS.includes(tk.winHour)) { state.gateReason = "hour-gate"; return out; }
  if (Array.isArray(P.L_DAYS) && P.L_DAYS.length && tk.winDay != null && !P.L_DAYS.includes(tk.winDay)) { state.gateReason = "day-gate"; return out; }
  if (P.L_ONE_PER_ROUND !== false && state.lockedThisRound) { state.gateReason = "locked"; return out; }
  if (state.entriesThisRound >= (+P.L_MAX_ENTRIES || 8)) { state.gateReason = "max-entries"; return out; }
  if (clockMs - state.lastBuyMs < (+P.L_COOLDOWN_MS || 0)) { state.gateReason = "cooldown"; return out; }

  const gap = tk.bzGap;
  if (gap == null) { state.gateReason = "no-gap"; return out; }
  const absGap = Math.abs(gap);
  if ((+P.L_MIN_GAP || 0) > 0 && absGap < (+P.L_MIN_GAP)) { state.gateReason = "min-gap"; return out; }

  // THE CORE INEQUALITY: BTC has already moved further from the open than it could realistically move back.
  const pMove = intensity * (P.L_SCALING === "sqrt" ? Math.sqrt(Math.max(0, secsLeft) / winSec) : Math.max(0, Math.min(1, secsLeft / winSec))) + (+P.L_EDGE_BUFFER || 0);
  if (!(absGap > pMove)) { state.lockCandidate = null; state.gateReason = "no-lock"; return out; }

  const side = gap > 0 ? "Up" : "Down";                         // the current (very-likely-final) leader
  const winAsk = side === "Up" ? upAsk : dnAsk;
  const entryLimit = (+P.L_ENTRY_CEIL || 0) > 0 ? Math.min(absCap, +P.L_ENTRY_CEIL) : absCap;
  if (winAsk == null || winAsk > entryLimit) { state.lockCandidate = null; state.gateReason = "no-ask"; return out; }
  if (winAsk < (+P.L_ENTRY_FLOOR || 0)) { state.lockCandidate = null; state.gateReason = "floor"; return out; }        // coin-flip zone → no edge
  if ((+P.L_ENTRY_CEIL || 0) > 0 && winAsk > (+P.L_ENTRY_CEIL)) { state.lockCandidate = null; state.gateReason = "ceil"; return out; }   // profit gone

  const confirmMs = Math.max(0, +P.L_ENTRY_CONFIRM_MS || 0);
  if (confirmMs > 0) {
    if (!state.lockCandidate || state.lockCandidate.side !== side || clockMs < state.lockCandidate.startMs) {
      state.lockCandidate = { side, startMs: clockMs };
      state.gateReason = "entry-confirm";
      return out;
    }
    if (clockMs - state.lockCandidate.startMs < confirmMs) { state.gateReason = "entry-confirm"; return out; }
  }

  // ── LOCK: buy the winning side (marketable taker) ──
  let sz = Math.max(1, Math.round(+P.SIZE || 40));
  const winFill = side === "Up" ? upFill : dnFill;
  // In a latency replay, an ask above the submitted ceiling means the GTC
  // rests; it is not a fill at the ceiling.  Live has no fillAsk override, so
  // the already-gated current ask remains marketable and emits normally.
  if (winFill == null || winFill > entryLimit + 1e-9) { state.gateReason = "entry-limit-resting"; return out; }
  { const minUsd = +P.MIN_ORDER_USD || 0;   // Polymarket min: bump against the FILL price (what it actually pays)
    const basis = winFill > 0 ? winFill : winAsk;
    if (minUsd > 0 && basis > 0 && basis * sz < minUsd - 1e-9) sz = Math.ceil(minUsd / basis); }
  const eOid = ++state.seq;
  out.push({ tInto: tk.t, side, shares: sz, effPx: winFill, usdc: +(winFill * sz).toFixed(4),
             exec: "marketable", limitPx: entryLimit, kind: "taker", leg: "entry", reason: "lock", status: "full", oid: eOid,
             intensity: +intensity.toFixed(2), pMove: +pMove.toFixed(2), sigGap: +absGap.toFixed(2) });   // signal snapshot @ lock (for the property menu)
  if (liveFills) { state.livePendingEntry = { side, shares: sz, oid: eOid, entryPx: winFill, placedT: tk.t }; }
  else state.positions.push({ side, shares: sz, entryPx: winFill, oid: eOid });
  state.lockedThisRound = true; state.entriesThisRound++; state.lastBuyMs = clockMs;
  state.lockCandidate = null;
  state.gateReason = liveFills ? "lock-pending" : "lock";
  return out;
}

/**
 * injectRealFill — REAL-FILL-DRIVEN STATE (live). shadow.js calls this when a REAL fill lands so state.positions
 * reflects what ACTUALLY filled. ENTRY(lock) leg opens/grows the position + clears the pending-entry guard; HEDGE leg
 * settles the balanced $1-set (accounting moved here from the decision tick). Caller feeds DELTA shares. No-op off live.
 * @param {object} state    engine/window state (shadow's `w`)
 * @param {object} f        { leg, side:"Up"|"Down", shares, px, oid }
 */
export function injectRealFill(state, f) {
  if (!state || !f) return;
  if (!Array.isArray(state.positions)) state.positions = [];
  if (state.realizedWin === undefined) state.realizedWin = 0;
  if (state.mUpSh === undefined) { state.mUpSh = 0; state.mDnSh = 0; state.mUpCost = 0; state.mDnCost = 0; state.mFee = 0; }
  const sh = +f.shares || 0, px = +f.px || 0;
  if (!(sh > 0)) return;
  if (f.leg === "entry" || f.leg == null) {                       // LOCK → open/grow the real position
    const ex = state.positions.find((p) => p.oid === f.oid);
    const pending = state.livePendingEntry && f.oid != null && state.livePendingEntry.oid === f.oid;
    // GROW only for a REAL oid (partials of the SAME order). A null-oid MANUAL buy opens its own leg (never blends by oid).
    if (ex && f.oid != null) { const tot = ex.shares + sh; ex.entryPx = (ex.entryPx * ex.shares + px * sh) / tot; ex.shares = tot; }
    else if (pending || f.oid == null) state.positions.push({ side: f.side, shares: sh, entryPx: px, oid: f.oid, real: true,
      reqShares: (pending && state.livePendingEntry) ? (+state.livePendingEntry.shares || sh) : sh });   // requested lock size → hedge waits until fully filled (manual buy: reqShares=sh, no wait)
    // else: non-null oid, no open leg AND not pending → already closed/superseded → IGNORE a late/stray fill.
    if (pending) state.livePendingEntry = null;
    return;
  }
  // HEDGE → settle the $1-set NOW using the REAL fill price. Only a NON-null oid matches the strategy's own hedge.
  const p = (f.oid != null) ? state.positions.find((x) => x.hedgePending === f.oid) : null;
  if (!p) return;
  const n = Math.min(sh, p.shares);
  const efee = fillFee(p.entryPx, n, true);
  state.realizedWin += (1 - p.entryPx - px) * n - efee - fillFee(px, n, true);
  const eCost = +(p.entryPx * n).toFixed(4), oCost = +(px * n).toFixed(4);
  if (p.side === "Up") { state.mUpSh += n; state.mUpCost += eCost; state.mDnSh += n; state.mDnCost += oCost; }
  else { state.mDnSh += n; state.mDnCost += eCost; state.mUpSh += n; state.mUpCost += oCost; }
  state.mFee += efee + fillFee(px, n, true);
  p.shares -= n;
  if (p.shares <= 1e-6) state.positions = state.positions.filter((x) => x !== p);   // fully hedged → drop
  // else: KEEP p.hedgePending — the same hedge order still works the remainder (real partials arrive under this oid).
}

/** MANUAL HEDGE (operator hedged before the bot): settle the open legs it covers so the engine won't hedge them again.
 *  A hedge on `hedgeSide` covers open legs on the OPPOSITE (held) side. Settles FIFO up to `shares` at the real hedge
 *  price `px` — same $1-set accounting as a bot hedge, so realizedWin stays consistent. Returns shares settled. */
export function applyManualHedge(state, hedgeSide, shares, px) {
  if (!state || !Array.isArray(state.positions)) return 0;
  let remaining = +shares || 0; const hpx = +px || 0;
  if (!(remaining > 0)) return 0;
  const heldSide = hedgeSide === "Up" ? "Down" : "Up";
  if (state.realizedWin === undefined) state.realizedWin = 0;
  const keep = []; let settled = 0;
  for (const p of state.positions) {
    if (remaining <= 1e-6 || p.side !== heldSide || p.hedgePending) { keep.push(p); continue; }
    const n = Math.min(remaining, p.shares);
    // realizedWin is GATING/diagnostic only (not reported PnL); deliberately DON'T touch merge-sets (manual shares
    //   aren't in the sim ledger → feeding them to merge-sets would underflow applyMerge when MERGE_ON).
    state.realizedWin += (1 - p.entryPx - hpx) * n - fillFee(p.entryPx, n, true) - fillFee(hpx, n, true);
    p.shares -= n; remaining -= n; settled += n;
    if (p.shares > 1e-6) keep.push(p);
  }
  state.positions = keep;
  return +settled.toFixed(4);
}

/** Clear a live pending order that will NOT fill (real order canceled / rejected / expired) → the engine may retry:
 *  release the entry guard AND any hedge-pending flag on the matching leg (so it re-hedges / re-locks). */
export function clearLivePending(state, oid) {
  if (!state) return;
  if (state.livePendingEntry && (oid == null || state.livePendingEntry.oid === oid)) state.livePendingEntry = null;
  if (Array.isArray(state.positions)) for (const p of state.positions) { if (p.hedgePending && (oid == null || p.hedgePending === oid)) p.hedgePending = null; }
}

// maybeMerge (MERGE ON PROFIT) lives in engine/mergesim.js — imported at the top.

// ── FEES (framework infra — leave as-is) ──
export function fillFee(px, shares, isTaker, p = PARAMS) {
  if (!isTaker || !p.FEE_BPS || px == null || shares == null) return 0;
  const sym = p.FEE_USE_MIN ? Math.min(px, 1 - px) : px * (1 - px);
  return (p.FEE_BPS / 10000) * sym * shares;
}
export function isTakerFill(f) {
  return f.taker === true || f.exec === "marketable" || (typeof f.kind === "string" && f.kind.includes("taker"));
}
export function isFeeFill(f, p = PARAMS) {
  return p.FEE_ALL_FILLS ? true : isTakerFill(f);
}
