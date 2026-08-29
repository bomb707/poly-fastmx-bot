// research/backtest-daily.mjs — reproduce the Lockstep backtest from a given slug/window to now, broken out by
// UTC day. Uses the ENGINE's simulateFills (the same strategy core that runs live) + the exact deployed modal
// config, driven with a cross-round intensity buffer (the real backtest driver). winSide comes from bapi settlement.
//
// Usage:  node research/backtest-daily.mjs <startSlugOrUnix> [latencyList=520] [key=val ...]
//   e.g.  node research/backtest-daily.mjs btc-updown-5m-1786665600
import { config } from "../src/config/config.js";
import { fetchWindowHistory } from "../src/sources/history.js";
import { simulateFills, positionFromFills } from "../engine/simrun.js";
import { STRAT } from "../engine/strategy.js";
import { roundExcursion, computeIntensity, intensityReady, makeIntensityBuffer, pushExcursion } from "../engine/intensity.js";

const A = process.argv.slice(2);
const START = (() => { const s = String(A[0] || "").trim(); const n = Number(s.split("-").pop()); return Number.isFinite(n) ? n : NaN; })();
if (!Number.isFinite(START)) { console.log("give a start slug (btc-updown-5m-<unix>) or unix."); process.exit(1); }
const LATS = String(A[1] || "520").split(",").map(Number).filter((x) => x >= 0);
const OVER = {}; for (const a of A.slice(2)) {
  const [k, ...rest] = a.split("="); const v = rest.join("=");
  if (!k || v == null) continue;
  if (!isNaN(+v)) OVER[k] = +v;
  else { try { OVER[k] = JSON.parse(v); } catch { OVER[k] = v; } }
}
const WIN = 300;
config.asset = "btc"; config.interval = "5m";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the EXACT deployed modal config (public/index.html shadowParams defaults), spread over engine STRAT ──
const MODAL = {
  SIZE: 40, LIMIT: 0.99, TICK: 0.01, MIN_ORDER_USD: 1, WINDOW_SEC: WIN, MERGE_ON: false, MERGE_X: 2, MAX_SESSION_LOSS: 0,
  L_ON: true, L_EDGE_BUFFER: 8, L_ENTRY_FLOOR: 0.50, L_ENTRY_CEIL: 0.88, L_SKIP_END_S: 5, L_MIN_GAP: 0,
  L_MIN_TIME_S: 1, L_SKIP_OPEN_S: 0, L_ONE_PER_ROUND: true,
  L_HEDGE_CAP: 0.02, L_HEDGE_EXEC: "maker", L_HEDGE_MAKER_OFFSET: 0.01, L_HEDGE_MAKER_TIMEOUT_S: 0, L_HEDGE_EAGER: false,
  L_SIM_FILL_PCT: 100, L_SIM_TOUCH_MS: 250, L_END_HEDGE_S: 0,
  L_SCALING: "sqrt", L_VOL_MODE: "max", L_VOL_ROUNDS: 6, L_MAX_ENTRIES: 8, L_COOLDOWN_MS: 1500,
  L_PAUSE: [], L_PAUSE_HEDGE: false, L_HOURS: [], L_DAYS: [],
};

// ── fetch every 5m window from START → now ──
const nowA = Math.floor(Date.now() / 1000 / WIN) * WIN;
const slugs = []; for (let ws = START; ws < nowA; ws += WIN) slugs.push(`btc-updown-5m-${ws}`);
console.log(`\nLockstep daily backtest — from ${new Date(START * 1000).toISOString()} → now, ${slugs.length} windows`);
const q = [...slugs]; const raw = []; let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (q.length) {
    const slug = q.shift();
    try {
      const d = await fetchWindowHistory(slug);
      if (d?.ticks?.length > 20 && d?.winSide != null && d?.openBinance != null && d.ticks.some((t) => t.bz != null)) {
        d.winSide = String(d.winSide).toLowerCase() === "up" ? "Up" : "Down";
        d.ws = Number(slug.split("-").pop()); raw.push(d);
      }
    } catch {}
    if (++done % 1000 === 0) console.log(`  …fetched ${done}/${slugs.length} (usable ${raw.length})`);
    await sleep(20);
  }
}));
raw.sort((a, b) => a.ws - b.ws);
console.log(`usable windows: ${raw.length}\n`);
if (raw.length < 50) { console.log("too few windows."); process.exit(0); }

const dayKey = (ws) => new Date(ws * 1000).toISOString().slice(0, 10);   // UTC date

function runAt(latency) {
  const P = { ...STRAT, ...MODAL, ...OVER, LATENCY_MS: latency };
  const buf = makeIntensityBuffer(12);
  const days = new Map();   // date → {wins, locks, wrong, hedged, net}
  const tot = { locks: 0, wrong: 0, hedged: 0, net: 0 };
  for (const d of raw) {
    const ready = intensityReady(buf.ex, 1) && buf.ex.length >= (+P.L_VOL_ROUNDS || 6);
    d.intensity = ready ? computeIntensity(buf.ex, P) : null;
    if (ready) {
      const fills = simulateFills(d, P);
      const entry = fills.filter((f) => f.leg === "entry");
      if (entry.length) {
        const k = dayKey(d.ws); const day = days.get(k) || { locks: 0, wrong: 0, hedged: 0, net: 0 };
        const p = positionFromFills(fills, d.winSide, d.ticks).realizedPnl ?? 0;
        const hedged = fills.some((f) => f.leg === "hedge");
        day.locks++; if (entry[0].side !== d.winSide) day.wrong++; if (hedged) day.hedged++; day.net += p;
        days.set(k, day);
        tot.locks++; if (entry[0].side !== d.winSide) tot.wrong++; if (hedged) tot.hedged++; tot.net += p;
      }
    }
    pushExcursion(buf, roundExcursion(d.ticks.map((t) => t.bz), d.openBinance));
  }
  return { days, tot };
}

for (const lat of LATS) {
  const { days, tot } = runAt(lat);
  console.log(`\n================  LATENCY ${lat}ms  ================`);
  console.log("date         locks   wrong   hedged    net $     cum $");
  console.log("-".repeat(56));
  let cum = 0;
  for (const k of [...days.keys()].sort()) {
    const dd = days.get(k); cum += dd.net;
    const wr = dd.locks ? `${dd.wrong}` : "0";
    console.log(`${k}   ${String(dd.locks).padStart(4)}   ${String(wr).padStart(4)}   ${String(dd.hedged).padStart(5)}   ${(dd.net >= 0 ? "+" : "") + "$" + dd.net.toFixed(2)}`.padEnd(46) + `${(cum >= 0 ? "+" : "") + "$" + cum.toFixed(2)}`.padStart(10));
  }
  console.log("-".repeat(56));
  const nDays = days.size || 1;
  console.log(`TOTAL        ${String(tot.locks).padStart(4)}   ${String(tot.wrong).padStart(4)}   ${String(tot.hedged).padStart(5)}   ${(tot.net >= 0 ? "+" : "") + "$" + tot.net.toFixed(2)}`);
  console.log(`→ ${tot.locks} locks over ${nDays} days · wrong-side ${(100 * tot.wrong / (tot.locks || 1)).toFixed(1)}% · hedged ${(100 * tot.hedged / (tot.locks || 1)).toFixed(0)}% · avg $${(tot.net / nDays).toFixed(2)}/day · $${(tot.net / (tot.locks || 1)).toFixed(3)}/lock`);
}
console.log(`\nConfig: deployed modal defaults plus overrides ${JSON.stringify(OVER)}.`);
console.log(`latency 520ms = the authoritative taker decision-to-fill assumption. winSide = bapi settlement (post-TWAP).`);
process.exit(0);
