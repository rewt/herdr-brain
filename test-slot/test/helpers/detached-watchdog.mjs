import { provingRun } from './proving.mjs';
// Fixed native-group scenarios, invoked only by detached-fixture.mjs. Their
// original process-group assertions require real detachment, while the normal
// test runner deliberately contains arbitrary product children in its group.
import test from '../../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnChild, waitForExit } from '../../../test/helpers/child.mjs';
import { testSlotEnvironment } from '../../../test/helpers/test-slot-env.mjs';
import { lookupProcess } from '../../../lib/processes.mjs';
import { stopGateGroup } from '../../watchdog.mjs';
import { healthyHistory } from '../../limits.mjs';
import { readProvingReservations, waitForProvingHold } from '../../reservations.mjs';
import { registerProcess, killProcess } from '../../../test/helpers/processes.mjs';
import { resourceStanza } from '../../resources.mjs';

const [root, mode] = process.argv.slice(2);
const cli = fileURLToPath(new URL('../../test-slot.mjs', import.meta.url));
const preload = fileURLToPath(new URL('../../../test/helpers/native-group-fixture.mjs', import.meta.url));
const lock = path.join(root, 'slot'), result = path.join(root, 'result.json');
const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
  HERDR_NATIVE_GROUP_FIXTURE_ROOT: root, NODE_OPTIONS: `--import=${JSON.stringify(preload)}` };
const run = (args, command) => spawnSync(process.execPath,
  provingRun([cli, 'run', 'fake', '--project-common', root, '--tier', 'promotion', '--result-path', result, ...args, '--', ...command]),
  { cwd: root, env, encoding: 'utf8', timeout: 15000 });
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'fixture became ready');
}

if (['reservation-expiry', 'floor-expiry'].includes(mode)) test('expired reservation and both locks retain a dead wrapper\'s real owned group', { timeout: 10000 }, async t => {
  const workspace = path.join(root, 'workspace-slot'), ready = path.join(root, 'payload-ready');
  env.MONITOR_TEST_SLOT_PATH = workspace;
  let group;
  t.after(() => { if (group) { const result = killProcess(group); assert.ok(result.ok, result.reason); } });
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`];
  const resource = { ...resourceStanza('fixture/expiry', command, 'EXCLUSIVE'), ...(mode === 'floor-expiry' ? { memory_floor_bytes: 0 } : {}) };
  const owner = spawnChild(t, process.execPath, [cli, 'run', 'expiry owner', '--timeout-seconds', '60', '--resource', JSON.stringify(resource), '--', ...command], { cwd: root, env });
  await until(() => fs.existsSync(ready));
  const row = readProvingReservations(lock)[0], pid = Number(fs.readFileSync(ready));
  assert.equal(row.record.pid, owner.pid); assert.equal(row.record.pgid, pid);
  group = registerProcess(pid, true);
  assert.equal(lookupProcess(pid, { identityOnly: true }).value.pgid, pid, 'the fixture owns a real detached process group');
  owner.kill('SIGKILL'); await waitForExit(owner);
  const now = Date.now(), expired = { ...row.record, acquiredAt: new Date(now - 60000).toISOString(),
    expectedEnd: new Date(now - 30000).toISOString(), expiresAt: new Date(now - 1000).toISOString() };
  const bytes = JSON.stringify(expired) + '\n'; fs.writeFileSync(row.path, bytes);
  const locks = [lock, workspace].map(file => fs.readFileSync(file, 'utf8'));
  assert.equal(readProvingReservations(lock, { prune: true })[0].state, 'expired');
  waitForProvingHold({ env, deadline: performance.now(), notify: () => {}, sleep: () => assert.fail('expired launch wait') });
  const blocked = run([], [process.execPath, '-e', 'throw Error("second prover started")']);
  assert.equal(blocked.status, 75, blocked.stderr); assert.match(blocked.stderr, /TEST_SLOT_HELD|TEST_SLOT_HOLDER_UNKNOWN/);
  assert.equal(fs.readFileSync(row.path, 'utf8'), bytes);
  assert.deepEqual([lock, workspace].map(file => fs.readFileSync(file, 'utf8')), locks);
  const stopped = killProcess(group); assert.ok(stopped.ok && stopped.signaled, stopped.reason); group = null;
  await until(() => readProvingReservations(lock)[0].state === 'gone');
  assert.equal(readProvingReservations(lock, { prune: true })[0].state, 'gone'); assert.equal(fs.existsSync(row.path), false);
  const next = run([], [process.execPath, '-e', 'console.log("next prover")']);
  assert.equal(next.status, 0, next.stderr); assert.match(next.stdout, /next prover/);
});

if (mode === 'floor-cancellation') test('cancellation retains a granted proving group until its signal cleanup completes', { timeout: 10000 }, async t => {
  const ready = path.join(root, 'ready'), term = path.join(root, 'term');
  const command = [process.execPath, '-e', `const fs=require('fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(term)},'term'));
    fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`];
  const resource = { ...resourceStanza('fixture/cancel', command, 'EXCLUSIVE'), memory_floor_bytes: 0 };
  const owner = spawnChild(t, process.execPath, [cli, 'run', 'cancel owner', '--timeout-seconds', '60', '--resource', JSON.stringify(resource), '--', ...command], { cwd: root, env });
  await until(() => fs.existsSync(ready));
  const row = readProvingReservations(lock)[0], group = registerProcess(Number(fs.readFileSync(ready)), true);
  t.after(() => { const stopped = killProcess(group); assert.ok(stopped.ok, stopped.reason); });
  owner.kill('SIGTERM'); await until(() => fs.existsSync(term));
  assert.equal(readProvingReservations(lock)[0].state, 'live'); assert.ok(fs.existsSync(row.path)); assert.ok(fs.existsSync(lock));
  assert.equal(JSON.parse(fs.readFileSync(lock)).pgid, group.pid);
  const result = await waitForExit(owner); assert.equal(result.code, 137, result.stderr);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(row.path), false);
});

if (mode === 'gate-pgid') test('nested gates preserve the legacy holder pgid after both wrappers die', { timeout: 10000 }, async t => {
  const ready = path.join(root, 'ready');
  let holder;
  t.after(async () => { if (holder) await stopGateGroup(holder.pgid); });
  const owner = spawnChild(t, process.execPath, provingRun([cli, 'run', 'outer', '--project-common', root, '--', process.execPath, cli, 'run', 'inner', '--project-common', root, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`]), { cwd: root, env });
  await until(() => fs.existsSync(ready));
  holder = JSON.parse(fs.readFileSync(lock));
  const leaf = Number(fs.readFileSync(ready));
  assert.equal(lookupProcess(leaf, { identityOnly: true }).value.pgid, holder.pgid);
  owner.kill('SIGKILL');
  process.kill(holder.pgid, 'SIGKILL'); // Inner wrapper only, never its shared group.
  await until(() => lookupProcess(holder.pgid, { identityOnly: true }).value === null);
  assert.doesNotThrow(() => process.kill(-holder.pgid, 0), 'legacy PGID stays live');
  const outcome = run([], [process.execPath, '-e', '']);
  assert.equal(outcome.status, 75, outcome.stderr); assert.match(outcome.stderr, /TEST_SLOT_HELD/);
  assert.ok(lookupProcess(leaf, { identityOnly: true }).value, 'nested command still lives');
  await stopGateGroup(holder.pgid); await waitForExit(owner);
  holder = null;
});

if (['gate-leftover-pipes', 'gate-leftover-ignore'].includes(mode)) {
  const inheritedPipes = mode === 'gate-leftover-pipes';
  test(`leftover group fails distinctly after bounded grace (inherited pipes=${inheritedPipes})`, { timeout: 10000 }, () => {
    const ready = path.join(root, 'leftover.pid');
    const script = `const cp=require('child_process');const child=cp.spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:${inheritedPipes ? "'inherit'" : "'ignore'"}});require('fs').writeFileSync(${JSON.stringify(ready)},String(child.pid));child.unref();setTimeout(()=>process.exit(0),250);`;
    const outcome = run(['--timeout-seconds', '60', '--retry-timeout-under-load'], [process.execPath, '-e', script]);
    assert.equal(outcome.status, 123, outcome.stderr); assert.match(outcome.stderr, /GATE_LEFTOVER_GROUP:/);
    assert.doesNotMatch(outcome.stderr, /GATE_TIMEOUT:|TEST_SLOT_TIMEOUT_RETRY/);
    const receipt = JSON.parse(fs.readFileSync(result));
    assert.equal(receipt.gate_timeout, null); assert.equal(receipt.attempts, 1); assert.ok(receipt.duration_s < 5);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(lookupProcess(Number(fs.readFileSync(ready)), { identityOnly: true }).value, null);
    assert.equal(healthyHistory(root, 'promotion', [process.execPath, '-e', script]).length, 0);
  });
}

if (mode === 'gate-identity') test('unknown process activity never proves a freeze', () => {
  const deny = path.join(root, 'deny.mjs');
  fs.writeFileSync(deny, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,read=fs.readFileSync,list=fs.readdirSync;
cp.spawnSync=(file,argv,...args)=>String(file).includes('process-source-')&&!argv.includes(String(process.pid))?{error:Error('injected source failure')}:execute(file,argv,...args);
fs.readFileSync=(file,...args)=>String(file).startsWith('/proc/')&&Number.isInteger(Number(String(file).split('/')[2]))&&!String(file).startsWith('/proc/'+process.pid+'/')?(()=>{throw Error('injected source failure');})():read(file,...args);
fs.readdirSync=(file,...args)=>String(file)==='/proc'?(()=>{throw Error('injected source failure');})():list(file,...args);syncBuiltinESMExports();`);
  env.NODE_OPTIONS += ` --import=${JSON.stringify(deny)}`;
  env.MONITOR_TEST_SLOT_FROZEN_SECONDS = '.15';
  const outcome = run(['--timeout-seconds', '.1'], [process.execPath, '-e', "setTimeout(()=>{},550)"]);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, /GATE_TIMEOUT:/);
  const receipt = JSON.parse(fs.readFileSync(result));
  assert.equal(receipt.gate_timeout, null);
  assert.ok(receipt.activity_audits.unavailable > 0);
  assert.equal(fs.existsSync(lock), false);
});
