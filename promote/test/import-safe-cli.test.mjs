import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { makeFixture, ignoreLaneState, openLane, commitFile, lane, git } from '../../lanes/test/lane-fixture.mjs';

test('a fresh lane CLI loads landing bookkeeping after its real fast-forward without preloaded supervisor modules', t => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  ignoreLaneState(f);
  const topic = 'import-safe-landing', workspace = openLane(f, topic);
  commitFile(workspace, 'finished', 'finished', 'Finished owned source');
  const head = git(workspace, ['rev-parse', 'HEAD']);
  const result = lane(f, ['promote', topic, '--expected-head', head], {
    env: { ...f.env, HERDR_ENV: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /ERR_REQUIRE_ASYNC_MODULE|post-FF landing receipt held/);
  const line = result.stdout.split('\n').find(line => line.startsWith('landing receipt: '));
  assert.ok(line, result.stdout);
  assert.deepEqual(JSON.parse(line.slice('landing receipt: '.length)), {
    recorded: false, reason: 'owning record unavailable',
  });
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.equal(git(workspace, ['status', '--porcelain=v1']), '');
});
