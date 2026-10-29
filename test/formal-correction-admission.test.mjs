import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { itemLaunchHold } from '../lib/item-launch-hold.mjs';
import { checkDispatchEligibility } from '../dispatch/launch-guard.mjs';

const KEY = 'review-finding/v1:fixture-major';

// A completed review REV-1 (run R-7) of ENG-1/R-1 created ENG-2 as its one
// formal correction and bound the typed Major to it.
function formalFixture(t, { fix = {}, link = {}, review = {}, from = 'R-7' } = {}) {
  const f = fixture(t, { merged: false, occupied: false });
  isolatedEnv(t, f);
  const base = f.git(['rev-parse', 'HEAD']), target = { base, head: f.head, diff_sha256: 'captured-diff', evidence: 'author-report' };
  transact(f.org, () => ({ add: [
    { type: 'item.added', id: 'G-1', kind: 'goal', title: 'Roadmap' },
    { type: 'item.added', id: 'REV-1', kind: 'work', role: 'reviewer', parent: 'G-1', meta: { review_key: `ENG-1:${f.head}`,
      review_source_item: 'ENG-1', review_source_run: 'R-1', review_target: target, ...review } },
    { type: 'run.started', id: 'R-7', item: 'REV-1', workspace: f.repo },
    { type: 'report.ingested', run: 'R-7', report: { outcome: 'done', summary: 'FAIL with one Major' }, sha256: 'review-report' },
    { type: 'run.started', id: 'R-8', item: 'REV-1', workspace: f.repo },
    { type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer', parent: 'REV-1', from_run: from, accept: ['exact Major control'],
      meta: { review_fix_of: `ENG-1:${f.head}`, review_source_item: 'ENG-1', review_source_run: 'R-1', review_owner_run: 'R-1',
        review_round_cap: 1, severity: 'major', review_finding_keys: [KEY], ...fix } },
    { type: 'review.finding-linked', item: 'ENG-2', correction_item: 'ENG-2', finding_key: KEY,
      finding: { severity: 'major', text: 'path:1 - exact Major' }, source_item: 'ENG-1', head: f.head, base,
      review_item: 'REV-1', review_run: 'R-7', report_sha256: 'review-report', ...link },
    { type: 'item.added', id: 'ENG-3', kind: 'work', role: 'engineer', parent: 'REV-1', from_run: 'R-7' },
    { type: 'item.closed', id: 'REV-1', as: 'done' },
  ] }));
  const current = () => { const events = loadEvents(f.org).events; return { events, state: fold(events) }; };
  const source = () => { const { events, state } = current();
    return correctionSource({ item: state.items.get('ENG-2'), state, events, repo: f.repo, org: f.org }); };
  return { ...f, current, source, job: (extra = {}) => ({ item: 'ENG-2', org: f.org, repo: f.repo, common: f.common, ...extra }) };
}

const refused = (f, job, subject) => {
  const record = fs.readFileSync(f.eventFile);
  assert.throws(() => checkDispatchEligibility(job, 'offline-formal-boundary'), error =>
    error.code === 'DISPATCH_INPUT_CHANGED' && error.launch_input.subject === subject, subject);
  assert.deepEqual(fs.readFileSync(f.eventFile), record, 'refusal appends nothing');
};

test('formal correction under its own completed review is admitted with its immutable source', t => {
  const f = formalFixture(t), correction = f.source(), { events, state } = f.current();
  assert.equal(correction.ref, 'refs/heads/lane/topic');
  assert.equal(correction.base, f.head);
  assert.match(correction.brief, /exact Major/);
  assert.equal(itemLaunchHold(state, 'ENG-2', events), null);
  assert.equal(checkDispatchEligibility(f.job({ correction }), 'offline-formal-boundary').item, 'ENG-2');
  assert.equal(state.items.get('REV-1').closed.as, 'done', 'completed review stays closed');
  assert.deepEqual(itemLaunchHold(state, 'ENG-2'), { subject: 'REV-1', reason: 'item/ancestor REV-1 is closed/held/reserved' },
    'callers without the event log keep the strict closed-ancestor refusal');
  assert.equal(itemLaunchHold(state, 'ENG-3', events).subject, 'REV-1', 'parent completion never authorizes unrelated work');
  refused(f, { ...f.job({ correction }), item: 'ENG-3' }, 'REV-1');
  assert.deepEqual(f.read().actions, [], 'no native effects');
});

test('formal correction with a wrong or missing typed finding or source stays refused', t => {
  const cases = {
    'missing finding binding': { link: { finding_key: 'review-finding/v1:other' } },
    'finding bound to another correction': { link: { correction_item: 'ENG-3' } },
    'finding from another review run': { link: { review_run: 'R-8' } },
    'finding against another head': { link: { head: 'f'.repeat(40) } },
    'missing typed finding keys': { fix: { review_finding_keys: [] } },
    'changed review key': { fix: { review_fix_of: 'ENG-1:another-head' } },
    'changed source run': { fix: { review_source_run: 'R-9' } },
    'changed source item': { fix: { review_source_item: 'ENG-9' } },
    'correction not created by the review run': { from: 'R-8' },
    'review key not bound to its captured head': { review: { review_key: 'ENG-1:another-head' }, fix: { review_fix_of: 'ENG-1:another-head' } },
  };
  for (const [name, shape] of Object.entries(cases)) {
    const f = formalFixture(t, shape), { events, state } = f.current();
    assert.equal(itemLaunchHold(state, 'ENG-2', events)?.subject, 'REV-1', name);
    refused(f, f.job(), 'REV-1');
  }
});

test('formal correction beneath an arbitrary closed parent stays refused', t => {
  const f = formalFixture(t);
  transact(f.org, () => ({ add: [
    { type: 'item.added', id: 'ENG-5', kind: 'work', role: 'engineer', parent: 'G-1' },
    { type: 'item.updated', id: 'ENG-2', fields: { parent: 'ENG-5' } },
    { type: 'item.closed', id: 'ENG-5', as: 'done' },
  ] }));
  refused(f, f.job(), 'ENG-5');
  const g = formalFixture(t);
  transact(g.org, () => ({ add: [{ type: 'item.reopened', id: 'REV-1', why: 'fixture' }, { type: 'item.closed', id: 'REV-1', as: 'dropped' }] }));
  refused(g, g.job(), 'REV-1');
});

test('formal correction keeps its exact review source beneath completed ordinary work ancestors', t => {
  const f = formalFixture(t), correction = f.source();
  transact(f.org, () => ({ add: [
    { type: 'item.added', id: 'DEC-1', kind: 'work', role: 'decision', parent: 'G-1' },
    { type: 'item.updated', id: 'REV-1', fields: { parent: 'DEC-1' } },
    { type: 'item.closed', id: 'DEC-1', as: 'done' },
  ] }));
  assert.equal(checkDispatchEligibility(f.job({ correction }), 'offline-formal-boundary').item, 'ENG-2');
  assert.deepEqual(f.source(), correction, 'completed decision does not change the immutable correction source');
  transact(f.org, () => ({ add: [{ type: 'item.updated', id: 'DEC-1', fields: { meta: { hold: true } } }] }));
  refused(f, f.job({ correction }), 'DEC-1');
});

test('formal correction refuses an explicitly held or reserved review or grandparent even when matched', t => {
  for (const subject of ['REV-1', 'G-1']) for (const flag of ['hold', 'held', 'operator_reserved', 'reserved']) {
    const f = formalFixture(t);
    transact(f.org, () => ({ add: [{ type: 'item.updated', id: subject, fields: { meta: { [flag]: true } } }] }));
    refused(f, f.job(), subject);
  }
});

test('formal correction admission still refuses changed source and a stale current claim at launch', t => {
  const f = formalFixture(t), correction = f.source();
  const fixer = path.join(f.scratch, 'fixer');
  f.git(['worktree', 'add', '-b', 'lane/fixer', fixer, correction.base]);
  const token = 'formal-fixer', journal = path.join(f.org, 'dispatch', `${token}.json`);
  const declared = { harness: 'codex', model: 'fixture', effort: 'high' };
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: f.repo, identity: f.common } };
  const added = transact(f.org, () => ({ add: [
    { type: 'run.started', id: 'R-9', item: 'ENG-2', workspace: fixer, meta: { ...declared, lane: 'fixer', route: 'engineer',
      dispatch_journal: journal, dispatch_attempt: token, dispatch_project: f.common, dispatch_record: f.org } },
    { type: 'run.claimed', run: 'R-9', owner, project: f.common, record: f.org },
  ] })).added;
  const generation = added.find(e => e.type === 'run.claimed').seq;
  const job = f.job({ run: 'R-9', workspace: fs.realpathSync(fixer), token, declared, lane: 'fixer', route: 'engineer',
    correction, ownership: { owner, generation } });
  assert.equal(checkDispatchEligibility(job, journal).run, 'R-9');
  assert.throws(() => checkDispatchEligibility({ ...job, ownership: { owner, generation: generation + 1 } }, journal),
    error => error.code === 'RUN_OWNED_ELSEWHERE');
  fs.writeFileSync(path.join(f.lane, 'seed'), 'moved author source'); f.git(['commit', '-am', 'move'], f.lane);
  assert.throws(() => checkDispatchEligibility(job, journal), error =>
    error.code === 'DISPATCH_INPUT_CHANGED' && /saved author source changed/.test(error.message));
  assert.deepEqual(f.read().actions, [], 'no native effects');
});
