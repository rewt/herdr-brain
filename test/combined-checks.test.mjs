import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { combinedPlan, main } from './helpers/combined-checks.mjs';
import { promotionTestPlan } from '../promote/test-plan.mjs';

const plannerRoot = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'combined-checks-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  const write = (file, text = '') => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text); };
  const commit = () => { git('add', '--all'); git('commit', '-qm', 'fixture change'); return git('rev-parse', 'HEAD'); };
  write('writer.mjs'); write('reader.mjs'); write('unrelated.mjs');
  write('writer.test.mjs', "import './writer.mjs';");
  write('reader.test.mjs', "import './reader.mjs';");
  write('contract.test.mjs', "import './reader.mjs'; import './writer.mjs';");
  write('unrelated.test.mjs', "import './unrelated.mjs';");
  const base = commit();
  return { cwd, base, git, write, commit };
}
test('combined range checks both landed and candidate slices on their combined HEAD', t => {
  const f = fixture(t);
  f.write('writer.mjs', 'export const shape = 2;'); f.commit();
  f.write('reader.mjs', 'export const use = 2;'); const head = f.commit();
  const plan = combinedPlan(f);
  assert.equal(plan.head, head); assert.equal(plan.base, f.base);
  assert.equal(plan.tree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.deepEqual(plan.changed, ['reader.mjs', 'writer.mjs']);
  assert.deepEqual(plan.files, ['contract.test.mjs', 'reader.test.mjs', 'writer.test.mjs']);
  assert.ok(plan.groups.every(([, files]) => files.length <= 4));
  assert.ok(!plan.files.includes('unrelated.test.mjs'));
});
test('deletions retain old-path consumers and renamed-path consumers', t => {
  const f = fixture(t);
  f.git('mv', 'writer.mjs', 'replacement.mjs'); f.commit();
  const plan = combinedPlan(f);
  assert.deepEqual(plan.changed, ['replacement.mjs', 'writer.mjs']);
  assert.deepEqual(plan.files, ['contract.test.mjs', 'writer.test.mjs']);
});
test('both planners retain transitive old and new consumers in the complete live inventory', t => {
  const f = fixture(t);
  f.write('bridge.mjs', "export * from './writer.mjs';");
  f.write('test/flow.test.mjs', "import '../bridge.mjs';");
  f.write('test-slot/test/slot.test.mjs', "import '../../bridge.mjs';");
  f.write('new.test.mjs', "import './replacement.mjs';");
  const base = f.commit();
  f.git('mv', 'writer.mjs', 'replacement.mjs'); f.commit();
  const plan = combinedPlan({ ...f, base });
  assert.deepEqual(plan.files, ['contract.test.mjs', 'new.test.mjs', 'test-slot/test/slot.test.mjs', 'test/flow.test.mjs', 'writer.test.mjs']);
  assert.equal(plan.graph.hops, 'transitive');
  assert.ok(!plan.files.includes('unrelated.test.mjs'));
  assert.equal(plan.graph.consumers.find(row => row.file === 'test/flow.test.mjs').reason, 'transitive-reference');
  const reduced = promotionTestPlan({ cwd: f.cwd, plannerRoot, planner: 'test/helpers/affected-tests.mjs',
    changed: plan.changed, baseCommand: 'node test/helpers/affected-tests.mjs --promotion' });
  assert.deepEqual(reduced.files, plan.files);
  assert.deepEqual(reduced.graph, plan.graph);
  assert.deepEqual(reduced.unknown, plan.unknown);
  assert.deepEqual(reduced.deferred, []);
  assert.ok(plan.groups.every(([, rows]) => rows.length <= 4));
});
test('both planners expose opaque coverage and recover an explicit data consumer without running unrelated tests', t => {
  const f = fixture(t);
  f.write('data.json', '{}');
  f.write('dynamic.test.mjs', 'await import(process.env.TEST_INPUT);');
  const base = f.commit();
  f.write('data.json', '{"shape":2}'); f.commit();
  const unresolved = combinedPlan({ ...f, base });
  assert.deepEqual(unresolved.files, []);
  assert.ok(unresolved.unknown.some(row => row.startsWith('opaque-inputs: dynamic.test.mjs')));
  assert.ok(unresolved.unknown.includes('unmapped-input: data.json'));
  f.write('test/helpers/test-consumers.json', JSON.stringify({ schema: 'test-consumers/v1',
    consumers: { 'dynamic.test.mjs': ['data.json'] } }));
  f.commit();
  const plan = combinedPlan({ ...f, base });
  assert.deepEqual(plan.files, ['dynamic.test.mjs']);
  assert.deepEqual(plan.unknown, []);
  assert.ok(plan.selected[0].consumers.every(row => row.reason === 'explicit-consumer'));
  const reduced = promotionTestPlan({ cwd: f.cwd, plannerRoot, planner: 'test/helpers/affected-tests.mjs',
    changed: plan.changed, baseCommand: 'node test/helpers/affected-tests.mjs --promotion' });
  assert.deepEqual(reduced.files, plan.files);
  assert.deepEqual(reduced.unknown, []);
  const extra = combinedPlan({ ...f, base, extra: ['unrelated.test.mjs'], budgetMs: 1, maxFiles: 1 });
  assert.deepEqual(extra.files, ['unrelated.test.mjs']);
  assert.deepEqual(extra.deferred.map(row => row.file), ['dynamic.test.mjs']);
  assert.deepEqual(extra.unknown, [], 'a budget deferral is distinct from an unresolved dependency');
});
test('bounded deferrals remain explicit and extra contract checks override budgets once', t => {
  const f = fixture(t);
  f.write('writer.mjs', 'changed'); f.commit();
  const plan = combinedPlan({ ...f, extra: ['unrelated.test.mjs', 'unrelated.test.mjs'], maxFiles: 1, budgetMs: 1 });
  assert.deepEqual(plan.files, ['unrelated.test.mjs']);
  assert.equal(plan.budget.required_over_budget, true);
  assert.equal(plan.deferred.length, 2);
  assert.ok(plan.deferred.every(row => row.destination === 'release-candidate'));
});
test('base must be immutable, available and ancestral; dirty candidates refuse', t => {
  const f = fixture(t);
  assert.throws(() => combinedPlan({ ...f, base: 'main' }), /immutable full commit/);
  assert.throws(() => combinedPlan({ ...f, base: 'f'.repeat(40) }));
  f.git('checkout', '-qb', 'side'); f.write('side'); const side = f.commit();
  f.git('checkout', '-q', 'main'); f.write('main'); f.commit();
  assert.throws(() => combinedPlan({ ...f, base: side }), /ancestor/);
  f.write('untracked'); assert.throws(() => combinedPlan(f), /clean committed/);
});
test('extra tests must belong to the tracked candidate and unknown flags refuse', t => {
  const f = fixture(t);
  for (const file of ['../outside.test.mjs', '/tmp/outside.test.mjs', 'missing.test.mjs', 'writer.mjs']) {
    assert.throws(() => combinedPlan({ ...f, extra: [file] }), /tracked test/);
  }
  assert.throws(() => main(['--base', f.base, '--full'], { cwd: f.cwd }), /usage/);
});
test('empty and plan-only selections never invoke the runner', t => {
  const f = fixture(t), output = [];
  const options = { cwd: f.cwd, output: text => output.push(text), execute: () => assert.fail('must remain unrun') };
  assert.equal(main(['--base', f.base], options), 3);
  assert.equal(JSON.parse(output[0]).execution, 'unrun-empty');
  assert.match(output.at(-1), /no tests executed.*not full coverage or a test PASS/);
  f.write('writer.mjs', 'changed'); f.commit();
  assert.equal(main(['--base', f.base, '--plan'], options), 0);
  assert.equal(JSON.parse(output.at(-1)).execution, 'unrun-plan');
});
test('real CLI empty selection exits unrun without producing passing test evidence', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('./helpers/combined-checks.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--base', f.base], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout.split('\n')[0]);
  assert.equal(plan.execution, 'unrun-empty');
  assert.deepEqual(plan.files, []);
  assert.match(result.stdout, /no tests executed.*not full coverage or a test PASS/);
  assert.doesNotMatch(result.stdout, /TAP version|# tests|All release-tier suites passed/);
});
test('real CLI planning captures the combined commit without running tests', t => {
  const f = fixture(t);
  f.write('writer.mjs', 'changed'); const head = f.commit();
  const cli = fileURLToPath(new URL('./helpers/combined-checks.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--base', f.base, '--extra', 'unrelated.test.mjs', '--plan'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.head, head); assert.ok(plan.files.includes('unrelated.test.mjs'));
  assert.equal(plan.execution, 'unrun-plan');
});
test('real combined CLI exercises the writer and consumer together through the bounded runner', t => {
  const f = fixture(t);
  f.write('writer.mjs', 'export const shape = 1;');
  f.write('reader.mjs', 'export const expected = 1;');
  f.write('contract.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict';
import { shape } from './writer.mjs'; import { expected } from './reader.mjs';
test('combined writer and reader agree', () => assert.equal(shape, expected));`);
  const base = f.commit();
  f.write('writer.mjs', 'export const shape = 2;'); f.commit();
  f.write('reader.mjs', 'export const expected = 2;'); const head = f.commit();
  const cli = fileURLToPath(new URL('./helpers/combined-checks.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--base', base], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /combined writer and reader agree/);
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.head, head); assert.equal(receipt.exit_code, 0);
  assert.deepEqual(receipt.selected, ['contract.test.mjs', 'reader.test.mjs', 'writer.test.mjs']);
});
test('a failing selection runs once and preserves its exit status and deferred truth', t => {
  const f = fixture(t), output = []; let calls = 0;
  f.write('writer.mjs', 'changed'); f.commit();
  assert.equal(main(['--base', f.base], { cwd: f.cwd, output: text => output.push(text), execute(files) {
    calls++; assert.deepEqual(files, ['contract.test.mjs', 'writer.test.mjs']); return 7;
  } }), 7);
  assert.equal(calls, 1); assert.equal(JSON.parse(output.at(-1)).exit_code, 7);
  assert.match(JSON.parse(output.at(-1)).coverage, /unselected tests unrun/);
});
test('source movement during execution refuses to attribute success to a new target', t => {
  const f = fixture(t);
  f.write('writer.mjs', 'changed'); f.commit();
  assert.throws(() => main(['--base', f.base], { cwd: f.cwd, output() {}, execute() {
    f.write('reader.mjs', 'moved'); f.commit(); return 0;
  } }), /HEAD moved/);
});
