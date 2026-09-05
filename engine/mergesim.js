// engine/mergesim.js — REUSABLE merge-sim model (MERGE ON PROFIT: reclaim balanced $1-sets, bank the profit).
//
// ── LIB BOUNDARY ─────────────────────────────────────────────────────────────────────────────────────
// Shared merge accounting supports persisted fills in the simulation ledger.
// The on-chain CTF merge adapter is src/execution/liveMerge.js (mergeOnChain).
//
// THE MODEL. When the hedge-accumulated position is BALANCED (equal Up/Down shares = complete $1-sets) and its
// guaranteed profit (fee-inclusive) ≥ MERGE_X, the strategy emits a fee-free "merge" record: reclaim $1 per set
// (CTF merge burns the set for $1), bank the realized profit, and reset the set accounting to flat — freeing the
// capital to keep scalping. PnL-neutral vs holding to settlement (balanced ⇒ if-up == if-down == guaranteed).
//
// MERGE RECORD CONTRACT (leg:"merge") — produced by maybeMerge, consumed by every ledger:
//   { sets, reclaimUsd, mainUpCost, mainDnCost, mainCost, mainFee, realized, ...(side:null, shares:0, kind:"merge") }
//   consumers: src/execution/shadow.js applyMerge (live ledger, via applyMergeToLedger) ·
//              engine/simrun.js positionFromFills (batch settlement) · src/execution/session.js.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * MERGE ON PROFIT decision. Mutates engine `state` (the merge-set accumulators mUpSh/mDnSh/mUpCost/mDnCost/mFee,
 * populated by the hedge legs) and pushes a merge record onto `out` when a balanced set clears MERGE_X. No-op
 * unless P.MERGE_ON. Does NOT write state.mergedRealized — the LEDGER banks `realized` (double-count otherwise;
 * in live, `state` IS the shadow window object).
 * @param {object} state  engine/window state
 * @param {Array}  out    the tick's output record list (merge record is pushed here)
 * @param {object} tk     the tick ({t})
 * @param {object} P      params (MERGE_ON, MERGE_X)
 */
export function maybeMerge(state, out, tk, P) {
  if (!P.MERGE_ON) return;
  const M = state.mUpSh;
  if (!(M > 0) || Math.abs(state.mUpSh - state.mDnSh) > 1e-6) return;   // only complete (balanced) sets merge
  const mCost = state.mUpCost + state.mDnCost, mFee = state.mFee;
  const guaranteed = M - mCost - mFee;                                  // balanced ⇒ if-up == if-down == this
  if (!(guaranteed >= (P.MERGE_X ?? 2) - 1e-9)) return;                 // must clear MERGE_X
  const realized = +guaranteed.toFixed(4);
  state.seq = (state.seq || 0) + 1;
  out.push({ tInto: tk.t, leg: "merge", reason: "merge", sets: +M.toFixed(4), reclaimUsd: +M.toFixed(4),
             mainUpCost: +state.mUpCost.toFixed(4), mainDnCost: +state.mDnCost.toFixed(4),
             mainCost: +mCost.toFixed(4), mainFee: +mFee.toFixed(4), realized,
             side: null, shares: 0, effPx: null, usdc: 0, status: "full", kind: "merge", oid: state.seq, placedT: tk.t, expireS: null });
  state.mUpSh = 0; state.mDnSh = 0; state.mUpCost = 0; state.mDnCost = 0; state.mFee = 0;   // reset → flat
}

/**
 * Apply a merge RECORD to a position ledger (incremental — used by the live shadow's applyMerge). Removes `sets`
 * from both sides + the merged shares' ACTUAL cost/fee, and BANKS the guaranteed profit + reclaimed collateral
 * into merged*. `L` is any object with upShares/downShares/cost/fee/upCost/downCost/mergedRealized/mergedUsd.
 * @returns {object} L (mutated)
 */
export function applyMergeToLedger(L, rec) {
  L.upShares -= rec.sets; L.downShares -= rec.sets;              // remove the merged main sets (special remains)
  L.cost -= (rec.mainCost || 0); L.fee -= (rec.mainFee || 0);    // remove the merged cost/fee (banked into realized)
  L.upCost -= (rec.mainUpCost || 0); L.downCost -= (rec.mainDnCost || 0);
  L.mergedRealized = (L.mergedRealized || 0) + (rec.realized || 0);   // → the "merged" card
  L.mergedUsd = (L.mergedUsd || 0) + (rec.reclaimUsd || 0);           // collateral reclaimed
  return L;
}
