// db.js — durable recording for the shadow strategy's fills + A/B session records.
//
// Collections are SPLIT BY EXECUTION MODE (isLive()): sim-live writes/reads the *_sim collections,
// real-live the *_real collections — a process is fixed to one mode for its whole life (EXECUTION_MODE).
//   shadow_fills_sim   / shadow_fills_real    — one doc per shadow fill (+ merge record), carries slug/windowStart
//   shadow_sessions_sim/ shadow_sessions_real — one doc per resolved window (the A/B ledger: sim/real/bot PnL)
//
// Session transitions are synchronously appended to a small local JSONL ledger, then mirrored to MongoDB
// asynchronously. Other MongoDB writes are fire-and-forget (never throw into the hot strategy loop).
// Connection: MONGO_URI (default local shared with the other bots), DB: MONGO_DB (default poly_helpme — this
//   bot's OWN database, kept separate from other projects' data even though they share the mongod instance).
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { isLive } from "../lib/executor.js";
import { config } from "../config/config.js";

const URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGO_DB || "poly_helpme";

let client = null, db = null, connecting = null, mongoRetryAfter = 0, mongoWarningShown = false;

function warnMongoFallback(error) {
  if (mongoWarningShown) return;
  mongoWarningShown = true;
  console.warn(`[db] MongoDB unavailable; durable local session ledger remains active (${error?.message || error})`);
}

/** Execution-mode suffix — the collections are physically separate per mode. */
export function mode() { return isLive() ? "real" : "sim"; }

async function connect() {
  if (db) return db;
  if (Date.now() < mongoRetryAfter) throw new Error("MongoDB reconnect backoff active");
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
    }).catch((e) => {
      connecting = null;
      mongoRetryAfter = Date.now() + 60_000;
      warnMongoFallback(e);
      throw e;
    });
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
const localSessionFile = () => path.join(config.dataDir, `shadow-sessions-${mode()}.jsonl`);

/** Collapse pending/resolved append-only rows to one authoritative row per window. */
export function collapseSessionRows(rows) {
  const byWindow = new Map();
  for (const row of rows || []) {
    const ws = Number(row?.windowStart);
    if (!Number.isFinite(ws)) continue;
    const previous = byWindow.get(ws);
    if (!previous) { byWindow.set(ws, row); continue; }
    const resolved = (value) => value?.status === "resolved" || value?.winSide ? 1 : 0;
    const fills = (value) => Number(value?.sim?.nFills) || 0;
    const better = resolved(row) > resolved(previous)
      || resolved(row) === resolved(previous) && fills(row) > fills(previous)
      || resolved(row) === resolved(previous) && fills(row) === fills(previous)
        && (Number(row?.ts) || 0) >= (Number(previous?.ts) || 0);
    if (better) byWindow.set(ws, row);
  }
  return [...byWindow.values()].sort((a, b) => Number(a.windowStart) - Number(b.windowStart));
}

function readLocalSessionRows() {
  try {
    return collapseSessionRows(fs.readFileSync(localSessionFile(), "utf8").split(/\r?\n/)
      .filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean));
  } catch { return []; }
}

function appendLocalSession(doc) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const { _id, ...row } = doc || {};
    fs.appendFileSync(localSessionFile(), JSON.stringify(row) + "\n");
    return true;
  } catch (error) {
    console.error(`[db] local session ledger write failed: ${error?.message || error}`);
    return false;
  }
}

function logFiles(dir, output = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) logFiles(file, output);
    else if (entry.isFile() && entry.name.endsWith(".log")) output.push(file);
  }
  return output;
}

// MongoDB used to be the only session store. If it is absent on an upgraded
// install, recover already-settled simulation PnL from the structured runtime
// logs once, then continue with the local append-only ledger.
function recoverLoggedSessions() {
  if (mode() !== "sim") return [];
  const recovered = [];
  for (const file of logFiles(config.logDir)) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const marker = "shadow.settle ", at = line.indexOf(marker);
      if (at < 0) continue;
      let event;
      try { event = JSON.parse(line.slice(at + marker.length)); } catch { continue; }
      const ws = Number(String(event.slug || "").split("-").at(-1));
      if (!Number.isFinite(ws) || !Number.isFinite(Number(event.pnl))) continue;
      const timestamp = line.match(/^\[([^\]]+)\]/)?.[1];
      recovered.push({ slug: event.slug, windowStart: ws, winSide: event.winSide,
        status: "resolved", ts: Math.floor((Date.parse(timestamp) || ws * 1000) / 1000),
        sim: { pnl: Number(event.pnl), nFills: Number(event.nFills) || 0,
          cfg: event.cfg || null }, bot: null, recoveredFromLog: true });
    }
  }
  return collapseSessionRows(recovered);
}

let localSessionsInitialized = false;
function ensureLocalSessions() {
  let rows = readLocalSessionRows();
  if (localSessionsInitialized) return rows;
  localSessionsInitialized = true;

  // Run one catch-up pass on every process start, even when a ledger already
  // exists. This closes the gap when an older binary kept running and logging
  // settlements after the ledger was first created but before it was restarted.
  const recovered = recoverLoggedSessions();
  const current = new Map(rows.map((row) => [Number(row.windowStart), row]));
  let imported = 0;
  for (const row of recovered) {
    const previous = current.get(Number(row.windowStart));
    if (previous && (previous.status === "resolved" || previous.winSide)) continue;
    if (appendLocalSession(row)) { current.set(Number(row.windowStart), row); imported++; }
  }
  if (imported) console.log(`[db] recovered ${imported} missing session rows from structured logs`);
  return collapseSessionRows([...rows, ...current.values()]);
}

/** Persist every session transition locally first, then mirror it to MongoDB
 * when available. The local ledger keeps Session PnL working without MongoDB. */
export function recordSession(doc) {
  appendLocalSession(doc);
  sessionsCol().then((c) => c.updateOne({ windowStart: doc.windowStart },
    { $set: doc }, { upsert: true })).catch(() => {});
}

/** Read one deduplicated session view. Local rows are authoritative while the
 * optional MongoDB mirror contributes older rows when already connected. */
export async function sessionRowsSince(since = 0) {
  const local = ensureLocalSessions();
  let mongo = [];
  if (db || !local.length) {
    try { mongo = await (await sessionsCol()).find({ windowStart: { $gte: Number(since) || 0 } }).toArray(); }
    catch {}
  }
  return collapseSessionRows([...mongo, ...local])
    .filter((row) => Number(row.windowStart) >= (Number(since) || 0));
}

/** Read closed rows that survived a process restart while still awaiting venue resolution. */
export async function pendingSessionsBefore(windowStart, limit = 50) {
  const rows = await sessionRowsSince(0);
  return rows.filter((row) => row.status === "pending"
    && Number(row.windowStart) < Number(windowStart)).slice(0, Math.max(1, Number(limit) || 50));
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
  const current = readLocalSessionRows().find((row) => Number(row.windowStart) === Number(resolved.windowStart));
  if (current?.status === "resolved") return null;
  appendLocalSession(resolved);
  sessionsCol().then(async (c) => {
    const { _id, ...set } = resolved;
    const filter = _id != null ? { _id, status: "pending" }
      : { windowStart: resolved.windowStart, status: "pending" };
    await c.updateOne(filter, { $set: set });
  }).catch(() => {});
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
