import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { createProcessTracker } from './helpers/processes.mjs';

function fixture(t, { detached = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-inbox-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'inbox.log'), script = path.join(root, 'prompt-supervisor.mjs');
  const argv = [process.execPath, script, '--inbox', file, '--owner-worker', '--settings', '{}'];
  fs.mkdirSync(`${file}.owner.lock`);
  const metadata = path.join(`${file}.owner.lock`, 'owner.json');
  fs.writeFileSync(metadata, JSON.stringify({ pid: 202, argv }));
  const row = (pid, extra = {}) => ({ pid, ppid: process.pid, pgid: 101, state: 'S',
    identity: `birth ${pid}`, command: 'test caller', ...extra });
  const owner = row(202, { pgid: detached ? 202 : 101, command: argv.join(' ') });
  const rows = new Map([[process.pid, row(process.pid)], [202, owner]]), signals = [], reports = [];
  const hooks = {
    snapshot: () => ({ ok: true, value: new Map([...rows].map(([pid, value]) => [pid, { ...value }])) }),
    identity: pid => ({ ok: true, value: rows.get(pid) ?? null }),
  };
  const tracker = createProcessTracker({ readIdentities: () => hooks.snapshot(), readIdentity: pid => hooks.identity(pid),
    report: message => reports.push(message), sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGSTOP') rows.get(pid).state = 'T';
      if (signal === 'SIGCONT') rows.get(pid).state = 'S';
      if (signal === 'SIGKILL') rows.delete(pid);
    } });
  return { owner, rows, row, hooks, signals, reports, metadata,
    stop: () => stopFixtureInbox(file, { script, tracker }) };
}

for (const receipt of ['missing', 'partial']) {
  for (const handoff of ['removed lock', 'late owner', 'late invalid argv']) {
    test(`inbox fixture teardown waits for ${receipt} metadata then handles ${handoff}`, async t => {
      const f = fixture(t), metadata = fs.readFileSync(f.metadata, 'utf8');
      if (receipt === 'missing') fs.unlinkSync(f.metadata);
      else fs.writeFileSync(f.metadata, '{"pid":');
      const read = fs.readFileSync, snapshot = f.hooks.snapshot;
      let reads = 0, snapshots = 0;
      f.hooks.snapshot = () => { snapshots++; return snapshot(); };
      t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (file === f.metadata && ++reads === 1) {
          // Change the real fixture only after the helper encounters the
          // handoff window and yields. No scheduling delay creates the race.
          setImmediate(() => {
            assert.equal(snapshots, 0);
            assert.deepEqual(f.signals, []);
            if (handoff === 'removed lock') fs.rmSync(path.dirname(f.metadata), { recursive: true });
            else fs.writeFileSync(f.metadata, handoff === 'late owner' ? metadata : JSON.stringify({ pid: 202, argv: ['foreign'] }));
          });
        }
        return read.call(this, file, ...args);
      });
      if (handoff === 'late invalid argv') await assert.rejects(f.stop(), /Cannot confirm fixture inbox owner argv/);
      else await f.stop();
      assert.ok(reads >= 1);
      assert.deepEqual(f.signals, handoff === 'late owner'
        ? [{ pid: 202, signal: 'SIGSTOP' }, { pid: 202, signal: 'SIGKILL' }] : []);
      if (handoff !== 'late owner') assert.equal(snapshots, 0);
    });
  }

  for (const ending of ['lock removal', 'read error']) test(`inbox fixture teardown keeps ${receipt} metadata pending until ${ending}`, async t => {
    const f = fixture(t);
    if (receipt === 'missing') fs.unlinkSync(f.metadata);
    else fs.writeFileSync(f.metadata, '{"pid":');
    const read = fs.readFileSync, failure = Object.assign(Error('metadata read refused'), { code: 'EACCES' });
    let reads = 0, failRead = false, settled = false;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
      if (file === f.metadata) { reads++; if (failRead) throw failure; }
      return read.call(this, file, ...args);
    });
    f.hooks.snapshot = () => assert.fail('unreadable metadata must not reach process lookup');
    const pending = f.stop();
    pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await new Promise(setImmediate);
      assert.equal(settled, false, 'missing metadata remains pending');
      assert.ok(reads >= 1);
      assert.deepEqual(f.signals, []);
      assert.ok(fs.existsSync(path.dirname(f.metadata)), 'retain unidentified lock evidence');
    } finally {
      if (ending === 'read error') failRead = true;
      else fs.rmSync(path.dirname(f.metadata), { recursive: true });
      if (ending === 'read error') await assert.rejects(pending, error => error === failure);
      else await pending;
    }
    assert.deepEqual(f.signals, []);
    assert.equal(fs.existsSync(path.dirname(f.metadata)), ending === 'read error');
  });
}

test('inbox fixture teardown resumes only after an actual valid receipt', async t => {
  const f = fixture(t), metadata = fs.readFileSync(f.metadata, 'utf8');
  fs.unlinkSync(f.metadata);
  let settled = false;
  const pending = f.stop();
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false, 'a pending handoff does not authorize cleanup');
    assert.deepEqual(f.signals, []);
  } finally {
    fs.writeFileSync(f.metadata, metadata);
    await pending;
  }
  assert.deepEqual(f.signals, [{ pid: 202, signal: 'SIGSTOP' }, { pid: 202, signal: 'SIGKILL' }]);
});

for (const detached of [true, false]) test(`teardown confirms the ${detached ? 'detached owner' : 'contained test'} group and stops its transport first`, async t => {
  const f = fixture(t, { detached });
  f.rows.set(303, f.row(303, { ppid: 202, pgid: f.owner.pgid, command: 'slow fixture transport' }));
  f.rows.set(404, f.row(404, { command: 'unrelated same-test process' }));
  await f.stop();
  assert.deepEqual(f.signals, [{ pid: 202, signal: 'SIGSTOP' }, { pid: 303, signal: 'SIGKILL' }, { pid: 202, signal: 'SIGKILL' }]);
  assert.ok(f.rows.has(404));
});

for (const gone of ['absent', 'zombie', 'foreign command']) test(`a ${gone} owner candidate never authorizes a signal`, async t => {
  const f = fixture(t);
  if (gone === 'absent') f.rows.delete(202);
  else if (gone === 'zombie') f.owner.state = 'Z';
  else f.owner.command = 'unrelated operator command';
  await f.stop();
  assert.deepEqual(f.signals, []);
});

for (const changed of ['birth', 'command']) test(`a ${changed} change before the first signal reads as owner gone`, async t => {
  const f = fixture(t);
  f.hooks.identity = pid => ({ ok: true, value: { ...f.rows.get(pid),
    ...(changed === 'birth' ? { identity: 'replacement birth' } : { command: 'foreign replacement' }) } });
  await f.stop();
  assert.deepEqual(f.signals, []);
});

test('a replacement observed after suspension is never killed or resumed', async t => {
  const f = fixture(t), snapshot = f.hooks.snapshot;
  let calls = 0;
  f.hooks.snapshot = () => {
    if (++calls === 2) f.rows.set(202, { ...f.owner, identity: 'replacement birth', command: 'foreign command' });
    return snapshot();
  };
  await f.stop();
  assert.deepEqual(f.signals, [{ pid: 202, signal: 'SIGSTOP' }]);
});

for (const ambiguous of ['wrong group', 'missing birth', 'failed snapshot', 'failed signal lookup', 'invalid argv']) {
  test(`${ambiguous} ownership fails closed without signalling`, async t => {
    const f = fixture(t);
    if (ambiguous === 'wrong group') f.owner.pgid = 505;
    if (ambiguous === 'missing birth') delete f.owner.identity;
    if (ambiguous === 'failed snapshot') f.hooks.snapshot = () => ({ ok: false, error: 'ps unavailable' });
    if (ambiguous === 'failed signal lookup') f.hooks.identity = () => ({ ok: false, error: 'ps unavailable' });
    if (ambiguous === 'invalid argv') fs.writeFileSync(f.metadata, JSON.stringify({ pid: 202, argv: ['foreign'] }));
    await assert.rejects(f.stop(), /Cannot (confirm|stop) fixture inbox/);
    assert.deepEqual(f.signals, []);
  });
}

test('a transport outside the confirmed owner group retains evidence and resumes the owner', async t => {
  const f = fixture(t);
  f.rows.set(303, f.row(303, { ppid: 202, pgid: 505, command: 'escaped transport' }));
  await assert.rejects(f.stop(), /child escaped its owner group/);
  assert.deepEqual(f.signals, [{ pid: 202, signal: 'SIGSTOP' }, { pid: 202, signal: 'SIGCONT' }]);
  assert.ok(fs.existsSync(f.metadata));
});
