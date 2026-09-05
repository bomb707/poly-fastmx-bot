import { config } from "../config/config.js";
import { fmt, sign, hms, currentWindowStart } from "../util/util.js";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const pnlc = (v) => (v == null ? "—" : v >= 0 ? C.g(sign(v)) : C.r(sign(v)));

export function render(state, tracker) {
  const a = config.asset;
  const bz = state.binance[a]?.value;
  const cl = state.chainlink[a]?.value;
  const out = [];
  out.push(C.b(`\n━━ Tracker  ${a.toUpperCase()} ${config.interval}  ${new Date().toISOString().slice(11, 19)}Z ━━`));

  const view = tracker.getView();
  const curStart = currentWindowStart();
  // Show ONLY the current live window. (Closed windows are still tracked in the
  // background for settlement + summary.jsonl; they're just not rendered.)
  const wins = [...view.windows.values()].filter((w) => w.windowStart === curStart);
  const live = wins[0] ?? null;

  // Per-feed GAP = current price − that feed's window-open (poly-wow-bot convention).
  // gap% = (current − open) / open × 100. Sign kept so direction is visible.
  const gapBlock = (cur, open) => {
    if (cur == null || open == null || open === 0) return { g: null, pct: null };
    return { g: cur - open, pct: ((cur - open) / Math.abs(open)) * 100 };
  };
  const bzG = gapBlock(bz, live?.openBinance);
  const clG = gapBlock(cl, live?.openPrice);
  const gp = (x) => (x == null ? "—" : (x >= 0 ? C.g(sign(x)) : C.r(sign(x))));
  const gpp = (x) => (x == null ? "—" : (x >= 0 ? C.g(sign(x, 3) + "%") : C.r(sign(x, 3) + "%")));
  // Cross-feed spread (binance − chainlink), still handy as a convergence gauge.
  const spread = bz != null && cl != null ? bz - cl : null;
  const spreadPct = spread != null && cl ? (spread / cl) * 100 : null;

  out.push(
    `binance   ${C.c(fmt(bz))}  gap ${gp(bzG.g)} (${gpp(bzG.pct)})  ${C.dim("open " + fmt(live?.openBinance) + "  age " + age(state.binance[a]?.recvTs))}`
  );
  out.push(
    `chainlink ${C.c(fmt(cl))}  gap ${gp(clG.g)} (${gpp(clG.pct)})  ${C.dim("open " + fmt(live?.openPrice) + "  age " + age(state.chainlink[a]?.recvTs))}`
  );
  out.push(
    C.dim(`spread(bz-cl) `) + `${gp(spread)} (${gpp(spreadPct)})`
  );

  if (!wins.length) {
    out.push(C.dim("\n  (waiting for live window…)"));
    process.stdout.write("\x1b[2J\x1b[H" + out.join("\n") + "\n");
    return;
  }

  for (const w of wins) {
    const live = true;
    const pnl = view.pnlView(w);
    const upA = w.upTokenId ? state.bbaByToken.get(w.upTokenId) : null;
    const dnA = w.downTokenId ? state.bbaByToken.get(w.downTokenId) : null;
    const tag = live ? C.y("● LIVE") : w.winSide ? C.dim(`✔ ${w.winSide}`) : C.dim("…closing");
    out.push(
      `\n${C.b(w.slug)}  ${tag}  ${C.dim(hms(w.windowStart) + "→" + hms(w.windowEnd))}` +
      `  open ${fmt(w.openPrice)}`
    );
    out.push(
      `  book  Up ask ${fmt(upA?.bestAsk, 3)}/bid ${fmt(upA?.bestBid, 3)}   ` +
      `Down ask ${fmt(dnA?.bestAsk, 3)}/bid ${fmt(dnA?.bestBid, 3)}`
    );
    out.push(
      `  pos   Up ${C.c(fmt(w.upShares))}sh  Down ${C.c(fmt(w.downShares))}sh  ` +
      `net ${sign(w.upShares - w.downShares)}  cost $${fmt(w.totalCost)}  ` +
      C.dim(`trades ${w.nTrades} split ${w.nSplit} merge ${w.nMerge} redeem ${w.nRedeem}`)
    );
    if (w.winSide) {
      out.push(`  pnl   ${C.b("REALIZED " + pnlc(pnl.realized))}  (winner ${w.winSide})`);
    } else {
      out.push(
        `  pnl   ifUp ${pnlc(pnl.ifUpWins)}  ifDown ${pnlc(pnl.ifDownWins)}  ` +
        `MtM ${pnlc(pnl.mtm)}`
      );
    }
    // last 3 events
    for (const e of w.events.slice(-3)) {
      const oh = e.orderHint?.label ? C.dim(e.orderHint.label) : "";
      out.push(
        C.dim(`   t+${String(e.tInto).padStart(3)}s `) +
        `${e.type === "TRADE" ? e.action + " " + e.side : e.type} ` +
        `${fmt(e.size)}sh @${fmt(e.effPx, 3)} ` +
        C.dim(
          `bzGap${sign(e.binanceDopen)}${e.binanceDopenPct != null ? "(" + sign(e.binanceDopenPct, 3) + "%)" : ""} ` +
          `clGap${sign(e.chainlinkDopen)}${e.chainlinkDopenPct != null ? "(" + sign(e.chainlinkDopenPct, 3) + "%)" : ""} `
        ) +
        `${classColor(e.posClass)} ${oh}`
      );
    }
  }
  out.push(C.dim(`\nunknown-slug events: ${view.unknownSlugEvents}   data → ${config.dataDir}`));
  // clear screen + home, then paint
  process.stdout.write("\x1b[2J\x1b[H" + out.join("\n") + "\n");
}

function classColor(c) {
  if (!c) return "";
  if (c.startsWith("HEDGE")) return C.y(c);
  if (c.startsWith("ADD")) return C.c(c);
  if (c.startsWith("OPEN")) return C.b(c);
  return C.dim(c);
}
function age(recvTs) {
  if (!recvTs) return "—";
  const ms = Date.now() - recvTs;
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

/**
 * Headless one-line status for non-TTY output (pm2 / nohup logs). No
 * clear-screen, no ANSI — append-only so `pm2 logs` stays readable. The JSONL
 * + CSV files remain the real dataset; this is just a heartbeat.
 */
export function renderHeadless(state, tracker, shadow = null) {
  const a = config.asset;
  const bz = state.binance[a]?.value;
  const cl = state.chainlink[a]?.value;
  const view = tracker.getView();
  const curStart = currentWindowStart();
  const w = [...view.windows.values()].find((x) => x.windowStart === curStart);
  const ts = new Date().toISOString().slice(11, 19);
  if (!w) {
    console.log(`[${ts}Z] waiting for live window…  bz ${fmt(bz)} cl ${fmt(cl)}`);
    return;
  }
  const bzGapPct = bz != null && w.openBinance ? ((bz - w.openBinance) / Math.abs(w.openBinance)) * 100 : null;
  const clGapPct = cl != null && w.openPrice ? ((cl - w.openPrice) / Math.abs(w.openPrice)) * 100 : null;
  // BINANCE FEED HEALTH — append only when NOT healthy (stale trade or accumulated failures), so pm2 logs flag it.
  const bh = state.binanceHealth, bzAge = state.binance[a]?.recvTs ? Date.now() - state.binance[a].recvTs : null;
  const bzStale = bzAge != null && bzAge > (config.binanceQuoteStaleReconnectMs || 30000);
  const bhStr = bh && (bzStale || bh.reconnects || bh.staleReconnects || bh.errors)
    ? ` | BZFEED ${bzStale ? "STALE " + Math.round(bzAge / 1000) + "s " : ""}reconn ${bh.reconnects} stale ${bh.staleReconnects} err ${bh.errors}` : "";
  // In Helpme simulation the optional tracker is hidden by default and is
  // separate from our modeled position. Printing its empty ledger after a
  // shadow fill made healthy runs look broken.
  // Use the shadow ledger for the PM2 heartbeat while leaving tracker mode
  // unchanged for deployments that explicitly show it.
  const sw = config.showTracker === false
    ? [...(shadow?.windows?.values?.() || [])].find((x) => x.windowStart === curStart) : null;
  const showingShadow = !!sw;
  const position = showingShadow ? {
    upShares: +sw.upShares || 0, downShares: +sw.downShares || 0,
    totalCost: +sw.cost || 0, fee: +sw.fee || 0, merged: +sw.mergedRealized || 0,
  } : { upShares: w.upShares, downShares: w.downShares, totalCost: w.totalCost,
    fee: 0, merged: 0 };
  const trackerPnl = showingShadow ? null : view.pnlView(w);
  const upBid = w.upTokenId ? state.bbaByToken.get(w.upTokenId)?.bestBid : null;
  const downBid = w.downTokenId ? state.bbaByToken.get(w.downTokenId)?.bestBid : null;
  const pnl = showingShadow ? {
    ifUpWins: position.upShares - position.totalCost - position.fee + position.merged,
    ifDownWins: position.downShares - position.totalCost - position.fee + position.merged,
    mtm: upBid != null && downBid != null
      ? position.upShares * upBid + position.downShares * downBid
        - position.totalCost - position.fee + position.merged : null,
  } : trackerPnl;
  const last = showingShadow ? sw.fills.at(-1) : w.events[w.events.length - 1];
  const lastSize = showingShadow ? last?.shares : last?.size;
  const lastStr = last ? ` | last t+${Math.round(last.tInto * 1000) / 1000}s ${showingShadow
    ? `BUY ${last.side}` : (last.type === "TRADE" ? `${last.action} ${last.side}` : last.type)} `
    + `${fmt(lastSize)}sh@${fmt(last.effPx, 3)}` : "";
  const tInto = Math.floor(Date.now() / 1000) - w.windowStart;
  console.log(
    `[${ts}Z] ${w.slug} t+${tInto}s | ` +
    `bz ${fmt(bz)}(${sign(bzGapPct, 3)}%) cl ${fmt(cl)}(${sign(clGapPct, 3)}%) | ` +
    `${showingShadow ? "SHADOW " : ""}Up ${fmt(position.upShares)} Dn ${fmt(position.downShares)} ` +
    `net ${sign(position.upShares - position.downShares)} cost $${fmt(position.totalCost)} | ` +
    `ifUp ${sign(pnl.ifUpWins)} ifDn ${sign(pnl.ifDownWins)} MtM ${pnl.mtm == null ? "—" : sign(pnl.mtm)}` +
    lastStr + bhStr
  );
}
