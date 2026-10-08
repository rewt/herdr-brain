import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateLimits, recordHealthyGate, healthyHistory, historyFile, gateHistoryKey, HISTORY_FILES, WALL_DEFAULT_SECONDS, projectCommon, sampleFloorSeconds, wallFloorSeconds } from '../limits.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { gateHistories } from '../../test/helpers/gate-history.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { shouldRetryTimeout, acquireTestSlot, HOLDER_UNKNOWN_CODE } from '../test-slot.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { canonicalValidation } from '../../lanes/validation.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { descendants, stopGateGroup } from '../watchdog.mjs';
import { fixture } from '../../promote/test/helpers/conformance.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { enqueue, queueFor } from '../../promote/promote.mjs';
import { resolveGateProfile } from '../../promote/gate-profile.mjs';
import { resolveValidation, validateValidation } from '../../lanes/validation.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-watchdog-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'slot'), result = path.join(root, 'result.json');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const run = (args, command) => spawnSync(process.execPath, [cli, 'run', 'fake', '--project-common', root, '--tier', 'promotion', '--result-path', result, ...args, '--', ...command], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  return { root, lock, result, env, run };
}

test('config, recent healthy clocks and conservative default resolve independently of slot waiting', t => {
  const s = scratch(t);
  assert.equal(resolveGateLimits({ common: s.root }).wall_seconds, WALL_DEFAULT_SECONDS);
  assert.equal(resolveGateLimits({ common: s.root }).idle_seconds, 0);
  for (const duration_s of [1865, 1900, 1855, 1853, 2067, 2158]) recordHealthyGate({ common: s.root, tier: 'promotion', command: 'full', duration_s, longest_silence_s: 120 });
  const derived = resolveGateLimits({ common: s.root, tier: 'promotion', command: 'full' });
  assert.equal(derived.wall_seconds, 4316); assert.equal(derived.wall_source, 'history');
  assert.equal(derived.idle_seconds, 360);
  const configured = resolveGateLimits({ common: s.root, tier: 'promotion', command: 'full', timeoutSeconds: 5000, idleTimeoutSeconds: 0 });
  assert.equal(configured.wall_seconds, 5000); assert.equal(configured.idle_seconds, 0);
  assert.equal(resolveGateLimits({ history: [{ duration_s: 10, longest_silence_s: 1 }] }).wall_seconds, WALL_DEFAULT_SECONDS);
  for (let i = 0; i < 20; i++) recordHealthyGate({ common: s.root, tier: 'promotion', command: 'narrow', duration_s: 180, longest_silence_s: 1 });
  assert.equal(healthyHistory(s.root, 'promotion', 'narrow').length, 20);
  assert.equal(resolveGateLimits({ common: s.root, tier: 'promotion', command: 'full' }).wall_seconds, 4316);
  assert.equal(resolveGateLimits({ common: s.root, tier: 'promotion', command: 'narrow' }).wall_seconds, 1200);
  const unknown = resolveGateLimits({ common: s.root, tier: 'promotion', command: 'new full' });
  assert.equal(unknown.wall_seconds, 4500); assert.equal(unknown.idle_seconds, 0);
  assert.equal(resolveGateLimits({ common: s.root, tier: 'promotion', command: 'full' }).idle_seconds, 360);
  assert.equal(resolveGateLimits({ common: s.root, tier: 'release' }).wall_source, 'default');
  for (const timeoutSeconds of [0, -1, NaN, Infinity]) assert.throws(() => resolveGateLimits({ timeoutSeconds }));
  for (const value of [{ timeout_seconds: -1 }, { idle_timeout_seconds: false }, { timeout_seconds: { unknown: 10 } }]) assert.throws(() => validateValidation(value));
  fs.writeFileSync(path.join(s.root, '.lane.validation.json'), JSON.stringify({ timeout_seconds: { promotion: 700 }, idle_timeout_seconds: 0 }));
  assert.equal(resolveValidation({ root: s.root, env: {} }).tiers.promotion.timeoutSeconds, 700);
  fs.writeFileSync(path.join(s.root, '.promote.json'), JSON.stringify({ gate: { timeout_seconds: 800, idle_timeout_seconds: 0 } }));
  assert.equal(resolveGateProfile(s.root, s.env).timeoutSeconds, 800);
});

for (const escaped of [false, true]) test(`wall timeout stops a forever-blocked grandchild${escaped ? ' in its own group' : ''}, releases slot and never retries under load`, { timeout: 20000 }, t => {
  const s = scratch(t), pids = path.join(s.root, 'pids');
  const preload = path.join(s.root, 'load.mjs'); fs.writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[1000,1000,1000];");
  s.env.NODE_OPTIONS = `--import=${preload}`;
  const leaf = path.join(s.root, 'leaf.cjs'), parent = path.join(s.root, 'parent.cjs');
  fs.writeFileSync(leaf, `require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');process.on('SIGTERM',()=>{});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
  fs.writeFileSync(parent, `require('fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');require('child_process').spawn(process.execPath,[${JSON.stringify(leaf)}],{detached:${escaped},stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const r = s.run(['--timeout-seconds', '0.5', '--retry-timeout-under-load'], [process.execPath, parent]);
  assert.equal(r.status, 124, r.stderr); assert.match(r.stderr, /GATE_TIMEOUT: wall limit 0.5s exceeded; elapsed/);
  assert.doesNotMatch(r.stderr, /TEST_SLOT_TIMEOUT_RETRY/);
  const receipt = JSON.parse(fs.readFileSync(s.result));
  assert.equal(receipt.attempts, 1); assert.equal(receipt.gate_timeout.kind, 'wall'); assert.ok(receipt.duration_s < 5);
  const ids = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number); assert.equal(ids.length, 2);
  for (const pid of ids) assert.equal(lookupProcess(pid, { identityOnly: true }).value, null, `pid ${pid} gone`);
  assert.throws(() => process.kill(-receipt.command_pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(s.lock), false); assert.equal(healthyHistory(s.root, 'promotion', [process.execPath, parent]).length, 0);
  assert.equal(s.run(['--timeout-seconds', '2'], [process.execPath, '-e', "console.log('healthy')"]).status, 0);
  assert.equal(healthyHistory(s.root, 'promotion', [process.execPath, '-e', "console.log('healthy')"]).length, 1);
});

test('enabled idle limit stops silence, output refreshes it and healthy clocks record final silence', { timeout: 15000 }, t => {
  const s = scratch(t);
  const r = s.run(['--timeout-seconds', '4', '--idle-timeout-seconds', '0.2'], [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(r.status, 124, r.stderr); assert.match(r.stderr, /GATE_TIMEOUT: idle limit/);
  assert.equal(JSON.parse(fs.readFileSync(s.result)).gate_timeout.kind, 'idle');
  const good = s.run(['--timeout-seconds', '4', '--idle-timeout-seconds', '0.3'], [process.execPath, '-e', "let n=0;const t=setInterval(()=>{console.log('alive');if(++n===6){clearInterval(t);setTimeout(()=>{},100);}},70)"]);
  assert.equal(good.status, 0, good.stderr);
  const history = healthyHistory(s.root, 'promotion', [process.execPath, '-e', "let n=0;const t=setInterval(()=>{console.log('alive');if(++n===6){clearInterval(t);setTimeout(()=>{},100);}},70)"]); assert.equal(history.length, 1);
  assert.ok(history[0].longest_silence_s >= .09); assert.ok(history[0].duration_s < 2);
  assert.equal(fs.existsSync(s.lock), false);
});

test('wall overrun and a descendant marker cannot spend a load retry', t => {
  assert.equal(shouldRetryTimeout({ status: 124, timeout: true, load: 100, gateTimeout: { kind: 'wall' } }), false);
  const s = scratch(t);
  const r = s.run(['--retry-timeout-under-load'], [process.execPath, '-e', "console.error('GATE_TIMEOUT: wall limit 1s exceeded; elapsed 1.001s');process.exit(124)"]);
  assert.equal(r.status, 124); assert.equal(JSON.parse(fs.readFileSync(s.result)).attempts, 1);
});

test('parent walk excludes unrelated processes and escaped-child signalling confirms birth', async () => {
  const row = (pid, ppid, pgid, identity) => ({ pid, ppid, pgid, identity, state: 'R' });
  const rows = new Map([row(1,0,1,'a'),row(2,1,2,'b'),row(3,2,3,'c'),row(4,0,4,'d')].map(r=>[r.pid,r]));
  assert.deepEqual([...descendants(rows,1).keys()], [1,2,3]);
  // The root group is gone; both escaped PIDs were reused before signalling.
  const signals = [];
  await stopGateGroup(99999999, { tracked: new Map([[2,rows.get(2)],[3,rows.get(3)]]),
    lookup: pid => ({ ok: true, value: pid ? null : new Map() }), signal: (...args) => signals.push(args), graceMs: 1 });
  assert.deepEqual(signals, []);
  await stopGateGroup(99999999, { rootIdentity: 'old-birth', lookup: () => ({ ok: true, value: new Map([[99999999, row(99999999, 0, 99999999, 'new-birth')]]) }), signal: (...args) => signals.push(args) });
  assert.deepEqual(signals, [], 'reused leader never authorizes group signals');
});

for (const operation of ['lane', 'queue', 'fast']) test(`${operation} records timeout, isolates correction and leaves main unchanged`, { timeout: 20000 }, t => {
  const f = fixture(t); fixtureFleet(t, f.root); f.env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  const fakeHerdr = path.join(f.root, 'herdr'); fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const declaration = JSON.parse(fs.readFileSync(path.join(f.repo, '.lane.validation.json')));
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ ...declaration, fast: declaration.promotion, timeout_seconds: { promotion: .4, fast: .4 }, idle_timeout_seconds: 0 }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Bound gate']); f.lane('topic');
  const base = f.git(['rev-parse', 'main']); f.body('setInterval(()=>{},1000);');
  if (operation === 'fast') {
    // A foreign scratch slot stays occupied; the narrow gate must never take it.
    const held = 'foreign scratch holder'; fs.writeFileSync(f.env.MONITOR_TEST_SLOT_PATH, held);
    const escaped = path.join(f.root, 'escaped.cjs'), marker = path.join(f.root, 'escaped.pid');
    fs.writeFileSync(escaped, `fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
    f.body(`require('child_process').spawn(process.execPath,[${JSON.stringify(escaped)}],{detached:true,stdio:'inherit'});setInterval(()=>{},1000);`);
    const r = f.exec(['check', '--tier', 'fast'], path.join(f.root, 'topic'));
    assert.equal(r.status, 124, r.stderr + r.stdout); assert.match(r.stdout, /GATE_TIMEOUT:/);
    assert.equal(fs.readFileSync(f.env.MONITOR_TEST_SLOT_PATH, 'utf8'), held);
    const gate = JSON.parse(fs.readFileSync(path.join(f.root, 'topic/.lane/gate.json')));
    assert.equal(gate.outcome, 'timeout'); assert.equal(gate.tier, 'fast');
    assert.equal(lookupProcess(Number(fs.readFileSync(marker)), { identityOnly: true }).value, null);
    assert.equal(healthyHistory(f.identity, 'fast', ['/bin/sh', '-c', declaration.promotion]).length, 0);
    f.body("console.log('healthy narrow gate');");
    const good = f.exec(['check', '--tier', 'fast'], path.join(f.root, 'topic')); assert.equal(good.status, 0, good.stderr);
    assert.equal(healthyHistory(f.identity, 'fast', ['/bin/sh', '-c', declaration.promotion]).length, 1);
    assert.equal(healthyHistory(f.identity, 'promotion', ['/bin/sh', '-c', declaration.promotion]).length, 0);
    fs.rmSync(f.env.MONITOR_TEST_SLOT_PATH);
  } else if (operation === 'lane') {
    const r = f.exec(['promote', 'topic']); assert.equal(r.status, 124, r.stderr + r.stdout);
    assert.match(r.stderr, /GATE_TIMEOUT:/);
    const dir = path.join(f.identity, 'lane-validation');
    const gate = fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&!n.endsWith('.execution.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n))))[0];
    assert.equal(gate.outcome, 'timeout'); assert.equal(gate.exit_code, 124);
  } else {
    const other = path.join(f.root, 'other'); f.git(['worktree', 'add', '-qb', 'lane/other', other]);
    fs.writeFileSync(path.join(other, 'other'), 'disjoint change'); f.git(['add', '.'], other); f.git(['commit', '-qm', 'Other'], other);
    const queue = queueFor(f.repo);
    enqueue(queue, ['topic', 'other'], { laneCLI: fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url)), org: null, to: 'offline', attempts: 1, retry: 0, herdr: fakeHerdr });
    f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../promote/promote.mjs', import.meta.url)), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const results = queue.load().results; assert.equal(results.length, 2);
    for (const result of results) { assert.equal(result.outcome, 'timeout', JSON.stringify(result)); assert.match(result.reason, /gate wall-clock limit exceeded; batch timed out; re-enqueue lanes individually/); }
    assert.equal(JSON.parse(fs.readFileSync(results[0].receipt)).attempts.length, 1, 'no bisection or replay');
  }
  assert.equal(f.git(['rev-parse', 'main']), base); assert.equal(fs.existsSync(f.env.MONITOR_TEST_SLOT_PATH), false);
});

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'fixture became ready');
}
test('slot waiting consumes none of a short command deadline', { timeout: 10000 }, async t => {
  const s = scratch(t), ready = path.join(s.root, 'ready');
  const owner = spawnChild(t, process.execPath, [cli, 'run', 'owner', '--project-common', s.root, '--timeout-seconds', '3', '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},1000);`], { cwd: s.root, env: s.env });
  await until(() => fs.existsSync(ready));
  const waiter = spawnChild(t, process.execPath, [cli, 'run', 'waiter', '--project-common', s.root, '--wait', '3', '--timeout-seconds', '.3', '--result-path', s.result, '--', process.execPath, '-e', 'setTimeout(()=>{},50)'], { cwd: s.root, env: s.env });
  const began = Date.now(), result = await waitForExit(waiter); await waitForExit(owner);
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - began > 800);
  const receipt = JSON.parse(fs.readFileSync(s.result)); assert.ok(receipt.duration_s < .3);
  assert.equal(receipt.gate_timeout, null); assert.equal(fs.existsSync(s.lock), false);
});
test('nested gates preserve the legacy holder pgid after both wrappers die', { timeout: 10000 }, async t => {
  const s = scratch(t), ready = path.join(s.root, 'ready');
  let holder;
  t.after(async () => { if (holder) await stopGateGroup(holder.pgid); });
  const owner = spawnChild(t, process.execPath, [cli, 'run', 'outer', '--project-common', s.root, '--', process.execPath, cli, 'run', 'inner', '--project-common', s.root, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`], { cwd: s.root, env: s.env });
  await until(() => fs.existsSync(ready));
  holder = JSON.parse(fs.readFileSync(s.lock));
  const leaf = Number(fs.readFileSync(ready));
  assert.equal(lookupProcess(leaf, { identityOnly: true }).value.pgid, holder.pgid);
  owner.kill('SIGKILL');
  process.kill(holder.pgid, 'SIGKILL'); // Inner wrapper only, never its shared group.
  await until(() => lookupProcess(holder.pgid, { identityOnly: true }).value === null);
  assert.doesNotThrow(() => process.kill(-holder.pgid, 0), 'legacy PGID stays live');
  const result = s.run([], [process.execPath, '-e', '']);
  assert.equal(result.status, 75, result.stderr); assert.match(result.stderr, /TEST_SLOT_HELD/);
  assert.ok(lookupProcess(leaf, { identityOnly: true }).value, 'nested command still lives');
  await stopGateGroup(holder.pgid); await waitForExit(owner);
  holder = null;
});

test('dead groups-lock owners recover and live or unknown owners fail with a coded path', async t => {
  const s = scratch(t), slot = await acquireTestSlot('guard', { lockPath: s.lock, env: s.env });
  t.after(() => slot.release());
  const dead = spawnSync(process.execPath, ['-e', ''], { env: s.env, timeout: 5000 });
  assert.equal(dead.status, 0, dead.error?.message);
  const guard = s.lock + '.groups-lock';
  fs.writeFileSync(guard, JSON.stringify({ pid: dead.pid, ...processStartRecord(process.pid) }));
  slot.setGroup(null, null);
  assert.equal(fs.existsSync(guard), false);
  for (const value of [JSON.stringify({ pid: process.pid, ...processStartRecord(process.pid) }), '{}']) {
    fs.writeFileSync(guard, value);
    assert.throws(() => slot.setGroup(null, null), error => error.code === HOLDER_UNKNOWN_CODE && error.message.includes(guard));
    assert.equal(fs.readFileSync(guard, 'utf8'), value);
    fs.rmSync(guard);
  }
});

for (const inheritedPipes of [true, false]) test(`leftover group fails distinctly after bounded grace (inherited pipes=${inheritedPipes})`, { timeout: 10000 }, t => {
  const s = scratch(t), ready = path.join(s.root, 'leftover.pid');
  const script = `const cp=require('child_process');const child=cp.spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:${inheritedPipes ? "'inherit'" : "'ignore'"}});require('fs').writeFileSync(${JSON.stringify(ready)},String(child.pid));child.unref();setTimeout(()=>process.exit(0),250);`;
  const r = s.run(['--timeout-seconds', '60', '--retry-timeout-under-load'], [process.execPath, '-e', script]);
  assert.equal(r.status, 123, r.stderr); assert.match(r.stderr, /GATE_LEFTOVER_GROUP:/);
  assert.doesNotMatch(r.stderr, /GATE_TIMEOUT:|TEST_SLOT_TIMEOUT_RETRY/);
  const receipt = JSON.parse(fs.readFileSync(s.result));
  assert.equal(receipt.gate_timeout, null); assert.equal(receipt.attempts, 1); assert.ok(receipt.duration_s < 5);
  assert.equal(fs.existsSync(s.lock), false);
  assert.equal(lookupProcess(Number(fs.readFileSync(ready)), { identityOnly: true }).value, null);
  assert.equal(healthyHistory(s.root, 'promotion', [process.execPath, '-e', script]).length, 0);
});

test('canonical validation includes layered lane-only wall and idle settings for both envelopes', t => {
  const f = fixture(t); fixtureFleet(t, f.root);
  const file = f.config;
  const config = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...config, validation: { timeout_seconds: { promotion: 10000, release: 11000 }, idle_timeout_seconds: { promotion: 900, release: 1000 } } }));
  const declared = canonicalValidation(f.repo, f.env);
  assert.equal(declared.tiers.promotion.timeoutSeconds, 10000);
  assert.equal(declared.tiers.release.timeoutSeconds, 11000);
  assert.equal(declared.tiers.promotion.idleTimeoutSeconds, 900);
  assert.equal(declared.tiers.release.idleTimeoutSeconds, 1000);
});

test('nested watchdog stops its parent-walk children and preserves a sibling in the shared group', { timeout: 10000 }, t => {
  const s = scratch(t), witness = path.join(s.root, 'nested.json'), script = path.join(s.root, 'nested.cjs');
  fs.writeFileSync(script, `const cp=require('child_process'),fs=require('fs');const sibling=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const result=cp.spawnSync(process.execPath,${JSON.stringify([cli, 'run', 'inner', '--project-common', s.root, '--timeout-seconds', '.3', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'])},{stdio:'inherit',env:process.env,timeout:2000});let alive=false;try{process.kill(sibling.pid,0);alive=true;}catch{}fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({status:result.status,alive}));sibling.kill('SIGTERM');sibling.once('close',()=>process.exit(result.status));`);
  const r = s.run(['--timeout-seconds', '5'], [process.execPath, script]);
  assert.equal(r.status, 124, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(witness)), { status: 124, alive: true });
  assert.equal(fs.existsSync(s.lock), false);
});

for (const status of [0, 1, 124]) test(`printed descendant timeout marker follows command status ${status}`, t => {
  const s = scratch(t);
  const r = s.run(['--no-slot'], [process.execPath, '-e', `console.error('GATE_TIMEOUT: wall limit 1s exceeded; elapsed 1.001s');process.exit(${status})`]);
  assert.equal(r.status, status, r.stderr);
  const receipt = JSON.parse(fs.readFileSync(s.result));
  assert.equal(receipt.gate_timeout?.descendant ?? false, status === 124);
});

test('failed descendant identity source stops the owned hung group and retains the slot', t => {
  const s = scratch(t), preload = path.join(s.root, 'deny.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,read=fs.readFileSync,list=fs.readdirSync;
cp.spawnSync=(file,argv,...args)=>String(file).includes('process-source-')&&!argv.includes(String(process.pid))?{error:Error('injected source failure')}:execute(file,argv,...args);
fs.readFileSync=(file,...args)=>String(file).startsWith('/proc/')&&Number.isInteger(Number(String(file).split('/')[2]))&&!String(file).startsWith('/proc/'+process.pid+'/')?(()=>{throw Error('injected source failure');})():read(file,...args);
fs.readdirSync=(file,...args)=>String(file)==='/proc'?(()=>{throw Error('injected source failure');})():list(file,...args);syncBuiltinESMExports();`);
  s.env.NODE_OPTIONS = `--import=${preload}`;
  const r = s.run(['--timeout-seconds', '.3'], [process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  assert.equal(r.status, 124, r.stderr);
  assert.match(r.stderr, /GATE_TIMEOUT_CLEANUP_FAILED: cannot snapshot gate descendants: .*injected source failure.*slot retained/);
  const receipt = JSON.parse(fs.readFileSync(s.result));
  assert.equal(receipt.gate_timeout.kind, 'wall');
  assert.match(receipt.cleanup_error, /cannot snapshot gate descendants: .*injected source failure/);
  assert.ok(receipt.duration_s < 5);
  assert.throws(() => process.kill(-receipt.command_pid, 0), { code: 'ESRCH' });
  const holder = JSON.parse(fs.readFileSync(s.lock));
  assert.equal(holder.pgid, receipt.command_pid);
  assert.equal(holder.groupStart, null, 'the injected child start lookup also failed');
});

test('planned train file lists record and resolve one declared command history', t => {
  const f = fixture(t);
  const base = JSON.parse(fs.readFileSync(path.join(f.repo, '.lane.validation.json'))).promotion;
  fs.writeFileSync(path.join(f.repo, 'planner.mjs'), `const files=JSON.parse(process.argv[3]).filter(f=>f.endsWith('.test.mjs'));if(process.argv[2]==='--plan')console.log(JSON.stringify({files}));`);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: base, promotion_tests: 'planner.mjs' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'Declare planner']);
  const key = gateHistoryKey('promotion', ['/bin/sh', '-c', base]);
  for (let i = 0; i < 3; i++) recordHealthyGate({ common: f.identity, tier: 'promotion', historyKey: key, duration_s: 6000, longest_silence_s: 110 });
  const commands = [];
  for (const topic of ['first', 'second']) {
    const lane = f.lane(topic);
    fs.writeFileSync(path.join(lane, `${topic}.test.mjs`), ''); f.git(['add', '.'], lane); f.git(['commit', '-qm', 'Selected test'], lane);
    const batch = f.batch([topic]); const r = batch.run(); assert.equal(r.status, 0, r.stderr + r.stdout);
    const gate = batch.read().attempts[0].gate;
    commands.push(gate.command);
    assert.equal(gate.limits.wall_seconds, 12000); assert.equal(gate.limits.wall_source, 'history');
  }
  assert.notEqual(commands[0], commands[1]);
  const file = historyFile(f.identity, 'promotion', undefined, key);
  assert.equal(healthyHistory(f.identity, 'promotion', undefined, file, key).length, 5);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(n=>n.endsWith('.json')).length, 1);
});

test('healthy history prunes old command files while preserving the current key', t => {
  const s = scratch(t), directory = path.dirname(historyFile(s.root, 'promotion', ['current'])); fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < HISTORY_FILES + 5; i++) {
    const file = historyFile(s.root, 'promotion', ['old', i]); fs.writeFileSync(file, '{}'); fs.utimesSync(file, 1 + i, 1 + i);
  }
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'unrelated');
  recordHealthyGate({ common: s.root, tier: 'promotion', command: ['current'], duration_s: 1, longest_silence_s: 1 });
  assert.equal(fs.readdirSync(directory).filter(n=>n.endsWith('.json')).length, HISTORY_FILES);
  assert.equal(fs.existsSync(historyFile(s.root, 'promotion', ['old', 0])), false);
  assert.equal(healthyHistory(s.root, 'promotion', ['current']).length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated');
});

for (const kind of ['wall', 'idle']) test(`unbatched queue maps ${kind} timeout to correction wording`, t => {
  const f = fixture(t); fixtureFleet(t, f.root); f.env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  f.lane('topic');
  const fakeHerdr = path.join(f.root, 'herdr'); fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const laneCLI = path.join(f.root, 'lane.cjs');
  fs.writeFileSync(laneCLI, `console.error('GATE_TIMEOUT: ${kind} gate limit exceeded; lane retained for correction; nothing merged');process.exit(124);`);
  const queue = queueFor(f.repo);
  enqueue(queue, ['topic'], { laneCLI, org: null, to: 'offline', attempts: 1, retry: 0, herdr: fakeHerdr });
  f.env.SUPERVISOR_INPUT_WAIT_SECONDS = '0';
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../promote/promote.mjs', import.meta.url)), '--drain'], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const result = queue.load().results[0]; assert.equal(result.outcome, 'timeout');
  assert.equal(result.reason, `gate ${kind === 'idle' ? 'no-output' : 'wall-clock'} limit exceeded; lane isolated for correction`);
  assert.equal(f.git(['rev-parse', 'main']), f.base);
});

test('an unknown escaped identity cannot prevent killing the owned group', async t => {
  const s = scratch(t), ready = path.join(s.root, 'ready');
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { detached: true, env: s.env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); await exited; });
  await until(() => fs.existsSync(ready));
  const escaped = { pid: 99999999, ppid: child.pid, pgid: 99999999, identity: '1:1' };
  await assert.rejects(stopGateGroup(child.pid, { ownedChild: true, graceMs: 50,
    lookup: pid => pid ? { ok: false, error: 'injected escaped identity failure' } : { ok: true, value: new Map([[child.pid, { pid: child.pid, ppid: process.pid, pgid: child.pid, identity: '2:2' }], [escaped.pid, escaped]]) } }), /cannot confirm gate descendant/);
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  const result = await exited; assert.equal(result.signal, 'SIGKILL');
});

test('fixture gates cannot create or modify the real repository history', t => {
  const s = scratch(t), common = projectCommon(path.dirname(cli));
  assert.ok(common, 'this regression exercises the actual shared Git common directory');
  const real = path.join(common, 'gate-watchdog');
  const command = [process.execPath, '-e', `console.log(${JSON.stringify(s.root)})`];
  const result = spawnSync(process.execPath, [cli, 'run', 'release adapter', '--lock-path', s.lock,
    '--project-common', common, '--tier', 'release', '--', ...command], { cwd: path.dirname(cli), env: s.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const file = historyFile(common, 'release', command);
  assert.ok(file.startsWith(process.env.MONITOR_GATE_HISTORY_ROOT + path.sep));
  assert.ok(fs.existsSync(file), 'this command key exists in scratch');
  assert.equal(fs.existsSync(historyFile(common, 'release', command, undefined, {})), false, 'this command key is absent from real history');
  assert.ok(gateHistories(real).every(history => history.command_fingerprint !== gateHistoryKey('release', command).command_fingerprint),
    'no real-history file contains this fixture command fingerprint');
  assert.equal(healthyHistory(common, 'release', command).length, 1, 'the gate records only in scratch');
  assert.notEqual(file, historyFile(s.root, 'release', command), 'projects keep separate histories inside one scratch root');
  assert.throws(() => historyFile(common, 'release', command, undefined, { MONITOR_GATE_HISTORY_ROOT: 'relative' }));
});

// Exercise the guard's default Git identity in an independent repository, so
// even the deliberate leak below cannot write the operator's history.
for (const writer of ['unattributed', 'foreign', 'descendant-leak']) test(`history origin guard handles a concurrent ${writer} writer`, t => {
  const s = scratch(t), repo = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of ['test/helpers/gate-history.mjs', 'test-slot/limits.mjs', 'lanes/promotion-lock.mjs', 'lib/deadline.mjs', 'lib/files.mjs']) {
    const target = path.join(s.root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, name), target);
  }
  const git = spawnSync('git', ['init', '-q', s.root], { env: s.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(git.status, 0, git.stderr);
  const common = projectCommon(s.root), command = ['concurrent', writer];
  const child = path.join(s.root, 'writer.mjs'), guarded = path.join(s.root, 'guarded.mjs');
  fs.writeFileSync(child, `
    import { isolateGateHistory } from './test/helpers/gate-history.mjs';
    import { recordHealthyGate } from './test-slot/limits.mjs';
    ${writer === 'descendant-leak' ? 'isolateGateHistory();' : ''}
    delete process.env.MONITOR_GATE_HISTORY_ROOT;
    ${writer === 'unattributed' ? 'delete process.env.MONITOR_GATE_HISTORY_ORIGIN;' : writer === 'foreign' ? "process.env.MONITOR_GATE_HISTORY_ORIGIN = 'other-process-tree';" : ''}
    recordHealthyGate({ common: ${JSON.stringify(common)}, command: ${JSON.stringify(command)}, duration_s: 60, longest_silence_s: 1 });
  `);
  fs.writeFileSync(guarded, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { isolateGateHistory } from './test/helpers/gate-history.mjs';
    delete process.env.MONITOR_GATE_HISTORY_ORIGIN;
    isolateGateHistory();
    assert.ok(process.env.MONITOR_GATE_HISTORY_ORIGIN);
    fs.writeFileSync(${JSON.stringify(path.join(s.root, 'origin'))}, process.env.MONITOR_GATE_HISTORY_ORIGIN);
    const result = spawnSync(process.execPath, [${JSON.stringify(child)}], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, ${writer === 'descendant-leak' ? 1 : 0}, result.stderr);
    // Unrelated transient locks must not affect the attribution check either.
    fs.mkdirSync(${JSON.stringify(path.join(common, 'gate-watchdog/.history.lock'))});
  `);
  const result = spawnSync(process.execPath, [guarded], { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 20000 });
  const sample = healthyHistory(common, 'gate', command, historyFile(common, 'gate', command, undefined, {}))[0];
  assert.ok(sample, 'the non-slot writer published under the guarded real Git identity');
  if (writer === 'descendant-leak') {
    assert.equal(sample.origin, fs.readFileSync(path.join(s.root, 'origin'), 'utf8'), 'nested helper preserves the process-tree origin');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /TEST_GATE_HISTORY_LEAK/);
  } else {
    assert.equal(sample.origin, writer === 'foreign' ? 'other-process-tree' : undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /TEST_GATE_HISTORY_LEAK/);
    assert.match(result.stderr, /TEST_GATE_HISTORY_DIAGNOSTIC/);
  }
});

test('three sane samples are required for wall and idle derivation, including legacy fixture history', () => {
  for (const tier of ['promotion', 'release', 'release-prepare', 'test:acceptance']) {
    const floor = sampleFloorSeconds(tier), sane = { duration_s: floor, longest_silence_s: 1 };
    for (const history of [[], [sane], [sane, sane], Array(20).fill({ duration_s: floor - .01, longest_silence_s: 1 }),
      [sane, sane, ...Array(18).fill({ duration_s: .5, longest_silence_s: .02 })]]) {
      const limits = resolveGateLimits({ tier, history });
      assert.equal(limits.wall_source, 'default'); assert.equal(limits.wall_seconds, 4500);
      assert.equal(limits.idle_seconds, 0); assert.equal(limits.idle_source, 'off');
    }
    const derived = resolveGateLimits({ tier, history: [sane, sane, sane, { duration_s: .5, longest_silence_s: .02 }] });
    assert.equal(derived.wall_source, 'history'); assert.equal(derived.wall_seconds, wallFloorSeconds(tier));
    assert.equal(derived.idle_source, 'history'); assert.equal(derived.idle_seconds, 300);
    const config = resolveGateLimits({ tier, history: [], timeoutSeconds: .25, idleTimeoutSeconds: .1 });
    assert.equal(config.wall_seconds, .25); assert.equal(config.idle_seconds, .1);
  }
});

test('observed healthy full gates fit clean-history defaults and trained limits', () => {
  for (const [tier, durations, expected] of [['promotion', [420, 510, 600], 1200],
    ['release', [1200, 1500, 1800], 3600], ['pnpm validate:all-safe', [1865, 2158, 2340], 4680]]) {
    const history = durations.map(duration_s => ({ duration_s, longest_silence_s: 100 }));
    assert.equal(resolveGateLimits({ tier, history: [] }).wall_seconds, 4500);
    assert.equal(resolveGateLimits({ tier, history }).wall_seconds, expected);
    assert.ok(expected >= 2 * Math.max(...durations));
    assert.ok(4500 > Math.max(...durations));
  }
});
