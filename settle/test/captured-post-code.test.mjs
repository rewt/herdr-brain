import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { OPERATOR_LANDING_WAIVER } from '../../lib/validation-declaration.mjs';

const result = r => { assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };

for (const change of ['engineer-head', 'newer-run']) test(`post-code review completes on captured immutable source after ${change} without changing newer work`, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ landing_waiver: OPERATOR_LANDING_WAIVER, review: 'parallel' }));
  f.git(['add', '.lane.validation.json']); f.git(['commit', '-qm', 'Current operator policy']);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ verdict: 'PASS', findings: 'None' }));
  const captured = result(f.settle(run, ['--defer-review']));
  assert.equal(captured.result, 'review_pending');
  const journal = path.join(f.org, 'settle', `${run}.json`);
  const saved = JSON.parse(fs.readFileSync(journal));
  assert.equal(saved.reviewPolicy.cap, 1);
  assert.equal(saved.reviewPolicy.source, 'operator-landing-waiver');
  f.commit('later engineer source\n');
  let newer;
  if (change === 'newer-run') {
    newer = f.start(); f.report(newer);
    f.record(['ingest', f.show(newer).report_path]);
  }
  const itemBefore = f.show(saved.item), newerBefore = newer && f.show(newer);
  const reviewed = result(f.retry(run));
  assert.equal(reviewed.result, 'reviewed');
  assert.equal(reviewed.blocks_landing, false);
  assert.equal(reviewed.reviewed_commit, saved.head);
  assert.equal(reviewed.head, saved.head);
  assert.equal(reviewed.review.verdict, 'PASS');
  assert.equal(f.git(['show', `${saved.head}:work.txt`]), 'correct');
  assert.deepEqual(f.show(saved.item).outcome, itemBefore.outcome);
  assert.deepEqual(f.show(saved.item).closed, itemBefore.closed);
  if (newer) assert.deepEqual(f.show(newer), newerBefore, 'old review never mutates the newer run');
  const count = f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length;
  assert.equal(count, 1, 'one scripted reviewer, no correction/re-review chain');
  assert.equal(result(f.retry(run)).review.sha256, reviewed.review.sha256);
  assert.equal(f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length, count);
});
