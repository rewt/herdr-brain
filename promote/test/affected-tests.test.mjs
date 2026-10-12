import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { affectedTests, boundAffectedTests, DEFAULT_BUDGET_MS, DEFAULT_MAX_FILES } from '../../test/helpers/affected-tests.mjs';
import { releasePhases } from '../../test/helpers/release-suites.mjs';
import { plannedCommand, promotionTestPlan } from '../test-plan.mjs';
const root = fs.realpathSync(new URL('../../', import.meta.url));
test('the three-argument planner output keeps the field set accepted by the main validator', () => {
  const result = spawnSync(process.execPath, ['test/helpers/affected-tests.mjs', '--plan',
    JSON.stringify(['lib/deadline.mjs']), JSON.stringify('npm run test:promotion')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['covered', 'files', 'graph']);
});

test('one-hop selection includes changed tests and direct literals without following re-exports or cycles', t => {
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
  assert.deepEqual(affectedTests({ root: scratch, files, tests, changed: ['module.mjs', 'changed.test.mjs'] }), ['changed.test.mjs', 'direct.test.mjs', 'launch.test.mjs']);
  assert.deepEqual(affectedTests({ root: scratch, files, tests, changed: ['deleted.mjs'] }), ['deleted.test.mjs']);
  assert.throws(() => affectedTests({ root: scratch, files: Array(10001).fill('module.mjs'), tests, changed: [] }), /10000/);
  assert.ok(releasePhases(tests).every(([, rows]) => rows.length <= 4));
});
test('a core-module change selects bounded one-hop extras and defers the expensive lane file', () => {
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['supervisor/chats.mjs', 'dispatch/dispatch.mjs'], baseCommand: 'npm run test:promotion' });
  assert.ok(!plan.files.includes('lanes/test/lane.test.mjs'));
  assert.ok(plan.deferred.some(row => row.file === 'lanes/test/lane.test.mjs' && row.reason === 'time-budget'));
  assert.ok(plan.files.length <= DEFAULT_MAX_FILES);
  assert.ok(plan.budget.estimated_ms <= DEFAULT_BUDGET_MS);
  assert.equal(plan.graph.hops, 1);
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
  const core = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['lib/deadline.mjs'], baseCommand: 'npm run test:promotion' });
  assert.ok(core.files.length > 0 && core.files.length <= DEFAULT_MAX_FILES);
  assert.ok(core.budget.estimated_ms <= DEFAULT_BUDGET_MS);
  assert.ok(core.deferred.length > 0);
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

test('a leaf change selects exactly its direct test', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-leaf-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sources = { 'leaf.mjs': '', 'leaf.test.mjs': "import './leaf.mjs';", 'other.test.mjs': '' };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(scratch, file), text);
  const candidates = affectedTests({ root: scratch, files: Object.keys(sources), tests: ['leaf.test.mjs', 'other.test.mjs'], changed: ['leaf.mjs'] });
  const plan = boundAffectedTests({ candidates, changed: ['leaf.mjs'] });
  assert.deepEqual(plan.files, ['leaf.test.mjs']);
  assert.deepEqual(plan.deferred, []);
  assert.equal(plan.selected[0].reason, 'direct-reference');
});

test('time and file caps defer extras to release while bound requirements always run', () => {
  const candidates = ['changed.test.mjs', 'cheap.test.mjs', 'expensive.test.mjs', 'unknown.test.mjs'];
  const estimates = { 'changed.test.mjs': { duration_ms: 90 }, 'cheap.test.mjs': { duration_ms: 20 }, 'expensive.test.mjs': { duration_ms: 300 } };
  const options = { candidates, changed: ['changed.test.mjs'], estimates, unknownMs: 60, budgetMs: 150, maxFiles: 2 };
  const capped = boundAffectedTests(options);
  assert.deepEqual(capped.files, ['changed.test.mjs', 'cheap.test.mjs']);
  assert.equal(capped.budget.estimated_ms, 110);
  assert.deepEqual(capped.deferred.map(row => [row.file, row.reason, row.destination]), [
    ['unknown.test.mjs', 'file-cap', 'release-candidate'], ['expensive.test.mjs', 'file-cap', 'release-candidate']]);
  const timed = boundAffectedTests({ ...options, maxFiles: 10 });
  assert.deepEqual(timed.deferred.map(row => [row.file, row.reason]), [['unknown.test.mjs', 'time-budget'], ['expensive.test.mjs', 'time-budget']]);
  assert.equal(timed.deferred[0].estimate, 'fallback');
  const required = boundAffectedTests({ ...options, required: ['expensive.test.mjs'], budgetMs: 100, maxFiles: 1 });
  assert.deepEqual(required.files, ['expensive.test.mjs']);
  assert.equal(required.selected[0].reason, 'bound-required');
  assert.equal(required.budget.required_over_budget, true);
  assert.equal(required.budget.estimated_ms, 300);
  assert.equal(required.deferred.length, 3);
  assert.throws(() => boundAffectedTests({ ...options, budgetMs: 0 }), /invalid affected-test budget/);
});

test('the real planner forces required evidence beyond both caps and refuses missing required files', () => {
  const options = { cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['lib/state.mjs'], baseCommand: 'npm run test:promotion',
    env: { ...process.env, MONITOR_PROMOTION_EXTRA_BUDGET_MS: '1', MONITOR_PROMOTION_EXTRA_MAX_FILES: '1' },
    required: ['lanes/test/lane.test.mjs', 'settle/test/test-evidence.test.mjs', 'promote/test/train.test.mjs'] };
  const plan = promotionTestPlan(options);
  assert.deepEqual(plan.files, ['lanes/test/lane.test.mjs', 'settle/test/test-evidence.test.mjs']);
  assert.equal(plan.selected.every(row => row.reason === 'bound-required'), true);
  assert.equal(plan.budget.required_over_budget, true);
  assert.ok(plan.covered.includes('promote/test/train.test.mjs'));
  assert.ok(plan.deferred.length > 0);
  assert.ok(!plan.deferred.some(row => options.required.includes(row.file)));
  assert.deepEqual(plan.required, [...options.required].sort());
  assert.throws(() => promotionTestPlan({ ...options, required: ['missing.test.mjs'] }), /required test file is missing/);
});
