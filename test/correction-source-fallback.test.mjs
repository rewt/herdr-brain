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

function successorFixture(t, { merged = true } = {}) {
  const f = fixture(t, { merged, occupied: false });
  isolatedEnv(t, f);
  // Establish the immutable prior blocked report before admitting a successor.
  const original = loadEvents(f.org).events.map(e => e.type === 'report.ingested' ? { ...e, report: { ...e.report, outcome: 'blocked' } } : e);
  fs.writeFileSync(f.eventFile, original.map(e => JSON.stringify(e) + '\n').join(''));
  const before = fold(original), item = before.items.get('ENG-1');
  const correction = correctionSource({ item, state: before, events: original, repo: f.repo, org: f.org });
  const token = 'owned-successor', journal = path.join(f.org, 'dispatch', `${token}.json`);
  const declared = { harness: 'codex', model: 'fixture', effort: 'high' };
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: f.repo, identity: f.common } };
  const result = transact(f.org, () => ({ add: [
    { type: 'item.reopened', id: 'ENG-1', why: 'fixture current successor' },
    { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: {
      ...declared, lane: 'topic', route: 'engineer', dispatch_journal: journal, dispatch_attempt: token,
      dispatch_project: f.common, dispatch_record: f.org } },
    { type: 'run.claimed', run: 'R-2', owner, project: f.common, record: f.org },
  ] }));
  const generation = result.added.find(e => e.type === 'run.claimed').seq;
  const job = { run: 'R-2', item: 'ENG-1', repo: f.repo, org: f.org, common: f.common, workspace: f.lane,
    token, declared, lane: 'topic', route: 'engineer', correction, ownership: { owner, generation },
    stage: 'worker', native_launch_attempted: false };
  fs.mkdirSync(path.dirname(journal)); fs.writeFileSync(journal, JSON.stringify(job));
  return { ...f, job, journal, originalReport: before.runs.get('R-1').report };
}

test('correction source permits only the validated current successor on a restored author allocation', t => {
  for (const merged of [true, false]) {
    const f = successorFixture(t, { merged });
    const journalBytes = fs.readFileSync(f.journal), recordBytes = fs.readFileSync(f.eventFile);
    assert.equal(checkDispatchEligibility(f.job, f.journal).run, 'R-2');
    const events = loadEvents(f.org).events, state = fold(events);
    const source = correctionSource({ item: state.items.get('ENG-1'), state, events, repo: f.repo, org: f.org,
      request: { job: f.job, journal: f.journal } });
    assert.equal(source.base, f.head);
    assert.equal(source.ref, merged ? undefined : 'refs/heads/lane/topic');
    assert.deepEqual(state.runs.get('R-1').report, f.originalReport);
    assert.deepEqual(fs.readFileSync(f.journal), journalBytes, 'original saved request survives');
    assert.deepEqual(fs.readFileSync(f.eventFile), recordBytes, 'original claim and record survive');
    assert.deepEqual(f.read().actions, [], 'pre-native source check launches nothing');
  }
});

test('correction source keeps foreign unknown and stale-claim owners protected on the saved allocation', t => {
  for (const kind of ['foreign', 'unknown', 'stale-claim', 'changed-request']) {
    const f = successorFixture(t);
    if (kind === 'foreign' || kind === 'unknown') {
      const owner = { controller: 'foreign', legacy: true, release: null };
      transact(f.org, () => ({ add: [
        { type: 'item.added', id: 'ENG-9', kind: 'work', role: 'engineer' },
        { type: 'run.started', id: 'R-9', item: 'ENG-9', workspace: f.lane },
        ...(kind === 'foreign' ? [{ type: 'run.claimed', run: 'R-9', owner, project: f.common, record: f.org }] : []),
      ] }));
    }
    const job = structuredClone(f.job);
    if (kind === 'stale-claim') job.ownership.generation++;
    if (kind === 'changed-request') job.token = 'different-request';
    const bytes = fs.readFileSync(f.journal), record = fs.readFileSync(f.eventFile);
    assert.throws(() => checkDispatchEligibility(job, f.journal), error =>
      kind === 'stale-claim' ? error.code === 'RUN_OWNED_ELSEWHERE' :
      kind === 'changed-request' ? error.code === 'DISPATCH_INPUT_CHANGED' : /active run owns the saved author allocation/.test(error.message));
    assert.deepEqual(fs.readFileSync(f.journal), bytes);
    assert.deepEqual(fs.readFileSync(f.eventFile), record);
    assert.deepEqual(f.read().actions, []);
  }
});
