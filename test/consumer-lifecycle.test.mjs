import test from 'node:test';
import assert from 'node:assert/strict';
import {measureLifecycle, distribution} from '../measurement/lifecycle.mjs';

const project = '/fixture/brain/.git';
const at = second => `2026-10-30T12:00:${String(second).padStart(2, '0')}.000Z`;
function fixture() {
  return [
    {seq: 1, at: at(0), type: 'run.started', id: 'R-1', item: 'ENG-1', by: 'line-service', workspace: '/fixture/lane', meta: {dispatch_project: project}},
    {seq: 2, at: at(1), type: 'run.claimed', run: 'R-1'},
    {seq: 3, at: at(10), type: 'report.available', run: 'R-1', project, started_seq: 1, claim_generation: 2, producer: 'original-report-watcher', sha256: 'a', observed_at: at(10)},
    {seq: 4, at: at(12), type: 'report.ingested', run: 'R-1', sha256: 'a'},
    {seq: 5, at: at(14), type: 'item.closed', id: 'ENG-1', completed_run: 'R-1', as: 'done'},
    {seq: 6, at: at(15), type: 'closeout.effect', run: 'R-1', identity: project, key: 'k', source: {seq: 4, type: 'report.ingested'}, effect: 'session', outcome: {action: 'closed', tab_id: 'w1:t2'}},
    {seq: 7, at: at(17), type: 'closeout.effect', run: 'R-1', identity: project, key: 'k', source: {seq: 4, type: 'report.ingested'}, effect: 'folder', outcome: {action: 'worktree-removed'}},
    {seq: 8, at: at(18), type: 'closeout.evaluated', run: 'R-1', identity: project, key: 'k', source: {seq: 4, type: 'report.ingested'}, resources: {
      session: {status: 'closed', receipts: [{seq: 6, effect: 'session'}]}, folder: {status: 'removed', receipt: {seq: 7, effect: 'folder'}}}}
  ];
}
const measure = (events = fixture(), options = {}) => measureLifecycle({events, project, from: at(0), cutoff: at(59), handActors: ['supervisor'], ...options});

test('measures report observation to linked ingestion, item close and folder removal once', () => {
  const events = fixture(); events.push({...events[7], seq: 9, at: at(19)});
  const result = measure(events);
  assert.equal(result.counts.starts, 1);
  assert.deepEqual(result.counts.starts_by_initiator, {line: 1});
  assert.deepEqual(result.latency.report_to_ingest, {count: 1, known: 1, unknown: 0, median_ms: 2000, p90_ms: 2000});
  assert.equal(result.latency.report_to_closed.median_ms, 4000);
  assert.equal(result.latency.report_to_folder_removed.median_ms, 7000);
  assert.deepEqual(result.counts.lifecycle, {session: {retired: 1, pending: 0, unknown: 0}, tab: {retired: 1, pending: 0, unknown: 0}, folder: {retired: 1, pending: 0, unknown: 0}});
  assert.deepEqual(result.pending, []);
});

test('missing report and completion timestamps remain unknown rather than zero', () => {
  const events = fixture(); delete events[2].observed_at; delete events[6].at;
  const result = measure(events);
  for (const d of Object.values(result.latency)) {assert.equal(d.unknown, 1); assert.equal(d.median_ms, null);}
  assert.deepEqual(result.source.missing_timestamp_seqs, [7]);
  assert.equal(result.runs[0].resources.folder.state, 'retired');
  const complete = fixture(); delete complete[6].at;
  assert.equal(measure(complete).latency.report_to_folder_removed.unknown, 1);
});

test('censored completions and negative durations are unknown, genuine zero is measured', () => {
  const events = fixture(); events[3].at = at(9); events[4].at = at(10);
  assert.equal(measure(events).runs[0].latency.report_to_ingest.reason, 'completion precedes report observation');
  assert.equal(measure(events).latency.report_to_closed.median_ms, 0);
  const before = measure(fixture(), {cutoff: at(13)});
  assert.equal(before.latency.report_to_closed.unknown, 1);
  assert.equal(before.latency.report_to_folder_removed.unknown, 1);
});

test('wrong project, key, effect, source, generation or hash cannot prove completion', () => {
  for (const change of [e => e[6].identity = '/other/.git', e => e[6].key = 'other',
    e => e[6].effect = 'other', e => e[6].source.seq = 99, e => e[7].resources.folder.receipt.seq = 99]) {
    const events = fixture(); change(events);
    assert.equal(measure(events).latency.report_to_folder_removed.unknown, 1);
    assert.equal(measure(events).runs[0].resources.folder.state, 'unknown');
  }
  for (const change of [e => e[2].claim_generation = 99, e => e[2].sha256 = 'wrong']) {
    const events = fixture(); change(events); assert.equal(measure(events).latency.report_to_ingest.unknown, 1);
  }
});

test('item closure requires explicit run attribution and successful disposition', () => {
  for (const change of [e => delete e.completed_run, e => e.completed_run = 'R-2', e => e.as = 'wontdo']) {
    const events = fixture(); change(events[4]); assert.equal(measure(events).latency.report_to_closed.unknown, 1);
  }
});

test('fixed cutoff/sequence rerun ignores later appends and never mutates source', () => {
  const events = fixture(), before = structuredClone(events);
  const first = measure(events, {throughSeq: 8});
  events.push({seq: 9, at: '2026-10-31T00:00:00Z', type: 'run.started', id: 'R-2', meta: {dispatch_project: project}});
  assert.deepEqual(measure(events, {throughSeq: 8}), first);
  assert.deepEqual(events.slice(0, 8), before);
});

test('window includes carry-in reports and unreported starts with separate denominators', () => {
  const events = fixture(); events.push({seq: 9, at: at(25), type: 'run.started', id: 'R-2', item: 'ENG-2', by: 'supervisor', meta: {dispatch_project: project}});
  const result = measure(events, {from: at(5)});
  assert.equal(result.counts.starts, 1);
  assert.deepEqual(result.counts.starts_by_initiator, {hand: 1});
  assert.equal(result.counts.report_cohort, 1);
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[1].latency.report_to_ingest.ms, null);
});

test('saved absence is not retirement; explicit pending keeps owner and reason', () => {
  const events = fixture().slice(0, 5);
  events.push({seq: 6, at: at(20), type: 'closeout.evaluated', run: 'R-1', identity: project, key: 'k', source: {seq: 4, type: 'report.ingested'},
    resources: {folder: {status: 'kept', owner: 'fixer', reason: 'unsaved changes'}}});
  const census = {project, observed_at: at(21), cutoff: {seq: 6}, inventory: {coverage: {native: true, git: true}, agents: [], panes: [], worktrees: [], folders: [{cwd: '/fixture/lane', present: false}]}};
  const result = measure(events, {census});
  assert.equal(result.runs[0].observation.folder, 'absent');
  assert.equal(result.runs[0].resources.folder.state, 'pending');
  assert.equal(result.latency.report_to_folder_removed.median_ms, null);
  assert.deepEqual(result.pending_by_owner_reason.find(r => r.owner === 'fixer'), {state: 'pending', owner: 'fixer', reason: 'unsaved changes', count: 1});
  assert.throws(() => measure(events, {census: {...census, project: '/foreign'}}), /outside measurement scope/);
});

test('start attribution and hand nudges expose incomplete coverage', () => {
  const events = fixture(); events[0].by = 'unclassified-agent';
  events.push({seq: 9, at: at(25), type: 'closeout.manual-assistance', run: 'R-1'});
  const result = measure(events);
  assert.deepEqual(result.counts.starts_by_initiator, {unknown: 1});
  assert.equal(result.hand_nudges.recorded, 1); assert.equal(result.hand_nudges.total, null);
  assert.throws(() => measure(events, {handActors: ['line-service']}), /overlap/);
});

test('distribution uses conventional median and nearest rank p90; empty is unknown', () => {
  assert.deepEqual(distribution([1, 2, 3, 4, null]), {count: 5, known: 4, unknown: 1, median_ms: 2.5, p90_ms: 4});
  assert.deepEqual(distribution([]), {count: 0, known: 0, unknown: 0, median_ms: null, p90_ms: null});
  assert.throws(() => measure([], {from: '2026-10-30'}), /timezone/);
  assert.throws(() => measure(fixture().reverse()), /sequence/);
});

test('journal projection uses occurrence time, project/run scope and captured sequence without claiming completeness', () => {
  const events = fixture();
  const nudge = {seq: 9, at: at(40), type: 'lifecycle.manual-nudge', nudge_id: 'n1', run: 'R-1', item: 'ENG-1', project,
    actor: 'owner', by: 'owner', occurred_at: at(25), stage: 'report', action: 'Prompted', reason: 'Stalled', evidence: 'saved:prompt'};
  events.push(nudge, {...nudge, seq: 10, nudge_id: 'n2', project: '/other/.git'},
    {...nudge, seq: 11, nudge_id: 'n3', run: 'R-99'},
    {...nudge, seq: 12, nudge_id: 'n4', occurred_at: at(5)},
    {...nudge, seq: 13, nudge_id: 'n5', occurred_at: at(55)});
  const result = measure(events, {from: at(20), cutoff: at(50)});
  assert.equal(result.hand_nudges.recorded, 1); assert.equal(result.hand_nudges.total, null);
  assert.deepEqual(result.hand_nudges.journal.map(e => e.id), ['n1']);
  assert.equal(result.hand_nudges.journal[0].occurred_at, at(25));
  assert.equal(measure(events, {cutoff: at(30), throughSeq: 8}).hand_nudges.recorded, 0, 'not recorded by cutoff');
  assert.equal(measure(events, {throughSeq: 8}).hand_nudges.recorded, 0, 'later append excluded by fence');
});
