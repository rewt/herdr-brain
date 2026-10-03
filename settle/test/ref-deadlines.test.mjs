import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/ref-transaction.mjs';
process.env.ORG_ACTOR = 'ref-deadlines-test';
for (const stage of ['start', 'prepare', 'commit']) {
  for (const mode of ['exhausted', 'refused']) test(`${mode} ${stage} replies preserve the ref and appropriate checkout locks`, async t => {
    const f = fixture(t, stage, mode), r = await f.run();
    assert.equal(r.code, 1, r.stderr + r.stdout);
    assert.deepEqual(fs.readFileSync(f.timers, 'utf8').trim().split('\n').map(JSON.parse),
      Array(['start', 'prepare', 'commit'].indexOf(stage) + 1).fill(90000), 'each protocol response scales once');
    // stderr and the refusal reply arrive independently; the product can use
    // its stage-specific fallback before the injected stderr text is observed.
    assert.match(r.stderr, mode === 'exhausted' ? /Git ref transaction timed out/
      : new RegExp(`injected ${stage} refusal|Git ref transaction refused ${stage}`));
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.from);
    assert.equal(f.git(['rev-parse', 'main']), f.plan.mainHead);
    const uncertain = stage === 'commit';
    assert.equal(fs.existsSync(f.headLock), uncertain); assert.equal(fs.existsSync(f.indexLock), uncertain);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), uncertain ? 'to\n' : 'from\n');
    if (uncertain) assert.match(r.stderr, /checkout outcome uncertain/);
  });
}

test('loaded transaction prepare retains a concurrent ref instead of overwriting its compare-and-swap refusal', async t => {
  const f = fixture(t, 'prepare', 'cas-refusal');
  const tree = f.git(['rev-parse', `${f.plan.from}^{tree}`]);
  const other = f.git(['commit-tree', tree, '-p', f.plan.from], f.repo, 'Concurrent work\n');
  f.env.REF_CONCURRENT_HEAD = other;
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /cannot lock ref.*expected/);
  assert.equal(f.git(['rev-parse', f.plan.branch]), other);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'from\n');
  assert.equal(fs.existsSync(f.headLock), false); assert.equal(fs.existsSync(f.indexLock), false);
});

test('loaded transaction refusal never removes a pre-existing HEAD or index lock', async t => {
  for (const kind of ['headLock', 'indexLock']) {
    const f = fixture(t, 'start', 'delayed');
    fs.writeFileSync(f[kind], 'foreign owner\n');
    const r = await f.run();
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /EEXIST/);
    assert.equal(fs.readFileSync(f[kind], 'utf8'), 'foreign owner\n');
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.from);
    assert.equal(fs.existsSync(f[kind === 'headLock' ? 'indexLock' : 'headLock']), false);
  }
});
