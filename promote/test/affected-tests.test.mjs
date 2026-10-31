import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { affectedTests, affectedTestPlan, boundAffectedTests, DEFAULT_BUDGET_MS, DEFAULT_MAX_FILES } from '../../test/helpers/affected-tests.mjs';
import { releasePhases } from '../../test/helpers/release-suites.mjs';
import { affectedOnlyCommand, plannedCommand, promotionTestPlan } from '../test-plan.mjs';
import { compactPlanDetails, expandPlanDetails } from '../../test/helpers/plan-details.mjs';
const root = fs.realpathSync(new URL('../../', import.meta.url));
// The planner reads git ls-files of the product tree; a release build's git-archive snapshot has none.
const gitTree = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() === 'true';
const SNAPSHOT = 'no Git work tree (release snapshot)';
test('test-path list membership does not propagate content changes, but helper imports still do', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-test-list-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sources = { 'list.mjs': "export default ['a.test.mjs'];",
    'other.test.mjs': "import './list.mjs';", 'a.test.mjs': '' };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(scratch, file), text);
  const options = { root: scratch, files: Object.keys(sources) };
  assert.deepEqual(affectedTestPlan({ ...options, changed: ['a.test.mjs'] }).candidates, ['a.test.mjs']);
  assert.deepEqual(affectedTestPlan({ ...options, changed: ['list.mjs'] }).candidates, ['other.test.mjs']);
  // Actual content dependencies on a test remain valid, including explicit ones.
  for (const reference of ["import './a.test.mjs';", "new URL('./a.test.mjs', import.meta.url);"]) {
    fs.writeFileSync(path.join(scratch, 'list.mjs'), reference);
    assert.deepEqual(affectedTestPlan({ ...options, changed: ['a.test.mjs'] }).candidates, ['a.test.mjs', 'other.test.mjs']);
  }
  fs.writeFileSync(path.join(scratch, 'list.mjs'), sources['list.mjs']);
  assert.deepEqual(affectedTestPlan({ ...options, changed: ['a.test.mjs'],
    consumers: { 'list.mjs': ['a.test.mjs'] } }).candidates, ['a.test.mjs', 'other.test.mjs']);
});

test('a listed live test edit excludes unrelated compatibility, line and adoption suites', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs',
    changed: ['test/tier-plan.test.mjs'], baseCommand: 'node test/helpers/affected-tests.mjs --promotion' });
  assert.ok(plan.files.includes('test/tier-plan.test.mjs'));
  for (const file of ['test/compat.test.mjs', 'test/line-service.test.mjs', 'test/adopt.test.mjs']) {
    assert.ok(!plan.files.includes(file), `${file} is unrelated to the changed test`);
  }
  t.diagnostic(`listed-test candidates: ${JSON.stringify(plan.files)}`);
});

test('thirty widely imported core changes produce a validated plan below 512 KiB', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split('\0').filter(Boolean), known = new Set(files), counts = new Map();
  for (const file of files.filter(file => /\.(?:mjs|js|cjs)$/.test(file))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const imports = /(?:\b(?:import|export)\s*(?:[^;'"`]*?\bfrom\s*)?|\b(?:import|require)\s*\(\s*)(['"])([^'"\r\n]+)\1/g;
    for (const match of source.matchAll(imports)) {
      if (!match[2].startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
      if (known.has(target)) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  const required = ['lib/cli-help.mjs', 'lib/store.mjs', 'lib/state.mjs', 'lib/render.mjs', 'bin/org.mjs'];
  const ranked = files.filter(file => /^lib\/.*\.mjs$/.test(file) && !required.includes(file))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const changed = [...required, ...ranked.slice(0, 25)];
  assert.equal(new Set(changed).size, 30);
  const baseCommand = 'node test/helpers/affected-tests.mjs --promotion';
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed, baseCommand });
  assert.ok(plan.files.includes('test/flow.test.mjs'));
  assert.deepEqual(plan.deferred, []);
  const stdout = spawnSync(process.execPath, ['test/helpers/affected-tests.mjs', '--plan',
    JSON.stringify(changed), JSON.stringify(baseCommand), '[]'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(stdout.status, 0, stdout.stderr || stdout.error?.message);
  const bytes = Buffer.byteLength(stdout.stdout);
  assert.ok(bytes < 512 * 1024, `${bytes} bytes must stay below 512 KiB`);
  const expanded = expandPlanDetails(JSON.parse(stdout.stdout));
  assert.deepEqual(expanded.graph, plan.graph);
  assert.deepEqual(expanded.selected, plan.selected);
  assert.deepEqual(expanded.files, plan.files);
  assert.equal(plan.graph.consumers.filter(row => row.file === 'test/flow.test.mjs').length > 1, true);
  t.diagnostic(`wide-plan bytes=${bytes}; consumers=${plan.graph.consumers.length}; files=${plan.files.length}; changed=${JSON.stringify(changed)}`);
});

test('indexed planner details preserve shared witnesses and reject invalid references', () => {
  const consumers = [{ input: 'a.mjs', file: 'a.test.mjs', via: ['a.mjs', 'helper.mjs', 'a.test.mjs'], reason: 'transitive-reference' },
    { input: 'b.mjs', file: 'a.test.mjs', via: ['b.mjs', 'helper.mjs', 'a.test.mjs'], reason: 'explicit-consumer' }];
  const plan = { files: ['a.test.mjs'], graph: { consumers }, selected: [{ file: 'a.test.mjs', consumers }], deferred: [] };
  const compact = compactPlanDetails(plan);
  assert.deepEqual(expandPlanDetails(JSON.parse(JSON.stringify(compact))), plan);
  const invalidRow = structuredClone(compact);
  invalidRow.selected[0].consumers = [consumers.length];
  assert.throws(() => expandPlanDetails(invalidRow), /invalid indexed planner details/);
  const cyclic = structuredClone(compact);
  cyclic.graph.details.via[0][0] = 0;
  assert.throws(() => expandPlanDetails(cyclic), /invalid indexed planner details/);
});

test('reduced planning selects unchanged historical promotion consumers from the complete inventory', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs',
    changed: ['lib/state.mjs'], baseCommand: 'node test/helpers/affected-tests.mjs --promotion' });
  assert.ok(plan.files.includes('test/flow.test.mjs'), 'historical promotion file must run in an affected-only plan');
  assert.ok(plan.graph.inventory.includes('test/flow.test.mjs'));
  assert.ok(plan.graph.inventory.includes('test-slot/test/test-slot.test.mjs'));
  assert.equal(plan.graph.test_files, plan.graph.inventory.length);
  assert.deepEqual(plan.deferred, [], 'reduced affected union has advisory limits');
  const reason = plan.graph.consumers.find(row => row.input === 'lib/state.mjs' && row.file === 'test/flow.test.mjs');
  assert.ok(reason?.via.includes('lib/state.mjs'));
  assert.ok(plan.selected.find(row => row.file === 'test/flow.test.mjs').consumers.length);
});

test('opaque inputs stay unresolved until a known consumer declares its runtime inputs', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-opaque-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sources = {
    'input.json': '{}', 'unrelated.mjs': '',
    'opaque.test.mjs': 'await import(process.env.RUNTIME_MODULE);',
    'unrelated.test.mjs': "import './unrelated.mjs';",
  };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(scratch, file), text);
  const options = { root: scratch, files: Object.keys(sources), changed: ['input.json'] };
  const opaque = affectedTestPlan(options);
  assert.deepEqual(opaque.candidates, []);
  assert.ok(opaque.unknown.some(reason => reason === 'unmapped-input: input.json'));
  assert.ok(opaque.unknown.some(reason => reason.startsWith('opaque-inputs: opaque.test.mjs')));
  assert.deepEqual(opaque.graph.unknown_scope, { 'opaque-inputs': 'global', 'unmapped-input': 'changed-input' });
  const otherChange = affectedTestPlan({ ...options, changed: ['unrelated.mjs'] });
  assert.deepEqual(otherChange.unknown.filter(reason => reason.startsWith('opaque-inputs:')),
    opaque.unknown.filter(reason => reason.startsWith('opaque-inputs:')), 'opaque warnings are global across edits');
  assert.ok(otherChange.unknown.includes('unmapped-input: unrelated.mjs'));
  const recovered = affectedTestPlan({ ...options, consumers: { 'opaque.test.mjs': ['input.json'] } });
  assert.deepEqual(recovered.candidates, ['opaque.test.mjs']);
  assert.deepEqual(recovered.unknown, []);
  assert.deepEqual(recovered.consumers, [{ input: 'input.json', file: 'opaque.test.mjs',
    via: ['input.json', 'opaque.test.mjs'], reason: 'explicit-consumer' }]);
  const bounded = boundAffectedTests({ candidates: recovered.candidates, changed: options.changed,
    consumers: recovered.consumers, budgetMs: 1 });
  assert.deepEqual(bounded.files, []);
  assert.equal(bounded.deferred[0].consumers[0].reason, 'explicit-consumer');
  assert.equal(bounded.deferred[0].destination, 'release-candidate');
  assert.throws(() => affectedTestPlan({ ...options, consumers: { 'absent.test.mjs': ['input.json'] } }), /invalid explicit consumer/);
});

test('a changed helper selects its transitive consumer while unrelated tests remain out', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-helper-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const sources = { 'leaf.mjs': '', 'helper.mjs': "export * from './leaf.mjs';",
    'consumer.test.mjs': "import './helper.mjs';", 'unrelated.test.mjs': '' };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(scratch, file), text);
  const plan = affectedTestPlan({ root: scratch, files: Object.keys(sources), changed: ['leaf.mjs'] });
  assert.deepEqual(plan.candidates, ['consumer.test.mjs']);
  assert.deepEqual(plan.unknown, []);
  assert.deepEqual(plan.consumers[0].via, ['leaf.mjs', 'helper.mjs', 'consumer.test.mjs']);
  assert.equal(plan.consumers[0].reason, 'transitive-reference');
});

test('the three-argument planner output keeps the field set accepted by the main validator', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const result = spawnSync(process.execPath, ['test/helpers/affected-tests.mjs', '--plan',
    JSON.stringify(['lib/deadline.mjs']), JSON.stringify('npm run test:promotion')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['covered', 'files', 'graph']);
});

test('transitive selection includes re-exports, literal dynamic imports, deletions and cycles', t => {
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
test('a core-module change selects bounded transitive extras and defers the expensive lane file', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: ['lanes/lane.mjs', 'dispatch/dispatch.mjs'], baseCommand: 'npm run test:promotion' });
  assert.ok(!plan.files.includes('lanes/test/lane.test.mjs'));
  assert.ok(plan.deferred.some(row => row.file === 'lanes/test/lane.test.mjs' && ['time-budget', 'file-cap'].includes(row.reason)));
  assert.ok(plan.files.length <= DEFAULT_MAX_FILES);
  assert.ok(plan.budget.estimated_ms <= DEFAULT_BUDGET_MS);
  assert.equal(plan.graph.hops, 'transitive');
  for (const file of ['dispatch/test/dispatch-admission.test.mjs', 'dispatch/test/dispatch-options.test.mjs',
    'dispatch/test/dispatch-recovery.test.mjs', 'dispatch/test/dispatch-session.test.mjs']) {
    assert.ok(plan.files.includes(file) || plan.covered.includes(file));
  }
  assert.ok(!plan.covered.includes('settle/test/validation-tiers.test.mjs'));
  assert.ok([...plan.selected, ...plan.deferred].some(row => row.file === 'settle/test/validation-tiers.test.mjs'));
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

test('both fixture targets reach all three split lane CLI files with measured budget costs', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
  const laneFiles = ['lanes/test/lane.test.mjs', 'lanes/test/lane-dispatch.test.mjs', 'lanes/test/lane-review.test.mjs'];
  for (const changed of ['lanes/lane.mjs', 'lanes/board/herdr-client.mjs']) {
    const plan = promotionTestPlan({ cwd: root, planner: 'test/helpers/affected-tests.mjs', changed: [changed], baseCommand: 'npm run test:promotion' });
    const rows = [...plan.selected, ...plan.deferred];
    for (const file of laneFiles) {
      const matches = rows.filter(row => row.file === file);
      assert.equal(matches.length, 1, `${changed} must select or defer ${file} exactly once`);
      assert.equal(matches[0].estimate, 'measured', file);
      assert.ok(Number.isFinite(Date.parse(matches[0].measured_at)), file);
      assert.ok(matches[0].estimated_ms > plan.budget.unknown_file_ms, file);
    }
    assert.ok(laneFiles.filter(file => plan.files.includes(file)).length <= 1, 'only one split lane CLI file fits in the extras budget');
    assert.ok(plan.budget.estimated_ms <= DEFAULT_BUDGET_MS);
    assert.ok(plan.files.length <= DEFAULT_MAX_FILES);
  }
});

test('the planner CLI launched through a symlinked directory emits the same plan', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
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

test('the real planner forces required evidence beyond both caps and refuses missing required files', t => {
  if (!gitTree) return t.skip(SNAPSHOT);
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


test('gating hotfix runs a unique affected selection once without a full-tier append', () => {
  const command = 'node test/helpers/affected-tests.mjs --promotion';
  const plan = { files: ['one.test.mjs', 'two.test.mjs'], command: 'must-not-run-again' };
  const actual = plannedCommand(command, plan);
  assert.equal(affectedOnlyCommand(command), true);
  assert.match(actual, /MONITOR_PROMOTION_TEST_FILES=/);
  assert.equal(actual.split('--promotion').length - 1, 1);
  assert.doesNotMatch(actual, /must-not-run-again|npm run test:promotion|&&/);
  assert.throws(() => plannedCommand(command, null), /captured test plan/);
});

test('gating hotfix validates parallel review and never promotes red or unauthenticated evidence', async () => {
  const { validateValidation } = await import('../../lib/validation-declaration.mjs');
  const { parallelPromotionResult } = await import('../../supervisor/supervisor.mjs');
  assert.equal(validateValidation({ review: 'parallel' }).review, 'parallel');
  assert.throws(() => validateValidation({ review: 'unknown' }), /serial or parallel/);
  const job = { parallelReview: true, stage: 'reviewing', outcome: 'done', reportHash: 'b'.repeat(64),
    head: 'a'.repeat(40), run: 'R-1', item: 'ENG-1', lane: 'fixture', validation: { exit_code: 0 } };
  const run = { id: 'R-1', item: 'ENG-1', report: { outcome: 'done', sha256: 'b'.repeat(64) } };
  assert.equal(parallelPromotionResult(job, run, job.head).result, 'review_pending');
  assert.equal(parallelPromotionResult(job, run, job.head).reviewed_commit, null);
  assert.equal(parallelPromotionResult({ ...job, validation: { exit_code: 1 } }, run, job.head), null);
  assert.equal(parallelPromotionResult({ ...job, review: { verdict: 'FAIL' } }, run, job.head), null);
  assert.equal(parallelPromotionResult(job, { ...run, report: { outcome: 'done', sha256: 'changed' } }, job.head), null);
  assert.equal(parallelPromotionResult({ ...job, outcome: 'blocked' }, run, job.head), null);
  assert.equal(parallelPromotionResult({ ...job, reportHash: undefined }, { ...run, report: { outcome: 'done' } }, job.head), null);
  assert.equal(parallelPromotionResult(job, { ...run, id: 'R-2' }, job.head), null);
  assert.equal(parallelPromotionResult(job, run, 'c'.repeat(40)), null);
  assert.equal(parallelPromotionResult({ ...job, review: { verdict: 'NEEDS-WORK' } }, run, job.head), null);
});


test('gating hotfix settle fixture preserves real exit errors without command ceilings', async t => {
  const { fixture } = await import('../../settle/test/fixture.mjs');
  const calls = [];
  const f = fixture(t, { execute(file, args, options) {
    calls.push({ file, args, options });
    assert.equal(Object.hasOwn(options, 'timeout'), false);
    return spawnSync(file, args, options);
  } });
  const result = f.exec(process.execPath, ['-e', 'process.stdout.write("actual-output");process.exit(7)']);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'actual-output');
  assert.ok(calls.some(call => call.file === 'git'));
  await f.cleanup();
});


test('gating hotfix reads the actual Git head and refuses changed source during parallel admission', async t => {
  const { parallelPromotionSourceResult } = await import('../../supervisor/supervisor.mjs');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-admission-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@localhost']);
  fs.writeFileSync(path.join(workspace, 'source'), 'bound source\n');
  git(['add', '--', 'source']); git(['commit', '-m', 'Bind source']);
  const head = git(['rev-parse', 'HEAD']), reportHash = 'b'.repeat(64);
  const job = { workspace, parallelReview: true, stage: 'reviewing', outcome: 'done', reportHash,
    head, run: 'R-1', item: 'ENG-1', lane: 'fixture', validation: { exit_code: 0 } };
  const run = { id: 'R-1', item: 'ENG-1', report: { outcome: 'done', sha256: reportHash } };
  assert.equal(parallelPromotionSourceResult(job, run).head, head);
  assert.equal(parallelPromotionSourceResult({ ...job, head: 'a'.repeat(40) }, run), null);
  assert.equal(parallelPromotionSourceResult({ ...job, review: { verdict: 'NEEDS-WORK' } }, run), null);
  assert.equal(parallelPromotionSourceResult(job, { ...run, report: { outcome: 'done', sha256: 'c'.repeat(64) } }), null);
  fs.appendFileSync(path.join(workspace, 'source'), 'changed\n');
  assert.throws(() => parallelPromotionSourceResult(job, run), /source changed/);
});
