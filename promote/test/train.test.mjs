import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue, queueJobs } from '../promote.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { registerProcess, killProcess } from '../../test/helpers/processes.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const emptyComposer = fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url));
const typedComposer = fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url));
async function until(fn) {
  const deadline = Date.now() + loadTimeout(10000);
  while (Date.now() < deadline) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('timed out waiting for train notice evidence');
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-test-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root);
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
  env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  env.PROMOTE_TEST_COMPOSER = path.join(root, 'composer');
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
const fs=require('fs'),a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='prompt')fs.appendFileSync(${JSON.stringify(path.join(root, 'notices'))},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log(fs.existsSync(process.env.PROMOTE_TEST_COMPOSER)?fs.readFileSync(process.env.PROMOTE_TEST_COMPOSER,'utf8'):'────────────────────\\n❯ \\n────────────────────');
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
  t.after(async () => { await waitForInboxIdle(path.join(repo, '.git/supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = () => fs.existsSync(path.join(root, 'notices')) ? fs.readFileSync(path.join(root, 'notices'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, repo, env, exec, git, queue, lane, add, drain, runs, checker, messages };
}

test('three ready lanes stack and fast-forward with one promotion-tier run', t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic); f.add(topic); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted', 'promoted']);
  assert.equal(f.runs(), 1);
  for (const topic of ['first', 'second', 'third']) assert.equal(fs.readFileSync(path.join(f.repo, topic), 'utf8'), topic);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
});

test('safe bisection lands two good lanes with the third red in exactly three runs', t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic, topic === 'third'); f.add(topic); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted', 'refused']);
  assert.equal(f.runs(), 3); t.diagnostic(`culprit=third promotion-tier runs=${f.runs()}`);
  assert.equal(fs.existsSync(path.join(f.repo, 'bad')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'third')), true);
});

test('a lone ready lane goes immediately with one promotion run', t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results[0].outcome, 'promoted'); assert.equal(f.runs(), 1);
});

test('STOP during a batch memory wait refuses promotion and permits retry after clearing', async t => {
  const f = fixture(t), workspace = f.lane('stopped'); f.add('stopped');
  const before = f.git(['rev-parse', 'main']), head = f.git(['rev-parse', 'HEAD'], workspace);
  const memory = path.join(f.root, 'memory.json'), stop = path.join(f.repo, '.lane/supervisor/STOP');
  const healthy = { available: 8 * 1024 ** 3, swap_used: 0 };
  fs.writeFileSync(memory, JSON.stringify({ ...healthy, available: 128 * 1024 ** 2 }));
  f.env.TEST_MEMORY_FILE = memory;
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    await until(() => {
      const batch = f.queue.load().current;
      const log = batch && path.join(f.queue.directory, 'batches', batch.id, 'train.log');
      return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('waiting; memory pressure');
    });
    assert.equal(f.runs(), 0);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'stop during wait');
    const r = await done; assert.equal(r.code, 0, r.stderr);
    const saved = f.queue.load();
    assert.equal(saved.results[0].outcome, 'refused');
    assert.equal(saved.current, null); assert.equal(saved.interrupted?.length ?? 0, 0);
    assert.match(saved.results[0].reason, /supervisor STOP exists; nothing merged/);
    assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), before);
    assert.equal(f.git(['rev-parse', 'HEAD'], workspace), head);
    fs.unlinkSync(stop); fs.writeFileSync(memory, JSON.stringify(healthy));
    const [retry] = f.add('stopped'); assert.notEqual(retry.id, saved.results[0].id);
    const resumed = f.drain(); assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
    assert.equal(f.queue.load().results.at(-1).id, retry.id); assert.equal(f.runs(), 1);
  } finally { fs.writeFileSync(memory, JSON.stringify(healthy)); await done; }
});

test('completed batch notices wait for empty input and deliver each lane once with one gate', async t => {
  const f = fixture(t); for (const topic of ['first', 'second']) { f.lane(topic); f.add(topic); }
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '10';
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, typedComposer);
  const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(inbox) && readInbox(inbox).length === 1);
    const saved = f.queue.load().current, integrated = f.git(['rev-parse', 'main']);
    assert.equal(saved.phase, 'completed'); assert.equal(saved.deliveredCount, 0);
    assert.equal(saved.results[0].result.outcome, 'promoted');
    assert.deepEqual(f.messages(), []); assert.equal(f.runs(), 1);
    assert.equal(enqueue(f.queue, ['first'], saved.jobs[0])[0].id, saved.jobs[0].id, 'queued delivery retains the original promotion request');
    assert.equal(f.queue.load().pending.length, 0);
    fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer);
    const result = await done; assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.queue.load().results.map(r => [r.topic, r.outcome, r.delivered]), [['first', 'promoted', true], ['second', 'promoted', true]]);
    assert.equal(f.messages().length, 2); assert.ok(readInbox(inbox).every(entry => entry.state === 'sent'));
    assert.equal(f.runs(), 1); assert.equal(f.git(['rev-parse', 'main']), integrated);
  } finally { fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer); await done; }
});

test('a crash with a train notice queued resumes its saved outcome without repeating cleanup or promotion', async t => {
  const f = fixture(t); for (const topic of ['first', 'second']) { f.lane(topic); f.add(topic); }
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '10';
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, typedComposer);
  const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker); let resumedDone;
  try {
    await until(() => fs.existsSync(inbox) && readInbox(inbox).length === 1);
    const queued = readInbox(inbox)[0], saved = f.queue.load().current, integrated = f.git(['rev-parse', 'main']);
    assert.deepEqual(f.messages(), []); assert.equal(f.runs(), 1);
    assert.equal(fs.existsSync(path.join(f.root, 'first')), false, 'cleanup completed before the notice was queued');
    assert.equal(worker.kill('SIGKILL'), true); await done;
    const lock = path.join(f.queue.directory, 'worker.lock'), owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
    assert.equal(owner.pid, worker.pid); assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(lock, { recursive: true });
    const resumed = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    resumedDone = waitForExit(resumed);
    const ready = new Promise(resolve => resumed.once('message', resolve));
    assert.equal((await ready).ready, true);
    resumed.disconnect();
    fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer);
    const result = await resumedDone; assert.equal(result.code, 0, result.stderr);
    const results = f.queue.load().results;
    assert.deepEqual(results.map(r => [r.id, r.outcome, r.delivered]), saved.jobs.map(job => [job.id, 'promoted', true]));
    assert.deepEqual(results[0].warnings, ['no record discovered; finished tabs preserved']);
    assert.equal(f.messages().length, 2); assert.equal(f.messages()[0][3], `${queued.message} notice-id=${queued.id}`);
    assert.equal(readInbox(inbox).length, 2); assert.ok(readInbox(inbox).every(entry => entry.state === 'sent'));
    assert.equal(f.runs(), 1); assert.equal(f.git(['rev-parse', 'main']), integrated);
  } finally { fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer); await done; if (resumedDone) await resumedDone; }
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
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['interrupted', 'interrupted']);
  assert.ok(f.queue.load().results.every(r => r.delivered));
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
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['interrupted', 'interrupted', 'promoted', 'promoted']);
  assert.deepEqual(queueJobs(f.queue.load()).map(r => r.outcome), ['promoted', 'promoted']);
});

test('a previously green identical tree is reused by the batch', t => {
  const f = fixture(t), wt = f.lane('alone'); f.add('alone');
  const checked = f.exec(process.execPath, [path.join(source, 'lanes/lane.mjs'), 'check', '--tier', 'promotion'], wt);
  assert.equal(checked.status, 0, checked.stderr); assert.equal(f.runs(), 1);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results[0].gate.reused, true); assert.equal(f.runs(), 1);
});

for (const broken of ['first', 'second']) test(`safe bisection lands all good work with ${broken} red in exactly five runs`, t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic, topic === broken); f.add(topic); }
  assert.equal(f.drain().status, 0);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['first', 'second', 'third'].map(topic => topic === broken ? 'refused' : 'promoted'));
  assert.equal(fs.existsSync(path.join(f.repo, 'bad')), false); assert.equal(f.runs(), 5);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
  t.diagnostic(`culprit=${broken} promotion-tier runs=${f.runs()}`);
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
  assert.equal(f.drain().status, 0); const integrated = f.git(['rev-parse', 'main']);
  assert.equal(f.queue.load().results[0].outcome, 'interrupted'); assert.equal(f.queue.load().results[0].delivered, true);
  assert.equal(f.runs(), 1);
  const lock = path.join(f.repo, '.git/lane-promote.lock'), owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
  assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(lock, { recursive: true });
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.runs(), 1);
  assert.equal(f.git(['rev-parse', 'main']), integrated);
});

test('recovery: a lost fast-forward is adopted after a later batch advances main', t => {
  const f = fixture(t); const first = f.lane('first'); f.lane('later');
  // Force replay so a redundant resume would append duplicate empty commits.
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'keep'); f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Advance main']);
  f.add('first'); f.add('later', { validate: `${process.execPath} ${f.checker} ` });
  const realGit = f.exec('which', ['git']).stdout.trim(), bin = path.join(f.root, 'bin'), marker = path.join(f.root, 'after-ff');
  fs.mkdirSync(bin); f.env.PATH = `${bin}:${f.env.PATH}`;
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2);
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});
if(r.status===0&&a.includes('merge')&&a.includes('--ff-only')&&!fs.existsSync(${JSON.stringify(marker)})){
 fs.writeFileSync(${JSON.stringify(marker)},'once');
 // Lose the train process before it checkpoints integration; release only its owned fixture lock.
 const lock=${JSON.stringify(path.join(f.repo, '.git/lane-promote.lock'))};
 if(JSON.parse(fs.readFileSync(lock+'/owner.json')).pid===process.ppid)fs.rmSync(lock,{recursive:true});
 process.kill(process.ppid,'SIGKILL');
}process.exit(r.status??1);`, { mode: 0o755 });
  const drained = f.drain(); assert.equal(drained.status, 0, drained.stderr);
  const [interrupted, later] = f.queue.load().results;
  assert.equal(interrupted.outcome, 'interrupted'); assert.equal(later.outcome, 'promoted'); assert.equal(f.runs(), 2);
  const before = JSON.parse(fs.readFileSync(interrupted.receipt)), tip = before.attempts[0].tip;
  assert.equal(before.attempts[0].phase, 'validated'); assert.notEqual(f.git(['rev-parse', 'main']), tip);
  f.git(['merge-base', '--is-ancestor', tip, 'main']);
  const integrated = f.git(['rev-parse', 'main']);
  const resumed = f.drain(); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.runs(), 2, 'no third gate');
  assert.equal(f.git(['rev-parse', 'main']), integrated, 'no duplicate replay commits');
  assert.equal(fs.existsSync(first), false); assert.equal(f.queue.load().interrupted.length, 0);
  const after = JSON.parse(fs.readFileSync(interrupted.receipt)); assert.equal(after.attempts.length, 1);
  assert.equal(after.attempts[0].phase, 'complete'); assert.equal(after.results[interrupted.id].tip, tip);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
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

// Fail at a real durable checkpoint, once, without killing a gate or leaving
// crash locks. All Git effects before/after this injected read remain real.
function interruptAt(f, phase) {
  const realGit = f.exec('which', ['git']).stdout.trim(), bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin); f.env.PATH = `${bin}:${f.env.PATH}`;
  const marker = path.join(f.root, 'interrupted'), proxy = path.join(f.root, 'interrupt.cjs');
  fs.writeFileSync(proxy, `const fs=require('fs'),path=require('path'),cp=require('child_process'),a=process.argv.slice(2);
const dir=${JSON.stringify(path.join(f.queue.directory, 'batches'))};
if(fs.existsSync(dir)&&!fs.existsSync(${JSON.stringify(marker)}))for(const name of fs.readdirSync(dir)){
 const file=path.join(dir,name,'train.json');if(!fs.existsSync(file))continue;
 const plan=JSON.parse(fs.readFileSync(file)),attempt=plan.attempts?.at(-1);
 if(attempt?.phase===${JSON.stringify(phase)}&&(${phase === 'prepared' ? "a.includes('status')&&a[1]===attempt.scratch" : "a.includes('rev-parse')&&a.at(-1)==='main'"})){
  fs.writeFileSync(${JSON.stringify(marker)},'once');console.error('injected ${phase} checkpoint interruption');process.exit(1);
 }
}
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$3" in status|rev-parse) exec '${process.execPath}' '${proxy}' "$@";; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
}

for (const mode of ['dirty', 'off-main']) test(`batch ${mode} canonical checkout returns refusals and notices before scratch work`, t => {
  const f = fixture(t); f.lane('first'); f.lane('second'); f.add('first'); f.add('second');
  const base = f.git(['rev-parse', 'main']);
  if (mode === 'dirty') fs.writeFileSync(path.join(f.repo, 'operator-edit'), 'keep');
  else f.git(['switch', '-qc', 'operator']);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['refused', 'refused']);
  assert.ok(f.queue.load().results.every(r => r.delivered));
  assert.match(f.queue.load().results[0].reason, mode === 'dirty' ? /not clean/ : /must be on main/);
  assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  const plan = JSON.parse(fs.readFileSync(f.queue.load().results[0].receipt)); assert.equal(plan.attempts.length, 0);
  assert.ok(f.messages().every(a => a[3].includes('[promote-queue]') && a[3].includes('outcome=refused')));
  if (mode === 'dirty') { assert.equal(fs.readFileSync(path.join(f.repo, 'operator-edit'), 'utf8'), 'keep'); fs.unlinkSync(path.join(f.repo, 'operator-edit')); }
  else f.git(['switch', '-q', 'main']);
  f.add('first'); assert.equal(f.drain().status, 0); assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
});

for (const phase of ['prepared', 'validated']) test(`resuming a ${phase} batch after main moves replans and preserves upstream work`, t => {
  const f = fixture(t); f.lane('first'); f.add('first'); interruptAt(f, phase);
  const base = f.git(['rev-parse', 'main']);
  assert.equal(f.drain().status, 0);
  const interrupted = f.queue.load().results[0]; assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(f.git(['rev-parse', 'main']), base);
  const before = JSON.parse(fs.readFileSync(interrupted.receipt)); assert.equal(before.attempts[0].phase, phase);
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'keep upstream'); f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Advance main']);
  const upstream = f.git(['rev-parse', 'main']);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
  assert.equal(fs.readFileSync(path.join(f.repo, 'upstream'), 'utf8'), 'keep upstream');
  assert.equal(f.git(['rev-list', '--count', `${upstream}..main`]), '1');
  const after = JSON.parse(fs.readFileSync(interrupted.receipt));
  assert.equal(after.attempts[0].phase, 'stale'); assert.equal(after.attempts[1].base, upstream);
  assert.equal(f.runs(), phase === 'prepared' ? 1 : 2);
});

for (const mode of ['dirty', 'moved', 'stop']) test(`resuming prepared capture refuses ${mode} input and drains the remaining lanes`, t => {
  const f = fixture(t), first = f.lane('first'); f.lane('second'); f.add('first'); f.add('second'); interruptAt(f, 'prepared');
  assert.equal(f.drain().status, 0);
  const base = f.git(['rev-parse', 'main']);
  if (mode === 'stop') { fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'STOP'); }
  else { fs.writeFileSync(path.join(first, 'later'), 'unreviewed'); if (mode === 'moved') { f.git(['add', '.'], first); f.git(['commit', '-qm', 'Later work'], first); } }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const results = f.queue.load().results.filter(r => r.outcome !== 'interrupted');
  assert.deepEqual(results.map(r => r.outcome), mode === 'stop' ? ['refused', 'refused'] : ['refused', 'promoted']);
  assert.match(results[0].reason, mode === 'stop' ? /STOP/ : mode === 'dirty' ? /not clean/ : /tip changed/);
  assert.equal(f.runs(), mode === 'stop' ? 0 : 1); assert.ok(fs.existsSync(first));
  if (mode === 'stop') assert.equal(f.git(['rev-parse', 'main']), base);
});

test('batch exceptions deliver interrupted notices, preserve the receipt and continue later requests', t => {
  const f = fixture(t); f.lane('first'); f.lane('later'); f.add('first');
  f.add('later', { validate: `${process.execPath} ${f.checker} ` }); interruptAt(f, 'prepared');
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const [interrupted, promoted] = f.queue.load().results;
  assert.equal(interrupted.outcome, 'interrupted'); assert.equal(interrupted.delivered, true);
  assert.equal(promoted.outcome, 'promoted'); assert.equal(f.queue.load().current, null);
  assert.equal(f.queue.load().interrupted.length, 1); assert.match(f.queue.load().interrupted[0].error, /batch interrupted/);
  assert.ok(fs.existsSync(interrupted.receipt)); assert.ok(fs.existsSync(interrupted.log));
  assert.ok(f.messages()[0][3].includes(interrupted.receipt)); assert.ok(f.messages()[0][3].includes(interrupted.log));
  assert.ok(f.messages()[0][3].includes(`notice-id=promote:${interrupted.id}`));
  assert.equal(f.drain().status, 0); assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
  assert.equal(f.queue.load().results.at(-1).id, interrupted.id); assert.equal(f.queue.load().interrupted.length, 0);
  assert.equal(queueJobs(f.queue.load()).find(job => job.id === interrupted.id).outcome, 'promoted');
  assert.equal(f.queue.load().results.at(-1).delivered, true);
  assert.ok(f.messages().at(-1)[3].includes(`notice-id=promote:${interrupted.id}:complete`));
});

test('promotion lock contention delivers an interrupted notice and resumes after the owner releases it', t => {
  const f = fixture(t); f.lane('first'); f.add('first');
  const base = f.git(['rev-parse', 'main']), release = acquireLock(path.join(f.repo, '.git/lane-promote.lock'));
  try {
    const r = f.drain(); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.queue.load().results[0].outcome, 'interrupted'); assert.equal(f.queue.load().results[0].delivered, true);
    assert.equal(f.git(['rev-parse', 'main']), base); assert.equal(f.runs(), 0);
    assert.equal(f.drain().status, 0); assert.equal(f.queue.load().interrupted.length, 1);
    assert.equal(f.queue.load().results.at(-1).delivery_id, f.queue.load().results[0].delivery_id);
  } finally { release(); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.runs(), 1);
});

// Observe the receipt from a separate process at real Git boundaries. The
// checks themselves also read it, before returning any validation evidence.
function telemetryProxy(f, { interrupt = false, realGit = f.exec('which', ['git']).stdout.trim() } = {}) {
  const bin = path.join(f.root, 'bin');
  const observations = path.join(f.root, 'telemetry.jsonl'), marker = path.join(f.root, 'telemetry-interrupted');
  const proxy = path.join(f.root, 'telemetry-git.cjs');
  fs.mkdirSync(bin, { recursive: true });
  if (f.env.PATH.split(path.delimiter)[0] !== bin) f.env.PATH = `${bin}:${f.env.PATH}`;
  fs.writeFileSync(proxy, `const fs=require('fs'),path=require('path'),cp=require('child_process'),args=process.argv.slice(2);
const batches=${JSON.stringify(path.join(f.queue.directory, 'batches'))};
if(fs.existsSync(batches))for(const name of fs.readdirSync(batches)){
 const file=path.join(batches,name,'train.json');if(!fs.existsSync(file))continue;
 const plan=JSON.parse(fs.readFileSync(file)),attempt=plan.attempts?.at(-1);
 fs.appendFileSync(${JSON.stringify(observations)},JSON.stringify({args,plan})+'\\n');
 if(${interrupt}&&plan.phase==='validating'&&args[2]==='status'&&args[1]===attempt.scratch&&!fs.existsSync(${JSON.stringify(marker)})){
  fs.writeFileSync(${JSON.stringify(marker)},file);
  const lock=${JSON.stringify(path.join(f.repo, '.git/lane-promote.lock'))};
  if(JSON.parse(fs.readFileSync(lock+'/owner.json')).pid===process.ppid)fs.rmSync(lock,{recursive:true});
  process.kill(process.ppid,'SIGKILL');
 }
}
const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$3" in worktree|rebase|merge|rev-parse|status) exec '${process.execPath}' '${proxy}' "$@";; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  return () => fs.readFileSync(observations, 'utf8').trim().split('\n').map(JSON.parse);
}

test('batch telemetry publishes every running phase before its work and preserves recovery checkpoints', t => {
  const f = fixture(t), preparation = path.join(f.root, 'prepare.cjs'), prepared = path.join(f.root, 'preparing.json');
  const config = path.join(f.root, 'lane.json');
  const receiptReader = `const fs=require('fs'),path=require('path');const dir=${JSON.stringify(path.join(f.queue.directory, 'batches'))};const file=path.join(dir,fs.readdirSync(dir)[0],'train.json');`;
  fs.writeFileSync(preparation, receiptReader + `fs.writeFileSync(${JSON.stringify(prepared)},fs.readFileSync(file));`);
  fs.writeFileSync(config, JSON.stringify({ prepare: [{ run: `${process.execPath} ${preparation}` }] }));
  f.lane('first'); f.lane('second'); f.add('first', { laneConfig: config }); f.add('second', { laneConfig: config });
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'keep'); f.git(['add', '.']); f.git(['commit', '-qm', 'Advance main']);
  const observed = telemetryProxy(f), checked = path.join(f.root, 'validating.json');
  fs.writeFileSync(f.checker, receiptReader + `fs.writeFileSync(${JSON.stringify(checked)},fs.readFileSync(file));console.log('green');`);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted']);
  const rows = observed();
  const preparationPlan = JSON.parse(fs.readFileSync(prepared)), checkPlan = JSON.parse(fs.readFileSync(checked));
  assert.equal(preparationPlan.phase, 'preparing'); assert.equal(preparationPlan.attempts[0].phase, 'prepared');
  assert.equal(checkPlan.phase, 'validating'); assert.equal(checkPlan.attempts[0].phase, 'prepared');
  assert.equal(checkPlan.attempts[0].gate.command, `${process.execPath} ${f.checker}`);
  assert.ok(Number.isFinite(Date.parse(checkPlan.attempts[0].gate.started_at)));
  assert.equal(checkPlan.attempts[0].gate.finished_at, undefined);
  assert.equal(checkPlan.attempts[0].gate.duration_s, undefined);
  assert.equal(checkPlan.attempts[0].gate.exit_code, undefined);
  assert.ok(rows.some(({ args, plan }) => args[2] === 'worktree' && args[3] === 'add' && plan.phase === 'preparing'));
  assert.ok(rows.some(({ args, plan }) => args[2] === 'rebase' && plan.phase === 'rebasing' && plan.attempts[0].phase === 'preparing'));
  const forwarding = rows.find(({ args }) => args[2] === 'merge' && args[3] === '--ff-only').plan;
  assert.equal(forwarding.phase, 'fast-forwarding'); assert.equal(forwarding.attempts[0].phase, 'validated');
  assert.equal(forwarding.attempts[0].gate.exit_code, 0);
  assert.ok(Number.isFinite(Date.parse(forwarding.attempts[0].gate.finished_at)));
  assert.ok(forwarding.attempts[0].gate.duration_s >= 0);
  assert.ok(rows.some(({ plan }) => plan.phase === 'closing' && plan.attempts[0].phase === 'integrated'));
  const final = JSON.parse(fs.readFileSync(f.queue.load().results[0].receipt));
  assert.equal(final.phase, 'complete'); assert.equal(final.attempts[0].phase, 'complete');
  assert.equal(final.started_at, checkPlan.started_at);
  assert.deepEqual(final.attempts[0].gate, final.results[final.jobs[0].id].gate);
  assert.deepEqual(final.jobs.map(j => j.topic), ['first', 'second']);
});

test('a paused check exposes its clock atomically while validation is still running', async t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const marker = path.join(f.root, 'running-check'), release = path.join(f.root, 'release-check');
  const before = f.git(['rev-parse', 'main']);
  fs.writeFileSync(f.checker, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'running');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('green');}},20);`);
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(marker));
    const batch = f.queue.load().current, file = path.join(f.queue.directory, 'batches', batch.id, 'train.json');
    const live = JSON.parse(fs.readFileSync(file)), gate = live.attempts[0].gate;
    assert.equal(live.phase, 'validating'); assert.equal(gate.command, `${process.execPath} ${f.checker}`);
    assert.ok(Date.parse(gate.started_at) <= Date.now()); assert.equal(gate.exit_code, undefined);
    assert.equal(gate.finished_at, undefined); assert.equal(f.git(['rev-parse', 'main']), before);
    fs.writeFileSync(release, 'finish');
    const r = await done; assert.equal(r.status, 0, r.stderr);
    const final = JSON.parse(fs.readFileSync(file));
    assert.equal(final.phase, 'complete'); assert.equal(final.attempts[0].gate.exit_code, 0);
    assert.ok(Date.parse(final.attempts[0].gate.finished_at) >= Date.parse(gate.started_at));
    assert.ok(final.attempts[0].gate.duration_s > 0);
  } finally { fs.writeFileSync(release, 'finish'); await done; }
});

test('resuming an in-flight gate keeps the prepared candidate and replaces the unfinished clock', t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const before = f.git(['rev-parse', 'main']); telemetryProxy(f, { interrupt: true });
  const interrupted = f.drain(); assert.equal(interrupted.status, 0, interrupted.stderr);
  const result = f.queue.load().results[0]; assert.equal(result.outcome, 'interrupted');
  const live = JSON.parse(fs.readFileSync(result.receipt)), attempt = live.attempts[0];
  assert.equal(live.phase, 'validating'); assert.equal(attempt.phase, 'prepared');
  assert.equal(attempt.gate.finished_at, undefined); assert.equal(attempt.gate.exit_code, undefined);
  assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), before);
  const resumed = f.drain(); assert.equal(resumed.status, 0, resumed.stderr);
  const final = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(final.phase, 'complete'); assert.equal(final.attempts.length, 1);
  assert.equal(final.started_at, live.started_at); assert.equal(final.attempts[0].tip, attempt.tip);
  assert.equal(final.attempts[0].gate.exit_code, 0); assert.equal(f.runs(), 1);
  assert.ok(Date.parse(final.attempts[0].gate.started_at) >= Date.parse(attempt.gate.started_at));
  assert.ok(Number.isFinite(final.attempts[0].gate.duration_s));
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
});

test('red validation finishes the published clock and retains its real exit', t => {
  const f = fixture(t); f.lane('alone', true); f.add('alone');
  const before = f.git(['rev-parse', 'main']);
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const result = f.queue.load().results[0], final = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(result.outcome, 'refused'); assert.equal(final.phase, 'complete');
  assert.equal(final.attempts[0].phase, 'red'); assert.equal(final.attempts[0].gate.exit_code, 1);
  assert.ok(Date.parse(result.gate.finished_at) >= Date.parse(result.gate.started_at));
  assert.ok(result.gate.duration_s >= 0); assert.equal(f.git(['rev-parse', 'main']), before);
});

test('resumed validated attempts checkpoint prepared before publishing a fresh unfinished clock', t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  const realGit = f.exec('which', ['git']).stdout.trim();
  interruptAt(f, 'validated');
  assert.equal(f.drain().status, 0);
  const result = f.queue.load().results[0], validated = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(validated.attempts[0].phase, 'validated'); assert.equal(validated.attempts[0].gate.exit_code, 0);
  telemetryProxy(f, { interrupt: true, realGit });
  assert.equal(f.drain().status, 0);
  const interrupted = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(interrupted.phase, 'validating'); assert.equal(interrupted.attempts[0].phase, 'prepared');
  assert.equal(interrupted.attempts[0].gate.exit_code, undefined);
  assert.equal(interrupted.attempts[0].tip, validated.attempts[0].tip);
  assert.equal(f.drain().status, 0);
  const final = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(final.attempts.length, 1); assert.equal(final.attempts[0].phase, 'complete');
  assert.equal(final.attempts[0].gate.exit_code, 0); assert.equal(final.attempts[0].gate.reused, true);
  assert.equal(f.runs(), 1, 'the completed identical-tree evidence remains reusable');
  assert.equal(final.started_at, validated.started_at);
  assert.equal(final.attempts[0].gate.started_at, validated.attempts[0].gate.started_at);
  assert.equal(final.attempts[0].gate.duration_s, validated.attempts[0].gate.duration_s);
  assert.equal(f.queue.load().results.at(-1).outcome, 'promoted');
});

test('validation that throws closes its telemetry clock without inventing green evidence', t => {
  const f = fixture(t), workspace = f.lane('alone'); f.add('alone');
  const before = f.git(['rev-parse', 'main']);
  fs.writeFileSync(f.checker, "require('fs').writeFileSync('unreviewed','change');");
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const result = f.queue.load().results[0], final = JSON.parse(fs.readFileSync(result.receipt));
  const attempt = final.attempts[0];
  assert.equal(result.outcome, 'refused'); assert.equal(attempt.phase, 'invalid');
  assert.match(attempt.gate.error, /worktree changed during validation/);
  assert.ok(Date.parse(attempt.gate.finished_at) >= Date.parse(attempt.gate.started_at));
  assert.ok(attempt.gate.duration_s >= 0); assert.equal(attempt.gate.exit_code, undefined);
  assert.equal(f.git(['rev-parse', 'main']), before); assert.ok(fs.existsSync(workspace));
});
