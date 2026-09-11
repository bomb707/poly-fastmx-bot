// db.js — MongoDB fills plus local and MongoDB session records.
//
// Collections are SPLIT BY EXECUTION MODE (isLive()): sim-live writes/reads the *_sim collections,
// real-live the *_real collections — a process is fixed to one mode for its whole life (EXECUTION_MODE).
//   shadow_fills_sim   / shadow_fills_real    — one doc per shadow fill (+ merge record), carries slug/windowStart
//   shadow_sessions_sim/ shadow_sessions_real — one doc per resolved window (the A/B ledger: sim/real/bot PnL)
//
// Writes are fire-and-forget (never block or throw into the hot strategy loop). Reads are awaited.
// Connection: MONGO_URI (default local shared with the other bots), DB: MONGO_DB (default poly_wallet3048 — this
//   bot's OWN database, kept separate from other projects' data even though they share the mongod instance).
import { MongoClient } from "mongodb";
import path from "node:path";
import { config } from "../config/config.js";
import { createSessionStore, mergeSessionRows } from "./session-store.js";
import { isLive } from "../lib/executor.js";

const URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGO_DB || "poly_wallet3048";

let client = null, db = null, connecting = null;

/** Execution-mode suffix — the collections are physically separate per mode. */
export function mode() { return isLive() ? "real" : "sim"; }

async function connect() {
  if (db) return db;
  if (!connecting) {
    client = new MongoClient(URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 4000 });
    connecting = client.connect().then(async () => {
      db = client.db(DB_NAME);
      // idempotent indexes for the read paths (fills by slug/oid, sessions by window)
      await Promise.all([
        db.collection("shadow_fills_sim").createIndex({ slug: 1, oid: 1 }),
        db.collection("shadow_fills_real").createIndex({ slug: 1, oid: 1 }),
        db.collection("shadow_fills_sim").createIndex({ windowStart: 1, tInto: 1 }),
        db.collection("shadow_fills_real").createIndex({ windowStart: 1, tInto: 1 }),
        db.collection("shadow_sessions_sim").createIndex({ windowStart: 1 }),
        db.collection("shadow_sessions_real").createIndex({ windowStart: 1 }),
        // Order Status panel history — read by slug in ts order; TTL-expired so it can't grow unbounded.
        db.collection("order_status_sim").createIndex({ slug: 1, ts: 1 }),
        db.collection("order_status_real").createIndex({ slug: 1, ts: 1 }),
        db.collection("order_status_sim").createIndex({ _at: 1 }, { expireAfterSeconds: 14 * 86400 }),
        db.collection("order_status_real").createIndex({ _at: 1 }, { expireAfterSeconds: 14 * 86400 }),
      ]).catch(() => {});
      console.log(`[db] MongoDB connected → ${DB_NAME} (mode=${mode()}) @ ${URI.replace(/\/\/[^@]*@/, "//***@")}`);
      return db;
    }).catch((e) => { connecting = null; throw e; });
  }
  return connecting;
}

/** The fills collection for THIS process's execution mode. */
export async function fillsCol() { await connect(); return db.collection("shadow_fills_" + mode()); }
/** The sessions (A/B ledger) collection for THIS process's execution mode. */
export async function sessionsCol() { await connect(); return db.collection("shadow_sessions_" + mode()); }
/** The Order-Status lifecycle-event collection for THIS process's execution mode. */
export async function orderStatusCol() { await connect(); return db.collection("order_status_" + mode()); }

/** Stable identity for one modeled fill. MongoDB's `_id` uniqueness makes the
 * fire-and-forget write idempotent if an event is accidentally delivered
 * twice. `tInto` remains part of the key because a restarted legacy process
 * could reuse an order number for a genuinely later fill. */
export function fillDocId(doc) {
  if (doc?.windowStart == null || doc?.tInto == null) return null;
  const ws = Number(doc?.windowStart), tInto = Number(doc?.tInto);
  if (!Number.isFinite(ws) || !Number.isFinite(tInto)) return null;
  if (doc?.fillId != null) {
    const fillId = String(doc.fillId).replace(/[^a-z0-9_.:-]/gi, "_");
    return `${Math.trunc(ws)}:fill:${fillId}`;
  }
  const oid = doc?.oid == null ? "none" : String(doc.oid);
  const leg = String(doc?.leg || "entry").replace(/[^a-z0-9_-]/gi, "_");
  const side = String(doc?.side || "none").replace(/[^a-z0-9_-]/gi, "_");
  return `${Math.trunc(ws)}:${oid}:${leg}:${side}:${tInto.toFixed(6)}`;
}

/** Fire-and-forget: record one shadow fill (or merge) doc. Never throws into
 * the caller. Upsert by stable identity so retrying the same persistence event
 * cannot double the ledger shown after a later restart. */
export function recordFill(doc) {
  const _id = fillDocId(doc);
  fillsCol().then((c) => _id == null ? c.insertOne(doc)
    : c.updateOne({ _id }, { $setOnInsert: { ...doc, _id } }, { upsert: true })).catch(() => {});
}

/** Read the durable modeled fills for one window, used to hydrate a process
 * that restarts while the market is still open. */
export async function fillsOfWindow(windowStart) {
  try {
    const c = await fillsCol();
    return await c.find({ windowStart: Number(windowStart) }, { projection: { _id: 0 } })
      .sort({ tInto: 1, ts: 1 }).toArray();
  } catch { return []; }
}
/** Fire-and-forget UPSERT of one window's A/B session doc, keyed by windowStart. Recorded as `status:"pending"`
 *  when the window closes, then overwritten with the resolved winner/PnL once Polymarket settles. Never throws. */
const sessionStores = new Map();
function localSessions() {
  const directory = path.resolve(config.dataDir, `sessions-${mode()}`);
  if (!sessionStores.has(directory)) sessionStores.set(directory, createSessionStore(directory));
  return sessionStores.get(directory);
}

// The local copy is committed before the optional MongoDB mirror, so a missing
// database cannot discard completed rounds or pending settlement records.
export function recordSession(doc) {
  let row = doc;
  try { row = localSessions().write(doc); }
  catch (error) { console.error(`[session ledger] Local write failed: ${error.message}`); }
  sessionsCol().then((c) => c.updateOne({ windowStart: row.windowStart }, { $set: row }, { upsert: true })).catch(() => {});
}

export async function readSessionRows(since = 0) {
  let local, localError;
  try { local = localSessions().read(since); } catch (error) { localError = error; }
  try {
    const remote = await (await sessionsCol()).find({ windowStart: { $gte: since } }).toArray();
    return mergeSessionRows(remote, local || []);
  } catch (error) {
    if (localError) throw new Error("Session ledger is unavailable");
    return mergeSessionRows(local);
  }
}

/** Read closed rows awaiting resolution, including those recorded without MongoDB. */
export async function pendingSessionsBefore(windowStart, limit = 50) {
  try {
    const rows = await readSessionRows();
    return rows.filter((row) => row.status === "pending" && row.windowStart < Number(windowStart))
      .slice(0, Math.max(1, Number(limit) || 50));
  } catch (error) {
    console.error(`[session ledger] Pending recovery failed: ${error.message}`);
    return [];
  }
}

const r4 = (value) => Math.round((Number(value) || 0) * 1e4) / 1e4;

/** Pure restart-recovery accounting, shared with tests. */
export function resolvePendingSessionDoc(doc, winSide, ts = Math.floor(Date.now() / 1000)) {
  if (!doc || (winSide !== "Up" && winSide !== "Down")) return null;
  const settleLedger = (ledger) => {
    if (!ledger) return ledger;
    const winningShares = winSide === "Up" ? Number(ledger.upShares) || 0 : Number(ledger.downShares) || 0;
    return { ...ledger, winSh: r4(winningShares), pnl: r4(winningShares - (Number(ledger.cost) || 0)
      - (Number(ledger.fee) || 0) + (Number(ledger.merged) || 0)) };
  };
  const out = { ...doc, status: "resolved", winSide, ts, sim: settleLedger(doc.sim) };
  if (doc.real) out.real = settleLedger(doc.real);
  if (out.bot && out.bot.pnl != null && out.sim?.pnl != null) {
    out.netMatch = out.sim.net === out.bot.net;
    out.pnlErr = r4(Math.abs(out.sim.pnl - out.bot.pnl));
  } else {
    out.netMatch = null;
    out.pnlErr = null;
  }
  return out;
}

/** Finalize a pending local row before mirroring it; repeated recovery is a no-op. */
export async function finalizePendingSession(doc, winSide, ts = Math.floor(Date.now() / 1000)) {
  const resolved = resolvePendingSessionDoc(doc, winSide, ts);
  if (!resolved) return null;
  const current = localSessions().read(doc.windowStart).find((row) => row.windowStart === doc.windowStart);
  if (current && current.status !== "pending") return null;
  recordSession(resolved);
  return resolved;
}

/** Fire-and-forget: persist one Order-Status lifecycle event (so the panel can reload it after refresh / later).
 *  Only events that carry a slug are stored; `_at` is a Date for the TTL index. Never throws. */
export function recordOrderStatus(e) {
  if (!e || !e.slug || !e.stage) return;
  const { kind, ...doc } = e;   // drop the WS envelope field
  doc._at = new Date(+e.ts || Date.now());
  orderStatusCol().then((c) => c.insertOne(doc)).catch(() => {});
}
/** Read one window's stored Order-Status events (chronological). Returns [] on any error. */
export async function orderStatusOf(slug) {
  try { const c = await orderStatusCol(); return await c.find({ slug }, { projection: { _id: 0, _at: 0 } }).sort({ ts: 1 }).toArray(); }
  catch { return []; }
}

export async function closeDb() { try { if (client) await client.close(); } catch {} client = db = connecting = null; }
