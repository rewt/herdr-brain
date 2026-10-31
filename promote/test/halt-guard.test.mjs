import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePromotionGuard, withPromotionGuard, withPromotionGuards } from '../guard.mjs';

function fixture(t) {
  const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-halt-'));
  t.after(() => fs.rmSync(canonical, { recursive: true, force: true }));
  const marker = name => path.join(canonical, '.lane/supervisor', name);
  fs.mkdirSync(path.dirname(marker('HOLD')), { recursive: true });
  return { canonical, marker };
}

for (const name of ['STOP', 'HOLD']) for (const batch of [false, true])
test(`${batch ? 'batch' : 'direct'} promotion guard refuses project ${name} and permits a fresh request after clearing`, t => {
  const f = fixture(t), options = { canonical: f.canonical };
  const promote = operation => batch ? withPromotionGuards([options], operation) : withPromotionGuard(options, operation);
  fs.writeFileSync(f.marker(name), name);
  assert.throws(() => promote(() => assert.fail('held integration executed')), {
    message: name === 'HOLD' ? 'PROMOTION_HELD: supervisor HOLD exists; nothing merged' : 'supervisor STOP exists; nothing merged',
    ...(name === 'HOLD' ? { code: 'PROMOTION_HELD' } : {}),
  });
  assert.equal(fs.readFileSync(f.marker(name), 'utf8'), name);
  fs.unlinkSync(f.marker(name));
  let integrated = 0;
  promote(() => integrated++);
  assert.equal(integrated, 1);
});

for (const name of ['STOP', 'HOLD'])
test(`prepared promotion fences project ${name} appearing before integration`, t => {
  const f = fixture(t), prepared = preparePromotionGuard({ canonical: f.canonical });
  fs.writeFileSync(f.marker(name), name);
  assert.throws(() => prepared.run(() => assert.fail('late halt integrated')), { code: 'RECORD_OBSERVATION_CONFLICT' });
  assert.equal(fs.readFileSync(f.marker(name), 'utf8'), name);
});

test('project STOP keeps precedence when HOLD also exists', t => {
  const f = fixture(t);
  for (const name of ['STOP', 'HOLD']) fs.writeFileSync(f.marker(name), name);
  assert.throws(() => withPromotionGuard({ canonical: f.canonical }), { message: 'supervisor STOP exists; nothing merged' });
});
