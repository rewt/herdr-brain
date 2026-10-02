import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createEntry, command, quote } from '../runtime.mjs';
import { sandboxCommand } from '../confinement.mjs';
import { checkedDirectory, validationTemporary } from '../paths.mjs';
const product = new URL('../../', import.meta.url).pathname;
const caseTest = (name, fn) => test(name, { timeout: 45000 }, (t) => {
  process.env.ORG_ACTOR = `r90-${name.replaceAll(/[^a-z0-9]/giu, '-').slice(0, 90)}`;
  return fn(t);
});
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-r90-'));
  const entries = [];
  t.after(() => { for (const entry of entries) entry.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Review regression'], repo);
  command('git', ['config', 'user.email', 'r90@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/check.test.mjs'), "import test from 'node:test';process.env.ORG_ACTOR='r90-scratch-validation';test('project gate',()=>{});\n");
  const bytes = Buffer.from([0, 255, 13, 10, 65, 66, 0, 127]);
  fs.writeFileSync(path.join(repo, 'data.bin'), bytes);
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'data.bin filter=fixture\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed'], repo);
  const sandbox = path.join(scratch, 'sandbox'), audit = path.join(scratch, 'sandbox-audit');
  // Semantic stand-in only. Real kernel denial is exercised separately through
  // MONITOR_TEST_ALTERNATIVE. No model binary or live project is invoked here.
  fs.writeFileSync(sandbox, `#!${process.execPath}\nconst fs=require('fs'),{spawnSync}=require('child_process'),a=process.argv.slice(2),i=a.indexOf('--');
if(a[0]!=='sandbox'||i<0)process.exit(99);fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify(a)+'\\n');
process.exit(require(${JSON.stringify(path.join(product, 'discovery/test/helpers/lifetime.cjs'))})(a));\n`, { mode: 0o755 });
  const provider = process.env.MONITOR_TEST_ALTERNATIVE ?? sandbox;
  return { scratch, repo, bytes, entries, audit, provider, sandbox,
    options: { cwd: repo, sandboxBinary: provider, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') } };
}
const blob = (repo) => {
  const r = spawnSync('git', ['-C', repo, 'show', 'HEAD:data.bin'], { timeout: 5000, env: process.env });
  assert.equal(r.status, 0, r.stderr.toString()); return r.stdout;
};
const runEntry = (f, settings) => {
  for (const [direction, value] of Object.entries(settings)) command('git', ['config', `filter.fixture.${direction}`, value], f.repo);
  const entry = createEntry(f.options); f.entries.push(entry); return entry;
};
const finishChange = (entry, bytes) => {
  const task = entry.dispatch({ op: 'start', text: 'Preserve filtered bytes' });
  fs.writeFileSync(path.join(task.workspace, 'data.bin'), bytes);
  fs.mkdirSync(path.dirname(task.report), { recursive: true });
  fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Filter regression\nheadline: Filter regression\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  entry.dispatch({ op: 'commit', text: 'Preserve filtered bytes' });
  entry.dispatch({ op: 'check' }); entry.dispatch({ op: 'promote' }); entry.dispatch({ op: 'finish' });
  return task;
};

for (const location of ['temporary', 'ancestor', 'dangling']) caseTest(`all providers reject ${location} writable symlink components`, (t) => {
  const f = fixture(t), record = path.join(f.scratch, 'record'); fs.mkdirSync(record);
  const temporary = path.join(f.repo, '.lane/validation-tmp');
  if (location === 'ancestor') { fs.mkdirSync(path.join(record, 'validation-tmp')); fs.symlinkSync(record, path.join(f.repo, '.lane')); }
  else { fs.mkdirSync(path.dirname(temporary)); fs.symlinkSync(location === 'dangling' ? path.join(f.scratch, 'missing') : record, temporary); }
  for (const provider of [f.sandbox, '/usr/bin/sandbox-exec', '/usr/bin/bwrap'])
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], writablePaths: [temporary] }), /writable path redirected/u);
  assert.throws(() => validationTemporary(f.repo), /writable path redirected/u);
  assert.throws(() => validationTemporary(f.repo, { create: true }));
});
caseTest('sandbox grants reject redirected workspaces, queues and external runtime paths', (t) => {
  const f = fixture(t), record = path.join(f.scratch, 'record'); fs.mkdirSync(record);
  const alias = path.join(f.scratch, 'alias'); fs.symlinkSync(record, alias);
  for (const provider of [f.sandbox, '/usr/bin/sandbox-exec', '/usr/bin/bwrap']) {
    assert.throws(() => sandboxCommand(provider, alias, { sharedPaths: [record] }), /writable path redirected/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], writablePaths: [alias], native: true }), /writable path redirected/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], runtimePaths: [alias], network: true }), /writable path redirected/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], writablePaths: [record] }), /within the assigned checkout/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], runtimePaths: [record] }), /external runtime writes/u);
  }
  assert.throws(() => checkedDirectory(alias), /writable path redirected/u);
});
caseTest('sandbox exceptions cannot override a protected record, Git tree or nested record target', (t) => {
  const f = fixture(t), record = path.join(f.repo, '.org'); fs.mkdirSync(record);
  const temporary = path.join(f.repo, '.lane/validation-tmp'); fs.mkdirSync(temporary, { recursive: true });
  const nestedRecord = path.join(temporary, 'selected-record'); fs.mkdirSync(nestedRecord);
  for (const provider of [f.sandbox, '/usr/bin/sandbox-exec', '/usr/bin/bwrap']) {
    for (const file of [record, path.join(f.repo, '.git/objects')])
      assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [record], writablePaths: [file] }), /overlaps protected state/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [nestedRecord], writablePaths: [temporary] }), /overlaps protected state/u);
  }
});
for (const target of ['record', 'git']) caseTest(`Git filter refuses a temporary symlink to ${target} before execution`, (t) => {
  const f = fixture(t), record = path.join(f.scratch, 'record'); fs.mkdirSync(record);
  const directory = target === 'record' ? record : path.join(f.repo, '.git');
  const sentinel = path.join(directory, target === 'record' ? 'events' : 'config');
  if (target === 'record') fs.writeFileSync(sentinel, 'record bytes');
  const before = fs.readFileSync(sentinel);
  fs.mkdirSync(path.join(f.repo, '.lane')); fs.symlinkSync(directory, path.join(f.repo, '.lane/validation-tmp'));
  const script = `require('fs').writeFileSync(require('path').join(process.env.TMPDIR,${JSON.stringify(path.basename(sentinel))}),'unsafe')`;
  const driver = `${quote(process.execPath)} -e ${quote(script)}`;
  const r = spawnSync(process.execPath, [path.join(product, 'discovery/git-driver.mjs'), f.provider,
    JSON.stringify([record]), Buffer.from(driver).toString('base64')], { cwd: f.repo, env: process.env, encoding: 'utf8', timeout: 5000, input: 'input bytes' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /writable path redirected/u);
  assert.deepEqual(fs.readFileSync(sentinel), before); assert.ok(!fs.existsSync(f.audit));
});

for (const settings of [{ clean: '' }, { smudge: '' }, { process: '' }, { clean: '', smudge: '', process: '' }, { process: '', clean: 'exit 17', smudge: 'exit 19' }, { clean: '', smudge: 'cat' }, { clean: 'cat', smudge: '' }])
  caseTest(`disabled ${Object.keys(settings).join('/')} filters preserve binary bytes across integration`, (t) => {
    const f = fixture(t), entry = runEntry(f, settings);
    assert.deepEqual(fs.readFileSync(path.join(entry.context().workspace, 'data.bin')), f.bytes);
    const changed = Buffer.concat([f.bytes, Buffer.from([0, 254, 10])]);
    const task = finishChange(entry, changed);
    assert.deepEqual(blob(task.workspace), changed); assert.deepEqual(blob(f.repo), changed);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, 'data.bin')), changed);
  });
for (const direction of ['clean', 'smudge']) caseTest(`${direction}-only required filters preserve the missing direction as identity`, (t) => {
  const f = fixture(t), filter = path.join(f.scratch, 'identity.cjs');
  fs.writeFileSync(filter, 'process.stdin.pipe(process.stdout);\n');
  const entry = runEntry(f, { [direction]: `${quote(process.execPath)} ${quote(filter)}` });
  assert.deepEqual(fs.readFileSync(path.join(entry.context().workspace, 'data.bin')), f.bytes);
  const changed = Buffer.concat([f.bytes, Buffer.from([253, 0, 10])]);
  const task = finishChange(entry, changed);
  assert.deepEqual(blob(task.workspace), changed); assert.deepEqual(blob(f.repo), changed);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, 'data.bin')), changed);
});
caseTest('required configured filters cannot fall back to identity after a command failure', (t) => {
  const f = fixture(t), entry = runEntry(f, { clean: 'cat' });
  entry.dispatch({ op: 'start', text: 'Failed clean must preserve the original blob' });
  fs.writeFileSync(path.join(entry.context().workspace, 'data.bin'), 'changed');
  command('git', ['config', 'filter.fixture.clean', 'exit 17'], f.repo);
  assert.throws(() => entry.dispatch({ op: 'commit', text: 'Must fail' }), /filter|failed/u);
  assert.deepEqual(blob(f.repo), f.bytes); assert.deepEqual(blob(entry.context().workspace), f.bytes);
  command('git', ['config', 'filter.fixture.clean', 'cat'], f.repo);
});
caseTest('Claude live cases stay pending without authorized authentication and never launch the native binary', (t) => {
  const f = fixture(t), native = path.join(f.scratch, 'fake-claude'), marker = path.join(f.scratch, 'native-called');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(1);\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(product, 'discovery/acceptance.mjs'), '--harness', 'claude', '--binary', native], {
    cwd: f.repo, env: process.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 1, r.stderr);
  const evidence = r.stdout.match(/^Evidence: (.+)$/mu)?.[1]; assert.ok(evidence, r.stdout);
  const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json'), 'utf8'));
  t.after(() => { fs.rmSync(summary.scratch, { recursive: true, force: true }); fs.rmSync(summary.install, { recursive: true, force: true }); });
  const cases = summary.results.filter((row) => /^(20|21) /u.test(row.name));
  assert.equal(cases.length, 2); assert.ok(cases.every((row) => row.status === 'PENDING' && /HUM-19/u.test(row.reason)));
  assert.equal(summary.results.filter((row) => row.status === 'FAIL').length, 0);
  assert.deepEqual(summary.usage, []); assert.ok(!fs.existsSync(marker));
});

caseTest('retained Claude discovery evidence marks unauthenticated cases pending on HUM-19', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(product, 'docs/reports/ENG-81-claude-discovery-evidence-20261002/summary.json'), 'utf8'));
  assert.equal(evidence.operator_question, 'HUM-19');
  const live = evidence.results.filter((row) => /^(20|21) /u.test(row.name));
  assert.equal(live.length, 2); assert.ok(live.every((row) => row.status === 'PENDING'));
  assert.ok(live.every((row) => row.historical_status === 'FAIL' && /HUM-19/u.test(row.reason)));
});
