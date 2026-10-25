import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('an earlier durable notice cannot release the next payload and a missing notice has a bounded failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-silence-negative-')), inbox = path.join(root, 'inbox.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'earlier-run' }) + '\n');
  const [command, ...args] = silenceCommand(), child = spawnChild(t, command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(finishAfterSilence(child, { inbox, seenIds: ['earlier-run'], waitMs: 120 }), /no new durable silence notice/);
  assert.equal(child.exitCode, null, 'a stale notice does not finish the payload');
  child.stdin.end('finish\n'); assert.equal((await waitForExit(child)).code, 0);
});
