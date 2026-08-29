// balance.js — on-chain wallet balance via the Polygon RPC (config.onchainRpc).
// Reports the pUSD collateral balance (what Polymarket trades against post-V2) + native POL for gas.
// Short-TTL cache so the header's refresh / poll can't hammer the RPC.
import { ethers } from "ethers";
import { config } from "../config/config.js";
import { verbose, verboseOn } from "../logging/verbose.js";

// pUSD (Polymarket USD) on Polygon — the collateral Polymarket CTF positions settle in since the
// Apr 28 2026 V2 upgrade (replaced USDC.e; backed 1:1 by USDC). Override via PUSD_ADDRESS / USDC_ADDRESS.
const COLLATERAL_ADDR = (process.env.PUSD_ADDRESS || process.env.USDC_ADDRESS || "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB").trim();
const COLLATERAL_SYMBOL = process.env.COLLATERAL_SYMBOL || "pUSD";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const CACHE_TTL_MS = Number(process.env.BALANCE_CACHE_MS ?? 4000);

let _provider = null, _token = null, _decimals = null;
const _cache = new Map();   // address -> { ts, data }

function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(config.onchainRpc, undefined, { staticNetwork: true });
  return _provider;
}
function collateral() {
  if (!_token) _token = new ethers.Contract(COLLATERAL_ADDR, ERC20_ABI, provider());
  return _token;
}

/** pUSD collateral + native POL balance for `address`. force=true bypasses the short cache. */
export async function getBalance(address, force = false) {
  const addr = String(address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return { address: addr, error: "invalid address" };
  const hit = _cache.get(addr.toLowerCase());
  if (!force && hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  try {
    if (_decimals == null) { try { _decimals = Number(await collateral().decimals()); } catch { _decimals = 6; } }
    const [raw, native] = await Promise.all([collateral().balanceOf(addr), provider().getBalance(addr)]);
    const usd = Number(ethers.formatUnits(raw, _decimals));
    const data = {
      address: addr,
      usd, usdc: usd,                 // `usd` (current) + `usdc` (back-compat alias)
      symbol: COLLATERAL_SYMBOL,
      native: Number(ethers.formatEther(native)),   // POL (gas)
      asOf: Date.now(), token: COLLATERAL_ADDR,
    };
    _cache.set(addr.toLowerCase(), { ts: Date.now(), data });
    if (verboseOn) verbose("balance.read", { address: addr, [COLLATERAL_SYMBOL]: usd, native: +data.native.toFixed(4) });
    return data;
  } catch (e) {
    const msg = String(e?.message || e);
    if (verboseOn) verbose("balance.error", { address: addr, error: msg });
    // serve a slightly-stale cached value if we have one, tagged with the error
    if (hit) return { ...hit.data, stale: true, error: msg };
    return { address: addr, error: msg };
  }
}
