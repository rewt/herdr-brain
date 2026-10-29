import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { releaseEnvironment } from './helpers/release-environment.mjs';

const script = fileURLToPath(new URL('../herdr/visible-run.mjs', import.meta.url));
const release = fileURLToPath(new URL('../herdr/release.sh', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "visible 'run-")));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  fixtureFleet(t, root);
  const repo = path.join(root, 'repo'), calls = path.join(root, 'calls.jsonl'), cli = path.join(root, 'herdr.cjs');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'seed'), 'seed'); git('add', '.'); git('commit', '-qm', 'fixture');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),repo=${JSON.stringify(repo)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(process.env.REFUSE===a.slice(0,2).join(' ')){console.error(JSON.stringify({error:{code:'native_refused'}}));process.exit(1);}
let result={};
if(a[0]==='workspace')result={workspaces:[{workspace_id:'parent',label:'untrusted label',worktree:{repo_key:repo+'/.git',repo_root:repo,checkout_path:repo,is_linked_worktree:false}},
{workspace_id:'wrong',label:'Herdr Brain',worktree:{repo_key:'/foreign/.git'}}]};
if(process.env.FOREIGN)result={workspaces:[{workspace_id:'wrong',label:'Herdr Brain',worktree:{repo_key:'/foreign/.git'}}]};
if(a[0]==='tab'&&a[1]==='create')result={tab:{tab_id:'parent:t9',workspace_id:'parent'},root_pane:{pane_id:'parent:p9',tab_id:'parent:t9',workspace_id:process.env.WRONG_PANE?'foreign':'parent'}};
if((a[0]==='pane'&&a[1]==='run')||(a[0]==='tab'&&a[1]==='rename'))process.exit(0);
console.log(JSON.stringify({result}));
`, { mode: 0o755 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_BIN_PATH: cli, HERDR_WORKSPACE_ID: 'wrong' };
  const run = (command, extra = {}) => waitForExit(spawnScenarioChild(t, process.execPath,
    [script, 'run', '--repo', repo, '--label', "Full suite '$(touch nope)'", '--', ...command], { cwd: repo, env: { ...env, ...extra } }));
  const entries = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const directories = () => fs.readdirSync(path.join(repo, '.git/visible-runs')).map(name => path.join(repo, '.git/visible-runs', name));
  return { root, repo, env, git, run, entries, directories };
}

test('visible commands retain stdout, stderr, cwd and exact failure; only a new canonical tab receives input', async t => {
  const f = fixture(t), counter = path.join(f.root, 'counter');
  const result = await f.run([process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(counter)},'once');console.log(process.cwd());console.error('suite diagnostic');process.exit(7)`]);
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, new RegExp(f.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, /suite diagnostic/);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'once');
  const [directory] = f.directories(), log = fs.readFileSync(path.join(directory, 'output.log'), 'utf8');
  assert.ok(log.includes(f.repo)); assert.match(log, /suite diagnostic/);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'result.json')));
  assert.equal(receipt.exit_code, 7); assert.equal(receipt.cwd, f.repo); assert.equal(receipt.signal, null);
  const calls = f.entries();
  assert.deepEqual(calls.map(row => row.slice(0, 2)), [['workspace', 'list'], ['tab', 'create'], ['pane', 'run']]);
  assert.ok(calls[1].includes('--no-focus')); assert.equal(calls[1][3], 'parent');
  assert.equal(calls[2][2], 'parent:p9'); assert.ok(!calls[2][3].startsWith('exec '), 'retain the shell and completed output');
  assert.equal(fs.existsSync(path.join(f.repo, 'nope')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'view.json'))).state, 'attached');
});

test('a native refusal is retained once while the original command completes once', async t => {
  const f = fixture(t);
  const result = await f.run([process.execPath, '-e', "console.log('completed once')"], { REFUSE: 'pane run' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /native_refused/);
  assert.equal(f.entries().filter(row => row[0] === 'pane').length, 1);
  assert.match(fs.readFileSync(path.join(f.directories()[0], 'view-error.json'), 'utf8'), /native_refused/);
});

test('foreign display metadata and inconsistent new-pane ownership cannot authorize input', async t => {
  const f = fixture(t);
  assert.equal((await f.run([process.execPath, '-e', ''], { FOREIGN: '1' })).code, 0);
  assert.deepEqual(f.entries().map(row => row.slice(0, 2)), [['workspace', 'list']]);
  assert.equal((await f.run([process.execPath, '-e', ''], { WRONG_PANE: '1' })).code, 0);
  assert.equal(f.entries().filter(row => row[0] === 'pane').length, 0);
});

test('headless commands keep their result without native calls, including launch failures', async t => {
  const f = fixture(t);
  assert.equal((await f.run([process.execPath, '-e', ''], { HERDR_ENV: '' })).code, 0);
  assert.deepEqual(f.entries(), []);
  const result = await f.run([path.join(f.root, 'missing-command')], { HERDR_ENV: '' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ENOENT/);
  const failed = f.directories().map(directory => JSON.parse(fs.readFileSync(path.join(directory, 'result.json')))).find(row => row.error);
  assert.match(failed.error, /ENOENT/);
});

test('the view drains final output and distinguishes command failure, signal and absent result', async t => {
  const f = fixture(t);
  assert.equal((await f.run([process.execPath, '-e', "console.log('last bytes');process.kill(process.pid,'SIGTERM')"], { HERDR_ENV: '' })).code, 143);
  const directory = f.directories()[0], resultFile = path.join(directory, 'result.json');
  const read = () => waitForExit(spawnScenarioChild(t, process.execPath, [script, 'view', directory, 'Live checks', 'parent:t9'], { env: f.env }));
  let shown = await read();
  assert.match(shown.stdout, /last bytes/); assert.match(shown.stdout, /interrupted \(SIGTERM\)/);
  fs.writeFileSync(resultFile, JSON.stringify({ exit_code: 9, signal: null }));
  shown = await read(); assert.match(shown.stdout, /failed \(9\)/);
  fs.unlinkSync(resultFile);
  shown = await read(); assert.match(shown.stdout, /result unknown/); assert.doesNotMatch(shown.stdout, /: passed/);
});

test('Herdr release builds wrap once, retain the real gate/live behavior and clear the display marker', async t => {
  const f = fixture(t), home = path.join(f.root, 'home'), counts = path.join(f.root, 'executed');
  copyProduct(fileURLToPath(new URL('../', import.meta.url)), f.repo);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ release: 'node fixture-gate.mjs', timeout_seconds: 0 }));
  fs.writeFileSync(path.join(f.repo, 'fixture-gate.mjs'), `import fs from 'node:fs';if(process.env.HERDR_RELEASE_VISIBLE_CHILD)process.exit(99);fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');console.log('offline suite progress');`);
  fs.mkdirSync(path.join(f.repo, 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'acceptance/run.mjs'), `import fs from 'node:fs';import {execFileSync} from 'node:child_process';if(process.env.HERDR_RELEASE_VISIBLE_CHILD)process.exit(99);fs.appendFileSync(${JSON.stringify(counts)},'live\\n');console.log('live progress');fs.writeFileSync(process.argv[process.argv.indexOf('--summary-file')+1],JSON.stringify({ready:true,elapsedSeconds:1,candidateCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),counts:{PASS:1,FAIL:0,PENDING:0,SKIP:0}}));`);
  f.git('add', '.'); f.git('commit', '-qm', 'synthetic release'); f.git('tag', 'visible-fixture');
  const env = releaseEnvironment(f.env, { HERDR_BIN_PATH: f.env.HERDR_BIN_PATH, HERDR_MONITOR_REPO: f.repo,
    HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: path.join(f.root, 'bin'), HERDR_MONITOR_PLIST: '', HERDR_MONITOR_FLEET: path.join(f.root, 'fleet') });
  const result = await waitForExit(spawnScenarioChild(t, 'bash', [release, 'build', 'visible-fixture', '--live'], { cwd: f.repo, env }));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(counts, 'utf8'), 'gate\nlive\n');
  assert.equal(f.directories().length, 1);
  assert.equal(f.entries().filter(row => row[0] === 'tab' && row[1] === 'create').length, 1);
  const work = path.join(home, 'builds/visible-fixture');
  const execution = JSON.parse(fs.readFileSync(path.join(work, 'execution.json')));
  assert.equal(JSON.parse(fs.readFileSync(execution.receipt)).exit_code, 0);
  assert.ok(fs.existsSync(path.join(home, 'releases/visible-fixture/.release-manifest.json')));
  const log = fs.readFileSync(path.join(f.directories()[0], 'output.log'), 'utf8');
  assert.match(log, /offline suite progress/); assert.match(log, /live progress/); assert.match(log, /built visible-fixture/);
});
