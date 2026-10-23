import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { copyProduct } from '../../lib/product-files.mjs';
import { selectTests } from '../../test/helpers/select-tests.mjs';
import { candidateChanges, shadowSelection, completeShadow, validateSelection, failingTestFiles } from '../selector.mjs';
import { collectShadow, renderShadow } from '../shadow.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selector-test-')));
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const env = { ...healthyMemoryEnvironment(fixtureEnvironment()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_(?!MONITOR_FLEET)|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const exec = (file, args, cwd = repo) => spawnSync(file, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
  const git = (args, cwd = repo) => { const r = exec('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const write = (file, value, cwd = repo) => { const target = path.join(cwd, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Selector']); git(['config', 'user.email', 'selector@example.invalid']);
  const commit = message => { git(['add', '.']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  const files = {
    'leaf.mjs': 'export const value = 1;',
    'bridge.mjs': "export*from'./leaf.mjs'; export * from './cycle.mjs';",
    'cycle.mjs': "import './bridge.mjs';",
    'direct.test.mjs': "import './leaf.mjs';",
    'transitive.test.mjs': "import{value}from'./bridge.mjs';",
    'dynamic.test.mjs': "await import('./cycle.mjs');",
    'url.test.mjs': "new URL('./bridge.mjs', import.meta.url);",
    'require.test.mjs': "require('./bridge');",
    'other.test.mjs': '',
    'orphan.mjs': '', 'test/helpers/shared.mjs': '', 'package.json': '{}', 'config.mjs': '',
  };
  for (const [file, value] of Object.entries(files)) write(file, value);
  return { root, repo, env, exec, git, write, commit, files: Object.keys(files) };
}
const change = file => [{ path: file, status: 'M' }];

test('the computed graph follows transitive importers, re-exports, cycles and literal dynamic references', t => {
  const f = fixture(t), options = { root: f.repo, files: f.files };
  assert.deepEqual(selectTests({ ...options, changed: change('leaf.mjs') }).pick,
    ['direct.test.mjs', 'dynamic.test.mjs', 'require.test.mjs', 'transitive.test.mjs', 'url.test.mjs']);
  assert.deepEqual(selectTests({ ...options, changed: change('other.test.mjs') }).pick, ['other.test.mjs']);
  f.write('new.test.mjs', "import './leaf.mjs';");
  assert.ok(selectTests({ ...options, files: [...f.files, 'new.test.mjs'], changed: change('leaf.mjs') }).pick.includes('new.test.mjs'), 'no checked-in consumer map to refresh');
  assert.deepEqual(selectTests({ ...options, changed: [] }).pick, []);
});

test('unknown, unmapped, helper, package, config, deleted, renamed and unsafe paths select full', t => {
  const f = fixture(t);
  for (const file of ['unknown.mjs', 'orphan.mjs', 'test/helpers/shared.mjs', 'package.json', 'config.mjs', '../leaf.mjs']) {
    assert.equal(selectTests({ root: f.repo, files: f.files, changed: change(file) }).pick, 'full', file);
  }
  for (const status of ['D', 'R100', 'T', '?']) assert.equal(selectTests({ root: f.repo, files: f.files, changed: [{ path: 'leaf.mjs', status }] }).pick, 'full', status);
  fs.unlinkSync(path.join(f.repo, 'leaf.mjs')); fs.symlinkSync('orphan.mjs', path.join(f.repo, 'leaf.mjs'));
  assert.equal(selectTests({ root: f.repo, files: f.files, changed: change('leaf.mjs') }).pick, 'full');
});

test('unreferenced documentation contributes zero tests beside a code change or by itself', t => {
  const f = fixture(t), documents = ['docs/reviews/topic/head-r1.md', 'docs/guide.md', 'docs/config-guide.md', 'module/docs/REFERENCE.md', 'module/README.md', 'README.md'];
  for (const file of documents) f.write(file, '# Unreferenced documentation');
  const options = { root: f.repo, files: [...f.files, ...documents] };
  const code = selectTests({ ...options, changed: change('leaf.mjs') }).pick;
  assert.ok(Array.isArray(code) && code.length > 0, 'the code change must produce a nonempty subset');
  for (const file of documents) {
    assert.deepEqual(selectTests({ ...options, changed: [...change('leaf.mjs'), ...change(file)] }).pick, code, file);
    assert.deepEqual(selectTests({ ...options, changed: change(file) }).pick, [], file);
  }
  assert.equal(selectTests({ ...options, changed: change('docs/unknown.md') }).pick, 'full');
  f.write('notes.md', '# Outside the documentation exemption');
  assert.equal(selectTests({ ...options, files: [...options.files, 'notes.md'], changed: change('notes.md') }).pick, 'full');
  for (const file of ['test/helpers/README.md', 'docs/reviews/config.json', 'docs/reviews/package.json']) {
    f.write(file, '{}');
    assert.equal(selectTests({ ...options, files: [...options.files, file], changed: change(file) }).pick, 'full', file);
  }
});

test('documents read through literal paths still select full, including transitive helper readers', t => {
  const f = fixture(t);
  const sources = {
    'docs/root.md': '# Root path', 'docs/relative.md': '# Relative path', 'module/README.md': '# Root-relative README',
    'docs/indirect.md': '# Helper read', 'docs/reviews/topic/read.md': '# Referenced review',
    'document.test.mjs': "fs.readFileSync(path.join(root, 'docs/root.md')); fs.readFileSync(new URL('./docs/relative.md', import.meta.url)); fs.readFileSync(path.join(root, 'module/README.md')); fs.readFileSync('docs/reviews/topic/read.md'); import './reader.mjs';",
    'reader.mjs': "fs.readFileSync('docs/indirect.md');",
  };
  for (const [file, content] of Object.entries(sources)) f.write(file, content);
  const options = { root: f.repo, files: [...f.files, ...Object.keys(sources)] };
  for (const file of Object.keys(sources).filter(file => file.endsWith('.md'))) {
    const selection = selectTests({ ...options, changed: change(file) });
    assert.equal(selection.pick, 'full', file); assert.match(selection.reason, /test-referenced document/);
  }
  fs.unlinkSync(path.join(f.repo, 'docs/root.md')); fs.symlinkSync('../leaf.mjs', path.join(f.repo, 'docs/root.md'));
  assert.equal(selectTests({ ...options, changed: change('docs/root.md') }).pick, 'full');
});

test('bare document basenames do not mark unrelated READMEs as test-referenced', t => {
  const f = fixture(t), moduleReadme = path.posix.join('promote', 'README.md');
  const sources = {
    [moduleReadme]: '# Module documentation', 'README.md': '# Root documentation',
    'test/fixture.test.mjs': 'fs.writeFileSync(path.join(temporaryRepo, "README.md"), "fixture");',
  };
  for (const [file, content] of Object.entries(sources)) f.write(file, content);
  const options = { root: f.repo, files: [...f.files, ...Object.keys(sources)] };
  const code = selectTests({ ...options, changed: change('leaf.mjs') }).pick;
  assert.ok(Array.isArray(code) && code.length > 0);
  for (const file of [moduleReadme, 'README.md']) {
    assert.deepEqual(selectTests({ ...options, changed: change(file) }).pick, [], file);
    assert.deepEqual(selectTests({ ...options, changed: [...change('leaf.mjs'), ...change(file)] }).pick, code, file);
  }
});

test('directory-based document paths reference only the resolved README', t => {
  const f = fixture(t), laneReadme = path.posix.join('lanes', 'README.md'), otherReadme = path.posix.join('promote', 'README.md');
  // Assemble the generated reader so this fixture does not itself appear to
  // read the README above this test file in the real repository's graph.
  const here = ['HE', 'RE'].join(''), dirname = ['__', 'dirname'].join('');
  const sources = {
    [laneReadme]: '# Reader target', [otherReadme]: '# Other module', 'README.md': '# Root',
    'lanes/test/lane.test.mjs': `const ${here} = dirname(fileURLToPath(import.meta.url)); readFileSync(resolve(${here}, "..", "README.md"), "utf8");`,
  };
  for (const [file, content] of Object.entries(sources)) f.write(file, content);
  const options = { root: f.repo, files: [...f.files, ...Object.keys(sources)] };
  assert.equal(selectTests({ ...options, changed: change(laneReadme) }).pick, 'full');
  for (const file of [otherReadme, 'README.md']) assert.deepEqual(selectTests({ ...options, changed: change(file) }).pick, [], file);
  f.write('lanes/test/lane.test.mjs', `readFileSync(path.join(${dirname}, '..', 'README.md'), 'utf8');`);
  assert.equal(selectTests({ ...options, changed: change(laneReadme) }).pick, 'full');
  assert.deepEqual(selectTests({ ...options, changed: change(otherReadme) }).pick, []);
});

test('suffix-anchored literals recover script and document paths inside template interpolations', t => {
  const f = fixture(t);
  const sources = {
    'cli/entry.mjs': "import '../leaf.mjs';",
    'interpolation.test.mjs': "const code = `import {run} from ${JSON.stringify(path.join(source, 'cli/entry.mjs'))};`;",
    'cli/runner.sh': '',
    'shell.test.mjs': "const code = `launch ${JSON.stringify(path.join(source, 'cli/runner.sh'))}`;",
    'docs/interpolated.md': '# Document', 'docs/reviews/topic/receipt': 'Review record',
    'document-template.test.mjs': "const code = `read(${JSON.stringify(path.join(root, 'docs/interpolated.md'))}); read(${JSON.stringify(path.join(root, 'docs/reviews/topic/receipt'))});`;",
  };
  for (const [file, content] of Object.entries(sources)) f.write(file, content);
  const options = { root: f.repo, files: [...f.files, ...Object.keys(sources)] };
  assert.deepEqual(selectTests({ ...options, changed: change('cli/entry.mjs') }).pick, ['interpolation.test.mjs']);
  assert.ok(selectTests({ ...options, changed: change('leaf.mjs') }).pick.includes('interpolation.test.mjs'));
  assert.deepEqual(selectTests({ ...options, changed: change('cli/runner.sh') }).pick, ['shell.test.mjs']);
  for (const file of ['docs/interpolated.md', 'docs/reviews/topic/receipt']) assert.equal(selectTests({ ...options, changed: change(file) }).pick, 'full', file);
});

test('spawned root-relative and basename CLI literals participate in transitive selection', t => {
  const f = fixture(t);
  const sources = {
    'cli/entry.mjs': "import '../leaf.mjs';",
    'root-cli.test.mjs': "spawnSync(process.execPath, [path.join(source, 'cli/entry.mjs')]);",
    'basename-cli.test.mjs': "spawnSync(process.execPath, [path.join(source, 'cli', 'entry.mjs')]);",
    'backtick-cli.test.mjs': 'spawnSync(process.execPath, [path.join(source, `cli/entry.mjs`)]);',
    'cli/tool.js': '', 'cli/tool.cjs': '', 'cli/tool.sh': '',
    'scripts.test.mjs': "spawnSync('node', ['cli/tool.js']); spawnSync('node', [path.join(source, 'cli', 'tool.cjs')]); spawnSync('bash', ['cli/tool.sh']);",
    'other-cli.test.mjs': "spawnSync('node', ['unrelated.mjs']);",
  };
  for (const [file, content] of Object.entries(sources)) f.write(file, content);
  const options = { root: f.repo, files: [...f.files, ...Object.keys(sources)] };
  const cliTests = ['backtick-cli.test.mjs', 'basename-cli.test.mjs', 'root-cli.test.mjs'];
  assert.deepEqual(selectTests({ ...options, changed: change('cli/entry.mjs') }).pick, cliTests);
  assert.deepEqual(selectTests({ ...options, changed: change('leaf.mjs') }).pick,
    [...cliTests, 'direct.test.mjs', 'dynamic.test.mjs', 'require.test.mjs', 'transitive.test.mjs', 'url.test.mjs'].sort());
  for (const file of ['cli/tool.js', 'cli/tool.cjs', 'cli/tool.sh']) assert.deepEqual(selectTests({ ...options, changed: change(file) }).pick, ['scripts.test.mjs'], file);
});

function adapter(f, text = "console.log(JSON.stringify({pick:['direct.test.mjs'],reason:'fixture adapter'}));") {
  f.write('.promotion-selector.json', JSON.stringify({ schema: 'promotion-selector/v1', adapter: 'adapter.mjs' }));
  f.write('adapter.mjs', text);
}
test('the generic contract uses base code and sends exact base...head statuses to the adapter', t => {
  const f = fixture(t);
  adapter(f, `import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(0,'utf8'));
if(r.schema!=='promotion-selector/v1'||r.changed.length!==1||r.changed[0].path!=='leaf.mjs'||r.changed[0].status!=='M'||!fs.readFileSync(r.root+'/leaf.mjs','utf8').includes('2'))process.exit(2);
console.log(JSON.stringify({pick:['direct.test.mjs'],reason:'captured base adapter'}));`);
  const base = f.commit('Base');
  f.git(['checkout', '-qb', 'lane/topic']); f.write('leaf.mjs', 'export const value = 2;'); const head = f.commit('Module change');
  f.git(['checkout', '-q', 'main']); f.write('orphan.mjs', 'unrelated main advance'); f.commit('Advance main');
  f.git(['checkout', '-q', 'lane/topic']);
  // Uncommitted lane adapter must never execute. The candidate root is read-only input.
  const marker = path.join(f.root, 'forged');
  f.write('adapter.mjs', `require('fs').writeFileSync(${JSON.stringify(marker)},'forged');`);
  const selection = shadowSelection({ repo: f.repo, cwd: f.repo, base, head, env: f.env });
  assert.deepEqual(selection.pick, ['direct.test.mjs']); assert.equal(selection.reason, 'captured base adapter');
  assert.deepEqual(selection.changed, change('leaf.mjs')); assert.equal(fs.existsSync(marker), false); assert.equal(selection.miss, null);
  assert.deepEqual(candidateChanges(f.repo, f.git(['rev-parse', 'main']), head), change('leaf.mjs'), 'three-dot diff excludes unrelated main changes');
});

test('renames and deletions select full without invoking an adapter', t => {
  const f = fixture(t), marker = path.join(f.root, 'adapter-ran');
  adapter(f, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');throw Error('must not execute');`);
  const base = f.commit('Base'); f.git(['mv', 'leaf.mjs', 'renamed.mjs']); const head = f.commit('Rename');
  assert.deepEqual(candidateChanges(f.repo, base, head), [{ path: 'leaf.mjs', status: 'D' }, { path: 'renamed.mjs', status: 'A' }]);
  assert.equal(shadowSelection({ repo: f.repo, cwd: f.repo, base, head, env: f.env }).pick, 'full');
  assert.equal(fs.existsSync(marker), false);
});

test('missing configuration opts out; bad, absent and failing adapters record full without throwing', t => {
  const f = fixture(t); let base = f.commit('Base');
  assert.equal(shadowSelection({ repo: f.repo, cwd: f.repo, base, head: base, env: f.env }), null);
  for (const code of ['throw Error("broken");', 'console.log("garbage");', 'console.log(JSON.stringify({pick:["../bad.test.mjs"],reason:"unsafe"}));', '']) {
    adapter(f, code); base = f.commit('Adapter variant');
    const selection = shadowSelection({ repo: f.repo, cwd: f.repo, base, head: base, env: f.env });
    assert.equal(selection.pick, 'full'); assert.ok(selection.error);
  }
  fs.unlinkSync(path.join(f.repo, 'adapter.mjs')); base = f.commit('Missing adapter');
  assert.equal(shadowSelection({ repo: f.repo, cwd: f.repo, base, head: base, env: f.env }).pick, 'full');
  for (const response of [{ pick: [], reason: '' }, { pick: ['x.test.mjs', 'x.test.mjs'], reason: 'dup' }, { pick: 'full', reason: 'ok', command: 'exit 0' }]) assert.throws(() => validateSelection(response));
});

test('the Brain adapter runs from the base snapshot and computes the candidate import graph', t => {
  const f = fixture(t);
  f.write('test/helpers/select-tests.mjs', fs.readFileSync(path.join(source, 'test/helpers/select-tests.mjs')));
  f.write('lib/cli-help.mjs', fs.readFileSync(path.join(source, 'lib/cli-help.mjs')));
  f.write('.promotion-selector.json', JSON.stringify({ schema: 'promotion-selector/v1', adapter: 'test/helpers/select-tests.mjs' }));
  const base = f.commit('Base'); f.write('leaf.mjs', 'export const value = 2;'); const head = f.commit('Change leaf');
  const selection = shadowSelection({ repo: f.repo, cwd: f.repo, base, head, env: f.env });
  assert.deepEqual(selection.pick, ['direct.test.mjs', 'dynamic.test.mjs', 'require.test.mjs', 'transitive.test.mjs', 'url.test.mjs']);
});

test('shadow comparison catches outside failures and unknown failures without changing a gate', t => {
  const f = fixture(t), log = f.write('gate.log', `TAP version 13
# Subtest: broken
not ok 1 - broken
  ---
  location: '${f.repo}/other.test.mjs:2:1'
  ...
`);
  const pick = { schema: 'promotion-selector-shadow/v1', pick: ['direct.test.mjs'], reason: 'fixture', miss: null };
  const gate = { command: 'unchanged gate', log, exit_code: 1 }, before = JSON.stringify(gate);
  const miss = completeShadow(pick, gate, [f.repo]);
  assert.equal(miss.miss, true); assert.deepEqual(miss.outside_pick, ['other.test.mjs']); assert.equal(miss.unattributed, false);
  assert.equal(completeShadow({ ...pick, pick: ['other.test.mjs'] }, gate, [f.repo]).miss, false);
  assert.equal(completeShadow({ ...pick, pick: 'full' }, gate, [f.repo]).miss, false);
  assert.equal(JSON.stringify(gate), before);
  fs.writeFileSync(log, 'preparation or runner failed without a test identity');
  assert.equal(completeShadow(pick, gate).miss, true); assert.equal(completeShadow(pick, gate).unattributed, true);
  assert.equal(completeShadow(pick, { ...gate, exit_code: 0 }).miss, false);
  fs.unlinkSync(log); assert.equal(completeShadow(pick, gate).miss, true);
  assert.deepEqual(failingTestFiles('not ok 1 - test/direct.test.mjs\nnot ok 2 - unknown\n'), { failing_files: ['test/direct.test.mjs'], unattributed: true });
  assert.deepEqual(failingTestFiles('testTimeoutFailure: Test file exceeded 10ms. File: test/red.test.mjs\n'), { failing_files: ['test/red.test.mjs'], unattributed: false });
});

for (const red of [false, true]) test(`a ${red ? 'red' : 'green'} train has byte-identical gate command, log and outcome with and without shadow selection`, t => {
  const observations = [];
  for (const enabled of [false, true]) {
    const f = fixture(t);
    adapter(f, 'throw Error("unavailable selector must not affect the gate");');
    const command = red ? "printf 'not ok 1 - other.test.mjs\\n'; exit 7" : "printf 'gate output\\n'";
    f.write('.lane.validation.json', JSON.stringify({ promotion: command }));
    const base = f.commit('Base');
    const lane = path.join(f.root, 'lane'); f.git(['worktree', 'add', '-qb', 'lane/topic', lane]);
    f.write('leaf.mjs', 'export const value = 2;', lane); f.git(['add', '.'], lane); f.git(['commit', '-qm', 'Module change'], lane);
    const head = f.git(['rev-parse', 'HEAD'], lane), identity = fs.realpathSync(path.join(f.repo, '.git'));
    const receipt = path.join(identity, 'promote/batches/example/train.json');
    f.write(path.relative(f.repo, receipt), JSON.stringify({ schema: 'promotion-train/v1', id: 'example', identity,
      jobs: [{ id: 'one', topic: 'topic', expectedHead: head }], phase: 'pending' }));
    // Keep the same tree and gate inputs; only the observer is enabled/disabled.
    // A product copy with the selector entry point returning null supplies the
    // no-selector control without modifying validation or its environment.
    let product = source;
    if (!enabled) {
      product = path.join(f.root, 'product');
      copyProduct(source, product);
      const entry = path.join(product, 'promote/selector.mjs');
      fs.writeFileSync(entry, 'export const shadowSelection=()=>null; export const completeShadow=()=>null;');
    }
    const r = f.exec(process.execPath, [path.join(product, 'lanes/lane.mjs'), 'promote-batch', receipt]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const plan = JSON.parse(fs.readFileSync(receipt)), attempt = plan.attempts[0];
    assert.ok(attempt.gate, JSON.stringify(plan));
    assert.equal(attempt.gate.command, command); assert.equal(attempt.gate.exit_code, red ? 7 : 0);
    assert.equal(plan.results.one.outcome, red ? 'refused' : 'promoted');
    assert.equal(f.git(['rev-parse', 'main']), red ? base : head);
    observations.push({ command: attempt.gate.command, exit: attempt.gate.exit_code, signal: attempt.gate.signal,
      outcome: plan.results.one.outcome, log: fs.readFileSync(attempt.gate.log, 'utf8') });
    if (enabled) { assert.equal(attempt.selector_shadow.pick, 'full'); assert.ok(attempt.selector_shadow.error); assert.equal(attempt.selector_shadow.miss, false); }
    else assert.equal(attempt.selector_shadow, null);
  }
  assert.deepEqual(observations[0], observations[1]);
});

test('the summary command reads completed, missed, pending and historical observations across batches', t => {
  const f = fixture(t); f.commit('Base');
  const identity = fs.realpathSync(path.join(f.repo, '.git'));
  const shadow = { schema: 'promotion-selector-shadow/v1', pick: ['direct.test.mjs'], reason: 'fixture', miss: false };
  const write = (batch, attempts) => f.write(`.git/promote/batches/${batch}/train.json`, JSON.stringify({ schema: 'promotion-train/v1', identity, attempts }));
  write('one', [{ selector_shadow_history: [{ ...shadow, miss: null }], selector_shadow: shadow }]);
  write('two', [{ selector_shadow: { ...shadow, miss: true } }, { selector_shadow: { ...shadow, pick: 'full' } }]);
  f.write('.git/promote/batches/bad/train.json', '{');
  const before = f.git(['status', '--porcelain']), result = collectShadow({ project: f.repo });
  assert.deepEqual(result.summary, { observations: 4, completed: 3, misses: 1, pending: 1, full: 1, subsets: 3, errors: 0 });
  assert.equal(result.warnings.length, 1); assert.match(renderShadow(result), /1 misses; 1 pending/);
  const cli = f.exec(process.execPath, [path.join(source, 'promote/shadow.mjs'), '--project', f.repo, '--json']);
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), result);
  assert.equal(f.git(['status', '--porcelain']), before);
});
