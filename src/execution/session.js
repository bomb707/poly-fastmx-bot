// session.js — session-level backtest. Replays the bot AND the shadow strategy over
// every window in [startTs, endTs] against a running USDC balance, settling winners
// each window, and returns the session PnL / ROI / drawdown / balance curve for each.
import { config } from "../config/config.js";
import { fetchWindowHistory } from "../sources/history.js";
import { simulateFills } from "../../engine/simrun.js";
import { fillFee, isTakerFill, isFeeFill } from "../../engine/fees.js";
import { apiHealth, resetApiHealth } from "../util/util.js";
import { verbose, verboseOn } from "../logging/verbose.js";
import { writeBacktestManifest } from "../logging/sessionLog.js";

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => x == null ? null : Math.round(x * 10000) / 10000;

// Walk one window's fills against a running balance (constraint: can't spend what you don't have).
// Settlement pays winnerShares × $1. applyFee: model the taker fee (true for the SHADOW's
// hypothetical fills; FALSE for the bot, whose on-chain trades already include fees).
function runWindowFills(fills, winSide, bal0, applyFee = true, unconstrained = false) {
  const sorted = fills.slice().sort((a, b) => a.tInto - b.tInto);
  // Fill taxonomy retained for compatibility with historical recorded sessions:
  //   BUY   → deploys capital (bal−), adds shares.
  //   SELL  (f.sell) → the scalp's exit: frees capital (bal+ proceeds−fee), removes shares. RECYCLES capital,
  //           so it lowers peak deploy. The closed round-trip's realized PnL is booked (proceeds − matched buy cost).
  //   MERGE (f.leg==="merge") → reclaim `reclaimUsd` cash, remove `sets` from BOTH sides (PnL-neutral vs settlement).
  const isSell = (f) => !!f.sell;
  const isMerge = (f) => f.leg === "merge";
  const feeOf = (f, px, shares, scale = 1) => Number.isFinite(Number(f.fee))
    ? Number(f.fee) * scale : fillFee(px, shares, isFeeFill(f));
  // pass 1 — PEAK intra-window deployment at full size (signed: sells/merges give capital back). Capital
  // recycles, so the real constraint is the running peak. If the bankroll can't cover it, SCALE every fill.
  let dep = 0, peakFull = 0;
  for (const f of sorted) {
    if (isMerge(f)) { dep -= (Number(f.reclaimUsd) || 0); continue; }
    const sh = Number(f.shares) || 0; if (sh <= 0) continue;
    const px = f.effPx ?? (sh ? f.usdc / sh : null);
    const usdc = f.usdc ?? (px != null ? px * sh : 0);
    if (isSell(f)) { dep -= applyFee ? usdc - feeOf(f, px, sh) : usdc; }   // sell returns capital
    else { dep += applyFee ? usdc + feeOf(f, px, sh) : usdc; }             // buy deploys capital
    peakFull = Math.max(peakFull, dep);
  }
  // TRACKER (unconstrained): never scale — the bot's stats are its REAL activity. Only the SHADOW scales.
  const scale = (!unconstrained && peakFull > bal0 && peakFull > 0) ? bal0 / peakFull : 1;
  // pass 2 — apply scaled fills. FIFO buy-lots per side so a sell/merge can realize its closed round-trip PnL.
  let bal = bal0, deployed = 0, peak = 0, spent = 0, fees = 0, realized = 0;
  const held = { Up: 0, Down: 0 };
  const lots = { Up: [], Down: [] };   // each: { sh, cps } — cost-per-share incl. buy fee (for FIFO matching)
  const popCost = (side, sh) => {      // pop `sh` shares FIFO from the side's buy-lots → their total cost
    let need = sh, c = 0; const arr = lots[side];
    while (need > 1e-9 && arr.length) { const lot = arr[0]; const take = Math.min(need, lot.sh);
      c += take * lot.cps; lot.sh -= take; need -= take; if (lot.sh <= 1e-9) arr.shift(); }
    return c;
  };
  const detail = [];
  for (const f of sorted) {
    // ── MERGE: reclaim cash, drop `sets` from both sides, realize (reclaim − matched buy cost of both legs) ──
    if (isMerge(f)) {
      const sets = (Number(f.sets) || 0) * scale, reclaim = (Number(f.reclaimUsd) || 0) * scale;
      bal += reclaim; deployed -= reclaim; spent -= reclaim;
      realized += reclaim - popCost("Up", sets) - popCost("Down", sets);
      held.Up -= sets; held.Down -= sets;
      detail.push({ tInto: r2(f.tInto), side: "both", shares: r2(sets), px: 1, usdc: r2(reclaim), fee: 0,
                    taker: false, kind: "merge", exec: null, leg: "merge", reason: f.reason ?? null, sell: false,
                    scaled: scale < 0.999, balAfter: r2(bal) });
      continue;
    }
    const sh0 = Number(f.shares) || 0; if (sh0 <= 0) continue;
    const px = f.effPx ?? (sh0 ? f.usdc / sh0 : null);
    const sh = sh0 * scale;
    const usdc = (f.usdc ?? (px != null ? px * sh0 : 0)) * scale;
    const taker = isTakerFill(f);
    if (isSell(f)) {
      // ── SELL (scalp exit): cash in = proceeds − sell fee; remove shares; realize vs matched buy cost ──
      const fee = applyFee ? feeOf(f, px, sh, scale) : (px != null ? Math.max(0, px * sh - usdc) : 0);
      const cash = usdc - fee;                          // net proceeds
      bal += cash; deployed -= cash; spent -= usdc; fees += fee;
      if (f.side === "Up") held.Up -= sh; else held.Down -= sh;
      realized += cash - popCost(f.side, sh);
      detail.push({ tInto: r2(f.tInto), side: f.side, shares: r2(sh), px: r4(px), usdc: r2(usdc),
                    fee: r4(fee), taker, kind: f.kind ?? null, exec: f.exec ?? null, leg: f.leg ?? "exit", reason: f.reason ?? null,
                    sell: true, scaled: scale < 0.999, balAfter: r2(bal) });
      continue;
    }
    // ── BUY ──
    // SHADOW (applyFee): model the taker fee and ADD it on top of price·shares.
    // BOT (!applyFee): the fee is ALREADY inside usdcSize — show it but DON'T re-add it to cost.
    let fee, cost;
    if (applyFee) { fee = feeOf(f, px, sh, scale); cost = usdc + fee; }
    else { fee = px != null ? Math.max(0, usdc - px * sh) : 0; cost = usdc; }
    bal -= cost; deployed += cost; spent += usdc; fees += fee;
    if (f.side === "Up") held.Up += sh; else held.Down += sh;
    if (sh > 1e-9) lots[f.side].push({ sh, cps: cost / sh });   // lot cost incl. buy fee → FIFO basis for a later sell
    peak = Math.max(peak, deployed);
    detail.push({ tInto: r2(f.tInto), side: f.side, shares: r2(sh), px: r4(px), usdc: r2(usdc),
                  fee: r4(fee), taker, kind: f.kind ?? null, exec: f.exec ?? null, leg: f.leg ?? null, reason: f.reason ?? null,
                  sell: false, scaled: scale < 0.999, balAfter: r2(bal) });
  }
  const winnerShares = winSide === "Up" ? held.Up : held.Down;   // shares STILL open at settlement (post sells/merges)
  bal += winnerShares;                              // settlement pays winners $1
  return { balAfter: bal, pnl: bal - bal0, realized, peakDeploy: peak, scale, spent, fees, winnerShares,
           net: held.Up > held.Down ? "Up" : "Down", held: { ...held }, detail };
}

function emptyAgg(initial) {
  return { initial, bal: initial, peakBal: initial, troughBal: initial, maxDD: 0, pnl: 0, realized: 0,
           wins: 0, losses: 0, n: 0, scaledWindows: 0, minScale: 1, peakDeploy: 0, invested: 0, fees: 0, best: -1e9, worst: 1e9, curve: [] };
}
function step(agg, r, ws) {
  agg.bal = r.balAfter; agg.pnl = agg.bal - agg.initial; agg.n++;
  if (r.pnl > 0) agg.wins++; else if (r.pnl < 0) agg.losses++;
  if (r.scale < 0.999) { agg.scaledWindows++; agg.minScale = Math.min(agg.minScale, r.scale); }
  agg.fees += r.fees; agg.peakDeploy = Math.max(agg.peakDeploy, r.peakDeploy); agg.invested += r.spent;   // total USDC into buys
  agg.realized += (r.realized || 0);   // Σ closed round-trip PnL (scalp sells/merges) — outcome-independent
  agg.best = Math.max(agg.best, r.pnl); agg.worst = Math.min(agg.worst, r.pnl);
  agg.peakBal = Math.max(agg.peakBal, agg.bal); agg.troughBal = Math.min(agg.troughBal, agg.bal);
  agg.maxDD = Math.max(agg.maxDD, agg.peakBal - agg.bal);   // peak-to-trough drawdown ($)
  agg.curve.push({ ws, bal: Math.round(agg.bal * 100) / 100, pnl: Math.round(r.pnl * 100) / 100 });
}
function finalize(agg) {
  const r2 = (x) => Math.round(x * 100) / 100;
  return { initial: agg.initial, final: r2(agg.bal), pnl: r2(agg.pnl), realized: r2(agg.realized),
           roi: agg.initial ? r2(100 * agg.pnl / agg.initial) : null,
           windows: agg.n, wins: agg.wins, losses: agg.losses,
           // win rate = wins / (wins+losses) — windows that actually had a P&L outcome (excludes no-trade / breakeven)
           winRate: (agg.wins + agg.losses) ? r2(100 * agg.wins / (agg.wins + agg.losses)) : null,
           meanPnl: agg.n ? r2(agg.pnl / agg.n) : null, best: agg.n ? r2(agg.best) : null, worst: agg.n ? r2(agg.worst) : null,
           maxDrawdown: r2(agg.maxDD), maxDrawdownPct: agg.peakBal ? r2(100 * agg.maxDD / agg.peakBal) : null,
           peakDeploy: r2(agg.peakDeploy), invested: r2(agg.invested), fees: r2(agg.fees),
           scaledWindows: agg.scaledWindows, minScale: r2(agg.minScale), curve: agg.curve };
}

/** Run the session backtest. start/end in unix seconds; initialUSDC the starting balance.
 *  params = strategy config (the UI's shadowParams) merged over STRAT; undefined → STRAT defaults.
 *  onProgress(done, total, phase) — fetch/replay progress (called often).
 *  onPartial(partialResult) — mid-run snapshot (~every 10s) with cards/curve so far (no strategy change).
 *  isCancelled() — return true to abort early (e.g. a newer Run superseded this one). */
export async function runSession(startTs, endTs, initialUSDC, onProgress = () => {}, params = undefined, onPartial = null, isCancelled = () => false) {
  const start = Math.ceil(Number(startTs) / config.windowSec) * config.windowSec;
  // allow start == end (or end within the same window): backtest that single window.
  const end = Math.max(Number(endTs), start + config.windowSec);
  const initial = Number(initialUSDC);
  const slugs = [];
  for (let ws = start; ws < end; ws += config.windowSec) slugs.push(`${config.asset}-updown-${config.interval}-${ws}`);
  // Hard runaway guard only. Large ranges are allowed but THROTTLED (SESSION_FETCH_DELAY_MS).
  if (slugs.length > 20000) throw new Error(`range too large (${slugs.length} windows); max 20000`);

  resetApiHealth();   // fresh API counters for this run (UI health panel)
  const tRun0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Adaptive fetch: large ranges use fewer workers + a bit more delay so we stay under the backtest API rate limit
  // (~1000/min) instead of stampeding into 429s / retries that make 30d look "stuck".
  const n = slugs.length;
  const conc = n > 4000 ? 3 : n > 1500 ? 4 : n > 400 ? 5 : 6;
  const delayMs = Number(process.env.SESSION_FETCH_DELAY_MS ?? (n > 1500 ? 50 : 25));
  const ticksOnly = !config.showTracker;   // shadow-only dashboards skip Polymarket activity (½ the remote calls)
  const BATCH = Math.max(conc * 8, 24);    // fetch+process in chronological chunks → mid-results without holding everything
  const PARTIAL_MS = 10000;

  const bot = emptyAgg(initial), sh = emptyAgg(initial);
  const windows = [];
  let done = 0, used = 0, miss = 0, errN = 0;
  let lastPartialAt = 0;
  const btRows = [];   // per-window backtest manifest rows (deterministic → diffable across processes)

  const side = (x) => ({ pnl: r2(x.pnl), realized: r2(x.realized || 0), deployed: r2(x.peakDeploy), invested: r2(x.spent), fees: r2(x.fees), winnerShares: r2(x.winnerShares),
                         net: x.net, held: { Up: r2(x.held.Up), Down: r2(x.held.Down) },
                         scale: r2(x.scale), scaled: x.scale < 0.999, fills: x.detail });

  const healthSnap = () => {
    const a = apiHealth();
    const elapsedS = Math.max(0.001, (Date.now() - tRun0) / 1000);
    const mu = process.memoryUsage();
    return {
      api: {
        reqs: a.reqs, ok: a.ok, fail: a.fail, http429: a.http429, http5xx: a.http5xx,
        timeouts: a.timeouts, retries: a.retries,
        avgMs: a.avgMs, lastMs: a.lastMs, lastStatus: a.lastStatus,
        limit: a.limit, remaining: a.remaining, reset: a.reset,
        rps: +(a.reqs / elapsedS).toFixed(1),
      },
      fetch: { done, total: slugs.length, used, miss, err: errN, conc, delayMs, ticksOnly, apiVer: config.backtestApiVersion },
      mem: { heapMB: Math.round(mu.heapUsed / 1e6), rssMB: Math.round(mu.rss / 1e6) },
      elapsedS: Math.round(elapsedS),
    };
  };

  const push = () => onProgress(done, slugs.length, "fetch", used, healthSnap());

  const emitPartial = (force = false) => {
    if (!onPartial || isCancelled()) return;
    const now = Date.now();
    if (!force && now - lastPartialAt < PARTIAL_MS) return;
    lastPartialAt = now;
    try {
      onPartial({
        partial: true, start, end, initial,
        windowsRequested: slugs.length, windowsUsed: used, done, total: slugs.length,
        asset: config.asset, interval: config.interval, windowSec: config.windowSec, wallet: config.wallet,
        apiVersion: config.backtestApiVersion,
        method: "bot real on-chain fills; shadow = FastMX dual momentum plus poly-mom Binance trend regime; settle winners @ $1",
        params: params ?? null, bot: finalize(bot), shadow: finalize(sh),
        health: healthSnap(),
        windows: [],
      });
    } catch {}
  };

  // Fetch one chronological batch with a small worker pool, then replay in order (balance is sequential).
  async function fetchBatch(batch) {
    const got = new Map();
    const q = [...batch];
    await Promise.all(Array.from({ length: Math.min(conc, batch.length) }, async () => {
      while (q.length) {
        if (isCancelled()) return;
        const slug = q.shift();
        try {
          const d = await fetchWindowHistory(slug, { ticksOnly });
          if (d?.ticks?.length && d?.winSide) got.set(slug, d);
          else miss++;
        } catch { errN++; }
        done++;
        // Throttle health pushes a bit (every window is fine numerically; WS flood is the concern — ui-server coalesces).
        if (done % 3 === 0 || done === slugs.length) push();
        if (delayMs > 0) await sleep(delayMs);
      }
    }));
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { cancelled: true });
    return batch.map((s) => got.get(s)).filter(Boolean);
  }

  for (let i = 0; i < slugs.length; i += BATCH) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { cancelled: true });
    const batch = slugs.slice(i, i + BATCH);
    const wins = await fetchBatch(batch);
    for (const d of wins) {
      const botFills = (d.buys || []).map((b) => ({ tInto: b.tInto, side: b.side, shares: b.shares, usdc: b.usdc, effPx: b.effPx, taker: b.orderHint?.taker ?? b.taker ?? null }));
      const simFills = simulateFills({ ticks: d.ticks, openBinance: d.openBinance,
        openPrice: d.openPrice, windowStart: d.windowStart }, params || {});

      const br = runWindowFills(botFills, d.winSide, bot.bal, false, true);
      const sr = runWindowFills(simFills, d.winSide, sh.bal, true, false);
      step(bot, br, d.windowStart);
      step(sh, sr, d.windowStart);
      windows.push({ ws: d.windowStart, slug: d.slug ?? null, winSide: d.winSide, bot: side(br), shadow: side(sr) });
      used++;
      // BACKTEST MANIFEST — deterministic per-window record (no timestamp) so two processes' runs of the same range
      //   diff cleanly: differing ticks/openBz ⇒ DATA divergence; same data but differing fills/PnL ⇒ CODE divergence.
      const _nTk = d.ticks ? d.ticks.length : 0;
      const _shEnt = simFills.filter((f) => f.leg === "entry").length;
      const _shRide = simFills.filter((f) => f.reason === "open-ride").length;
      const _shPnl = sr && sr.pnl != null ? sr.pnl : 0;
      btRows.push({ ws: d.windowStart, line: `ws=${d.windowStart} win=${d.winSide} ticks=${_nTk} openBz=${d.openBinance != null ? Math.round(d.openBinance * 100) / 100 : "null"} shEntries=${_shEnt} shRides=${_shRide} shPnl=${_shPnl.toFixed(2)}` });
      if (verboseOn) verbose("bt.win", { ws: d.windowStart, win: d.winSide, ticks: _nTk, openBz: d.openBinance, ent: _shEnt, ride: _shRide, pnl: +_shPnl.toFixed(2) });
      // Drop heavy per-window fetch payload ASAP so RAM stays bounded.
      d.ticks = null; d.buys = null;
      for (const k of Object.keys(d)) { if (k !== "windowStart" && k !== "slug" && k !== "winSide") d[k] = null; }
    }
    wins.length = 0;   // release the batch array itself
    push();
    emitPartial(false);
  }
  emitPartial(true);   // one last mid-frame right before the full result

  // Write the diffable per-window backtest manifest (always — cheap, ~1 line/window; the primary tool to compare runs).
  try {
    btRows.sort((a, b) => a.ws - b.ws);
    const hdr = `# backtest ${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`
      + ` | requested=${slugs.length} used=${used} miss=${miss} err=${errN}`
      + ` | api=${config.backtestApiVersion}`
      + ` | shadowPnl=${(sh.pnl || 0).toFixed(2)} botPnl=${(bot.pnl || 0).toFixed(2)}`;
    const fp = writeBacktestManifest(`${start}_${end}`, hdr + "\n" + btRows.map((r) => r.line).join("\n") + "\n");
    if (fp) console.log(`[backtest] manifest (${btRows.length} windows) → ${fp}`);
  } catch {}

  const result = { start, end, initial, windowsRequested: slugs.length, windowsUsed: used,
           asset: config.asset, interval: config.interval, windowSec: config.windowSec, wallet: config.wallet,
           apiVersion: config.backtestApiVersion,
           method: "bot real on-chain fills; shadow = FastMX dual momentum plus poly-mom Binance trend regime; settle winners @ $1",
           params: params ?? null, bot: finalize(bot), shadow: finalize(sh), windows,
           health: healthSnap() };
  // Help GC: drop the running aggregators' curve buffers (already copied into finalize()).
  bot.curve = []; sh.curve = [];
  return result;
}
