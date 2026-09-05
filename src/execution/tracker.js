import fs from "node:fs";
import path from "node:path";
import { config } from "../config/config.js";
import { bookAround, depthAround } from "../util/state.js";
import { slugFor, windowStartFor } from "../util/util.js";
import { PARAMS, fillFee } from "../../engine/fees.js";   // shared fee model so bot+sim PnL match

const EPS = 1e-9;

/**
 * The analysis brain. Holds a per-window position/PnL model and, for every bot
 * event, derives: signal context (binance vs chainlink vs open), order-type
 * hint (taker / book-walk / partial), hedge classification, and live PnL.
 *
 * @param {ReturnType<import('../util/state.js').createLiveState>} state
 * @param {(slug:string)=>Promise<object|null>} resolveWindow async window meta provider
 */
export function createTracker(state, resolveWindow, onEvent = () => {}) {
  /** @type {Map<string, Window>} */
  const windows = new Map();
  const pending = new Set();
  let unknownSlugEvents = 0;

  fs.mkdirSync(config.dataDir, { recursive: true });

  function newWindow(slug, meta) {
    const windowStart = Number(slug.split("-").pop());
    const w = {
      slug,
      windowStart,
      windowEnd: windowStart + config.windowSec,
      upTokenId: meta?.upTokenId ?? null,
      downTokenId: meta?.downTokenId ?? null,
      conditionId: meta?.conditionId ?? null,
      openPrice: meta?.openPrice ?? null,
      openProvisional: false,
      openBinance: meta?.openBinance ?? null,
      openBinanceProvisional: false,
      winSide: meta?.winSide ?? null,
      // position (totalCost === upCost + downCost; split/merge attribute $/set 50/50)
      upShares: 0, downShares: 0, totalCost: 0, upCost: 0, downCost: 0,
      nTrades: 0, nSplit: 0, nMerge: 0, nRedeem: 0,
      events: [],
      settledLogged: false,
    };
    windows.set(slug, w);
    hydrateFromDisk(w);   // restart-safe: rebuild position from any prior log, dedup future fills
    return w;
  }

  // On (re)start, the activity poller re-fetches recent fills. Without this, each
  // restart re-applies + re-appends them → duplicated rows and inflated position.
  // Replay the existing per-window log to restore state and seed dedup keys, WITHOUT
  // re-logging. (Also de-dups any duplicates already present in the file.)
  function hydrateFromDisk(w) {
    let lines;
    try { lines = fs.readFileSync(path.join(config.dataDir, `${w.slug}.jsonl`), "utf8").trim().split("\n"); }
    catch { return; }
    let n = 0;
    for (const ln of lines) {
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (!r || !r.key || w.events.some((e) => e.key === r.key)) continue; // dedup
      w.events.push(r);
      const size = Number(r.size) || 0, usdc = Number(r.usdc) || 0;
      // snapshot the BEFORE state, then re-stamp the record with the reconstructed per-side cost +
      // before-snapshot (old logs predate these fields → the property menu's before→after needs them).
      const posBefore = { upShares: w.upShares, downShares: w.downShares, upCost: w.upCost, downCost: w.downCost, totalCost: w.totalCost,
                          ifUpWins: w.upShares - w.totalCost, ifDownWins: w.downShares - w.totalCost };
      if (r.type === "TRADE") { const dir = r.action === "SELL" ? -1 : 1;
        if (r.side === "Up") { w.upShares += dir * size; w.upCost += dir * usdc; } else if (r.side === "Down") { w.downShares += dir * size; w.downCost += dir * usdc; }
        w.totalCost += dir * usdc; w.nTrades++; }
      else if (r.type === "SPLIT") { w.upShares += size; w.downShares += size; w.totalCost += usdc; w.upCost += usdc / 2; w.downCost += usdc / 2; w.nSplit++; }
      else if (r.type === "MERGE") { w.upShares -= size; w.downShares -= size; w.totalCost -= usdc; w.upCost -= usdc / 2; w.downCost -= usdc / 2; w.nMerge++; }
      else if (r.type === "REDEEM") { w.nRedeem++; }
      r.upShares = w.upShares; r.downShares = w.downShares; r.totalCost = w.totalCost;   // rebuilt cumulative (in case the log lacked them)
      r.upCost = w.upCost; r.downCost = w.downCost; r.posBefore = posBefore;
      n++;
    }
    if (n) console.log(`[hydrate] ${w.slug}: restored ${n} prior fills (Up ${w.upShares.toFixed(0)} Dn ${w.downShares.toFixed(0)})`);
  }

  function updateMeta(w, meta) {
    if (!meta) return;
    if (meta.upTokenId) w.upTokenId = meta.upTokenId;
    if (meta.downTokenId) w.downTokenId = meta.downTokenId;
    if (meta.conditionId) w.conditionId = meta.conditionId;
    // authoritative open overrides a provisional (live-snapshot) open from index.js
    if (meta.openPrice != null && (w.openPrice == null || w.openProvisional)) w.openPrice = meta.openPrice;
    if (meta.openBinance != null && (w.openBinance == null || w.openBinanceProvisional)) {
      w.openBinance = meta.openBinance;
      w.openBinanceProvisional = false;
    }
    // Resolution now comes from Polymarket (chainlink open/close only, no binance) — so clear provisional
    // once the authoritative openPrice arrives; openBinance stays feed-sourced (its live value is correct).
    if (meta.openPrice != null) w.openProvisional = false;
    if (meta.winSide && !w.winSide) w.winSide = meta.winSide;
  }

  async function ensure(slug) {
    let w = windows.get(slug);
    if (w) return w;
    if (pending.has(slug)) return null;
    pending.add(slug);
    const meta = await resolveWindow(slug).catch(() => null);
    pending.delete(slug);
    w = windows.get(slug) ?? newWindow(slug, meta || {});
    updateMeta(w, meta);
    return w;
  }

  // Public: register/refresh a window proactively (called on rollover).
  async function register(slug) {
    const w = await ensure(slug);
    return w;
  }

  // Public: feed a raw activity event.
  async function onActivity(a) {
    const slug = a.slug;
    // only the tracked asset + interval
    if (!slug || !slug.startsWith(`${config.asset}-updown-${config.interval}-`)) {
      return;
    }
    const w = await ensure(slug);
    if (!w) return;
    if (w.events.some((e) => e.key === eventKey(a))) return; // idempotent
    applyEvent(w, a);
  }

  function eventKey(a) {
    return `${a.transactionHash}:${a.asset}:${a.side}:${a.type}:${a.timestamp}:${a.size}`;
  }

  function applyEvent(w, a) {
    const type = a.type;
    const side = a.outcome; // Up | Down (for TRADE)
    const size = Number(a.size) || 0;
    const usdc = Number(a.usdcSize) || 0;
    const ts = Number(a.timestamp); // seconds
    const tsMs = ts * 1000;
    // TRUE fill price = API `price` field; usdcSize/size would be fee-inclusive (usdcSize =
    // price·size + taker fee), overstating the price. usdc (=usdcSize) stays the real cost.
    const apiPx = Number(a.price);
    const effPx = Number.isFinite(apiPx) && apiPx > 0 ? apiPx : (size ? usdc / size : null);

    // ---- position accounting ----
    // snapshot the position BEFORE this event (for the property menu's before→after view)
    const posBefore = { upShares: w.upShares, downShares: w.downShares, upCost: w.upCost, downCost: w.downCost, totalCost: w.totalCost,
                        ifUpWins: w.upShares - w.totalCost, ifDownWins: w.downShares - w.totalCost };
    if (type === "TRADE") {
      const dir = a.side === "SELL" ? -1 : 1;
      if (side === "Up") { w.upShares += dir * size; w.upCost += dir * usdc; }
      else if (side === "Down") { w.downShares += dir * size; w.downCost += dir * usdc; }
      w.totalCost += dir * usdc; // SELL proceeds reduce net cost
      w.nTrades++;
    } else if (type === "SPLIT") {
      // mint complete sets: USDC -> Up + Down (attribute $/set 50/50 per side)
      w.upShares += size; w.downShares += size; w.totalCost += usdc; w.upCost += usdc / 2; w.downCost += usdc / 2; w.nSplit++;
    } else if (type === "MERGE") {
      // burn complete sets: Up + Down -> USDC
      w.upShares -= size; w.downShares -= size; w.totalCost -= usdc; w.upCost -= usdc / 2; w.downCost -= usdc / 2; w.nMerge++;
    } else if (type === "REDEEM") {
      w.nRedeem++; // realization of winning shares; PnL computed from shares+winSide
    }

    // ---- signal context from the feeds at fill time ----
    const asset = config.asset;
    const bz = state.binance[asset]?.value ?? null;
    const cl = state.chainlink[asset]?.value ?? null;
    const ctx = {
      tInto: ts - w.windowStart,
      binance: bz,
      chainlink: cl,
      // GAP = current feed price − that feed's window-open (poly-wow-bot convention).
      // gap% = (current − open)/|open|×100. Signed so direction is visible.
      binanceDopen: bz != null && w.openBinance != null ? bz - w.openBinance : null,
      binanceDopenPct: bz != null && w.openBinance != null && w.openBinance !== 0
        ? ((bz - w.openBinance) / Math.abs(w.openBinance)) * 100 : null,
      chainlinkDopen: cl != null && w.openPrice != null ? cl - w.openPrice : null,
      chainlinkDopenPct: cl != null && w.openPrice != null && w.openPrice !== 0
        ? ((cl - w.openPrice) / Math.abs(w.openPrice)) * 100 : null,
      // Cross-feed spread (binance − chainlink) — convergence gauge.
      spread: bz != null && cl != null ? bz - cl : null,
      spreadPct: bz != null && cl != null && cl !== 0 ? ((bz - cl) / cl) * 100 : null,
    };

    // ---- order book at fill (from ring buffer) ----
    const token = side === "Up" ? w.upTokenId : side === "Down" ? w.downTokenId : null;
    let book = null;
    let orderHint = null;
    let depth = null;
    if (type === "TRADE" && a.side === "BUY" && token) {
      const { before, after } = bookAround(state, token, tsMs);
      const askBefore = before?.bestAsk ?? null;
      const askAfter = after?.bestAsk ?? null;
      book = { askBefore, askAfter };
      orderHint = inferOrderType(effPx, askBefore, askAfter, size, usdc);
      const ds = depthAround(state, token, tsMs); // ask/bid ladder the order faced
      if (ds) depth = { asks: ds.asks, bids: ds.bids };
    }

    // ---- hedge / direction classification ----
    let posClass = null;
    if (type === "TRADE") {
      const netBefore = (side === "Up" ? w.upShares - size : w.upShares) -
                        (side === "Down" ? w.downShares - size : w.downShares);
      posClass = classifyHedge(netBefore, side, a.side);
    } else if (type === "SPLIT") posClass = "SPLIT(both sides)";
    else if (type === "MERGE") posClass = "MERGE(unwind both)";

    const rec = {
      key: eventKey(a),
      ts, tInto: ctx.tInto, type, action: a.side, side,
      size, usdc, effPx,
      ...ctx,
      book, orderHint, depth, posClass,
      netAfter: w.upShares - w.downShares,
      upShares: w.upShares, downShares: w.downShares, totalCost: w.totalCost,
      upCost: w.upCost, downCost: w.downCost, posBefore,
      tx: a.transactionHash, asset: a.asset,
    };
    w.events.push(rec);
    // Emit FIRST so a file-logging error can never drop the live broadcast.
    try { onEvent({ kind: "bot_event", slug: w.slug, windowStart: w.windowStart, rec, pnl: pnlView(w),
                    upShares: w.upShares, downShares: w.downShares, totalCost: w.totalCost,
                    openPrice: w.openPrice, openBinance: w.openBinance }); }
    catch (err) { console.error("[onEvent err]", err?.message, err?.stack?.split("\n")[1]?.trim()); }
    try { logEvent(w.slug, rec); } catch (err) { console.error("[logEvent err]", err?.message); }
    try { logCsv(w, rec); } catch (err) { console.error("[logCsv err]", err?.message); }
    return rec;
  }

  // ---- PnL views (called by dashboard / on settle) ----
  function pnlView(w) {
    const markUp = w.upTokenId ? state.bbaByToken.get(w.upTokenId)?.bestBid ?? null : null;
    const markDown = w.downTokenId ? state.bbaByToken.get(w.downTokenId)?.bestBid ?? null : null;
    const mtm = markUp != null && markDown != null
      ? w.upShares * markUp + w.downShares * markDown - w.totalCost
      : null;
    // NO modeled fee for the bot: its on-chain trades ALREADY have Polymarket fees applied
    // (baked into totalCost), so subtracting a modeled fee would double-count. Fees are only
    // modeled for the SHADOW (hypothetical fills at quoted prices). [fee kept as 0 for shape.]
    const fee = 0;
    return {
      ifUpWins: w.upShares - w.totalCost,
      ifDownWins: w.downShares - w.totalCost,
      markUp, markDown, mtm, fee,
      realized: w.winSide
        ? (w.winSide === "Up" ? w.upShares : w.downShares) - w.totalCost
        : null,
    };
  }

  function settle(w) {
    if (w.settledLogged || !w.winSide) return;
    w.settledLogged = true;
    const pnl = pnlView(w);
    const summary = {
      slug: w.slug, windowStart: w.windowStart, winSide: w.winSide,
      openPrice: w.openPrice, openBinance: w.openBinance,
      upShares: round(w.upShares), downShares: round(w.downShares),
      netShares: round(w.upShares - w.downShares), totalCost: round(w.totalCost),
      realizedPnl: round(pnl.realized),
      nTrades: w.nTrades, nSplit: w.nSplit, nMerge: w.nMerge, nRedeem: w.nRedeem,
      endedNetLongWinner: (w.winSide === "Up" ? w.upShares > w.downShares : w.downShares > w.upShares),
    };
    fs.appendFileSync(path.join(config.dataDir, "summary.jsonl"), JSON.stringify(summary) + "\n");
    try { onEvent({ kind: "window_resolved", slug: w.slug, windowStart: w.windowStart, summary }); } catch {}
    return summary;
  }

  // Per-window CSV (one file per window, one row per event) — spreadsheet/pandas
  // friendly. Header written once per file. Buys are the bulk; SPLIT/MERGE/REDEEM
  // also captured with their type so the file is a complete per-window ledger.
  const csvHeaderDone = new Set();
  const CSV_COLS = [
    "ts_unix", "time_utc", "t_into_s", "type", "action", "side",
    "shares", "usdc", "eff_px",
    "bz_price", "bz_gap", "bz_gap_pct",
    "cl_price", "cl_gap", "cl_gap_pct",
    "spread", "spread_pct",
    "ask_before", "ask_after", "ask_jump", "taker", "book_walk", "order_hint",
    "pos_class", "up_shares", "down_shares", "net_shares", "total_cost",
    "open_chainlink", "open_binance", "win_side", "tx",
  ];
  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function logCsv(w, rec) {
    const file = path.join(config.dataDir, `${w.slug}.csv`);
    if (!csvHeaderDone.has(w.slug)) {
      csvHeaderDone.add(w.slug);
      if (!fs.existsSync(file)) fs.appendFileSync(file, CSV_COLS.join(",") + "\n");
    }
    const row = [
      rec.ts,
      new Date(rec.ts * 1000).toISOString(),
      rec.tInto, rec.type, rec.action, rec.side,
      rec.size, rec.usdc, rec.effPx,
      rec.binance, rec.binanceDopen, rec.binanceDopenPct,
      rec.chainlink, rec.chainlinkDopen, rec.chainlinkDopenPct,
      rec.spread, rec.spreadPct,
      rec.book?.askBefore, rec.book?.askAfter, rec.orderHint?.askJump,
      rec.orderHint?.taker, rec.orderHint?.bookWalk, rec.orderHint?.label,
      rec.posClass, rec.upShares, rec.downShares, rec.netAfter, rec.totalCost,
      w.openPrice, w.openBinance, w.winSide, rec.tx,
    ];
    fs.appendFileSync(file, row.map(csvCell).join(",") + "\n");
  }

  function logEvent(slug, rec) {
    fs.appendFileSync(path.join(config.dataDir, `${slug}.jsonl`), JSON.stringify(rec) + "\n");
  }

  function getView() {
    return { windows, unknownSlugEvents, pnlView };
  }

  // Drop windows that closed long ago (keep N most recent closed for settlement).
  function prune(nowSec) {
    const closed = [...windows.values()]
      .filter((w) => w.windowEnd < nowSec)
      .sort((x, y) => y.windowStart - x.windowStart);
    for (const w of closed.slice(config.keepClosedWindows)) windows.delete(w.slug);
  }

  return { onActivity, register, updateMeta, ensure, getView, settle, pnlView, prune, windows };
}

/** Hedge vs directional add, relative to net position BEFORE this fill. */
function classifyHedge(netBefore, side, action) {
  if (action === "SELL") return "REDUCE(sell)";
  if (Math.abs(netBefore) < EPS) return "OPEN";
  const buyingUp = side === "Up";
  const longUp = netBefore > 0;
  // buying the opposite side of current net => hedging/flattening
  if (buyingUp !== longUp) return "HEDGE(reduce net)";
  return "ADD(grow net)";
}

/**
 * Order-type inference from public data alone.
 *  - taker: paid >= best ask before the fill (crossed the spread).
 *  - bookWalk: paid clearly above best ask => swept multiple levels.
 *  - askJump: best ask rose right after => liquidity removed (taker confirmed).
 * FAK vs FOK can't be labelled directly, but partial/sweep footprints (flagged
 * here + small-then-refire detected at sequence level) point to FAK.
 */
function inferOrderType(effPx, askBefore, askAfter, size, usdc) {
  if (effPx == null) return null;
  // TAKER = a fee was charged (usdcSize > price·shares) — ground truth, vs the old effPx≥ask guess.
  const extra = (usdc != null && size) ? usdc - effPx * size : null;
  const expFee = size ? 0.07 * effPx * (1 - effPx) * size : 0;
  const taker = extra == null ? null : (expFee > 0 ? extra > 0.5 * expFee : extra > 0.001);
  const bookWalk = askBefore != null ? effPx > askBefore + 0.005 : null;
  const askJump = askBefore != null && askAfter != null ? askAfter - askBefore : null;
  let label = "unknown";
  if (taker === true) label = bookWalk ? "TAKER/book-walk (marketable, FAK-like)" : "TAKER (marketable, paid fee)";
  else if (taker === false) label = "MAKER (resting — no fee)";
  return { taker, bookWalk, askBefore, askAfter, askJump, label };
}

const round = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
