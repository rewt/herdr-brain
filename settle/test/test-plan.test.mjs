import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { canonicalTestPlan } from '../test-plan.mjs';

test('the real canonical planner loads its transitive base imports while selecting tests from the lane', () => {
  const repo = fs.realpathSync(new URL('../../', import.meta.url));
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const plan = canonicalTestPlan({ repo, base, cwd: repo, planner: 'test/helpers/affected-tests.mjs',
    changed: ['discovery/native-sandbox.mjs', 'dispatch/dispatch.mjs', 'settle/test/test-evidence.test.mjs'],
    required: ['lanes/test/lane.test.mjs', 'dispatch/test/dispatch.test.mjs', 'settle/test/test-evidence.test.mjs'],
    baseCommand: 'npm run test:promotion' });
  assert.ok(plan.files.includes('lanes/test/lane.test.mjs'));
  assert.ok(plan.files.includes('dispatch/test/dispatch.test.mjs'));
  assert.ok(plan.files.includes('settle/test/test-evidence.test.mjs'));
  assert.ok(plan.covered.includes('promote/test/train.test.mjs'));
  assert.equal(plan.graph.max_suite_files, 4);
  assert.deepEqual(plan.required, ['dispatch/test/dispatch.test.mjs', 'lanes/test/lane.test.mjs', 'settle/test/test-evidence.test.mjs']);
});

test('the real canonical planner works with TMPDIR set to a symlinked directory and removes its snapshot', t => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canonical-plan-tmp-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const temporary = path.join(scratch, 'real'), linked = path.join(scratch, 'linked');
  fs.mkdirSync(temporary); fs.symlinkSync(temporary, linked, 'dir');
  const repo = fs.realpathSync(new URL('../../', import.meta.url));
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const code = `import { canonicalTestPlan } from ${JSON.stringify(new URL('../test-plan.mjs', import.meta.url).href)};
    console.log(JSON.stringify(canonicalTestPlan(${JSON.stringify({ repo, base, cwd: repo,
      planner: 'test/helpers/affected-tests.mjs', changed: ['settle/test/test-evidence.test.mjs'],
      baseCommand: 'npm run test:promotion' })})));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repo, env: { ...process.env, TMPDIR: linked }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.files.includes('settle/test/test-evidence.test.mjs'));
  assert.ok(plan.covered.includes('promote/test/train.test.mjs'));
  assert.deepEqual(fs.readdirSync(temporary), [], 'private snapshot is removed');
});
