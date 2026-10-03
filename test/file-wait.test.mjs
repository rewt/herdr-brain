import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForFile } from './helpers/file-wait.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-wait-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'ready');
}

test('file waits accept existing evidence and wait through an incomplete PID publication', async t => {
  const file = fixture(t);
  fs.writeFileSync(file, '');
  const waiting = waitForFile(file, text => /^[1-9]\d*$/.test(text));
  fs.writeFileSync(file, '123');
  assert.equal(await waiting, '123');
  assert.equal(await waitForFile(file, text => text === '123'), '123');
});

test('file waits observe atomic renames and close their watcher on cancellation', async t => {
  const file = fixture(t), temporary = `${file}.tmp`;
  const waiting = waitForFile(file, text => text === 'complete');
  fs.writeFileSync(temporary, 'complete'); fs.renameSync(temporary, file);
  assert.equal(await waiting, 'complete');
  const controller = new AbortController();
  const cancelled = waitForFile(file, () => false, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(waitForFile(file, () => false, { signal: controller.signal }), { name: 'AbortError' });
});

test('file waits use a finite measured-load deadline and report the missing evidence', async t => {
  const file = fixture(t);
  await assert.rejects(waitForFile(file, () => true, { timeoutMs: 10 }), /timed out waiting for.*ready/);
});

test('file waits follow newly created parent directories without polling', async t => {
  const file = path.join(path.dirname(fixture(t)), 'new', 'nested', 'ready');
  const waiting = waitForFile(file, text => text === 'nested');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'nested');
  assert.equal(await waiting, 'nested');
});

test('file waits scale their deadline once with measured load', async t => {
  const file = fixture(t), load = os.loadavg, capacity = os.availableParallelism, timer = globalThis.setTimeout;
  let allowance;
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  globalThis.setTimeout = (fn, ms, ...args) => { allowance = ms; return timer(fn, 1, ...args); };
  t.after(() => { os.loadavg = load; os.availableParallelism = capacity; globalThis.setTimeout = timer; });
  await assert.rejects(waitForFile(file, () => true, { timeoutMs: 1000 }), /timed out waiting/);
  assert.equal(allowance, 6000);
});
