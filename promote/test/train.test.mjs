import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { registerProcess, killProcess } from '../../test/helpers/processes.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-test-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
  const exec = (file, args, cwd = repo) => spawnSync(file, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
  const git = (args, cwd = repo) => { const r = exec('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Train']); git(['config', 'user.email', 'train@example.invalid']);
  const counts = path.join(root, 'checks');
  const checker = path.join(root, 'check.cjs');
  fs.writeFileSync(checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');console.log('# tests 1\\n# pass '+(fs.existsSync('bad')?0:1));if(fs.existsSync('bad'))process.exit(1);`);
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${checker}` }));
  fs.writeFileSync(path.join(repo, 'base'), 'base'); git(['add', '.']); git(['commit', '-qm', 'Base']);
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const queue = queueFor(repo);
  const lane = (topic, bad = false) => {
    const wt = path.join(root, topic); git(['worktree', 'add', '-qb', `lane/${topic}`, wt]);
    fs.writeFileSync(path.join(wt, bad ? 'bad' : topic), topic); git(['add', '.'], wt); git(['commit', '-qm', topic], wt);
    return wt;
  };
  const add = (topic, extra = {}) => enqueue(queue, [topic], { to: 'test', herdr, attempts: 1, retry: 0,
    laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, expectedHead: git(['rev-parse', `lane/${topic}`]), ...extra });
  const drain = () => exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']);
  const runs = () => fs.existsSync(counts) ? fs.readFileSync(counts, 'utf8').trim().split('\n').length : 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, env, exec, git, queue, lane, add, drain, runs, checker };
}

test('three ready lanes stack and fast-forward with one promotion-tier run', t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic); f.add(topic); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted', 'promoted']);
  assert.equal(f.runs(), 1);
  for (const topic of ['first', 'second', 'third']) assert.equal(fs.readFileSync(path.join(f.repo, topic), 'utf8'), topic);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
});

test('a red three-lane batch lands two good lanes and isolates the breaking lane in two extra runs', t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic, topic === 'third'); f.add(topic); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted', 'refused']);
  assert.ok(f.runs() <= 3, `ran ${f.runs()} gates`); assert.equal(fs.existsSync(path.join(f.repo, 'bad')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'third')), true);
});

test('a lone ready lane goes immediately with one promotion run', t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results[0].outcome, 'promoted'); assert.equal(f.runs(), 1);
});

test('interrupted validation preserves main and drain resumes the batch', async t => {
  const f = fixture(t); f.lane('first'); f.lane('second'); f.add('first'); f.add('second');
  const before = f.git(['rev-parse', 'main']), marker = path.join(f.root, 'killed');
  fs.writeFileSync(f.checker, `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setTimeout(()=>{},60000);`);
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(marker));
  const gateOwner = JSON.parse(fs.readFileSync(path.join(f.repo, '.git/lane-promote.lock/owner.json')));
  const gate = registerProcess(gateOwner.pid), checker = registerProcess(JSON.parse(fs.readFileSync(marker)).pid);
  assert.ok(gate.command.includes(path.join(source, 'lanes/lane.mjs'))); assert.ok(checker.command.includes(f.checker));
  killProcess(gate, 'SIGKILL'); killProcess(checker, 'SIGKILL'); await done;
  assert.equal(f.git(['rev-parse', 'main']), before);
  fs.writeFileSync(f.checker, "console.log('green');");
  for (const lock of ['worker.lock', '../lane-promote.lock']) {
    const dir = path.resolve(f.queue.directory, lock);
    if (fs.existsSync(dir)) { const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'))); assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(dir, { recursive: true }); }
  }
  const receipts = path.join(f.repo, '.git/lane-validation');
  for (const entry of fs.readdirSync(receipts).filter(name => name.endsWith('.lock'))) {
    const dir = path.join(receipts, entry), owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json')));
    assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(dir, { recursive: true });
  }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted']);
});

test('a previously green identical tree is reused by the batch', t => {
  const f = fixture(t), wt = f.lane('alone'); f.add('alone');
  const checked = f.exec(process.execPath, [path.join(source, 'lanes/lane.mjs'), 'check', '--tier', 'promotion'], wt);
  assert.equal(checked.status, 0, checked.stderr); assert.equal(f.runs(), 1);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results[0].gate.reused, true); assert.equal(f.runs(), 1);
});

for (const broken of ['first', 'second']) test(`bisection lands all good work with ${broken} red`, t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic, topic === broken); f.add(topic); }
  assert.equal(f.drain().status, 0);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['first', 'second', 'third'].map(topic => topic === broken ? 'refused' : 'promoted'));
  assert.equal(fs.existsSync(path.join(f.repo, 'bad')), false); assert.ok(f.runs() <= 5);
});

test('a changed queued head and a dirty lane are refused without holding a clean lane', t => {
  const f = fixture(t); const wt = f.lane('changed'); f.add('changed');
  fs.writeFileSync(path.join(wt, 'later'), 'later'); f.git(['add', '.'], wt); f.git(['commit', '-qm', 'Unreviewed'], wt);
  const dirty = f.lane('dirty'); f.add('dirty'); fs.writeFileSync(path.join(dirty, 'local'), 'local');
  f.lane('clean'); f.add('clean');
  assert.equal(f.drain().status, 0);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['refused', 'refused', 'promoted']); assert.equal(f.runs(), 1);
});

test('a crash after the fast-forward resumes bookkeeping without a second gate', t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const realGit = f.exec('which', ['git']).stdout.trim(), bin = path.join(f.root, 'bin'), marker = path.join(f.root, 'after-ff');
  fs.mkdirSync(bin); f.env.PATH = `${bin}:${f.env.PATH}`;
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2);
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});
if(r.status===0&&a.includes('merge')&&a.includes('--ff-only')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');process.kill(process.ppid,'SIGKILL');}
process.exit(r.status??1);`, { mode: 0o755 });
  assert.equal(f.drain().status, 1); const integrated = f.git(['rev-parse', 'main']);
  assert.equal(f.runs(), 1);
  const lock = path.join(f.repo, '.git/lane-promote.lock'), owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
  assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(lock, { recursive: true });
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results[0].outcome, 'promoted'); assert.equal(f.runs(), 1);
  assert.equal(f.git(['rev-parse', 'main']), integrated);
});

test('STOP and scratch mutation preserve main and produce refusals', t => {
  for (const mode of ['stop', 'dirty']) {
    const f = fixture(t); f.lane('alone'); f.add('alone');
    const base = f.git(['rev-parse', 'main']);
    if (mode === 'stop') {
      fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'STOP');
    } else fs.writeFileSync(f.checker, "require('fs').writeFileSync('alone','unreviewed');");
    assert.equal(f.drain().status, 0);
    assert.equal(f.queue.load().results[0].outcome, 'refused');
    assert.equal(f.git(['rev-parse', 'main']), base); assert.ok(fs.existsSync(path.join(f.root, 'alone')));
  }
});
