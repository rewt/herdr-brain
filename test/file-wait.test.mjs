import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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

test('file waits follow newly created parent directories with notification recovery', async t => {
  const file = path.join(path.dirname(fixture(t)), 'new', 'nested', 'ready');
  const waiting = waitForFile(file, text => text === 'nested');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'nested');
  assert.equal(await waiting, 'nested');
});

function silentWatch(t, subscribe = () => {}) {
  const original = fs.watch, watchers = [];
  fs.watch = (directory, callback) => {
    subscribe(directory);
    const watcher = new EventEmitter();
    watcher.directory = directory;
    watcher.closed = false;
    watcher.close = () => { watcher.closed = true; };
    watcher.on('change', callback);
    watchers.push(watcher);
    return watcher;
  };
  t.after(() => { fs.watch = original; });
  return watchers;
}

test('file waits recover evidence when the watcher delivers no notifications', async t => {
  const file = fixture(t), watchers = silentWatch(t);
  fs.writeFileSync(file, '');
  const waiting = waitForFile(file, text => /^[1-9]\d*$/.test(text), { timeoutMs: 100 });
  fs.writeFileSync(file, '123');
  assert.equal(await waiting, '123');
  assert.ok(watchers.every(watcher => watcher.closed));
});

test('file waits recover a deeper parent created between ancestor selection and subscription', async t => {
  const root = path.dirname(fixture(t)), directory = path.join(root, 'new', 'nested');
  const file = path.join(directory, 'ready');
  const watchers = silentWatch(t, () => fs.mkdirSync(directory, { recursive: true }));
  const waiting = waitForFile(file, text => text === 'nested', { timeoutMs: 100 });
  assert.equal(watchers[0].directory, root, 'ancestor was selected before the deeper parent existed');
  fs.writeFileSync(file, 'nested');
  assert.equal(await waiting, 'nested');
  assert.ok(watchers.some(watcher => watcher.directory === directory), 'recheck follows the deeper parent');
  assert.ok(watchers.every(watcher => watcher.closed));
});

test('file wait notifications never substitute for evidence and cancellation closes silent watchers', async t => {
  const file = fixture(t), watchers = silentWatch(t), controller = new AbortController();
  let checks = 0;
  const waiting = waitForFile(file, text => { checks++; return text === 'complete'; }, { signal: controller.signal });
  fs.writeFileSync(file, 'partial');
  // The injected watcher is silent by default; deliver one misleading event.
  watchers[0].emit('change');
  assert.equal(checks, 1, 'notification rereads the incomplete evidence');
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.ok(watchers.every(watcher => watcher.closed));
});

test('file waits scale their deadline once with measured load', async t => {
  const file = fixture(t), load = os.loadavg, capacity = os.availableParallelism, timer = globalThis.setTimeout;
  const allowances = [];
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  globalThis.setTimeout = (fn, ms, ...args) => { allowances.push(ms); return timer(fn, 1, ...args); };
  t.after(() => { os.loadavg = load; os.availableParallelism = capacity; globalThis.setTimeout = timer; });
  await assert.rejects(waitForFile(file, () => true, { timeoutMs: 1000 }), /timed out waiting/);
  assert.equal(allowances[0], 6000);
  assert.equal(allowances.filter(ms => ms === 6000).length, 1, 'deadline is sampled and scheduled once');
});
