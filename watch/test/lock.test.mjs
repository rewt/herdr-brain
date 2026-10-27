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
    if (!String(file).endsWith('.tmp')) return write(file, data, options);
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

test('two stale takers both prove death but only the guarded taker can remove and replace the lock', t => {
  const { directory, rows, options } = fixture(t);
  acquireWatcherLock(options); rows.delete(101);
  const lock = path.join(directory, fs.readdirSync(directory)[0]);
  rows.set(303, { pid: 303, identity: 'other-birth', state: 'S' });
  const unlink = fs.unlinkSync;
  let interleaved = false, deadReads = 0;
  const readProcess = pid => {
    if (pid === 101) deadReads++;
    return options.readProcess(pid);
  };
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === lock && !interleaved) {
      interleaved = true;
      // Both old-code takers have passed the byte equality check here. The
      // second used to publish, then lose its winning lock to this unlink.
      assert.throws(() => acquireWatcherLock({ ...options, pid: 303, readProcess }), /another watcher/);
      assert.equal(JSON.parse(fs.readFileSync(lock)).pid, 101);
    }
    return unlink(file);
  });
  const release = acquireWatcherLock({ ...options, pid: 202, readProcess });
  assert.ok(interleaved); assert.equal(deadReads, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock)), { pid: 202, identity: 'own-birth' });
  assert.deepEqual(fs.readdirSync(directory), [path.basename(lock)]);
  release(); assert.deepEqual(fs.readdirSync(directory), []);
});

function abandoned(t, owner = { pid: 404, identity: 'dead-birth' }) {
  const f = fixture(t);
  acquireWatcherLock(f.options); f.rows.delete(101);
  const lock = path.join(f.directory, fs.readdirSync(f.directory)[0]), guard = `${lock}.reclaim`;
  const token = '11111111-1111-1111-1111-111111111111';
  fs.mkdirSync(guard);
  const file = path.join(guard, `${token}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...owner, token }));
  return { ...f, lock, guard, file };
}

for (const variant of ['dead', 'reused', 'empty', 'after-unlink', 'after-publication']) test(`watcher recovers abandoned reclamation (${variant})`, t => {
  const f = abandoned(t);
  if (variant === 'reused') f.rows.set(404, { pid: 404, identity: 'new-birth', state: 'S' });
  if (variant === 'empty') fs.unlinkSync(f.file);
  if (variant === 'after-unlink') fs.unlinkSync(f.lock);
  if (variant === 'after-publication') fs.writeFileSync(f.lock, JSON.stringify({ pid: 404, identity: 'dead-birth' }));
  const release = acquireWatcherLock({ ...f.options, pid: 202 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lock)), { pid: 202, identity: 'own-birth' });
  release();
  // A crash after removing the public lock needs no takeover guard for the
  // next fresh publisher. Its subsequent stale takeover recovers the orphan.
  if (variant === 'after-unlink') {
    acquireWatcherLock({ ...f.options, pid: 202 }); f.rows.delete(202);
    acquireWatcherLock({ ...f.options, pid: 101, readProcess: pid => ({ ok: true, value: pid === 101 ? { pid, identity: 'returned-birth', state: 'S' } : null }) })();
  }
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const variant of ['live', 'unknown', 'malformed', 'legacy-live']) test(`watcher retains ${variant} reclamation state`, t => {
  const f = abandoned(t, { pid: 202, identity: 'own-birth' });
  if (variant === 'malformed') fs.writeFileSync(f.file, '{');
  if (variant === 'legacy-live') fs.writeFileSync(f.file, JSON.stringify({ pid: 202, token: path.basename(f.file, '.json') }));
  const before = fs.readFileSync(f.lock, 'utf8'), guardBefore = fs.readFileSync(f.file, 'utf8');
  const readProcess = pid => variant === 'unknown' && pid === 202 ? { ok: false, error: 'fixture denied' } : f.options.readProcess(pid);
  assert.throws(() => acquireWatcherLock({ ...f.options, pid: 101, readProcess: pid => pid === 101
    ? { ok: true, value: { pid, identity: 'new-birth', state: 'S' } } : readProcess(pid) }), /another watcher|identity|JSON|property/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), before);
  assert.equal(fs.readFileSync(f.file, 'utf8'), guardBefore);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [path.basename(f.lock), path.basename(f.guard)].sort());
});

test('delayed recovery cannot remove the replacement guard or its winning public lock', t => {
  const f = abandoned(t), unlink = fs.unlinkSync;
  f.rows.set(303, { pid: 303, identity: 'other-birth', state: 'S' });
  let interleaved = false, winner;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === f.file && !interleaved) {
      interleaved = true;
      winner = acquireWatcherLock({ ...f.options, pid: 303 });
      assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, 303);
    }
    return unlink(file);
  });
  assert.throws(() => acquireWatcherLock({ ...f.options, pid: 202 }), /watcher lock changed/);
  assert.ok(interleaved);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lock)), { pid: 303, identity: 'other-birth' });
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(f.lock)]);
  winner(); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a reclaimer paused after deletion cannot remove a newly published nonempty guard', t => {
  const f = abandoned(t), unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  f.rows.set(303, { pid: 303, identity: 'other-birth', state: 'S' });
  let interleaved = false, winner, replacementObserved = false;
  t.mock.method(fs, 'unlinkSync', file => {
    const result = unlink(file);
    if (file === f.file && !interleaved) {
      interleaved = true;
      winner = acquireWatcherLock({ ...f.options, pid: 303 });
    } else if (file === f.lock && interleaved && !replacementObserved) {
      // Resume the delayed old guard's rmdir while the new guard is held.
      assert.throws(() => rmdir(f.guard), { code: 'ENOTEMPTY' });
      const entries = fs.readdirSync(f.guard);
      assert.equal(entries.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.guard, entries[0]))).pid, 303);
      replacementObserved = true;
    }
    return result;
  });
  assert.throws(() => acquireWatcherLock({ ...f.options, pid: 202 }), /watcher lock changed/);
  assert.ok(replacementObserved);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lock)), { pid: 303, identity: 'other-birth' });
  winner(); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a failed reclamation-owner write preserves the stale lock and removes private staging', t => {
  const f = abandoned(t), write = fs.writeFileSync;
  fs.rmSync(f.guard, { recursive: true });
  const before = fs.readFileSync(f.lock, 'utf8');
  const failure = Object.assign(Error('fixture guard write failure'), { code: 'EIO' });
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    write(file, data.slice(0, 1), options);
    throw failure;
  });
  assert.throws(() => acquireWatcherLock({ ...f.options, pid: 202 }), error => error === failure);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(f.lock)]);
});
