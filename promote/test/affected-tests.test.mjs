import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { affectedTests } from '../../test/helpers/affected-tests.mjs';
import { releasePhases } from '../../test/helpers/release-suites.mjs';
import { plannedCommand, promotionTestPlan } from '../test-plan.mjs';
const root = fs.realpathSync(new URL('../../', import.meta.url));
test('affected tests include changed files and transitive imports, re-exports, cycles and launched literal paths', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-tests-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sources = {
    'module.mjs': "export * from './bridge.mjs';",
    'bridge.mjs': "export * from './module.mjs';",
    'direct.test.mjs': "import './module.mjs';",
    'deleted.test.mjs': "import './deleted.mjs';",
    'indirect.test.mjs': "await import('./bridge.mjs');",
    'launch.test.mjs': "new URL('./module.mjs', import.meta.url);",
    'changed.test.mjs': '', 'other.test.mjs': '',
  };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(scratch, file), text);
  const files = Object.keys(sources), tests = files.filter(f => f.endsWith('.test.mjs'));
  assert.deepEqual(affectedTests({ root: scratch, files, tests, changed: ['module.mjs', 'changed.test.mjs'] }), ['changed.test.mjs', 'direct.test.mjs', 'indirect.test.mjs', 'launch.test.mjs']);
  assert.deepEqual(affectedTests({ root: scratch, files, tests, changed: ['deleted.mjs'] }), ['deleted.test.mjs']);
  assert.throws(() => affectedTests({ root: scratch, files: Array(10001).fill('module.mjs'), tests, changed: [] }), /10000/);
  assert.ok(releasePhases(tests).every(([, rows]) => rows.length <= 4));
});
test('real import closure selects the previously missed release files and records bounded coverage', () => {
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['discovery/native-sandbox.mjs', 'dispatch/dispatch.mjs'], baseCommand: 'npm run test:promotion' });
  assert.ok(plan.files.includes('lanes/test/lane.test.mjs'));
  assert.ok(plan.files.includes('dispatch/test/dispatch.test.mjs'));
  assert.ok(plan.covered.includes('promote/test/train.test.mjs'));
  const overridden = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['promote/test/train.test.mjs'], baseCommand: 'true' });
  assert.ok(overridden.files.includes('promote/test/train.test.mjs'));
  assert.deepEqual(overridden.covered, []);
  const slot = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['test-slot/test/test-slot.test.mjs'], baseCommand: 'npm run test:promotion' });
  assert.ok(slot.covered.includes('test-slot/test/test-slot.test.mjs'));
  assert.ok(!slot.files.includes('test-slot/test/test-slot.test.mjs'));
  assert.equal(new Set(plan.files).size, plan.files.length);
  assert.equal(plan.graph.max_suite_files, 4);
  assert.match(plannedCommand('npm run test:promotion', plan), /MONITOR_PROMOTION_TEST_FILES=.*&&/);
});

test('the planner CLI launched through a symlinked directory emits the same plan', t => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'affected-linked-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const linked = path.join(scratch, 'project'); fs.symlinkSync(root, linked, 'dir');
  const options = { cwd: root, planner: 'test/helpers/affected-tests.mjs',
    changed: ['settle/test/test-evidence.test.mjs'], baseCommand: 'npm run test:promotion' };
  assert.deepEqual(promotionTestPlan({ ...options, plannerRoot: linked }), promotionTestPlan(options));
});

test('a selected mixed file skips the patterned step and executes once in full', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-runner-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'mixed.test.mjs'), marker = path.join(scratch, 'runs');
  fs.writeFileSync(file, `import test from 'node:test'; import fs from 'node:fs'; test('selected case',()=>fs.appendFileSync(${JSON.stringify(marker)},'run\\n'));`);
  const env = { ...process.env, MONITOR_PROMOTION_TEST_FILES: JSON.stringify([file]) };
  delete env.NODE_TEST_CONTEXT;
  const run = args => spawnSync(process.execPath, [path.join(root, 'test/helpers/run.mjs'), ...args, file], { env, encoding: 'utf8' });
  const skipped = run(['--test-name-pattern=selected case']);
  assert.equal(skipped.status, 0, skipped.stderr); assert.equal(fs.existsSync(marker), false);
  const full = run([]); assert.equal(full.status, 0, full.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
});
