import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fold, extendFold, itemStatus, blockersOf, blockedBy, releases, reviewsWithoutPass,
  openQuestionsFor, waitingImpact, wouldCycleBlock } from '../lib/state.mjs';
import { blockReason, itemJson } from '../lib/render.mjs';
import { completionEvents, completionFingerprint } from '../lib/completion.mjs';
import { report, setupOrg } from './helpers.mjs';

const parent = 'ENG-1349', review = 'REV-785', dependent = 'ENG-1352';
const start = (id, item) => ({ type: 'run.started', id, item });
const done = (run, verdict) => ({ type: 'report.ingested', run,
  report: { outcome: 'done', extra: verdict === undefined ? {} : { verdict } } });
const base = (role = 'reviewer') => [
  { type: 'item.added', id: parent, role: 'engineer', title: 'Implement the bch change' },
  { type: 'item.added', id: review, role, parent, title: 'Review the bch change' },
  { type: 'item.added', id: dependent, role: 'engineer', title: 'Use the bch change' },
  { type: 'link.added', blocker: parent, blocked: dependent },
  start('R-1926', parent), done('R-1926'),
];
const events = entries => entries.map((e, i) => ({ seq: i + 1, at: '2026-10-14T08:50:00Z', by: 'test', ...e }));
const state = (...entries) => fold(events([...base(), ...entries]));
function held(s, status) {
  assert.equal(itemStatus(s, review), status);
  assert.equal(itemStatus(s, parent), 'blocked');
  assert.equal(itemStatus(s, dependent), 'blocked');
  assert.deepEqual(blockersOf(s, parent), [review]);
  assert.deepEqual(blockedBy(s, review), [parent]);
  assert.deepEqual(itemJson(s, parent).blocked_by, [review]);
}

test('bch regression: a parent done report cannot release its dependent while its child review needs work', () => {
  const s = state(start('R-1927', review), done('R-1927', 'NEEDS-WORK'));
  held(s, 'done');
  assert.equal(s.items.get(parent).outcome.value, 'done', 'the worker report remains recorded');
  assert.equal(s.links.some(l => l.blocker === review && l.blocked === parent), false);
  assert.deepEqual(reviewsWithoutPass(s, parent), [review]);
  assert.deepEqual(blockReason(s, parent), [`${review} done, verdict NEEDS-WORK`]);
  assert.deepEqual(waitingImpact(s, review), { items: 2, runs: 0, plan_steps: 0 });
});

test('review children hold while open, active, or done without an explicit PASS', () => {
  held(state(), 'ready');
  held(state(start('R-1927', review)), 'active');
  for (const verdict of [undefined, '', 'FAIL', 'NEEDS-WORK']) {
    const s = state(start('R-1927', review), done('R-1927', verdict));
    held(s, 'done');
    assert.equal(releases(s, review, 'done'), false);
    assert.deepEqual(reviewsWithoutPass(s, parent), [review]);
  }
  assert.deepEqual(blockReason(state(start('R-1927', review), done('R-1927')), parent),
    [`${review} done, no PASS verdict`]);
});

test('PASS releases the parent and dependent; reopening or a newer failed verdict holds them again', () => {
  const s = state(start('R-1927', review), done('R-1927', ' pass '));
  assert.equal(itemStatus(s, parent), 'done');
  assert.equal(itemStatus(s, dependent), 'ready');
  assert.deepEqual(reviewsWithoutPass(s, parent), []);
  extendFold(s, events([{ type: 'item.reopened', id: review }]));
  held(s, 'ready');
  extendFold(s, events([start('R-1928', review), done('R-1928', 'PASS'),
    start('R-1929', review), done('R-1929', 'NEEDS-WORK')]));
  held(s, 'done');
});

test('review role aliases count, while an id prefix and ordinary children do not', () => {
  for (const role of ['review', 'Reviewer', 'REVIEW']) {
    assert.equal(itemStatus(fold(events(base(role))), parent), 'blocked', role);
  }
  for (const role of [null, 'engineer', 'researcher', 'human']) {
    assert.equal(itemStatus(fold(events(base(role))), parent), 'done', String(role));
  }
});

test('a child also linked as a blocker counts once and linked-only behavior is preserved', () => {
  const s = state({ type: 'link.added', blocker: review, blocked: parent },
    start('R-1927', review), done('R-1927', 'FAIL'));
  held(s, 'done');
  assert.deepEqual(reviewsWithoutPass(s, parent), [review]);
  assert.deepEqual(waitingImpact(s, review), { items: 2, runs: 0, plan_steps: 0 });
  for (const verdict of [undefined, 'PASS', 'FAIL']) {
    const linked = state({ type: 'item.updated', id: review, fields: { parent: null } },
      { type: 'link.added', blocker: review, blocked: parent }, start('R-1927', review), done('R-1927', verdict));
    assert.equal(itemStatus(linked, parent), verdict === 'FAIL' ? 'blocked' : 'done');
    assert.deepEqual(reviewsWithoutPass(linked, parent), verdict === 'PASS' ? [] : [review]);
  }
});

test('a review waiting for its parent can run after the work report and PASS without a cycle', () => {
  const entries = base().slice(0, 4);
  entries.push({ type: 'link.added', blocker: parent, blocked: review });
  let s = fold(events(entries));
  held(s, 'blocked');
  assert.equal(wouldCycleBlock(s, parent, review), false, 'the review hold is not a prerequisite edge');
  assert.equal(wouldCycleBlock(s, review, parent), true, 'explicit prerequisite cycles remain refused');
  entries.push(start('R-1926', parent), done('R-1926'));
  s = fold(events(entries));
  held(s, 'ready');
  assert.deepEqual(blockReason(s, review), [], 'views use work completion for the review prerequisite');
  entries.push(start('R-1927', review), done('R-1927', 'PASS'));
  s = fold(events(entries));
  assert.equal(itemStatus(s, review), 'done');
  assert.equal(itemStatus(s, parent), 'done');
  assert.equal(itemStatus(s, dependent), 'ready');
});

test('reviews waiting for one parent do not hold each other, but real work prerequisites still hold them', () => {
  const extra = 'REV-786', blocker = 'ENG-1350';
  const s = state({ type: 'item.added', id: extra, role: 'reviewer', parent },
    { type: 'link.added', blocker: parent, blocked: review },
    { type: 'link.added', blocker: parent, blocked: extra });
  assert.equal(itemStatus(s, review), 'ready');
  assert.equal(itemStatus(s, extra), 'ready');
  extendFold(s, events([{ type: 'item.added', id: blocker, role: 'engineer' },
    { type: 'link.added', blocker, blocked: parent }]));
  assert.equal(itemStatus(s, review), 'blocked');
  assert.equal(itemStatus(s, extra), 'blocked');
});

test('explicit work closure and active runs keep their existing precedence; dropped reviews release', () => {
  assert.equal(itemStatus(state(start('R-1928', parent)), parent), 'active');
  for (const as of ['done', 'dropped']) {
    assert.equal(itemStatus(state({ type: 'item.closed', id: parent, as }), parent), as);
  }
  const s = state({ type: 'item.closed', id: review, as: 'dropped' });
  assert.equal(itemStatus(s, parent), 'done');
  assert.equal(itemStatus(s, dependent), 'ready');
  assert.deepEqual(reviewsWithoutPass(s, parent), []);
  held(state({ type: 'item.closed', id: review, as: 'done' }), 'done');
});

test('open questions under child reviews hold promotion without a review blocker link', () => {
  const question = { type: 'item.added', id: 'HUM-1', role: 'human', parent: review };
  const s = state(start('R-1927', review), done('R-1927', 'PASS'), question);
  assert.deepEqual(openQuestionsFor(s, parent).map(q => q.id), ['HUM-1']);
});

function completion(s) {
  return { version: 1, batch: 'review-child', org: '/record', identity: '/repo/.git',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), gate: { exit_code: 0, log: '/gate.log', sha256: 'c'.repeat(64) },
    items: [{ item: parent, run: 'R-1926', head: 'b'.repeat(40), expected: completionFingerprint(s, parent),
      why: 'Independent review passed', superseded: [] }], excluded: [] };
}

test('batch completion and its fingerprint include child reviews without adding stored state', () => {
  for (const verdict of [undefined, 'NEEDS-WORK', 'PASS']) {
    const entries = events([...base(), start('R-1927', review), done('R-1927', verdict)]), s = fold(entries);
    const plan = completion(s), original = completionFingerprint(s, parent);
    if (verdict === 'PASS') {
      assert.deepEqual(completionEvents(s, entries, plan, '/record').result.items, [parent]);
    } else {
      assert.throws(() => completionEvents(s, entries, plan, '/record'), /unresolved or declined blockers.*REV-785/);
    }
    extendFold(s, events([{ type: 'item.reopened', id: review }]));
    assert.notEqual(completionFingerprint(s, parent), original);
    assert.throws(() => completionEvents(s, entries, plan, '/record'), /changed since batch preparation/);
    assert.deepEqual(Object.keys(s).sort(), ['candidates', 'categoryFlags', 'eventCount', 'items', 'lastAt', 'lessons', 'links', 'runs']);
  }
});

test('CLI views and briefs name an unlinked child review and its missing or failing verdict', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.ok(['add', 'Implement the change', '--role', 'engineer']);
  f.ok(['start', 'ENG-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-1/report.md'), report('run: R-1\noutcome: done\nsummary: Implemented.\nheadline: Implemented'));
  f.ok(['sync']);
  f.ok(['add', 'Review the change', '--role', 'Reviewer', '--parent', 'ENG-1']);
  f.ok(['start', 'REV-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-2/report.md'), report('run: R-2\noutcome: done\nsummary: Review completed.\nheadline: Review completed'));
  f.ok(['sync']);
  assert.equal(f.json(['show', 'ENG-1', '--json']).status, 'blocked');
  assert.match(f.ok(['status']), /ENG-1 .*REV-1 done, no PASS verdict/);
  assert.match(f.ok(['show', 'ENG-1']), /blocked by: REV-1 \(done, no PASS verdict\)/);
  // Existing briefs are immutable context; a missing brief is rendered from current events.
  fs.rmSync(path.join(f.dir, 'runs/R-1/brief.md'));
  assert.match(f.ok(['brief', 'R-1']), /\*\*REV-1\*\* Review the change — done, no PASS verdict/);
  f.ok(['start', 'REV-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-3/report.md'), report('run: R-3\noutcome: done\nverdict: NEEDS-WORK\nsummary: Needs correction.\nheadline: Needs correction'));
  f.ok(['sync']);
  assert.match(f.ok(['snapshot']), /\*\*ENG-1\*\* .*REV-1 done, verdict NEEDS-WORK/);
});

test('conditional close can finish a PASS review waiting on its parent while another child still holds the work', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.ok(['add', 'Implement the change', '--role', 'engineer']);
  f.ok(['start', 'ENG-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-1/report.md'), report('run: R-1\noutcome: done\nsummary: Implemented.\nheadline: Implemented'));
  f.ok(['sync']);
  for (const title of ['Review correctness', 'Review compatibility']) {
    const id = f.ok(['add', title, '--role', 'reviewer', '--parent', 'ENG-1']).trim();
    f.ok(['block', id, '--by', 'ENG-1']);
    assert.equal(f.json(['show', id, '--json']).status, 'ready');
  }
  f.ok(['start', 'REV-1']);
  fs.writeFileSync(path.join(f.dir, 'runs/R-2/report.md'), report('run: R-2\noutcome: done\nverdict: PASS\nsummary: Correct.\nheadline: Correct'));
  f.ok(['sync']);
  f.ok(['close', 'REV-1', '--if-current-run', 'R-2']);
  assert.equal(f.json(['show', 'REV-1', '--json']).closed.as, 'done');
  assert.equal(f.json(['show', 'ENG-1', '--json']).status, 'blocked');
  assert.match(f.fail(['close', 'ENG-1', '--if-current-run', 'R-1']), /blockers or outcome changed/);
});
