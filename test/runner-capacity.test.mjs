import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { testLoadFactor } from '../test-slot/load.mjs';
import { workerSettings } from '../test-slot/resources.mjs';
import { shouldRetryTimeout } from '../test-slot/test-slot.mjs';
import { runnerLimits } from './helpers/runner-limits.mjs';
import { loadFactor } from '../lib/deadline.mjs';

for (const [load, parallelism, factor, concurrency] of [
  [0, 18, 1, 4],
  [7, 18, 1, 4],
  [18, 18, 1, 4],
  [27, 18, 1.5, 2],
  [45, 18, 2.5, 1],
  [7, 2, 3.5, 1],
  [7, 1, 7, 1],
]) test(`runner load ${load} on ${parallelism} cores has factor ${factor} and concurrency ${concurrency}`, () => {
  const measured = testLoadFactor(load, parallelism);
  assert.equal(measured, factor);
  assert.equal(runnerLimits({ factor: measured }).concurrency, concurrency);
});

test('sampled load 7 on 18 cores keeps four files, no deadlines and matching slot telemetry', t => {
  t.mock.method(os, 'loadavg', () => [7, 7, 7]);
  t.mock.method(os, 'availableParallelism', () => 18);
  const factor = testLoadFactor();
  assert.equal(factor, 1);
  assert.deepEqual(runnerLimits({ factor, fileTimeout: 480_000, suiteTimeout: 540_000 }),
    { concurrency: 4, fileTimeout: 0, suiteTimeout: 0 });
  const workers = workerSettings({});
  assert.equal(workers.load_factor, factor);
  assert.equal(workers.test_file_cap, 4);
  assert.equal(workers.maximum_test_file_cap, 4);
  assert.equal(shouldRetryTimeout({ status: 124, timeout: true, load: factor }), false);
  // Record locks and other product operations keep their original allowance.
  assert.equal(loadFactor(), 1.75);
});

test('actual host overload still reduces concurrency, keeps deadlines off and permits a timeout retry', t => {
  t.mock.method(os, 'loadavg', () => [27, 27, 27]);
  t.mock.method(os, 'availableParallelism', () => 18);
  const factor = testLoadFactor();
  assert.deepEqual(runnerLimits({ factor }),
    { concurrency: 2, fileTimeout: 0, suiteTimeout: 0 });
  assert.equal(workerSettings({}).test_file_cap, 2);
  assert.equal(shouldRetryTimeout({ status: 124, timeout: true, load: factor }), true);
});

test('invalid host measurements keep a safe factor and single-core fallback', () => {
  for (const load of [-1, NaN, Infinity]) assert.equal(testLoadFactor(load, 18), 1);
  for (const parallelism of [0, -1, NaN, Infinity]) assert.equal(testLoadFactor(7, parallelism), 7);
});

test('explicit runner environment adjusts only file admission and optional file timeout', () => {
  assert.deepEqual(runnerLimits({ factor: 1, env: {} }), { concurrency: 4, fileTimeout: 0, suiteTimeout: 0 });
  assert.deepEqual(runnerLimits({ factor: 1, env: { MONITOR_TEST_CONCURRENCY: '12' } }),
    { concurrency: 12, fileTimeout: 0, suiteTimeout: 0 });
  assert.deepEqual(runnerLimits({ factor: 2, env: { MONITOR_TEST_CONCURRENCY: '12', MONITOR_TEST_FILE_TIMEOUT_MS: '1234' } }),
    { concurrency: 6, fileTimeout: 1234, suiteTimeout: 0 });
  assert.equal(runnerLimits({ factor: 100, env: { MONITOR_TEST_CONCURRENCY: '12' } }).concurrency, 1);
});

test('invalid runner environment refuses unsafe caps and timer overflow', () => {
  for (const value of ['0', '-1', '1.5', '', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => runnerLimits({ factor: 1, env: { MONITOR_TEST_CONCURRENCY: value } }), /MONITOR_TEST_CONCURRENCY/);
  }
  for (const value of ['-1', '0.5', 'NaN', 'Infinity', '2147483648']) {
    assert.throws(() => runnerLimits({ factor: 1, env: { MONITOR_TEST_FILE_TIMEOUT_MS: value } }), /MONITOR_TEST_FILE_TIMEOUT_MS/);
  }
});
