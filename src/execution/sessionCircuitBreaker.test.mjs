import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCircuitBreaker } from './sessionCircuitBreaker.js';

test('ignores a delayed settlement from a previous Start generation', () => {
  const trips = [];
  const breaker = createSessionCircuitBreaker(() => 5, (event) => trips.push(event));
  const oldGeneration = breaker.stamp();

  breaker.reset();
  breaker.record(oldGeneration, -144.42);

  assert.deepEqual(breaker.state(), { generation: 1, sessionRealized: 0, tripped: false, limit: 5 });
  assert.deepEqual(trips, []);
});

test('still trips on losses created in the current Start generation', () => {
  const trips = [];
  const breaker = createSessionCircuitBreaker(() => 5, (event) => trips.push(event));
  breaker.reset();
  const currentGeneration = breaker.stamp();

  breaker.record(currentGeneration, -2);
  breaker.record(currentGeneration, -3.01);

  assert.deepEqual(breaker.state(), { generation: 1, sessionRealized: -5.01, tripped: true, limit: 5 });
  assert.deepEqual(trips, [{ sessionRealized: -5.01, limit: 5 }]);
});
