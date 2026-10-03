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
