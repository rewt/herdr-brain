import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { canonicalTestPlan } from '../test-plan.mjs';

test('the real canonical planner loads its transitive base imports while selecting tests from the lane', () => {
  const repo = fs.realpathSync(new URL('../../', import.meta.url));
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const plan = canonicalTestPlan({ repo, base, cwd: repo, planner: 'test/helpers/affected-tests.mjs',
    changed: ['discovery/native-sandbox.mjs', 'dispatch/dispatch.mjs', 'settle/test/test-evidence.test.mjs'],
    baseCommand: 'npm run test:promotion' });
  assert.ok(plan.files.includes('lanes/test/lane.test.mjs'));
  assert.ok(plan.files.includes('dispatch/test/dispatch.test.mjs'));
  assert.ok(plan.files.includes('settle/test/test-evidence.test.mjs'));
  assert.ok(plan.covered.includes('promote/test/train.test.mjs'));
  assert.equal(plan.graph.max_suite_files, 4);
});
