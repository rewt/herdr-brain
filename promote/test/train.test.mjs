import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue, queueJobs } from '../promote.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { registerProcess, killProcess } from '../../test/helpers/processes.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { loadFactor, loadTimeout } from '../../lib/deadline.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { promotionWorkers } from '../../test/helpers/promotion-worker.mjs';
import { watchPromotionLock } from '../../test/helpers/promotion-lock.mjs';
import { healthyMemoryEnvironment, promotionMemoryFixture, healthyMemory, pressuredMemory } from '../../test/helpers/promotion-memory-fixture.mjs';

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
  // These lifecycle cases inspect synchronous delivery; opt into a bounded wait.
  const env = { ...healthyMemoryEnvironment(fixtureEnvironment()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_WAIT_SECONDS: '10', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
  env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  env.PROMOTE_TEST_COMPOSER = path.join(root, 'composer');
  const workers = promotionWorkers(repo);
  const exec = (file, args, cwd = repo) => {
    const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
    let reply; try { reply = JSON.parse(result.stdout); } catch { /* Not a launch acknowledgement. */ }
    workers.remember(reply);
    return result;
  };
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
  t.after(async () => { await workers.wait(); await waitForInboxIdle(path.join(repo, '.git/supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = () => fs.existsSync(path.join(root, 'notices')) ? fs.readFileSync(path.join(root, 'notices'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, repo, env, exec, git, queue, lane, add, drain, runs, checker, messages, wait: () => workers.wait() };
}

test('three ready lanes stack and fast-forward with one promotion-tier run', t => {
  const f = fixture(t); for (const topic of ['first', 'second', 'third']) { f.lane(topic); f.add(topic); }
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.queue.load().results.map(r => r.outcome), ['promoted', 'promoted', 'promoted']);
  assert.equal(f.runs(), 1);
  for (const topic of ['first', 'second', 'third']) assert.equal(fs.readFileSync(path.join(f.repo, topic), 'utf8'), topic);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
});

for (const maxBatch of [undefined, 3]) {
  test(`five pending lanes drain in arrival order with ${maxBatch === undefined ? 'the unbounded default' : 'max_batch 3'}`, async t => {
    const f = fixture(t), topics = ['third', 'first', 'fifth', 'second', 'fourth'];
    if (maxBatch !== undefined) {
      fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: maxBatch }));
      f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Batch cap']);
    }
    for (const topic of topics) { f.lane(topic); f.add(topic); }
    // Hold delivery after integration to inspect the still-pending tail before
    // the worker can form its next batch.
    f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '10';
    fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, typedComposer);
    const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: path.join(f.root, topics[0]), env: f.env });
    const done = waitForExit(worker);
    try {
      const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
      await until(() => fs.existsSync(inbox) && readInbox(inbox).length === 1);
      const saved = f.queue.load(), firstSize = maxBatch ?? topics.length;
      assert.deepEqual(saved.current.jobs.map(job => job.topic), topics.slice(0, firstSize));
      assert.deepEqual(saved.pending.map(job => job.topic), topics.slice(firstSize));
      assert.equal(f.runs(), 1);
      for (const topic of topics.slice(firstSize)) assert.equal(fs.existsSync(path.join(f.repo, topic)), false);
      fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer);
      const r = await done; assert.equal(r.code, 0, r.stderr);
      const results = f.queue.load().results;
      assert.deepEqual(results.map(job => [job.topic, job.outcome]), topics.map(topic => [topic, 'promoted']));
      const batches = [...new Set(results.map(job => job.batch))];
      assert.deepEqual(batches.map(id => results.filter(job => job.batch === id).map(job => job.topic)),
        maxBatch === undefined ? [topics] : [topics.slice(0, 3), topics.slice(3)]);
      assert.equal(f.runs(), batches.length);
      assert.equal(f.queue.load().pending.length, 0); assert.equal(f.queue.load().current, null);
      assert.equal(f.git(['rev-list', '--merges', 'main']), '');
    } finally { fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer); await done; }
  });
}

test('invalid committed max_batch values refuse enqueue and drain without consuming pending lanes', t => {
  const f = fixture(t), workspace = f.lane('first'); f.add('first');
  const pending = f.queue.load().pending;
  for (const value of [0, -1, 1.5, '3', null, false, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: value }));
    f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Invalid cap fixture']);
    for (const args of [['second'], ['--drain']]) {
      const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), ...args], workspace);
      assert.equal(r.status, 1, `max_batch=${JSON.stringify(value)} ${r.stderr}`);
      assert.match(r.stderr, /promote max_batch must be a positive integer/);
      assert.deepEqual(f.queue.load().pending, pending);
      assert.equal(f.queue.load().current, null); assert.equal(f.runs(), 0);
      assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
      if (args[0] === '--drain') {
        const refusal = f.queue.load().refusal;
        assert.equal(refusal.code, 'PROMOTION_SETTINGS_INVALID');
        assert.deepEqual(refusal.pending, pending.map(job => job.id));
        const status = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--status']);
        assert.equal(status.status, 0, status.stderr);
        assert.deepEqual(JSON.parse(status.stdout).refusal, refusal);
      }
    }
  }
});

test('batch policy ignores untracked canonical config, uncommitted edits and lane copies', t => {
  const f = fixture(t), config = path.join(f.repo, '.promote.json');
  fs.writeFileSync(config, JSON.stringify({ max_batch: 0 }));
  assert.equal(f.drain().status, 0, 'an untracked file cannot set the cap');
  fs.writeFileSync(config, JSON.stringify({ max_batch: 1 }));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Committed cap']);
  const workspace = f.lane('first');
  fs.writeFileSync(config, JSON.stringify({ max_batch: 0 }));
  fs.writeFileSync(path.join(workspace, '.promote.json'), JSON.stringify({ max_batch: -1 }));
  f.git(['add', '.promote.json'], workspace); f.git(['commit', '-qm', 'Lane cap override'], workspace);
  const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], workspace);
  assert.equal(r.status, 0, r.stderr);
});

test('an unborn canonical branch uses default settings even with an untracked config', async t => {
  const f = fixture(t);
  f.git(['checkout', '--orphan', 'unborn']); f.git(['rm', '-rf', '.']);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: 0 }));
  const laneCLI = path.join(f.root, 'fake-lane.cjs');
  fs.writeFileSync(laneCLI, "console.error('lane: fixture refusal'); process.exit(1);\n");
  const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), 'missing-lane',
    '--lane-cli', laneCLI, '--herdr', path.join(f.root, 'herdr'), '--delivery-attempts', '1', '--retry-seconds', '0']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).worker.ready, true);
  await until(() => f.queue.load().results.length === 1);
  const result = f.queue.load().results[0];
  assert.equal(result.to, 'supervisor-herdr'); assert.equal(result.outcome, 'refused');
  assert.match(result.reason, /fixture refusal/);
  assert.equal(f.queue.load().refusal, undefined);
});

for (const command of ['rev-parse', 'ls-tree', 'show']) test(`a failed settings git ${command} retains a coded queue refusal and permits retry`, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: 1 }));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Batch cap']);
  const workspace = f.lane('first'); f.add('first'); f.lane('second'); f.add('second');
  const pending = f.queue.load().pending, before = f.git(['rev-parse', 'main']);
  const preload = path.join(f.root, 'fail-settings.cjs');
  fs.writeFileSync(preload, `const cp=require('node:child_process'),original=cp.spawnSync;
cp.spawnSync=function(cmd,args,options){
  if(process.argv.includes('--drain') && cmd==='git' && args[2]===${JSON.stringify(command)})
    return {status:128,stdout:'',stderr:'fatal: injected settings read failure'};
  return original.apply(this,arguments);
};\n`);
  const options = f.env.NODE_OPTIONS;
  f.env.NODE_OPTIONS = `${options ?? ''} --require=${JSON.stringify(preload)}`;
  const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), 'first',
    '--expected-head', pending[0].expectedHead]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /PROMOTION_SETTINGS_GIT_FAILED: cannot read committed promotion settings: fatal: injected settings read failure/);
  assert.match(r.stderr, /queued requests retained/);
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')));
  const saved = f.queue.load();
  assert.deepEqual(saved.pending, pending); assert.equal(saved.current, null);
  assert.equal(saved.refusal.outcome, 'refused'); assert.equal(saved.refusal.code, 'PROMOTION_SETTINGS_GIT_FAILED');
  assert.deepEqual(saved.refusal.pending, pending.map(job => job.id));
  assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), before);
  assert.ok(fs.existsSync(workspace));
  const status = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--status']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).refusal, saved.refusal);
  if (options === undefined) delete f.env.NODE_OPTIONS; else f.env.NODE_OPTIONS = options;
  const retried = f.drain(); assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(f.queue.load().results.map(job => [job.topic, job.outcome]), [['first', 'promoted'], ['second', 'promoted']]);
  assert.equal(f.queue.load().refusal, undefined);
});

for (const mode of ['invalid', 'git-failed']) test(`a ${mode} settings refusal after startup sends one queue notice and preserves the pending tail`, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: 1 }));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Batch cap']);
  const workspace = f.lane('first');
  if (mode === 'invalid') {
    fs.writeFileSync(path.join(workspace, '.promote.json'), JSON.stringify({ max_batch: 0 }));
    f.git(['add', '.promote.json'], workspace); f.git(['commit', '-qm', 'Invalid next batch cap'], workspace);
  } else {
    const preload = path.join(f.root, 'fail-second-settings.cjs');
    fs.writeFileSync(preload, `const cp=require('node:child_process'),original=cp.spawnSync;let reads=0;
cp.spawnSync=function(cmd,args,options){
  if(process.argv[1]===${JSON.stringify(path.join(source, 'promote/promote.mjs'))} && cmd==='git' && args[2]==='ls-tree' && ++reads===2)
    return {status:128,stdout:'',stderr:'fatal: injected mid-drain settings failure'};
  return original.apply(this,arguments);
};\n`);
    f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
  }
  f.add('first');
  for (const topic of ['second', 'third']) { f.lane(topic); f.add(topic); }
  const pending = f.queue.load().pending.slice(1);
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], {
    cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const done = waitForExit(worker), acknowledgements = [];
  worker.on('message', value => acknowledgements.push(value));
  const r = await done;
  const code = mode === 'invalid' ? 'PROMOTION_SETTINGS_INVALID' : 'PROMOTION_SETTINGS_GIT_FAILED';
  assert.equal(r.code, 1, r.stderr); assert.match(r.stderr, new RegExp(code));
  assert.deepEqual(acknowledgements, [{ ready: true }]);
  const saved = f.queue.load();
  assert.equal(saved.refusal.code, code); assert.equal(saved.refusal.delivered, true);
  assert.deepEqual(saved.refusal.pending, pending.map(job => job.id));
  assert.deepEqual(saved.pending, pending); assert.equal(saved.current, null);
  assert.deepEqual(saved.results.map(job => [job.topic, job.outcome]), [['first', 'promoted']]);
  assert.equal(f.runs(), 1);
  const messages = f.messages(); assert.equal(messages.length, 2);
  const refusals = messages.filter(args => args[3].includes(`code=${code}`));
  assert.equal(refusals.length, 1); assert.equal(refusals[0][2], 'test');
  for (const job of pending) assert.ok(refusals[0][3].includes(job.id));
  const notices = readInbox(path.join(f.repo, '.git/supervisor/inbox.log'));
  assert.equal(notices.filter(entry => entry.message.includes(`code=${code}`)).length, 1);
  assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
});

for (const command of ['rev-parse', 'ls-tree', 'show']) test(`a settings git ${command} timeout releases the queue for enqueuers and retains a coded refusal`, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: 1 }));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Batch cap']);
  for (const topic of ['first', 'second']) f.lane(topic);
  f.add('first');
  const marker = path.join(f.root, 'settings-wait'), preload = path.join(f.root, 'slow-settings.cjs');
  // Observe the deadline's actual load inputs without taking another sample or
  // changing the worker's allowance.
  fs.writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os'),original=cp.spawnSync;
const loadavg=os.loadavg,availableParallelism=os.availableParallelism;let load,parallelism;
os.loadavg=function(){const values=loadavg.apply(this,arguments);load=values[0];return values;};
os.availableParallelism=function(){parallelism=availableParallelism.apply(this,arguments);return parallelism;};
cp.spawnSync=function(cmd,args,options){
  if(process.argv[1]===${JSON.stringify(path.join(source, 'promote/promote.mjs'))} && cmd==='git' && args[2]===${JSON.stringify(command)}) {
    const temporary=${JSON.stringify(marker)}+'.'+process.pid+'.'+Math.random().toString(36).slice(2)+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify({timeout:options.timeout,load,parallelism,locked:fs.existsSync(${JSON.stringify(path.join(f.queue.directory, 'queue.lock'))})}));
    fs.renameSync(temporary,${JSON.stringify(marker)});
    return original.call(this,process.execPath,['-e','setTimeout(()=>{},60000)'],options);
  }
  return original.apply(this,arguments);
};\n`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], {
    cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const done = waitForExit(worker), acknowledgements = [];
  worker.on('message', value => acknowledgements.push(value));
  await until(() => fs.existsSync(marker));
  const waiting = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(waiting.locked, false);
  // Reuse the inputs sampled for the worker's deadline, including for later Git
  // reads sharing that deadline. A fresh load sample can fall before we get here.
  assert.ok(Number.isFinite(waiting.load) && Number.isInteger(waiting.parallelism) && waiting.parallelism > 0);
  const settingsAllowance = loadTimeout(2000, loadFactor(waiting.load, waiting.parallelism));
  assert.ok(Number.isInteger(waiting.timeout) && waiting.timeout > 0 && waiting.timeout <= settingsAllowance);
  f.add('second'); // Must succeed while the settings subprocess is still waiting.
  assert.equal(worker.exitCode, null);
  const pending = f.queue.load().pending;
  const r = await done;
  assert.equal(r.code, 1, r.stderr); assert.match(r.stderr, /PROMOTION_SETTINGS_GIT_FAILED.*ETIMEDOUT/);
  const saved = f.queue.load();
  assert.deepEqual(saved.pending, pending); assert.equal(saved.current, null);
  assert.equal(saved.refusal.code, 'PROMOTION_SETTINGS_GIT_FAILED');
  assert.deepEqual(saved.refusal.pending, pending.map(job => job.id));
  assert.equal(acknowledgements.length, 1); assert.equal(acknowledgements[0].ready, false);
  assert.deepEqual(acknowledgements[0].refusal, saved.refusal);
  assert.equal(f.runs(), 0); assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
});

test('settings are read once for each new batch and not for an empty queue', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ max_batch: 1 }));
  f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Batch cap']);
  for (const topic of ['first', 'second']) { f.lane(topic); f.add(topic); }
  const trace = path.join(f.root, 'settings-reads'), preload = path.join(f.root, 'trace-settings.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process'),original=cp.spawnSync;
cp.spawnSync=function(cmd,args,options){
  if(process.argv[1]===${JSON.stringify(path.join(source, 'promote/promote.mjs'))} && cmd==='git' && ['ls-tree','show'].includes(args[2]))
    fs.appendFileSync(${JSON.stringify(trace)},args[2]+'\\n');
  return original.apply(this,arguments);
};\n`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), ['ls-tree', 'show', 'ls-tree', 'show']);
  assert.equal(f.runs(), 2);
  const empty = f.drain(); assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), ['ls-tree', 'show', 'ls-tree', 'show']);
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

test('unprofiled batch waits before its project lock and proceeds when memory clears', async t => {
  const f = fixture(t); f.lane('memory'); f.add('memory');
  const memory = promotionMemoryFixture(f, 'unused'); memory.set(pressuredMemory);
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    await until(() => {
      const batch = f.queue.load().current;
      const log = batch && path.join(f.queue.directory, 'batches', batch.id, 'train.log');
      return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('waiting; memory pressure');
    });
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    assert.equal(fs.existsSync(f.env.MONITOR_TEST_SLOT_PATH), false); assert.equal(f.runs(), 0);
    memory.set(healthyMemory);
    const r = await done; assert.equal(r.code, 0, r.stderr);
    assert.equal(f.queue.load().results[0].outcome, 'promoted'); assert.equal(f.runs(), 1);
  } finally { memory.set(healthyMemory); await done; }
});

for (const clear of [false, true]) test(`unprofiled memory re-check ${clear ? 'proceeds on clearing' : 'refuses with a code and releases the project lock'}`, async t => {
  const f = fixture(t), workspace = f.lane('memory'); f.add('memory');
  const before = f.git(['rev-parse', 'main']), head = f.git(['rev-parse', 'HEAD'], workspace);
  const memory = promotionMemoryFixture(f, 'project-lock');
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(memory.ready));
    assert.ok(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')));
    if (clear) memory.set(healthyMemory);
    const r = await done; assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    const saved = f.queue.load(), result = saved.results[0];
    assert.equal(result.outcome, clear ? 'promoted' : 'refused'); assert.equal(saved.current, null);
    assert.equal(saved.interrupted?.length ?? 0, 0);
    if (clear) { assert.equal(f.runs(), 1); return; }
    assert.equal(result.code, 'PROMOTION_MEMORY_PRESSURE'); assert.equal(result.gate, undefined);
    assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), before);
    assert.equal(f.git(['rev-parse', 'HEAD'], workspace), head);
    const plan = JSON.parse(fs.readFileSync(result.receipt));
    assert.equal(plan.attempts?.length ?? 0, 0); assert.deepEqual(plan.groups, []); assert.equal(plan.phase, 'complete');
    assert.ok(f.messages().some(args => args[3].includes('outcome=refused code=PROMOTION_MEMORY_PRESSURE')));
    memory.set(healthyMemory); const [retry] = f.add('memory'); assert.notEqual(retry.id, result.id);
    const resumed = f.drain(); assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(f.queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.runs(), 1);
  } finally { memory.set(healthyMemory); await done; }
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
  // The append is visible before journal-lock release. Park after release so
  // SIGKILL cannot strand an unidentified lock between owner unlink and rmdir.
  const parked = path.join(f.root, 'notice-queued'), preload = path.join(f.root, 'park-notice.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),rmdir=fs.rmdirSync;
fs.rmdirSync=function(directory,...args){
 const result=rmdir.call(this,directory,...args);
 if(directory===${JSON.stringify(`${inbox}.lock`)}){
  fs.writeFileSync(${JSON.stringify(`${parked}.tmp`)},JSON.stringify({pid:process.pid}));
  fs.renameSync(${JSON.stringify(`${parked}.tmp`)},${JSON.stringify(parked)});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${loadTimeout(60000)});
 }
 return result;
};`);
  const worker = spawnChild(t, process.execPath, ['--require', preload, path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker); let resumedDone;
  try {
    await until(() => fs.existsSync(parked));
    assert.equal(readInbox(inbox).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(parked)).pid, worker.pid);
    assert.equal(fs.existsSync(`${inbox}.lock`), false, 'the queued notice has released its journal lock');
    const queued = readInbox(inbox)[0], saved = f.queue.load().current, integrated = f.git(['rev-parse', 'main']);
    assert.deepEqual(f.messages(), []); assert.equal(f.runs(), 1);
    assert.equal(fs.existsSync(path.join(f.root, 'first')), false, 'cleanup completed before the notice was queued');
    assert.equal(worker.kill('SIGKILL'), true); await done;
    const lock = path.join(f.queue.directory, 'worker.lock'), owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
    assert.equal(owner.pid, worker.pid); assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(lock, { recursive: true });
    const resumed = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    resumedDone = waitForExit(resumed);
    // An actual early exit/error is evidence, not an indefinitely pending
    // readiness promise that cancels the remainder of this test file.
    const ready = Promise.race([
      new Promise((resolve, reject) => { resumed.once('message', resolve); resumed.once('error', reject); }),
      resumedDone.then(result => { throw Error(`resumed train exited before readiness: ${JSON.stringify(result)}`); }),
    ]);
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
  } finally { fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, emptyComposer); worker.kill('SIGKILL'); await done; if (resumedDone) await resumedDone; }
});

test('interrupted validation preserves main and drain resumes the batch', async t => {
  const f = fixture(t); f.lane('first'); f.lane('second'); f.add('first'); f.add('second');
  const before = f.git(['rev-parse', 'main']), marker = path.join(f.root, 'killed');
  fs.writeFileSync(f.checker, `const fs=require('fs'),temporary=${JSON.stringify(marker)}+'.'+process.pid+'.'+Math.random().toString(36).slice(2)+'.tmp';fs.writeFileSync(temporary,JSON.stringify({pid:process.pid}));fs.renameSync(temporary,${JSON.stringify(marker)});setTimeout(()=>{},60000);`);
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

function diagnoseTrain(t, f) {
  const saved = f.queue.load();
  t.diagnostic(`promotion queue at failure:\n${JSON.stringify(saved, null, 2)}`);
  const files = new Set(saved.results.flatMap(result => [result.receipt, result.log]).filter(Boolean));
  for (const file of files) t.diagnostic(`${path.basename(file)} at failure:\n${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(missing)'}`);
}

test('a train waits for a short closeout holder and completes without an interrupted batch', async t => {
  const f = fixture(t), workspace = f.lane('first'); f.add('first');
  const lock = path.join(f.repo, '.git/lane-promote.lock'), release = acquireLock(lock);
  const owner = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
  const waiting = watchPromotionLock(f.root, f.env, lock);
  const child = spawnScenarioChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(child);
  try {
    try {
      await until(() => fs.existsSync(waiting));
      // A fake closeout pass keeps its real lock for three seconds after the
      // train reaches acquisition, longer than immediate refusal could survive.
      await new Promise(resolve => setTimeout(resolve, 3000));
      assert.equal(child.exitCode, null);
      assert.equal(f.runs(), 0);
      assert.equal(f.queue.load().results.length, 0);
      assert.equal(f.queue.load().interrupted?.length ?? 0, 0);
      assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
      assert.ok(fs.existsSync(workspace));
    } finally { release(); await done; }
    const result = await done; assert.equal(result.code, 0, result.stderr);
    const saved = f.queue.load();
    assert.deepEqual(saved.results.map(r => r.outcome), ['promoted']);
    assert.equal(saved.interrupted?.length ?? 0, 0); assert.equal(saved.current, null);
    assert.equal(f.runs(), 1); assert.equal(fs.existsSync(workspace), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'first'), 'utf8'), 'first');
    assert.ok(f.messages().every(message => !message[3].includes('outcome=interrupted')));
  } catch (error) { diagnoseTrain(t, f); throw error; }
});

test('a holder past the promotion wait bound keeps the refusal and interrupted recovery', t => {
  const f = fixture(t); f.lane('first'); f.add('first');
  const lock = path.join(f.repo, '.git/lane-promote.lock');
  const base = f.git(['rev-parse', 'main']), release = acquireLock(lock);
  const owner = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
  const waiting = watchPromotionLock(f.root, f.env, lock, { expire: true });
  try {
    try {
      const r = f.drain(); assert.equal(r.status, 0, r.stderr);
      assert.equal(f.queue.load().results[0].outcome, 'interrupted'); assert.equal(f.queue.load().results[0].delivered, true);
      assert.ok(fs.existsSync(waiting), 'the real train acquisition waited before its deadline expired');
      assert.ok(fs.readFileSync(f.queue.load().results[0].log, 'utf8').includes(`lane: locked: ${lock}; inspect owner.json and surviving processes before removing a stale lock`));
      assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
      assert.equal(f.git(['rev-parse', 'main']), base); assert.equal(f.runs(), 0);
      assert.equal(f.drain().status, 0); assert.equal(f.queue.load().interrupted.length, 1);
      assert.equal(f.queue.load().results.at(-1).delivery_id, f.queue.load().results[0].delivery_id);
    } finally { release(); }
    const r = f.drain(); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.runs(), 1);
  } catch (error) { diagnoseTrain(t, f); throw error; }
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

function noRetryFixture(f, redAppend = false) {
  const recipe = new URL('../../test/helpers/bootstrap-gate.mjs', import.meta.url).href;
  const appended = path.join(f.root, 'append-runs');
  f.env.MONITOR_PROMOTION_NO_RETRIES = '0';
  f.env.MONITOR_TEST_SLOT_TIMEOUT_RETRIED = '0';
  fs.writeFileSync(f.checker, `const fs=require('fs');
import(${JSON.stringify(recipe)}).then(({requireNoRetries})=>{
 requireNoRetries();fs.appendFileSync(${JSON.stringify(path.join(f.root, 'checks'))},'gate\\n');console.log('# tests 1\\n# pass 1');
});`);
  fs.writeFileSync(path.join(f.repo, 'planner.mjs'), `import fs from 'node:fs';
import {requireNoRetries} from ${JSON.stringify(recipe)};
if(process.argv[2]==='--plan') console.log(JSON.stringify({files:['extra.test.mjs']}));
else {
 requireNoRetries();fs.appendFileSync(${JSON.stringify(appended)},'append\\n');
 ${redAppend ? "console.error('testTimeoutFailure');process.exitCode=124;" : "console.log('# tests 1\\n# pass 1');"}
}`);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${f.checker}`, promotion_tests: 'planner.mjs' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare no-retry planner fixture']);
  return { validate: `MONITOR_PROMOTION_NO_RETRIES=1 ${process.execPath} ${f.checker}`, appended };
}

test('a bare enqueue starts a request-scoped no-retry recipe and its sibling append without caller settings', async t => {
  const f = fixture(t), { validate, appended } = noRetryFixture(f);
  const workspace = f.lane('bare');
  const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), 'bare', '--validate', validate,
    '--expected-head', f.git(['rev-parse', 'HEAD'], workspace), '--lane-cli', path.join(source, 'lanes/lane.mjs'),
    '--herdr', path.join(f.root, 'herdr'), '--delivery-attempts', '1', '--retry-seconds', '0']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(JSON.parse(r.stdout).worker.ready, true);
  await until(() => f.queue.load().results.some(row => row.outcome === 'promoted'));
  const result = f.queue.load().results.at(-1);
  assert.equal(result.validate, validate); assert.equal(f.runs(), 1);
  assert.equal(fs.readFileSync(appended, 'utf8'), 'append\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'bare'), 'utf8'), 'bare');
});

test('bare resume restores the saved no-retry declaration for both steps after a prepared interruption', async t => {
  const f = fixture(t), { validate, appended } = noRetryFixture(f);
  f.lane('first'); f.lane('second'); f.add('first', { validate }); f.add('second', { validate });
  const jobs = f.queue.load().pending;
  const delivery = job => ({ herdr: job.herdr, to: job.to, attempts: job.attempts, retry: job.retry });
  const expectedDelivery = { herdr: path.join(f.root, 'herdr'), to: 'test', attempts: 1, retry: 0 };
  assert.deepEqual(jobs.map(delivery), [expectedDelivery, expectedDelivery]);
  const before = f.git(['rev-parse', 'main']);
  interruptAt(f, 'prepared'); assert.equal(f.drain().status, 0);
  const interrupted = f.queue.load();
  assert.deepEqual(interrupted.results.map(row => row.outcome), ['interrupted', 'interrupted']);
  assert.deepEqual(interrupted.interrupted[0].jobs.map(delivery), [expectedDelivery, expectedDelivery]);
  const receipt = interrupted.results[0].receipt;
  const prepared = JSON.parse(fs.readFileSync(receipt));
  assert.equal(interrupted.interrupted[0].native_refusal, undefined);
  assert.equal(prepared.attempts.length, 1); assert.equal(prepared.attempts[0].phase, 'prepared');
  assert.equal(prepared.attempts[0].gate, undefined);
  assert.equal(f.git(['rev-parse', 'main']), before); assert.equal(f.runs(), 0);
  assert.equal(fs.existsSync(appended), false);
  const resumed = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--resume']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).worker.ready, true);
  // Native guarded cleanup runs before each result is published. Wait for the
  // acknowledged finite worker, using the same bounded lifetime as teardown,
  // rather than timing out a healthy resumed train at the notice poll's 10 s.
  await f.wait();
  assert.equal(f.runs(), 1); assert.equal(fs.readFileSync(appended, 'utf8'), 'append\n');
  const completed = f.queue.load();
  assert.equal(completed.current, null); assert.equal(completed.interrupted.length, 0);
  assert.ok(completed.results.every(row => row.validate === validate));
  const promoted = completed.results.slice(interrupted.results.length);
  assert.deepEqual(promoted.map(row => [row.id, row.outcome]), jobs.map(job => [job.id, 'promoted']));
  assert.deepEqual(promoted.map(delivery), [expectedDelivery, expectedDelivery]);
  const notices = readInbox(path.join(f.repo, '.git/supervisor/inbox.log'));
  assert.deepEqual(notices.map(row => [row.herdr, row.to, row.attempts, row.retrySeconds]),
    Array.from({ length: 4 }, () => [expectedDelivery.herdr, 'test', 1, 0]));
  assert.deepEqual(notices.map(row => row.state), ['sent', 'sent', 'sent', 'sent']);
  assert.equal(f.messages().length, 4);
  const final = JSON.parse(fs.readFileSync(receipt));
  assert.equal(final.native_context.ok, true); assert.equal(final.phase, 'complete');
  assert.equal(final.attempts.length, 1); assert.equal(final.attempts[0].phase, 'complete');
  assert.equal(final.attempts[0].tip, prepared.attempts[0].tip);
  assert.equal(final.attempts[0].gate.exit_code, 0); assert.equal(final.attempts[0].gate.reused, false);
  assert.equal(final.attempts[0].gate.executed, true);
  for (const topic of ['first', 'second']) assert.equal(fs.readFileSync(path.join(f.repo, topic), 'utf8'), topic);
});

test('a red no-retry append refuses every batch member without bisecting or replaying completed groups', t => {
  const f = fixture(t), { validate, appended } = noRetryFixture(f, true);
  const before = f.git(['rev-parse', 'main']);
  for (const topic of ['first', 'second', 'third']) { f.lane(topic); f.add(topic, { validate }); }
  assert.equal(f.drain().status, 0);
  const results = f.queue.load().results;
  assert.equal(results.length, 3); assert.ok(results.every(row => row.outcome === 'refused' && /no-retry command forbids bisection/.test(row.reason)));
  assert.equal(f.runs(), 1); assert.equal(fs.readFileSync(appended, 'utf8'), 'append\n');
  assert.equal(JSON.parse(fs.readFileSync(results[0].receipt)).attempts.length, 1);
  assert.equal(f.git(['rev-parse', 'main']), before);
  for (const topic of ['first', 'second', 'third']) assert.ok(fs.existsSync(path.join(f.root, topic)));
});

test('affected test supplements run once in the batch gate, are recorded and block a red landing', t => {
  const f = fixture(t);
  const planner = `import fs from 'node:fs';
if(process.argv[2]==='--plan') console.log(JSON.stringify({files:['extra.test.mjs'],deferred:[{file:'slow.test.mjs',reason:'time-budget',estimated_ms:342215,estimate:'measured',destination:'release-candidate'}],budget:{time_ms:300000,max_files:10,unknown_file_ms:60000,estimated_ms:1000},graph:{max_suite_files:4}}));
else { fs.appendFileSync(${JSON.stringify(path.join(f.root, 'extra-runs'))},'run\\n'); if(fs.existsSync('red-extra')) process.exitCode=1; }
`;
  fs.writeFileSync(path.join(f.repo, 'planner.mjs'), planner);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${f.checker}`, promotion_tests: 'planner.mjs' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare affected test planner']);
  f.lane('first'); f.lane('second'); f.add('first'); f.add('second');
  assert.equal(f.drain().status, 0);
  assert.equal(f.runs(), 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'extra-runs'), 'utf8').trim().split('\n').length, 1);
  const landed = f.queue.load().results[0];
  const plan = JSON.parse(fs.readFileSync(landed.receipt));
  assert.deepEqual(plan.attempts[0].test_plan.files, ['extra.test.mjs']);
  assert.deepEqual(plan.attempts[0].test_plan.deferred.map(row => [row.file, row.reason, row.destination]), [['slow.test.mjs', 'time-budget', 'release-candidate']]);
  assert.equal(plan.attempts[0].test_plan.budget.time_ms, 300000);
  assert.ok(plan.attempts[0].test_plan.changed.includes('first'));
  assert.ok(plan.attempts[0].test_plan.changed.includes('second'));
  assert.match(plan.attempts[0].gate.command, /--run/);
  const bad = f.lane('extra-red');
  fs.writeFileSync(path.join(bad, 'red-extra'), 'red'); f.git(['add', '.'], bad); f.git(['commit', '-qm', 'Red supplemental test'], bad);
  f.add('extra-red'); assert.equal(f.drain().status, 0);
  assert.equal(f.queue.load().results.at(-1).outcome, 'refused');
  assert.equal(fs.existsSync(path.join(f.repo, 'red-extra')), false);
});

for (const selected of [true, false]) test(`a lane-modified planner cannot ${selected ? 'shrink' : 'invent'} canonical bound test coverage`, t => {
  const f = fixture(t), required = 'required.test.mjs';
  const marker = path.join(f.root, 'lane-planner-ran'), runs = path.join(f.root, 'required-runs');
  const runner = `else { fs.appendFileSync(${JSON.stringify(runs)},'run\\n'); process.exitCode=1; }`;
  fs.writeFileSync(path.join(f.repo, 'coverage.mjs'), `export const files=${JSON.stringify(selected ? [required] : [])};\n`);
  fs.writeFileSync(path.join(f.repo, 'planner.mjs'), `import fs from 'node:fs'; import { files } from './coverage.mjs';
if(process.argv[2]==='--plan') {
  if(!fs.existsSync('deferred') || !JSON.parse(process.argv[3]).includes('planner.mjs')) process.exit(1);
  console.log(JSON.stringify({files,covered:[]}));
} ${runner}\n`);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${f.checker}`, promotion_tests: 'planner.mjs' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare canonical bound coverage']);
  const base = f.git(['rev-parse', 'main']), workspace = f.lane('deferred');
  fs.writeFileSync(path.join(workspace, 'coverage.mjs'), `export const files=[];\n`);
  fs.writeFileSync(path.join(workspace, 'planner.mjs'), `import fs from 'node:fs'; import { files } from './coverage.mjs';
if(process.argv[2]==='--plan') {
  fs.writeFileSync(${JSON.stringify(marker)},'ran');
  console.log(JSON.stringify({files,covered:[${JSON.stringify(required)}]}));
} ${runner}\n`);
  f.git(['add', '.'], workspace); f.git(['commit', '-qm', 'Forge lane planner coverage'], workspace);
  const head = f.git(['rev-parse', 'HEAD'], workspace);
  f.add('deferred', { requiredTests: [required] });
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const result = f.queue.load().results[0], attempt = JSON.parse(fs.readFileSync(result.receipt)).attempts[0];
  assert.equal(result.outcome, 'refused');
  assert.equal(fs.existsSync(marker), false, 'planning never executes the lane planner');
  assert.equal(attempt.base, base);
  assert.deepEqual(attempt.test_plan.files, selected ? [required] : []);
  assert.deepEqual(attempt.test_plan.covered, []);
  assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(f.git(['rev-parse', 'HEAD'], workspace), head);
  assert.equal(f.runs(), selected ? 1 : 0);
  if (selected) {
    assert.equal(fs.readFileSync(runs, 'utf8'), 'run\n', 'the required supplemental test executes once');
    assert.match(result.reason, /batch validation failed/);
    assert.equal(attempt.gate.exit_code, 1);
  } else {
    assert.equal(fs.existsSync(runs), false);
    assert.match(result.reason, /no longer covers/);
    assert.equal(attempt.gate, undefined);
  }
});

test('a changed gate cannot omit a bound deferred test file', t => {
  const f = fixture(t), base = f.git(['rev-parse', 'main']);
  f.lane('deferred'); f.add('deferred', { requiredTests: ['required.test.mjs'] });
  assert.throws(() => f.add('deferred', { requiredTests: [] }), /different head or run binding/);
  assert.equal(f.drain().status, 0);
  const saved = f.queue.load();
  assert.equal(saved.results[0].outcome, 'refused');
  assert.match(saved.results[0].reason, /no longer covers/);
  assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(f.runs(), 0);
});

test('canonical planning receives the union of bound required files and executes them beyond the extra cap', t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'required-runs');
  const planner = `import fs from 'node:fs';
if(process.argv[2]==='--plan') {
  const required = JSON.parse(process.argv[5]);
  console.log(JSON.stringify({files:required,selected:required.map(file=>({file,reason:'bound-required',estimated_ms:342215,estimate:'measured'})),
    deferred:[{file:'optional.test.mjs',reason:'time-budget',estimated_ms:60000,estimate:'fallback',destination:'release-candidate'}],
    budget:{time_ms:1,max_files:1,unknown_file_ms:60000,estimated_ms:required.length*342215,required_over_budget:true}}));
} else fs.appendFileSync(${JSON.stringify(marker)},process.argv[3]+'\\n');`;
  fs.writeFileSync(path.join(f.repo, 'planner.mjs'), planner);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${f.checker}`, promotion_tests: 'planner.mjs' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare capped canonical planner']);
  const first = f.lane('first'); f.lane('second');
  // A candidate planner tries to omit bound evidence. The canonical plan must
  // retain it; the run branch still accepts the captured selection.
  fs.writeFileSync(path.join(first, 'planner.mjs'), planner.replace('const required = JSON.parse(process.argv[5]);', 'const required = [];'));
  f.git(['add', '.'], first); f.git(['commit', '-qm', 'Attempt to shrink required coverage'], first);
  f.add('first', { requiredTests: ['first.test.mjs'] });
  f.add('second', { requiredTests: ['second.test.mjs', 'first.test.mjs'] });
  const result = f.drain(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.queue.load().results.map(row => row.outcome), ['promoted', 'promoted']);
  const receipt = JSON.parse(fs.readFileSync(f.queue.load().results[0].receipt));
  const plan = receipt.attempts[0].test_plan;
  assert.deepEqual(plan.required, ['first.test.mjs', 'second.test.mjs']);
  assert.deepEqual(plan.files, plan.required);
  assert.equal(plan.budget.required_over_budget, true);
  assert.equal(plan.selected.every(row => row.reason === 'bound-required'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8').trim()), plan.required);
  assert.equal(f.runs(), 1);
});

for (const capability of ['PTY', 'loopback', 'process source']) test(`native ${capability} refusal is coded in the batch and notice without running or relaunching a gate`, t => {
  const f = fixture(t); f.lane('sandbox'); f.add('sandbox');
  const base = f.git(['rev-parse', 'main']), preload = path.join(f.root, 'native-refusal.cjs'), starts = path.join(f.root, 'drain-starts');
  const deny = capability === 'PTY'
    ? "const open=fs.openSync;fs.openSync=function(file,...args){if(file==='/dev/ptmx')throw Object.assign(new Error('native sandbox refusal'),{code:'EPERM'});return open.call(this,file,...args);};"
    : capability === 'loopback' ? "require('net').Server.prototype.listen=function(){setImmediate(()=>this.emit('error',Object.assign(new Error('native sandbox refusal'),{code:'EPERM'})));return this;};"
    : "const cp=require('child_process'),spawn=cp.spawnSync,list=fs.readdirSync;cp.spawnSync=function(file,...args){if(String(file).includes('process-source-')&&new Error().stack.includes('probeNativeGate'))return {status:125,stdout:'',stderr:'native fixture EPERM'};return spawn.call(this,file,...args);};fs.readdirSync=function(file,...args){if(String(file)==='/proc'&&new Error().stack.includes('probeNativeGate'))throw Object.assign(new Error('native fixture EPERM'),{code:'EPERM'});return list.call(this,file,...args);};require('module').syncBuiltinESMExports();";
  fs.writeFileSync(preload, `const fs=require('fs');if(process.argv.includes('--drain'))fs.appendFileSync(${JSON.stringify(starts)},'drain\\n');${deny}`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require ${preload}`;
  const r = f.drain(); assert.equal(r.status, 0, r.stderr);
  const job = f.queue.load().results[0], plan = JSON.parse(fs.readFileSync(job.receipt));
  assert.equal(job.outcome, 'refused'); assert.equal(job.code, capability === 'PTY' ? 'PROMOTE_NATIVE_PTMX_REFUSED' : capability === 'loopback' ? 'PROMOTE_NATIVE_LOOPBACK_REFUSED' : 'PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED');
  assert.match(plan.native_context.error, /EPERM/); assert.equal(plan.phase, 'complete'); assert.equal(plan.attempts?.length ?? 0, 0);
  assert.equal(f.runs(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(fs.readFileSync(starts, 'utf8'), 'drain\n');
  assert.ok(f.messages().some(args => args[3].includes(`code=${job.code}`)));
  assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
});
test('existing-worker enqueue refuses an absent worker atomically and never starts one', t => {
  const f = fixture(t); f.lane('alone');
  const r = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), 'alone', '--existing-worker', '--repo', f.repo]);
  assert.equal(r.status, 1); assert.match(r.stderr, /AUTOPILOT_NO_NATIVE_WORKER/);
  assert.equal(f.queue.load().pending.length, 0); assert.equal(f.queue.load().current, null);
  assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.log')), false); assert.equal(f.runs(), 0);
  const resume = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--existing-worker', '--resume', '--repo', f.repo]);
  assert.equal(resume.status, 1); assert.match(resume.stderr, /enqueue-only/);
  assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.log')), false);
});

for (const context of ['worker', 'host']) test(`native refusal in the ${context} preserves a prior validated checkpoint until explicit resume`, async t => {
  const f = fixture(t);
  if (context === 'host') {
    fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ gate: {} }));
    f.git(['add', '.promote.json']); f.git(['commit', '-qm', 'Declare host adapter']);
  }
  f.lane('alone'); f.add('alone'); const base = f.git(['rev-parse', 'main']);
  interruptAt(f, 'validated'); assert.equal(f.drain().status, 0); assert.equal(f.runs(), 1);
  const first = f.queue.load().results[0], before = JSON.parse(fs.readFileSync(first.receipt));
  assert.equal(before.attempts[0].phase, 'validated');
  const preload = path.join(f.root, 'native-refusal.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),open=fs.openSync;fs.openSync=function(file,...args){if(file==='/dev/ptmx'&&(${JSON.stringify(context)}==='worker'||process.argv[1]?.endsWith('host-gate.mjs')))throw Object.assign(new Error('native sandbox refusal'),{code:'EPERM'});return open.call(this,file,...args);};`);
  const originalOptions = f.env.NODE_OPTIONS;
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require ${preload}`;
  const refused = f.drain(); assert.equal(refused.status, 0, refused.stderr || refused.stdout);
  const job = f.queue.load().results.at(-1), after = JSON.parse(fs.readFileSync(job.receipt));
  assert.equal(job.code, 'PROMOTE_NATIVE_PTMX_REFUSED'); assert.equal(job.outcome, 'interrupted');
  assert.deepEqual(after.attempts, before.attempts); assert.equal(after.native_context.ok, false);
  assert.equal(f.runs(), 1); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(f.queue.load().interrupted[0].native_refusal.code, 'PROMOTE_NATIVE_PTMX_REFUSED');
  if (context === 'worker') {
    const deniedResume = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--resume']);
    assert.equal(deniedResume.status, 1); assert.match(deniedResume.stderr, /PROMOTE_NATIVE_PTMX_REFUSED/);
    assert.equal(f.queue.load().interrupted[0].native_refusal.code, 'PROMOTE_NATIVE_PTMX_REFUSED');
    assert.deepEqual(JSON.parse(fs.readFileSync(job.receipt)).attempts, before.attempts);
    assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
  }
  // A healthy worker may process a different request without adopting the
  // native-refused attempt as ordinary interrupted recovery.
  f.env.NODE_OPTIONS = originalOptions;
  f.lane('later'); f.add('later'); const later = f.drain(); assert.equal(later.status, 0, later.stderr);
  const last = f.queue.load().results.at(-1);
  assert.equal(last.outcome, 'promoted', `${last.code ?? ''}: ${last.reason}`); assert.equal(f.runs(), 2);
  assert.equal(fs.existsSync(path.join(f.repo, 'alone')), false); assert.equal(fs.existsSync(path.join(f.repo, 'later')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(job.receipt)).attempts, before.attempts);
  assert.equal(f.queue.load().interrupted.length, 1);
  const resumed = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--resume']);
  assert.equal(resumed.status, 0, resumed.stderr);
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')));
  const completed = f.queue.load(), final = JSON.parse(fs.readFileSync(job.receipt));
  assert.equal(final.native_resumptions.at(-1).refusal.code, 'PROMOTE_NATIVE_PTMX_REFUSED');
  assert.equal(final.native_resumptions.at(-1).native_context.ok, true);
  assert.equal(completed.interrupted.length, 0, JSON.stringify(completed.interrupted));
  assert.equal(queueJobs(completed).find(row => row.id === job.id).outcome, 'promoted');
  assert.equal(fs.existsSync(path.join(f.repo, 'alone')), true);
  assert.equal(fs.existsSync(path.join(f.repo, 'later')), true);
  assert.equal(final.attempts[0].gate.started_at, before.attempts[0].gate.started_at, 'old validation evidence retained');
  assert.equal(f.runs(), 3, 'changed main requires one new gate');
});

test('explicit native resume completes an unchanged validated batch without another gate', async t => {
  const f = fixture(t); f.lane('alone'); f.add('alone');
  interruptAt(f, 'validated'); assert.equal(f.drain().status, 0); assert.equal(f.runs(), 1);
  const first = f.queue.load().results[0], before = JSON.parse(fs.readFileSync(first.receipt));
  const preload = path.join(f.root, 'refuse-pty.cjs');
  fs.writeFileSync(preload, "const fs=require('fs'),open=fs.openSync;fs.openSync=function(file,...args){if(file==='/dev/ptmx')throw Object.assign(new Error('fixture refusal'),{code:'EPERM'});return open.call(this,file,...args);};");
  const originalOptions = f.env.NODE_OPTIONS;
  f.env.NODE_OPTIONS = `${originalOptions ?? ''} --require ${preload}`;
  assert.equal(f.drain().status, 0);
  assert.equal(f.queue.load().interrupted[0].native_refusal.code, 'PROMOTE_NATIVE_PTMX_REFUSED');
  f.env.NODE_OPTIONS = originalOptions;
  const resumed = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--resume']);
  assert.equal(resumed.status, 0, resumed.stderr);
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')));
  assert.equal(f.queue.load().interrupted.length, 0); assert.equal(f.runs(), 1);
  assert.equal(queueJobs(f.queue.load()).find(row => row.id === first.id).outcome, 'promoted');
  const final = JSON.parse(fs.readFileSync(first.receipt));
  assert.equal(final.native_resumptions.at(-1).refusal.code, 'PROMOTE_NATIVE_PTMX_REFUSED');
  assert.equal(final.native_resumptions.at(-1).native_context.ok, true);
  assert.equal(final.attempts[0].gate.started_at, before.attempts[0].gate.started_at);
  assert.equal(final.attempts[0].phase, 'complete');
});
