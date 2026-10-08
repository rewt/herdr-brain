import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordHealthyGate, gateHistoryKey, historyFile } from '../limits.mjs';
import { resolveGateProfile, runProjectGateSync } from '../../promote/gate-profile.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { enqueue, queueFor } from '../../promote/promote.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { promotionMemoryFixture, healthyMemory, pressuredMemory } from '../../test/helpers/promotion-memory-fixture.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const host = path.join(source, 'promote/host-gate.mjs');
const slotCLI = path.join(source, 'test-slot/test-slot.mjs');
const kernelLockOptions = { skip: !fs.existsSync('/bin/zsh') && 'external kernel-lock tests require /bin/zsh' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + loadTimeout(10000);
  while (Date.now() < deadline) { if (fn()) return; await pause(25); }
  assert.fail('fixture did not become ready');
}

function fixture(t, { externalLock = false, ...changes } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-profile-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root);
  fs.mkdirSync(repo);
  const env = { ...testSlotEnvironment(), HOME: path.join(root, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)|MONITOR_PROMOTION_|.*TEST_SLOT_TOKEN)/.test(key)) delete env[key];
  const slot = path.join(root, 'slot'); env.MONITOR_TEST_SLOT_PATH = env.MONITOR_TEST_SLOT_COMPAT_PATH = slot;
  env.PROFILE_EVIDENCE = path.join(root, 'evidence');
  const bin = path.join(env.HOME, '.nvm/versions/node', `v${process.versions.node}`, 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: loadTimeout(15000) }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Profile']); git(['config', 'user.email', 'profile@example.invalid']);
  fs.writeFileSync(path.join(repo, '.nvmrc'), process.versions.node);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(repo, 'prep.cjs'), `const fs=require('fs'),assert=require('assert/strict');assert(process.env.BCH_CLOAK_TEST_SLOT_TOKEN);assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token,process.env.BCH_CLOAK_TEST_SLOT_TOKEN);const lock=JSON.parse(fs.readFileSync('.promote.json')).gate.external_lock;if(lock){const r=require('child_process').spawnSync('/bin/zsh',['-f','-c','zmodload zsh/system; zsystem flock -t 0 -f fd "$1"','probe',lock],{env:process.env,timeout:${loadTimeout(5000)}});assert.notEqual(r.status,null,'legacy kernel lock probe completes within its bound');assert.notEqual(r.status,0,'legacy kernel lock stays held during preparation');}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/prepared','prepared');`);
  fs.writeFileSync(path.join(repo, 'gate.cjs'), `const fs=require('fs'),assert=require('assert/strict'),net=require('net');assert.equal(fs.readFileSync('dist/prepared','utf8'),'prepared');assert.equal(process.env.PROFILE_VALUE,'declared');assert.equal(process.env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS,'7200');assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token,process.env.BCH_CLOAK_TEST_SLOT_TOKEN);const fd=fs.openSync('/dev/ptmx','r+');fs.closeSync(fd);const s=net.createServer();s.listen(0,'127.0.0.1',()=>s.close(()=>fs.appendFileSync(process.env.PROFILE_EVIDENCE,JSON.stringify({node:process.execPath,version:process.version,token:process.env.BCH_CLOAK_TEST_SLOT_TOKEN})+'\\n')));`);
  const gate = { node_version_file: '.nvmrc', env: { PROFILE_VALUE: 'declared', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200' },
    prepare: [{ run: 'node prep.cjs' }], wait_seconds: 1,
    ...(externalLock ? { external_lock: path.join(root, 'promote.flock') } : {}), ...changes };
  const declare = () => { fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ gate })); git(['add', '.']); git(['commit', '-qm', 'Profile']); };
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: 'node gate.cjs' })); declare();
  const lane = path.join(root, 'lane'); git(['worktree', 'add', '-qb', 'lane/profile', lane]);
  fs.writeFileSync(path.join(lane, 'change'), 'change'); git(['add', '.'], lane); git(['commit', '-qm', 'Lane'], lane);
  const head = git(['rev-parse', 'HEAD'], lane), before = git(['rev-parse', 'main']);
  const directory = path.join(repo, '.git/promote/batches/profile'); fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'promotion-train/v1', id: 'profile', identity: path.join(repo, '.git'), jobs: [{ id: 'job', topic: 'profile', expectedHead: head }] }));
  const argv = [path.join(source, 'lanes/lane.mjs'), 'promote-batch', receipt];
  const run = ({ compound = false } = {}) => {
    // Five sequential bisection gates plus preparation/Git work need their own
    // finite response window below the enclosing 60-second test allowance.
    const timeout = loadTimeout(compound ? 55000 : 15000);
    return runProjectGateSync({ canonical: repo, receipt, argv, cwd: repo, env, encoding: 'utf8', timeout,
      ...(compound ? { [commandAllowance]: timeout } : {}) });
  };
  const asyncRun = () => spawnChild(t, process.execPath, [host, repo, receipt, ...argv], { cwd: repo, env });
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, 'host-gate.json')));
  const slotSaved = () => JSON.parse(fs.readFileSync(path.join(directory, 'test-slot-wait.json')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, env, bin, gate, slot, directory, receipt, head, before, git, run, asyncRun, saved, slotSaved, declare };
}

async function holdSlot(t, f) {
  const ready = path.join(f.root, 'slot-ready');
  const owner = spawnChild(t, process.execPath, [slotCLI, 'run', 'fixture owner', '--lock-path', f.slot, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`], { env: f.env });
  await until(() => fs.existsSync(ready));
  return { release: async () => { owner.kill('SIGTERM'); await waitForExit(owner); } };
}

test('project profile runs the pinned Node, real host sockets/PTY, preparation and inherited slot before exact integration', t => {
  const f = fixture(t, { prepare: [{ run: 'exit 9', unless: '.nvmrc' }, { run: 'node prep.cjs' }] });
  f.env.PROFILE_VALUE = 'caller';
  const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git(['rev-parse', 'main']), f.head);
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
    const data = queue.load(); assert.deepEqual(data.results.map(r => r.outcome), ['promoted', 'refused']);
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
    await until(() => fs.existsSync(memory.ready));
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
  assert.equal(f.saved().external_lock.state, 'acquired'); assert.equal(f.git(['rev-parse', 'main']), f.head);
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
  assert.equal(hostReceipt.phase, 'refused'); assert.match(data.results[0].reason, /TEST_SLOT_HELD/);
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

test('busy host slot has a live bounded receipt and the train inherits it after release', async t => {
  const f = fixture(t, { wait_seconds: 3 });
  const slot = await holdSlot(t, f);
  const worker = f.asyncRun();
  await until(() => fs.existsSync(path.join(f.directory, 'test-slot-wait.json')) && f.slotSaved().waits.length);
  assert.equal(f.slotSaved().state, 'waiting'); assert.match(f.slotSaved().waits[0].holder, /fixture owner/);
  await slot.release();
  const result = await waitForExit(worker); assert.equal(result.code, 0, result.stderr);
  assert.equal(f.slotSaved().state, 'acquired'); assert.equal(f.git(['rev-parse', 'main']), f.head);
});

test('busy host slot caps without a red gate receipt or integration', async t => {
  const f = fixture(t), slot = await holdSlot(t, f);
  const result = f.run(); assert.equal(result.status, 75, result.stderr);
  assert.equal(f.slotSaved().state, 'refused'); assert.match(f.slotSaved().reason, /TEST_SLOT_HELD/);
  assert.equal(f.saved().command_started, undefined); assert.equal(f.git(['rev-parse', 'main']), f.before);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).attempts, undefined);
  assert.equal(f.slotSaved().acquired_at, undefined);
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
  await until(() => fs.existsSync(path.join(f.directory, 'test-slot-wait.json')) && f.slotSaved().waits.length);
  const competitor = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)', 'gate-profile-competitor'], { env: f.env });
  await slot.release();
  const result = await waitForExit(worker); assert.equal(result.code, 75, result.stderr);
  assert.match(f.saved().reason, /PROMOTE_PROCESS_RUNNING/); assert.equal(f.saved().command_started, undefined);
  assert.equal(fs.existsSync(f.slot), false); assert.equal(f.git(['rev-parse', 'main']), f.before);
  competitor.kill('SIGTERM'); await waitForExit(competitor);
});

test('unavailable host capabilities refuse with a host launch instruction before builds', t => {
  const f = fixture(t), preload = path.join(f.root, 'deny-net.cjs');
  fs.writeFileSync(preload, `require('net').Server.prototype.listen=function(){throw Object.assign(Error('denied'),{code:'EPERM'})};`);
  f.env.NODE_OPTIONS = `--require=${preload}`;
  const result = f.run(); assert.equal(result.status, 75, result.stderr);
  assert.match(f.saved().reason, /PROMOTE_HOST_REQUIRED.*outside the worker sandbox/);
  assert.equal(fs.existsSync(f.env.PROFILE_EVIDENCE), false); assert.equal(f.git(['rev-parse', 'main']), f.before);
});

test('malformed profiles and missing exact Node pins fail closed; effective declarations salt evidence', t => {
  const f = fixture(t), profile = resolveGateProfile(f.repo, f.env);
  assert.equal(profile.env.PATH.split(path.delimiter)[0], f.bin);
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ gate: { ...f.gate, env: { PROFILE_VALUE: 'new' } } }));
  assert.notEqual(resolveGateProfile(f.repo, f.env).fingerprint, profile.fingerprint);
  for (const gate of [{ surprise: true }, { wait_seconds: -1 }, { node_version_file: '../pin' }, { env: { MONITOR_TEST_SLOT_PATH: '/tmp/foreign' } }, { refuse_processes: ['['] }]) {
    fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ gate })); assert.throws(() => resolveGateProfile(f.repo, f.env));
  }
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ gate: f.gate }));
  fs.writeFileSync(path.join(f.repo, '.nvmrc'), '0.0.0'); assert.throws(() => resolveGateProfile(f.repo, f.env));
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
  f.env.NODE_OPTIONS = `--import=${preload}`;
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
  f.env.NODE_OPTIONS = `--import=${preload}`;
  const r = f.run({ compound: true }); assert.equal(r.status, 0, r.stderr + r.stdout);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.attempts.length, 5);
  for (const attempt of train.attempts) {
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
  f.env.NODE_OPTIONS = `--import=${preload}`;
  const fakeHerdr = path.join(f.root, 'herdr'); fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const queue = queueFor(f.repo);
  enqueue(queue, ['profile', 'other'], { laneCLI: path.join(source, 'lanes/lane.mjs'), org: null, to: 'offline', attempts: 1, retry: 0, herdr: fakeHerdr });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const r = spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(15000) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const results = queue.load().results; assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.reason, 'gate wall-clock limit exceeded; batch timed out; re-enqueue lanes individually');
    const host = JSON.parse(fs.readFileSync(result.host_receipt)); assert.equal(host.phase, 'timeout'); assert.equal(host.gate_timeout.descendant ?? false, false);
  }
  assert.equal(f.git(['rev-parse', 'main']), f.before); assert.equal(fs.existsSync(f.slot), false);
});
