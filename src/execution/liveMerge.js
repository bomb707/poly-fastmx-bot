// liveMerge.js — REAL on-chain CTF mergePositions for MERGE ON PROFIT (EXECUTION_MODE=live).
//
// Merge = combine a COMPLETE SET (equal Up + Down outcome tokens) back into $1 collateral, on-chain,
// BEFORE resolution. Fee-free (no CLOB fee — just Polygon gas). Fires when strategy.maybeMerge decides a
// balanced main cycle locked ≥ MERGE_X; index.js routes the shadow_merge event here.
//
// WALLET MODEL: mergePositions burns the outcome tokens from msg.sender. That only works when the SIGNER
// wallet itself holds the tokens (EOA funder = signer). If the funder is a Polymarket PROXY (a smart wallet
// that holds the tokens while the EOA merely signs), a direct call from the EOA would revert — the merge
// must be routed THROUGH the proxy's exec, which is proxy-type-specific. In that case we SKIP the on-chain
// merge (logged) — it costs nothing: the un-merged complete sets simply redeem $1 each at settlement, so PnL
// is unchanged (merge is only a capital-recycling optimization). The shadow already banked the profit.
import { ethers } from "ethers";
import { config } from "../config/config.js";
import { getKey, dkConfigured } from "../keys/dk.js";
import { resolveFunder } from "../lib/executor.js";
import { verbose, verboseOn } from "../logging/verbose.js";

const CTF_ADDR = (process.env.CTF_ADDRESS || "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045").trim();   // ConditionalTokens (Polygon)
const COLLATERAL_ADDR = (process.env.PUSD_ADDRESS || process.env.USDC_ADDRESS || "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB").trim();
const CTF_ABI = [
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
];
const PARTITION = [1, 2];   // binary market: the two outcome index sets
const SHARE_DECIMALS = 6;   // CTF outcome tokens share the collateral's decimals (pUSD = 6)

let _ready = null;   // Promise<{ wallet, ctf, signer, funder, isEoa }>
let _failed = null;

async function init() {
  if (_failed) throw new Error(_failed);
  if (_ready) return _ready;
  _ready = (async () => {
    let privateKey;
    if (dkConfigured()) { const k = await getKey(); privateKey = k.privateKey; }
    else if (config.livePrivateKey) privateKey = config.livePrivateKey;
    else throw new Error("no live credentials for on-chain merge");
    const provider = new ethers.JsonRpcProvider(config.onchainRpc, undefined, { staticNetwork: true });
    const wallet = new ethers.Wallet(privateKey, provider);
    const funder = (await resolveFunder().catch(() => null)) || wallet.address;
    const isEoa = funder.toLowerCase() === wallet.address.toLowerCase();
    const ctf = new ethers.Contract(CTF_ADDR, CTF_ABI, wallet);
    if (verboseOn) verbose("merge.init", { signer: wallet.address, funder, isEoa, ctf: CTF_ADDR, collateral: COLLATERAL_ADDR });
    return { wallet, ctf, signer: wallet.address, funder, isEoa };
  })().catch((e) => { _failed = String(e?.message || e); _ready = null; throw e; });
  return _ready;
}

/**
 * Merge `sets` complete sets of the market `conditionId` back into collateral. Returns
 * {ok, txHash} | {skipped, reason} | {error}. Never throws into the caller.
 */
export async function mergeOnChain({ conditionId, sets, slug }) {
  if (config.executionMode !== "live") return { skipped: true, reason: "not live" };
  if (!conditionId) return { error: "no conditionId" };
  const amount = Math.floor((+sets || 0) * 10 ** SHARE_DECIMALS);
  if (!(amount > 0)) return { error: "zero sets" };
  const tag = String(slug || "").split("-").pop();
  let dep; try { dep = await init(); } catch (e) { return { error: "init: " + String(e?.message || e) }; }
  const { ctf, wallet, funder, isEoa } = dep;

  // PROXY funder: the tokens live in the proxy, not the signer EOA → a direct merge would revert. Skip
  // (harmless: the sets redeem $1 each at settlement). Surfacing loudly so it can be wired to the proxy exec.
  if (!isEoa) {
    console.warn(`[merge] SKIP ${tag} ${sets} sets — funder ${funder.slice(0, 10)}… is a Polymarket PROXY; on-chain merge needs proxy-routed exec (not wired). Sets redeem at settlement (PnL unchanged).`);
    if (verboseOn) verbose("merge.skip_proxy", { slug: tag, funder, sets });
    return { skipped: true, reason: "proxy funder — merge not routed" };
  }

  // EOA funder: reconcile against the real on-chain balances, then merge min(intended, on-chain).
  try {
    const parent = ethers.ZeroHash;
    let mergeable = amount;
    try {
      const [cUp, cDn] = await Promise.all([
        ctf.getCollectionId(parent, conditionId, PARTITION[0]),
        ctf.getCollectionId(parent, conditionId, PARTITION[1]),
      ]);
      const [idUp, idDn] = await Promise.all([
        ctf.getPositionId(COLLATERAL_ADDR, cUp), ctf.getPositionId(COLLATERAL_ADDR, cDn),
      ]);
      const [balUp, balDn] = await Promise.all([ctf.balanceOf(funder, idUp), ctf.balanceOf(funder, idDn)]);
      mergeable = Number(balUp < balDn ? balUp : balDn);
      if (mergeable > amount) mergeable = amount;      // never merge more than intended
    } catch (e) { if (verboseOn) verbose("merge.balance_check_failed", { slug: tag, error: String(e?.message || e) }); }
    if (!(mergeable > 0)) {
      console.warn(`[merge] SKIP ${tag} — no on-chain complete sets to merge (fills not settled yet?)`);
      return { skipped: true, reason: "no on-chain sets" };
    }
    const startedAt = verboseOn ? Date.now() : 0;
    if (verboseOn) verbose("merge.submit", { slug: tag, conditionId, sets: mergeable / 10 ** SHARE_DECIMALS, amount: mergeable });
    const tx = await ctf.mergePositions(COLLATERAL_ADDR, parent, conditionId, PARTITION, mergeable);
    const rcpt = await tx.wait(1);
    if (verboseOn) verbose("merge.response", { slug: tag, txHash: tx.hash, status: rcpt?.status, latencyMs: startedAt ? Date.now() - startedAt : null });
    console.log(`[merge] ${tag} merged ${mergeable / 10 ** SHARE_DECIMALS} sets → $${(mergeable / 10 ** SHARE_DECIMALS).toFixed(2)} reclaimed · tx=${tx.hash}`);
    return { ok: true, txHash: tx.hash, sets: mergeable / 10 ** SHARE_DECIMALS };
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("merge.error", { slug: tag, error: msg });
    console.error(`[merge] ${tag} on-chain merge FAILED (sets redeem at settlement, PnL unchanged):`, msg);
    return { error: msg };
  }
}
