// Focused fake-Herdr launch checks, with no native process-source fixtures.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from '../../test/helpers/bounded-test.mjs';
import { makeFixture, ignoreLaneState, openLane, writeFakeHerdr, lane, repositoryIdentity, makeReviewFixture } from './lane-fixture.mjs';

test('retired hook-pull configuration never changes worker launch argv or issues descriptors', () => {
  for (const config of [undefined, { enabled: false }, { enabled: true }, { enabled: true, rendering: 'invalid' }]) {
    const fixture = makeFixture({ main: 'main', validate: 'true', registry: '.lane/sessions.json',
      routes: { engineer: { kind: 'claude', model: 'worker-model', effort: 'high', env: ['ORG_ACTOR=fixture-worker'] } } });
    try {
      ignoreLaneState(fixture);
      const path = openLane(fixture, 'hook-pull');
      if (config) writeFileSync(join(fixture.repo, '.hook-pull.json'), JSON.stringify(config));
      fixture.env.HERDR_SOCKET_PATH = join(fixture.root, 'herdr.sock');
      const fake = writeFakeHerdr(fixture, { lanePath: path, branch: 'lane/hook-pull', initiallyOpened: true });
      const result = lane(fixture, ['dispatch', 'hook-pull', '--route', 'engineer']);
      assert.equal(result.status, 0, result.stderr);
      const start = fake.calls().find(a => a[0] === 'agent' && a[1] === 'start');
      assert.deepEqual(start.slice(start.indexOf('--') + 1), ['--model', 'worker-model', '--effort', 'high']);
      assert.equal(existsSync(join(repositoryIdentity(fixture.repo), 'sessions/hook-pull')), false);
    } finally { fixture.cleanup(); }
  }
});

test('retired hook-pull configuration leaves reviewer launch settings untouched', () => {
  const review = makeReviewFixture('hook-pull-review', { verdict: 'PASS' });
  try {
    writeFileSync(join(review.fixture.repo, '.hook-pull.json'), '{"enabled":true}\n');
    const result = lane(review.fixture, ['review', 'hook-pull-review', '--round', '1', '--route', 'alternate', '--brief', review.brief]);
    assert.equal(result.status, 0, result.stderr);
    const start = review.fake.calls().find(a => a[0] === 'agent' && a[1] === 'start');
    assert.equal(start.includes('--settings'), false);
    assert.equal(existsSync(join(repositoryIdentity(review.fixture.repo), 'sessions/hook-pull')), false);
  } finally { review.fixture.cleanup(); }
});
