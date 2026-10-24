import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveGateLimits, RELEASE_TIMEOUT_ENV, WALL_DEFAULT_SECONDS } from '../limits.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

const declared = JSON.parse(fs.readFileSync(new URL('../../.lane.validation.json', import.meta.url))).timeout_seconds;

test('release wrappers keep wall caps off despite historical allowances', () => {
  assert.equal(declared, 0);
  for (const tier of ['test:release', 'test:core', 'test:cycle', 'test:lanes', 'test:acceptance', 'test:release:only']) {
    for (const history of [[], Array(3).fill({ duration_s: 300, longest_silence_s: 1 })]) {
      const limits = resolveGateLimits({ tier, history, env: { [RELEASE_TIMEOUT_ENV]: String(declared) } });
      assert.equal(limits.wall_seconds, declared, tier);
      assert.equal(limits.wall_source, 'watch', tier);
    }
  }
});

test('legacy explicit wall allowances are ignored and silence remains an observation', () => {
  for (const inherited of [String(declared), 'invalid']) {
    const limits = resolveGateLimits({ timeoutSeconds: 17, idleTimeoutSeconds: 3, history: [], env: { [RELEASE_TIMEOUT_ENV]: inherited } });
    assert.equal(limits.wall_seconds, 0);
    assert.equal(limits.wall_source, 'watch');
    assert.equal(limits.idle_seconds, 3);
    assert.equal(limits.idle_source, 'config');
  }
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', '10000000']) {
    assert.equal(resolveGateLimits({ history: [], env: { [RELEASE_TIMEOUT_ENV]: value } }).wall_seconds, 0);
  }
});

test('promotion defaults and history remain watch-only outside a release process tree', () => {
  const cold = resolveGateLimits({ tier: 'promotion', history: [], env: {} });
  assert.equal(cold.wall_seconds, WALL_DEFAULT_SECONDS);
  assert.equal(cold.wall_source, 'watch');
  const warm = resolveGateLimits({ tier: 'promotion', history: Array(3).fill({ duration_s: 600, longest_silence_s: 100 }), env: {} });
  assert.equal(warm.wall_seconds, 0);
  assert.equal(warm.wall_source, 'watch');
  assert.equal(warm.idle_seconds, 900);
  assert.equal(process.env[RELEASE_TIMEOUT_ENV], undefined, 'in-process fixtures clear inherited release context');
  assert.equal(testSlotEnvironment({ [RELEASE_TIMEOUT_ENV]: '1' })[RELEASE_TIMEOUT_ENV], undefined);
});
