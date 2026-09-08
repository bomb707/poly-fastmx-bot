// auth.js — password gate for the dashboard AND all APIs (incl. the WebSocket).
// Ported from polystack-bot's auth.ts (Express) to this project's raw http server.
//
//   • Public:  GET /login (HTML form), POST /api/login, POST /api/logout.
//   • Gated:   everything else needs a valid session cookie — /api/* → 401, pages → 302 /login.
//   • Sessions: 256-bit random tokens, in-memory (cleared on restart). Cookie HttpOnly + SameSite=Strict
//     (+ Secure when SECURE_COOKIE=true). Per-IP lockout after repeated failures. Timing-safe compare.
//
// Env: WEB_PASSWORD (required — set a strong one), WEB_SESSION_COOKIE, SECURE_COOKIE, TRUST_PROXY.
//
// QUIET MODE: auth is only ENFORCED in real-live (config.executionMode === "live"), where real money is
// at stake. In SIMULATION the dashboard opens with NO password (the password stays configured for when
// you flip to live, it's just not prompted). Checked dynamically, so a live→sim runtime downgrade relaxes
// the gate too. Set AUTH_ALWAYS=1 to force the password even in simulation.
import crypto from "node:crypto";
import { config } from "../config/config.js";

const COOKIE_NAME = process.env.WEB_SESSION_COOKIE || "wallet3048_session";
const COOKIE_MAX_AGE = 24 * 60 * 60;            // 1 day
const DEFAULT_PASSWORD = "changeme";
const PASSWORD = process.env.WEB_PASSWORD || DEFAULT_PASSWORD;
const SECURE = String(process.env.SECURE_COOKIE || "").toLowerCase() === "true";
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";
const MAX_FAILED = 5, FAIL_WINDOW_MS = 15 * 60 * 1000, LOCKOUT_MS = 5 * 60 * 1000;

const sessions = new Set();                     // valid session tokens
const failedByIp = new Map();                   // ip -> { count, lastFailAt, lockUntil }

export function isDefaultPassword() { return PASSWORD === DEFAULT_PASSWORD; }
export function warnPassword() {
  if (!authRequired()) {
    console.log(`[auth] SIMULATION — dashboard is OPEN (no password). Auth is enforced only in real-live (set AUTH_ALWAYS=1 to force it in sim too).`);
    return;
  }
  if (isDefaultPassword())
    console.warn(`[auth] ⚠ real-live + WEB_PASSWORD is the built-in default ("${DEFAULT_PASSWORD}"). Anyone who can reach this server can control the bot — set a strong WEB_PASSWORD in .env.`);
  else
    console.log(`[auth] real-live — password required for the dashboard.`);
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function parseCookie(header, name) {
  if (!header) return null;
  const m = String(header).match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function clientIp(req) {
  if (TRUST_PROXY) { const xff = req.headers["x-forwarded-for"]; if (xff) return String(xff).split(",")[0].trim(); }
  return (req.socket?.remoteAddress || "").toString();
}
function cookieStr(val, maxAge) {
  const p = [`${COOKIE_NAME}=${val}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${maxAge}`];
  if (SECURE) p.push("Secure");
  return p.join("; ");
}
const isLocked = (ip) => { const f = failedByIp.get(ip); return !!f && f.lockUntil > Date.now(); };
function recordFailure(ip) {
  const now = Date.now();
  const f = failedByIp.get(ip) || { count: 0, lastFailAt: 0, lockUntil: 0 };
  if (now - f.lastFailAt > FAIL_WINDOW_MS) f.count = 0;
  f.count++; f.lastFailAt = now;
  if (f.count >= MAX_FAILED) { f.lockUntil = now + LOCKOUT_MS; console.warn(`[auth] ${ip} locked ${Math.round(LOCKOUT_MS / 1000)}s after ${f.count} failed logins`); }
  failedByIp.set(ip, f);
}

/** Is the password gate ENFORCED right now? Only in real-live (unless AUTH_ALWAYS=1 forces it). */
export function authRequired() {
  if (String(process.env.AUTH_ALWAYS || "").toLowerCase() === "true" || process.env.AUTH_ALWAYS === "1") return true;
  return config.executionMode === "live";
}

/** Valid session cookie? (used by the request gate AND the WS verifyClient.) In simulation (gate not
 *  enforced) everyone is treated as authed → no password prompt. */
export function isAuthed(req) {
  if (!authRequired()) return true;                               // quiet mode: simulation = open access
  const t = parseCookie(req?.headers?.cookie, COOKIE_NAME); return !!t && sessions.has(t);
}

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>FastMX · sign in</title>
<style>
  :root{--bg:#080a10;--panel:#0e131b;--panel2:#161c26;--border:#222b39;--text:#e6edf3;--muted:#8b98a8;--accent:#19e3a0;--err:#ff5d7a}
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:
    radial-gradient(1100px 560px at 20% -10%,rgba(25,227,160,.07),transparent 60%),
    radial-gradient(1100px 560px at 80% -10%,rgba(255,93,122,.07),transparent 60%),var(--bg);
    color:var(--text);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;display:flex;align-items:center;justify-content:center}
  form{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:30px 32px;min-width:320px;box-shadow:0 18px 60px rgba(0,0,0,.45)}
  h1{font-size:14px;margin:0 0 4px;letter-spacing:.5px} .sub{color:var(--muted);font-size:11px;margin:0 0 18px}
  label{display:block;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
  input{font:inherit;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:10px 12px;width:100%}
  input:focus{outline:none;border-color:var(--accent)}
  button{font:inherit;background:var(--accent);color:#04140d;font-weight:800;border:1px solid var(--accent);border-radius:7px;padding:10px 12px;width:100%;cursor:pointer;margin-top:16px}
  button:hover{filter:brightness(1.08)} .err{color:var(--err);font-size:12px;margin-top:10px;min-height:16px}
</style></head><body>
<form id="f" autocomplete="off">
  <h1>● FASTMX</h1><p class="sub">enter the access password</p>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autofocus />
  <button type="submit">Sign in</button>
  <div class="err" id="err"></div>
</form>
<script>
  const f=document.getElementById("f"),err=document.getElementById("err");
  f.addEventListener("submit",async(e)=>{e.preventDefault();err.textContent="";
    let r; try{ r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})}); }
    catch{ err.textContent="network error"; return; }
    if(r.ok){ location.href="/"; } else { const j=await r.json().catch(()=>({})); err.textContent=j.error||("login failed ("+r.status+")"); const p=document.getElementById("p"); p.select(); }
  });
</script></body></html>`;

function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

/**
 * Handle auth routes + gate. Call FIRST in the request handler.
 * @returns {boolean} true if the request was fully handled here (served login / blocked) — caller returns;
 *                    false if the request is authed and the caller should continue routing.
 */
export function handleAuth(req, res, url) {
  // QUIET MODE (simulation): no gate → send anyone hitting /login straight to the dashboard.
  if (!authRequired()) { if (url === "/login") { res.writeHead(302, { Location: "/" }); res.end(); return true; } return false; }
  if (url === "/login") { res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); res.end(LOGIN_HTML); return true; }
  if (url === "/api/login") {
    if (req.method !== "POST") { json(res, 405, { error: "POST only" }); return true; }
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => {
      const ip = clientIp(req);
      if (isLocked(ip)) { const s = Math.ceil((failedByIp.get(ip).lockUntil - Date.now()) / 1000); json(res, 429, { error: `too many attempts — locked ${s}s` }); return; }
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
      if (timingEqual(b.password || "", PASSWORD)) {
        const tok = crypto.randomBytes(32).toString("hex");
        sessions.add(tok); res.setHeader("Set-Cookie", cookieStr(tok, COOKIE_MAX_AGE)); failedByIp.delete(ip);
        json(res, 200, { ok: true }); return;
      }
      recordFailure(ip); json(res, 401, { error: "Invalid password" });
    });
    return true;
  }
  if (url === "/api/logout") {
    const t = parseCookie(req.headers.cookie, COOKIE_NAME); if (t) sessions.delete(t);
    res.setHeader("Set-Cookie", cookieStr("", 0)); json(res, 200, { ok: true }); return true;
  }
  // ── gate everything else ──
  if (isAuthed(req)) return false;                                  // authed → proceed
  if (url.startsWith("/api/")) { json(res, 401, { error: "auth required" }); return true; }
  res.writeHead(302, { Location: "/login" }); res.end(); return true; // page → login
}
