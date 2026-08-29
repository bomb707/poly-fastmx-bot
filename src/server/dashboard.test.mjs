import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config/config.js";
import { currentWindowStart } from "../util/util.js";
import { renderHeadless } from "./dashboard.js";

test("headless simulation heartbeat reports the shadow ledger", () => {
  const ws = currentWindowStart(), previousShowTracker = config.showTracker;
  config.showTracker = false;
  const window = { slug: `btc-updown-5m-${ws}`, windowStart: ws,
    upTokenId: "up", downTokenId: "down", openBinance: 100, openPrice: 100,
    upShares: 0, downShares: 0, totalCost: 0, events: [] };
  const tracker = { getView: () => ({ windows: new Map([[window.slug, window]]),
    pnlView: () => ({ ifUpWins: 0, ifDownWins: 0, mtm: 0 }) }) };
  const state = { binance: { btc: { value: 101, recvTs: Date.now() } },
    chainlink: { btc: { value: 101, recvTs: Date.now() } },
    bbaByToken: new Map([["up", { bestBid: .59 }], ["down", { bestBid: .39 }]]) };
  const shadowWindow = { windowStart: ws, upShares: 7.1, downShares: 0,
    cost: 4.97, fee: .1044, mergedRealized: 0,
    fills: [{ tInto: 12.52, side: "Up", shares: 7.1, effPx: .7 }] };
  const shadow = { windows: new Map([[window.slug, shadowWindow]]) };
  let line = "";
  const oldLog = console.log;
  console.log = (value) => { line = String(value); };
  try { renderHeadless(state, tracker, shadow); }
  finally { console.log = oldLog; config.showTracker = previousShowTracker; }
  assert.match(line, /SHADOW Up 7\.10 Dn 0\.00/);
  assert.match(line, /cost \$4\.97/);
  assert.match(line, /last t\+12\.52s BUY Up 7\.10sh@0\.700/);
});
