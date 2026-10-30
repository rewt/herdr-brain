import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fold, extendFold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-pre-session-bind.mjs';
import { initOrg, loadRecord, loadRecordReader, transact } from '../lib/store.mjs';
import { READER_FILE } from '../lib/record-reader.mjs';
import { SNAPSHOT_FILE } from '../lib/record-snapshot.mjs';
import { obligationInventory, obligationPending } from '../lib/obligations.mjs';

const project = '/project/.git', stamp = '2026-10-30T12:00:00.000Z';
const base = 'a'.repeat(40), head = 'b'.repeat(40), later = 'c'.repeat(40), hash = 'd'.repeat(64);
const start = [
  { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'producer' },
  { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/removed/producer', meta: {
    dispatch_project: project, dispatch_record: '/project/.org', dispatch_attempt: 'original', dispatch_journal: '/project/.org/dispatch/original.json',
  } },
  { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } },
];
const report = { type: 'report.ingested', run: 'R-1', item: 'ENG-1', sha256: hash, file: 'reports/R-1.md', report: { outcome: 'done', summary: 'source delivered' } };
const landing = { type: 'change.landed', project, run: 'R-1', item: 'ENG-1', head, base,
  source: { run: 'R-1', attempt: 'original', claim_generation: 3, repository: project },
  producer: { agent: 'original', session: 'session', ownership_generation: 3 },
};
const queue = { type: 'item.added', id: 'REV-1', role: 'reviewer', meta: {
  review_source_run: 'R-1', review_source_item: 'ENG-1', review_round_cap: 1,
  review_target: { head, base, reportHash: hash, source_group: { run: 'R-1', owned_commits: [head] } },
} };
const stampEvents = events => events.map((e, i) => ({ at: stamp, seq: i + 1, by: 'fixture', ...e }));
const rows = (s, kind) => [...s.obligations.values()].filter(r => r.kind === kind);
const add = (s, events) => extendFold(s, stampEvents(events).map((e, i) => ({ ...e, seq: s.eventCount + i + 1 })));

for (const order of [[report, landing], [landing, report], [landing, { ...queue, meta: { ...queue.meta, review_target: { ...queue.meta.review_target, evidence_kind: 'native-landings/v1' } } }, report]]) {
  test(`original review obligation survives ${order.map(e => e.type).join(' then ')}, duplicate facts and removed producer folder`, () => {
    const history = stampEvents([...start, ...order]), s = fold(history), first = rows(s, 'review-handoff')[0];
    const originalSource = structuredClone(first.source);
    add(s, [report, landing]);
    assert.equal(rows(s, 'review-handoff').length, 1);
    assert.equal(first.landings.length, 1); assert.equal(first.reports.length, 1);
    assert.deepEqual(first.source, originalSource);
    const originalQueue = order.find(e => e.type === 'item.added') ?? queue;
    add(s, [originalQueue, originalQueue]);
    assert.equal(first.queues.length, 1);
    assert.equal(first.outcome.consumer, 'queue-review');
    assert.equal(first.outcome.result.review_item, 'REV-1');
    assert.equal(obligationPending(first), false);
    assert.deepEqual(first.landings[0].binding, landing.source);
    assert.equal(s.runs.get('R-1').workspace, '/removed/producer');
    assert.deepEqual(olderFold(history).items.get('ENG-1').outcome, fold(history).items.get('ENG-1').outcome);
  });
}

test('a later landing or conflicting capture retains original outcome and exposes uncovered source', () => {
  const s = fold(stampEvents([...start, report, landing, queue])), r = rows(s, 'review-handoff')[0], outcome = structuredClone(r.outcome);
  add(s, [{ ...landing, head: later, base: head }, { ...report, sha256: 'other-original-report' }]);
  assert.equal(obligationPending(r), true); assert.deepEqual(r.uncovered_heads, [later]);
  assert.deepEqual(r.outcome, outcome); assert.equal(r.reports.length, 2);
  assert.equal(r.landings[0].head, head); assert.equal(r.queues[0].target.head, head);
  assert.match(r.diagnosis, /immutable/);
  add(s, [{ ...queue, id: 'REV-other', meta: { ...queue.meta, review_target: { ...queue.meta.review_target, head: later, reportHash: 'wrong' } } }]);
  assert.deepEqual(r.outcome, outcome); assert.deepEqual(r.uncovered_heads, [later]);
});

test('a report alone has no inferred landed target and no-source eligibility remains explicit', () => {
  const s = fold(stampEvents([...start, report]));
  const r = obligationInventory(s).rows.find(r => r.kind === 'review-handoff');
  assert.equal(r.pending, true); assert.equal(r.supported, false);
  assert.equal(r.has_source_prerequisite, false); assert.match(r.diagnosis, /eligibility unproven/);
  assert.equal(r.outcome, null);
});

test('availability and dispatch outcomes require original report, claim, journal and attempt', () => {
  const available = { type: 'report.available', run: 'R-1', item: 'ENG-1', project, sha256: hash, file: report.file, started_seq: 2, claim_generation: 3 };
  const s = fold(stampEvents([...start, available]));
  const intake = rows(s, 'report-intake')[0], dispatch = rows(s, 'dispatch-outcome')[0];
  add(s, [{ ...report, sha256: 'wrong' }, { type: 'dispatch.completed', run: 'R-1', item: 'ENG-1', project, attempt: 'replacement', journal: dispatch.journal, exit_code: 0 }]);
  assert.equal(intake.outcome, null); assert.equal(dispatch.outcome, null);
  add(s, [report, { type: 'dispatch.completed', run: 'R-1', item: 'ENG-1', project, attempt: dispatch.attempt, journal: dispatch.journal, exit_code: 1, stage: 'worker' }]);
  assert.equal(intake.outcome.result.sha256, hash); assert.equal(dispatch.outcome.result.exit_code, 1);
  const changed = fold(stampEvents([...start, available, { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } }, report]));
  assert.equal(rows(changed, 'report-intake')[0].outcome, null);
  const originalPath = '/removed/producer/report.md';
  const archived = fold(stampEvents([...start, { ...available, file: originalPath }, { ...report, source: originalPath }]));
  assert.equal(rows(archived, 'report-intake')[0].outcome.result.file, report.file);
});

test('closeout original source and resource outcomes remain separate from wait classification and counters', () => {
  const target = { common: project, run: 'R-1', key: 'original-key', cwd: '/removed/producer', head, panes: [{ pane: 'p', terminal: 't', session: 's' }] };
  const s = fold(stampEvents([...start, { ...report, closeout_targets: [target] }]));
  const request = rows(s, 'closeout')[0], source = { seq: request.source.seq, type: request.source.type };
  add(s, [{ type: 'closeout.evaluated', identity: project, key: target.key, source: { ...source, seq: 999 }, completed: true },
    { type: 'closeout.waiting', identity: project, key: target.key, source, run: 'R-1', wait_id: 'original-wait', waiting: { owner: 'R-1', defect: 'Original UNKNOWN has no completion writer', producers: [] } }]);
  const wait = rows(s, 'closeout-wait')[0];
  add(s, [{ type: 'closeout.wait-classified', identity: project, key: target.key, source, wait_id: wait.wait_id, wait_seq: wait.source.seq, disposition: 'continuation' }]);
  assert.equal(wait.supported, false); assert.equal(wait.outcome, null); assert.equal(request.outcome, null);
  add(s, [{ type: 'closeout.evaluated', identity: project, key: target.key, source, completed: true, resources: { session: { status: 'closed' } } }]);
  assert.equal(request.outcome.consumer, 'lane-closeout'); assert.equal(wait.outcome, null);
  assert.deepEqual(request.target.panes, target.panes);
});

test('worker-report wait validates the original completion reference and claim; other producer kinds stay diagnosed', () => {
  const producer = { kind: 'worker-report', run: 'R-1', claim: 3 };
  const wait = { type: 'closeout.waiting', identity: project, key: 'key', source: { seq: 1, type: 'cleanup.bound' }, revision: 3,
    wait_id: 'wait', waiting: { owner: 'worker-report', producers: [producer] } };
  const s = fold(stampEvents([...start, wait, report]));
  const row = rows(s, 'closeout-wait')[0], status = { type: 'closeout.producer-status', identity: project, key: 'key', source: wait.source, wait_id: 'wait', producer,
    status: 'complete', completion: { seq: 9999, type: 'report.ingested' } };
  add(s, [status]); assert.equal(row.outcome, null);
  add(s, [{ ...status, completion: { seq: 5, type: 'report.ingested' } }]); assert.ok(row.outcome);
  const changed = fold(stampEvents([...start, wait, { type: 'run.claimed', run: 'R-1', owner: {} }, report,
    { ...status, completion: { seq: 6, type: 'report.ingested' } }]));
  assert.equal(rows(changed, 'closeout-wait')[0].outcome, null);
  add(s, [{ ...wait, wait_id: 'native', waiting: { owner: 'original-run', producers: [{ kind: 'native-command', intent: 'UNKNOWN' }] } }]);
  assert.equal(rows(s, 'closeout-wait')[1].supported, false);
  assert.match(rows(s, 'closeout-wait')[1].diagnosis, /closeoutWaitState/);
});

test('UNKNOWN native attempts survive unrelated results and preserve exact refusals without replacement', () => {
  const scope = { identity: project, key: 'key', run: 'R-1', source: { seq: 4, type: 'report.ingested' } };
  const intent = { type: 'closeout.effect', ...scope, effect: 'original-intent', outcome: { action: 'agent-exit-requested', pane: 'pane', occupant: ['worker', 'codex', 'pane', 'workspace', '/removed/producer', 'terminal', 'session'] } };
  const s = fold(stampEvents([...start, report, intent])), row = rows(s, 'native-outcome')[0];
  const result = { type: 'closeout.effect', ...scope, intent: 'original-intent', effect: 'receipt', outcome: { action: 'exit-observed', pane: 'pane', occupant: { terminal_id: 'terminal', agent_session_id: 'session' } } };
  add(s, [{ ...result, intent: 'replacement-intent' }, { ...result, outcome: { ...result.outcome, pane: 'other' } },
    { type: 'closeout.command-failed', ...scope, intent: 'original-intent', failure: { kind: 'unknown', code: 'OUTCOME_UNKNOWN' } }]);
  assert.equal(row.outcome, null); assert.equal(row.attempt, 'original-intent');
  assert.equal(row.result_observation.failure.code, 'OUTCOME_UNKNOWN');
  add(s, [{ type: 'closeout.command-failed', ...scope, intent: 'original-intent', failure: { kind: 'fence', code: 'EACCES' } }]);
  assert.equal(row.outcome.result.state, 'refused'); const refusal = structuredClone(row.outcome);
  add(s, [result]); assert.deepEqual(row.outcome, refusal); assert.equal(rows(s, 'native-outcome').length, 1);
  assert.deepEqual(row.original, intent.outcome);
});

test('binding errors and unknown pending types have visible original source and stuck owner', () => {
  const s = fold(stampEvents([...start, { ...report, closeout_binding_errors: [{ run: 'R-1', owner: 'R-1', code: 'BINDING_UNAVAILABLE', reason: 'Original session missing' }] },
    { type: 'future.waiting', run: 'R-1', pending: true, attempt: 'UNKNOWN-original' }]));
  const inventory = obligationInventory(s, { now: Date.parse(stamp) + 1234, position: { lastSeq: 99999 } });
  assert.equal(inventory.counts['closeout-binding'].unsupported, 1); assert.equal(inventory.counts.unsupported.unsupported, 1);
  const unknown = inventory.rows.find(r => r.kind === 'unsupported');
  assert.equal(unknown.original.attempt, 'UNKNOWN-original'); assert.equal(unknown.outcome, null);
  assert.equal(unknown.age_ms, 1234); assert.equal(unknown.event_to_observation_upper_bound_ms, 1234);
  assert.equal(unknown.event_to_outcome_ms, null); assert.match(inventory.limits, /unmeasured/);
});

test('projection crashes at source, cache publication, result and checkpoint boundaries recover identical obligations from log', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obligation-recovery-')));
  const savedFleet = process.env.HERDR_MONITOR_FLEET; process.env.HERDR_MONITOR_FLEET = path.join(dir, 'no-fleet.json');
  t.after(() => { if (savedFleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = savedFleet; fs.rmSync(dir, { recursive: true, force: true }); });
  initOrg(dir);
  const log = path.join(dir, 'events.jsonl'), append = events => transact(dir, () => ({ add: events }), { actor: 'fixture', strictTail: true }).added;
  append([...start, report, landing]);
  const immutable = fs.readFileSync(log), expected = loadRecord(dir, { snapshot: false }).state.obligations;
  const first = loadRecordReader(dir); assert.deepEqual(new Map(first.state.obligations), expected); const position = first.position; first.close();
  for (const cache of [READER_FILE, SNAPSHOT_FILE]) fs.writeFileSync(path.join(dir, cache), 'interrupted cache write');
  const recovered = loadRecordReader(dir);
  assert.deepEqual(new Map(recovered.state.obligations), expected); assert.equal(recovered.position.lastSeq, position.lastSeq); recovered.close();
  const outcome = append([queue]);
  assert.deepEqual(fs.readFileSync(log).subarray(0, immutable.length), immutable);
  const after = loadRecordReader(dir); const original = rows(after.state, 'review-handoff')[0];
  assert.equal(original.outcome.seq, outcome[0].seq); assert.equal(obligationPending(original), false); after.close();
  fs.unlinkSync(path.join(dir, READER_FILE)); fs.unlinkSync(path.join(dir, SNAPSHOT_FILE));
  const restart = loadRecordReader(dir); assert.deepEqual(new Map(restart.state.obligations), loadRecord(dir, { snapshot: false }).state.obligations); restart.close();
  const result = spawnSync(process.execPath, [new URL('../bin/org.mjs', import.meta.url).pathname, 'obligations', '--json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ORG_DIR: dir, HERDR_BRAIN_ROOT: new URL('../', import.meta.url).pathname },
  });
  assert.equal(result.status, 0, result.stderr); const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.counts['review-handoff'].pending, 0); assert.equal(inventory.position.lastSeq, outcome[0].seq);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, outcome[0].seq);
});
