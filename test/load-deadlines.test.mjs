import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadFactor, loadTimeout } from '../lib/deadline.mjs';
import { lookupProcess, createProcessTracker } from './helpers/processes.mjs';
import { environmentFingerprint } from '../lanes/validation.mjs';
import { HerdrClient } from '../lanes/board/herdr-client.mjs';
import { EventEmitter } from 'node:events';
import { stopFixtureInbox, waitForInboxIdle } from './helpers/inbox.mjs';
import { initOrg, transact, withLock } from '../lib/store.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';

process.env.ORG_ACTOR = 'load-deadlines-test';
const withLoad = t => {
  const load = os.loadavg, capacity = os.availableParallelism;
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  t.after(() => { os.loadavg = load; os.availableParallelism = capacity; });
};
const line = (command = 'owned fixture') => `101 1 101 S Fri Oct 2 01:00:00 2026 ${command}\n`;
const good = command => ({ status: 0, signal: null, stdout: line(command), stderr: '' });
const timedOut = { status: null, error: Object.assign(Error('ps timed out'), { code: 'ETIMEDOUT' }), stdout: line(), stderr: '' };

test('measured load expands internal allowances without shorter, infinite or overflowing timers', t => {
  withLoad(t);
  assert.equal(loadFactor(), 6);
  assert.equal(loadFactor(24, 64), 6);
  assert.equal(loadFactor(24, 2), 12);
  assert.equal(loadFactor(0, 4), 1);
  assert.equal(loadFactor(NaN, 4), 1);
  for (const milliseconds of [0, 2000, 5000, 10000, 15000, 60000, 120000, 300000, 360000])
    assert.equal(loadTimeout(milliseconds), milliseconds * 6);
  assert.equal(loadTimeout(2 ** 31), 2 ** 31 - 1);
  assert.throws(() => loadTimeout(-1));
});

test('a loaded ps lookup receives time to answer and timeout retries back off with fresh output', t => {
  withLoad(t);
  const attempts = [], pauses = [];
  const result = lookupProcess(101, { execute: (_file, _args, options) => {
    attempts.push(options.timeout);
    return options.timeout < 20000 ? timedOut : good();
  }, pause: ms => pauses.push(ms) });
  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [12000, 24000]);
  assert.deepEqual(pauses, [300]);
});

test('the default ps executor under the bounded helper scales each response allowance once', async t => {
  const source = `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
os.loadavg=()=>[24,24,24];os.availableParallelism=()=>4;
const native=cp.spawnSync,attempts=[],commands=[];
cp.spawnSync=(file,args,options)=>{
 if(file==='ps'){attempts.push(options.timeout);return {status:null,stdout:'',stderr:'',error:Object.assign(Error('injected ps timeout'),{code:'ETIMEDOUT'})};}
 if(file==='command-allowance-fixture'){commands.push(options.timeout);return {status:0,stdout:'',stderr:''};}
 return native(file,args,options);
};syncBuiltinESMExports();
await import(${JSON.stringify(new URL('./helpers/bounded-test.mjs', import.meta.url).href)});
const {lookupProcess}=await import(${JSON.stringify(new URL('./helpers/processes.mjs', import.meta.url).href)});
const {commandAllowance}=await import(${JSON.stringify(new URL('./helpers/command-allowance.mjs', import.meta.url).href)});
const lookup=lookupProcess(101,{pause:()=>{}});
cp.spawnSync('command-allowance-fixture',[]);
cp.spawnSync('command-allowance-fixture',[],{timeout:12000});
cp.spawnSync('command-allowance-fixture',[],{timeout:180000});
cp.spawnSync('command-allowance-fixture',[],{timeout:108000,[commandAllowance]:108000});
console.log(JSON.stringify({lookup,attempts,commands}));`;
  const child = spawnChild(t, process.execPath, ['--input-type=module', '-e', source],
    { env: { ...process.env, ORG_ACTOR: 'default-ps-deadline-test' } });
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.lookup.ok, false, 'exhausted lookups never become identity evidence');
  assert.deepEqual(actual.attempts, [12000, 24000, 48000]);
  assert.deepEqual(actual.commands, [90000, 12000, 90000, 108000]);
});

test('the record lock waits past ten seconds for a live holder under load before appending', t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-record-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initOrg(root);
  const lock = path.join(root, 'lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const now = Date.now, wait = Atomics.wait, start = now();
  let elapsed = 0;
  try {
    Date.now = () => start + elapsed;
    Atomics.wait = (_view, _index, _value, milliseconds) => {
      elapsed += milliseconds;
      if (elapsed === 12000) fs.rmSync(lock, { recursive: true });
    };
    const result = transact(root, () => ({ add: [{ type: 'loaded-lock-test' }] }), { actor: 'loaded-record-lock-test' });
    assert.equal(elapsed, 12000, 'the live owner released after the former fixed limit');
    assert.equal(result.added.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8')).by, 'loaded-record-lock-test');
    assert.equal(fs.existsSync(lock), false);
  } finally { Date.now = now; Atomics.wait = wait; }
});

test('exhausted record-lock waits preserve live, refused and initializing owners and log bytes', t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-record-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initOrg(root);
  const now = Date.now, wait = Atomics.wait, kill = process.kill, start = now();
  const lock = path.join(root, 'lock');
  try {
    for (const owner of ['live', 'refused', 'initializing']) {
      fs.mkdirSync(lock);
      if (owner !== 'initializing') fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      let elapsed = 0;
      Date.now = () => start + elapsed;
      Atomics.wait = (_view, _index, _value, milliseconds) => { elapsed += milliseconds; };
      process.kill = owner === 'refused' ? () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); } : kill;
      assert.throws(() => withLock(root, () => assert.fail('unconfirmed record write')), /record is locked/);
      assert.ok(elapsed > 60000 && elapsed <= 60015);
      assert.equal(fs.existsSync(lock), true);
      assert.equal(fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8'), '');
      Date.now = now; process.kill = kill; fs.rmSync(lock, { recursive: true });
    }
  } finally { Date.now = now; Atomics.wait = wait; process.kill = kill; }
});

test('exhausted, refused and malformed lookups never authorize a signal, including after timeout', () => {
  for (const ending of [timedOut, { status: 1, stderr: 'denied', stdout: '' }, { ...good(), stdout: line().slice(0, -1) }]) {
    let attempts = 0;
    const tracker = createProcessTracker({ readIdentity: () => lookupProcess(101, {
      execute: () => (++attempts === 1 ? timedOut : ending), allowance: ms => ms, pause: () => {},
    }), sendSignal: () => assert.fail('unconfirmed signal'), report: () => {} });
    assert.equal(tracker.killProcess({ pid: 101, identity: 'Fri Oct 2 01:00:00 2026', command: 'owned fixture', group: true }).ok, false);
    assert.equal(attempts, ending === timedOut ? 3 : 2);
  }
});

test('a replacement PID discovered after a retry remains unauthorized', () => {
  let attempts = 0;
  const tracker = createProcessTracker({ readIdentity: () => lookupProcess(101, {
    execute: () => (++attempts === 1 ? timedOut : good('operator session')), allowance: ms => ms, pause: () => {},
  }), sendSignal: () => assert.fail('replacement signal'), report: () => {} });
  assert.equal(tracker.killProcess({ pid: 101, identity: 'Fri Oct 2 01:00:00 2026', command: 'owned fixture', group: true }).reason, 'changed');
});

test('promotion validation can read Git after the old injected 15-second command deadline', { timeout: 60000 }, t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'load-slow-git-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  // A real bounded subprocess reproduces ETIMEDOUT in the old test helper.
  fs.writeFileSync(path.join(root, 'git'), `#!${process.execPath}\nsetTimeout(()=>console.log('git version fixture'),15200);\n`, { mode: 0o755 });
  process.env.PATH = `${root}:${oldPath}`;
  assert.match(environmentFingerprint({ env: { ORG_ACTOR: 'load-git-fixture' } }), /^[a-f0-9]{64}$/);
});

test('slow Herdr transport responds within a loaded allowance; refusals stay refusals', async t => {
  withLoad(t);
  const timers = [];
  const original = globalThis.setTimeout;
  // Compress response timers only: 2s -> 20ms, 12s -> 120ms. The reply at
  // 50ms is beyond the former fixed deadline and within the loaded deadline.
  globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms / 100, ...args);
  t.after(() => { globalThis.setTimeout = original; });
  class Socket extends EventEmitter {
    setEncoding() {}
    write(text) {
      const request = JSON.parse(text);
      timers.push(original(() => this.emit('data', JSON.stringify({ id: request.id,
        ...(request.method === 'ping' ? { result: { type: 'pong' } } : { error: { code: 'refused', message: 'unsafe' } }) }) + '\n'), 50));
    }
    destroy() { for (const timer of timers) clearTimeout(timer); }
  }
  const client = new HerdrClient({ connect: () => {
    const socket = new Socket(); queueMicrotask(() => socket.emit('connect')); return socket;
  } });
  t.after(() => client.close());
  assert.equal((await client.ping()).type, 'pong');
  await assert.rejects(client.request('unsafe'), /refused: unsafe/);
});

test('housekeeping gives each evidence read a loaded response allowance and preserves refusals', async t => {
  withLoad(t);
  const { createHousekeeping } = await import('../housekeeping/housekeeping.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-housekeeping-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = (_exe, _args, options) => options.timeout >= 60000
    ? { status: 0, stdout: root, stderr: '' } : timedOut;
  assert.equal(createHousekeeping({ cwd: root, command }).common, root);
  assert.throws(() => createHousekeeping({ cwd: root, command: () => ({ status: 1, stderr: 'refused' }) }), /refused/);
});

test('queue and notice locks wait through loaded contention and never remove a live lock', async t => {
  withLoad(t);
  const { acquireLock } = await import('../lanes/promotion-lock.mjs');
  const { noticeLock } = await import('../supervisor/notice-lock.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now, wait = Atomics.wait;
  try {
    for (const acquire of [acquireLock, noticeLock]) {
      const lock = path.join(root, 'lock');
      fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      let elapsed = 0;
      Date.now = () => elapsed;
      Atomics.wait = () => { elapsed += 10; if (elapsed === 80) fs.rmSync(lock, { recursive: true }); };
      const release = acquire(lock, { waitMs: 50 });
      assert.equal(elapsed, 80, 'outlasted the old 50ms deadline'); release();
      fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      elapsed = 0; Atomics.wait = () => { elapsed += 10; };
      assert.throws(() => acquire(lock, { waitMs: 50 }), /locked:/);
      assert.ok(fs.existsSync(lock)); fs.rmSync(lock, { recursive: true });
    }
  } finally { Date.now = now; Atomics.wait = wait; }
});

test('inbox fixture teardown waits through loaded owner shutdown and preserves an unresponsive owner', async t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-inbox-shutdown-'));
  const inbox = path.join(root, 'inbox.log'), lock = `${inbox}.owner.lock`;
  const now = Date.now, started = now();
  // Advance wall time 100x: the old 5s wait lasts 50ms, the load-24 wait
  // lasts 300ms. The actual owner receipt disappears after 80ms.
  Date.now = () => started + (now() - started) * 100;
  let timer;
  t.after(() => { clearTimeout(timer); Date.now = now; fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(lock);
  timer = setTimeout(() => fs.rmdirSync(lock), 80);
  await waitForInboxIdle(inbox);
  fs.mkdirSync(lock);
  await assert.rejects(waitForInboxIdle(inbox), /fixture inbox owner did not exit/);
  assert.equal(fs.existsSync(lock), true, 'an unconfirmed owner is never removed or signalled');
});

for (const delayed of ['stop', 'shutdown']) test(`owned inbox teardown allows loaded ${delayed} confirmation before clearing its processes`, async t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-owned-inbox-'));
  const inbox = path.join(root, 'inbox.log'), lock = `${inbox}.owner.lock`, script = path.join(root, 'owner.mjs');
  const argv = [process.execPath, script, '--inbox', inbox, '--owner-worker'];
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 101, argv }));
  const now = Date.now;
  let elapsed = 0, phase = 'initial', reads = 0;
  Date.now = () => elapsed;
  t.after(() => { Date.now = now; fs.rmSync(root, { recursive: true, force: true }); });
  const signals = [];
  const tracker = {
    snapshot() {
      if (phase === delayed) elapsed += 6000;
      reads++;
      const rows = new Map([[process.pid, { pid: process.pid, pgid: 7 }]]);
      if (phase !== 'shutdown' || (delayed === 'shutdown' && reads < 2)) {
        rows.set(101, { pid: 101, pgid: 7, identity: 'owner-birth', command: argv.join(' '),
          state: phase === 'initial' || (phase === 'stop' && delayed === 'stop' && reads < 2) ? 'S' : 'T' });
        rows.set(102, { pid: 102, ppid: 101, pgid: 7, identity: 'child-birth', command: 'fixture transport', state: 'S' });
      }
      return { ok: true, value: rows };
    },
    killProcess(target, signal) {
      signals.push([target.pid, target.identity, target.command, target.group, signal]);
      if (signal === 'SIGSTOP') { phase = 'stop'; reads = 0; }
      if (target.pid === 101 && signal === 'SIGKILL') { phase = 'shutdown'; reads = 0; }
      return { ok: true, signaled: true };
    },
  };
  await stopFixtureInbox(inbox, { script, tracker });
  assert.equal(elapsed, 12000, 'confirmation outlasted the former five-second window');
  assert.deepEqual(signals, [
    [101, 'owner-birth', argv.join(' '), false, 'SIGSTOP'],
    [102, 'child-birth', 'fixture transport', false, 'SIGKILL'],
    [101, 'owner-birth', argv.join(' '), false, 'SIGKILL'],
  ]);
  assert.equal(fs.existsSync(lock), true, 'the helper leaves scratch removal to the fixture');
});
