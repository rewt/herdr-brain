import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForChange, until, producerOutcome } from '../../test/helpers/producer-wait.mjs';

function childProducer(t, source) {
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  return { exited, observe: () => ({
    state: child.exitCode === null && child.signalCode === null ? 'live' : 'exited',
    detail: `child exit ${child.exitCode}/${child.signalCode}`,
  }) };
}

test('producer wait rejects exit before evidence, including successful exit without evidence', async t => {
  for (const code of [0, 7]) {
    const child = childProducer(t, `process.exit(${code})`);
    await assert.rejects(waitForChange([], () => false, { producer: child.observe, signal: t.signal }),
      new RegExp(`Producer exited without expected fixture evidence: child exit ${code}/null`));
  }
});

test('producer wait rejects already missing evidence and stale teardown lock after exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'worker.lock'); fs.mkdirSync(lock);
  const child = childProducer(t, ''); await child.exited;
  await assert.rejects(until(() => !fs.existsSync(lock), {
    producer: child.observe, signal: t.signal, description: 'worker lock removal during teardown',
  }), /Producer exited without worker lock removal during teardown/);
  assert.equal(fs.existsSync(root), true, 'failure preserves fixture evidence');
});

test('producer wait permits healthy elapsed execution and reads final evidence after exit', async () => {
  let checks = 0;
  const value = await until(() => ++checks === 4 && 'evidence', {
    producer: () => ({ state: 'live' }), timeoutMs: 1,
  });
  assert.equal(value, 'evidence');
  let evidence = false;
  assert.equal(await waitForChange([], () => evidence, {
    producer: () => { evidence = 'final write'; return { state: 'exited' }; },
  }), 'final write');
});

test('producer wait cancellation interrupts live polling and pre-aborted evidence reads', async () => {
  const controller = new AbortController(); let observed;
  const first = new Promise(resolve => { observed = resolve; });
  const pending = until(() => false, { signal: controller.signal, producer: () => { observed(); return { state: 'live' }; } });
  await first; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(until(() => { throw Error('must not read'); }, { signal: controller.signal }), { name: 'AbortError' });
});

test('producer outcomes distinguish live birth, exit, PID reuse, and unknown inspection', async () => {
  const entry = { pid: 123, identity: 'birth', command: 'owned' };
  for (const row of [null, { ...entry, state: 'Z' }, { ...entry, identity: 'replacement', state: 'R' }, { ...entry, command: 'replacement', state: 'R' }])
    assert.equal(producerOutcome([entry], () => ({ ok: true, value: row })).state, 'exited');
  assert.equal(producerOutcome([entry], () => ({ ok: true, value: { ...entry, state: 'R' } })).state, 'live');
  const unknown = producerOutcome([entry], () => ({ ok: false, error: 'native inspection refused' }));
  assert.equal(unknown.state, 'unknown');
  await assert.rejects(until(() => false, { producer: () => unknown }), /Cannot confirm producer.*native inspection refused/);
});
