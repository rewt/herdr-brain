import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fold, itemStatus } from '../lib/state.mjs';
import { fold as oldFold } from './fixtures/state-v0.mjs';
import { transact, loadEvents } from '../lib/store.mjs';
import { proposalIntakeEvents, proposalKey, proposalToken, proposalDisposition, proposalMetrics } from '../lib/proposal-intake.mjs';
import { queueSelected } from '../line-service/priority-order.mjs';
import { dispatchInput, reviewResultEvents } from '../line-service/phase1.mjs';
import { setupOrg } from './helpers.mjs';

const stamp = events => events.map((e, i) => ({ at:'2026-10-28T18:00:00Z', by:'fixture', ...e, seq:i + 1 }));
const seed = () => stamp([{ type:'item.added', id:'ENG-1', role:'engineer', title:'Source' },
  { type:'run.started', id:'R-1', item:'ENG-1' }]);
const proposal = (title, extra = {}) => ({ role:'engineer', title, why:'Retain evidence', accept:['Preserve native guards'], ...extra });
const report = proposals => ({ run:'R-1', outcome:'done', summary:'Finished source', proposals, extra:{} });
const intake = (events, data, options = {}) => { const state = fold(events); return proposalIntakeEvents({ state, events,
  run:state.runs.get('R-1'), report:data, sha256:'a'.repeat(64), ...options }); };
const items = events => events.filter(e => e.type === 'item.added');
const authority = { native_caller:{ name:'fixture-supervisor', terminal_id:'native' }, project:'/fixture/.git' };
function fixture(t) { const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive:true, force:true })); return f; }
function disposition(events, id, options = {}) { const state = fold(events); return proposalDisposition({ state, events, id,
  expect:proposalToken(state, id), cut:'selection', why:'Explicit bounded selection cut', authority, ...options }); }

test('proposal intake records notes, ignores dispatch_after and producer selection, and admits only a separate selection', () => {
  const events = seed(), data = report([proposal('Future work', { extra:{ dispatch_after:'past', queue_selected:true } })]);
  const add = intake(events, data), id = items(add)[0].id, committed = stamp([...events, ...add]), state = fold(committed);
  assert.equal(itemStatus(state, id), 'proposed'); assert.equal(queueSelected(state.items.get(id)), false);
  assert.equal(dispatchInput({ events:committed, state, item:state.items.get(id) }), null);
  assert.equal(queueSelected(oldFold(committed).items.get(id)), false, 'old installed selection honors the conservative metadata');
  const selected = stamp([...committed, { type:'item.updated', id, fields:{ meta:{ queue_selected:true } } }]), next = fold(selected);
  assert.equal(itemStatus(next, id), 'ready'); assert.equal(queueSelected(next.items.get(id)), true);
  assert.ok(dispatchInput({ events:selected, state:next, item:next.items.get(id) }));
  assert.deepEqual(data.proposals[0].extra, { dispatch_after:'past', queue_selected:true });
});

test('proposal intake groups four ordinary follow-ups and retains every payload, evidence and finding identity', () => {
  const proposals = Array.from({ length:5 }, (_, i) => proposal(`Follow-up ${i}`, { extra:{ evidence:`evidence-${i}`, finding_id:`finding-${i}` } }));
  proposals.splice(2, 0, proposal('Dependency obligation', { blocking:true }));
  proposals.push(proposal('Major obligation', { extra:{ severity:'major', review_findings:['typed finding'] } }));
  const events = seed(), data = report(proposals), before = JSON.stringify(data), add = intake(events, data);
  assert.equal(items(add).length, 3);
  const reshape = items(add).find(e => e.role === 'architect');
  assert.deepEqual(reshape.meta.proposal_sources.map(s => s.index), [0, 1, 3, 4, 5]);
  for (const source of reshape.meta.proposal_sources) assert.deepEqual(source.proposal, proposals[source.index]);
  assert.equal(add.filter(e => e.type === 'proposal.recorded').length, 7);
  assert.equal(add.filter(e => e.type === 'link.added').length, 1);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(intake(stamp([...events, ...add]), data, { indices:[4] }), [], 'refiling a group member reuses its reshape note');
  const isolated = intake(events, data, { indices:[4] });
  assert.equal(items(isolated).length, 1); assert.equal(items(isolated)[0].meta.proposal_sources.length, 5);
});

test('proposal source reuse survives renamed, active, UNKNOWN and closed owners and refuses conflicting bindings', () => {
  const data = report([proposal('Original')]), events = seed(), first = intake(events, data), id = items(first)[0].id;
  for (const extra of [[], [{ type:'item.closed', id, as:'dropped' }], [{ type:'run.started', id:'R-2', item:id, meta:{ dispatch_attempt:'UNKNOWN' } }]]) {
    const committed = stamp([...events, ...first, { type:'item.updated', id, fields:{ title:'Renamed', parent:null } }, ...extra]);
    const before = JSON.stringify(committed); assert.deepEqual(intake(committed, data), []); assert.equal(JSON.stringify(committed), before);
  }
  assert.throws(() => intake(stamp([...events, ...first, { ...items(first)[0], id:'ENG-99' }]), data), /conflicting owners/);
  const changed = structuredClone(data); changed.proposals[0].title = 'Changed immutable source';
  assert.throws(() => intake(stamp([...events, ...first]), changed), /changed or UNKNOWN/);
  assert.equal(items(intake(seed(), report([proposal('Original'), proposal('Original')]))).length, 2, 'equal titles are separate source indices');
});

test('legacy proposal recovery uses complete immutable creation while preserving saved selected work and attempts', () => {
  const data = report([proposal('Legacy')]), p = data.proposals[0];
  const events = stamp([...seed(), { type:'item.added', id:'ENG-2', title:p.title, role:p.role, accept:p.accept, why:p.why,
    parent:'ENG-1', from_run:'R-1', meta:{} }, { type:'item.updated', id:'ENG-2', fields:{ title:'Renamed', meta:{ queue_selected:true } } },
  { type:'run.started', id:'R-2', item:'ENG-2', meta:{ dispatch_attempt:'UNKNOWN' } }]);
  const before = fold(events), add = intake(events, data);
  assert.equal(items(add).length, 0); assert.equal(add[0].item, 'ENG-2');
  assert.deepEqual(fold([...events, ...add]).items.get('ENG-2'), before.items.get('ENG-2'));
  assert.equal(queueSelected(before.items.get('ENG-2')), true);
  const different = structuredClone(events); different[2].why = 'Different immutable proposal';
  assert.equal(items(intake(different, data)).length, 1, 'source run and title alone never prove reuse');
});

test('proposal allocation is recomputed under commit after concurrent filing and a lost acknowledgement', t => {
  const f = fixture(t), data = report([proposal('Race')]);
  transact(f.dir, () => ({ add:seed().map(({ seq, at, by, ...e }) => e) }));
  let prepared;
  const result = transact(f.dir, events => ({ add:intake(events, data) }), { subjects:['R-1'], prepare:(_state, events) => {
    prepared = intake(events, data); transact(f.dir, current => ({ add:intake(current, data) }));
  } });
  assert.equal(items(prepared).length, 1); assert.equal(items(result.added).length, 0);
  assert.deepEqual(intake(loadEvents(f.dir).events, data), []);
  assert.equal(f.events().filter(e => e.type === 'proposal.recorded').length, 1);
});

test('record ingest and supervisor re-filing reuse one note and require a separate selection before start', t => {
  const f = fixture(t); f.ok(['add', 'Source', '--role', 'engineer']); f.ok(['start', 'ENG-1']);
  const data = report([proposal('Intake note')]), bytes = `---\n${JSON.stringify(data)}\n---\nImmutable evidence.\n`, file = path.join(f.root, 'report.md');
  fs.writeFileSync(file, bytes); f.ok(['ingest', file]);
  const state = fold(f.events()), note = [...state.items.values()].find(i => i.created.run === 'R-1');
  assert.equal(f.json(['show', note.id, '--json']).status, 'proposed');
  assert.match(f.fail(['start', note.id]), /select the proposal separately/);
  const count = f.events().length;
  assert.equal(f.json(['proposals', 'file', 'R-1', '--index', '0']).reused, true); assert.equal(f.events().length, count);
  assert.match(f.fail(['close', note.id, '--dropped']), /owning proposal disposition/);
  assert.match(f.fail(['proposals', 'lapse', note.id, '--cut', 'selection', '--expect', proposalToken(state, note.id), '--why', 'Explicit cut']), /native caller|owning record/);
  f.ok(['set', note.id, 'meta.queue_selected=true']); f.ok(['start', note.id]);
  assert.equal(fs.readFileSync(path.join(f.dir, 'reports/R-1.md'), 'utf8'), bytes);
});

test('formal correction and Major keys retain original cardinality while unrelated ordinary proposals group', () => {
  const target = { base:'a'.repeat(40), head:'b'.repeat(40), scope:{ commits:['b'.repeat(40)] } };
  const events = stamp([{ type:'item.added', id:'REV-1', role:'reviewer', title:'Captured review', meta:{ review_key:`ENG-1:${target.head}`,
    review_target:target, review_source_item:'ENG-1', review_source_run:'R-0', review_round_cap:1 } }, { type:'run.started', id:'R-1', item:'REV-1' }]);
  const data = report([proposal('Repair all findings'), ...Array.from({ length:4 }, (_, i) => ({ role:'writer', title:`Document ${i}` }))]);
  data.extra.verdict = 'FAIL'; const state = fold(events), run = state.runs.get('R-1');
  const ordinary = proposalIntakeEvents({ state, events, run, report:data, sha256:'hash' });
  const facts = reviewResultEvents({ state, events, run, report:data, sha256:'hash', body:'- [Major] path:1 - Keep native guard\n- [Minor] path:2 - Restore detail',
    usedIds:items(ordinary).map(e => e.id) });
  assert.equal(items(ordinary).length, 1); assert.equal(items(facts).length, 1);
  assert.equal(facts.filter(e => e.type === 'review.finding-linked').length, 2);
  assert.equal(items(facts)[0].meta.review_round_cap, 1); assert.equal(items(facts)[0].meta.queue_selected, true);
  assert.equal(items(facts)[0].meta.proposal_intake, undefined);
});

test('lapse requires an explicit cut and native authority, stays visible and reverses through existing selection', () => {
  const events = seed(), data = report([proposal('Unselected')]), add = intake(events, data), id = items(add)[0].id;
  const committed = stamp([...events, ...add]);
  assert.throws(() => disposition(committed, id, { cut:undefined }), /explicit selection\/release cut/);
  assert.throws(() => disposition(committed, id, { authority:undefined }), /owning authority/);
  const mutation = disposition(committed, id), lapsed = stamp([...committed, ...mutation.add]), state = fold(lapsed);
  assert.equal(itemStatus(state, id), 'lapsed'); assert.equal(state.items.get(id).closed, null); assert.equal(queueSelected(state.items.get(id)), false);
  const selected = fold([...lapsed, { type:'item.updated', id, fields:{ meta:{ queue_selected:true } } }]);
  assert.equal(itemStatus(selected, id), 'ready'); assert.equal(selected.items.get(id).meta.proposal_sources.length, 1);
});

test('lapse retains active, committed, saved UNKNOWN, selected, reserved and dependency-bearing proposals', () => {
  const events = seed(), add = intake(events, report([proposal('Protected')])), id = items(add)[0].id;
  const base = [...events, ...add, { type:'item.added', id:'ENG-99', role:'engineer', title:'Independent' }];
  const cases = [
    { type:'run.started', id:'R-2', item:id }, { type:'change.landed', item:id, head:'committed' },
    { type:'item.updated', id, fields:{ meta:{ unknown_attempt:'saved' } } },
    { type:'item.updated', id, fields:{ meta:{ committed:true } } },
    { type:'item.updated', id, fields:{ meta:{ queue_selected:true } } },
    { type:'item.updated', id, fields:{ meta:{ operator_reserved:true } } },
    { type:'link.added', blocker:id, blocked:'ENG-99' }, { type:'link.added', blocker:'ENG-99', blocked:id },
  ];
  for (const extra of cases) assert.throws(() => disposition(stamp([...base, extra]), id), /retained|unselected dependency-free/);
  assert.throws(() => disposition(stamp(base), id, { attempted:[id] }), /retained/);
  const original = fold(stamp(base)), changed = stamp([...base, cases.at(-1)]);
  assert.throws(() => disposition(changed, id, { expect:proposalToken(original, id) }), /dependencies changed/);
});

test('typed duplicate adds replacement blockers before removing originals and never transiently releases dependents', () => {
  const events = seed(), add = intake(events, report([proposal('Duplicate')])), id = items(add)[0].id, key = proposalKey('R-1', 0);
  const committed = stamp([...events, ...add, { ...items(add)[0], id:'ENG-99', meta:{ ...items(add)[0].meta, proposal_sources:[...items(add)[0].meta.proposal_sources] } },
    { type:'item.added', id:'ENG-98', title:'Dependent', role:'engineer' }, { type:'item.added', id:'ENG-97', title:'Prerequisite', role:'engineer' },
    { type:'link.added', blocker:id, blocked:'ENG-98' }, { type:'link.added', blocker:'ENG-97', blocked:id }]);
  const state = fold(committed), args = { successor:'ENG-99', successorExpect:proposalToken(state, 'ENG-99'), key };
  const mutation = disposition(committed, id, args);
  for (let i = 1; i <= mutation.add.length; i++) assert.equal(itemStatus(fold(stamp([...committed, ...mutation.add.slice(0, i)])), 'ENG-98'), 'blocked');
  const after = fold([...committed, ...mutation.add]); assert.equal(after.items.get(id).closed.as, 'dropped');
  assert.ok(after.links.some(l => l.blocker === 'ENG-99' && l.blocked === 'ENG-98'));
  assert.ok(after.links.some(l => l.blocker === 'ENG-97' && l.blocked === 'ENG-99'));
  assert.throws(() => disposition(committed, id, { ...args, key:'similar title' }), /shared typed/);
  assert.throws(() => disposition(committed, id, { ...args, successorExpect:'stale' }), /successor changed/);
});

test('proposal metrics report dated filing denominators and observed ever-run shares', () => {
  const events = seed(), add = intake(events, report([proposal('New note')])), metrics = proposalMetrics(stamp([...events, ...add]));
  assert.deepEqual(metrics.days[0], { date:'2026-10-28', filed:2, ever_run:1, report_filed:1, report_ever_run:0, ever_run_share:0.5, report_ever_run_share:0 });
});
