import assert from 'node:assert/strict';
import { STRAT, step, injectRealFill, releaseCandidate, participationCandidate, clearLivePending } from './wallet3048.js';

const P = { ...STRAT };
const levels = (rows) => rows.map(([price, size]) => [price, size]);
function tick(ms, { upThin = false, downThin = false, upAsk = 0.4, downAsk = 0.61 } = {}) {
  const side = (ask, thin) => ({
    bestAsk: ask,
    bestBid: +(ask - 0.01).toFixed(2),
    depthTs: ms,
    asks: levels([[ask, thin ? 20 : 400], [ask + 0.01, thin ? 30 : 400], [ask + 0.02, thin ? 40 : 400]]),
    bids: levels([[ask - 0.01, thin ? 500 : 50], [ask - 0.02, thin ? 450 : 50], [ask - 0.03, thin ? 400 : 50]]),
  });
  return { t: ms / 1000, up: side(upAsk, upThin), down: side(downAsk, downThin), bzGapPct: 0.01, clGapPct: 0.01 };
}

assert.equal(releaseCandidate({ askDepth3: 500, askDepth1: 50, topDepthImbalance: .7, depth3Imbalance: .4, askDepth3Change1: -200, micropriceBias: .003, ask: .4 }, P)?.ask, .4);

const state = {};
assert.deepEqual(step(state, tick(4000), P, 120, 4000), [], 'thick book does not release');
const entry = step(state, tick(5100, { upThin: true }), P, 120, 5100);
assert.equal(entry.length, 1);
assert.equal(entry[0].side, 'Up');
assert.equal(entry[0].shares, 25);
assert.equal(entry[0].limitPx, 0.4);
assert.equal(entry[0].postOnly, false);

// Cooldown then a cheap opposite release completes inventory under the $1 cap.
step(state, tick(7000), P, 120, 7000);
const hedge = step(state, tick(8100, { downThin: true, downAsk: .55 }), P, 120, 8100);
assert.equal(hedge.length, 1);
assert.equal(hedge[0].side, 'Down');
assert.equal(hedge[0].leg, 'hedge');
assert.ok(hedge[0].pairCost <= 1);

const liveState = {};
const liveP = { ...P, LIVE_FILLS: true };
step(liveState, tick(4000), liveP, 120, 4000);
const liveEntry = step(liveState, tick(5100, { upThin: true }), liveP, 120, 5100)[0];
assert.equal(liveState.wallet3048.up, 0, 'live decision reserves but does not assume a fill');
injectRealFill(liveState, { oid: liveEntry.oid, side: 'Up', shares: 25, px: .4 });
assert.equal(liveState.wallet3048.up, 25);
assert.equal(liveState.wallet3048.pending.size, 0);

// The normal release tree retains priority, but a quiet eligible market gets a
// bounded minimum-size participation order once the fallback start is reached.
const quietState = {};
assert.deepEqual(step(quietState, tick(29_000), P, 120, 29_000), []);
const floor = step(quietState, tick(30_000), P, 120, 30_000);
assert.equal(floor.length, 1);
assert.equal(floor[0].side, 'Up', 'positive Binance/Chainlink gaps select Up');
assert.equal(floor[0].shares, 5);
assert.equal(floor[0].reason, 'w3048-participation-floor');
assert.equal(floor[0].postOnly, false);
assert.equal(floor[0].limitPx, .42);

// Full-depth freshness is required by the strict release tree, but the live
// BBA-driven participation floor must still attempt a bounded order when the
// last full-depth snapshot is older than its one-second release threshold.
const staleDepthState = {};
const staleDepthTick = tick(30_000, { upThin: true });
staleDepthTick.up.depthTs = 0;
staleDepthTick.down.depthTs = 0;
const staleDepthFloor = step(staleDepthState, staleDepthTick, P, 120, 30_000);
assert.equal(staleDepthFloor.length, 1);
assert.equal(staleDepthFloor[0].reason, 'w3048-participation-floor');
assert.equal(staleDepthFloor[0].shares, 5);

// Paper observation can explicitly disable the reconstructed high-frequency
// release tree while retaining one bounded participation fill per market.
const floorOnlyState = {};
const floorOnlyP = { ...P, W3048_RELEASE_ON: false };
const floorOnly = step(floorOnlyState, tick(30_000, { upThin: true }), floorOnlyP, 120, 30_000);
assert.equal(floorOnly.length, 1);
assert.equal(floorOnly[0].reason, 'w3048-participation-floor');
assert.equal(floorOnly[0].shares, 5);

const negative = participationCandidate(tick(30_000, { upAsk: .56, downAsk: .45 }), {
  ...P, W3048_PARTICIPATION_SPOT_WEIGHT: .7, W3048_PARTICIPATION_MARKET_WEIGHT: .3,
});
assert.equal(negative.side, 'Up', 'positive spot evidence can outweigh a modest CLOB lean');
const negativeTick = { ...tick(30_000, { upAsk: .56, downAsk: .45 }), bzGapPct: -.05, clGapPct: -.05 };
assert.equal(participationCandidate(negativeTick, P).side, 'Down');

// Live mode does not assume a fill. Once the reconciler cancels an unfilled
// order, the participation floor may retry, up to the configured attempt cap.
const retryState = {};
const retryP = { ...P, LIVE_FILLS: true, W3048_PARTICIPATION_MAX_ATTEMPTS: 2 };
const firstAttempt = step(retryState, tick(30_000), retryP, 120, 30_000)[0];
clearLivePending(retryState, firstAttempt.oid);
const secondAttempt = step(retryState, tick(32_000), retryP, 120, 32_000)[0];
assert.equal(secondAttempt.reason, 'w3048-participation-floor');
clearLivePending(retryState, secondAttempt.oid);
assert.deepEqual(step(retryState, tick(34_000), retryP, 120, 34_000), []);

console.log('wallet3048.test: passed');
