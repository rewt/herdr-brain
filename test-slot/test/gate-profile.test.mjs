import { provingRun } from './helpers/proving.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordHealthyGate, gateHistoryKey, historyFile } from '../limits.mjs';
import { resolveGateProfile } from '../../promote/gate-profile.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { enqueue, queueFor } from '../../promote/promote.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { healthyMemoryEnvironment, promotionMemoryFixture, healthyMemory, pressuredMemory } from '../../test/helpers/promotion-memory-fixture.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';

import { fixture } from './helpers/gate-profile.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const slotCLI = path.join(source, 'test-slot/test-slot.mjs');
const kernelLockOptions = { skip: !fs.existsSync('/bin/zsh') && 'external kernel-lock tests require /bin/zsh' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, diagnostics = () => '') {
  const deadline = Date.now() + loadTimeout(10000);
  while (Date.now() < deadline) { if (fn()) return; await pause(25); }
  assert.fail(`fixture did not become ready: ${diagnostics()}`);
}

async function holdSlot(t, f) {
  const ready = path.join(f.root, 'slot-ready');
  // A legacy holder intentionally has no proving reservation. These cases
  // exercise the slot queue after the launch gate, not the proving pause.
  const owner = spawnChild(t, process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';import {acquireTestSlot} from ${JSON.stringify(new URL('../test-slot.mjs', import.meta.url).href)};
    const slot=await acquireTestSlot('fixture owner',{lockPath:${JSON.stringify(f.slot)}});
    for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{slot.release();process.exit(0);});
    fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { env: f.env });
  await until(() => fs.existsSync(ready));
  return { release: async () => { owner.kill('SIGTERM'); await waitForExit(owner); } };
}

async function waitForSlotWait(worker) {
  let stderr = '';
  worker.stderr.on('data', data => { stderr += String(data); });
  await until(() => stderr.includes('TEST_SLOT_WAIT:') || worker.exitCode !== null);
  assert.match(stderr, /TEST_SLOT_WAIT:/, 'the host adapter reaches the slot wait');
}

test('a default profile fixture promotes despite pressured memory in the outer environment', t => {
  const outer = healthyMemoryEnvironment().TEST_MEMORY_FILE;
  fs.writeFileSync(outer, JSON.stringify(pressuredMemory));
  const previous = process.env.TEST_MEMORY_FILE;
  let f;
  try {
    process.env.TEST_MEMORY_FILE = outer;
    f = fixture(t);
  } finally {
    if (previous === undefined) delete process.env.TEST_MEMORY_FILE;
    else process.env.TEST_MEMORY_FILE = previous;
  }
  assert.notEqual(f.env.TEST_MEMORY_FILE, outer);
  assert.ok(f.env.NODE_OPTIONS.includes(`--import=${JSON.stringify(new URL('../../test/helpers/memory-fixture.mjs', import.meta.url).href)}`),
    'the healthy fixture sample is consumed through the memory preload');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.env.TEST_MEMORY_FILE)), healthyMemory);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).results.job.outcome, 'promoted');
  assert.deepEqual(JSON.parse(fs.readFileSync(outer)), pressuredMemory);
});

test('project profile runs the pinned Node, real host sockets/PTY, preparation and inherited slot before exact integration', t => {
  const f = fixture(t, { prepare: [{ run: 'exit 9', unless: '.nvmrc' }, { run: 'node prep.cjs' }] });
  f.env.PROFILE_VALUE = 'caller';
  const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git(['rev-parse', 'main']), f.head, result.stdout + result.stderr + fs.readFileSync(f.receipt));
  const evidence = JSON.parse(fs.readFileSync(f.env.PROFILE_EVIDENCE, 'utf8'));
  assert.equal(evidence.version, process.version); assert.ok(evidence.token);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.host_receipt, path.join(f.directory, 'host-gate.json'));
  assert.equal(train.results.job.outcome, 'promoted'); assert.equal(train.attempts[0].gate.exit_code, 0);
  assert.equal(f.saved().external_lock, undefined); assert.equal(f.slotSaved().state, 'acquired');
  assert.equal(train.slot_granted_at, f.slotSaved().acquired_at);
  assert.equal(train.external_lock_required, false);
  assert.ok(Date.parse(train.started_at) <= Date.parse(train.slot_granted_at));
  assert.ok(Date.parse(train.slot_granted_at) <= Date.parse(train.attempts[0].prepare.started_at));
  assert.equal(fs.existsSync(f.slot), false);
  assert.equal(fs.readFileSync(path.join(f.directory, 'host-gate.json'), 'utf8').includes('declared'), false, 'environment values stay out of receipts');
});

function probeExternal(f) {
  return spawnSync('/bin/zsh', ['-f', '-c', 'zmodload zsh/system; zsystem flock -t 0 -f fd "$1"', 'probe', f.gate.external_lock], { env: f.env }).status;
}

test('fresh profiled STOP refuses before acquiring any promotion resource', kernelLockOptions, t => {
  const f = fixture(t, { externalLock: true });
  const stop = path.join(f.repo, '.lane/supervisor/STOP');
  fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'STOP');
  fs.writeFileSync(f.gate.external_lock, 'keep');
  const result = f.run(); assert.equal(result.status, 75, result.stderr);
  assert.equal(f.saved().code, 'PROMOTION_STOPPED'); assert.equal(f.saved().external_lock, undefined);
  assert.equal(f.saved().command_started, undefined); assert.equal(fs.existsSync(f.slot), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'test-slot-wait.json')), false);
  assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
  assert.equal(probeExternal(f), 0); assert.equal(f.git(['rev-parse', 'main']), f.before);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).attempts?.length ?? 0, 0);
  assert.equal(fs.existsSync(f.env.PROFILE_EVIDENCE), false);
});

for (const phase of ['validated', 'integrated']) test(`profiled STOP resumes its ${phase} checkpoint, reconciles main and refuses unfinished members after waiting for memory`, kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true }), first = f.run(); assert.equal(first.status, 0, first.stderr);
  const later = path.join(f.root, 'later');
  f.git(['worktree', 'add', '-qb', 'lane/later', later]);
  fs.writeFileSync(path.join(later, 'later'), 'unfinished'); f.git(['add', '.'], later); f.git(['commit', '-qm', 'Later'], later);
  const laterHead = f.git(['rev-parse', 'HEAD'], later);
  const train = JSON.parse(fs.readFileSync(f.receipt)), gate = train.attempts[0].gate;
  train.results = {}; train.groups = [['job'], ['later']]; train.phase = 'fast-forwarding'; train.attempts[0].phase = phase;
  train.jobs.push({ id: 'later', topic: 'later', expectedHead: laterHead });
  fs.writeFileSync(f.receipt, JSON.stringify(train));
  const queue = queueFor(f.repo);
  const herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));
`, { mode: 0o755 });
  const opts = { laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, to: 'offline', attempts: 1,
    retry: 0, herdr };
  enqueue(queue, ['profile'], { ...opts, expectedHead: f.head });
  enqueue(queue, ['later'], { ...opts, expectedHead: laterHead });
  const jobs = queue.load().pending; jobs[0].id = 'job'; jobs[1].id = 'later';
  queue.transaction(data => { data.pending = []; data.current = { id: 'profile', phase: 'batching', jobs }; });
  f.env.SUPERVISOR_INPUT_CONFIRM_SECONDS = '0.001'; f.env.SUPERVISOR_INPUT_POLL_SECONDS = '0.001';
  const stop = path.join(f.repo, '.lane/supervisor/STOP');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.lane/\n');
  fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'STOP');
  const memory = promotionMemoryFixture(f, 'unused'); memory.set(pressuredMemory);
  const worker = spawnChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(worker);
  try {
    const log = path.join(f.directory, 'train.log');
    await until(() => f.saved().phase === 'refused' || (f.saved().phase === 'waiting-memory' &&
      fs.readFileSync(log, 'utf8').includes('waiting; memory pressure')));
    assert.equal(f.saved().phase, 'waiting-memory', JSON.stringify(f.saved()));
    assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    memory.set(healthyMemory);
    const result = await done; assert.equal(result.code, 0, result.stderr);
    const data = queue.load(); assert.deepEqual(data.results.map(r => r.outcome), ['promoted', 'refused'], f.diagnostics());
    assert.ok(data.results.every(r => r.delivered));
    assert.match(data.results[1].reason, /STOP/); assert.equal(data.interrupted?.length ?? 0, 0); assert.equal(data.current, null);
    const saved = JSON.parse(fs.readFileSync(f.receipt));
    assert.equal(saved.phase, 'complete'); assert.deepEqual(saved.groups, []);
    assert.equal(saved.attempts.length, 1); assert.equal(saved.attempts[0].phase, 'complete');
    assert.deepEqual(saved.attempts[0].gate, gate); assert.equal(saved.results.job.tip, f.head);
    assert.equal(saved.results.later.gate, undefined); assert.equal(f.saved().phase, 'finished'); assert.equal(f.saved().command_started, true);
    assert.equal(fs.readFileSync(f.env.PROFILE_EVIDENCE, 'utf8').trim().split('\n').length, 1);
    assert.equal(f.git(['rev-parse', 'main']), f.head); assert.equal(f.git(['rev-parse', 'lane/later']), laterHead);
    assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    await waitForInboxIdle(path.join(f.repo, '.git/supervisor/inbox.log'));
  } finally { memory.set(healthyMemory); await done; }
});

for (const stop of [false, true]) test(`profile initial memory wait holds no locks and ${stop ? 'STOP refuses' : 'clearing proceeds'}`, kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true });
  const memory = promotionMemoryFixture(f, 'unused'); memory.set(pressuredMemory);
  // The legacy lock file already exists; probing it must succeed throughout
  // the initial wait, and neither slot nor project lock may be occupied.
  fs.writeFileSync(f.gate.external_lock, 'keep');
  const worker = f.asyncRun(), done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(path.join(f.directory, 'host-gate.json')) && f.saved().phase === 'waiting-memory');
    assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    if (stop) {
      const file = path.join(f.repo, '.lane/supervisor/STOP'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'stop');
    } else memory.set(healthyMemory);
    const result = await done;
    assert.equal(result.code, stop ? 75 : 0, result.stderr);
    if (stop) {
      assert.equal(f.saved().code, 'PROMOTION_STOPPED'); assert.equal(f.saved().command_started, undefined);
      assert.equal(f.git(['rev-parse', 'main']), f.before);
    } else assert.equal(f.git(['rev-parse', 'main']), f.head);
    assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
  } finally { memory.set(healthyMemory); await done; }
});

for (const stage of ['--held', '--execute', 'project-lock']) test(`profile pressure at ${stage} caps and releases every acquired lock without gate evidence`, kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true }), memory = promotionMemoryFixture(f, stage);
  fs.writeFileSync(f.gate.external_lock, 'keep');
  const worker = f.asyncRun(), done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(memory.ready), f.diagnostics);
    assert.notEqual(probeExternal(f), 0);
    if (stage !== '--held') assert.ok(fs.existsSync(f.slot), 'slot acquired before injected pressure');
    if (stage === 'project-lock') assert.ok(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')));
    const result = await done;
    assert.equal(result.code, stage === 'project-lock' ? 0 : 75, result.stderr);
    assert.match(result.stderr, /PROMOTION_MEMORY_PRESSURE/);
    if (stage !== 'project-lock') {
      assert.equal(f.saved().code, 'PROMOTION_MEMORY_PRESSURE'); assert.equal(f.saved().command_started, undefined);
    } else {
      const plan = JSON.parse(fs.readFileSync(f.receipt));
      assert.equal(plan.results.job.code, 'PROMOTION_MEMORY_PRESSURE'); assert.equal(plan.phase, 'complete');
    }
    assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false);
    assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(f.git(['rev-parse', 'lane/profile']), f.head);
    assert.equal(fs.existsSync(f.env.PROFILE_EVIDENCE), false);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).attempts?.length ?? 0, 0);
    assert.equal(fs.readFileSync(f.gate.external_lock, 'utf8'), 'keep');
  } finally { memory.set(healthyMemory); await done; }
});

test('pressure clearing after both host locks are acquired proceeds within the bound', kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true }), memory = promotionMemoryFixture(f, '--execute');
  fs.writeFileSync(f.gate.external_lock, '');
  const worker = f.asyncRun(), done = waitForExit(worker);
  try {
    await until(() => fs.existsSync(memory.ready));
    assert.notEqual(probeExternal(f), 0); assert.ok(fs.existsSync(f.slot));
    memory.set(healthyMemory);
    const result = await done; assert.equal(result.code, 0, result.stderr);
    assert.equal(f.git(['rev-parse', 'main']), f.head); assert.equal(probeExternal(f), 0);
    assert.equal(fs.existsSync(f.slot), false);
  } finally { memory.set(healthyMemory); await done; }
});

test('queue delivers a coded memory refusal with no bisection and permits re-enqueue after pressure clears', kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true }), memory = promotionMemoryFixture(f, '--execute');
  fs.writeFileSync(f.gate.external_lock, '');
  const herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));
`, { mode: 0o755 });
  const queue = queueFor(f.repo), add = () => enqueue(queue, ['profile'], { laneCLI: path.join(source, 'lanes/lane.mjs'),
    org: null, to: 'offline', attempts: 1, retry: 0, expectedHead: f.head, herdr });
  add(); f.env.SUPERVISOR_INPUT_CONFIRM_SECONDS = '0.001'; f.env.SUPERVISOR_INPUT_POLL_SECONDS = '0.001';
  const drain = () => spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const first = drain(); assert.equal(first.status, 0, first.stderr);
  const data = queue.load(), refused = data.results[0];
  assert.equal(refused.outcome, 'refused'); assert.equal(refused.code, 'PROMOTION_MEMORY_PRESSURE');
  assert.equal(refused.delivered, true);
  assert.equal(data.interrupted?.length ?? 0, 0); assert.equal(data.current, null); assert.equal(refused.gate, undefined);
  const plan = JSON.parse(fs.readFileSync(refused.receipt));
  assert.equal(plan.phase, 'complete'); assert.deepEqual(plan.groups, []); assert.equal(plan.attempts?.length ?? 0, 0);
  assert.equal(probeExternal(f), 0); assert.equal(fs.existsSync(f.slot), false);
  assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(f.git(['rev-parse', 'lane/profile']), f.head);
  const inbox = fs.readFileSync(path.join(f.repo, '.git/supervisor/inbox.log'), 'utf8');
  assert.match(inbox, /outcome=refused code=PROMOTION_MEMORY_PRESSURE/);
  memory.set(healthyMemory); const [retry] = add(); assert.notEqual(retry.id, refused.id);
  const second = drain(); assert.equal(second.status, 0, second.stderr);
  assert.equal(queue.load().results.at(-1).outcome, 'promoted'); assert.equal(f.git(['rev-parse', 'main']), f.head);
  await waitForInboxIdle(path.join(f.repo, '.git/supervisor/inbox.log'));
});

test('busy legacy fcntl lock waits visibly, caps, preserves main, and releases without deleting the lock file', kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true }), ready = path.join(f.root, 'ready');
  fs.writeFileSync(f.gate.external_lock, 'keep');
  const owner = spawnChild(t, '/bin/zsh', ['-f', '-c', 'zmodload zsh/system; zsystem flock -t 0 -f fd "$1" || exit 1; print ready > "$2"; read answer', 'holder', f.gate.external_lock, ready], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = waitForExit(owner);
  await until(() => fs.existsSync(ready));
  const train = f.asyncRun(); await until(() => fs.existsSync(path.join(f.directory, 'host-gate.json')) && f.saved().phase === 'waiting-external-lock');
  assert.equal(f.saved().external_lock.wait_seconds, 1);
  const result = await waitForExit(train); assert.equal(result.code, 75, result.stderr);
  assert.match(f.saved().reason, /PROMOTE_LOCK_HELD/); assert.equal(f.saved().external_lock.state, 'refused');
  assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(fs.existsSync(f.env.PROFILE_EVIDENCE), false);
  assert.equal(fs.readFileSync(f.gate.external_lock, 'utf8'), 'keep');
  owner.stdin.end('release\n'); await done;
  const resumed = f.run(); assert.equal(resumed.status, 0, resumed.stderr);
  const receipt = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(receipt.external_lock_started_at, f.saved().external_lock.started_at, 'a grant uses the successful retry wait, excluding idle time after a cap');
  assert.equal(receipt.external_lock_granted_at, f.saved().external_lock.acquired_at);
});

test('a released legacy lock admits the waiting train and stays held for the complete batch', kernelLockOptions, async t => {
  const f = fixture(t, { externalLock: true, wait_seconds: 3 }), ready = path.join(f.root, 'ready');
  fs.writeFileSync(f.gate.external_lock, '');
  const owner = spawnChild(t, '/bin/zsh', ['-f', '-c', 'zmodload zsh/system; zsystem flock -t 0 -f fd "$1" || exit 1; print ready > "$2"; read answer', 'holder', f.gate.external_lock, ready], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  await until(() => fs.existsSync(ready));
  const worker = f.asyncRun(); await until(() => fs.existsSync(path.join(f.directory, 'host-gate.json')) && f.saved().phase === 'waiting-external-lock');
  owner.stdin.end('release\n'); await waitForExit(owner);
  const result = await waitForExit(worker); assert.equal(result.code, 0, result.stderr);
  assert.equal(f.saved().external_lock.state, 'acquired'); assert.equal(f.git(['rev-parse', 'main']), f.head, f.diagnostics());
  const receipt = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(receipt.external_lock_required, true);
  assert.equal(receipt.external_lock_started_at, f.saved().external_lock.started_at);
  assert.equal(receipt.external_lock_granted_at, f.saved().external_lock.acquired_at);
  assert.ok(Date.parse(receipt.started_at) <= Date.parse(receipt.external_lock_granted_at));
  assert.ok(Date.parse(receipt.external_lock_granted_at) <= Date.parse(receipt.slot_granted_at));
});

test('a queue slot cap emits a completed per-lane refusal and no interrupted or red gate outcome', async t => {
  const f = fixture(t), slot = await holdSlot(t, f);
  const queue = queueFor(f.repo);
  const laneCLI = path.join(source, 'lanes/lane.mjs');
  enqueue(queue, ['profile'], { laneCLI, org: null, to: 'offline', attempts: 1, retry: 0,
    expectedHead: f.head, herdr: path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'herdr') });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const result = spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  await slot.release();
  assert.equal(result.status, 0, result.stderr);
  const data = queue.load(); assert.equal(data.results[0].outcome, 'refused');
  assert.equal(data.results[0].gate, undefined); assert.equal(data.interrupted?.length ?? 0, 0);
  const hostReceipt = JSON.parse(fs.readFileSync(data.results[0].host_receipt));
  assert.equal(hostReceipt.phase, 'refused'); assert.match(data.results[0].reason, /TEST_SLOT_REFUSED/);
  assert.match(fs.readFileSync(path.join(path.dirname(data.results[0].host_receipt), 'train.log'), 'utf8'), /TEST_SLOT_HELD/);
  assert.equal(fs.existsSync(hostReceipt.slot_receipt), false);
  assert.equal(f.git(['rev-parse', 'main']), f.before);
});

test('a capped resume preserves a lost fast-forward checkpoint and reconciles it without another gate', async t => {
  const f = fixture(t), first = f.run(); assert.equal(first.status, 0, first.stderr);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  train.results = {}; train.groups = [['job']]; train.phase = 'fast-forwarding'; train.attempts[0].phase = 'validated';
  fs.writeFileSync(f.receipt, JSON.stringify(train));
  const queue = queueFor(f.repo);
  enqueue(queue, ['profile'], { laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, to: 'offline', attempts: 1,
    retry: 0, expectedHead: f.head, herdr: path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'herdr') });
  const job = queue.load().pending[0];
  job.id = 'job';
  queue.transaction(data => { data.pending = []; data.current = { id: 'profile', phase: 'batching', jobs: [job] }; });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const drain = () => spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  const slot = await holdSlot(t, f), capped = drain();
  await slot.release(); assert.equal(capped.status, 0, capped.stderr);
  const cappedResult = queue.load().results.at(-1), hostReceipt = path.join(f.directory, 'host-gate.json');
  assert.equal(cappedResult.outcome, 'interrupted'); assert.equal(queue.load().interrupted.length, 1);
  assert.equal(cappedResult.host_receipt, hostReceipt);
  assert.equal(queue.load().interrupted[0].results[0].result.host_receipt, hostReceipt);
  assert.equal(JSON.parse(fs.readFileSync(hostReceipt)).phase, 'refused');
  const notices = fs.readFileSync(path.join(f.repo, '.git/supervisor/inbox.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(notices.some(entry => entry.message?.includes(`host-receipt=${hostReceipt}`)), 'interrupted notice links host refusal evidence');
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).attempts[0].phase, 'validated'); assert.equal(f.git(['rev-parse', 'main']), f.head);
  const resumed = drain(); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(queue.load().results.at(-1).outcome, 'promoted', fs.readFileSync(path.join(f.directory, 'train.log'), 'utf8'));
  const recovered = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(recovered.started_at, train.started_at); assert.equal(recovered.slot_granted_at, train.slot_granted_at);
  assert.equal(fs.readFileSync(f.env.PROFILE_EVIDENCE, 'utf8').trim().split('\n').length, 1);
});

test('busy host slot writes its grant receipt only after release and the train inherits it', async t => {
  const f = fixture(t, { wait_seconds: 3 });
  const slot = await holdSlot(t, f);
  const worker = f.asyncRun();
  await waitForSlotWait(worker);
  assert.equal(fs.existsSync(path.join(f.directory, 'test-slot-wait.json')), false);
  await slot.release();
  const result = await waitForExit(worker); assert.equal(result.code, 0, result.stderr);
  assert.equal(f.slotSaved().state, 'acquired'); assert.match(f.slotSaved().waits[0].holder, /fixture owner/);
  assert.equal(f.git(['rev-parse', 'main']), f.head);
});

test('busy host slot caps without a red gate receipt or integration', async t => {
  const f = fixture(t), slot = await holdSlot(t, f);
  const result = f.run(); assert.equal(result.status, 75, result.stderr);
  assert.equal(fs.existsSync(path.join(f.directory, 'test-slot-wait.json')), false);
  assert.match(result.stderr, /TEST_SLOT_HELD/);
  assert.equal(f.saved().command_started, undefined); assert.equal(f.git(['rev-parse', 'main']), f.before);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).attempts, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).slot_granted_at, undefined);
  await slot.release();
});

test('a declared competing process refuses before taking the slot or building', async t => {
  const f = fixture(t, { refuse_processes: ['gate-profile-competitor'] });
  const competitor = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)', 'gate-profile-competitor'], { env: f.env });
  const result = f.run(); assert.equal(result.status, 75, result.stderr); assert.match(f.saved().reason, /PROMOTE_PROCESS_RUNNING/);
  assert.equal(fs.existsSync(f.slot), false); assert.equal(f.git(['rev-parse', 'main']), f.before);
  competitor.kill('SIGTERM'); await waitForExit(competitor);
});

test('a competing process started during a slot wait refuses before preparation', async t => {
  const f = fixture(t, { wait_seconds: 3, refuse_processes: ['gate-profile-competitor'] });
  const slot = await holdSlot(t, f), worker = f.asyncRun();
  await waitForSlotWait(worker);
  assert.equal(fs.existsSync(path.join(f.directory, 'test-slot-wait.json')), false);
  const competitor = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)', 'gate-profile-competitor'], { env: f.env });
  await slot.release();
  const result = await waitForExit(worker); assert.equal(result.code, 75, result.stderr);
  assert.equal(f.slotSaved().state, 'acquired', 'a grant remains evidence even if the command then refuses');
  assert.match(f.saved().reason, /PROMOTE_PROCESS_RUNNING/); assert.equal(f.saved().command_started, undefined);
  assert.equal(fs.existsSync(f.slot), false); assert.equal(f.git(['rev-parse', 'main']), f.before);
  competitor.kill('SIGTERM'); await waitForExit(competitor);
});


test('malformed profiles and missing exact Node pins fail closed; effective declarations salt evidence', t => {
  const f = fixture(t), profile = resolveGateProfile(f.repo, f.env);
  // Only committed declarations count: commit each change before resolving it.
  const commit = (file, text) => { fs.writeFileSync(path.join(f.repo, file), text); f.git(['add', file]); f.git(['commit', '-qm', `Change ${file}`]); };
  assert.equal(profile.env.PATH.split(path.delimiter)[0], f.bin);
  const changed = JSON.stringify({ gate: { ...f.gate, env: { PROFILE_VALUE: 'new' } } });
  fs.writeFileSync(path.join(f.repo, '.promote.json'), changed);
  assert.equal(resolveGateProfile(f.repo, f.env).fingerprint, profile.fingerprint, 'an uncommitted edit is not the profile');
  commit('.promote.json', changed);
  assert.notEqual(resolveGateProfile(f.repo, f.env).fingerprint, profile.fingerprint);
  for (const gate of [{ surprise: true }, { wait_seconds: -1 }, { node_version_file: '../pin' }, { env: { MONITOR_TEST_SLOT_PATH: '/tmp/foreign' } }, { env: { NODE_OPTIONS: '--import=x' } }, { refuse_processes: ['['] }]) {
    commit('.promote.json', JSON.stringify({ gate })); assert.throws(() => resolveGateProfile(f.repo, f.env));
  }
  commit('.promote.json', JSON.stringify({ gate: f.gate }));
  commit('.nvmrc', '0.0.0'); assert.throws(() => resolveGateProfile(f.repo, f.env));
});

test('inner idle timeout uses canonical lane-only limits without timing out the completed host envelope', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ validation: { timeout_seconds: { promotion: 5000 }, idle_timeout_seconds: { promotion: .2 } } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Canonical watchdog settings']);
  const before = f.git(['rev-parse', 'main']);
  f.env.LANE_VALIDATE = 'node -e "setInterval(()=>{},1000)"';
  const result = f.run();
  // The train completed and recorded a lane timeout; its zero exit and printed
  // descendant marker cannot turn this completed host lifecycle into a timeout.
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const saved = f.saved();
  assert.equal(saved.phase, 'finished'); assert.equal(saved.exit_code, 0);
  assert.equal(saved.gate_timeout, undefined);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.attempts[0].gate.limits.wall_seconds, 5000);
  assert.equal(train.results.job.outcome, 'timeout');
  assert.equal(train.attempts[0].gate.gate_timeout.kind, 'idle');
  assert.match(train.results.job.reason, /gate no-output limit exceeded; lane isolated for correction/);
  assert.doesNotMatch(train.results.job.reason, /wall-clock/);
  assert.equal(f.git(['rev-parse', 'main']), before);
  assert.equal(fs.existsSync(f.slot), false);
});

test('promotion host envelope derives from the declared inner history key', t => {
  const f = fixture(t), common = path.join(f.repo, '.git');
  f.env.MONITOR_GATE_HISTORY_ROOT = path.join(f.root, 'history');
  const key = gateHistoryKey('promotion', ['/bin/sh', '-c', 'node gate.cjs']);
  for (let i = 0; i < 3; i++) recordHealthyGate({ common, tier: 'promotion', historyKey: key, file: historyFile(common, 'promotion', undefined, key, f.env), duration_s: 6000, longest_silence_s: 20 });
  const preload = path.join(f.root, 'observe.mjs'), evidence = path.join(f.root, 'envelope.json');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const run=cp.spawnSync;cp.spawnSync=(cmd,args,opts)=>{if(Array.isArray(args)&&args.includes('promotion-host'))fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(args));return run(cmd,args,opts);};syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${preload}`;
  const r = f.run(); assert.equal(r.status, 0, r.stderr + r.stdout);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.ok(train.attempts[0].gate, JSON.stringify(train) + r.stdout + r.stderr);
  const inner = train.attempts[0].gate.limits;
  assert.equal(inner.wall_seconds, 12000); assert.equal(inner.wall_source, 'history');
  const args = JSON.parse(fs.readFileSync(evidence));
  assert.ok(Number(args[args.indexOf('--timeout-seconds') + 1]) > inner.wall_seconds);
});

test('three-lane red bisection fits the host envelope and promotes both healthy green lanes', t => {
  const f = fixture(t), common = path.join(f.repo, '.git');
  fs.writeFileSync(path.join(f.repo, 'gate.cjs'), `const fs=require('fs');fs.appendFileSync(process.env.PROFILE_EVIDENCE,'gate\\n');process.exit(fs.existsSync('red')?1:0);`);
  f.git(['add', 'gate.cjs']); f.git(['commit', '-qm', 'Gate rejects only the red lane']);
  const jobs = [];
  for (const topic of ['red', 'green-one', 'green-two']) {
    const lane = path.join(f.root, topic); f.git(['worktree', 'add', '-qb', `lane/${topic}`, lane]);
    fs.writeFileSync(path.join(lane, topic), topic); f.git(['add', '.'], lane); f.git(['commit', '-qm', topic], lane);
    jobs.push({ id: topic, topic, expectedHead: f.git(['rev-parse', 'HEAD'], lane) });
  }
  fs.writeFileSync(f.receipt, JSON.stringify({ schema: 'promotion-train/v1', id: 'profile', identity: common, jobs }));
  const key = gateHistoryKey('promotion', ['/bin/sh', '-c', 'node gate.cjs']);
  for (let i = 0; i < 3; i++) recordHealthyGate({ common, tier: 'promotion', historyKey: key, duration_s: 6000, longest_silence_s: 20 });
  const preload = path.join(f.root, 'observe.mjs'), evidence = path.join(f.root, 'envelope.json');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const run=cp.spawnSync;cp.spawnSync=(cmd,args,opts)=>{if(Array.isArray(args)&&args.includes('promotion-host'))fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(args));return run(cmd,args,opts);};syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${preload}`;
  const r = f.run({ compound: true }); assert.equal(r.status, 0, r.stderr + r.stdout);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.attempts.length, 5);
  for (const attempt of train.attempts) {
    assert.ok(attempt.gate, f.diagnostics());
    assert.equal(attempt.gate.limits.wall_seconds, 12000);
    assert.equal(attempt.gate.gate_timeout, null);
  }
  const args = JSON.parse(fs.readFileSync(evidence));
  assert.equal(Number(args[args.indexOf('--timeout-seconds') + 1]), 5 * (12000 + 600) + 60);
  assert.equal(train.results.red.outcome, 'refused');
  for (const topic of ['green-one', 'green-two']) {
    assert.equal(train.results[topic].outcome, 'promoted');
    assert.equal(fs.readFileSync(path.join(f.repo, topic), 'utf8'), topic);
  }
  assert.equal(fs.existsSync(path.join(f.repo, 'red')), false);
  assert.equal(f.saved().phase, 'finished'); assert.equal(f.saved().gate_timeout, undefined);
  assert.equal(fs.existsSync(f.slot), false);
});

test('two-lane host envelope timeout returns batch re-enqueue wording', t => {
  const f = fixture(t, { prepare: [{ run: 'node -e "setInterval(()=>{},1000)"' }] });
  const other = path.join(f.root, 'other'); f.git(['worktree', 'add', '-qb', 'lane/other', other]);
  fs.writeFileSync(path.join(other, 'other'), 'other'); f.git(['add', '.'], other); f.git(['commit', '-qm', 'Other'], other);
  const preload = path.join(f.root, 'short-host.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const run=cp.spawnSync;cp.spawnSync=(cmd,args,opts)=>{if(Array.isArray(args)&&args.includes('promotion-host')){args=[...args];args[args.indexOf('--timeout-seconds')+1]='.8';}return run(cmd,args,opts);};syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${preload}`;
  const fakeHerdr = path.join(f.root, 'herdr'); fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const queue = queueFor(f.repo);
  enqueue(queue, ['profile', 'other'], { laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, to: 'offline', attempts: 1, retry: 0, herdr: fakeHerdr });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const r = spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const results = queue.load().results; assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.outcome, 'timeout', JSON.stringify({ outcome: result.outcome, code: result.code, reason: result.reason }));
    assert.equal(result.reason, 'gate wall-clock limit exceeded; batch timed out; re-enqueue lanes individually');
    const host = JSON.parse(fs.readFileSync(result.host_receipt)); assert.equal(host.phase, 'timeout'); assert.equal(host.gate_timeout.descendant ?? false, false);
  }
  assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(fs.existsSync(f.slot), false);
});

test('a signaled preparation without a host timeout remains a refusal', t => {
  const f = fixture(t, { prepare: [{ run: 'kill -TERM $$' }] });
  f.run();
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.results.job.outcome, 'refused');
  assert.equal(train.attempts[0].prepare.failure.signal, 'SIGTERM');
  assert.equal(f.saved().gate_timeout, undefined);
  assert.equal(f.git(['rev-parse', 'main']), f.before);
});

test('host timeout preserves an earlier preparation refusal while classifying its interrupted member', t => {
  const f = fixture(t, { prepare: [{ run: `node -e 'const fs=require("fs"),p=process.env.PROFILE_EVIDENCE+".prepare";if(!fs.existsSync(p)){fs.writeFileSync(p,"first refused");process.exit(7);}setInterval(()=>{},1000)'` }] });
  const other = path.join(f.root, 'other'); f.git(['worktree', 'add', '-qb', 'lane/other', other]);
  fs.writeFileSync(path.join(other, 'other'), 'other'); f.git(['add', '.'], other); f.git(['commit', '-qm', 'Other'], other);
  const preload = path.join(f.root, 'split-host.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const run=cp.spawnSync;cp.spawnSync=(cmd,args,opts)=>{if(Array.isArray(args)&&args.includes('promotion-host')){args=[...args];args[args.indexOf('--timeout-seconds')+1]='${loadTimeout(3000) / 1000}';}return run(cmd,args,opts);};syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${preload}`;
  const herdr = path.join(f.root, 'herdr'); fs.writeFileSync(herdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const queue = queueFor(f.repo);
  enqueue(queue, ['profile', 'other'], { laneCLI: path.join(source, 'lanes/lane.mjs'), org: null,
    to: 'offline', attempts: 1, retry: 0, herdr });
  const jobs = queue.load().pending;
  const id = 'split-timeout', directory = path.join(queue.directory, 'batches', id); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'train.json'), JSON.stringify({ schema: 'promotion-train/v1', id,
    identity: queue.project.identity, jobs, phase: 'pending', groups: jobs.map(job => [job.id]) }));
  queue.transaction(data => { data.pending = []; data.current = { id, phase: 'batching', jobs }; });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const r = spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'],
    { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const results = queue.load().results;
  assert.deepEqual(results.map(result => result.outcome), ['refused', 'timeout']);
  assert.match(results[0].reason, /train preparation failed/);
  assert.equal(results[1].reason, 'gate wall-clock limit exceeded; batch timed out; re-enqueue lanes individually');
  assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(fs.existsSync(f.slot), false);
});
