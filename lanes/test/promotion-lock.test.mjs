import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, PROMOTION_LOCK_WAIT_MS } from '../promotion-lock.mjs';

for (const factor of [1, 6]) test(`promotion lock refuses at its finite loaded bound (factor ${factor}) and preserves the holder`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-lock-')), lock = path.join(root, 'lane-promote.lock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = acquireLock(lock), owner = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
  let elapsed = 0, waits = 0;
  t.mock.method(os, 'loadavg', () => [factor * 4, 0, 0]);
  t.mock.method(os, 'availableParallelism', () => 4);
  t.mock.method(Date, 'now', () => elapsed);
  t.mock.method(Atomics, 'wait', () => {
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
    elapsed += ++waits === 1 ? 120_000 * factor - 1 : 1;
  });
  const refusal = `locked: ${lock}; inspect owner.json and surviving processes before removing a stale lock`;
  try {
    assert.equal(PROMOTION_LOCK_WAIT_MS, 120_000);
    assert.throws(() => acquireLock(lock), { message: refusal });
    assert.equal(waits, 0, 'unrelated lock callers still refuse immediately');
    assert.throws(() => acquireLock(lock, { waitMs: PROMOTION_LOCK_WAIT_MS }), { message: refusal });
    assert.equal(waits, 2, 'the waiter reaches the bound, including its last millisecond');
    assert.equal(elapsed, 120_000 * factor, 'load scales the fixed allowance exactly once');
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
  } finally { t.mock.restoreAll(); release(); }
  const unlock = acquireLock(lock, { waitMs: PROMOTION_LOCK_WAIT_MS });
  unlock(); unlock();
  assert.equal(fs.existsSync(lock), false);
});
