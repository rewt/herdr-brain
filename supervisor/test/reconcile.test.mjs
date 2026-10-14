import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupOrg, report } from '../../test/helpers.mjs';
import { fold, itemStatus, openRuns } from '../../lib/state.mjs';
import { fold as olderFold } from '../../test/fixtures/state-v0.mjs';
import { completionEvents, completionFingerprint, completionDelta, refreshCompletionEvents, digest } from '../../lib/completion.mjs';
import { reconcile } from '../reconcile.mjs';

function fixture() {
  const events = [
    { type: 'item.added', id: 'ENG-1', title: 'First' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'ENG-1' },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } },
    { type: 'item.added', id: 'ENG-2', title: 'Second' },
    { type: 'run.started', id: 'R-3', item: 'ENG-2' },
    { type: 'report.ingested', run: 'R-3', report: { outcome: 'done' } },
    { type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-2' },
    { type: 'item.added', id: 'ENG-3', title: 'Excluded' },
    { type: 'run.started', id: 'R-4', item: 'ENG-3' },
    { type: 'report.ingested', run: 'R-4', report: { outcome: 'done' } },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-10-10T00:00:00Z', by: 'test' }));
  const state = fold(events);
  const plan = { version: 1, batch: 'batch-1', org: '/fixture/.org', identity: '/fixture/.git',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), gate: { exit_code: 0, log: '/fixture/gate.log', sha256: 'c'.repeat(64) },
    items: [{ item: 'ENG-2', run: 'R-3', superseded: [] }, { item: 'ENG-1', run: 'R-2', superseded: ['R-1'] }]
      .map(e => ({ ...e, expected: completionFingerprint(state, e.item), head: 'b'.repeat(40), why: 'Independent PASS; operator approved promotion.' })),
    excluded: [{ item: 'ENG-3', run: 'R-4', superseded: [], expected: completionFingerprint(state, 'ENG-3'),
      reason: 'Requires further review', next_action: 'Dispatch review before promotion', blocked_by: [] }] };
  return { events, state, plan, complete: (p = plan, e = events) => completionEvents(fold(e), e, p, plan.org) };
}

test('one batch reconciles every member and superseded run, preserving excluded work and older folds', () => {
  const f = fixture(), { add, result } = f.complete();
  assert.deepEqual(result.items, ['ENG-2', 'ENG-1']);
  assert.deepEqual(result.superseded, ['R-1']);
  for (const read of [fold, olderFold]) {
    const s = read([...f.events, ...add]);
    assert.equal(itemStatus(s, 'ENG-1'), 'done');
    assert.equal(itemStatus(s, 'ENG-2'), 'done');
    assert.equal(itemStatus(s, 'ENG-3'), 'ready');
    assert.equal(openRuns(s, 'ENG-1').length, 0);
    assert.equal(s.runs.get('R-2').report.outcome, 'done');
    assert.match(s.items.get('ENG-3').notes.at(-1).text, /Next action: Dispatch review/);
  }
});

test('omissions, stale evidence, unresolved questions and malformed plans refuse the whole batch', () => {
  const cases = [
    p => { p.items[1].superseded = []; },
    p => { p.items[1].superseded = ['R-3']; },
    p => { p.items[1].superseded = ['R-1', 'R-1']; },
    p => { p.items[1].run = 'R-1'; },
    p => { p.items[0].expected = 'd'.repeat(64); },
    p => { p.items.push(p.items[0]); },
    p => { p.gate.exit_code = 1; },
    p => { p.org = '/other/.org'; },
    p => { p.excluded[0].next_action = ''; },
    p => { p.excluded[0].blocked_by = ['missing']; },
  ];
  for (const change of cases) {
    const f = fixture(), before = JSON.stringify(f.events), p = structuredClone(f.plan); change(p);
    assert.throws(() => f.complete(p)); assert.equal(JSON.stringify(f.events), before);
  }
  for (const extra of [
    { type: 'run.started', id: 'R-5', item: 'ENG-1' },
    { type: 'item.reopened', id: 'ENG-1' },
    { type: 'note.added', id: 'ENG-1', text: 'Hold pending decision' },
    { type: 'item.updated', id: 'ENG-1', fields: { meta: { operator_reserved: true } } },
  ]) {
    const f = fixture(); assert.throws(() => f.complete(f.plan, [...f.events, extra]));
  }
  const f = fixture();
  const events = [...f.events, { type: 'item.added', id: 'HUM-1', role: 'human', meta: { answer: 'no' } },
    { type: 'item.closed', id: 'HUM-1', as: 'done' }, { type: 'link.added', blocker: 'HUM-1', blocked: 'ENG-1' }];
  f.plan.items[1].expected = completionFingerprint(fold(events), 'ENG-1');
  assert.throws(() => f.complete(f.plan, events), /declined blockers/);
});

test('an excluded done report cannot satisfy an included dependency, and exclusion cycles refuse', () => {
  const f = fixture();
  const events = [...f.events, { type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-1' }];
  for (const entry of [...f.plan.items, ...f.plan.excluded]) entry.expected = completionFingerprint(fold(events), entry.item);
  assert.throws(() => f.complete(f.plan, events), /unresolved or declined blockers/);
  const other = fixture();
  other.plan.excluded[0].blocked_by = ['ENG-3'];
  assert.throws(() => other.complete(), /invalid exclusion blocker/);
});

test('blocked reports require recorded supervisor resolution, while unrelated writes do not invalidate preparation', () => {
  const f = fixture();
  f.events[3].report.outcome = 'blocked';
  for (const entry of f.plan.items) entry.expected = completionFingerprint(fold(f.events), entry.item);
  assert.throws(() => f.complete(), /resolution/);
  f.plan.items[1].resolution = 'Independent review and host gate resolved the sandbox restriction.';
  const unrelated = [...f.events, { type: 'item.added', id: 'ENG-99', title: 'Unrelated' }];
  assert.equal(f.complete(f.plan, unrelated).result.replayed, false);
});

test('display-only session metadata never changes completion authority', () => {
  const f = fixture();
  const events = [...f.events, { type: 'run.updated', id: 'R-2', meta: { harness: 'another', model: 'display', pane: 'new-pane' } }];
  assert.equal(f.complete(f.plan, events).result.replayed, false);
});

test('replay is a no-op even after reopening, and different evidence cannot reuse the batch id', () => {
  const f = fixture(), { add } = f.complete();
  const events = [...f.events, ...add, { type: 'item.reopened', id: 'ENG-1' }];
  const again = f.complete(f.plan, events);
  assert.equal(again.result.replayed, true); assert.deepEqual(again.add, []);
  assert.equal(itemStatus(fold(events), 'ENG-1'), 'ready');
  f.plan.tip = 'e'.repeat(40);
  assert.throws(() => f.complete(f.plan, events), /different evidence/);
});

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function integration(t) {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.root, 'init', '-b', 'main'); git(f.root, 'config', 'user.name', 'Fixture'); git(f.root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(f.root, '.git/info/exclude'), '.org/\n.lane/\n');
  fs.writeFileSync(path.join(f.root, 'source'), 'base\n'); git(f.root, 'add', 'source'); git(f.root, 'commit', '-m', 'base');
  const base = git(f.root, 'rev-parse', 'HEAD');
  const lane = path.join(f.root, '.lane/work'); git(f.root, 'worktree', 'add', '-b', 'lane/work', lane);
  fs.appendFileSync(path.join(lane, 'source'), 'change\n'); git(lane, 'commit', '-am', 'change');
  const head = git(lane, 'rev-parse', 'HEAD');
  f.ok(['add', 'Implement change', '--role', 'engineer']);
  f.ok(['start', 'ENG-1', '--harness', 'fixture', '--workspace', lane]);
  f.ok(['start', 'ENG-1', '--harness', 'fixture', '--workspace', lane]);
  const reportFile = path.join(f.dir, 'runs/R-2/report.md');
  fs.writeFileSync(reportFile, report('run: R-2\noutcome: done\nsummary: Independent PASS for local fixture.'));
  f.ok(['ingest', reportFile]);
  const manifest = path.join(f.root, '.lane/batch.json'), prepared = path.join(f.root, '.lane/prepared.json'), log = path.join(f.root, '.lane/gate.log');
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'fixture-batch', candidate: head,
    items: [{ item: 'ENG-1', run: 'R-2', head, superseded: ['R-1'], why: 'Independent PASS and authorized local integration.' }], excluded: [] }));
  const common = ['--repo', f.root, '--org', f.dir, '--role', 'supervisor', '--prepared', prepared];
  const prepare = () => reconcile(['prepare', ...common, '--manifest', manifest, '--gate-log', log]);
  const finish = (code = '0', tip = head) => reconcile(['finish', ...common, '--gate-exit', code, '--tip', tip]);
  const refresh = (accepted, why = 'Inspected the supervisor notes; they do not change acceptance.') =>
    reconcile(['refresh', ...common, '--gate-exit', '0', '--tip', head, '--accept-delta', accepted, '--why', why]);
  return { ...f, lane, base, head, manifest, prepared, log, common, prepare, finish, refresh };
}

function refusal(fn) {
  let message;
  assert.throws(fn, error => { message = error.message; return true; });
  const accepted = /delta digest: ([a-f0-9]{64})/.exec(message)?.[1];
  assert.ok(accepted, message);
  return { message, accepted };
}

function appended(events, ...add) {
  return [...events, ...add.map((e, i) => ({ ...e, seq: events.length + i + 1,
    at: '2026-10-14T01:16:38Z', by: e.by ?? 'supervisor-fixture' }))];
}

for (const legacy of [false, true]) for (const change of ['question', 'link'])
test(`a reverted ${change} is omitted beside a plain-note delta with ${legacy ? 'older' : 'new'} receipts`, () => {
  const f = fixture();
  if (!legacy) f.plan.prepared_seq = f.events.at(-1).seq;
  // Put the note first so an older receipt must scan history before the revert.
  const reverted = change === 'question' ? [
    { type: 'item.added', id: 'HUM-1', parent: 'ENG-1', role: 'human', title: 'Proceed?' },
    { type: 'item.closed', id: 'HUM-1', as: 'done' },
  ] : [
    { type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-1' },
    { type: 'link.removed', blocker: 'ENG-3', blocked: 'ENG-1' },
  ];
  const events = appended(f.events, { type: 'note.added', id: 'ENG-2', text: 'Retained supervisor note' }, ...reverted);
  const state = fold(events), delta = completionDelta(state, events, f.plan);
  assert.deepEqual(delta.items.map(e => e.item), ['ENG-2']);
  assert.deepEqual(delta.items[0].events.map(e => e.type), ['note.added']);
  assert.equal(delta.items[0].events[0].acceptance_relevant, false);
  const { message, accepted } = refusal(() => f.complete(f.plan, events));
  assert.match(message, /ENG-2 changed since batch preparation/);
  assert.doesNotMatch(message, /ENG-1 changed|ENG-3 changed|item.added|link.added|link.removed/);
  const refreshed = refreshCompletionEvents(state, events, f.plan, f.plan.org, accepted, 'Inspected the retained note');
  assert.deepEqual(refreshed.result.items, ['ENG-2']);
  assert.equal(f.complete(f.plan, appended(events, ...refreshed.add)).result.replayed, false);
});

for (const legacy of [false, true]) for (const change of ['question', 'auto-question', 'link'])
test(`finish reconciles a reverted ${change} without refresh with ${legacy ? 'older' : 'new'} receipts`, t => {
  const f = integration(t); f.prepare();
  if (legacy) {
    const old = JSON.parse(fs.readFileSync(f.prepared)); delete old.prepared_seq;
    fs.writeFileSync(f.prepared, JSON.stringify(old, null, 2) + '\n');
  }
  const original = fs.readFileSync(f.prepared, 'utf8');
  git(f.root, 'merge', '--ff-only', f.head); fs.writeFileSync(f.log, 'original successful gate\n');
  if (change === 'link') {
    const blocker = f.ok(['add', 'Temporary blocker', '--role', 'engineer']).trim();
    f.ok(['block', 'ENG-1', '--by', blocker]);
    assert.throws(f.finish, /acceptance-relevant/);
    f.ok(['unblock', 'ENG-1', '--by', blocker]);
  } else {
    if (change === 'auto-question') {
      const configFile = path.join(f.dir, 'config.json'), config = JSON.parse(fs.readFileSync(configFile));
      config.approvals.categories.design = 'auto';
      fs.writeFileSync(configFile, JSON.stringify(config));
    }
    const question = f.ok(['ask', 'Proceed after integration?', '--parent', 'ENG-1', '--category', 'design',
      '--recommend', 'yes', '--why', 'Confirm the integrated work', ...(change === 'question' ? ['--wait'] : [])]).trim();
    if (change === 'question') {
      assert.throws(f.finish, /acceptance-relevant/);
      f.ok(['answer', question, 'yes']);
    }
    assert.ok(fold(f.events()).items.get(question).closed);
  }
  const state = fold(f.events()), prepared = JSON.parse(original);
  assert.equal(completionFingerprint(state, 'ENG-1'), prepared.items[0].expected);
  assert.equal(f.finish().result, 'reconciled');
  assert.equal(itemStatus(fold(f.events()), 'ENG-1'), 'done');
  assert.equal(f.events().some(e => e.type === 'promotion.delta-accepted'), false);
  const marker = f.events().at(-1);
  assert.equal(marker.batch, prepared.batch); assert.equal(marker.base, f.base); assert.equal(marker.tip, f.head);
  assert.equal(fs.readFileSync(f.prepared, 'utf8'), original);
});

for (const legacy of [false, true]) for (const change of ['question', 'link'])
test(`a plain note and reverted ${change} on the same member refresh with ${legacy ? 'older' : 'new'} receipts`, () => {
  const f = fixture();
  f.events = appended(f.events, { type: 'note.added', id: 'ENG-1', text: 'Note retained from preparation' });
  for (const entry of [...f.plan.items, ...f.plan.excluded]) entry.expected = completionFingerprint(fold(f.events), entry.item);
  if (!legacy) f.plan.prepared_seq = f.events.at(-1).seq;
  // The new note precedes the revert so older receipts recover the original
  // boundary rather than the later matching state after the revert.
  const reverted = change === 'question' ? [
    { type: 'item.added', id: 'HUM-1', parent: 'ENG-1', role: 'human', title: 'Proceed?' },
    { type: 'item.closed', id: 'HUM-1', as: 'done' },
  ] : [
    { type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-1' },
    { type: 'link.removed', blocker: 'ENG-3', blocked: 'ENG-1' },
  ];
  const tail = [{ type: 'note.added', id: 'ENG-1', text: 'Inspected supervisor note' }, ...reverted];
  const events = appended(f.events, ...tail), state = fold(events), delta = completionDelta(state, events, f.plan);
  // ENG-2 also fingerprints ENG-1 as its blocker, so the note affects both.
  assert.deepEqual(delta.items.map(e => e.item), ['ENG-2', 'ENG-1']);
  assert.ok(delta.items.every(e => e.acceptance_relevant === false));
  const member = delta.items.find(e => e.item === 'ENG-1');
  assert.deepEqual(member.events.map(e => e.event), events.slice(f.events.length));
  assert.deepEqual(member.events.map(e => e.acceptance_relevant), [false, true, true]);
  const { message, accepted } = refusal(() => f.complete(f.plan, events));
  for (const e of tail) assert.ok(message.includes(e.type), message);
  const refreshed = refreshCompletionEvents(state, events, f.plan, f.plan.org, accepted, 'Inspected the note and reverted change');
  assert.deepEqual(refreshed.add[0].items, delta.items);
  const completed = f.complete(f.plan, appended(events, ...refreshed.add));
  const final = fold(appended(events, ...refreshed.add, ...completed.add));
  assert.equal(itemStatus(final, 'ENG-1'), 'done');
  assert.deepEqual(final.items.get('ENG-1').notes.slice(0, 2).map(n => n.text),
    ['Note retained from preparation', 'Inspected supervisor note']);
});

for (const decision of [false, true])
test(`an asked and answered question followed by a ${decision ? 'decision' : 'plain'} note ${decision ? 'refuses refresh' : 'refreshes and finishes'}`, t => {
  const f = integration(t); f.prepare();
  const original = fs.readFileSync(f.prepared, 'utf8');
  git(f.root, 'merge', '--ff-only', f.head); fs.writeFileSync(f.log, 'original successful gate\n');
  const start = f.events().length;
  const question = f.ok(['ask', 'Proceed after integration?', '--parent', 'ENG-1', '--category', 'design',
    '--recommend', 'yes', '--why', 'Confirm the integrated work', '--wait']).trim();
  f.ok(['answer', question, 'yes']);
  f.ok(['note', 'ENG-1', decision ? 'Changed acceptance decision' : 'Retained supervisor note', ...(decision ? ['--decision'] : [])]);
  const before = f.events(), { message, accepted } = refusal(f.finish);
  const receipt = fs.readFileSync(f.prepared + '.record.json', 'utf8');
  const delta = completionDelta(fold(before), before, JSON.parse(receipt));
  assert.equal(delta.items[0].acceptance_relevant, decision);
  assert.deepEqual(delta.items[0].events.map(e => e.event), before.slice(start));
  for (const e of before.slice(start)) assert.ok(message.includes(`seq ${e.seq}: ${e.type}`), message);
  if (decision) {
    assert.throws(() => f.refresh(accepted), /cannot be refreshed as plain notes/);
    assert.deepEqual(f.events(), before);
    assert.equal(fold(before).items.get('ENG-1').closed, null);
  } else {
    assert.equal(f.refresh(accepted).result, 'refreshed');
    assert.deepEqual(f.events().at(-1).items, delta.items);
    assert.equal(f.refresh(accepted).replayed, true);
    assert.equal(f.finish().result, 'reconciled');
    assert.equal(itemStatus(fold(f.events()), 'ENG-1'), 'done');
    assert.equal(f.finish().replayed, true);
  }
  assert.equal(fs.readFileSync(f.prepared, 'utf8'), original);
  assert.equal(fs.readFileSync(f.prepared + '.record.json', 'utf8'), receipt);
  assert.equal(fs.readFileSync(f.log, 'utf8'), 'original successful gate\n');
});

test('refusal shows every changed member and only an exact inspected plain-note delta can be accepted', () => {
  const f = fixture(); f.plan.prepared_seq = f.events.at(-1).seq;
  const events = appended(f.events,
    { type: 'note.added', id: 'ENG-1', text: 'First supervisor note', by: 'supervisor-one' },
    { type: 'note.added', id: 'ENG-2', text: 'Second supervisor note', by: 'supervisor-two' });
  const { message, accepted } = refusal(() => f.complete(f.plan, events));
  assert.match(message, /ENG-1 changed since batch preparation/);
  assert.match(message, /ENG-2 changed since batch preparation/);
  assert.match(message, /seq 12: note.added by supervisor-one \[plain note\]/);
  assert.match(message, /seq 13: note.added by supervisor-two \[plain note\]/);
  assert.match(message, /First supervisor note/);
  const delta = completionDelta(fold(events), events, f.plan);
  assert.equal(digest(delta), accepted);
  const changed = appended(events, { type: 'note.added', id: 'ENG-1', text: 'A later note' });
  assert.throws(() => refreshCompletionEvents(fold(changed), changed, f.plan, f.plan.org, accepted, 'Inspected'), /changed since inspection/);
  const unrelated = appended(events, { type: 'item.added', id: 'ENG-99', title: 'Unrelated' });
  const refreshed = refreshCompletionEvents(fold(unrelated), unrelated, f.plan, f.plan.org, accepted, 'Inspected both notes');
  assert.equal(refreshed.add.length, 1);
  assert.equal(refreshed.add[0].type, 'promotion.delta-accepted');
  assert.deepEqual(refreshed.add[0].items, delta.items);
  const acceptedEvents = appended(unrelated, ...refreshed.add);
  assert.equal(f.complete(f.plan, acceptedEvents).result.replayed, false);
  assert.deepEqual(refreshCompletionEvents(fold(acceptedEvents), acceptedEvents, f.plan, f.plan.org, accepted, 'Retry').add, []);
  const newer = appended(acceptedEvents, { type: 'note.added', id: 'ENG-1', text: 'Not yet inspected' });
  assert.throws(() => f.complete(f.plan, newer), /changed since batch preparation/);
  const decision = appended(acceptedEvents, { type: 'note.added', id: 'ENG-1', decision: true, text: 'New hold' });
  assert.throws(() => f.complete(f.plan, decision), /acceptance-relevant/);
});

test('decision notes, newer runs, reports, links, questions, holds and close/reopen remain acceptance-relevant', () => {
  const cases = [
    [{ type: 'note.added', id: 'ENG-1', text: 'New acceptance decision', decision: true }],
    [{ type: 'note.added', id: 'ENG-1', text: 'New plan', kind: 'plan' }],
    [{ type: 'run.started', id: 'R-5', item: 'ENG-1' }],
    [{ type: 'report.ingested', run: 'R-1', report: { outcome: 'blocked', blockers: ['New blocker'] } }],
    [{ type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-1' }],
    [{ type: 'item.added', id: 'HUM-1', parent: 'ENG-1', role: 'human', title: 'Proceed?' }],
    [{ type: 'note.added', id: 'ENG-1', text: 'Hold pending operator decision', decision: true }],
    [{ type: 'item.closed', id: 'ENG-1', as: 'done' }, { type: 'item.reopened', id: 'ENG-1' }],
  ];
  for (const add of cases) {
    const f = fixture(); f.plan.prepared_seq = f.events.at(-1).seq;
    const events = appended(f.events, ...add), before = JSON.stringify(events);
    const { message, accepted } = refusal(() => f.complete(f.plan, events));
    for (const e of add) assert.ok(message.includes(e.type), message);
    assert.match(message, /acceptance-relevant/);
    assert.throws(() => refreshCompletionEvents(fold(events), events, f.plan, f.plan.org, accepted, 'Inspected'), /cannot be refreshed as plain notes/);
    assert.equal(JSON.stringify(events), before);
  }
});

test('refresh refuses a missing historical binding and a preparation sequence that contradicts its fingerprints', () => {
  const f = fixture(); f.plan.items[0].expected = 'd'.repeat(64);
  const { message, accepted } = refusal(() => f.complete());
  assert.match(message, /Original record boundary unavailable/);
  assert.throws(() => refreshCompletionEvents(f.state, f.events, f.plan, f.plan.org, accepted, 'Inspected'), /cannot be refreshed as plain notes/);
  f.plan.prepared_seq = f.events.at(-1).seq;
  assert.throws(() => f.complete(), /sequence does not match/);
});

test('questions under a blocking review are included in the delta without changing the work fingerprint', () => {
  const f = fixture();
  f.events = appended(f.events,
    { type: 'item.added', id: 'REV-1', role: 'reviewer', title: 'Review' },
    { type: 'item.closed', id: 'REV-1', as: 'done' },
    { type: 'link.added', blocker: 'REV-1', blocked: 'ENG-1' });
  for (const entry of [...f.plan.items, ...f.plan.excluded]) entry.expected = completionFingerprint(fold(f.events), entry.item);
  f.plan.prepared_seq = f.events.at(-1).seq;
  const events = appended(f.events, { type: 'item.added', id: 'HUM-1', parent: 'REV-1', role: 'human', title: 'Hold review?' });
  assert.equal(completionFingerprint(fold(events), 'ENG-1'), f.plan.items[1].expected);
  const delta = completionDelta(fold(events), events, f.plan);
  assert.deepEqual(delta.items.map(e => e.item), ['ENG-1']);
  assert.equal(delta.items[0].events[0].type, 'item.added');
  assert.equal(delta.items[0].events[0].acceptance_relevant, true);
});

for (const legacy of [false, true]) test(`plain supervisor notes recover the original integrated range with ${legacy ? 'older' : 'new'} v1 receipts`, t => {
  const f = integration(t); f.prepare();
  if (legacy) {
    const old = JSON.parse(fs.readFileSync(f.prepared)); delete old.prepared_seq;
    fs.writeFileSync(f.prepared, JSON.stringify(old, null, 2) + '\n');
  }
  const original = fs.readFileSync(f.prepared, 'utf8');
  git(f.root, 'merge', '--ff-only', f.head); fs.writeFileSync(f.log, 'original successful gate\n');
  const noteStart = f.events().at(-1).seq + 1;
  f.ok(['note', 'ENG-1', 'Integrated batch; retained original gate'], { env: { ORG_ACTOR: 'supervisor-first' } });
  f.ok(['note', 'ENG-1', 'Record reconciliation pending after gate'], { env: { ORG_ACTOR: 'supervisor-second' } });
  const before = f.events(), log = fs.readFileSync(f.log, 'utf8');
  const { message, accepted } = refusal(f.finish);
  assert.ok(message.includes(`seq ${noteStart}: note.added by supervisor-first [plain note]`));
  assert.ok(message.includes(`seq ${noteStart + 1}: note.added by supervisor-second [plain note]`));
  assert.deepEqual(f.events(), before);
  const recordReceipt = fs.readFileSync(f.prepared + '.record.json', 'utf8');
  const actor = process.env.ORG_ACTOR; process.env.ORG_ACTOR = 'inspecting-supervisor';
  t.after(() => { if (actor === undefined) delete process.env.ORG_ACTOR; else process.env.ORG_ACTOR = actor; });
  assert.equal(f.refresh(accepted).result, 'refreshed');
  const refreshed = f.events(), event = refreshed.at(-1);
  assert.equal(event.type, 'promotion.delta-accepted');
  assert.equal(event.by, 'inspecting-supervisor'); assert.equal(event.batch, 'fixture-batch');
  assert.equal(event.delta_digest, accepted);
  assert.deepEqual(event.items[0].events.map(e => e.seq), [noteStart, noteStart + 1]);
  const history = f.ok(['show', 'ENG-1']);
  assert.ok(history.includes(`inspecting-supervisor accepted plain-note delta ${accepted} for batch fixture-batch`));
  assert.ok(history.includes(`ENG-1 (seq ${noteStart}, ${noteStart + 1})`));
  for (const read of [fold, olderFold]) {
    assert.deepEqual(read(refreshed).items, read(before).items);
    assert.deepEqual(read(refreshed).runs, read(before).runs);
    assert.equal(read(refreshed).items.get('ENG-1').closed, null);
  }
  assert.equal(f.refresh(accepted).replayed, true); assert.deepEqual(f.events(), refreshed);
  assert.equal(f.finish().result, 'reconciled');
  const marker = f.events().at(-1);
  assert.equal(marker.type, 'promotion.reconciled'); assert.equal(marker.base, f.base); assert.equal(marker.tip, f.head);
  assert.notEqual(marker.base, marker.tip); assert.equal(marker.batch, 'fixture-batch');
  assert.equal(marker.gate.log, f.log);
  assert.equal(fs.readFileSync(f.prepared, 'utf8'), original);
  assert.equal(fs.readFileSync(f.prepared + '.record.json', 'utf8'), recordReceipt);
  assert.equal(fs.readFileSync(f.log, 'utf8'), log);
  const done = f.events(); assert.equal(f.finish().replayed, true); assert.deepEqual(f.events(), done);
});

for (const change of ['decision', 'run', 'question']) test(`finish explains a post-prepare ${change} and refresh refuses it`, t => {
  const f = integration(t); f.prepare();
  git(f.root, 'merge', '--ff-only', f.head); fs.writeFileSync(f.log, 'passed once\n');
  if (change === 'decision') f.ok(['note', 'ENG-1', 'Hold for a new acceptance decision', '--decision']);
  if (change === 'run') f.ok(['start', 'ENG-1', '--harness', 'fixture', '--workspace', f.lane]);
  if (change === 'question') f.ok(['ask', 'Proceed after integration?', '--parent', 'ENG-1', '--category', 'design',
    '--recommend', 'no', '--why', 'Needs operator inspection', '--wait']);
  const before = f.events(), { message, accepted } = refusal(f.finish);
  assert.match(message, /acceptance-relevant/);
  assert.ok(message.includes(change === 'decision' ? 'note.added' : change === 'run' ? 'run.started' : 'item.added'));
  assert.throws(() => f.refresh(accepted), /cannot be refreshed as plain notes/);
  assert.deepEqual(f.events(), before);
});

test('shared adapter verifies exact Git integration and uses explicit project record despite inherited ORG_DIR', t => {
  const f = integration(t), old = process.env.ORG_DIR;
  process.env.ORG_DIR = '/wrong/inherited/record';
  t.after(() => { if (old === undefined) delete process.env.ORG_DIR; else process.env.ORG_DIR = old; });
  assert.equal(f.prepare().result, 'prepared');
  assert.throws(f.prepare, /already exists/);
  const before = f.events();
  assert.throws(() => f.finish('1'), /successful gate/);
  assert.throws(f.finish); // Candidate is not on main.
  assert.deepEqual(f.events(), before);
  git(f.root, 'merge', '--ff-only', f.head);
  assert.throws(f.finish, /ENOENT/);
  fs.writeFileSync(f.log, 'offline fixture validation passed\n');
  assert.throws(() => f.finish('0', f.base), /differs/);
  assert.equal(f.finish().result, 'reconciled');
  const done = f.events();
  assert.equal(itemStatus(fold(done), 'ENG-1'), 'done');
  assert.equal(openRuns(fold(done), 'ENG-1').length, 0);
  assert.equal(f.finish().replayed, true); assert.deepEqual(f.events(), done);
  f.ok(['reopen', 'ENG-1', '--note', 'New operator direction']);
  assert.equal(f.finish().replayed, true);
  assert.equal(itemStatus(fold(f.events()), 'ENG-1'), 'ready');
  fs.appendFileSync(f.log, 'changed evidence\n');
  assert.throws(f.finish, /evidence changed/);
});

test('adapter refuses stale record, dirty trees, wrong record, STOP and the actual promotion lock', t => {
  const f = integration(t);
  fs.appendFileSync(path.join(f.lane, 'source'), 'dirty\n'); assert.throws(f.prepare, /head\/workspace/);
  git(f.lane, 'restore', 'source');
  const lock = path.join(f.root, '.git/lane-promote.lock'); fs.mkdirSync(lock);
  assert.throws(f.prepare, /locked/); fs.rmdirSync(lock);
  fs.mkdirSync(path.join(f.root, '.lane/supervisor')); fs.writeFileSync(path.join(f.root, '.lane/supervisor/STOP'), 'stop');
  assert.throws(f.prepare, /STOP/); fs.unlinkSync(path.join(f.root, '.lane/supervisor/STOP'));
  const wrong = path.join(f.root, '.lane/wrong-org'); f.ok(['init', wrong]);
  assert.throws(() => reconcile(['prepare', ...f.common, '--org', wrong]), /record differs/);
  f.prepare(); git(f.root, 'merge', '--ff-only', f.head); fs.writeFileSync(f.log, 'passed\n');
  f.ok(['start', 'ENG-1', '--harness', 'fixture', '--workspace', f.lane]);
  const before = f.events(); assert.throws(f.finish, /changed/); assert.deepEqual(f.events(), before);
});


test('historical exclusions preserve newer work and cannot mutate its state', () => {
  const f = fixture();
  f.plan.excluded = [{ item: 'ENG-3', run: 'R-4', superseded: [], disposition: 'historical',
    reason: 'Red in the earlier batch', next_action: 'Continue the newly assigned correction' }];
  const events = [...f.events, { type: 'run.started', id: 'R-5', item: 'ENG-3' },
    { type: 'note.added', id: 'ENG-3', text: 'New work is in progress' }];
  const before = fold(events).items.get('ENG-3');
  const completed = f.complete(f.plan, events);
  assert.deepEqual(fold([...events, ...completed.add]).items.get('ENG-3'), before);
  assert.deepEqual(completed.add.at(-1).historical_exclusions[0], {
    item: 'ENG-3', run: 'R-4', reason: 'Red in the earlier batch', next_action: 'Continue the newly assigned correction' });
  for (const mutation of [{ superseded: ['R-4'] }, { blocked_by: ['ENG-1'] }, { resolution: 'Override' }]) {
    const p = structuredClone(f.plan); Object.assign(p.excluded[0], mutation);
    assert.throws(() => f.complete(p, events), /cannot mutate/);
  }
  const dependent = [...events, { type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-1' }];
  for (const entry of f.plan.items) entry.expected = completionFingerprint(fold(dependent), entry.item);
  assert.throws(() => f.complete(f.plan, dependent), /unresolved or declined blockers/);
});
