import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countUnlanded, checkUnlandedCap, DEFAULT_UNLANDED_CAP, UNLANDED_EXCEPTION_CAP } from '../unlanded-cap.mjs';
import { fold as oldFold } from '../../test/fixtures/state-pre-session-bind.mjs';

const common = '/project/.git';
function record() {
  const events = [];
  const add = event => { events.push({ seq: events.length + 1, at: '2026-10-21T12:00:00Z', ...event }); return event; };
  const item = (n, fields = {}) => add({ type: 'item.added', id: `ENG-${n}`, title: `Work ${n}`, ...fields }).id;
  const start = (n, target = `ENG-${n}`, meta = {}, fields = {}) => add({ type: 'run.started', id: `R-${n}`, item: target,
    workspace: '/project/lane', meta: { dispatch_project: common, dispatch_unlanded_admitted: true, ...meta }, ...fields }).id;
  const land = (n, fields = {}) => add({ type: 'promotion.reconciled', identity: common, items: [`ENG-${n}`], runs: [`R-${n}`],
    heads: [{ item: `ENG-${n}`, run: `R-${n}`, head: 'a'.repeat(40) }], ...fields });
  return { events, add, item, start, land };
}
const count = r => countUnlanded({ events: r.events, common });
const check = (r, request = { item: 'ENG-new' }, config = {}, extra = {}) => checkUnlandedCap({ events: r.events, common, request, config, ...extra });

test('admitted open items count once across attempts, done reports, parked/kept lanes and abandonment; closed items do not', () => {
  const r = record();
  for (let n = 1; n <= 8; n++) r.item(n);
  for (let n = 1; n <= 7; n++) r.start(n, undefined, { lane: `lane-${n}` });
  r.start(9, 'ENG-1');
  r.add({ type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } });
  r.add({ type: 'item.closed', id: 'ENG-2', as: 'done' });
  r.add({ type: 'lane.parked', topic: 'lane-3' });
  r.add({ type: 'lane.kept', topic: 'lane-4' });
  r.add({ type: 'run.abandoned', id: 'R-5' });
  r.add({ type: 'item.closed', id: 'ENG-6', as: 'dropped' });
  r.land(7);
  assert.deepEqual(count(r).items.map(i => i.item), ['ENG-1', 'ENG-3', 'ENG-4', 'ENG-5']);
  assert.deepEqual(count(r).items[0].runs, ['R-1', 'R-9']);
  assert.equal(count(r).items[0].latest, 'R-9');
});

for (const as of ['done', 'dropped']) test(`a ${as} closure frees an admitted item only until it is reopened`, () => {
  const r = record(); r.item(1); r.start(1);
  r.add({ type: 'item.closed', id: 'ENG-1', as });
  assert.equal(count(r).items.length, 0);
  r.add({ type: 'item.reopened', id: 'ENG-1' });
  assert.equal(count(r).items.length, 1);
});

test('historical done closures and pre-cap open work cannot freeze adoption; legacy work stays visible', () => {
  const r = record();
  for (let n = 1; n <= 164; n++) {
    r.item(n); r.start(n, undefined, { dispatch_unlanded_admitted: undefined });
    if (n <= 116) r.add({ type: 'item.closed', id: `ENG-${n}`, as: 'done' });
  }
  const admitted = check(r);
  assert.equal(admitted.count, 0);
  assert.equal(admitted.admission.kind, 'regular');
  assert.equal(admitted.legacy.count, 48);
  assert.equal(admitted.legacy.counted, false);
  assert.deepEqual(admitted.legacy.items.map(i => i.item), Array.from({ length: 48 }, (_, n) => `ENG-${n + 117}`));
  r.add({ type: 'item.reopened', id: 'ENG-1' });
  assert.equal(check(r).count, 0, 'reopening pre-cap work does not invent an admission');
  r.item(165); r.start(165);
  assert.equal(check(r).count, 1, 'the first cap-aware start immediately consumes capacity');
});

test('nine cap-admitted open items refuse a tenth and distinguish legacy work in the refusal', () => {
  const r = record();
  for (let n = 1; n <= 9; n++) { r.item(n); r.start(n); }
  r.item(10); r.item(11); r.start(11, undefined, { dispatch_unlanded_admitted: undefined });
  assert.throws(() => check(r, { item: 'ENG-10' }), e => {
    assert.equal(e.code, 'DISPATCH_UNLANDED_CAP');
    assert.match(e.message, /unlanded count 9, cap 8: ENG-1, ENG-2, ENG-3, ENG-4, ENG-5, ENG-6, ENG-7, ENG-8, ENG-9\./);
    assert.match(e.message, /Legacy, not counted \(1\): ENG-11/);
    assert.equal(e.unlanded.count, 9);
    assert.equal(e.unlanded.legacy.counted, false);
    return true;
  });
});

test('only the latest original start marker counts; display edits cannot invent or remove an admission', () => {
  const r = record(); r.item(1); r.start(1);
  r.add({ type: 'run.updated', id: 'R-1', meta: { dispatch_unlanded_admitted: false } });
  assert.equal(count(r).items.length, 1);
  r.start(2, 'ENG-1', { dispatch_unlanded_admitted: undefined });
  r.add({ type: 'run.updated', id: 'R-2', meta: { dispatch_unlanded_admitted: true } });
  assert.equal(count(r).items.length, 0);
  assert.equal(count(r).legacy[0].latest, 'R-2');
  r.start(3, 'ENG-1');
  assert.equal(count(r).items[0].latest, 'R-3');
  assert.deepEqual(count(r).legacy, []);
  for (const marker of [undefined, false, 'true', 1]) {
    r.start(4, 'ENG-1', { dispatch_unlanded_admitted: marker });
    assert.equal(count(r).items.length, 0, `marker ${marker} is not an admission`);
    r.events.pop();
  }
});

test('older record folds treat the admission marker as opaque metadata', () => {
  const r = record(); r.item(1); r.start(1);
  const unmarked = structuredClone(r.events);
  delete unmarked.at(-1).meta.dispatch_unlanded_admitted;
  const markedState = oldFold(r.events), unmarkedState = oldFold(unmarked);
  delete markedState.runs.get('R-1').meta.dispatch_unlanded_admitted;
  assert.deepEqual(markedState, unmarkedState, 'the marker has no other effect on an older fold');
});

test('only a matching project promotion covers its attempts; excluded items and newer attempts still count', () => {
  const r = record(); r.item(1); r.start(1);
  r.land(1, { identity: '/other/.git' });
  r.land(1, { items: [], runs: [], heads: [], excluded: ['ENG-1'] });
  r.land(1, { runs: ['R-unrelated'] });
  assert.equal(count(r).items.length, 1);
  r.land(1);
  assert.equal(count(r).items.length, 0);
  r.start(0, 'ENG-1', {}, { at: '2026-10-20T00:00:00Z' });
  r.land(1); // A delayed old receipt cannot land the newer attempt.
  assert.equal(count(r).items[0].latest, 'R-0');
  r.land(1, { runs: ['R-0'], heads: [{ item: 'ENG-1', run: 'R-0' }] });
  assert.equal(count(r).items.length, 0);
});

test('canonical Git identity scopes record-only and dispatched runs, including symlinks and unavailable legacy workspaces', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unlanded-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = path.join(root, 'git'), alias = path.join(root, 'alias'); fs.mkdirSync(git); fs.symlinkSync(git, alias);
  const r = record(); for (let n = 1; n <= 6; n++) r.item(n);
  r.start(1, undefined, { dispatch_project: alias });
  r.start(2, undefined, { dispatch_project: '/elsewhere/.git' });
  for (const [n, workspace] of [[3, 'legacy'], [4, 'foreign'], [5, 'gone'], [6, 'legacy']]) r.start(n, undefined, {}, { meta: {}, workspace });
  const lookups = [];
  const evidence = countUnlanded({ events: r.events, common: git, projectIdentity: cwd => {
    lookups.push(cwd);
    if (cwd === 'gone') throw Error('workspace removed');
    return cwd === 'legacy' ? alias : '/elsewhere/.git';
  } });
  assert.deepEqual(evidence.items.map(i => i.item), ['ENG-1']);
  assert.deepEqual(evidence.legacy.map(i => i.item), ['ENG-3', 'ENG-5', 'ENG-6']);
  assert.deepEqual(lookups, ['legacy', 'foreign', 'gone'], 'resolve each legacy workspace once per count');
});

test('matching promotion evidence identifies removed legacy workspaces before an unknown or reused Git path', () => {
  const r = record(), foreign = '/other/.git';
  for (let n = 1; n <= 7; n++) r.item(n);
  for (let n = 1; n <= 6; n++) r.start(n, undefined, {}, { meta: {}, workspace: '/removed/lane' });
  r.land(1, { identity: foreign });
  r.land(2, { identity: foreign, items: [] });
  r.land(3, { identity: foreign, runs: ['R-unknown'] });
  r.land(4, { identity: foreign, heads: [{ item: 'ENG-7', run: 'R-4' }] });
  r.land(5);
  r.start(7); r.land(7, { identity: foreign }); // Original dispatch project wins a conflicting receipt.
  const missing = () => { throw Error('workspace removed'); };
  const evidence = countUnlanded({ events: r.events, common, projectIdentity: missing });
  assert.deepEqual(evidence.items.map(i => i.item), ['ENG-7']);
  assert.deepEqual(evidence.legacy.map(i => i.item), ['ENG-2', 'ENG-3', 'ENG-4', 'ENG-6']);
  assert.equal(evidence.starts.has('R-1'), false, 'a proven foreign landing cannot qualify as an unblocks target');
  assert.throws(() => check(r, { item: 'ENG-new', unblocks: 'ENG-1' }, {}, { projectIdentity: missing }),
    e => e.code === 'DISPATCH_UNBLOCKS_INVALID');
  assert.deepEqual(countUnlanded({ events: r.events, common: foreign, projectIdentity: missing }).legacy.map(i => i.item),
    ['ENG-2', 'ENG-3', 'ENG-4', 'ENG-6']);
  assert.equal(countUnlanded({ events: r.events, common, projectIdentity: () => common }).starts.has('R-1'), false,
    'a replacement checkout at the old path cannot override a recorded foreign landing');
});

test('uncertain starts reserve distinct items and exception runs until their original record start replaces them', () => {
  const r = record(); r.item(1); r.start(1); r.item(2);
  const journal = (name, fields = {}) => ({ journal: `/record/dispatch/${name}.json`, token: name, common, item: 'ENG-2',
    stage: 'starting', unlandedCap: { admission: { kind: 'unblocks', admitted: true } }, ...fields });
  const first = journal('first'), second = journal('second');
  const journals = [first, second, journal('foreign', { common: '/other/.git' }),
    journal('refused', { startRefused: true }), journal('not-started', { stage: 'start' })];
  const evidence = countUnlanded({ events: r.events, common, journals });
  assert.deepEqual(evidence.items.map(i => i.item), ['ENG-1', 'ENG-2']);
  assert.deepEqual(evidence.items[1].pending, [first.journal, second.journal]);
  assert.equal(evidence.exceptions.length, 2, 'same-item attempts reserve separate exception slots');
  assert.throws(() => check(r, { item: 'ENG-new' }, { dispatch: { max_unlanded: 2 } }, { journals }),
    e => e.code === 'DISPATCH_UNLANDED_CAP' && /Pending record starts/.test(e.message));
  assert.throws(() => check(r, { item: 'ENG-new', unblocks: 'ENG-2' }, {}, { journals }),
    e => e.code === 'DISPATCH_UNBLOCKS_INVALID', 'an unmatched start is not yet a landing to unblock');
  r.start(2, undefined, { dispatch_journal: first.journal, dispatch_attempt: first.token, dispatch_unlanded_exception: 'unblocks' });
  const recorded = countUnlanded({ events: r.events, common, journals });
  assert.equal(recorded.items.length, 2); assert.equal(recorded.exceptions.length, 2);
  assert.deepEqual(recorded.reservations.map(j => j.journal), [second.journal], 'a stale journal must not double count its committed start');
  r.add({ type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } });
  r.land(2);
  const landed = countUnlanded({ events: r.events, common, journals });
  assert.equal(landed.items.length, 2, 'the other uncertain start still reserves the landed item');
  assert.equal(landed.exceptions.length, 1, 'the stale first journal cannot recreate a reported exception');
});

test('a journal reference releases its reservation only for the original project, item, attempt, admission and exception facts', () => {
  for (const [label, item, override] of [
    ['other item', 'ENG-3', {}],
    ['other journal', 'ENG-2', { dispatch_journal: '/record/dispatch/other.json' }],
    ['other attempt', 'ENG-2', { dispatch_attempt: 'other' }],
    ['missing attempt', 'ENG-2', { dispatch_attempt: undefined }],
    ['other project', 'ENG-2', { dispatch_project: '/other/.git' }],
    ['missing project', 'ENG-2', { dispatch_project: undefined }],
    ['missing admission', 'ENG-2', { dispatch_unlanded_admitted: undefined }],
    ['false admission', 'ENG-2', { dispatch_unlanded_admitted: false }],
    ['other exception', 'ENG-2', { dispatch_unlanded_exception: 'fix' }],
    ['missing exception', 'ENG-2', { dispatch_unlanded_exception: undefined }],
    ['display-only match', 'ENG-2', { dispatch_journal: undefined, dispatch_attempt: undefined, dispatch_unlanded_exception: undefined }],
  ]) {
    const r = record(); r.item(2); r.item(3);
    const journal = '/record/dispatch/start.json', token = 'wanted';
    const pending = { journal, token, common, item: 'ENG-2', stage: 'starting', unlandedCap: { admission: { kind: 'unblocks', admitted: true } } };
    const meta = { dispatch_project: common, dispatch_journal: journal, dispatch_attempt: token,
      dispatch_unlanded_admitted: true, dispatch_unlanded_exception: 'unblocks' };
    r.start(1, item, { ...meta, ...override });
    r.add({ type: 'run.updated', id: 'R-1', meta }); // Display edits cannot manufacture the missing original match.
    assert.equal(countUnlanded({ events: r.events, common, journals: [pending] }).reservations.length, 1, label);
    r.start(2, 'ENG-2', meta);
    assert.equal(countUnlanded({ events: r.events, common, journals: [pending] }).reservations.length, 0,
      `${label}: a matching original start replaces the reservation`);
    r.add({ type: 'run.updated', id: 'R-2', meta: { dispatch_project: '/other/.git', dispatch_journal: 'display-only',
      dispatch_attempt: 'display-only', dispatch_unlanded_admitted: false, dispatch_unlanded_exception: 'fix' } });
    assert.equal(countUnlanded({ events: r.events, common, journals: [pending] }).reservations.length, 0,
      `${label}: later display edits cannot invalidate a matching original start`);
  }
});

test('pre-marker journals retain reservations until an exact original pre-marker start replaces them', () => {
  for (const kind of ['regular', 'unblocks']) {
    const r = record(); r.item(1);
    const journal = '/record/dispatch/old.json', token = 'old';
    const pending = { journal, token, common, item: 'ENG-1', stage: 'starting', unlandedCap: { admission: { kind } } };
    assert.equal(countUnlanded({ events: r.events, common, journals: [pending] }).items.length, 1);
    r.start(1, undefined, { dispatch_journal: journal, dispatch_attempt: token,
      dispatch_unlanded_exception: kind === 'regular' ? undefined : kind });
    assert.equal(countUnlanded({ events: r.events, common, journals: [pending] }).reservations.length, 1,
      'a new marked start cannot replace an old unmarked reservation');
    r.start(2, 'ENG-1', { dispatch_journal: journal, dispatch_attempt: token, dispatch_unlanded_admitted: undefined,
      dispatch_unlanded_exception: kind === 'regular' ? undefined : kind });
    const evidence = countUnlanded({ events: r.events, common, journals: [pending] });
    assert.equal(evidence.reservations.length, 0);
    assert.equal(evidence.items.length, 0);
    assert.equal(evidence.legacy.length, 1);
  }
});

test('an uncertain cap admission reserves its legacy item without listing the item twice', () => {
  const r = record(); r.item(1); r.start(1, undefined, { dispatch_unlanded_admitted: undefined });
  const pending = { journal: '/record/dispatch/new.json', token: 'new', common, item: 'ENG-1', stage: 'starting',
    unlandedCap: { admission: { kind: 'regular', admitted: true } } };
  const evidence = countUnlanded({ events: r.events, common, journals: [pending] });
  assert.equal(evidence.items.length, 1);
  assert.deepEqual(evidence.items[0].runs, ['R-1']);
  assert.deepEqual(evidence.items[0].pending, [pending.journal]);
  assert.deepEqual(evidence.legacy, []);
});

test('recovery between the journal and event snapshots cannot hide both an uncertain start and its committed run', t => {
  const org = fs.mkdtempSync(path.join(os.tmpdir(), 'unlanded-snapshot-'));
  t.after(() => fs.rmSync(org, { recursive: true, force: true }));
  const r = record(); r.item(1);
  const log = path.join(org, 'events.jsonl'), journal = path.join(org, 'dispatch/start.json');
  fs.mkdirSync(path.dirname(journal));
  const job = { token: 'snapshot', common, item: 'ENG-1', stage: 'starting', unlandedCap: { admission: { kind: 'regular', admitted: true } } };
  fs.writeFileSync(journal, JSON.stringify(job));
  fs.writeFileSync(log, r.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const read = fs.readFileSync;
  let recovered = false;
  fs.readFileSync = function(file, ...args) {
    const value = read.call(this, file, ...args);
    if (file === log && !recovered) {
      recovered = true;
      r.start(1, undefined, { dispatch_journal: journal, dispatch_attempt: job.token });
      fs.writeFileSync(log, r.events.map(e => JSON.stringify(e)).join('\n') + '\n');
      fs.writeFileSync(journal, JSON.stringify({ ...job, stage: 'worker', run: 'R-1' }));
    }
    return value; // Return the event snapshot from just before the writer commits.
  };
  try {
    assert.throws(() => checkUnlandedCap({ org, common, config: { dispatch: { max_unlanded: 1 } }, request: { item: 'ENG-new' } }),
      e => e.code === 'DISPATCH_UNLANDED_CAP');
  } finally { fs.readFileSync = read; }
  assert.equal(recovered, true);
  const after = checkUnlandedCap({ org, common, config: { dispatch: { max_unlanded: 2 } }, request: { item: 'ENG-new' } });
  assert.equal(after.count, 1); assert.deepEqual(after.pending_starts, []);
});

test('default eight admits below the cap and refuses at it with count, list and a next action', () => {
  const r = record(); assert.equal(DEFAULT_UNLANDED_CAP, 8);
  for (let n = 1; n <= 7; n++) { r.item(n); r.start(n); }
  assert.equal(check(r).admission.kind, 'regular');
  r.item(8); r.start(8);
  assert.throws(() => check(r), e => {
    assert.equal(e.code, 'DISPATCH_UNLANDED_CAP');
    assert.match(e.message, /unlanded count 8, cap 8/);
    assert.match(e.message, /ENG-1, ENG-2, ENG-3, ENG-4, ENG-5, ENG-6, ENG-7, ENG-8/);
    assert.match(e.message, /Finish a listed landing/);
    return true;
  });
  assert.equal(check(r, undefined, { dispatch: { max_unlanded: 9 } }).cap, 9);
  for (const invalid of [null, 0, -1, 1.5, '8', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => check(r, undefined, { dispatch: { max_unlanded: invalid } }), /max_unlanded must be a positive integer/);
  }
});

test('only explicit continuations and recorded landing follow-ups qualify over the cap', () => {
  const r = record(); r.item(1); r.start(1); r.item(2);
  const config = { dispatch: { max_unlanded: 1 } };
  assert.throws(() => check(r, { item: 'ENG-1' }, config), e => e.code === 'DISPATCH_UNLANDED_CAP');
  assert.equal(check(r, { item: 'ENG-1', fromRun: 'R-1' }, config).admission.kind, 'fix');
  assert.throws(() => check(r, { item: 'ENG-2', fromRun: 'R-1' }, config), e => e.code === 'FROM_RUN_OTHER_ITEM');
  const request = { item: 'ENG-2', unblocks: 'ENG-1' };
  assert.throws(() => check(r, request, config, { requireLink: true }), /recorded landing link missing/);
  r.add({ type: 'link.added', blocker: 'ENG-2', blocked: 'ENG-1' });
  assert.equal(check(r, request, config, { requireLink: true }).admission.kind, 'unblocks');
  r.add({ type: 'link.removed', blocker: 'ENG-2', blocked: 'ENG-1' });
  assert.throws(() => check(r, request, config, { requireLink: true }), /recorded landing link missing/);
  for (const unblocks of ['ENG-2', 'ENG-unknown', '', ' ']) assert.throws(() => check(r, { item: 'ENG-2', unblocks }, config), e => e.code === 'DISPATCH_UNBLOCKS_INVALID');
  r.land(1);
  assert.throws(() => check(r, request, config), e => e.code === 'DISPATCH_UNBLOCKS_INVALID');
});

test('legacy open work remains a landing follow-up target without consuming an item slot', () => {
  const r = record(); r.item(1); r.start(1); r.item(2);
  r.start(2, undefined, { dispatch_unlanded_admitted: undefined });
  r.item(3); r.add({ type: 'link.added', blocker: 'ENG-3', blocked: 'ENG-2' });
  const request = { item: 'ENG-3', unblocks: 'ENG-2' }, config = { dispatch: { max_unlanded: 1 } };
  const admitted = check(r, request, config, { requireLink: true });
  assert.equal(admitted.count, 1);
  assert.equal(admitted.admission.kind, 'unblocks');
  assert.equal(admitted.legacy.count, 1);
  r.add({ type: 'item.closed', id: 'ENG-2', as: 'done' });
  assert.throws(() => check(r, request, config), e => e.code === 'DISPATCH_UNBLOCKS_INVALID');
});

test('fixes and follow-ups share three active slots derived from original admission facts; reports and abandonment release them', () => {
  const r = record(); r.item(1); r.start(1);
  const config = { dispatch: { max_unlanded: 1 } }, request = { item: 'ENG-1', fromRun: 'R-1' };
  assert.equal(UNLANDED_EXCEPTION_CAP, 3);
  for (let n = 2; n <= 4; n++) {
    assert.equal(check(r, request, config).exceptions.count, n - 2);
    r.item(n); r.start(n, undefined, { dispatch_unlanded_exception: n === 2 ? 'fix' : 'unblocks' });
  }
  assert.throws(() => check(r, request, config), e => e.code === 'DISPATCH_UNLANDED_CAP' && /All 3 active fix\/follow-up slots.*R-2, R-3, R-4/.test(e.message));
  r.add({ type: 'run.updated', id: 'R-2', meta: { dispatch_unlanded_exception: null } });
  assert.equal(count(r).exceptions.length, 3, 'editing a display field cannot release an active exception');
  r.add({ type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } });
  r.add({ type: 'run.abandoned', id: 'R-3' });
  r.add({ type: 'run.updated', id: 'R-1', meta: { dispatch_unlanded_exception: 'fix' } });
  assert.equal(check(r, request, config).exceptions.count, 1, 'editing display metadata cannot invent an admission');
  assert.equal(count(r).items.length, 4, 'completion of an exception does not itself land the item');
});
