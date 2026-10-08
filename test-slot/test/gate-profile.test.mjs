import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateProfile, runProjectGateSync } from '../../promote/gate-profile.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { enqueue, queueFor } from '../../promote/promote.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const host = path.join(source, 'promote/host-gate.mjs');
const slotCLI = path.join(source, 'test-slot/test-slot.mjs');
const kernelLockOptions = { skip: !fs.existsSync('/bin/zsh') && 'external kernel-lock tests require /bin/zsh' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await pause(25); } assert.fail('fixture did not become ready'); }

function fixture(t, { externalLock = false, ...changes } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-profile-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root);
  fs.mkdirSync(repo);
  const env = { ...process.env, HOME: path.join(root, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)|MONITOR_PROMOTION_|.*TEST_SLOT_TOKEN)/.test(key)) delete env[key];
  const slot = path.join(root, 'slot'); env.MONITOR_TEST_SLOT_PATH = env.MONITOR_TEST_SLOT_COMPAT_PATH = slot;
  env.PROFILE_EVIDENCE = path.join(root, 'evidence');
  const bin = path.join(env.HOME, '.nvm/versions/node', `v${process.versions.node}`, 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Profile']); git(['config', 'user.email', 'profile@example.invalid']);
  fs.writeFileSync(path.join(repo, '.nvmrc'), process.versions.node);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(repo, 'prep.cjs'), `const fs=require('fs'),assert=require('assert/strict');assert(process.env.BCH_CLOAK_TEST_SLOT_TOKEN);assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token,process.env.BCH_CLOAK_TEST_SLOT_TOKEN);const lock=JSON.parse(fs.readFileSync('.promote.json')).gate.external_lock;if(lock){const r=require('child_process').spawnSync('/bin/zsh',['-f','-c','zmodload zsh/system; zsystem flock -t 0 -f fd "$1"','probe',lock]);assert.notEqual(r.status,0,'legacy kernel lock stays held during preparation');}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/prepared','prepared');`);
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
  const run = () => runProjectGateSync({ canonical: repo, receipt, argv, cwd: repo, env, encoding: 'utf8' });
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
  assert.equal(fs.existsSync(f.slot), false);
  assert.equal(fs.readFileSync(path.join(f.directory, 'host-gate.json'), 'utf8').includes('declared'), false, 'environment values stay out of receipts');
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
});

test('a queue slot cap emits a completed per-lane refusal and no interrupted or red gate outcome', async t => {
  const f = fixture(t), slot = await holdSlot(t, f);
  const queue = queueFor(f.repo);
  const laneCLI = path.join(source, 'lanes/lane.mjs');
  enqueue(queue, ['profile'], { laneCLI, org: null, to: 'offline', attempts: 1, retry: 0,
    expectedHead: f.head, herdr: path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'herdr') });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const result = spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
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
  const drain = () => spawnSync(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
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

test('host envelope honors canonical lane-only limits and reports an idle timeout accurately', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ validation: { timeout_seconds: { promotion: 5000 }, idle_timeout_seconds: { promotion: .2 } } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Canonical watchdog settings']);
  const before = f.git(['rev-parse', 'main']);
  f.env.LANE_VALIDATE = 'node -e "setInterval(()=>{},1000)"';
  const result = f.run();
  assert.equal(result.status, 124, result.stderr + result.stdout);
  const saved = f.saved();
  assert.equal(saved.phase, 'timeout'); assert.equal(saved.gate_timeout.kind, 'idle');
  assert.match(saved.reason, /gate no-output limit exceeded/);
  assert.doesNotMatch(saved.reason, /wall-clock/);
  const train = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(train.attempts[0].gate.limits.wall_seconds, 5000);
  assert.equal(train.results.job.outcome, 'timeout');
  assert.equal(f.git(['rev-parse', 'main']), before);
  assert.equal(fs.existsSync(f.slot), false);
});
