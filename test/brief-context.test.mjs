import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { fold } from '../lib/state.mjs';
import { renderBrief } from '../lib/render.mjs';
import { briefContext, contextDecision } from '../lib/brief-context.mjs';
import { createWorkerBrief } from '../lib/worker-brief.mjs';
import { DEFAULT_CONFIG } from '../lib/store.mjs';

// Planted cold-start case based on ENG-935/R-1257's actual intent/method tension:
// exclusive-writer reuse is the intended policy; existing dispatch still allocates
// lanes, and the closeout proof's hold cannot be lifted by interpreting that intent.
function example({ title = 'Improve dispatch/dispatch.mjs using ENG-935', noise = 0 } = {}) {
  const events = [
    { type: 'item.added', id: 'G-3', kind: 'goal', title: 'Herdr platform', why: 'A standalone product any project can adopt' },
    { type: 'item.added', id: 'ARCH-1', parent: 'G-3', title: 'Fresh ownership', why: 'Carry purpose through a fresh session' },
    { type: 'note.added', id: 'ARCH-1', decision: true, text: 'Native identity remains a hard boundary.' },
    ...Array.from({ length: 12 }, (_, n) => ({ type: 'note.added', id: 'ARCH-1', text: `Routine status ${n}` })),
    { type: 'item.added', id: 'ENG-935', role: 'engineer', parent: 'ARCH-1', title: 'Shared procedures in dispatch/dispatch.mjs' },
    { type: 'note.added', id: 'ENG-935', decision: true, text: 'A sole writer may reuse an exclusive checkout where guards support it. The running closeout proof holds lifecycle allocation changes; keep the current lane binding.' },
    { type: 'item.added', id: 'ENG-1', role: 'engineer', parent: 'ARCH-1', title, why: 'Give a fresh owner the intended outcome', accept: ['Preserve current dispatch identity.'] },
    { type: 'item.acceptance-amended', id: 'ENG-1', accept: ['Keep the held allocation unchanged.'], why: 'Respect the active proof' },
    { type: 'item.added', id: 'HUM-1', kind: 'question', parent: 'ENG-1', title: 'May the reserved effect proceed?', meta: { operator_reserved: true } },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', report_path: '/record/report.md' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'blocked', summary: 'Held pending authority', blockers: ['Proof hold'], learnings: [], artifacts: [], decisions: [], questions: [{ id: 'HUM-1', question: 'May the reserved effect proceed?' }] } },
    { type: 'run.started', id: 'R-2', item: 'ENG-1', report_path: '/record/report.md' },
    { type: 'lesson.proposed', id: 'L-1', text: 'Old claim: bypass the lane to save folders', scope: 'project', paths: ['unmentioned'], modules: [], evidence: [{ kind: 'item', id: 'ENG-935' }] },
    { type: 'lesson.activated', id: 'L-1' },
    { type: 'lesson.proposed', id: 'L-2', text: 'Keep the existing guarded lane while the proof holds allocation changes.', scope: 'project', paths: ['unmentioned'], modules: [], evidence: [{ kind: 'item', id: 'ENG-935' }] },
    { type: 'lesson.activated', id: 'L-2' },
    { type: 'lesson.superseded', id: 'L-1', by_lesson: 'L-2', reason: 'Preserve native source and proof ownership' },
    ...Array.from({ length: noise }, (_, n) => ({ type: 'item.added', id: `ENG-${2000 + n}`, role: 'engineer', title: `Unrelated organization ${n}`, why: 'Unrelated '.repeat(50) })),
  ].map((e, n) => ({ seq: n + 1, at: '2026-10-30T12:00:00Z', by: 'fixture-owner', ...e }));
  const s = fold(events), item = s.items.get('ENG-1');
  const contract = createWorkerBrief({ item, ask: '/external/assignment.md', askText: 'Read dispatch/dispatch.mjs', project: '/project', org: '/record', lane: 'topic', route: 'engineer', harness: 'codex', reviewRoute: 'review', exception: { to: 'supervisor', source: 'project promote.to' } });
  contract.workspace = '/project/lane';
  const run = s.runs.get('R-2');
  Object.assign(run, { workspace: contract.workspace, meta: { lane: 'topic', route: 'engineer', harness: 'codex', worker_brief: JSON.stringify(contract) } });
  return { s, events, render: () => renderBrief(s, 'R-2', { config: DEFAULT_CONFIG, cli: 'record' }) };
}

test('cold start finds original purpose, old ancestor decision, sibling decision and current mistake with exact sources', t => {
  const f = example(), text = f.render();
  assert.match(text, /Project purpose.*record show G-3.*standalone product/);
  assert.match(text, /Original rationale.*Give a fresh owner/);
  assert.match(text, /Acceptance was amended; original wording/);
  assert.match(text, /Ancestor decision pointers[\s\S]*Native identity remains a hard boundary.*event:3, by fixture-owner/);
  assert.match(text, /Related context pointers[\s\S]*ENG-935.*explicit ENG-935/);
  assert.match(text, /Decision excerpt: A sole writer may reuse.*proof holds lifecycle/);
  assert.match(text, /^L-2 .*Keep the existing guarded lane/m);
  assert.match(text, /Evidence: ENG-935/);
  assert.doesNotMatch(text, /Old claim: bypass/);
  assert.match(text, /External ask: \/external\/assignment.md/);
  assert.match(text, /intent and related excerpts grant no new authority/);
  assert.match(text, /Prior question obligations[\s\S]*record show HUM-1.*record show R-1.*unresolved/);
  t.diagnostic(JSON.stringify({ example: 'planted ENG-935 allocation tension', brief_bytes: Buffer.byteLength(text), context_bytes: Buffer.byteLength(text.split('## Intent and authority\n')[1].split('\n## Lessons')[0]), retrieved: ['G-3 purpose', 'ARCH-1 decision event:3', 'ENG-935 decision', 'L-2 evidence ENG-935'], superseded_rejected: 'L-1', utility: '4/4 planted facts, exact source links; method remains held' }));
});

test('source and module selectors find siblings without an exact ID and respect literal boundaries', () => {
  const f = example({ title: 'Improve dispatch/dispatch.mjs' });
  assert.equal(briefContext(f.s, 'ENG-1').related[0].reason, 'shared selector dispatch/dispatch.mjs');
  f.s.items.get('ENG-1').title = 'Improve dispatch/dispatch.mjsx and library';
  assert.equal(briefContext(f.s, 'ENG-1').related.length, 0);
  f.s.lessons.get('L-2').modules = ['allocation'];
  f.s.items.get('ENG-1').title = 'Improve allocation.';
  f.s.items.get('ENG-935').notes.push({ text: 'module allocation', seq: 100 });
  assert.equal(briefContext(f.s, 'ENG-1').related[0].reason, 'shared selector allocation');
});

test('bounded pointers do not grow with unrelated organization and report measured prompt size', t => {
  const small = example(), large = example({ noise: 300 }), text = large.render();
  assert.equal(text, small.render());
  assert.doesNotMatch(text, /Unrelated organization/);
  t.diagnostic(JSON.stringify({ example: '300 unrelated records', brief_bytes: Buffer.byteLength(text), record_json_bytes: Buffer.byteLength(JSON.stringify(large.events)), unrelated_records_in_prompt: 0, utility: 'same four planted facts; no savings extrapolation' }));
});

test('exact references precede selectors, cap four pointers and make absent references explicit without other-record reads', () => {
  const f = example();
  f.s.items.get('ENG-1').notes.push({ text: 'ENG-8 ENG-7 ENG-6 ENG-5 ENG-4 ENG-9999 R-99' });
  for (const n of [4, 5, 6, 7, 8]) f.s.items.set(`ENG-${n}`, { ...f.s.items.get('ENG-935'), id: `ENG-${n}`, parent: null });
  const result = briefContext(f.s, 'ENG-1');
  assert.deepEqual(result.related.map(row => row.item.id), ['ENG-4', 'ENG-5', 'ENG-6', 'ENG-7']);
  assert.equal(result.omitted, 2);
  assert.deepEqual(result.missing, ['ENG-9999', 'R-99']);
  assert.match(f.render(), /Unresolved references: ENG-9999, R-99 are absent from this record/);
});

test('decision provenance follows the latest recorded source; challenges never become confirmed mistakes', () => {
  const f = example(), sibling = f.s.items.get('ENG-935');
  f.s.runs.set('R-20', { id: 'R-20', item: sibling.id, report: { seq: 100, by: 'report-owner', decisions: [{ text: 'Use guarded source only', why: 'Identity' }], challenges: [{ text: 'An unconfirmed suspicion' }] } });
  sibling.runs.push('R-20');
  assert.deepEqual(contextDecision(f.s, sibling), { text: 'Use guarded source only', source: 'R-20', seq: 100, by: 'report-owner' });
  assert.match(f.render(), /record show R-20.*, event:100, by report-owner/);
  assert.doesNotMatch(f.render(), /unconfirmed suspicion/);
  sibling.notes.push({ decision: true, text: 'Newer correction', seq: 101, by: 'correction-owner' });
  assert.equal(contextDecision(f.s, sibling).text, 'Newer correction');
});
