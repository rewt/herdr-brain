import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

for (const name of ['STOP', 'HOLD']) for (const boundary of ['run', 'validate'])
test(`prepared promotion ${boundary} reports project ${name} appearing before integration`, t => {
  const f = fixture(t), options = { canonical: f.canonical }, prepared = preparePromotionGuard(options);
  fs.writeFileSync(f.marker(name), name);
  assert.throws(() => prepared[boundary](() => assert.fail('late halt integrated')), {
    message: name === 'HOLD' ? 'PROMOTION_HELD: supervisor HOLD exists; nothing merged' : 'supervisor STOP exists; nothing merged',
    ...(name === 'HOLD' ? { code: 'PROMOTION_HELD' } : {}),
  });
  assert.equal(fs.readFileSync(f.marker(name), 'utf8'), name);
  fs.unlinkSync(f.marker(name));
  if (boundary === 'run') assert.throws(() => prepared.run(), /already used/);
  let integrated = 0;
  withPromotionGuard(options, () => integrated++);
  assert.equal(integrated, 1);
});

test('project STOP keeps precedence when HOLD also exists', t => {
  const f = fixture(t), prepared = preparePromotionGuard({ canonical: f.canonical });
  for (const name of ['STOP', 'HOLD']) fs.writeFileSync(f.marker(name), name);
  assert.throws(() => withPromotionGuard({ canonical: f.canonical }), { message: 'supervisor STOP exists; nothing merged' });
  assert.throws(() => prepared.validate(), { message: 'supervisor STOP exists; nothing merged' });
  assert.throws(() => prepared.run(), { message: 'supervisor STOP exists; nothing merged' });
});

test('prepared promotion retains the original Git observation fence after halt recheck', t => {
  const f = fixture(t);
  const git = args => execFileSync('git', ['-C', f.canonical, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--initial-branch=main']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base']);
  const head = git(['rev-parse', 'HEAD']);
  git(['branch', 'same-head']);
  const prepared = preparePromotionGuard({ canonical: f.canonical, workspace: f.canonical, expectedHead: head });
  git(['symbolic-ref', 'HEAD', 'refs/heads/same-head']);
  assert.equal(git(['rev-parse', 'HEAD']), head);
  assert.throws(() => prepared.validate(), { code: 'RECORD_OBSERVATION_CONFLICT' });
  assert.throws(() => prepared.run(() => assert.fail('stale source integrated')), { code: 'RECORD_OBSERVATION_CONFLICT' });
  let integrated = 0;
  withPromotionGuard({ canonical: f.canonical, workspace: f.canonical, expectedHead: head }, () => integrated++);
  assert.equal(integrated, 1);
});
