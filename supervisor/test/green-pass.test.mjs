import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { gitProject } from '../../lib/project.mjs';
import { createGreenCohort, LIFECYCLE_CASES } from '../green-pass.mjs';
import { sourceReach, executionClosure, staticImportClosure } from '../green-reach.mjs';
import { autopilotNotice, autopilotSettings } from '../autopilot.mjs';
import { receiptDirectory } from '../context.mjs';
import { fixture as settleFixture } from '../../settle/test/fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const contracts = fs.readFileSync(new URL('../green-contracts.json', import.meta.url), 'utf8');
function setup(t, { entry = "import '../lib/a.mjs';\n", extra = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-pass-')));
  fixtureFleet(t, root); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'brain'), lab = path.join(root, 'lab'), workspace = path.join(root, 'lane');
  const put = (file, value, dir = repo) => { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
  const git = (args, dir = repo) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message); return r.stdout.trim();
  };
  for (const dir of [repo, lab]) {
    fs.mkdirSync(dir); git(['init', '-qb', 'main'], dir);
    git(['config', 'user.name', 'Offline fixture'], dir); git(['config', 'user.email', 'fixture@example.invalid'], dir);
    fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.org/\n.supervisor.json\n');
    put('.org/events.jsonl', '', dir); put('README.md', 'Fixture\n', dir);
  }
  put('supervisor/green-contracts.json', contracts);
  put('supervisor/reconcile.mjs', entry);
  put('lib/a.mjs', 'export const shared = 1;\n');
  put('sessions/retirement-policy.mjs', 'export const retirementDelay = 1;\n');
  for (const [file, value] of Object.entries(extra)) put(file, value);
  git(['add', '.']); git(['commit', '-qm', 'Seed source']);
  git(['add', '.'], lab); git(['commit', '-qm', 'Seed lab'], lab);
  git(['worktree', 'add', '-qb', 'lane/change', workspace]);
  const pair = dir => ({ repo: dir, identity: gitProject(dir).identity, org: path.join(dir, '.org') });
  const bindings = { brain: pair(repo), lab: pair(lab) }, base = git(['rev-parse', 'HEAD']);
  const checker = createGreenCohort(repo), reportRoot = path.join(repo, '.org/runs/R-1'); fs.mkdirSync(reportRoot, { recursive: true });
  const change = (file = 'sessions/retirement-policy.mjs', bytes = 'export const retirementDelay = 2;\n') => {
    put(file, bytes, workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace); return git(['rev-parse', 'HEAD'], workspace);
  };
  const options = () => ({ repo, org: bindings.brain.org, identity: bindings.brain.identity, workspace, base,
    head: git(['rev-parse', 'HEAD'], workspace), run: 'R-1', reportRoot, bindings });
  const evidence = (overrides = {}) => {
    const opts = options(), envelope = { version: 1, run: opts.run, base, head: opts.head, identity: opts.identity, org: opts.org, controls: {}, ...overrides };
    const artifact = (file, bytes) => { fs.writeFileSync(path.join(reportRoot, file), bytes); return { file, sha256: digest(bytes) }; };
    for (const [control, cases] of Object.entries(LIFECYCLE_CASES)) {
      const log = artifact(`${control}.tap`, 'TAP version 13\n' + cases.map((name, i) => `ok ${i + 1} - ${name}\n`).join('') + `1..${cases.length}\n# fail 0\n`);
      envelope.controls[control] = artifact(`${control}.json`, JSON.stringify({ ...envelope, controls: undefined, schema: 'green-control/v1', control,
        exit_code: 0, command: ['node', '--test', 'focused-controls.test.mjs'], log }));
    }
    return { extra: { green_lifecycle: envelope } };
  };
  return { root, repo, lab, workspace, reportRoot, put, git, change, options, evidence, checker,
    scope: (extra = {}) => checker.scope({ ...options(), ...extra }) };
}

test('a real lifecycle module outside the cross-project closure is eligible with bound control evidence', t => {
  const f = setup(t); f.change();
  const result = f.scope({ report: f.evidence() });
  assert.equal(result.eligible, true, JSON.stringify(result)); assert.equal(result.area, 'green-lifecycle');
  assert.deepEqual(result.reach.base.paths, ['lib/a.mjs', 'supervisor/reconcile.mjs']);
  assert.deepEqual(Object.keys(result.lifecycle.controls), Object.keys(LIFECYCLE_CASES));
});
for (const operation of ['modify', 'delete', 'rename']) test(`the base/candidate union refuses a consumed module ${operation}`, t => {
  const f = setup(t);
  if (operation === 'modify') f.change('lib/a.mjs', 'export const shared = 2;\n');
  else {
    f.git(operation === 'delete' ? ['rm', 'lib/a.mjs'] : ['mv', 'lib/a.mjs', 'lib/innocent.mjs'], f.workspace);
    f.git(['commit', '-qm', operation], f.workspace);
  }
  const result = f.scope(); assert.equal(result.code, 'GREEN_BCH_CONSUMED'); assert.match(result.reason, /lib\/a.mjs/);
});
test('a module reached only by a spawned entry is refused transitively', t => {
  const f = setup(t, { entry: "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['./worker.mjs']);\n",
    extra: { 'supervisor/worker.mjs': "import '../lib/spawned.mjs';\n", 'lib/spawned.mjs': 'export const value = 1;\n' } });
  f.change('lib/spawned.mjs', 'export const value = 2;\n');
  assert.equal(f.scope().code, 'GREEN_BCH_CONSUMED');
});
test('a literal fork target contributes its complete execution closure', t => {
  const f = setup(t, { entry: "import { fork } from 'node:child_process';\nfork('./worker.mjs');\n",
    extra: { 'supervisor/worker.mjs': "import '../lib/forked.mjs';\n", 'lib/forked.mjs': 'export const value = 1;\n' } });
  f.change('lib/forked.mjs', 'export const value = 2;\n'); assert.equal(f.scope().code, 'GREEN_BCH_CONSUMED');
});
for (const imported of ['fork', 'fork as launch']) test(`a computed ${imported} target refuses an unrelated candidate`, t => {
  const name = imported.includes(' as ') ? 'launch' : 'fork';
  const f = setup(t, { entry: `import { ${imported} } from 'node:child_process';\n${name}(computedPath);\n` });
  f.change(); assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_REACH_UNKNOWN');
});
for (const helper of [
  "export { spawnSync as run } from 'node:child_process';\n",
  "export { spawnSync } from 'node:child_process';\n",
  "export * from 'node:child_process';\n",
  "export { ChildProcess as run } from 'node:child_process';\n",
  "import { spawnSync as launch } from 'node:child_process'; export { launch as run };\n",
  "export { launch as run }; import { spawnSync as launch } from 'node:child_process';\n",
  "import { spawnSync as launch } from 'node:child_process'; export default launch;\n",
]) test(`launcher re-exports refuse computed calls through a relative helper: ${helper.trim()}`, t => {
  const entry = helper.includes('export default') ? "import run from '../lib/launch.mjs';\n" : helper.includes(' as run') ? "import { run } from '../lib/launch.mjs';\n" : "import { spawnSync as run } from '../lib/launch.mjs';\n";
  const f = setup(t, { entry: entry + 'run(process.execPath, [computedScript]);\n', extra: { 'lib/launch.mjs': helper } });
  f.change(); const result = f.scope({ report: f.evidence() });
  assert.equal(result.code, 'GREEN_REACH_UNKNOWN');
  assert.ok(result.reach.base.unknown.some(e => e.file === 'lib/launch.mjs' && /re-export/.test(e.reason)));
});
test('a regex after a closing brace cannot hide a dynamic import from admission', t => {
  const f = setup(t, { entry: "if (x) {} /'/.test(s); import(spec); // '\n" });
  f.change(); const result = f.scope({ report: f.evidence() });
  assert.equal(result.code, 'GREEN_REACH_UNKNOWN');
  assert.ok(result.reach.base.unknown.some(e => /regex\/division/.test(e.reason)));
});
test('a computed native-addon load refuses an unrelated candidate', t => {
  const f = setup(t, { entry: 'process.dlopen(module, computedAddon);\n' });
  f.change(); assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_REACH_UNKNOWN');
});
test('a closed dispatch table includes every lazy command, not only the invoked command', t => {
  const f = setup(t, { entry: "const lazy = (file, name) => async (argv) => (await import(file))[name](argv);\nconst COMMANDS = { one: lazy('../lib/a.mjs', 'one'), two: lazy('../lib/b.mjs', 'two') };\nif (Object.hasOwn(COMMANDS, command)) COMMANDS[command](argv);\n",
    extra: { 'lib/b.mjs': 'export const two = 1;\n' } });
  f.change('lib/b.mjs', 'export const two = 2;\n'); assert.equal(f.scope().code, 'GREEN_BCH_CONSUMED');
  const files = new Map(['supervisor/reconcile.mjs', 'lib/a.mjs', 'lib/b.mjs'].map(file => [file, {}]));
  assert.deepEqual(sourceReach('supervisor/reconcile.mjs', fs.readFileSync(path.join(f.repo, 'supervisor/reconcile.mjs'), 'utf8'), files).unknown, []);
});
for (const entry of [
  'export const load = name => import(name);\n',
  "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [process.env.SCRIPT]);\n",
  "import { execSync } from 'node:child_process';\nexecSync('node ./worker.mjs');\n",
  "import { spawnSync } from 'node:child_process';\nconst command = spawnSync;\n",
  "const lazy = file => import(file);\nconst alias = lazy;\n",
]) test(`unknown execution reach refuses an unrelated candidate: ${entry.split('\n')[0]}`, t => {
  const f = setup(t, { entry }); f.change(); const result = f.scope({ report: f.evidence() });
  assert.equal(result.code, 'GREEN_REACH_UNKNOWN'); assert.ok(result.reach.base.unknown.length);
});
test('a new unknown load in the affected green path also uses the ordinary route', t => {
  const f = setup(t); f.change('sessions/retirement-policy.mjs', 'export const load = name => import(name);\n');
  assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_REACH_UNKNOWN');
});
test('removing an unknown load cannot erase the base tree execution uncertainty', t => {
  const f = setup(t, { extra: { 'sessions/retirement-policy.mjs': 'export const load = name => import(name);\n' } });
  f.change(); assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_REACH_UNKNOWN');
});
for (const [file, code] of [
  ['supervisor/green-contracts.json', 'GREEN_SELF_AUTHORITY'], ['supervisor/green-pass.mjs', 'GREEN_SELF_AUTHORITY'],
  ['supervisor/green-reach.mjs', 'GREEN_SELF_AUTHORITY'], ['supervisor/autopilot.mjs', 'GREEN_SELF_AUTHORITY'],
  ['housekeeping/config.mjs', 'GREEN_SELF_AUTHORITY'], ['dispatch/metrics.mjs', 'GREEN_SELF_AUTHORITY'],
  ['test-slot/ticket-queue.mjs', 'GREEN_SELF_AUTHORITY'], ['messages/receiver.mjs', 'GREEN_SELF_AUTHORITY'],
  ['.housekeeping.json', 'GREEN_SELF_AUTHORITY'],
  ['blue/hotfix.mjs', 'GREEN_BLUE_HOTFIX'], ['discovery/native-sandbox.mjs', 'GREEN_NATIVE_ISOLATION'],
  ['test-slot/shared-admission.mjs', 'GREEN_HOST_RESOURCE'], ['sessions/authorization.mjs', 'GREEN_CROSS_PROJECT_AUTHORITY'],
  ['herdr/release.sh', 'GREEN_GLOBAL_RELEASE'], ['watch/notice.mjs', 'GREEN_SHARED_RUNTIME'],
]) test(`declared contract ${file} refuses with ${code}`, t => {
  const f = setup(t); f.change(file, '// Changed contract\n'); assert.equal(f.scope().code, code);
});
test('blue operation metadata refuses a change outside a blue-named path', t => {
  const f = setup(t); f.change(); assert.equal(f.scope({ item: { meta: { release_channel: 'blue' } } }).code, 'GREEN_BLUE_HOTFIX');
});
for (const file of ['docs/evidence/new.txt', 'docs/evidence/results.tap', 'docs/evidence/run.json']) test(`text evidence is eligible without lifecycle checks or tests: ${file}`, t => {
  const f = setup(t); f.change(file, file.endsWith('.json') ? '{"observed":true}\n' : 'Captured evidence\n');
  const result = f.scope(); assert.equal(result.eligible, true, JSON.stringify(result)); assert.equal(result.area, 'evidence-only'); assert.equal(result.lifecycle, undefined);
});
for (const [file, bytes] of [['docs/evidence/binary.txt', Buffer.from([0, 255, 1])], ['docs/evidence/image.png', 'ASCII disguised as an image'], ['docs/evidence/program.mjs', 'export const x = 1;']]) test(`binary or executable evidence stays ordinary: ${file}`, t => {
  const f = setup(t); f.change(file, bytes); assert.equal(f.scope().code, 'GREEN_BINARY_EVIDENCE');
});
test('an executable-mode evidence change is refused before treating it as text', t => {
  const f = setup(t); f.change('docs/evidence/script.txt', 'captured\n');
  fs.chmodSync(path.join(f.workspace, 'docs/evidence/script.txt'), 0o755); f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Executable evidence'], f.workspace);
  assert.equal(f.scope().code, 'GREEN_NATIVE_ISOLATION');
});
for (const change of ['record', 'identity', 'foreign', 'source', 'workspace']) test(`canonical admission refuses ${change} mismatch`, t => {
  const f = setup(t); f.change(); const options = f.options(), bindings = structuredClone(options.bindings);
  if (change === 'record') bindings.brain.org = bindings.lab.org;
  if (change === 'identity') bindings.brain.identity = bindings.lab.identity;
  if (change === 'foreign') options.repo = f.lab;
  if (change === 'source') [bindings.brain, bindings.lab] = [bindings.lab, bindings.brain];
  if (change === 'workspace') options.workspace = f.lab;
  assert.equal(f.checker.scope({ ...options, bindings }).code, 'GREEN_IDENTITY_MISMATCH');
});
test('lab admission uses its own canonical identity and discovered record', t => {
  const f = setup(t), base = f.git(['rev-parse', 'HEAD'], f.lab);
  f.put('docs/evidence/lab.txt', 'lab evidence\n', f.lab); f.git(['add', '.'], f.lab); f.git(['commit', '-qm', 'Lab evidence'], f.lab);
  const result = f.scope({ ...f.options().bindings.lab, workspace: f.lab, base, head: f.git(['rev-parse', 'HEAD'], f.lab) });
  assert.equal(result.eligible, true, JSON.stringify(result)); assert.equal(result.binding.kind, 'lab');
});
test('a lane-local record mismatch is kept even when its Git identity is correct', t => {
  const f = setup(t); f.change(); f.put('.org/events.jsonl', '', f.workspace);
  assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_IDENTITY_MISMATCH');
});
for (const kind of ['missing', 'stale-head', 'stale-base', 'stale-run', 'digest', 'failed', 'missing-control', 'symlink']) test(`lifecycle evidence refuses ${kind}`, t => {
  const f = setup(t); f.change();
  const report = kind === 'missing' ? undefined : f.evidence(kind === 'stale-head' ? { head: f.options().base } : kind === 'stale-base' ? { base: '0'.repeat(40) } : kind === 'stale-run' ? { run: 'R-9' } : {});
  const controls = report?.extra.green_lifecycle.controls;
  if (kind === 'digest') fs.appendFileSync(path.join(f.reportRoot, controls.hold.file), ' ');
  if (kind === 'missing-control') delete controls.hold;
  if (kind === 'symlink') {
    fs.renameSync(path.join(f.reportRoot, controls.hold.file), path.join(f.reportRoot, 'real.json'));
    fs.symlinkSync('real.json', path.join(f.reportRoot, controls.hold.file));
  }
  if (kind === 'failed') {
    const p = path.join(f.reportRoot, 'hold.tap'); fs.appendFileSync(p, 'not ok 2 - late-hold\n');
    const check = JSON.parse(fs.readFileSync(path.join(f.reportRoot, controls.hold.file)));
    check.log.sha256 = digest(fs.readFileSync(p)); const bytes = JSON.stringify(check);
    fs.writeFileSync(path.join(f.reportRoot, controls.hold.file), bytes); controls.hold.sha256 = digest(bytes);
  }
  assert.equal(f.scope({ report }).code, 'GREEN_LIFECYCLE_EVIDENCE');
});
test('settle may append exactly its hashed review after lifecycle evidence capture', t => {
  const f = setup(t); f.change(); const report = f.evidence();
  const bytes = '## Findings\nNone\n'; const review = { path: path.join(f.workspace, 'docs/reviews/independent.md'), sha256: digest(bytes) };
  f.change('docs/reviews/independent.md', bytes);
  assert.equal(f.scope({ report, review }).eligible, true);
  f.change('sessions/retirement-policy.mjs', 'export const retirementDelay = 3;\n');
  assert.equal(f.scope({ report, review }).code, 'GREEN_LIFECYCLE_EVIDENCE');
});
test('dirty candidates and untracked reach inputs are refused', t => {
  const f = setup(t); f.change(); f.put('extra.mjs', 'export {};\n', f.workspace);
  assert.equal(f.scope({ report: f.evidence() }).code, 'GREEN_REACH_UNKNOWN');
});

test('the live autopilot accepts declared lab evidence and retains clean PASS promotion checks', t => {
  const brain = setup(t), f = settleFixture(t), lab = gitProject(f.repo);
  fs.writeFileSync(path.join(f.repo, 'work.txt'), 'correct\n'); f.git(['add', 'work.txt']); f.git(['commit', '-qm', 'Seed review claim']); f.git(['rebase', 'main'], f.workspace);
  fs.mkdirSync(path.join(f.workspace, 'docs/evidence'), { recursive: true }); fs.writeFileSync(path.join(f.workspace, 'docs/evidence/lab.txt'), 'captured\n');
  f.git(['add', 'docs/evidence/lab.txt'], f.workspace); f.git(['commit', '-qm', 'Lab evidence'], f.workspace);
  assert.equal(f.git(['ls-files', '.org'], f.workspace), '', 'fixture records must not become candidate inputs');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.supervisor.json\n');
  const green = { brain: brain.options().bindings.brain, lab: { repo: f.repo, identity: lab.identity, org: f.org } };
  fs.writeFileSync(path.join(f.repo, '.supervisor.json'), JSON.stringify({ autopilot: { enabled: true, cohort: 'green-pass', green } }));
  assert.equal(autopilotSettings(f.repo).cohort, 'green-pass');
  const run = f.start(); f.report(run); f.record(['ingest', f.show(run).report_path]);
  const config = JSON.parse(fs.readFileSync(path.join(f.org, 'config.json'))); config.approvals.categories.tooling = 'auto'; fs.writeFileSync(path.join(f.org, 'config.json'), JSON.stringify(config));
  const entry = { id: 'green-report', to: 'supervisor-test', project: { repo: f.repo, org: f.org, identity: lab.identity },
    message: `[org-report] run=${run} item=${f.show(run).item} outcome=done headline=Captured` };
  const calls = [];
  const execute = (_file, args) => {
    calls.push(args);
    if (args[0] === 'promote') return JSON.stringify({ phase: 'acknowledged' });
    const head = f.git(['rev-parse', 'HEAD'], f.workspace), text = '## Findings\nNone\n\n## Analysis\nIndependent PASS.\n';
    const review = { verdict: 'PASS', text, sha256: digest(text), path: path.join(f.workspace, 'docs/reviews/green.md') };
    const result = { result: 'promotable', run, head, reviewed_commit: head, review };
    fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
    fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ common: lab.identity, org: f.org, run, stage: 'complete', head, finalHead: head,
      mainHead: f.git(['rev-parse', 'main']), review, result }));
    return JSON.stringify(result);
  };
  const result = autopilotNotice(entry, { execute, nativeWorker: () => ({ pid: 1 }), green: brain.checker });
  assert.equal(result.disposition, 'handled', fs.readFileSync(result.receipt, 'utf8'));
  assert.deepEqual(calls.map(a => a[0]), ['handle', 'promote']); assert.ok(calls[1].includes('--existing-worker'));
  const saved = JSON.parse(fs.readFileSync(result.receipt)); assert.equal(saved.scope.area, 'evidence-only');
  assert.ok(result.receipt.startsWith(receiptDirectory(f.org, lab.identity)));
});

test('source scanning never executes a candidate and handles comments, regexes and template loads', () => {
  const files = new Map([['lib/a.mjs', {}]]);
  const result = sourceReach('entry.mjs', "// import('./absent.mjs')\nconst pattern = /import\\('fake'\\)/;\nconst text = `${import('./lib/a.mjs')}`;\nthrow Error('candidate must never run');\n", files);
  assert.deepEqual(result.dependencies, ['lib/a.mjs']); assert.deepEqual(result.unknown, []);
});
test('constant shadowing cannot resolve an unknown dynamic import to the outer constant', () => {
  const result = sourceReach('entry.mjs', "const file = './lib/a.mjs';\nfunction load(file) { return import(file); }\n", new Map([['lib/a.mjs', {}]]));
  assert.ok(result.unknown.some(e => /dynamic import/.test(e.reason)));
});
test('a referenced non-JavaScript launcher is retained as unknown rather than dropped', () => {
  const files = new Map([['launch.sh', { mode: '100644' }]]);
  assert.equal(executionClosure({ files, read: () => 'node computed-script' }, ['launch.sh']).unknown.length, 1);
});
test('escaped imports and literal URL spawns resolve without executing either target', () => {
  const files = new Map([['lib/a.mjs', {}], ['worker.mjs', {}]]);
  const source = "import './lib/\\u0061.mjs';\nconst delimiter = '\\0';\nimport { spawnSync as launch } from 'node:child_process';\nconst entry = fileURLToPath(new URL('./worker.mjs', import.meta.url));\nlaunch(process.execPath, [entry], {env: {...process.env}});\n";
  const result = sourceReach('entry.mjs', source, files);
  assert.deepEqual(result.dependencies, ['lib/a.mjs', 'worker.mjs']); assert.deepEqual(result.unknown, []);
});
for (const prefix of ['{', 'typeof', 'else', 'do', 'in', 'of', 'await', 'yield', 'void', 'delete', 'new', 'return', 'case', 'throw',
  '=', '===', '!==', '==', '!=', '+', '-', '*', '**', '/', '%', '&', '|', '^', '&&', '||', '??', '<', '>', '<=', '>=', '<<', '>>', '>>>', 'instanceof']) {
  test(`regex prefix ${prefix} keeps a following loader visible or unknown`, () => {
    const frames = {
      '{': "{ /'/.test(s); import(spec); // '\n}\n",
      else: "if (x) {} else /'/.test(s); import(spec); // '\n",
      do: "do /'/.test(s); while (false); import(spec); // '\n",
      of: "for (const x of /'/.test(s)) {} import(spec); // '\n",
      yield: "function* g() { yield /'/.test(s); import(spec); // '\n}\n",
      return: "function g() { return /'/.test(s); import(spec); // '\n}\n",
      case: "switch (x) { case /'/.test(s): break; } import(spec); // '\n",
    };
    const unary = ['typeof', 'await', 'void', 'delete', 'new', 'throw'].includes(prefix);
    const source = frames[prefix] ?? `${unary ? prefix : `const result = value ${prefix}`} /'/.test(s); import(spec); // '\n`;
    const result = sourceReach('entry.mjs', source, new Map());
    assert.ok(result.unknown.some(e => /dynamic import|regex\/division/.test(e.reason)), JSON.stringify(result));
  });
}
test('a regex after a closing parenthesis cannot hide a loader in a fake string', () => {
  const result = sourceReach('entry.mjs', "if (x) /'/.test(s); import(spec); // '\n", new Map());
  assert.ok(result.unknown.some(e => /regex\/division/.test(e.reason)));
});
test('unambiguous division and equivalent numeric slash readings retain static imports', () => {
  for (const code of ['const ratio = (12) / 2;\n', 'const ratio = (12) / 2 / 3;\n']) {
    const result = sourceReach('entry.mjs', code + "import './lib/a.mjs';\n", new Map([['lib/a.mjs', {}]]));
    assert.deepEqual(result.unknown, []); assert.deepEqual(result.dependencies, ['lib/a.mjs']);
  }
});
test('fork overloads resolve literal argv/options and refuse unresolved executable options', () => {
  const header = "import { fork } from 'node:child_process';\n", files = new Map([['worker.mjs', {}]]);
  for (const source of [
    "fork('./worker.mjs');", "fork('./worker.mjs', []);", "fork('./worker.mjs', {silent: true});",
    "fork('./worker.mjs', [], {silent: true});", "const argv = []; fork('./worker.mjs', argv);",
  ]) {
    const reach = sourceReach('entry.mjs', header + source, files);
    assert.deepEqual(reach.unknown, [], source); assert.deepEqual(reach.dependencies, ['worker.mjs']);
  }
  for (const source of [
    "fork('./worker.mjs', computedOptions);", "fork('./worker.mjs', {execPath: injected});",
    "fork('./worker.mjs', [], {execArgv: injected});",
    "const options = {execPath: injected}; fork('./worker.mjs', options);",
    "const options = {silent: true}; options.execPath = injected; fork('./worker.mjs', options);",
  ]) assert.ok(sourceReach('entry.mjs', header + source, files).unknown.length, source);
});
test('static authority imports derive transitive helpers again after the source graph changes', () => {
  const files = new Map([
    ['authority.mjs', "import './gate.mjs'; export * from './metrics.mjs';\n"],
    ['gate.mjs', "import fs from 'node:fs'; export const enabled = true;\n"],
    ['metrics.mjs', "import './clock.mjs';\n"], ['clock.mjs', 'export const now = 1;\n'],
  ]);
  const tree = { read(file) { assert.ok(files.has(file), file); return files.get(file); } };
  const first = staticImportClosure(tree, ['authority.mjs']);
  assert.deepEqual(first.unknown, []); assert.deepEqual(first.paths, ['authority.mjs', 'clock.mjs', 'gate.mjs', 'metrics.mjs']);
  files.set('gate.mjs', "import './new-helper.mjs';\n"); files.set('new-helper.mjs', 'export const enabled = false;\n');
  assert.ok(staticImportClosure(tree, ['authority.mjs']).paths.includes('new-helper.mjs'));
  files.delete('new-helper.mjs'); assert.ok(staticImportClosure(tree, ['authority.mjs']).unknown.length);
});
for (const source of [
  "import('node:child_process').then(cp => cp.spawnSync('node', ['missing']));",
  "import cp from 'node:child_process'; cp['spawn' + 'Sync'](program, argv);",
  "const loader = (() => {})['constructor']; loader(text)();",
  "const operations = [load]; operations[index]();",
  "const target = './lib/a.mjs'; function launch(target) { return import(target); }",
  "const COMMANDS = { run: fn }; const alias = COMMANDS; COMMANDS[key]();",
  "const COMMANDS = { run: fn }; COMMANDS[other] = unknown; COMMANDS[key]();",
  "import {spawnSync} from 'node:child_process'; spawnSync('node', ['./worker.mjs'], {...options});",
  "import {spawnSync} from 'node:child_process'; spawnSync('node', ['./worker.mjs'], {['sh'+'ell']: true});",
  "process.dlopen(module, addonPath);",
  "import {fork} from 'node:child_process'; fork(computedPath);",
  "import {fork} from 'node:child_process'; fork('./worker.mjs', [], {execArgv: injected});",
  "import {fork} from 'node:child_process'; fork('git');",
]) test(`unsupported indirect execution fails closed: ${source.slice(0, 50)}`, () => {
  assert.ok(sourceReach('entry.mjs', source, new Map([['lib/a.mjs', {}]])).unknown.length);
});
