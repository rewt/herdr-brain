import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupOrg, report } from '../../test/helpers.mjs';
import { fold, itemStatus, openRuns } from '../../lib/state.mjs';
import { fold as olderFold } from '../../test/fixtures/state-v0.mjs';
import { completionEvents, completionFingerprint } from '../../lib/completion.mjs';
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
  return { ...f, lane, base, head, manifest, prepared, log, common, prepare, finish };
}

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
