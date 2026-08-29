// research/wallet-3048-extract.mjs — reverse-engineer the profitable BTC-5m wallet 0x3048d653 by JOINING its
// on-chain fills (Polymarket data-api /activity) to the v4 L2 order book at each fill's instant (bapi-v4). The
// v4 book is what v2/v3 lacked: it lets us classify each BUY as TAKER (crossed the ask) vs MAKER (rested at/below
// bid) and read the microstructure the wallet gates on — |gap|, price band, time-into-window, both-sides behavior.
//
// DATA LIMIT: /activity returns only the most recent ~500 rows (no backfill), so one run covers ~25 min / ~5-6
// windows. For a deep sample, run repeatedly / poll and append. Read-only research on a public wallet.
//
// Usage:  node research/wallet-3048-extract.mjs [fills.jsonl]   (no arg = live /activity, 500 recent)
try { process.loadEnvFile?.(new URL("../.env", import.meta.url)); } catch {}
import { config } from "../src/config/config.js";
import { getJson as getJsonUtil } from "../src/util/util.js";
import { existsSync, readFileSync } from "node:fs";
const FILLS_FILE = process.argv[2] && existsSync(process.argv[2]) ? process.argv[2] : null;

const WALLET = "0x3048d65321be3497164cdfc2996f94f98a2e7537";
const V4_BASE = (process.env.BAPI_V4_BASE || "https://bapi-v4.polywinbot.com").replace(/\/+$/, "");
const KEY = process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || process.env.BAPI_KEY || process.env.BACKTEST_API_KEY;
if (!KEY) throw new Error("Set BAPI_V4_KEY / BAPI_V3_KEY / BAPI_KEY / BACKTEST_API_KEY");
const headers = { Accept: "application/json", "X-API-Key": KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function v4(path, query = {}, attempt = 0) {
  const url = new URL(path, `${V4_BASE}/`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  let res;
  try { res = await fetch(url, { headers }); }
  catch (e) { if (attempt >= 5) throw e; await sleep(600 * 2 ** attempt); return v4(path, query, attempt + 1); }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(600 * 2 ** attempt); return v4(path, query, attempt + 1); }
  if (!res.ok) throw new Error(`bapi-v4 ${res.status} ${url.pathname}`);
  return res.json();
}

// L2 book side → sorted asks (ascending) + bids (descending) + best prices
function bookSide(raw) {
  const asks = (raw?.asks || []).map((l) => ({ price: +l.price, size: +l.size }))
    .filter((l) => l.price > 0 && l.price < 1 && l.size > 0).sort((a, b) => a.price - b.price);
  const bids = (raw?.bids || []).map((l) => ({ price: +l.price, size: +l.size }))
    .filter((l) => l.price > 0 && l.price < 1 && l.size > 0).sort((a, b) => b.price - a.price);
  return { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null };
}

async function fetchWindowV4(slug) {
  const path = `markets/${encodeURIComponent(slug)}/snapshots`;
  const body = await v4(path, { page: 1, limit: 5000, include_orderbook: "true" });
  const startMs = Date.parse(body.startTime || "") || (Number(slug.split("-").pop()) * 1000);
  const openBz = Number(body.binanceSpotPriceStart);
  const openCl = Number(body.coinPriceStart);
  const ticks = (body.ticks || []).map((r) => {
    const ms = Date.parse(r.time || r.tick_time || "");
    return { ms, up: bookSide(r.orderbookUp || r.orderbook_up), down: bookSide(r.orderbookDown || r.orderbook_down),
             bz: Number(r.binanceSpotPrice ?? r.binance_spot_price) || null, cl: Number(r.coinPrice ?? r.chainlinkPrice) || null };
  }).filter((t) => Number.isFinite(t.ms)).sort((a, b) => a.ms - b.ms);
  return { slug, startMs, winner: body.winner ? (/^up$/i.test(body.winner) ? "Up" : "Down") : null,
           openBz: openBz > 0 ? openBz : null, openCl: openCl > 0 ? openCl : null, ticks };
}

// tick at-or-before t (ms)
function tickAt(ticks, ms) { let out = null; for (const t of ticks) { if (t.ms <= ms) out = t; else break; } return out || ticks[0] || null; }

// ── 1. get the wallet's fills — from the accumulated JSONL (deep sample) or live /activity ──
let rows;
if (FILLS_FILE) rows = readFileSync(FILLS_FILE, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
else rows = await getJsonUtil(`${config.dataApiHost}/activity?user=${WALLET}&limit=500`, 12000);
const fills = (Array.isArray(rows) ? rows : []).filter((r) => r.type === "TRADE" && /btc-updown-5m/.test(r.slug || ""));
console.log(`\nWALLET 0x3048 — ${fills.length} BTC-5m fills (${FILLS_FILE ? "accumulated " + FILLS_FILE.split("/").pop() : "live /activity, most-recent 500"})`);
if (!fills.length) { console.log("no fills."); process.exit(0); }
const byWin = new Map();
for (const f of fills) { const a = byWin.get(f.slug) || []; a.push(f); byWin.set(f.slug, a); }
const fmt = (t) => new Date(t * 1000).toISOString().slice(5, 16);
const span = fills.map((f) => f.timestamp).sort((a, b) => a - b);
console.log(`span ${fmt(span[0])} → ${fmt(span[span.length - 1])} · ${byWin.size} windows · ${(fills.length / byWin.size).toFixed(0)} fills/window\n`);

// ── 2. fetch v4 books per window, ── 3. join each fill → book at fill-time ──
const EPS = 0.006;   // price-classification tolerance (~ half a tick / VWAP slack)
const agg = { taker: 0, maker: 0, inside: 0, n: 0, prices: [], gapsBz: [], tInto: [], sizes: [] };
const perWin = [];
for (const [slug, wf] of byWin) {
  let W; try { W = await fetchWindowV4(slug); } catch (e) { console.log(`  ${slug}: v4 err ${e.message.slice(0, 60)}`); continue; }
  if (!W.ticks.length) { console.log(`  ${slug}: no v4 ticks`); continue; }
  let up$ = 0, dn$ = 0, upSh = 0, dnSh = 0;
  for (const f of wf) {
    const side = /up/i.test(f.outcome) ? "Up" : "Down";
    const tk = tickAt(W.ticks, f.timestamp * 1000); if (!tk) continue;
    const book = side === "Up" ? tk.up : tk.down;
    const px = Number(f.price), sz = Number(f.size), usd = Number(f.usdcSize);
    let cls = "inside";
    if (book.bestAsk != null && px >= book.bestAsk - EPS) cls = "taker";
    else if (book.bestBid != null && px <= book.bestBid + EPS) cls = "maker";
    agg[cls]++; agg.n++; agg.prices.push(px); agg.sizes.push(sz);
    if (tk.bz != null && W.openBz != null) agg.gapsBz.push(tk.bz - W.openBz);
    agg.tInto.push(f.timestamp - Math.floor(W.startMs / 1000));
    if (side === "Up") { up$ += usd; upSh += sz; } else { dn$ += usd; dnSh += sz; }
  }
  perWin.push({ slug, winner: W.winner, up$, dn$, upSh, dnSh });
}

// ── 4. aggregate + characterize ──
const q = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };
const pc = (x) => `${(100 * x / agg.n).toFixed(0)}%`;
console.log(`ORDER TYPE (fill price vs L2 book at that instant, ±${EPS}):`);
console.log(`  TAKER (px ≥ bestAsk): ${agg.taker} (${pc(agg.taker)})   MAKER (px ≤ bestBid): ${agg.maker} (${pc(agg.maker)})   inside: ${agg.inside} (${pc(agg.inside)})`);
console.log(`\nENTRY PRICE band (VWAP paid): min ${q(agg.prices, 0)?.toFixed(2)} · p10 ${q(agg.prices, 10)?.toFixed(2)} · median ${q(agg.prices, 50)?.toFixed(2)} · p90 ${q(agg.prices, 90)?.toFixed(2)} · max ${q(agg.prices, 100)?.toFixed(2)}`);
if (agg.gapsBz.length) console.log(`|BINANCE gap| at entry ($): p50 ${Math.abs(q(agg.gapsBz, 50)).toFixed(1)} · p90 ${Math.abs(q(agg.gapsBz, 90)).toFixed(1)} · max ${Math.max(...agg.gapsBz.map(Math.abs)).toFixed(1)}`);
console.log(`TIME-INTO-WINDOW at entry (s): min ${q(agg.tInto, 0)} · median ${q(agg.tInto, 50)} · p90 ${q(agg.tInto, 90)} · max ${q(agg.tInto, 100)} (window=300s)`);
console.log(`FILL SIZE (shares): median ${q(agg.sizes, 50)?.toFixed(0)} · p90 ${q(agg.sizes, 90)?.toFixed(0)} · max ${q(agg.sizes, 100)?.toFixed(0)}`);

console.log(`\nBOTH-SIDES per window (does it buy Up AND Down = build toward a completed $1 set?):`);
console.log("window(start)     winner   up $     dn $    upSh    dnSh   set?   est.net@settle");
let totNet = 0, nSettled = 0;
for (const w of perWin.sort((a, b) => (Number(a.slug.split("-").pop())) - (Number(b.slug.split("-").pop())))) {
  const both = w.up$ > 0 && w.dn$ > 0;
  // completed-set payout: min(upSh,dnSh) pairs each return $1; the excess leg rides directional to settle
  let net = null;
  if (w.winner) {
    const pairs = Math.min(w.upSh, w.dnSh);
    const winSh = w.winner === "Up" ? w.upSh : w.dnSh;
    net = pairs * 1 + Math.max(0, winSh - pairs) * 1 - (w.up$ + w.dn$);   // pairs pay $1 + net-long winner shares pay $1
    totNet += net; nSettled++;
  }
  console.log(`${w.slug.split("-").pop()}   ${(w.winner || "open").padEnd(6)}  $${w.up$.toFixed(1).padStart(6)} $${w.dn$.toFixed(1).padStart(6)}  ${w.upSh.toFixed(0).padStart(5)}  ${w.dnSh.toFixed(0).padStart(5)}   ${both ? "yes" : "no "}    ${net == null ? "(open)" : (net >= 0 ? "+" : "") + "$" + net.toFixed(2)}`);
}
if (nSettled) console.log(`\nSETTLED windows: ${nSettled} · est net $${totNet.toFixed(2)} · $${(totNet / nSettled).toFixed(2)}/window (spend-weighted read; small sample)`);
console.log(`\nNOTE: sample is only ~${byWin.size} windows (activity API cap). Taker/maker split + gap/band/time are the`);
console.log(`extractable signal; est.net assumes completed-set + net-long-winner settle to $1 (no early sells — wallet does only BUYs).`);
process.exit(0);
