import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { watchRun } from '../watch.mjs';
import { silenceNotice, NOTICE_ENV } from '../watch-notice.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { silenceCommand, finishAfterSilence, inboxNotices } from './helpers/silence.mjs';

const sleeping = [{ pid: 123, identity: '1:1', state: 'S', cpu: '00:00.00' }];

for (const fixture of [
  { name: '400 ms quiet child', idle: .05, end: .4, audit: .7 },
  { name: '850 ms child with output at 450 ms', idle: .15, end: .85, output: .45, audit: 1 },
]) test(`a delayed initial audit can cancel the first notice for the original ${fixture.name}`, t => {
  let at = 0, timer, sampled = false;
  const notices = [];
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    timer = { callback, due: at + ms / 1000, cancelled: false }; return timer;
  });
  t.mock.method(globalThis, 'clearInterval', value => { value.cancelled = true; });
  const start = () => watchRun({ now: () => at, idleSeconds: fixture.idle, onSilence: row => notices.push(row),
    sample: () => { if (!sampled) { sampled = true; at += fixture.audit; } return sleeping; } });
  const watcher = start();
  assert.ok(timer.due > fixture.end, 'the payload has already finished before the first timer is eligible');
  if (fixture.output) watcher.output(); // Buffered output is delivered before completion.
  watcher.stop();
  assert.equal(timer.cancelled, true); assert.equal(notices.length, 0);

  // Control: a live payload can reach the timer after the same initial audit.
  at = 0; sampled = false;
  const live = start();
  at = timer.due + fixture.idle; live.tick();
  assert.equal(notices.length, 1);
  live.output(); at += fixture.idle * 3; live.tick();
  assert.equal(notices.length, 1, 'later output and silence never produce a second notice');
  live.stop();
});

test('slow sampling and cleanup can exceed five seconds while freezing at the first eligible sample', () => {
  let at = 0, samples = 0;
  const stops = [];
  const watcher = watchRun({ now: () => at, idleSeconds: 0, frozen: .5, startTimer: false,
    sample: () => { if (++samples === 1) at += 4.6; return sleeping; }, onFrozen: row => stops.push(row) });
  assert.equal(stops.length, 0);
  at += .05; watcher.tick();
  assert.equal(stops.length, 1); assert.equal(samples, 2);
  assert.equal(stops[0].limit_seconds, .5);
  assert.ok(stops[0].inactivity_s >= .5); assert.ok(stops[0].silence_s >= .5);
  at += 1; // Actual cleanup can continue after the inactivity observation.
  assert.ok(watcher.snapshot().duration_s > 5);
  watcher.tick(); assert.equal(stops.length, 1); assert.equal(samples, 2);
});

test('unknown samples restart the inactivity window rather than authorizing a frozen stop', () => {
  let at = 0, rows = sleeping;
  const stops = [];
  const watcher = watchRun({ now: () => at, idleSeconds: 0, frozen: .5, startTimer: false,
    sample: () => rows, onFrozen: row => stops.push(row) });
  at = 10; rows = null; watcher.tick();
  assert.equal(stops.length, 0);
  at = 10.4; rows = sleeping; watcher.tick();
  at = 10.8; watcher.tick(); assert.equal(stops.length, 0);
  at = 10.9; watcher.tick(); assert.equal(stops.length, 1);
});

test('the durable-notice handshake survives a delayed audit and a reused receipt through later silence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-control-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ids = [], receipt = path.join(root, 'stable-result.json');
  for (const delay of [0, 1000]) {
    const [command, ...args] = silenceCommand();
    const child = spawnChild(t, command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let initial = true;
    const watcher = watchRun({ pid: child.pid, idleSeconds: .15, frozen: 1000,
      sample: () => {
        if (initial) { initial = false; if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }
        return sleeping;
      },
      onSilence: observation => {
        observation.notice = silenceNotice(observation, { label: 'delayed audit control', receipt, runId: `run-${delay}`,
          env: { ...process.env, [NOTICE_ENV]: JSON.stringify({ to: 'owning-supervisor', inbox }) } });
      },
      onFrozen: () => assert.fail('the handshake must not freeze'),
    });
    // This is the same acknowledgement boundary as the wrapper's observe then
    // forward path; it avoids native CPU inventory in this deterministic control.
    child.stdout.on('data', () => watcher.output());
    try {
      const notice = await finishAfterSilence(child, { inbox, seenIds: ids });
      const result = await waitForExit(child);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, 'still working\n');
      const snapshot = watcher.snapshot();
      assert.equal(snapshot.observations.length, 1); assert.equal(snapshot.observations[0].kind, 'silence');
      assert.equal(snapshot.observations[0].notice.error, undefined);
      assert.equal(snapshot.observations[0].notice.id, notice.id); assert.ok(snapshot.longest_silence_s >= .4);
      ids.push(notice.id);
    } finally { watcher.stop(); }
  }
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(inboxNotices(inbox).map(row => row.id), ids);
  assert.ok(inboxNotices(inbox).every(row => row.to === 'owning-supervisor' && row.message.includes('test continues')));
});

// Controlled child interfaces exercise the actual imported helper. Physical
// spawn/ownership/close are still covered by the unchanged real-child case above.
function controlledChild() {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const commands = [];
  child.stdin.write = data => { commands.push(data); child.stdout.emit('data', 'still working\n'); };
  child.stdin.end = data => { commands.push(data); child.exitCode = 0; child.emit('exit', 0, null); };
  return { child, commands };
}

function assertListenersRemoved(child) {
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
  for (const stream of [child.stdin, child.stdout, child.stderr]) assert.equal(stream.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
}

test('a stale durable notice stays pending until a real missing-notice exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-negative-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'earlier-run' }) + '\n');
  const { child, commands } = controlledChild();
  const pending = finishAfterSilence(child, { inbox, seenIds: ['earlier-run'], waitMs: 120 });
  const rejected = assert.rejects(pending, /no new durable silence notice; child exited with code 7/);
  await new Promise(resolve => setImmediate(resolve)); // Event turn, no elapsed trigger.
  assert.deepEqual(commands, [], 'a stale notice sends neither progress nor finish');
  assert.equal(child.exitCode, null, 'a stale notice does not finish the payload');
  child.stderr.emit('data', 'controlled worker exit'); child.exitCode = 7; child.emit('exit', 7, null);
  await rejected; assertListenersRemoved(child);
});

for (const target of ['child', 'stdin', 'stdout', 'stderr']) test(`actual silence helper preserves ${target} errors without a deadline`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-error-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { child, commands } = controlledChild(), failure = Error(`controlled ${target} failure`);
  const pending = finishAfterSilence(child, { inbox, waitMs: 120 });
  const rejected = assert.rejects(pending, error => error === failure);
  (target === 'child' ? child : child[target]).emit('error', failure);
  await rejected; assert.deepEqual(commands, []); assertListenersRemoved(child);
});

test('only a complete new notice releases actual helper progress and explicit finish', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-positive-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldNotice = { type: 'notice', id: 'earlier-run' }, next = { type: 'notice', id: 'new-run' };
  fs.writeFileSync(inbox, JSON.stringify(oldNotice) + '\n' + JSON.stringify(next));
  const { child, commands } = controlledChild();
  const pending = finishAfterSilence(child, { inbox, seenIds: [oldNotice.id], waitMs: 120 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [], 'an incomplete append is not a durable new notice');
  fs.appendFileSync(inbox, '\n');
  assert.deepEqual(await pending, next);
  assert.deepEqual(commands, ['progress\n', 'finish\n']); assert.equal(child.exitCode, 0);
  assertListenersRemoved(child);
});

test('a real error during the substantive quiet interval is preserved before finish', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-quiet-error-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'new-run' }) + '\n');
  const { child, commands } = controlledChild(), failure = Error('controlled quiet worker error');
  const pending = finishAfterSilence(child, { inbox });
  const rejected = assert.rejects(pending, error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, ['progress\n']); child.emit('error', failure);
  await rejected; assert.deepEqual(commands, ['progress\n']); assertListenersRemoved(child);
});
