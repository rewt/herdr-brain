import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { OPERATOR_LANDING_WAIVER } from '../../lib/validation-declaration.mjs';
import { loadEvents, transact } from '../../lib/store.mjs';
import { fold } from '../../lib/state.mjs';
import { validateQueuedReview, reviewQueueBrief } from '../../line-service/review-queue.mjs';

const result = r => { assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };

for (const change of ['engineer-head', 'newer-run']) test(`post-code review completes on captured immutable source after ${change} without changing newer work`, t => {
  // New waiver intake uses the record queue. The fixture is a non-session
  // service caller; native reviewer dispatch is covered by the queue controls.
  const f = fixture(t, { actor: 'line-service' });
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ landing_waiver: OPERATOR_LANDING_WAIVER, review: 'parallel' }));
  f.git(['add', '.lane.validation.json']); f.git(['commit', '-qm', 'Current operator policy']);
  f.git(['merge', '--ff-only', 'main'], f.workspace);
  const base = f.git(['rev-parse', 'HEAD']), identity = f.git(['rev-parse', '--absolute-git-dir']);
  transact(f.org, () => ({ add: [{ type: 'line-service.phase0', id: 'fixture-boundary',
    project: identity, repo: f.repo, org: f.org, source: f.source, main: 'main', canonical_head: base }] }));
  const item = f.show('ENG-1').id, dispatch = path.join(f.org, 'dispatch', 'source.json');
  const run = f.record(['start', item, '--workspace', f.workspace, '--meta', 'lane=topic',
    '--meta', 'route=engineer', '--meta', 'harness=codex', '--meta', `dispatch_journal=${dispatch}`,
    '--meta', 'dispatch_attempt=source']).match(/R-\d+/)[0];
  f.record(['claim', run, '--controller', 'brain']);
  fs.mkdirSync(path.dirname(dispatch), { recursive: true });
  fs.writeFileSync(dispatch, JSON.stringify({ token: 'source', stage: 'complete', run, item,
    org: f.org, common: identity, workspace: f.workspace, base }));
  f.commit('correct\n');
  const head = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.git(['merge', '--ff-only', head]);
  f.report(run, 'done', { artifacts: [`Commit: ${head}`, 'work.txt'] });
  f.record(['ingest', f.show(run).report_path]);
  const captured = result(f.settle(run));
  assert.equal(captured.result, 'review_queued');
  assert.equal(captured.existing, false);
  const queued = f.show(captured.review_item), target = queued.meta.review_target;
  assert.equal(queued.meta.review_round_cap, 1);
  assert.equal(queued.meta.review_source_run, run);
  assert.equal(target.head, head);
  assert.equal(target.base, base);
  assert.equal(target.reportHash, f.show(run).report.sha256);
  assert.match(reviewQueueBrief(queued), /zero reviewer suites/);
  assert.equal(fs.existsSync(path.join(f.org, 'settle', `${run}.json`)), false, 'no parallel legacy settle journal');
  const evidence = fs.readFileSync(target.evidence);
  f.commit('later engineer source\n');
  let newer;
  if (change === 'newer-run') {
    newer = f.start(); f.report(newer);
    f.record(['ingest', f.show(newer).report_path]);
  }
  const itemBefore = f.show(item), runBefore = f.show(run), newerBefore = newer && f.show(newer);
  const events = loadEvents(f.org).events, state = fold(events);
  assert.deepEqual(validateQueuedReview({ events, state, org: f.org, repo: f.repo, identity,
    item: state.items.get(queued.id) }), target, 'launch still validates the original immutable target');
  const again = result(f.retry(run));
  assert.equal(again.review_item, queued.id);
  assert.equal(again.existing, true, 'replay retains the one queue item');
  // Complete an ordinary scripted reviewer report against committed objects,
  // never the engineer's newer worktree. No model/native launch is needed here.
  assert.equal(f.git(['show', `${target.head}:work.txt`]), 'correct');
  const reviewRun = f.record(['start', queued.id, '--workspace', f.repo]).match(/R-\d+/)[0];
  f.record(['claim', reviewRun, '--controller', 'brain']);
  f.report(reviewRun, 'done', { artifacts: [`Commit: ${target.head}`], body: 'Verdict: PASS\n\nNo findings.' });
  f.record(['ingest', f.show(reviewRun).report_path]);
  f.record(['ingest', f.show(reviewRun).report_path]);
  const reviewed = loadEvents(f.org).events.filter(e => e.type === 'change.reviewed');
  assert.equal(reviewed.length, 1, 'repeated ingest retains one exact-target verdict');
  assert.equal(reviewed[0].head, target.head);
  assert.equal(reviewed[0].base, target.base);
  assert.equal(reviewed[0].review_run, reviewRun);
  assert.equal(reviewed[0].verdict, 'PASS');
  assert.deepEqual(fs.readFileSync(target.evidence), evidence);
  assert.deepEqual(f.show(queued.id).meta.review_target, target);
  assert.deepEqual(f.show(run), runBefore, 'old producer run remains unchanged');
  assert.deepEqual(f.show(item).outcome, itemBefore.outcome);
  assert.deepEqual(f.show(item).closed, itemBefore.closed);
  if (newer) assert.deepEqual(f.show(newer), newerBefore, 'old review never mutates the newer run');
  assert.equal(f.show(queued.id).runs.length, 1, 'one reviewer run, no correction/re-review chain');
  assert.equal(f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length, 0, 'settle intake never launches a legacy reviewer');
});
