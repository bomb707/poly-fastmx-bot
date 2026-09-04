// Historical/live ledgers may contain on-chain merge records. This accounting
// helper remains for compatibility; the FastMX strategy does not decide merges.

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
