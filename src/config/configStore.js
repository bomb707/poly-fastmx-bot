// configStore.js — durable runtime config so the bot survives restarts with its LAST-APPLIED settings.
//   • On boot, index.js calls loadConfigStore() and applies the saved slices to the live holders
//     (backtest version, shadow-strategy params, verbose) — no .env edit,
//     no browser needed.
//   • On every Apply the UI hits an endpoint; that endpoint calls patchConfigStore() to persist the slice.
//   • GET /api/config returns the whole thing so the browser can reflect the persisted config on load.
// The file is a plain JSON object; writes are synchronous (config changes are user-driven + infrequent) and
// best-effort (a bad/absent file just yields {} — the code-level defaults then apply, exactly like before).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strategyParamKeys } from "../../engine/strategies/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.RUNTIME_CONFIG_FILE || path.resolve(HERE, "..", "..", "data", "runtime-config.json");

let store = {};

const UI_KEYS = new Set(["btVersionInput", "strategySelect", "sigSessStopInput", "sigLatencyInput",
  "sigLiveOrderTypeInput", "sigTargetCooldownInput",
  "sigTargetResidualScaleInput", "sigTargetCrossThresholdInput", "sigTargetMinOrderInput",
  "sigTargetReleaseThresholdInput", "sigTargetDecisionStepInput", "sigTargetMaxCellUsesInput",
  "sigTargetStartInput", "sigTargetStopInput", "sigTargetMaxOrderInput", "sigTargetMaxGrossInput", "verboseInput"]);
const SHADOW_KEYS = strategyParamKeys();

function sanitizeStore(value) {
  const src = value && typeof value === "object" ? value : {};
  const next = {};
  if (src.shadowParams && typeof src.shadowParams === "object") {
    next.shadowParams = Object.fromEntries(Object.entries(src.shadowParams)
      .filter(([key]) => SHADOW_KEYS.has(key)));
  }
  if (["v2", "v3"].includes(src.backtestApiVersion)) next.backtestApiVersion = src.backtestApiVersion;
  if (Number.isFinite(+src.sessionStartSec)) next.sessionStartSec = +src.sessionStartSec;
  if (typeof src.tradeEnabled === "boolean") next.tradeEnabled = src.tradeEnabled;
  if (typeof src.verbose === "boolean") next.verbose = src.verbose;
  if (src.ui && typeof src.ui === "object") {
    next.ui = Object.fromEntries(Object.entries(src.ui).filter(([key]) => UI_KEYS.has(key)));
  }
  return next;
}

function writeStore() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

/** Read the persisted config from disk into memory. Returns the object (｛｝ if missing/corrupt). */
export function loadConfigStore() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const o = JSON.parse(raw);
    store = sanitizeStore(o);
    if (JSON.stringify(o) !== JSON.stringify(store)) writeStore();
  }
  catch { store = {}; }
  return store;
}

/** The whole persisted config (shallow copy) — for GET /api/config. */
export function getConfigStore() { return { ...store }; }

/** Merge a slice into the store and write it to disk. Called by each apply endpoint. */
export function patchConfigStore(patch) {
  if (!patch || typeof patch !== "object") return store;
  // UI and strategy snapshots can come from an older browser tab that does not
  // know newly added controls. Merge those nested slices so an omitted new key
  // cannot silently erase it from the durable store.
  const next = { ...store, ...patch };
  if (patch.shadowParams && typeof patch.shadowParams === "object") {
    next.shadowParams = { ...(store.shadowParams || {}), ...patch.shadowParams };
  }
  if (patch.ui && typeof patch.ui === "object") {
    next.ui = { ...(store.ui || {}), ...patch.ui };
  }
  store = sanitizeStore(next);
  try {
    writeStore();
  } catch (e) { try { console.error("[configStore] write failed:", e?.message || e); } catch {} }
  return store;
}

export function configStorePath() { return FILE; }
