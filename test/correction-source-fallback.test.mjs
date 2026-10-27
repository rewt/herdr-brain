import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { checkDispatchEligibility } from '../dispatch/launch-guard.mjs';

test('correction source deleted author branch falls back to current owning integration with launch CAS and keeps genuine unlanded source', t => {
  const f = fixture(t, { merged: false, occupied: false });
  isolatedEnv(t, f);
  const initialMain = f.git(['rev-parse', 'HEAD']);
  transact(f.org, () => ({ add: [
    { type: 'item.added', id: 'REV-1', kind: 'work', role: 'reviewer', meta: {
      review_source_run: 'R-1', review_target: { base: initialMain, head: f.head, diff_sha256: 'captured-diff', evidence: 'author-report' } } },
    { type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer', parent: 'REV-1', accept: ['specific correction control'], meta: {
      review_fix_of: `ENG-1:${f.head}`, review_source_run: 'R-1' } },
  ] }));
  const current = repo => {
    const events = loadEvents(f.org).events, state = fold(events);
    return correctionSource({ item: state.items.get('ENG-2'), state, events, repo, org: f.org });
  };
  const unlanded = current(f.lane);
  assert.equal(unlanded.base, f.head);
  assert.equal(unlanded.ref, 'refs/heads/lane/topic');

  f.git(['merge', '--ff-only', f.head]);
  f.git(['worktree', 'remove', f.lane]);
  f.git(['branch', '-d', 'lane/topic']);
  assert.equal(f.git(['for-each-ref', '--format=%(objectname)', 'refs/heads/lane/topic']), '');

  const caller = path.join(f.scratch, 'fresh-fixer');
  f.git(['worktree', 'add', '-b', 'lane/fixer', caller, initialMain]);
  const advance = () => {
    fs.appendFileSync(path.join(f.repo, 'seed'), '\nnew integration input');
    f.git(['commit', '-am', 'advance owning integration']);
    return f.git(['rev-parse', 'HEAD']);
  };
  const movedMain = advance(), fallback = current(caller);
  assert.equal(fallback.base, movedMain);
  assert.notEqual(fallback.base, f.git(['rev-parse', 'HEAD'], caller));
  assert.equal(fallback.ref, undefined);
  const job = { item: 'ENG-2', org: f.org, repo: caller, common: f.common, correction: fallback };
  assert.equal(checkDispatchEligibility(job, 'offline-source-boundary').item, 'ENG-2');
  const newerMain = advance();
  assert.throws(() => checkDispatchEligibility(job, 'offline-source-boundary'), error =>
    error.code === 'DISPATCH_INPUT_CHANGED' && /saved author source changed/.test(error.message));
  assert.equal(current(caller).base, newerMain);

  f.git(['branch', '-m', 'integration']);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ main: 'integration', retirement: { closeout_queue: false } }));
  assert.equal(current(caller).base, newerMain, 'use the owning configured integration branch');
  assert.deepEqual(f.read().actions, [], 'no native dispatch or live project effects');
});
