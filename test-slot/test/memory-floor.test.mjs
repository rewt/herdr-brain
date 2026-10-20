import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForMemoryFloor } from '../memory-floor.mjs';

import { resourceStanza } from '../resources.mjs';
import { readProvingReservations, reservationState, waitForProvingHold } from '../reservations.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { spawnDetachedFixture } from '../../test/helpers/detached.mjs';
import { waitForExit } from '../../test/helpers/child.mjs';

test('an exhausted budget before sampling does not assert measured low memory', async () => {
  await assert.rejects(waitForMemoryFloor({ floor: 10, deadline: 10, now: () => 10,
    read: () => assert.fail('deadline exhausted before any sample'),
    sleep: () => assert.fail('exhausted admission must not wait') }), error => {
    assert.equal(error.code, 'TEST_SLOT_MEMORY');
    assert.match(error.message, /exhausted before a qualifying memory sample; floor 10 bytes/);
    assert.doesNotMatch(error.message, /available memory below floor/);
    return true;
  });
});

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + loadTimeout(10000);
  while (!predicate()) { assert.ok(Date.now() < deadline, 'floor fixture became ready'); await sleep(20); }
}

test('measured-low memory uses the remaining lock budget, never samples after its deadline, and logs only changes', async () => {
  let now = 3000, reads = 0; const sleeps = [], lines = [];
  await assert.rejects(waitForMemoryFloor({ floor: 10, deadline: 5500, now: () => now,
    read: () => { reads++; return { available: 9 }; }, sleep: ms => { sleeps.push(ms); now += ms; },
    notify: line => lines.push(line) }), { code: 'TEST_SLOT_MEMORY' });
  assert.equal(now, 5500); assert.equal(reads, 3); assert.deepEqual(sleeps, [1000, 1000, 500]);
  assert.equal(lines.length, 1); assert.match(lines[0], /^TEST_SLOT_MEMORY_WAIT:.*floor 10 bytes; admission deadline/);
});

test('recovery requires fresh ownership on each sample and grants within the original budget', async () => {
  let now = 0, confirmations = 0; const values = [1, 2, 10], lines = [];
  const memory = await waitForMemoryFloor({ floor: 10, deadline: 3000, now: () => now,
    read: () => ({ available: values.shift() }), confirm: () => { confirmations++; },
    sleep: ms => { now += ms; }, notify: line => lines.push(line) });
  assert.equal(memory.available, 10); assert.equal(now, 2000); assert.equal(confirmations, 6); assert.equal(lines.length, 2);
});

for (const available of [null, undefined, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
  test(`an invalid sample (${String(available)}) is an immediate named unknown`, async () => {
    await assert.rejects(waitForMemoryFloor({ floor: 0, deadline: 1000, now: () => 0,
      read: () => ({ available }), sleep: () => assert.fail('unknown must not wait') }), { code: 'TEST_SLOT_HOLDER_UNKNOWN' });
  });

test('an unreadable sample refuses immediately, and ownership loss after a good sample cannot grant', async () => {
  await assert.rejects(waitForMemoryFloor({ floor: 0, deadline: 1000, now: () => 0,
    read: () => { throw Error('unreadable'); } }), { code: 'TEST_SLOT_HOLDER_UNKNOWN' });
  let confirms = 0;
  await assert.rejects(waitForMemoryFloor({ floor: 0, deadline: 1000, now: () => 0,
    read: () => ({ available: 10 }), confirm: () => { if (++confirms === 2) throw Error('ownership lost'); } }), /ownership lost/);
});

test('fallback free memory and invalid capacity are unknown, while validated availability survives an unavailable swap probe', async () => {
  for (const memory of [{ available: 10, source: 'os.freemem (fallback)' }, { available: 10, total: 9 }, { available: 0, total: 0 }])
    await assert.rejects(waitForMemoryFloor({ floor: 0, deadline: 1000, now: () => 0,
      read: () => memory, sleep: () => assert.fail('unknown sample waited') }), { code: 'TEST_SLOT_HOLDER_UNKNOWN' });
  const sample = { available: 10, total: 20, source: 'vm_stat (swap unavailable)', warning: 'swap probe failed' };
  assert.equal(await waitForMemoryFloor({ floor: 10, deadline: 1000, now: () => 0, read: () => sample }), sample);
});

test('zero budget samples exactly once; a late probe cannot grant a nonzero budget', async () => {
  for (const available of [0, 10]) {
    let reads = 0;
    const attempt = waitForMemoryFloor({ floor: 10, deadline: 0, immediate: true, now: () => 5,
      read: () => { reads++; return { available }; }, sleep: () => assert.fail('immediate attempt slept'), notify: () => {} });
    if (available === 10) assert.equal((await attempt).available, 10);
    else await assert.rejects(attempt, { code: 'TEST_SLOT_MEMORY' });
    assert.equal(reads, 1);
  }
  let now = 0;
  await assert.rejects(waitForMemoryFloor({ floor: 0, deadline: 10, now: () => now,
    read: () => { now = 10; return { available: 10 }; }, notify: () => {} }), { code: 'TEST_SLOT_MEMORY' });
});

test('the asynchronous wait is signal-cancellable without waiting for the next sample', async () => {
  const controller = new AbortController(); let reads = 0;
  const promise = waitForMemoryFloor({ floor: 10, deadline: Date.now() + 60000, signal: controller.signal,
    read: () => { reads++; return { available: 0 }; }, notify: () => {} });
  controller.abort('SIGTERM'); await assert.rejects(promise, { name: 'AbortError' }); assert.equal(reads, 1);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proving-floor-')));
  const compat = path.join(root, 'compat'), lock = path.join(root, 'workspace');
  const marker = path.join(root, 'payload'), receipt = path.join(root, 'grant.json'), resultPath = path.join(root, 'execution.json');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: compat,
    HERDR_MONITOR_FLEET: path.join(root, 'fleet') };
  const owners = [];
  t.after(async () => {
    for (const owner of owners) if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await Promise.all(owners.map(owner => owner.done));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`];
  const resource = (floor = 0, argv = command) => ({ ...resourceStanza('fixture/floor', argv, 'EXCLUSIVE'), memory_floor_bytes: floor });
  const args = (floor, extra = [], argv = command) => [cli, 'run', 'floor witness', '--wait', '0', '--timeout-seconds', '20',
    '--wait-receipt-path', receipt, '--result-path', resultPath, '--resource', JSON.stringify(resource(floor, argv)), ...extra, '--', ...argv];
  const run = (floor, extra = [], overrides = {}, argv = command) => spawnSync(process.execPath, args(floor, extra, argv),
    { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: loadTimeout(20000) });
  const start = (floor, extra = [], overrides = {}, argv = command) => {
    const child = spawn(process.execPath, args(floor, extra, argv), { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    const owner = { child, stdout: '', stderr: '' };
    child.stdout.on('data', b => { owner.stdout += b; }); child.stderr.on('data', b => { owner.stderr += b; });
    owner.done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr: owner.stderr })));
    owners.push(owner); return owner;
  };
  const clean = () => {
    for (const file of [lock, compat]) {
      assert.equal(fs.existsSync(file), false);
      assert.deepEqual(fs.existsSync(`${file}.queue`) ? fs.readdirSync(`${file}.queue`) : [], []);
    }
    assert.deepEqual(readProvingReservations(compat), []);
  };
  return { root, compat, lock, env, marker, receipt, resultPath, command, resource, args, run, start, clean };
}

test('the CLI waits only its one-second budget, never grants/starts, and removes both locks, reservation and tickets', t => {
  const f = fixture(t), started = Date.now();
  const result = f.run(Number.MAX_SAFE_INTEGER, ['--wait', '1']);
  assert.equal(result.status, 75, result.stderr); assert.match(result.stderr, /^TEST_SLOT_MEMORY:/m);
  assert.doesNotMatch(result.stderr, /TEST_SLOT_MEMORY_GRANTED/); assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.resultPath), false);
  assert.ok(Date.now() - started < loadTimeout(8000)); f.clean();
});

test('zero-budget low refuses once, while floor zero grants with group ownership and a renewed execution expiry', t => {
  const f = fixture(t), low = f.run(Number.MAX_SAFE_INTEGER);
  assert.equal(low.status, 75, low.stderr); assert.equal((low.stderr.match(/TEST_SLOT_MEMORY_WAIT:/g) ?? []).length, 1); f.clean();
  const command = [process.execPath, '-e', `const fs=require('fs'),assert=require('assert/strict');
    for(const file of [process.env.MONITOR_TEST_SLOT_PATH,process.env.MONITOR_TEST_SLOT_COMPAT_PATH]){
      const row=JSON.parse(fs.readFileSync(file));assert.equal(row.pgid,process.pid);assert(!('schema' in row));assert(!('version' in row));}
    const dir=process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy';const row=JSON.parse(fs.readFileSync(dir+'/'+fs.readdirSync(dir).find(n=>!n.startsWith('.'))));
    assert.equal(row.pgid,process.pid);assert(Date.parse(row.expiresAt)>Date.now()+40000);console.log('owned before payload');`];
  const granted = f.run(0, [], {}, command);
  assert.equal(granted.status, 0, granted.stderr); assert.match(granted.stdout, /owned before payload/);
  assert.match(granted.stderr, /TEST_SLOT_MEMORY_GRANTED/); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).state, 'acquired');
  const saved = JSON.parse(fs.readFileSync(f.resultPath)); assert.equal(saved.resource.profile.memory_floor_bytes, 0); assert.equal(saved.exit_code, 0);
  f.clean();
});

test('publication evidence shows a zero-budget waiting row and execution renewal only on grant', t => {
  const f = fixture(t), preload = path.join(f.root, 'publications.mjs'), evidence = path.join(f.root, 'publications.jsonl');
  fs.writeFileSync(preload, `import fs from 'node:fs';const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to).startsWith(${JSON.stringify(f.compat + '.occupancy/')})){
      fs.appendFileSync(${JSON.stringify(evidence)},fs.readFileSync(from,'utf8'));}return rename(from,to);};`);
  const env = { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` };
  const low = f.run(Number.MAX_SAFE_INTEGER, [], env); assert.equal(low.status, 75, low.stderr);
  const rows = () => fs.readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows().length, 1); assert.equal(rows()[0].expiresAt, rows()[0].acquiredAt);
  fs.unlinkSync(evidence);
  const granted = f.run(0, [], env); assert.equal(granted.status, 0, granted.stderr);
  const saved = rows(); assert.equal(saved[0].expiresAt, saved[0].acquiredAt);
  assert.equal(saved[0].pgid, null); assert.equal(saved[1].pgid, null, 'renewal precedes group publication and barrier');
  assert.ok(Date.parse(saved[1].expiresAt) >= Date.parse(saved[1].acquiredAt) + 50000);
  assert.ok(saved.at(-1).pgid); f.clean();
});

test('unknown native memory is a named immediate refusal with no payload or execution renewal', t => {
  const f = fixture(t), preload = path.join(f.root, 'unknown.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFileSync,spawn=cp.spawnSync;os.freemem=()=>NaN;
    fs.readFileSync=(file,...args)=>file==='/proc/meminfo'?'invalid':read(file,...args);
    cp.spawnSync=(file,...args)=>file==='vm_stat'?{status:1,stderr:'unreadable'}:spawn(file,...args);syncBuiltinESMExports();`);
  const result = f.run(0, ['--wait', '10'], { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
  assert.equal(result.status, 75, result.stderr); assert.match(result.stderr, /TEST_SLOT_HOLDER_UNKNOWN: proving memory sample/);
  assert.doesNotMatch(result.stderr, /TEST_SLOT_MEMORY_GRANTED|TEST_SLOT_MEMORY_WAIT/); assert.equal(fs.existsSync(f.marker), false); f.clean();
});

test('SIGTERM cancels a live waiting reservation promptly, with no execution renewal or payload', async t => {
  const f = fixture(t), owner = f.start(Number.MAX_SAFE_INTEGER, ['--wait', '30']);
  await until(() => owner.stderr.includes('TEST_SLOT_MEMORY_WAIT:'));
  const row = readProvingReservations(f.compat)[0]; assert.equal(row.state, 'live'); assert.equal(row.record.pgid, null);
  const deadline = owner.stderr.match(/admission deadline ([^;\s]+)/)[1]; assert.equal(row.record.expiresAt, deadline);
  assert.ok(Date.parse(row.record.expiresAt) < Date.parse(row.record.acquiredAt) + 31000);
  const lines = []; let elapsed = 0;
  assert.throws(() => waitForProvingHold({ env: f.env, deadline: 1, clock: () => elapsed,
    sleep: ms => { elapsed += ms; }, notify: line => lines.push(line) }), { code: 'HOST_RESERVATION_WAIT_EXPIRED' });
  assert.match(lines[0], /waiting; proving/);
  const cancelled = Date.now(); owner.child.kill('SIGTERM');
  const result = await owner.done; assert.equal(result.code, 143, result.stderr);
  assert.ok(Date.now() - cancelled < loadTimeout(3000)); assert.equal(fs.existsSync(f.marker), false); f.clean();
  waitForProvingHold({ env: f.env, deadline: performance.now(), sleep: () => assert.fail('released reservation waited') });
});

for (const changed of ['compat', 'workspace', 'reservation']) test(`fresh confirmation refuses changed ${changed} ownership before payload`, async t => {
  const f = fixture(t), owner = f.start(Number.MAX_SAFE_INTEGER, ['--wait', '30']);
  await until(() => owner.stderr.includes('TEST_SLOT_MEMORY_WAIT:'));
  const file = changed === 'reservation' ? readProvingReservations(f.compat)[0].path : changed === 'compat' ? f.compat : f.lock;
  const record = JSON.parse(fs.readFileSync(file));
  if (changed === 'reservation') record.reason = 'foreign bytes'; else record.token = 'foreign-token';
  const bytes = JSON.stringify(record); fs.writeFileSync(file, bytes);
  const result = await owner.done; assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /TEST_SLOT_HOLDER_UNKNOWN:/); assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'foreign bytes never become cleanup authority');
  fs.unlinkSync(file); f.clean();
});

test('EXCLUSIVE under EXCLUSIVE stays covered, without resampling an impossible child floor or changing ownership', t => {
  const f = fixture(t), inner = [process.execPath, '-e', 'console.log("covered")'];
  const resource = f.resource(Number.MAX_SAFE_INTEGER, inner);
  const command = [process.execPath, '-e', `const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
    const paths=[process.env.MONITOR_TEST_SLOT_PATH,process.env.MONITOR_TEST_SLOT_COMPAT_PATH];
    const dir=process.env.MONITOR_TEST_SLOT_COMPAT_PATH+'.occupancy';paths.push(...fs.readdirSync(dir).filter(n=>!n.startsWith('.')).map(n=>dir+'/'+n));
    const before=paths.map(p=>fs.readFileSync(p,'utf8'));
    const result=cp.spawnSync(process.execPath,[${JSON.stringify(cli)},'run','covered child','--resource',${JSON.stringify(JSON.stringify(resource))},'--',...${JSON.stringify(inner)}],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'covered\\n');assert(!result.stderr.includes('TEST_SLOT_MEMORY_WAIT:'));assert(!result.stderr.includes('TEST_SLOT_MEMORY_GRANTED:'));
    assert.deepEqual(paths.map(p=>fs.readFileSync(p,'utf8')),before);console.log('still covered');`];
  const result = f.run(0, [], {}, command); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /still covered/); f.clean();
});

test('two compatible floor-bearing proving steps retain FIFO ticket order behind a waiting reservation', async t => {
  const f = fixture(t), owner = f.start(Number.MAX_SAFE_INTEGER, ['--wait', '30']);
  await until(() => owner.stderr.includes('TEST_SLOT_MEMORY_WAIT:'));
  const order = path.join(f.root, 'order');
  const command = name => [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(order)},${JSON.stringify(name + '\n')})`];
  const queued = () => fs.existsSync(`${f.compat}.queue`) ? fs.readdirSync(`${f.compat}.queue`).filter(n => !n.startsWith('.')).length : 0;
  const first = f.start(0, ['--wait', '15'], {}, command('first')); await until(() => queued() === 1);
  const second = f.start(0, ['--wait', '15'], {}, command('second')); await until(() => queued() === 2);
  owner.child.kill('SIGTERM'); assert.equal((await owner.done).code, 143);
  for (const result of await Promise.all([first.done, second.done])) assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(order, 'utf8'), 'first\nsecond\n'); f.clean();
});

test('ordinary unprofiled and SHARED commands start during a waiting prover without sampling its floor', async t => {
  const f = fixture(t), owner = f.start(Number.MAX_SAFE_INTEGER, ['--wait', '30']);
  await until(() => owner.stderr.includes('TEST_SLOT_MEMORY_WAIT:'));
  const preload = path.join(f.root, 'observe-probe.mjs'), probe = path.join(f.root, 'probe');
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFileSync,spawn=cp.spawnSync,free=os.freemem;const observed=()=>{if(new Error().stack.includes('memory-floor.mjs'))fs.writeFileSync(${JSON.stringify(probe)},'floor sampled');};
    fs.readFileSync=(file,...args)=>{if(file==='/proc/meminfo')observed();return read(file,...args);};
    cp.spawnSync=(file,...args)=>{if(file==='vm_stat')observed();return spawn(file,...args);};os.freemem=()=>{observed();return free();};syncBuiltinESMExports();`);
  for (const shared of [false, true]) {
    const args = [cli, 'run', 'ordinary', ...(shared ? ['--resource', JSON.stringify(resourceStanza('fixture/shared', f.command))] : []), '--', ...f.command];
    const result = spawnSync(process.execPath, args, { cwd: f.root, env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` },
      encoding: 'utf8', timeout: loadTimeout(15000) });
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /TEST_SLOT_MEMORY_/);
    assert.equal(fs.existsSync(probe), false); assert.ok(fs.existsSync(f.marker)); fs.unlinkSync(f.marker);
  }
  owner.child.kill('SIGTERM'); assert.equal((await owner.done).code, 143); f.clean();
  const exclusive = f.run(0, [], { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` });
  assert.equal(exclusive.status, 0, exclusive.stderr); assert.ok(fs.existsSync(probe), 'EXCLUSIVE positive control fires the same floor sampler'); f.clean();
});

test('a zero-duration reservation is expired immediately, with no invalid future authority', () => {
  const record = { schema: 'host-reservation/v1', class: 'proving', pid: process.pid, processStart: null, processBirth: null,
    pgid: null, groupStart: null, groupBirth: null, acquiredAt: new Date(1000).toISOString(), expectedEnd: new Date(1000).toISOString(),
    expiresAt: new Date(1000).toISOString(), project: 'fixture', label: 'immediate', cwd: '/fixture', host: 'host', reason: 'immediate' };
  assert.equal(reservationState(record, { now: 1000 }).state, 'expired');
  assert.equal(reservationState({ ...record, expiresAt: new Date(999).toISOString() }, { now: 1000 }).state, 'unknown');
});

for (const mode of ['floor-expiry', 'floor-cancellation']) test(`granted floor admission preserves real owned groups (${mode})`, async t => {
  const { child } = spawnDetachedFixture(t, mode);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# tests 1$/m); assert.match(result.stdout, /^# pass 1$/m);
});
