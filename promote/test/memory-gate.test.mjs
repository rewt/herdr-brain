import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refuseBeforeTrain } from '../memory-gate.mjs';

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
    for (const code of ['PROMOTION_MEMORY_PRESSURE', 'PROMOTION_STOPPED']) {
      const error = Object.assign(Error(code), { code });
      assert.throws(() => refuseBeforeTrain({ file, identity, error }), e => e === error);
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
    }
  }
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
