import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../lib/state.mjs';
import { loadRecordReader, DEFAULT_CONFIG } from '../lib/store.mjs';
import { selectPageState, stageFor, collectProjectPage, renderProjectPage, writeProjectPage } from '../lib/project-page.mjs';
import { operatorDigestFrom, operatorDigest, pushId } from '../messages/operator-inbox.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'project-page-'));
process.env.HERDR_MONITOR_FLEET = path.join(scratch, 'fleet');
const NOW = new Date('2026-10-30T18:00:00Z');
const project = { identity: '/fixture/.git', canonical: '/fixture' };
const CLI = fileURLToPath(new URL('../bin/project-page.mjs', import.meta.url));
let serial = 0;
const eventLog = rows => rows.map((e, i) => ({ at: '2026-10-30T10:00:00Z', by: 'fixture', ...e, seq: i + 1 }));
function record(rows) {
  const org = path.join(scratch, `record-${serial++}`);
  fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), eventLog(rows).map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(org, 'config.json'), JSON.stringify(DEFAULT_CONFIG));
  return org;
}
const item = (id, title, extra = {}) => ({ type: 'item.added', id, title, role: 'engineer', ...extra });
const fixtures = () => [
  item('ENG-896', 'Stage root', { meta: { stage_ref: 'ENG-896' } }),
  item('ENG-1', 'Active <script>alert(1)</script> & "quote"', { parent: 'ENG-896', meta: { next_action: 'Read <b>facts</b>', owner: 'recorded owner' } }),
  { type: 'run.started', id: 'R-1', item: 'ENG-1', meta: { lane: 'recorded-lane', agent: 'recorded-agent' } },
  item('ENG-2', 'Held work', { parent: 'ENG-896', meta: { hold: true, hold_reason: 'Wait for decision' } }),
  item('ENG-3', 'Unassigned work'),
  item('ENG-4', 'Broken ancestry', { parent: 'ENG-9999' }),
  item('ENG-5', 'Report done, review pending', { parent: 'ENG-896' }),
  { type: 'run.started', id: 'R-5', item: 'ENG-5' },
  { type: 'change.landed', project: project.identity, item: 'ENG-5', run: 'R-5', head: 'a'.repeat(40), base: 'b'.repeat(40), landed_at: '2026-10-30T11:00:00Z' },
  { type: 'report.ingested', run: 'R-5', file: 'reports/R-5.md', report: { outcome: 'done', summary: 'PRIVATE REPORT BODY' } },
  item('REV-1', 'Independent review', { role: 'reviewer', parent: 'ENG-896', meta: { review_source_item: 'ENG-5', review_source_run: 'R-5' } }),
  item('HUM-1', 'Publish <img src=x onerror=alert(1)>?', { role: 'human', at: '2026-10-01T10:00:00Z', meta: { category: 'publish', operator_reserved: true, recommend: 'Wait', authority_reason: 'Actual operator required' } }),
  { type: 'link.added', blocker: 'HUM-1', blocked: 'ENG-2' },
  item('HUM-2', 'Choose local layout?', { role: 'human', meta: { operator_reserved: false, delegation: 'project T2', recommend: 'Simple' } }),
  item('HUM-3', 'Already answered?', { role: 'human', meta: { answer: 'yes' } }),
  { type: 'item.closed', id: 'HUM-3', as: 'done' },
];

test('waiting Minor batches stay proposed without reopening a passed producer on the project page', () => {
  const rows = [item('ENG-1', 'Producer'), {type:'run.started',id:'R-1',item:'ENG-1'},
    {type:'report.ingested',run:'R-1',report:{outcome:'done'}},
    item('ENG-2','Waiting Minor batch',{meta:{review_fix_of:'ENG-1:head',review_source_item:'ENG-1',
      review_source_run:'R-1',review_minor_batch:'v1',severity:'minor',queue_selected:false}})];
  const waiting=collectProjectPage({org:record(rows),project,now:NOW});
  const producer=waiting.work.find(w=>w.id==='ENG-1'), batch=waiting.work.find(w=>w.id==='ENG-2');
  assert.equal(batch.status,'proposed');
  assert.equal(producer.open,false);
  assert.deepEqual(producer.review.corrections,[]);
  assert.notEqual(producer.review.status,'correction pending');
  for(const event of [{type:'item.updated',id:'ENG-2',fields:{meta:{queue_selected:true}}},
    {type:'run.started',id:'R-2',item:'ENG-2'}]) {
    const active=collectProjectPage({org:record([...rows,event]),project,now:NOW}).work.find(w=>w.id==='ENG-1');
    assert.equal(active.open,true);
    assert.equal(active.review.status,'correction pending');
  }
});

test('local page inherits stable stages and exposes unassigned, invalid, conflicting and cyclic ancestry', () => {
  const s = selectPageState(fold(eventLog([
    item('ENG-896', 'Stage four', { meta: { stage_ref: 'ENG-896' } }),
    item('ENG-1', 'Child', { parent: 'ENG-896' }), item('ENG-2', 'Grandchild', { parent: 'ENG-1' }),
    item('ENG-3', 'Detached'), item('ENG-4', 'Explicit', { meta: { stage_ref: 'ENG-896' } }),
    item('ENG-5', 'Missing reference', { meta: { stage_ref: 'ENG-999' } }),
    item('ENG-6', 'Conflicting', { parent: 'ENG-896', meta: { stage_ref: 'ENG-3' } }),
    item('ENG-7', 'Legacy number', { meta: { stage: 4 } }),
    item('ENG-8', 'Cycle', { parent: 'ENG-8' }), item('ENG-9', 'Prose Stage 4 ENG-896'),
  ])));
  for (const n of [1, 2, 4]) assert.equal(stageFor(s, `ENG-${n}`).ref, 'ENG-896');
  for (const n of [5, 6, 7, 8]) assert.equal(stageFor(s, `ENG-${n}`).label, 'Unknown');
  for (const n of [3, 9]) assert.equal(stageFor(s, `ENG-${n}`).label, 'Unassigned');
  s.items.get('ENG-896').meta = {};
  assert.equal(stageFor(s, 'ENG-2', ['ENG-896']).ref, 'ENG-896');
  assert.equal(stageFor(s, 'ENG-2').label, 'Unassigned');
});

test('local page keeps recorded active/held/unknown work and source/report/review/acceptance distinct', () => {
  const org = record(fixtures()), doc = collectProjectPage({ org, project, now: NOW });
  const row = name => doc.work.find(w => w.id === name);
  assert.equal(doc.record.status, 'current at captured cutoff');
  assert.equal(doc.record.position.lastSeq, fixtures().length);
  assert.equal(row('ENG-1').status, 'active');
  assert.equal(row('ENG-1').runs[0].lane, 'recorded-lane');
  assert.equal(row('ENG-1').runs[0].native_liveness, 'unknown');
  assert.equal(row('ENG-1').owner, 'recorded owner');
  assert.equal(row('ENG-2').work_state, 'held');
  assert.equal(row('ENG-2').blockers[0].id, 'HUM-1');
  assert.equal(row('ENG-3').owner, null);
  assert.equal(row('ENG-3').next_action, null);
  assert.equal(row('ENG-4').stage.label, 'Unknown');
  assert.deepEqual(row('ENG-896').review.items, []);
  assert.equal(row('ENG-896').review.status, 'unknown');
  assert.equal(row('ENG-5').status, 'done');
  assert.equal(row('ENG-5').open, true);
  assert.equal(row('ENG-5').source_landed.head, 'a'.repeat(40));
  assert.equal(row('ENG-5').report_ingested.run, 'R-5');
  assert.equal(row('ENG-5').review.status, 'review pending');
  assert.deepEqual(row('ENG-5').review.items.map(r => r.id), ['REV-1']);
  assert.equal(row('ENG-5').completion, 'derived done; acceptance unknown');
  assert.equal(row('ENG-1').source_landed, null);
  assert.equal(row('ENG-1').report_ingested, null);
  assert.doesNotMatch(JSON.stringify(doc), /PRIVATE REPORT BODY/);
  assert.equal(doc.auxiliary.delivery.status, 'missing');
  assert.ok(doc.freshness.indicators.includes('delivery-missing'));

  const closedParent = record([...fixtures(), { type: 'item.closed', id: 'ENG-896', as: 'done' }]);
  const parent = collectProjectPage({ org: closedParent, project, now: NOW }).work.find(w => w.id === 'ENG-896');
  assert.equal(parent.status, 'done');
  assert.deepEqual(parent.review.items, []);
  assert.equal(parent.open, false);

  const legacy = record([...fixtures(), item('REV-2', 'Legacy review', { role: 'reviewer', parent: 'ENG-3' })]);
  const legacyRow = collectProjectPage({ org: legacy, project, now: NOW }).work.find(w => w.id === 'ENG-3');
  assert.deepEqual(legacyRow.review.items.map(r => r.id), ['REV-2']);
  assert.equal(legacyRow.review.status, 'review pending');

  const correction = record([...fixtures(),
    { type: 'change.reviewed', item: 'ENG-5', head: 'a'.repeat(40), verdict: 'FAIL', review_item: 'REV-1', review_run: 'R-8' },
    { type: 'item.closed', id: 'REV-1', as: 'done' },
    item('ENG-6', 'Formal correction', { meta: { review_fix_of: 'key', review_source_item: 'ENG-5' } }),
  ]);
  const corrected = collectProjectPage({ org: correction, project, now: NOW }).work.find(w => w.id === 'ENG-5');
  assert.equal(corrected.review.status, 'correction pending');
  assert.equal(corrected.open, true);
  const accepted = record([...fixtures(),
    { type: 'change.reviewed', item: 'ENG-5', head: 'a'.repeat(40), verdict: 'PASS', review_item: 'REV-1', review_run: 'R-8' },
    { type: 'item.closed', id: 'REV-1', as: 'done' },
  ]);
  const done = collectProjectPage({ org: accepted, project, now: NOW }).work.find(w => w.id === 'ENG-5');
  assert.equal(done.completion, 'derived done; acceptance unknown', 'a historical item/head-only PASS cannot establish exact acceptance');
  assert.equal(done.open, false);
});

test('local page includes parked questions, reserved/delegated authority, original answers and delivery states without writes', () => {
  const org = record(fixtures());
  fs.mkdirSync(path.join(org, 'supervisor'));
  const delivery = path.join(org, 'supervisor/inbox.log');
  fs.writeFileSync(delivery, [
    { type: 'notice', id: pushId(org, 'HUM-1'), message: 'PRIVATE DELIVERY PAYLOAD' },
    { type: 'sending', id: pushId(org, 'HUM-1') },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const before = fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8'), journal = fs.readFileSync(delivery, 'utf8');
  const doc = collectProjectPage({ org, project, now: NOW }), [reserved, delegated] = doc.needs_your_decision;
  assert.equal(reserved.id, 'HUM-1');
  assert.equal(reserved.parked, true);
  assert.equal(reserved.age_days, 29);
  assert.equal(reserved.recommendation, 'Wait');
  assert.equal(reserved.authority_reason, 'Actual operator required');
  assert.equal(reserved.audience, 'reserved operator question');
  assert.deepEqual(reserved.affected_work.map(w => w.id), ['ENG-2']);
  assert.equal(reserved.delivery, 'uncertain');
  assert.match(reserved.record_link, /events.jsonl#HUM-1$/);
  assert.equal(delegated.audience, 'delegated project judgment');
  assert.equal(delegated.delivery, 'no delivery recorded');
  assert.equal(doc.needs_your_decision.some(q => q.id === 'HUM-3'), false);
  assert.doesNotMatch(JSON.stringify(doc), /PRIVATE DELIVERY PAYLOAD/);
  assert.equal(fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8'), before);
  assert.equal(fs.readFileSync(delivery, 'utf8'), journal);
});

test('local page rejects mixed cutoffs, closes every reader, and surfaces missing/unavailable/torn sources', () => {
  const org = record(fixtures());
  let closed = 0;
  const openReader = dir => {
    const reader = loadRecordReader(dir), original = reader.events.bind(reader);
    return { ...reader,
      *events() { yield* original(); fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'future', seq: 99, at: NOW.toISOString() }) + '\n'); },
      close() { closed++; reader.close(); },
    };
  };
  const stale = collectProjectPage({ org, project, now: NOW, openReader });
  assert.equal(stale.record.status, 'stale');
  assert.equal(stale.work, null);
  assert.equal(stale.needs_your_decision, null);
  assert.equal(closed, 1);
  assert.match(renderProjectPage(stale), /Questions unavailable/);
  const missing = collectProjectPage({ org: path.join(scratch, 'missing'), project, now: NOW });
  assert.equal(missing.record.status, 'missing');
  const corrupt = record(fixtures());
  fs.appendFileSync(path.join(corrupt, 'events.jsonl'), '{broken}\n');
  assert.equal(collectProjectPage({ org: corrupt, project, now: NOW }).record.status, 'unavailable');
  const torn = record(fixtures());
  fs.appendFileSync(path.join(torn, 'events.jsonl'), '{broken');
  assert.equal(collectProjectPage({ org: torn, project, now: NOW }).record.status, 'incomplete');
});

test('local page escapes HTML, bounds fields and refuses to overwrite any output generation', () => {
  const org = record([...fixtures(), item('ENG-10', 'x'.repeat(5000)), item('ENG-11', 'api_key=secret123')]);
  const doc = collectProjectPage({ org, project, now: NOW }), html = renderProjectPage(doc);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quote&quot;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /default-src 'none'/);
  assert.ok(html.indexOf('Needs your decision') < html.indexOf('Open work'));
  assert.equal(doc.work.find(w => w.id === 'ENG-10').title.length, 400);
  assert.equal(doc.work.find(w => w.id === 'ENG-11').title, '[redacted]');
  const directory = path.join(scratch, 'output');
  writeProjectPage(directory, doc);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'))), doc);
  assert.equal(fs.readFileSync(path.join(directory, 'index.html'), 'utf8'), html);
  assert.throws(() => writeProjectPage(directory, doc), /EEXIST/);
});

function envelope(n, org, question = 'HUM-1') {
  return { type: 'session.message.v1', seq: n, envelope: { eventId: `message-${n}`, correlationId: 'thread',
    payload: { kind: 'question', summary: `Question ${n}`, reply_to: null, refs: [{ orgRef: org, item: question }] } } };
}
test('captured stream digest preserves normal digest selection and unknown delivery semantics', () => {
  const org = record([item('HUM-1', 'Question?', { role: 'human', meta: { operator_reserved: true } })]);
  const events = eventLog([item('HUM-1', 'Question?', { role: 'human', meta: { operator_reserved: true } }), ...Array.from({ length: 12 }, (_, n) => envelope(n + 2, org))]);
  const state = fold(events), messages = events.filter(e => e.type === 'session.message.v1');
  for (const options of [{}, { limit: 2 }, { limit: 3, after: 4 }]) {
    assert.deepEqual(operatorDigestFrom(messages.values(), org, { state, entries: [], ...options }), operatorDigest(events, org, options));
  }
  const unknown = operatorDigestFrom(messages.values(), org, { state });
  assert.equal(unknown.messages.length, 5);
  assert.equal(unknown.total, 12);
  assert.equal(unknown.remaining, 7);
  assert.equal(unknown.messages[0].push, 'unknown');
});

test('fresh process command binds owning record, explicitly groups roots and refuses foreign records', () => {
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const org = path.join(repo, '.org'); fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), eventLog([item('ENG-896', 'Stage'), item('ENG-1', 'Work', { parent: 'ENG-896' })]).map(e => JSON.stringify(e)).join('\n') + '\n');
  const out = path.join(scratch, 'fresh-output');
  const env = { ...process.env, ORG_DIR: org };
  const run = spawnSync(process.execPath, [CLI, '--stage', 'ENG-896', '--out', out], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'project.json')));
  assert.equal(doc.work.find(w => w.id === 'ENG-1').stage.ref, 'ENG-896');
  assert.equal(doc.project.record, fs.realpathSync(org));
  assert.equal(JSON.parse(run.stdout).sequence, 2);
  const other = record(fixtures());
  const foreign = spawnSync(process.execPath, [CLI, '--out', path.join(scratch, 'foreign-output')], { cwd: repo, env: { ...env, ORG_DIR: other }, encoding: 'utf8' });
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /foreign/);
  assert.equal(fs.existsSync(path.join(scratch, 'foreign-output')), false);
});

test('fresh context owning-record demonstration captures real evidence when explicitly selected', { skip: !process.env.PROJECT_PAGE_REAL_EVIDENCE }, () => {
  // Opt-in only: this reads the selected owning record, never mutates its log or
  // native/runtime state. Scratch controls above remain isolated from the fleet.
  const evidence = process.env.PROJECT_PAGE_REAL_EVIDENCE;
  const cwd = process.env.PROJECT_PAGE_REAL_CWD;
  const env = { ...process.env, HERDR_MONITOR_FLEET: process.env.PROJECT_PAGE_REAL_FLEET ?? '', ORG_DIR: process.env.PROJECT_PAGE_REAL_ORG };
  const run = spawnSync(process.execPath, [CLI, '--stage', 'ENG-896', '--out', evidence], { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(fs.readFileSync(path.join(evidence, 'project.json')));
  assert.equal(doc.project.record, fs.realpathSync(env.ORG_DIR));
  assert.equal(doc.work.find(w => w.id === 'ENG-995').stage.ref, 'ENG-896');
  assert.ok(doc.record.position.lastSeq > 0);
  assert.equal(doc.record.status, 'current at captured cutoff');
  fs.writeFileSync(path.join(evidence, 'command.json'), JSON.stringify({ command: [process.execPath, CLI, '--stage', 'ENG-896', '--out', evidence], cwd, exit: run.status, stdout: run.stdout, stderr: run.stderr, node: process.version }, null, 2) + '\n');
});
