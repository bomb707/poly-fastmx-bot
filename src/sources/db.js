// db.js — MongoDB recording for the shadow strategy's fills + A/B session records.
//
// Collections are SPLIT BY EXECUTION MODE (isLive()): sim-live writes/reads the *_sim collections,
// real-live the *_real collections — a process is fixed to one mode for its whole life (EXECUTION_MODE).
//   shadow_fills_sim   / shadow_fills_real    — one doc per shadow fill (+ merge record), carries slug/windowStart
//   shadow_sessions_sim/ shadow_sessions_real — one doc per resolved window (the A/B ledger: sim/real/bot PnL)
//
// Writes are fire-and-forget (never block or throw into the hot strategy loop). Reads are awaited.
// Connection: MONGO_URI (default local shared with the other bots), DB: MONGO_DB (default poly_helpme — this
//   bot's OWN database, kept separate from other projects' data even though they share the mongod instance).
import { MongoClient } from "mongodb";
import { isLive } from "../lib/executor.js";

const URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGO_DB || "poly_helpme";

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
export function recordSession(doc) { sessionsCol().then((c) => c.updateOne({ windowStart: doc.windowStart }, { $set: doc }, { upsert: true })).catch(() => {}); }

/** Read closed rows that survived a process restart while still awaiting venue resolution. */
export async function pendingSessionsBefore(windowStart, limit = 50) {
  try {
    const c = await sessionsCol();
    return await c.find({ status: "pending", windowStart: { $lt: Number(windowStart) } })
      .sort({ windowStart: 1 }).limit(Math.max(1, Number(limit) || 50)).toArray();
  } catch { return []; }
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

/** Atomically finalize one still-pending row. Returns null if another path won the race. */
export async function finalizePendingSession(doc, winSide, ts = Math.floor(Date.now() / 1000)) {
  const resolved = resolvePendingSessionDoc(doc, winSide, ts);
  if (!resolved) return null;
  try {
    const c = await sessionsCol();
    const { _id, ...set } = resolved;
    const filter = _id != null ? { _id, status: "pending" }
      : { windowStart: resolved.windowStart, status: "pending" };
    const result = await c.updateOne(filter, { $set: set });
    return result.modifiedCount === 1 ? resolved : null;
  } catch { return null; }
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
