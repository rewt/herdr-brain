import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireWatcherLock } from '../lock.mjs';

for (const variant of ['reused', 'dead', 'legacy-dead', 'unreadable', 'legacy-live', 'live', 'malformed']) test(`watcher lock handles ${variant} process identity`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = new Map([[101, { pid: 101, identity: 'old-birth', state: 'S' }], [202, { pid: 202, identity: 'own-birth', state: 'S' }]]);
  const readProcess = pid => ({ ok: true, value: rows.get(pid) ?? null });
  const options = { org: directory, run: 'R-1', directory, pid: 101, readProcess };
  const oldRelease = acquireWatcherLock(options), lock = path.join(directory, fs.readdirSync(directory)[0]);
  if (variant === 'reused') rows.get(101).identity = 'new-birth';
  if (variant === 'dead') rows.delete(101);
  if (variant.startsWith('legacy-')) fs.writeFileSync(lock, '101');
  if (variant === 'legacy-dead') rows.delete(101);
  if (variant === 'malformed') fs.writeFileSync(lock, '{');
  const bytes = fs.readFileSync(lock, 'utf8');
  const next = { ...options, pid: 202, ...(variant === 'unreadable' ? { readProcess: () => ({ ok: false, error: 'fixture denied' }) } : {}) };
  if (['reused', 'dead', 'legacy-dead'].includes(variant)) {
    const release = acquireWatcherLock(next);
    assert.deepEqual(JSON.parse(fs.readFileSync(lock)), { pid: 202, identity: 'own-birth' });
    oldRelease(); assert.ok(fs.existsSync(lock), 'old owner cannot release the replacement lock');
    release(); assert.ok(!fs.existsSync(lock));
  } else {
    assert.throws(() => acquireWatcherLock(next), /identity|another watcher|JSON|property/);
    assert.equal(fs.readFileSync(lock, 'utf8'), bytes);
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = new Map([[101, { pid: 101, identity: 'old-birth', state: 'S' }], [202, { pid: 202, identity: 'own-birth', state: 'S' }]]);
  const options = { org: directory, run: 'R-1', directory, pid: 101, readProcess: pid => ({ ok: true, value: rows.get(pid) ?? null }) };
  return { directory, rows, options };
}

for (const stale of [false, true]) test(`watcher lock never publishes empty or partial JSON (${stale ? 'stale takeover' : 'fresh'})`, t => {
  const { directory, rows, options } = fixture(t);
  if (stale) { acquireWatcherLock(options); rows.delete(101); }
  const expected = { pid: 202, identity: 'own-birth' };
  const write = fs.writeFileSync, link = fs.linkSync;
  let observations = 0, publications = 0;
  const observe = () => {
    // Look at the public lock while the injected write is empty or truncated.
    for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.lock'))) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')), expected);
    }
    observations++;
  };
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    const fd = fs.openSync(file, options.flag);
    try {
      observe();
      const middle = Math.floor(data.length / 2);
      write(fd, data.slice(0, middle)); observe();
      write(fd, data.slice(middle));
    } finally { fs.closeSync(fd); }
  });
  t.mock.method(fs, 'linkSync', (source, target) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), expected);
    const result = link(source, target);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), expected);
    publications++;
    return result;
  });
  const release = acquireWatcherLock({ ...options, pid: 202 });
  assert.equal(observations, 2); assert.equal(publications, 1);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1, 'successful publication removes the staging file');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')), expected);
  release(); assert.deepEqual(fs.readdirSync(directory), []);
});

test('watcher losing a concurrent publication refuses and cleans up its staging file', t => {
  const { directory, options } = fixture(t), link = fs.linkSync;
  let winner, contend = true;
  t.mock.method(fs, 'linkSync', (source, target) => {
    if (contend) {
      contend = false;
      winner = acquireWatcherLock({ ...options, pid: 202 });
    }
    return link(source, target);
  });
  assert.throws(() => acquireWatcherLock(options), /another watcher already owns R-1/);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1, 'only the winning public lock remains');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')), { pid: 202, identity: 'own-birth' });
  winner(); assert.deepEqual(fs.readdirSync(directory), []);
});

test('watcher cleans up a failed partial staging write without publishing a lock', t => {
  const { directory, options } = fixture(t), write = fs.writeFileSync;
  const failure = Object.assign(new Error('fixture write failure'), { code: 'EIO' });
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    write(file, data.slice(0, 1), options);
    throw failure;
  });
  assert.throws(() => acquireWatcherLock(options), error => error === failure);
  assert.deepEqual(fs.readdirSync(directory), []);
});
