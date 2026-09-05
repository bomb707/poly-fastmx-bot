import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/config.js';
import { setRunning } from './botState.js';
import { createShadow } from './shadow.js';
import { simulateFills } from '../../engine/simrun.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastmx-fill-test-'));
Object.assign(config, { dataDir, windowSec: 300, tradeFreshMs: 6000, recordLiveTicks: false });
setRunning(true);
after(() => { setRunning(false); fs.rmSync(dataDir, { recursive: true, force: true }); });
const PARAMS = { H_CLOB_MID_VELOCITY_ON: false, H_BINANCE_TREND_ON: false,
  H_BINANCE_GAP_AGREE_ON: false, H_STOP_S: 300, H_COOLDOWN_MS: 2000, LATENCY_MS: 520 };
const book = (ask = .5, qty = 20) => ({ bestAsk: ask, bestBid: .48,
  asks: ask == null ? [] : [[ask, qty]], bids: [[.48, 20]] });
function harness(params = {}) {
  const events = [], persisted = [];
  const shadow = createShadow(e => events.push(e), () => false, {
    persistFill: f => persisted.push(f), persistSession: () => {},
  });
  shadow.setParams({ ...PARAMS, ...params });
  const tick = (t, bzPrice, opts = {}) => shadow.tick({ slug: 'test', windowStart: 1000,
    tInto: t, nowMs: 1_000_000 + t * 1000, openBinance: 100,
    up: book(), down: book(), bzPrice, ...opts });
  return { shadow, tick, events, persisted, window: () => shadow.windows.get('test') };
}

test('zero-latency simulation respects partial L2 and actual cost', () => {
  const h = harness({ LATENCY_MS: 0 });
  h.tick(0, 100); h.tick(3, 106, { up: book(.5, 4) });
  const [f] = h.window().fills;
  assert.equal(f.shares, 4); assert.equal(f.usdc, 2); assert.equal(f.effPx, .5);
  assert.equal(f.requestedBudgetUsd, 3.57); assert.equal(f.status, 'partial');
  assert.equal(f.tInto, 3); assert.equal(f.filledLate, false);
});

test('zero-latency fixed-USDC entry receives price-improved shares', () => {
  const h = harness({ LATENCY_MS: 0 });
  h.tick(0, 100); h.tick(3, 106);
  const [f] = h.window().fills;
  assert.equal(f.shares, 7.14); assert.equal(f.usdc, 3.57); assert.equal(f.status, 'full');
});

for (const close of ['recordPending', 'settle']) {
  for (const latency of [500, 520]) {
    test(`${close} expires an arrival ${latency === 500 ? 'at' : 'after'} the window boundary`, () => {
      const h = harness({ LATENCY_MS: latency });
      h.tick(296, 100); h.tick(299.5, 106);
      h.shadow[close]('test', 'Up');
      assert.equal(h.window().fills.length, 0);
      assert.equal(h.window().pendingFills.length, 0);
      assert.equal(h.persisted.length, 0);
      assert.ok(h.events.some(e => e.stage === 'skipped' && /expiry/.test(e.note)));
    });
  }
}

test('close resolves a pre-expiry partial arrival once through the depth matcher', () => {
  const h = harness();
  h.tick(296, 100); h.tick(299.2, 106, { up: book(.5, 4) });
  h.shadow.recordPending('test'); h.shadow.recordPending('test'); h.shadow.settle('test', 'Up');
  const [f] = h.window().fills;
  assert.equal(f.shares, 4); assert.equal(f.usdc, 2); assert.equal(f.status, 'partial');
  assert.ok(Math.abs(f.tInto - 299.72) < 1e-9);
  assert.equal(h.persisted.length, 1);
});

test('close cannot resurrect asks removed before arrival', () => {
  const h = harness();
  h.tick(296, 100); h.tick(299.2, 106);
  h.tick(299.4, 106, { up: book(null) });
  h.shadow.recordPending('test');
  assert.equal(h.window().fills.length, 0);
});

test('an arrival uses the frame at its exact deadline', () => {
  const h = harness();
  h.tick(0, 100); h.tick(3, 106); h.tick(3.52, 106, { up: book(.6) });
  assert.equal(h.window().fills.length, 0);
});

test('arrival uses the latest preceding L2 and price context, never a future frame', () => {
  const h = harness();
  h.tick(0, 100); h.tick(3, 106);
  h.tick(3.519, 107, { up: book(.5, 4) });
  h.tick(3.521, 120, { up: book(.6) });
  const [f] = h.window().fills;
  assert.equal(f.shares, 4); assert.equal(f.usdc, 2); assert.equal(f.bz, 107);
});

test('fresh BBA without L2 cannot manufacture liquidity at arrival', () => {
  const h = harness();
  h.tick(0, 100); h.tick(3, 106);
  h.tick(3.4, 106, { up: { bestAsk: .5, bestBid: .48, asks: [], bids: [] } });
  h.tick(3.6, 106);
  assert.equal(h.window().fills.length, 0);
});

test('closing rejects stale L2 even when a recent frame carries it', () => {
  const h = harness();
  h.tick(296, 100);
  h.tick(299.2, 106, { up: { ...book(), depthTs: 1_290_000 } });
  h.shadow.recordPending('test');
  assert.equal(h.window().fills.length, 0);
  assert.ok(h.events.some(e => e.stage === 'skipped' && /stale/.test(e.note)));
});

test('authoritative open replaces the provisional gap reference causally', () => {
  const h = harness({ H_BINANCE_GAP_AGREE_ON: true });
  h.tick(0, 100); h.tick(3, 106, { openBinance: 110 });
  assert.equal(h.window().openBinance, 110);
  assert.equal(h.window().gateReason, 'binance-gap-disagreement');
  assert.equal(h.window().fills.length, 0);
  h.tick(3.1, 106, { openBinance: null });
  assert.equal(h.window().openBinance, 110);
});

test('an open correction preserves already recorded decisions', () => {
  const h = harness({ H_BINANCE_GAP_AGREE_ON: true, LATENCY_MS: 0 });
  h.tick(0, 100); h.tick(3, 106); h.tick(6, 112, { openBinance: 110 });
  assert.deepEqual(h.window().fills.map(f => f.signal.binanceWindowOpen), [100, 110]);
});

test('live and replay apply partial arrivals before choosing an opposing hedge', () => {
  const h = harness({ H_HEDGE_ON: true, H_COOLDOWN_MS: 0 });
  const frames = [
    [0, 100, book()], [3, 106, book()], [3.52, 94, book(.5, 4)], [4.1, 94, book()],
  ];
  for (const [t, bz, up] of frames) h.tick(t, bz, { up });
  h.shadow.recordPending('test');
  const ticks = frames.map(([t, bz, up]) => ({ t, bz, up, down: book(),
    upAsk: up.bestAsk, upBid: up.bestBid, dnAsk: .5, dnBid: .48 }));
  const replay = simulateFills({ ticks, openBinance: 100 }, h.shadow.getParams());
  const fields = fs => fs.map(({ side, role, shares, usdc, tInto }) => ({ side, role, shares, usdc, tInto }));
  assert.deepEqual(fields(h.window().fills), fields(replay));
  assert.equal(h.window().fills.length, 1); // 4 filled shares cannot hedge 4 while retaining a lead
});

for (const latency of [0, 520]) {
  test(`manual simulation also respects visible depth with ${latency}ms latency`, t => {
    const h = harness({ LATENCY_MS: latency, H_ON: false });
    h.tick(10, 100, { up: book(.5, 4) });
    t.mock.method(Date, 'now', () => 1_010_000);
    const result = h.shadow.manualBuy({ side: 'Up', shares: 7, limit: .51 });
    assert.equal(result.ok, true);
    if (latency) h.tick(10.52, 100, { up: book(.5, 4) });
    const [f] = h.window().fills;
    assert.equal(f.shares, 4); assert.equal(f.usdc, 2); assert.equal(f.status, 'partial');
    assert.equal(f.manual, true);
  });
}
