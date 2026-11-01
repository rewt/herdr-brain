import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectMinors, DISPOSITION_PREFIX, reportMinors } from '../measurement/minor-batches.mjs';
import { readReport } from '../lib/report.mjs';
import { fold } from '../lib/state.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const text = (body, extra = '') => `---\nrun: R-2\noutcome: done\nsummary: Reviewed\nheadline: Review complete\nverdict: PASS\nproposals: []\n${extra}---\n${body}`;
const plain = '## Batched Minors\n- lib/a.mjs:12 - Empty input loses the reason; retain it.\n- `lib/a.mjs:29` - A retry duplicates the note; deduplicate it.';
function fixture(reportText = text(plain)) {
  const events = [], add = e => events.push({ at: '2026-11-01T18:00:00Z', by: 'fixture', seq: events.length + 1, ...e });
  add({ type: 'item.added', id: 'ENG-1', role: 'engineer' });
  add({ type: 'run.started', id: 'R-1', item: 'ENG-1' });
  add({ type: 'item.added', id: 'REV-1', role: 'review', meta: {
    review_source_item: 'ENG-1', review_source_run: 'R-1',
    review_target: { base: 'a'.repeat(40), head: 'b'.repeat(40), reportHash: 'c'.repeat(64), covered_commits: ['b'.repeat(40)] } } });
  add({ type: 'run.started', id: 'R-2', item: 'REV-1', report_path: '/editable/unused' });
  const parsed = readReport(reportText);
  assert.deepEqual(parsed.errors, []);
  add({ type: 'report.ingested', run: 'R-2', item: 'REV-1', file: 'reports/R-2.md', sha256: sha(reportText), report: parsed.report });
  const read = file => { assert.equal(file, '/record/reports/R-2.md'); return reportText; };
  const collect = () => collectMinors({ events, org: '/record', read });
  return { events, add, collect, parsed };
}

test('plain Minor-only report enters one waiting batch and retains every immutable inventory finding', () => {
  const f = fixture(), state = fold(f.events), run = state.runs.get('R-2');
  const result = reviewResultEvents({ state, events: f.events, run, report: f.parsed.report, body: f.parsed.body, sha256: sha(text(plain)) });
  assert.equal(result.filter(e=>e.type==='item.added').length, 1);
  assert.equal(result.find(e=>e.type==='item.added').meta.queue_selected, false);
  assert.equal(result[0].type, 'change.reviewed');
  assert.equal(result[0].verdict, 'PASS');
  assert.equal(result[0].findings.length, 2);
  assert.equal(result[0].intent_fulfilled, false); // batching cannot assert missing acceptance
  const original = f.collect();
  for (const event of result) f.add(event);
  const inventory = f.collect();
  assert.deepEqual(inventory.issues, []);
  assert.equal(inventory.findings.length, 2);
  assert.equal(inventory.pending.length, 0);
  assert.equal(inventory.groups.length, 1);
  assert.equal(inventory.waiting_batches.length, 1);
  assert.deepEqual(inventory.findings.map(f=>f.key), original.findings.map(f=>f.key));
  assert.ok(inventory.findings.every(f=>f.disposition.status==='batched'));
  assert.deepEqual(inventory.reviews[0].fix_sessions, []);
  assert.deepEqual(inventory.findings.map(r => r.key), f.collect().findings.map(r => r.key));
  assert.equal(inventory.findings[0].report_sha256, sha(text(plain)));
});

test('Major and mixed reviews keep existing corrections; old Minor format is reported with its actual fix starts', () => {
  const mixed = fixture(text('- [Major] lib/a.mjs:4 - Drops data\n- [Minor] lib/a.mjs:7 - Omits context'));
  const state = fold(mixed.events);
  const result = reviewResultEvents({ state, events: mixed.events, run: state.runs.get('R-2'), report: mixed.parsed.report, body: mixed.parsed.body, sha256: 'd'.repeat(64) });
  assert.deepEqual(result[0].findings.map(f => f.severity), ['major', 'minor']);
  assert.ok(result.some(e => e.type === 'item.added' && e.meta.severity === 'major'));
  assert.ok(result.some(e => e.type === 'review.finding-linked'));
  assert.equal(mixed.collect().findings.length, 0);
  assert.equal(mixed.collect().legacy_minor_only.length, 0);
  const legacy = fixture(text('- [Minor] lib/a.mjs:7 - Omits context'));
  legacy.add({ type: 'item.added', id: 'ENG-2', role: 'engineer', from_run: 'R-2' });
  legacy.add({ type: 'run.started', id: 'R-3', item: 'ENG-2' });
  assert.deepEqual(legacy.collect().legacy_minor_only[0].fix_sessions, ['R-3']);
  const structured = fixture(text('Reviewed.', 'findings:\n  - severity: minor\n    text: lib/a.mjs:9 - Reason\n'));
  assert.equal(structured.collect().legacy_minor_only[0].tagged_or_structured_minors.length, 1);
});

test('disposition history preserves batches, fixed, stale and dismissed findings with concrete evidence', () => {
  const f = fixture(), keys = f.collect().pending;
  f.add({ type: 'item.added', id: 'ENG-3', role: 'engineer' });
  const note = (finding, status, extra = {}) => f.add({ type: 'note.added', id: 'REV-1', text: DISPOSITION_PREFIX + JSON.stringify({
    schema: 'brain.minor-batch/v1', finding, status, batch: 'ENG-3', reason: 'Same retry parser; captured diff establishes disposition', evidence: '/evidence/pilot.md', ...extra }) });
  note(keys[0], 'batched');
  note(keys[0], 'fixed');
  note(keys[1], 'stale');
  note(keys[1], 'dismissed', { reason: 'Captured contract explicitly allows this behavior' });
  const inventory = f.collect();
  assert.deepEqual(inventory.pending, []);
  assert.equal(inventory.findings[0].disposition.status, 'fixed');
  assert.equal(inventory.findings[0].dispositions.length, 2);
  assert.equal(inventory.findings[1].disposition.status, 'dismissed');
  assert.deepEqual(inventory.issues, []);
});

test('bad dispositions and changed or missing immutable report bytes remain visible and do not dispose findings', () => {
  const f = fixture(), key = f.collect().pending[0];
  f.add({ type: 'note.added', id: 'REV-1', text: DISPOSITION_PREFIX + JSON.stringify({ schema: 'brain.minor-batch/v1', finding: key, status: 'batched', batch: 'ENG-404', reason: 'related', evidence: '/evidence' }) });
  assert.equal(f.collect().issues.length, 1);
  assert.equal(f.collect().pending.length, 2);
  const corrupted = collectMinors({ events: f.events, org: '/record', read: () => 'changed' });
  assert.match(corrupted.issues[0].error, /hash mismatch/);
  const missing = collectMinors({ events: f.events, org: '/record', read: () => { throw Error('missing report'); } });
  assert.match(missing.issues[0].error, /missing report/);
});

test('malformed, empty and mixed plain sections fail visibly; fences cannot create batch findings', () => {
  for (const body of ['## Batched Minors\n', '## Batched Minors\n- missing location', `${plain}\ncontinued silently`, `${plain}\n## Batched Minors\n- lib/b.mjs:3 - Duplicate section`, `${plain}\n- [Major] lib/a.mjs:8 - Broken`]) {
    const inventory = fixture(text(body)).collect();
    assert.equal(inventory.issues.length, 1, body);
    if (body.includes('[Major]')) assert.equal(inventory.findings.length, 0);
  }
  assert.equal(reportMinors(text('```md\n' + plain + '\n```')).rows.length, 0);
});

test('near headings and unclosed or over-indented fences are issues, while valid rows survive malformed lines', () => {
  for (const body of ['## Batched minors\n- lib/a.mjs:1 - Lost', '### Batched Minors\n- lib/a.mjs:1 - Lost',
    '```md\n' + plain, '    ```md\n' + plain]) {
    const inventory = fixture(text(body)).collect();
    assert.equal(inventory.issues.length, 1, body);
    assert.ok(inventory.findings.some(f => f.malformed), body);
  }
  const f = fixture(text(plain + '\nwrapped continuation'));
  const before = f.collect();
  assert.equal(before.findings.length, 3);
  assert.equal(before.findings.filter(f => f.location).length, 2);
  const malformed = before.findings.find(f => f.malformed);
  f.add({ type: 'note.added', id: 'REV-1', text: DISPOSITION_PREFIX + JSON.stringify({
    schema: 'brain.minor-batch/v1', finding: malformed.key, status: 'dismissed',
    reason: 'Continuation repeats the preceding finding; retained original body bytes', evidence: '/evidence/report-analysis' }) });
  const after = f.collect();
  assert.deepEqual(after.issues, []);
  assert.deepEqual(after.pending, before.findings.filter(f => !f.malformed).map(f => f.key));
  assert.deepEqual(after.findings.map(f => f.key), before.findings.map(f => f.key));
});

test('dropping a batch returns its findings to pending until a later concrete disposition', () => {
  const f = fixture(), key = f.collect().pending[0];
  f.add({ type: 'item.added', id: 'ENG-3', role: 'engineer' });
  const note = status => f.add({ type: 'note.added', id: 'REV-1', text: DISPOSITION_PREFIX + JSON.stringify({
    schema: 'brain.minor-batch/v1', finding: key, status, batch: 'ENG-3', reason: 'Retained batch evidence', evidence: '/evidence/batch' }) });
  note('batched');
  assert.ok(!f.collect().pending.includes(key));
  f.add({ type: 'item.closed', id: 'ENG-3', as: 'dropped' });
  assert.ok(f.collect().pending.includes(key));
  note('stale');
  assert.ok(!f.collect().pending.includes(key));
});

test('ordinary typed Minor batches remain listed and grouped for explicit owner selection', () => {
  const f = fixture(text('Reviewed.', 'findings:\n  - severity: minor\n    text: lib/a.mjs:9 - Preserve context\n'));
  const state = fold(f.events);
  for (const event of reviewResultEvents({state, events:f.events, run:state.runs.get('R-2'),
    report:f.parsed.report, body:f.parsed.body, sha256:sha(text('Reviewed.', 'findings:\n  - severity: minor\n    text: lib/a.mjs:9 - Preserve context\n'))})) f.add(event);
  const inventory = f.collect();
  assert.equal(inventory.findings.length, 1);
  assert.match(inventory.findings[0].key, /^review-finding\/v1:/);
  assert.equal(inventory.waiting_batches.length, 1);
  assert.deepEqual(inventory.groups[0].findings, [inventory.findings[0].key]);
  assert.deepEqual(inventory.legacy_minor_only, []);
  assert.deepEqual(inventory.issues, []);
});
