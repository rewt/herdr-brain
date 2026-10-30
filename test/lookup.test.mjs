import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildLookup, searchLookup } from '../lib/lookup.mjs';
import { setupOrg } from './helpers.mjs';

const stamp = events => events.map((event, i) => ({ seq: i + 1, at: '2026-10-30T16:00:00Z', by: 'fixture', ...event }));
const annotate = (text, lookup) => `${text}\n[lookup] ${JSON.stringify(lookup)}`;
// Bounded planted excerpts, not copies of the backlog. Original references:
// ENG-936/R-1258 event:35008; ENG-161/R-216; L-3 event:2746;
// ENG-1040 event:46490 withdrawn by event:46497. Fixture sequences are local.
const planted = () => stamp([
  { type: 'item.added', id: 'ENG-936', title: 'Decision churn', role: 'engineer' },
  { type: 'run.started', id: 'R-1258', item: 'ENG-936' },
  { type: 'report.ingested', run: 'R-1258', file: 'reports/R-1258.md', sha256: 'planted', report: {
    summary: '321 fixed-rule items among 327 decisions; original-producer benefit unknown.', outcome: 'blocked',
    extra: { decisions: [{ text: 'Stop automatic blocked-work judgment production.', why: 'Churn without measured original-producer resolution benefit.' }],
      challenges: ['The old case 27 focus change remains unattributed.'] } } },
  { type: 'item.added', id: 'ENG-161', title: 'Fleet isolation', role: 'engineer' },
  { type: 'run.started', id: 'R-216', item: 'ENG-161' },
  { type: 'report.ingested', run: 'R-216', file: 'reports/R-216.md', report: {
    outcome: 'done', summary: 'Child HOME did not protect in-process createEntry; isolated the parent fixture fleet.',
    learnings: ['acceptance/supervisor.mjs calls createEntry in its own process.'] } },
  { type: 'note.added', id: 'ENG-161', decision: true, text: annotate('Confirmed fleet isolation mistake.', {
    confirmed_mistake: true, premise: 'Changing child HOME isolates an in-process entry caller.',
    failure_evidence: ['event:6', 'R-216'], correction: 'Set HERDR_MONITOR_FLEET in the calling process.',
    scope: 'test fixtures using in-process entry', evidence: ['ENG-161'],
  }) },
  { type: 'item.added', id: 'ENG-1040', title: 'Record lookup', role: 'engineer' },
  { type: 'note.added', id: 'ENG-1040', text: 'Consider cross-record shards for project memory.' },
  { type: 'note.added', id: 'ENG-1040', decision: true, text: annotate('Per-record lookup only. The prior suggestion is withdrawn.', {
    supersedes: ['event:9'], evidence: ['ENG-1040'], scope: 'lookup ownership',
  }) },
]);

test('fresh CLI retrieves planted real decision and confirmed mistake and follows original evidence', t => {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.dir, 'events.jsonl'), planted().map(e => JSON.stringify(e) + '\n').join(''));
  fs.mkdirSync(path.join(f.dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'reports/R-216.md'), 'Original planted evidence: child HOME did not protect createEntry.');
  const decision = f.json(['lookup', 'automatic blocked-work', '--kind', 'decision', '--json']);
  assert.equal(decision.results[0].ref, 'event:3/decisions/0');
  assert.equal(decision.results[0].source.file, 'reports/R-1258.md');
  assert.match(decision.results[0].context.why, /Churn/);
  const mistake = f.json(['lookup', 'fleet isolation', '--kind', 'mistake', '--json']);
  assert.equal(mistake.results.length, 1);
  assert.equal(mistake.results[0].premise, 'Changing child HOME isolates an in-process entry caller.');
  assert.equal(mistake.results[0].failure_evidence[0].status, 'present');
  assert.match(f.ok(['show', 'R-216']), /Original planted evidence: child HOME did not protect createEntry/);
  assert.equal(f.json(['lookup', 'unattributed', '--kind', 'mistake', '--json']).total, 0);
  assert.equal(f.json(['lookup', 'unattributed', '--kind', 'challenge', '--json']).total, 1);
  assert.equal(f.json(['lookup', 'shards', '--json']).results[0].ref, 'event:10');
  assert.doesNotMatch(f.ok(['lookup', 'shards']), /Consider cross-record shards/);
  assert.match(f.fail(['lookup', 'fleet', '--at', '-1']), /nonnegative/);
  assert.match(f.fail(['lookup', 'fleet', '--limit', '101']), /1\.\.100/);
  assert.equal(f.events().length, 10, 'lookup appends no source events');
});

test('rebuild at a fixed cutoff preserves references and hash after later correction', () => {
  const events = planted();
  const first = buildLookup(events, { at: 9 });
  assert.deepEqual(first, buildLookup(events.slice(0, 9)));
  assert.deepEqual(first, buildLookup([...events, { seq: 11, type: 'unknown.future', at: 'later' }], { at: 9 }));
  assert.equal(searchLookup(first, { query: 'shards' }).results[0].ref, 'event:9');
  const current = searchLookup(buildLookup(events), { query: 'shards' });
  assert.deepEqual(current.results[0].matched_sources, ['event:9']);
  assert.equal(current.results[0].state, 'current');
  assert.equal(searchLookup(buildLookup(events), { query: 'shards', allStates: true }).results[0].ref, 'event:9');
  assert.throws(() => buildLookup(events, { at: 11 }), /not present/);
});

test('missing failure evidence, ordinary reds and malformed confirmations never become mistakes', () => {
  const events = stamp([
    { type: 'item.added', id: 'ENG-1', title: 'Proof' },
    { type: 'note.added', id: 'ENG-1', decision: true, text: annotate('A red check is an observation.', {
      confirmed_mistake: true, premise: 'Hypothesis', correction: 'Candidate', scope: 'fixture',
      failure_evidence: ['event:999', 'R-404', 'file:/other-record/evidence.md'],
    }) },
    { type: 'note.added', id: 'ENG-1', decision: true, text: 'Malformed\n[lookup] null' },
    { type: 'report.ingested', run: 'R-404', report: { extra: { challenges: [{ text: 'Incomplete', lookup: { confirmed_mistake: true } }] } } },
  ]);
  const index = buildLookup(events);
  assert.equal(searchLookup(index, { query: 'red', kind: 'mistake' }).total, 0);
  const row = searchLookup(index, { query: 'red' }).results[0];
  assert.deepEqual(row.failure_evidence.map(r => r.status), ['missing', 'missing', 'external-unverified']);
  assert.match(row.diagnostics.join(' '), /confirmation incomplete/);
  assert.match(searchLookup(index, { query: 'Malformed' }).results[0].diagnostics.join(), /invalid/);
  assert.equal(searchLookup(index, { query: 'Incomplete', kind: 'mistake' }).total, 0);
});

test('native lesson supersession chains, retirement and absent replacement remain explicit', () => {
  const events = stamp([
    ...['L-1', 'L-2', 'L-3', 'L-4'].map(id => ({ type: 'lesson.proposed', id, text: `fleet ${id}`, evidence: [{ kind: 'event', seq: 1 }] })),
    { type: 'lesson.activated', id: 'L-1' }, { type: 'lesson.activated', id: 'L-2' },
    { type: 'lesson.activated', id: 'L-3' }, { type: 'lesson.activated', id: 'L-4' },
    { type: 'lesson.superseded', id: 'L-1', by_lesson: 'L-2', reason: 'First correction' },
    { type: 'lesson.superseded', id: 'L-2', by_lesson: 'L-3', reason: 'Second correction' },
    { type: 'lesson.retired', id: 'L-3', reason: 'No longer applicable' },
    { type: 'lesson.superseded', id: 'L-4', by_lesson: 'L-99', reason: 'Broken imported reference' },
  ]);
  const index = buildLookup(events), result = searchLookup(index, { query: 'fleet' });
  assert.equal(result.total, 0);
  assert.deepEqual(result.unresolved, [{ ref: 'L-4', missing_replacement: 'L-99' }]);
  const history = searchLookup(index, { query: 'fleet', allStates: true });
  assert.equal(history.total, 4);
  assert.equal(history.results.find(r => r.ref === 'L-3').retirement.reason, 'No longer applicable');
});

test('lookup filters and multi-step explicit report correction retain source scope and missing links', () => {
  const events = planted();
  events.push({ seq: 11, type: 'report.ingested', run: 'R-216', report: { extra: { decisions: [{ text: 'Replacement fleet rule', lookup: {
    supersedes: ['event:7', 'event:999', 'event:11/decisions/0'], evidence: ['R-216'], scope: 'test only',
  } }] } } });
  const index = buildLookup(events);
  const result = searchLookup(index, { query: 'isolation', item: 'ENG-161', limit: 1 });
  assert.equal(result.results[0].ref, 'event:11/decisions/0');
  assert.equal(result.results[0].supersedes[1].status, 'missing-or-not-earlier');
  assert.equal(result.results[0].supersedes[2].status, 'missing-or-not-earlier');
  assert.equal(searchLookup(index, { query: 'fleet', item: 'ENG-936' }).total, 0);
  assert.throws(() => searchLookup(index, { query: 'fleet', kind: 'guess' }), /--kind/);
  assert.throws(() => searchLookup(index, { query: '' }), /nonempty/);
});
