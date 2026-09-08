import assert from 'node:assert/strict';
import { MarketDepthBook } from './marketDepthBook.js';
import { createLiveState, recordDepth } from '../util/state.js';

const book = new MarketDepthBook();
assert.equal(book.apply({ side: 'BUY', price: '0.49', size: '2' }), false, 'delta before snapshot is rejected');
book.replace({
  bids: [{ price: '0.48', size: '5' }, { price: '0.49', size: '3' }],
  asks: [{ price: '0.52', size: '7' }, { price: '0.51', size: '4' }],
});
assert.deepEqual(book.snapshot(2), {
  synchronized: true,
  bids: [[0.49, 3], [0.48, 5]],
  asks: [[0.51, 4], [0.52, 7]],
});
assert.equal(book.apply({ side: 'SELL', price: '0.51', size: '0' }), true);
assert.equal(book.apply({ side: 'BUY', price: '0.50', size: '9.5' }), true);
assert.deepEqual(book.snapshot(2), {
  synchronized: true,
  bids: [[0.5, 9.5], [0.49, 3]],
  asks: [[0.52, 7]],
});

const state = createLiveState();
recordDepth(state, 'token', [[0.51, 4]], [[0.49, 3]], 1_000);
recordDepth(state, 'token', [[0.52, 8]], [[0.50, 9]], 1_100);
assert.equal(state.depthHistory.get('token').length, 1, 'historical depth remains throttled');
assert.deepEqual(state.depthByToken.get('token'), {
  eventId: 'token:2',
  ts: 1_100,
  sourceTs: 1_100,
  recvTs: 1_100,
  asks: [[0.52, 8]],
  bids: [[0.50, 9]],
}, 'live strategy always sees the newest unthrottled L2 snapshot');
console.log('marketDepthBook.test: passed');
