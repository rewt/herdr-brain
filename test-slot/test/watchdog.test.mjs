import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGateLimits, recordHealthyGate, healthyHistory, WALL_DEFAULT_SECONDS } from '../limits.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { shouldRetryTimeout } from '../test-slot.mjs';
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
  const env = { ...process.env, MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  for (const key of ['MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED']) delete env[key];
  const run = (args, command) => spawnSync(process.execPath, [cli, 'run', 'fake', '--project-common', root, '--tier', 'promotion', '--result-path', result, ...args, '--', ...command], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  return { root, lock, result, env, run };
}

test('config, recent healthy clocks and conservative default resolve independently of slot waiting', t => {
  const s = scratch(t);
  assert.equal(resolveGateLimits({ common: s.root }).wall_seconds, WALL_DEFAULT_SECONDS);
  assert.equal(resolveGateLimits({ common: s.root }).idle_seconds, 0);
  for (const duration_s of [1865, 1900, 1855, 1853, 2067, 2158]) recordHealthyGate({ common: s.root, tier: 'promotion', command: 'full', duration_s, longest_silence_s: 120 });
  const derived = resolveGateLimits({ common: s.root, tier: 'promotion' });
  assert.equal(derived.wall_seconds, 4316); assert.equal(derived.wall_source, 'history');
  assert.equal(derived.idle_seconds, 360);
  const configured = resolveGateLimits({ common: s.root, tier: 'promotion', timeoutSeconds: 5000, idleTimeoutSeconds: 0 });
  assert.equal(configured.wall_seconds, 5000); assert.equal(configured.idle_seconds, 0);
  assert.equal(resolveGateLimits({ history: [{ duration_s: 10, longest_silence_s: 1 }] }).wall_seconds, 600);
  for (let i = 0; i < 20; i++) recordHealthyGate({ common: s.root, tier: 'promotion', command: 'narrow', duration_s: 10, longest_silence_s: 1 });
  assert.equal(healthyHistory(s.root, 'promotion').length, 20);
  assert.equal(resolveGateLimits({ common: s.root, tier: 'promotion' }).wall_seconds, 600);
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
  assert.equal(fs.existsSync(s.lock), false); assert.equal(healthyHistory(s.root, 'promotion').length, 0);
  assert.equal(s.run(['--timeout-seconds', '2'], [process.execPath, '-e', "console.log('healthy')"]).status, 0);
  assert.equal(healthyHistory(s.root, 'promotion').length, 1);
});

test('enabled idle limit stops silence, output refreshes it and healthy clocks record final silence', { timeout: 15000 }, t => {
  const s = scratch(t);
  const r = s.run(['--timeout-seconds', '4', '--idle-timeout-seconds', '0.2'], [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(r.status, 124, r.stderr); assert.match(r.stderr, /GATE_TIMEOUT: idle limit/);
  assert.equal(JSON.parse(fs.readFileSync(s.result)).gate_timeout.kind, 'idle');
  const good = s.run(['--timeout-seconds', '4', '--idle-timeout-seconds', '0.3'], [process.execPath, '-e', "let n=0;const t=setInterval(()=>{console.log('alive');if(++n===6){clearInterval(t);setTimeout(()=>{},100);}},70)"]);
  assert.equal(good.status, 0, good.stderr);
  const history = healthyHistory(s.root, 'promotion'); assert.equal(history.length, 1);
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
    assert.equal(healthyHistory(f.identity, 'fast').length, 0);
    f.body("console.log('healthy narrow gate');");
    const good = f.exec(['check', '--tier', 'fast'], path.join(f.root, 'topic')); assert.equal(good.status, 0, good.stderr);
    assert.equal(healthyHistory(f.identity, 'fast').length, 1);
    assert.equal(healthyHistory(f.identity, 'promotion').length, 0);
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
    for (const result of results) { assert.equal(result.outcome, 'timeout', JSON.stringify(result)); assert.match(result.reason, /gate wall-clock limit exceeded; lane isolated for correction/); }
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
test('detached nested groups still protect a slot when both wrappers die', { timeout: 10000 }, async t => {
  const s = scratch(t), ready = path.join(s.root, 'ready');
  let nested;
  t.after(async () => { if (nested) await stopGateGroup(nested.pgid); });
  const owner = spawnChild(t, process.execPath, [cli, 'run', 'outer', '--project-common', s.root, '--', process.execPath, cli, 'run', 'inner', '--project-common', s.root, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: s.root, env: s.env });
  await until(() => fs.existsSync(ready) && Object.values(JSON.parse(fs.readFileSync(s.lock)).groups ?? {}).some(g => g.birth));
  const holder = JSON.parse(fs.readFileSync(s.lock)); nested = Object.values(holder.groups)[0];
  owner.kill('SIGKILL'); await waitForExit(owner); process.kill(-holder.pgid, 'SIGKILL');
  await until(() => lookupProcess(holder.pgid, { identityOnly: true }).value === null);
  const result = s.run([], [process.execPath, '-e', '']);
  assert.equal(result.status, 75, result.stderr); assert.match(result.stderr, /TEST_SLOT_HELD/);
  assert.ok(lookupProcess(nested.pgid, { identityOnly: true }).value, 'nested command still lives');
});
