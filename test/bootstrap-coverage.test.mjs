import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCE_COMMIT, MONOLITH, DISPATCH_FILES, SMOKE_FILES, generateCoverage, replaceDispatch, reconcileDispatch, checkFiles } from './helpers/bootstrap-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8'));

function sourceFixture() {
  const base = SOURCE_COMMIT, split = '4'.repeat(40), capacity = '5'.repeat(40);
  const promotion = [MONOLITH, ...Array.from({ length: 77 }, (_, i) => `test/promotion-${i}.test.mjs`)];
  const slot = ['test-slot/test/train-conformance.test.mjs', ...Array.from({ length: 15 }, (_, i) => `test-slot/test/slot-${i}.test.mjs`)];
  const lane = ['lanes/test/lane.test.mjs'], logic = Array.from({ length: 11 }, (_, i) => `test/logic-${i}.test.mjs`);
  const registrations = (start, count) => "import test from '../../test/helpers/bounded-test.mjs';\n" +
    Array.from({ length: count }, (_, i) => `test('case ${start + i}', () => { throw Error('registration must never execute a callback'); });`).join('\n');
  const before = Object.fromEntries([...promotion, ...slot, ...lane, ...logic, ...SMOKE_FILES,
    ...Object.keys(manifest.execution_sources)].map(file => [file, `// fixture ${file}\n`]));
  before['test/helpers/tier.mjs'] = `const promotion = [\n${promotion.map(file => `  '${file}'`).join(',\n')}\n];`;
  before['package.json'] = JSON.stringify({ scripts: { 'test:promotion:lanes': `node runner ${lane.join(' ')}`, 'test:promotion:logic': `node runner ${logic.join(' ')}` } });
  before[MONOLITH] = registrations(0, 100);
  const after = { ...before, 'dispatch/test/dispatch-fixture.mjs': '// inert shared fixture\n' };
  delete after[MONOLITH];
  let start = 0;
  for (const [index, count] of [32, 4, 24, 40].entries()) {
    after[DISPATCH_FILES[index]] = registrations(start, count); start += count;
  }
  const added = 'test/capacity-new.test.mjs';
  return {
    inputs: { source_commit: base, stack_commits: { 'lane/dispatch-test-split': split, 'lane/runner-capacity': capacity },
      required_tests: [{ source: 'fixture-required-tests.json', sha256: 'fixture', files: [...DISPATCH_FILES, added] }],
      required_files: [slot[0]], bootstrap_tests: ['test/bootstrap-coverage.test.mjs', 'test/bootstrap-gate.test.mjs'] },
    trees: { [base]: before, [split]: after, [capacity]: { ...before, [added]: '// capacity witness\n', 'test/helpers/run.mjs': '// capacity runner\n' } },
    local_files: ['test/bootstrap-coverage.test.mjs', 'test/bootstrap-gate.test.mjs'],
  };
}

// This adapter is also serialized into the VM-enabled child. Every source and
// tree query is injected; an unrecognized query fails instead of using Git.
function fixtureSources(fixture) {
  return {
    read(commit, file) {
      assert.ok(Object.hasOwn(fixture.trees[commit], file), `missing fixture source: ${commit}:${file}`);
      return fixture.trees[commit][file];
    },
    list(args) {
      if (args[0] === 'ls-tree') {
        const prefix = args[5] ?? '';
        return Object.keys(fixture.trees[args[3]]).filter(file => file.startsWith(prefix)).sort().join('\n');
      }
      assert.equal(args[0], 'diff');
      assert.ok(args.includes('--no-renames'));
      const [base, head] = args.slice(-2), before = fixture.trees[base], after = fixture.trees[head];
      if (args.includes('--diff-filter=D')) return Object.keys(before).filter(file => !Object.hasOwn(after, file)).sort().join('\n');
      assert.ok(args.includes('--diff-filter=ACMRT'));
      return Object.keys(after).filter(file => after[file] !== before[file]).sort().join('\n');
    },
    localFile: file => fixture.local_files.includes(file),
  };
}

test('injected source fixtures generate deterministically without a checkout or Git executable', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-sources-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fixture = sourceFixture();
  const program = `import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { generateCoverage } from ${JSON.stringify(new URL('./helpers/bootstrap-coverage.mjs', import.meta.url).href)};
    const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
    const sources = (${fixtureSources.toString()})(fixture);
    process.stdout.write(JSON.stringify(await generateCoverage(fixture.inputs, sources)));`;
  const generate = () => execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', program],
    { cwd: scratch, env: { ...process.env, PATH: scratch }, input: JSON.stringify(fixture), encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  const first = generate();
  assert.equal(first, generate());
  const result = JSON.parse(first);
  const expected = replaceDispatch([...Object.values(result.coverage).flat(), ...fixture.inputs.required_tests.flatMap(row => row.files),
    ...fixture.inputs.required_files, ...fixture.local_files]);
  assert.deepEqual(result.files, expected);
  assert.deepEqual(Object.keys(result.test_sources), expected);
  assert.equal(result.test_sources[DISPATCH_FILES[0]], fixture.inputs.stack_commits['lane/dispatch-test-split']);
  assert.equal(result.coverage.promotion.length, 78); assert.equal(result.coverage.slot.length, 16);
  assert.equal(result.dispatch.registered_names, 100);
  assert.deepEqual(Object.values(result.dispatch.groups), [32, 4, 24, 40]);
});

test('generation refuses missing required, stack-deleted and missing bootstrap lane sources', async () => {
  const missing = sourceFixture();
  missing.inputs.required_files.push('test/not-in-stack.test.mjs');
  await assert.rejects(generateCoverage(missing.inputs, fixtureSources(missing)), /missing bootstrap source in combined stack: test\/not-in-stack.test.mjs/);
  const deleted = sourceFixture();
  delete deleted.trees[deleted.inputs.stack_commits['lane/dispatch-test-split']]['test/promotion-0.test.mjs'];
  await assert.rejects(generateCoverage(deleted.inputs, fixtureSources(deleted)), /missing bootstrap source in combined stack: test\/promotion-0.test.mjs/);
  const local = sourceFixture();
  local.local_files.pop();
  await assert.rejects(generateCoverage(local.inputs, fixtureSources(local)), /missing bootstrap lane source: test\/bootstrap-gate.test.mjs/);
});

test('checkout-only: frozen manifest regenerates from pinned Git objects and registrations', {
  skip: fs.existsSync(new URL('../.git', import.meta.url)) ? false : 'checkout-only: release archive snapshots omit Git history; injected source coverage runs above',
}, () => {
  const args = ['--experimental-vm-modules', 'test/helpers/bootstrap-coverage.mjs', '--stdout'];
  const generate = () => execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = generate(), second = generate();
  assert.equal(first, second);
  assert.equal(first, fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8'));
  assert.equal(manifest.source_commit, SOURCE_COMMIT);
  assert.equal(manifest.coverage.promotion.length, 78);
  assert.equal(manifest.coverage.slot.length, 16);
  assert.equal(manifest.coverage.lane.length, 1);
  assert.equal(manifest.coverage.logic.length, 11);
  assert.deepEqual(manifest.coverage.smoke, SMOKE_FILES);
  assert.equal(manifest.dispatch.registered_names, 100);
  assert.deepEqual(Object.values(manifest.dispatch.groups), [32, 4, 24, 40]);
});

test('dispatch replacement applies to every coverage source and deduplicates the union', () => {
  assert.deepEqual(replaceDispatch([MONOLITH, 'test/a.test.mjs', MONOLITH, ...DISPATCH_FILES]), [...DISPATCH_FILES, 'test/a.test.mjs'].sort());
  assert.ok(!manifest.files.includes(MONOLITH));
  for (const file of DISPATCH_FILES) assert.ok(manifest.files.includes(file));
  const inputs = JSON.parse(fs.readFileSync(new URL('./helpers/bootstrap-inputs.json', import.meta.url), 'utf8'));
  const expected = replaceDispatch([...Object.values(manifest.coverage).flat(), ...inputs.required_tests.flatMap(row => row.files), ...inputs.required_files, ...manifest.changed_tests, ...inputs.bootstrap_tests]);
  assert.deepEqual(manifest.files, expected);
  assert.equal(manifest.files.length, new Set(manifest.files).size);
  assert.deepEqual(Object.keys(manifest.test_sources), manifest.files);
  assert.deepEqual(inputs.required_tests.map(row => path.basename(row.source)), ['eng-539-required-tests.json', 'eng-547-required-tests.json']);
  assert.deepEqual(inputs.required_files, ['test-slot/test/train-conformance.test.mjs']);
  for (const file of ['promote/test/declared-train.test.mjs', 'settle/test/declared-plan.test.mjs', 'test/closeout-code.test.mjs', 'test/closeout-handoff.test.mjs']) assert.ok(!manifest.files.includes(file));
});

test('dispatch provenance rejects changed bodies, missing cases and duplicate names', () => {
  const before = manifest.dispatch.registrations;
  assert.equal(reconcileDispatch(before, { split: before }).registered_names, 100);
  assert.throws(() => reconcileDispatch(before, { split: before.slice(1) }));
  assert.throws(() => reconcileDispatch(before, { split: [...before.slice(1), before[1]] }));
  assert.throws(() => reconcileDispatch(before, { split: before.map((row, index) => index ? row : { ...row, body_sha256: 'changed' }) }), /callback bodies changed/);
});

test('bootstrap inventory refuses duplicate, unsafe and non-test paths', () => {
  for (const files of [['../escape.test.mjs'], ['/root/a.test.mjs'], ['a.test.mjs', 'a.test.mjs'], ['a.mjs'], [null]]) assert.throws(() => checkFiles(files));
  assert.deepEqual(checkFiles(['test/one.test.mjs']), ['test/one.test.mjs']);
});
