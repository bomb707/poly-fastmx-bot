// sessionLog.js — structured PER-RUN logging for full traceability.
//
// Each bot start creates a session directory  logs/<bootStamp>/  containing:
//   • config.json   — the boot config snapshot + a full config-CHANGE HISTORY: every change records the
//                     timestamp, the WINDOW slug in effect, and each key's from→to. So you can tell exactly
//                     when a config changed and from which window the new value was used.
//   • <slug>.log    — all console output while that window is live (verbose events, order/route/merge lines,
//                     errors). Rotates at 3 MB → <slug>.p2.log, <slug>.p3.log, … under the same session dir.
//   • startup.log   — output before the first window is known (boot).
//
// Goal: for ANY issue, open the session dir, find the window's log for the detailed cause, and read
// config.json to see exactly which config that window ran under.
import fs from "node:fs";
import path from "node:path";

let dir = "", curSlug = null, stream = null, bytes = 0, part = 1, maxBytes = 3 * 1024 * 1024;
let cfgPath = "", cfg = null, patched = false;

const p2 = (n, w = 2) => String(n).padStart(w, "0");
function stamp() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`; }
function fileStamp() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`; }

function fileFor(slug, prt) { const base = (slug ? String(slug).split("-").pop() : "startup"); return path.join(dir, prt > 1 ? `${base}.p${prt}.log` : `${base}.log`); }

function openFile() {
  const fp = fileFor(curSlug, part);
  try { bytes = fs.existsSync(fp) ? fs.statSync(fp).size : 0; } catch { bytes = 0; }
  stream = fs.createWriteStream(fp, { flags: "a" });
  stream.on("error", () => {});   // a logging failure must never crash the bot
}

function write(line) {
  if (!stream) return;
  const b = Buffer.byteLength(line);
  if (bytes + b > maxBytes) { try { stream.end(); } catch {} part++; openFile(); }   // 3 MB → next part file
  try { stream.write(line); bytes += b; } catch {}
}

function redact(c) {
  if (!c || typeof c !== "object") return c;
  const o = {};
  for (const k of Object.keys(c)) o[k] = /key|password|secret|cipher|private/i.test(k) ? (c[k] ? "***" : c[k]) : c[k];
  return o;
}
function writeCfg() { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch {} }

/**
 * Create the session dir, snapshot the config, and tee ALL console output to the per-window log files.
 * @param {string} baseDir  parent logs dir (config.logDir)
 * @param {{config?:object, strat?:object, maxMb?:number}} opts
 * @returns {string} the session directory path
 */
export function initSessionLog(baseDir, { config, strat, maxMb = 3, instance } = {}) {
  if (patched) return dir;
  patched = true;
  // Per-INSTANCE nesting: logs/<instance>/<bootStamp>/ so several processes (pm2 34 vs 52) never share a dir and are
  //   trivially distinguishable. instance defaults to config.instanceName; falls back to a flat dir if absent.
  const inst = instance || (config && config.instanceName) || null;
  dir = inst ? path.join(baseDir, String(inst), fileStamp()) : path.join(baseDir, fileStamp());
  maxBytes = Math.max(0.1, maxMb) * 1024 * 1024;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  cfgPath = path.join(dir, "config.json");
  cfg = { instance: inst || null, bootStamp: fileStamp(), startedAt: new Date().toISOString(), env: redact(config), strategy: strat || null, history: [] };
  writeCfg();
  curSlug = null; part = 1; openFile();   // startup.log until the first window is set
  const tag = inst ? `[${inst}] ` : "";   // every teed line carries the instance tag so a MERGED pm2 view stays attributable
  const fmt = (a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const lvl of ["log", "info", "warn", "error"]) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...args) => { orig(...args); try { write(`[${stamp()}] ${tag}${lvl === "log" ? "" : lvl.toUpperCase() + " "}${args.map(fmt).join(" ")}\n`); } catch {} };
  }
  console.log(`[sessionlog] instance=${inst || "(none)"} → ${dir} · per-window files (${maxMb}MB rotation) · config+history in config.json`);
  return dir;
}

/** Switch the active log file to the given window slug (called on window rollover). Idempotent. */
export function setLogWindow(slug) {
  if (!patched || !slug || slug === curSlug) return;
  const first = curSlug === null;
  try { stream?.end(); } catch {}
  curSlug = slug; part = 1; openFile();
  if (!first) write(`[${stamp()}] ─────────── window ${slug} ───────────\n`);
}

/**
 * Record a config change into config.json's history + the current window log. Only real diffs are kept.
 * @param {string} source  where it came from (e.g. "shadow-params", "market", "tracker")
 */
export function logConfigChange(source, oldP, newP) {
  if (!cfg) return;
  const changes = {}; const keys = new Set([...Object.keys(oldP || {}), ...Object.keys(newP || {})]);
  for (const k of keys) { const a = oldP ? oldP[k] : undefined, b = newP ? newP[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a, to: b }; }
  if (!Object.keys(changes).length) return;
  cfg.history.push({ ts: new Date().toISOString(), window: curSlug, source: source || "config", changes });
  writeCfg();
  try { write(`[${stamp()}] CONFIG CHANGE (${source}) window=${curSlug} ${JSON.stringify(changes)}\n`); } catch {}
}

/** Snapshot the effective strategy config into config.json (e.g. once the shadow's live params are known). */
export function setStrategySnapshot(strat) { if (cfg) { cfg.strategy = strat || cfg.strategy; writeCfg(); } }

/** Re-snapshot config.env AFTER boot finishes initializing it (model load, toggle restores, …). initSessionLog runs
 *  FIRST to tee console output, so its env snapshot predates those — call this once boot is done so the log is truthful. */
export function refreshEnvSnapshot(config) { if (cfg) { cfg.env = redact(config); writeCfg(); } }
export function sessionDir() { return dir; }

/**
 * Write a BACKTEST manifest into the session dir — a deterministic, timestamp-free per-window dump so two
 * processes' runs of the same range can be diffed directly (different ticks/openBz ⇒ data divergence;
 * same data but different fills/PnL ⇒ code divergence). Overwrites per (start,end) label.
 * @returns {string|null} the file path written, or null.
 */
export function writeBacktestManifest(label, text) {
  if (!dir) return null;
  const safe = String(label).replace(/[^0-9a-zA-Z_.-]/g, "_");
  const fp = path.join(dir, `backtest_${safe}.log`);
  try { fs.writeFileSync(fp, text); return fp; } catch { return null; }
}

/**
 * Record a FEED-HEALTH transition (e.g. Binance @aggTrade went stale/down/live). Writes a distinctly-tagged,
 * greppable line into the current window log AND maintains a per-feed summary in config.json (latest counters +
 * a capped transition history), so a run's total downtime/reconnects/errors is readable in ONE place.
 * @param {string} feed    feed name, e.g. "binance"
 * @param {string} status  "live" | "stale" | "down"
 * @param {string} [detail] short reason
 * @param {object} [counts] latest counters { reconnects, staleReconnects, errors, downMs, ... }
 */
export function logFeedEvent(feed, status, detail, counts) {
  try { write(`[${stamp()}] FEEDHEALTH ${feed} ${status}${detail ? " — " + detail : ""}${counts ? " " + JSON.stringify(counts) : ""}\n`); } catch {}
  if (!cfg) return;
  const feeds = cfg.feeds || (cfg.feeds = {});
  const f = feeds[feed] || (feeds[feed] = { transitions: 0, events: [] });
  f.transitions++;
  const ev = { ts: new Date().toISOString(), window: curSlug, status, detail: detail || null, ...(counts || {}) };
  f.last = ev; if (counts) Object.assign(f, counts);   // keep latest counters at the top level for a quick read
  f.events.push(ev); if (f.events.length > 200) f.events.shift();
  writeCfg();
}
