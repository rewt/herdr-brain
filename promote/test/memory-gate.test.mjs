import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refuseBeforeTrain, waitForPromotionMemory } from '../memory-gate.mjs';
import { publishProvingReservation, RESERVATION_WAIT_EXPIRED_CODE } from '../../test-slot/reservations.mjs';

test('the held promotion re-check never reads reservations and the unheld gate still honors STOP', t => {
  const lock = process.env.MONITOR_TEST_SLOT_COMPAT_PATH;
  const held = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
  t.after(() => held.release());
  const read = fs.readdirSync; let reservationReads = 0;
  fs.readdirSync = (file, ...args) => { if (String(file).endsWith('.occupancy')) { reservationReads++; throw Error('reservation read during held re-check'); } return read(file, ...args); };
  try { waitForPromotionMemory(path.dirname(lock), { held: true }); }
  finally { fs.readdirSync = read; }
  assert.equal(reservationReads, 0);
  const canonical = path.join(path.dirname(lock), 'canonical'); fs.mkdirSync(path.join(canonical, '.lane/supervisor'), { recursive: true });
  fs.writeFileSync(path.join(canonical, '.lane/supervisor/STOP'), 'STOP');
  assert.throws(() => waitForPromotionMemory(canonical), e => e.code === 'PROMOTION_STOPPED');
});

test('promotion reservations use one deadline through renewal and STOP cancels a resumed blocked wait', t => {
  const lock = process.env.MONITOR_TEST_SLOT_COMPAT_PATH, canonical = path.join(path.dirname(lock), 'bounded-promotion');
  const held = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'bounded promotion', expiresAt: new Date(Date.now() + 60000).toISOString() });
  t.after(() => held.release());
  const wait = Atomics.wait; let elapsed = 0;
  try {
    Atomics.wait = (_view, _index, _value, ms) => {
      elapsed += ms; held.renew({ expiresAt: new Date(Date.now() + 60000).toISOString() });
    };
    assert.throws(() => waitForPromotionMemory(canonical, { deadline: 3, clock: () => elapsed }),
      error => error.code === RESERVATION_WAIT_EXPIRED_CODE && error.elapsed_ms === 3);
    fs.mkdirSync(path.join(canonical, '.lane/supervisor'), { recursive: true });
    fs.writeFileSync(path.join(canonical, '.lane/supervisor/STOP'), 'STOP');
    assert.throws(() => waitForPromotionMemory(canonical, { checkStop: false, deadline: 3, clock: () => elapsed }),
      error => error.code === 'PROMOTION_STOPPED');
  } finally { Atomics.wait = wait; }
});

test('memory refusal completes every fresh batch member without attempts or replacing an existing result', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'train.json'), identity = path.join(root, '.git');
  const existing = { outcome: 'refused', reason: 'earlier guard' };
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', identity, id: 'batch',
    jobs: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], results: { three: existing } }));
  const error = Object.assign(Error('pressure'), { code: 'PROMOTION_MEMORY_PRESSURE' });
  refuseBeforeTrain({ file, identity, error });
  const plan = JSON.parse(fs.readFileSync(file));
  assert.equal(plan.phase, 'complete'); assert.deepEqual(plan.groups, []); assert.equal(plan.attempts, undefined);
  for (const id of ['one', 'two']) assert.deepEqual(plan.results[id], {
    outcome: 'refused', code: error.code, reason: error.message, batch: 'batch' });
  assert.deepEqual(plan.results.three, existing);
});

test('memory or STOP refusals preserve every byte of an earlier integration checkpoint', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'train.json'), identity = path.join(root, '.git');
  for (const phase of ['prepared', 'validated', 'integrated', 'complete']) {
    const saved = JSON.stringify({ schema: 'promotion-train/v1', identity, jobs: [{ id: 'one' }],
      attempts: [{ phase, tip: 'saved-candidate' }], phase: 'fast-forwarding' });
    fs.writeFileSync(file, saved);
    for (const code of ['PROMOTION_MEMORY_PRESSURE', 'PROMOTION_STOPPED', RESERVATION_WAIT_EXPIRED_CODE]) {
      const error = Object.assign(Error(code), { code });
      assert.throws(() => refuseBeforeTrain({ file, identity, error }), e => e === error);
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
    }
  }
});

test('a reservation deferral completes fresh train members without starting validation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'train.json'), identity = path.join(root, '.git');
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', identity, id: 'batch', jobs: [{ id: 'one' }] }));
  const error = Object.assign(Error('caller deadline exhausted after 3ms'), { code: RESERVATION_WAIT_EXPIRED_CODE });
  refuseBeforeTrain({ file, identity, error });
  const plan = JSON.parse(fs.readFileSync(file));
  assert.equal(plan.attempts, undefined); assert.deepEqual(plan.groups, []);
  assert.equal(plan.results.one.code, RESERVATION_WAIT_EXPIRED_CODE); assert.equal(plan.results.one.reason, error.message);
});

test('memory refusal rejects a foreign or malformed train before changing its receipt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'train.json'), identity = path.join(root, '.git');
  for (const plan of [{ schema: 'promotion-train/v1', identity: 'foreign', jobs: [] },
    { schema: 'unknown', identity, jobs: [] }, { schema: 'promotion-train/v1', identity, jobs: null }]) {
    const saved = JSON.stringify(plan); fs.writeFileSync(file, saved);
    assert.throws(() => refuseBeforeTrain({ file, identity, error: Error('pressure') }), /invalid train receipt/);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
});
