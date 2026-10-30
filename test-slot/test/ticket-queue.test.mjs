import { provingRun } from './helpers/proving.mjs';
// Protocol v1.1 firing cases. Every process and lock/queue belongs to this fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadTimeout } from '../../lib/deadline.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { readTestSlotQueue, testSlotTicket } from '../ticket-queue.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

// Allows the new regression witnesses to be run against the pre-change module.
const CLI = process.env.TEST_SLOT_QUEUE_CLI ?? fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
const MODULE = pathToFileURL(CLI).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const loadWaitSeconds = ms => Math.ceil(loadTimeout(ms) / 1000);
const firing = (name, body) => test(name, { timeout: loadTimeout(20000) }, body);

async function until(predicate, what) {
  const deadline = Date.now() + loadTimeout(6000);
  while (Date.now() < deadline) { if (predicate()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-queue-'));
  const children = [];
  const file = name => path.join(root, name);
  const lock = file('slot.lock'), compat = file('compat.lock');
  const env = { ...testSlotEnvironment(), HERDR_MONITOR_FLEET: file('fleet'),
    MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const start = (args, extraEnv = {}) => {
    const child = spawn(process.execPath, args[0] === CLI ? provingRun(args) : args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, done };
  };
  t.after(async () => {
    // A live, unreaped direct child cannot have had its pid reused.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null
      : new Promise(resolve => child.once('close', resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const worker = (label, { lockPath = lock, compatPath, pollMs = 100, waitSeconds = loadWaitSeconds(12000), preload = '' } = {}) => {
    const waiting = file(`${label}.waiting`), ready = file(`${label}.ready`), finish = file(`${label}.finish`);
    const script = `import fs from 'node:fs';
      ${preload}
      const mod = await import(${JSON.stringify(MODULE)});
      const slot = await mod.${compatPath ? 'acquireHostTestSlot' : 'acquireTestSlot'}(${JSON.stringify(label)}, {
        env: process.env, lockPath: ${JSON.stringify(lockPath)}, ${compatPath ? `compatPath: ${JSON.stringify(compatPath)},` : ''}
        pollMs: ${pollMs}, waitSeconds: ${waitSeconds},
        onWait: () => fs.writeFileSync(${JSON.stringify(waiting)}, 'waiting') });
      fs.appendFileSync(${JSON.stringify(file('order'))}, ${JSON.stringify(label + '\n')});
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(slot.holder));
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(finish)})) {
        clearInterval(timer); slot.release(); } }, 10);`;
    return { ...start(['--input-type=module', '-e', script]), waiting, ready, finish };
  };
  const queue = (lockPath = lock) => {
    try { return fs.readdirSync(`${lockPath}.queue`).filter(name => !name.startsWith('.')).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const stop = async worker => { fs.writeFileSync(worker.finish, 'finish'); const result = await worker.done; assert.equal(result.code, 0, result.stderr); };
  return { root, file, lock, compat, env, start, worker, queue, stop };
}

function denySource(pid, { eperm = false } = {}) {
  return `const cp = await import('node:child_process'), { syncBuiltinESMExports } = await import('node:module');
    const execute = cp.default.spawnSync, read = fs.readFileSync, kill = process.kill;
    cp.default.spawnSync = (file, args, ...rest) => String(file).includes('process-source-') && args.includes(${JSON.stringify(String(pid))})
      ? { error: Object.assign(Error('source denied'), { code: 'EPERM' }) } : execute(file, args, ...rest);
    fs.readFileSync = (file, ...rest) => String(file) === ${JSON.stringify(`/proc/${pid}/stat`)}
      ? (() => { throw Object.assign(Error('source denied'), { code: 'EACCES' }); })() : read(file, ...rest);
    ${eperm ? `process.kill = (target, signal) => { if (target === ${pid} && signal === 0) throw Object.assign(Error('probe denied'), { code: 'EPERM' }); return kill(target, signal); };` : ''}
    syncBuiltinESMExports();`;
}

function writeTicket(f, { pid = process.pid, arrivedMs = Date.now() - 1000, token = 'a'.repeat(32), ...overrides } = {}) {
  const identity = processStartRecord(pid);
  const ticket = { v: 1, token, pid, processStart: identity.start, processBirth: null,
    label: 'wire-peer', cwd: f.root, host: os.hostname(), arrivedAt: new Date(arrivedMs).toISOString(),
    expiresAt: new Date(Date.now() + loadTimeout(12000)).toISOString(), ...overrides };
  const name = `${String(arrivedMs).padStart(16, '0')}-${String(pid).padStart(10, '0')}-${token}.json`;
  fs.mkdirSync(`${f.lock}.queue`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(`${f.lock}.queue`, name), JSON.stringify(ticket) + '\n');
  return { name, ticket };
}

firing('1: the earlier 2 s waiter takes the slot before a later 100 ms waiter', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const removed = f.file('early.removed');
  const early = f.worker('early', { pollMs: 2000, preload: `
    const remove = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      if (String(target).startsWith(${JSON.stringify(`${f.lock}.queue/`)}) && !String(target).split('/').at(-1).startsWith('.')) {
        const ticket = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (ticket.pid === process.pid) {
          const holder = JSON.parse(fs.readFileSync(${JSON.stringify(f.lock)}, 'utf8'));
          if (holder.pid !== ticket.pid || holder.token !== ticket.token) throw Error('ticket removed before owning the lock');
          fs.writeFileSync(${JSON.stringify(removed)}, JSON.stringify({ ticket, holder }));
        }
      }
      return remove(target, ...args);
    };` });
  await until(() => fs.existsSync(early.waiting), 'earlier arrival');
  const late = f.worker('late', { pollMs: 100 });
  await until(() => fs.existsSync(late.waiting), 'later arrival');
  const lateTicket = f.queue().find(name => JSON.parse(fs.readFileSync(path.join(`${f.lock}.queue`, name), 'utf8')).pid === late.child.pid);
  assert.ok(lateTicket, 'later waiter has published its ticket');
  await f.stop(holder);
  await until(() => fs.existsSync(early.ready) || fs.existsSync(late.ready), 'next holder');
  assert.equal(fs.existsSync(late.ready), false, 'fast polling cannot pass an earlier waiter');
  assert.equal(fs.existsSync(early.ready), true);
  const witness = JSON.parse(fs.readFileSync(removed, 'utf8'));
  assert.equal(witness.holder.token, JSON.parse(fs.readFileSync(early.ready, 'utf8')).token);
  assert.equal(witness.ticket.token, witness.holder.token, 'lock exists before the winner removes its own ticket');
  assert.deepEqual(f.queue(), [lateTicket], 'later waiter keeps its ticket while early holds the lock');
  await f.stop(early);
  await until(() => fs.existsSync(late.ready), 'later holder');
  await f.stop(late);
  assert.equal(fs.readFileSync(f.file('order'), 'utf8'), 'holder\nearly\nlate\n');
  assert.deepEqual(f.queue(), []);
});

firing('lock publication never exposes incomplete bytes to another queued waiter', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const paused = f.file('publication.paused'), resume = f.file('publication.resume'), observed = f.file('late.observed');
  const early = f.worker('early', { pollMs: 50, preload: `
    const write = fs.writeFileSync;
    fs.writeFileSync = (target, data, options) => {
      if (options?.flag !== 'wx' || typeof data !== 'string' || !data.includes('"acquiredAt"')) return write(target, data, options);
      const fd = fs.openSync(target, options.flag, options.mode), split = Math.floor(data.length / 2);
      try {
        write(fd, data.slice(0, split));
        write(${JSON.stringify(paused)}, 'paused');
        const deadline = Date.now() + ${loadTimeout(6000)};
        while (!fs.existsSync(${JSON.stringify(resume)})) {
          if (Date.now() >= deadline) throw Error('publication pause timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return write(fd, data.slice(split));
      } finally { fs.closeSync(fd); }
    };` });
  await until(() => fs.existsSync(early.waiting), 'early waiting');
  const late = f.worker('late', { pollMs: 50, preload: `
    const read = fs.readFileSync;
    fs.readFileSync = (target, ...args) => {
      try { return read(target, ...args); }
      finally {
        if (target === ${JSON.stringify(f.lock)} && fs.existsSync(${JSON.stringify(paused)}) && !fs.existsSync(${JSON.stringify(resume)}))
          fs.writeFileSync(${JSON.stringify(observed)}, 'observed');
      }
    };` });
  await until(() => fs.existsSync(late.waiting), 'late waiting');
  const names = f.queue();
  assert.equal(names.length, 2);
  await f.stop(holder);
  await until(() => fs.existsSync(paused) && fs.existsSync(observed), 'late to read during the incomplete write');
  assert.equal(fs.existsSync(f.lock), false, 'incomplete holder bytes remain private');
  assert.deepEqual(f.queue(), names, 'neither ticket is removed before lock publication');
  fs.writeFileSync(resume, 'resume');
  await until(() => fs.existsSync(early.ready) || fs.existsSync(late.ready), 'next holder');
  assert.equal(fs.existsSync(early.ready), true);
  assert.equal(fs.existsSync(late.ready), false, 'late cannot pass the unpublished head');
  await f.stop(early);
  await until(() => fs.existsSync(late.ready), 'later holder');
  await f.stop(late);
  assert.equal(fs.readFileSync(f.file('order'), 'utf8'), 'holder\nearly\nlate\n');
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')), [], 'publication scratch is removed');
});

firing('lock publication preserves a competing creator and cleans scratch on link failure', async t => {
  for (const error of ['EEXIST', 'EACCES']) {
    const f = fixture(t);
    const result = await f.start(['--input-type=module', '-e', `import fs from 'node:fs';
      const link = fs.linkSync;
      fs.linkSync = (source, destination) => {
        if (destination !== ${JSON.stringify(f.lock)}) return link(source, destination);
        ${error === 'EEXIST' ? `const competing = { ...JSON.parse(fs.readFileSync(source, 'utf8')), token: 'competing', label: 'competing' };
          fs.writeFileSync(destination, JSON.stringify(competing), { flag: 'wx' });
          return link(source, destination);` : "throw Object.assign(Error('publication denied'), { code: 'EACCES' });"}
      };
      const { acquireTestSlot } = await import(${JSON.stringify(MODULE)});
      try {
        const slot = await acquireTestSlot('publisher', { lockPath: ${JSON.stringify(f.lock)}, env: process.env, waitSeconds: 0 });
        console.log(JSON.stringify({ nested: slot.nested, token: slot.token }));
      } catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }`]).done;
    assert.equal(result.code, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    if (error === 'EEXIST') {
      assert.deepEqual(outcome, { nested: true, token: 'competing' }, 'exclusive link loses to the existing holder');
      assert.equal(JSON.parse(fs.readFileSync(f.lock, 'utf8')).token, 'competing');
    } else {
      assert.equal(outcome.code, 'TEST_SLOT_HOLDER_UNKNOWN');
      assert.match(outcome.message, /cannot create .*: EACCES/);
      assert.equal(fs.existsSync(f.lock), false);
    }
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.endsWith('.tmp')), [], 'failed publication scratch is removed');
  }
});

firing('2: SIGKILL leaves a gone head that ESRCH removes even with denied start-time reads', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const head = f.worker('killed-head', { pollMs: 2000 });
  await until(() => fs.existsSync(head.waiting), 'head waiting');
  assert.equal(f.queue().length, 1, 'head has a published ticket');
  const headName = f.queue()[0];
  const next = f.worker('next', { preload: denySource(head.child.pid) });
  await until(() => fs.existsSync(next.waiting), 'next waiting');
  head.child.kill('SIGKILL');
  assert.equal((await head.done).signal, 'SIGKILL');
  await until(() => !f.queue().includes(headName), 'ESRCH pruning before ticket expiration');
  await f.stop(holder);
  await until(() => fs.existsSync(next.ready), 'next holder');
  await f.stop(next);
  assert.deepEqual(f.queue(), []);
});

test('3: an EPERM/unknown head blocks until its own expiresAt', async t => {
  const f = fixture(t);
  const peer = f.start(['-e', `require('fs').writeFileSync(${JSON.stringify(f.file('peer-ready'))},'ready');setInterval(()=>{},1000);`]);
  await until(() => fs.existsSync(f.file('peer-ready')), 'peer process');
  const expires = Date.now() + loadTimeout(1800);
  const head = writeTicket(f, { pid: peer.child.pid, expiresAt: new Date(expires).toISOString() });
  const next = f.worker('next', { preload: denySource(peer.child.pid, { eperm: true }) });
  await until(() => fs.existsSync(next.waiting) || fs.existsSync(next.ready), 'unknown-head witness');
  assert.equal(fs.existsSync(next.ready), false, 'unknown head must be honored');
  const status = await f.start(['--input-type=module', '-e', `import fs from 'node:fs';${denySource(peer.child.pid, { eperm: true })}
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, 'status', '--lock-path', ${JSON.stringify(f.lock)}];await import(${JSON.stringify(MODULE)});`]).done;
  assert.equal(JSON.parse(status.stdout).queue[0].state, 'unknown');
  // This fixture writes directly: existence can precede the complete JSON.
  // Wait for the content without a wall cap, but fail if its writer exits.
  let acquired;
  for (;;) {
    try { acquired = JSON.parse(fs.readFileSync(next.ready, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    assert.equal(next.child.exitCode, null, 'next worker exited before publishing its holder');
    assert.equal(next.child.signalCode, null, 'next worker was signalled before publishing its holder');
    await sleep(10);
  }
  assert.ok(Date.parse(acquired.acquiredAt) >= expires, 'no separate shorter unknown-ticket cap');
  assert.equal(f.queue().includes(head.name), false);
  assert.equal(peer.child.exitCode, null, 'expiration works while the pid still exists');
  await f.stop(next);
});

firing('4: deleting the queue mid-wait republishes original names and preserves order', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const early = f.worker('early', { pollMs: 2000 });
  await until(() => fs.existsSync(early.waiting), 'early waiting');
  const late = f.worker('late');
  await until(() => fs.existsSync(late.waiting), 'late waiting');
  const names = f.queue();
  assert.equal(names.length, 2);
  const bytes = names.map(name => fs.readFileSync(path.join(`${f.lock}.queue`, name), 'utf8'));
  fs.rmSync(`${f.lock}.queue`, { recursive: true });
  await until(() => f.queue().length === 2, 'both original tickets to republish');
  assert.deepEqual(f.queue(), names);
  assert.deepEqual(names.map(name => fs.readFileSync(path.join(`${f.lock}.queue`, name), 'utf8')), bytes);
  await f.stop(holder);
  await until(() => fs.existsSync(early.ready), 'early holder');
  assert.equal(fs.existsSync(late.ready), false);
  await f.stop(early);
  await until(() => fs.existsSync(late.ready), 'late holder');
  await f.stop(late);
});

firing('5: an old exclusive-create poller and a queuer both eventually run', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const queued = f.worker('new');
  await until(() => fs.existsSync(queued.waiting), 'new waiter');
  const oldReady = f.file('old.ready'), oldFinish = f.file('old.finish');
  const old = f.start(['--input-type=module', '-e', `import fs from 'node:fs';import os from 'node:os';
    import { processStartRecord } from ${JSON.stringify(new URL('../lock-support.mjs', import.meta.url).href)};
    const identity=processStartRecord(process.pid), lock=${JSON.stringify(f.lock)};
    const record={pid:process.pid,processStart:identity.start,processBirth:identity.birth,pgid:null,groupStart:null,
      token:'old-poller',label:'old',cwd:process.cwd(),host:os.hostname(),acquiredAt:new Date().toISOString()};
    let held=false;fs.writeFileSync(${JSON.stringify(f.file('old.waiting'))},'waiting');
    const timer=setInterval(()=>{if(!held){try{fs.writeFileSync(lock,JSON.stringify(record)+'\\n',{flag:'wx'});held=true;
      fs.writeFileSync(${JSON.stringify(oldReady)},'ready');}catch(error){if(error.code!=='EEXIST')throw error;}}
      if(held&&fs.existsSync(${JSON.stringify(oldFinish)})){clearInterval(timer);fs.rmSync(lock);}},20);`]);
  await until(() => fs.existsSync(f.file('old.waiting')), 'old poller');
  await f.stop(holder);
  await until(() => fs.existsSync(queued.ready) || fs.existsSync(oldReady), 'one competing poller to acquire');
  if (fs.existsSync(oldReady)) {
    fs.writeFileSync(oldFinish, 'finish');
    assert.equal((await old.done).code, 0);
    await until(() => fs.existsSync(queued.ready), 'queuer after old poller');
    await f.stop(queued);
  } else {
    await f.stop(queued);
    await until(() => fs.existsSync(oldReady), 'old poller after queuer');
    fs.writeFileSync(oldFinish, 'finish');
    assert.equal((await old.done).code, 0);
  }
  assert.deepEqual(f.queue(), []);
  assert.equal(fs.existsSync(f.lock), false);
});

firing('6: inherited-token and token-free nested runs never create tickets', async t => {
  const f = fixture(t), result = f.file('nested-result');
  const program = `const fs=require('fs'),cp=require('child_process');
    for(const inherited of [true,false]){const env={...process.env};if(!inherited){delete env.MONITOR_TEST_SLOT_TOKEN;delete env.BCH_CLOAK_TEST_SLOT_TOKEN;}
      const r=cp.spawnSync(process.execPath,[${JSON.stringify(CLI)},'run','nested','--wait',${JSON.stringify(String(loadWaitSeconds(5000)))},'--',process.execPath,'-e',''],{env,encoding:'utf8'});
      if(r.status!==0)throw Error(r.stderr);if(fs.existsSync(${JSON.stringify(`${f.lock}.queue`)}))throw Error('nested run created queue');}
    fs.writeFileSync(${JSON.stringify(result)},'done');`;
  const run = await f.start([CLI, 'run', 'outer', '--wait', String(loadWaitSeconds(5000)), '--', process.execPath, '-e', program]).done;
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.readFileSync(result, 'utf8'), 'done');
  assert.equal(fs.existsSync(`${f.lock}.queue`), false);
});

firing('tickets publish complete v1 bytes by link with a private directory', async t => {
  const f = fixture(t), identity = processStartRecord(process.pid), token = 'b'.repeat(32);
  const ticket = testSlotTicket(f.lock, { identity, token, label: 'published', waitSeconds: 7 });
  const link = fs.linkSync;
  let linked = false;
  fs.linkSync = (source, destination) => {
    assert.equal(source, path.join(`${f.lock}.queue`, `.${token}.tmp`));
    const bytes = fs.readFileSync(source, 'utf8');
    assert.equal(bytes.split('\n').length, 2);
    const record = JSON.parse(bytes);
    assert.equal(record.v, 1); assert.equal(record.processBirth, identity.birth);
    assert.equal(Date.parse(record.expiresAt) - Date.parse(record.arrivedAt), 7000);
    assert.match(path.basename(destination), /^\d{16}-\d{10}-[a-f0-9]{32}\.json$/);
    linked = true;
    return link(source, destination);
  };
  try { ticket.publish(); } finally { fs.linkSync = link; }
  assert.equal(linked, true);
  assert.equal(fs.statSync(`${f.lock}.queue`).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(`${f.lock}.queue`), [ticket.name]);
  ticket.remove();
});

firing('status lists all classifications head-first, and readers prune only eligible stale files', async t => {
  const f = fixture(t), now = Date.now();
  const noExpiry = writeTicket(f, { arrivedMs: now - 9500, token: 'b'.repeat(32), expiresAt: 'whenever' });
  const noPid = writeTicket(f, { arrivedMs: now - 9400, token: 'c'.repeat(32) });
  fs.writeFileSync(path.join(`${f.lock}.queue`, noPid.name), JSON.stringify({ ...noPid.ticket, pid: 0 }) + '\n');
  const gone = writeTicket(f, { arrivedMs: now - 9000, processStart: 'ps-utc-c:another start' });
  const expired = writeTicket(f, { arrivedMs: now - 8000, expiresAt: new Date(now - 1).toISOString() });
  const live = writeTicket(f, { arrivedMs: now - 7000 });
  const unknown = writeTicket(f, { arrivedMs: now - 6000, processStart: 'legacy-local-time' });
  const birth = writeTicket(f, { arrivedMs: now - 5000,
    processBirth: processStartRecord(process.pid).birth.replace(/\d+$/, value => String(BigInt(value) + 1n)) });
  const recentBad = `${String(now - 4000).padStart(16, '0')}-0000000001-bad.json`;
  const oldBad = `${String(now - 86400001).padStart(16, '0')}-0000000001-bad.json`;
  fs.writeFileSync(path.join(`${f.lock}.queue`, recentBad), '{');
  fs.writeFileSync(path.join(`${f.lock}.queue`, oldBad), '{"v":2}');
  fs.writeFileSync(path.join(`${f.lock}.queue`, '.partial.tmp'), '{');
  const status = await f.start([CLI, 'status', '--lock-path', f.lock]).done;
  assert.equal(status.code, 0, status.stderr);
  const queue = JSON.parse(status.stdout).queue;
  assert.equal(queue[0].name, live.name); assert.equal(queue[0].head, true);
  assert.deepEqual(Object.fromEntries(queue.map(row => [row.name, row.state])), {
    [live.name]: 'live', [gone.name]: 'gone', [expired.name]: 'expired', [unknown.name]: 'unknown',
    [birth.name]: 'gone', [recentBad]: 'unreadable', [oldBad]: 'unreadable',
    [noExpiry.name]: 'unreadable', [noPid.name]: 'unreadable',
  });
  assert.equal(f.queue().length, 9, 'status is read-only');
  assert.equal(readTestSlotQueue(f.lock, { prune: true }).head.name, live.name);
  assert.deepEqual(f.queue(), [noExpiry.name, noPid.name, live.name, unknown.name, recentBad].sort());
});

firing('two-path acquisition queues on the second path only after taking the first', async t => {
  const f = fixture(t), holder = f.worker('workspace-holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'workspace holder');
  const bridge = f.worker('bridge', { compatPath: f.compat });
  await until(() => fs.existsSync(bridge.waiting), 'bridge waiting on workspace');
  assert.equal(JSON.parse(fs.readFileSync(f.compat, 'utf8')).pid, bridge.child.pid);
  assert.equal(f.queue(f.compat).length, 0);
  assert.equal(f.queue().length, 1);
  const next = f.worker('next-bridge', { compatPath: f.compat });
  await until(() => fs.existsSync(next.waiting), 'next bridge on compat');
  assert.equal(f.queue(f.compat).length, 1);
  assert.equal(f.queue().length, 1, 'next bridge has not queued on workspace yet');
  await f.stop(holder);
  await until(() => fs.existsSync(bridge.ready), 'bridge acquires both');
  assert.equal(JSON.parse(fs.readFileSync(f.compat, 'utf8')).token, JSON.parse(fs.readFileSync(f.lock, 'utf8')).token);
  await f.stop(bridge);
  await until(() => fs.existsSync(next.ready), 'next bridge acquires both');
  await f.stop(next);
  assert.deepEqual(f.queue(), []); assert.deepEqual(f.queue(f.compat), []);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) firing(`waiting ${signal} removes the ticket and releases an already held compat path`, async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const waiting = f.start([CLI, 'run', 'waiting', '--wait', String(loadWaitSeconds(12000)), '--poll-ms', '2000', '--', process.execPath, '-e', ''],
    { MONITOR_TEST_SLOT_COMPAT_PATH: f.compat });
  await until(() => f.queue().length === 1, 'CLI ticket on the second path');
  assert.equal(JSON.parse(fs.readFileSync(f.compat, 'utf8')).pid, waiting.child.pid);
  waiting.child.kill(signal);
  const result = await waiting.done;
  assert.equal(result.code, 128 + os.constants.signals[signal], result.stderr);
  assert.deepEqual(f.queue(), []);
  assert.equal(fs.existsSync(f.compat), false);
  assert.equal(fs.existsSync(f.lock), true, 'holder retains its lock');
  await f.stop(holder);
});

firing('wait exhaustion still exits 75 with TEST_SLOT_HELD and removes its ticket', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  const waiter = f.start([CLI, 'run', 'budget', '--wait', String(loadWaitSeconds(1000)), '--', process.execPath, '-e', '']);
  await until(() => f.queue().length === 1, 'budget ticket');
  const result = await waiter.done;
  assert.equal(result.code, 75); assert.match(result.stderr, /^TEST_SLOT_HELD:/);
  assert.deepEqual(f.queue(), []);
  await f.stop(holder);
});

firing('a zero-wait taker honors a queued peer without publishing its own ticket', async t => {
  const f = fixture(t), head = writeTicket(f);
  const result = await f.start([CLI, 'run', 'zero-wait', '--', process.execPath, '-e', '']).done;
  assert.equal(result.code, 75); assert.match(result.stderr, /^TEST_SLOT_HELD:/);
  assert.deepEqual(f.queue(), [head.name]);
  assert.equal(fs.existsSync(f.lock), false);
});

firing('callback failure and an explicit process exit both remove a waiting ticket', async t => {
  const f = fixture(t), holder = f.worker('holder', { waitSeconds: 0 });
  await until(() => fs.existsSync(holder.ready), 'holder');
  for (const exit of [false, true]) {
    const result = await f.start(['--input-type=module', '-e', `import fs from 'node:fs';
      const { acquireTestSlot } = await import(${JSON.stringify(MODULE)});
      try { await acquireTestSlot('ends-wait', { lockPath: ${JSON.stringify(f.lock)}, env: process.env,
        waitSeconds: ${loadWaitSeconds(10000)}, onWait: () => { ${exit ? 'process.exit(0);' : "throw Error('callback failed');"} } }); }
      catch (error) { if(error.message !== 'callback failed') throw error; }`]).done;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.queue(), []);
  }
  await f.stop(holder);
});

firing('publication retries a directory deleted between writing and linking', async t => {
  const f = fixture(t), ticket = testSlotTicket(f.lock, { identity: processStartRecord(process.pid),
    token: 'c'.repeat(32), label: 'republication', waitSeconds: 5 });
  const link = fs.linkSync;
  let calls = 0;
  fs.linkSync = (source, destination) => {
    if (++calls === 1) fs.rmSync(`${f.lock}.queue`, { recursive: true });
    return link(source, destination);
  };
  try { ticket.publish(); } finally { fs.linkSync = link; }
  assert.equal(calls, 2);
  assert.deepEqual(fs.readdirSync(`${f.lock}.queue`), [ticket.name]);
  ticket.remove();
});
