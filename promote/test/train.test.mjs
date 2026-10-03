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
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
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
