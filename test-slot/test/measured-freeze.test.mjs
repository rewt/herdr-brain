import test from 'node:test';
import assert from 'node:assert/strict';
import { FROZEN_SECONDS, FROZEN_SECONDS_ENV, frozenSeconds, resolveGateLimits } from '../limits.mjs';
import { watchRun } from '../watch.mjs';

test('measured freeze resolves the observed precision and explicit project settings', () => {
  assert.equal(FROZEN_SECONDS, 199580.020875 / 1000);
  assert.equal(frozenSeconds({}), 199.580020875);
  for (const tier of ['gate', 'fast', 'promotion', 'promotion-host', 'release', 'suite']) {
    const limits = resolveGateLimits({ tier, env: {} });
    assert.equal(limits.frozen_seconds, 199.580020875, tier);
    assert.equal(limits.wall_seconds, 0, tier);
    for (const value of ['1.23456789', '199.580020875', '0'])
      assert.equal(resolveGateLimits({ tier, env: { [FROZEN_SECONDS_ENV]: value } }).frozen_seconds, Number(value), tier);
  }
});

for (const kind of ['quiet', 'output', 'cpu', 'identity', 'unknown', 'faulted'])
  test(`measured freeze requires both silence and confirmed inactivity: ${kind}`, () => {
    const threshold = frozenSeconds({}), stops = [];
    let at = 0, cpu = '00:00.00', identity = 'birth', available = true, faulted = false;
    const watcher = watchRun({ now: () => at, idleSeconds: 0, frozen: threshold, startTimer: false,
      sample: () => {
        if (faulted) throw Error('activity unavailable');
        return available ? [{ pid: 123, identity, state: 'S', cpu }] : null;
      }, onFrozen: row => stops.push(row) });
    at = threshold - 1e-8; watcher.tick();
    assert.equal(stops.length, 0);
    at = threshold;
    if (kind === 'output') watcher.output();
    if (kind === 'cpu') cpu = '00:00.01';
    if (kind === 'identity') identity = 'replacement';
    if (kind === 'unknown') available = false;
    if (kind === 'faulted') faulted = true;
    watcher.tick(); watcher.tick();
    assert.equal(stops.length, kind === 'quiet' ? 1 : 0);
    if (kind === 'quiet') {
      assert.equal(stops[0].limit_seconds, 199.580020875);
      assert.equal(stops[0].silence_s, threshold);
      assert.equal(stops[0].inactivity_s, threshold);
    }
    watcher.stop();
  });
