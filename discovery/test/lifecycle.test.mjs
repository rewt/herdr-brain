import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createEntry, command } from '../runtime.mjs';

const product = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-lifecycle-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'unrelated'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Lifecycle test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Unrelated project\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed project'], repo);
  return { scratch, repo, options: { cwd: repo, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') } };
}
async function waitUntil(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function childProcess(t, binary, args, options) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stderr = '';
  child.stderr.on('data', (part) => { stderr += part; });
  child.stdout.resume();
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, ended };
}
function startOwner(t, f, reason = 'empty', nativePid) {
  const receipt = path.join(f.scratch, `${reason}.json`);
  const source = `import fs from 'node:fs'; import {createEntry,command} from ${JSON.stringify(path.join(product, 'discovery/runtime.mjs'))};
const entry=createEntry(${JSON.stringify(f.options)}),context=entry.context(),reason=${JSON.stringify(reason)};
if(reason==='child')entry.attachChild(${JSON.stringify(nativePid)});
if(reason==='ignored')fs.writeFileSync(context.workspace+'/.env','retain ignored configuration');
if(reason==='untracked')fs.writeFileSync(context.workspace+'/notes.txt','retain notes');
if(reason==='modified')fs.appendFileSync(context.workspace+'/README.md','retain edit');
if(reason==='filter'){
 fs.writeFileSync(context.workspace+'/.gitattributes','README.md filter=unsafe\\n');
 fs.appendFileSync(context.workspace+'/README.md','retain edit');
}
if(reason==='committed'||reason==='integrated'){
 fs.writeFileSync(context.workspace+'/work.txt','retain commit');command('git',['add','.'],context.workspace);command('git',['commit','-qm','Keep work'],context.workspace);
}
if(reason==='run')entry.dispatch({op:'start',text:'Keep started work'});
const gitDir=command('git',['rev-parse','--path-format=absolute','--git-dir'],context.workspace);
fs.writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify({...context,metadata:gitDir+'/monitor-entry/'+context.requests.split('/').at(-1)}));fs.renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});
setInterval(()=>{},1000);`;
  return { ...childProcess(t, process.execPath, ['--input-type=module', '-e', source], { cwd: f.repo }), receipt };
}

test('close preserves ignored .env and .lane files and explains retention', (t) => {
  const f = fixture(t);
  for (const name of ['.env', '.lane/note']) {
    const entry = createEntry(f.options), context = entry.context(), target = path.join(context.workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'operator work');
    assert.equal(command('git', ['status', '--porcelain', '--untracked-files=all'], context.workspace), '');
    const messages = [], original = console.error;
    console.error = (message) => messages.push(message);
    try { entry.close(); } finally { console.error = original; }
    assert.equal(fs.readFileSync(target, 'utf8'), 'operator work');
    assert.ok(command('git', ['branch', '--list', context.branch], f.repo));
    assert.match(messages.join('\n'), /keeping .*modified, untracked or ignored files/u);
  }
});

for (const kind of ['codex', 'claude']) test(`${kind} entry forwards terminal hangup and cleans its untouched lane`, { timeout: 15000 }, async (t) => {
  const f = fixture(t), native = path.join(f.scratch, 'native'), receipt = path.join(f.scratch, 'native.json'), hup = path.join(f.scratch, 'hangup');
  fs.writeFileSync(native, `#!${process.execPath}\nconst fs=require('fs');
process.on('SIGHUP',()=>{fs.writeFileSync(process.env.TEST_HUP,'forwarded');process.exit(0)});
fs.writeFileSync(process.env.TEST_RECEIPT,JSON.stringify({cwd:process.cwd(),requests:process.env.MONITOR_REQUEST_DIR,pid:process.pid}));
setInterval(()=>{},1000);`, { mode: 0o755 });
  const { child, ended } = childProcess(t, process.execPath, [path.join(product, `discovery/adapters/${kind}.mjs`), '--repo', f.repo, '--binary', native, '--'], {
    cwd: f.repo, env: { ...process.env, ORG_ACTOR: 'lifecycle-test-agent', TEST_HUP: hup, TEST_RECEIPT: receipt, MONITOR_RUNTIME_DIR: f.options.runtimeDir, MONITOR_WORKTREE_ROOT: f.options.worktreeRoot },
  });
  await waitUntil(() => fs.existsSync(receipt), `${kind} native launch`);
  const context = JSON.parse(fs.readFileSync(receipt));
  const branch = command('git', ['branch', '--show-current'], context.cwd);
  const gitDir = command('git', ['rev-parse', '--path-format=absolute', '--git-dir'], context.cwd);
  const metadata = path.join(gitDir, 'monitor-entry', path.basename(context.requests));
  child.kill('SIGHUP');
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, `${kind} hangup exit`);
  const result = await ended; assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(hup, 'utf8'), 'forwarded');
  assert.ok(!fs.existsSync(context.cwd)); assert.ok(!fs.existsSync(context.requests)); assert.ok(!fs.existsSync(metadata));
  assert.equal(command('git', ['branch', '--list', branch], f.repo), '');
});

test('next entry sweeps killed untouched owners and preserves every form of work', { timeout: 30000 }, async (t) => {
  for (const reason of ['empty', 'ignored', 'untracked', 'modified', 'committed', 'integrated', 'run', 'unreceipted', 'filter']) {
    const f = fixture(t);
    if (reason === 'filter') command('git', ['config', 'filter.unsafe.clean', `touch ${f.scratch}/filter-ran && cat`], f.repo);
    const owner = startOwner(t, f, reason);
    await waitUntil(() => fs.existsSync(owner.receipt), `${reason} owner receipt`);
    const old = JSON.parse(fs.readFileSync(owner.receipt));
    if (reason === 'integrated') command('git', ['merge', '--ff-only', old.branch], f.repo);
    if (reason === 'unreceipted') fs.unlinkSync(path.join(f.repo, '.lane/discovery/entries', `${old.topic}.json`));
    owner.child.kill('SIGKILL'); await owner.ended;
    const next = createEntry(f.options); next.close();
    const retained = reason !== 'empty';
    assert.equal(fs.existsSync(old.workspace), retained, reason);
    assert.equal(Boolean(command('git', ['branch', '--list', old.branch], f.repo)), retained, reason);
    if (!retained) {
      assert.ok(!fs.existsSync(old.requests)); assert.ok(!fs.existsSync(old.metadata));
      assert.ok(!fs.existsSync(path.join(f.repo, '.lane/discovery/entries', `${old.topic}.json`)));
    }
    if (reason === 'ignored') assert.equal(fs.readFileSync(path.join(old.workspace, '.env'), 'utf8'), 'retain ignored configuration');
    if (reason === 'filter') assert.ok(!fs.existsSync(path.join(f.scratch, 'filter-ran')), 'stale inspection must never execute an external clean filter');
  }
});

test('sweep never removes a lane owned by a live parent or native child', { timeout: 20000 }, async (t) => {
  const f = fixture(t), native = childProcess(t, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: f.repo });
  const owner = startOwner(t, f, 'child', native.child.pid);
  await waitUntil(() => fs.existsSync(owner.receipt), 'live owner receipt');
  const old = JSON.parse(fs.readFileSync(owner.receipt));
  const first = createEntry({ ...f.options, role: 'supervisor' }); first.close();
  assert.ok(fs.existsSync(old.workspace));
  owner.child.kill('SIGKILL'); await owner.ended;
  // The parent used the same attachChild API as both installed adapters. Its
  // live native process keeps the lane after the parent is killed.
  const second = createEntry(f.options); second.close();
  assert.ok(fs.existsSync(old.workspace));
  native.child.kill('SIGKILL'); await native.ended;
  const third = createEntry({ ...f.options, role: 'supervisor' }); third.close();
  assert.ok(!fs.existsSync(old.workspace));
});

test('a parent killed during ownership handoff cannot launch an unregistered native child', { timeout: 15000 }, async (t) => {
  const f = fixture(t), receipt = path.join(f.scratch, 'handoff.json'), escaped = path.join(f.scratch, 'native-started');
  const source = `import fs from 'node:fs';
import {createEntry} from ${JSON.stringify(path.join(product, 'discovery/runtime.mjs'))};
import {spawnNative} from ${JSON.stringify(path.join(product, 'discovery/session.mjs'))};
const entry=createEntry(${JSON.stringify(f.options)}),context=entry.context();
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(context));
spawnNative({...entry,attachChild(){process.kill(process.pid,'SIGKILL')}},process.execPath,
 ['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(escaped)},'unregistered child started')`)}],{cwd:context.workspace});`;
  const owner = childProcess(t, process.execPath, ['--input-type=module', '-e', source], { cwd: f.repo });
  const result = await owner.ended; assert.equal(result.signal, 'SIGKILL');
  const old = JSON.parse(fs.readFileSync(receipt));
  const next = createEntry(f.options); next.close();
  assert.ok(!fs.existsSync(escaped), 'native execution must wait for durable ownership');
  assert.ok(!fs.existsSync(old.workspace)); assert.ok(!fs.existsSync(old.requests));
});

test('symlinked HOME and operator worktree-root prefixes resolve before no-follow creation', (t) => {
  const f = fixture(t), home = path.join(f.scratch, 'real-home'), alias = path.join(f.scratch, 'home-link');
  fs.mkdirSync(home); fs.symlinkSync(home, alias);
  const source = `import {createEntry} from ${JSON.stringify(path.join(product, 'discovery/runtime.mjs'))};const entry=createEntry({cwd:${JSON.stringify(f.repo)},runtimeDir:${JSON.stringify(f.options.runtimeDir)}});console.log(JSON.stringify(entry.context()));entry.close();`;
  const context = JSON.parse(command(process.execPath, ['--input-type=module', '-e', source], f.repo, { HOME: alias }));
  assert.ok(context.workspace.startsWith(path.join(home, '.herdr/worktrees') + path.sep));
  assert.ok(!fs.existsSync(context.workspace));
  const roots = path.join(f.scratch, 'real-roots'), rootLink = path.join(f.scratch, 'root-link');
  fs.mkdirSync(roots); fs.symlinkSync(roots, rootLink);
  const entry = createEntry({ ...f.options, worktreeRoot: path.join(rootLink, 'not-yet-created/deep') });
  assert.equal(path.dirname(entry.context().workspace), path.join(roots, 'not-yet-created/deep'));
  entry.close();
});
