import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initOrg, withLock } from '../lib/store.mjs';
import { snapshotVersion } from '../lib/record-snapshot.mjs';
import { recordLockTimingJournal, recordLockRefusalJournal } from '../lib/run-timing.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-refusal-')), org = path.join(root, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initOrg(org);
  const timing = recordLockTimingJournal(org), refusal = recordLockRefusalJournal(org), lock = path.join(org, 'lock');
  const acquisitions = fs.readFileSync(timing, 'utf8');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  return { org, timing, refusal, lock, acquisitions };
}

test('explicit-control busy refusals record one attempt without probing or changing the live owner', t => {
  const f = fixture(t), kill = process.kill;
  process.kill = () => assert.fail('explicit control must not probe'); t.after(() => { process.kill = kill; });
  assert.throws(() => withLock(f.org, () => assert.fail('busy effect'), { recover: false, label: 'fixture', actor: 'worker' }), /explicit control/);
  const rows = fs.readFileSync(f.refusal, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schema, 'record-lock-refusal/v1'); assert.equal(rows[0].reason, 'explicit-control');
  assert.equal(rows[0].source_version, snapshotVersion); assert.equal(rows[0].node, process.version);
  assert.equal(rows[0].label, 'fixture'); assert.equal(rows[0].actor, 'worker'); assert.ok(rows[0].wait_ms >= 0);
  assert.equal(fs.readFileSync(f.timing, 'utf8'), f.acquisitions);
  assert.equal(fs.readFileSync(path.join(f.lock, 'pid'), 'utf8'), String(process.pid));
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), '');
});

test('exhausted busy waits retain the original refusal and do not count as acquisitions', t => {
  const f = fixture(t);
  assert.throws(() => withLock(f.org, () => assert.fail('live owner'), { timeoutMs: 0 }), /owner death is not confirmed/);
  const row = JSON.parse(fs.readFileSync(f.refusal, 'utf8').trim());
  assert.equal(row.reason, 'owner-unconfirmed'); assert.ok(row.wait_ms >= 0);
  assert.equal(fs.readFileSync(f.timing, 'utf8'), f.acquisitions); assert.equal(fs.existsSync(f.lock), true);
});

test('refused diagnostic writes cannot change lock authority or follow a substituted sidecar', t => {
  const f = fixture(t), target = path.join(f.org, 'untouched'); fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, f.refusal);
  assert.throws(() => withLock(f.org, () => assert.fail('busy effect'), { recover: false }), /explicit control/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assert.equal(fs.existsSync(f.lock), true);
  fs.unlinkSync(f.refusal); fs.mkdirSync(f.refusal);
  assert.throws(() => withLock(f.org, () => assert.fail('busy effect'), { recover: false }), /explicit control/);
  fs.rmSync(f.lock, { recursive: true });
  assert.equal(withLock(f.org, () => 42), 42);
  assert.equal(fs.existsSync(f.lock), false);
});
