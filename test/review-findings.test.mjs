import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { readReport } from '../lib/report.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';
import { reviewFindingKey } from '../line-service/review-findings.mjs';
import { setupOrg } from './helpers.mjs';

const target = { base: 'a'.repeat(40), head: 'b'.repeat(40), reportHash: 'c'.repeat(64),
  diff_sha256: 'd'.repeat(64), scope: { commits: ['b'.repeat(40)] } };
const major = 'codec.mjs:41 - Reject invalid source paths';
const minor = 'codec.mjs:50 - Restore the caller environment';
const report = (proposals = []) => ({ outcome: 'done', extra: { verdict: 'FAIL' }, proposals });
const seed = (extra = {}) => [
  { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Source' },
  ...review('REV-1', 'R-2', { ...target, ...extra }),
];
function review(id, run, captured = target) {
  return [{ type: 'item.added', id, role: 'reviewer', title: 'Immutable review',
    meta: { review_key: `ENG-1:${captured.head}`, review_target: captured,
      review_source_item: 'ENG-1', review_source_run: 'R-1', review_round_cap: 1 } },
  { type: 'run.started', id: run, item: id }];
}
const stamped = events => events.map((event, i) => ({ seq: i + 1, at: '2026-10-27T16:00:00Z', by: 'fixture', ...event }));
function intake(events, data = report(), body = `- [Major] ${major}`, runId = 'R-2') {
  const state = fold(events);
  return reviewResultEvents({ state, events, run: state.runs.get(runId), report: data, body, sha256: 'e'.repeat(64) });
}
const items = events => events.filter(event => event.type === 'item.added');
const bindings = events => events.filter(event => event.type === 'review.finding-linked');
function orgFixture(t) {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true })); return f;
}

test('finding intake: one formal proposal covers Major and Minor findings without a severity duplicate', () => {
  const data = report([{ role: 'engineering', title: 'Repair the review findings', accept: ['Fix both defects'] }]);
  data.extra.findings = [{ severity: 'major', text: `  ${major}  ` }, { severity: 'minor', text: minor }];
  const before = structuredClone(data), events = stamped(seed());
  const add = intake(events, data, `- [Major] ${major}\n- [Minor] ${minor}`);
  assert.equal(items(add).length, 1);
  assert.equal(bindings(add).length, 2, 'body/frontmatter repetition names the same finding');
  assert.equal(new Set(bindings(add).map(event => event.correction_item)).size, 1);
  assert.equal(add[0].findings.length, 2);
  assert.equal(items(add)[0].meta.review_round_cap, 1);
  assert.deepEqual(items(add)[0].accept, ['Fix both defects']);
  assert.deepEqual(data, before, 'immutable parsed proposals are retained');
  assert.deepEqual(intake(stamped([...events, ...add]), data), []);
});

test('finding intake: quoting only the Major never narrows a sole unbound whole-report proposal', () => {
  const events = stamped(seed()), body = `- [Major] ${major}\n- [Minor] ${minor}`;
  for (const quote of [{ title: major }, { why: major }, { accept: [major] }]) {
    const data = report([{ role: 'engineer', title: 'Resolve all findings', ...quote }]);
    const bytes = JSON.stringify(data), add = intake(events, data, body);
    assert.equal(items(add).length, 1);
    assert.equal(bindings(add).length, 2);
    assert.equal(new Set(bindings(add).map(event => event.finding_key)).size, 2);
    assert.deepEqual(new Set(bindings(add).map(event => event.correction_item)), new Set([items(add)[0].id]));
    assert.equal(JSON.stringify(data), bytes);
  }
  const narrow = intake(events, report([{ role: 'engineer', title: 'Repair the Major',
    extra: { review_findings: [major] } }]), body);
  assert.equal(items(narrow).length, 2, 'only explicit references narrow coverage');
  assert.notEqual(bindings(narrow)[0].correction_item, bindings(narrow)[1].correction_item);
});

test('finding intake: separate findings at the same location keep separate corrections', () => {
  const events = stamped(seed()), body = `- [Minor] ${minor}\n- [Minor] codec.mjs:50 - Preserve native claims`;
  const add = intake(events, report(), body);
  assert.equal(items(add).length, 2);
  assert.equal(bindings(add).length, 2);
  assert.equal(new Set(bindings(add).map(event => event.finding_key)).size, 2);
  assert.equal(new Set(bindings(add).map(event => event.correction_item)).size, 2);
  assert.equal(items(add).some(event => event.meta.severity === 'major'), false, 'FAIL with Minor findings does not invent a Major');
});

test('finding intake: structured findings and paraphrased body summaries file once in both observed report shapes', () => {
  for (const count of [5, 2]) {
    const findings = Array.from({ length: count }, (_, i) => ({
      severity: count === 5 && i === 0 ? 'major' : 'minor',
      text: `[${count === 5 && i === 0 ? 'Major' : 'Minor'}] codec.mjs:${40 + i} - Full immutable explanation ${i}`,
      ...(count === 5 && i === 0 ? { correction_check: 'Reproduce the exact Major and assert its correction' } : {}),
    }));
    const proposals = count === 5 ? [{ role: 'engineer', title: 'Repair the Major',
      extra: { review_findings: [findings[0].text] } }] : [];
    const data = report(proposals);
    data.extra = { verdict: count === 5 ? 'FAIL' : 'PASS', findings };
    const body = findings.map((f, i) => `- [${f.severity}] codec.mjs:${40 + i} - Short display summary ${i}`).join('\n');
    const events = stamped(seed()), bytes = JSON.stringify(data), add = intake(events, data, body);
    const reviewItem = fold(events).items.get('REV-1');
    const keys = findings.map(f => reviewFindingKey(reviewItem, f));
    assert.equal(items(add).length, count, 'one item per declared finding, with or without proposals');
    assert.deepEqual(add[0].findings.map(f => f.key), keys);
    assert.deepEqual(bindings(add).map(e => e.finding_key), keys);
    if (count === 5) assert.equal(items(add)[0].meta.review_correction_checks[keys[0]], findings[0].correction_check);
    const retained = stamped([...events, ...add, ...review('REV-2', 'R-3'),
      ...items(add).map(e => ({ type: 'item.updated', id: e.id, fields: { meta: { hold: true, unknown_attempt: 'retained' } } }))]);
    assert.deepEqual(intake(retained, data, body), [], 'the second consumer of the same report is idempotent');
    const next = intake(retained, data, body, 'R-3');
    assert.equal(items(next).length, 0, 'another intake reuses the same typed finding owners');
    assert.deepEqual(fold([...retained, ...next]).items, fold(retained).items, 'held and UNKNOWN items remain unchanged');
    assert.equal(JSON.stringify(data), bytes, 'canonical declarations and display text are never rewritten');
  }
});

test('finding intake: body-only findings remain available without structured declarations', () => {
  for (const findings of [undefined, []]) {
    const data = report();
    if (findings) data.extra.findings = findings;
    const add = intake(stamped(seed()), data, `- [Major] ${major}\n- [Minor] ${minor}`);
    assert.equal(items(add).length, 2);
    assert.deepEqual(add[0].findings.map(f => f.text), [major, minor]);
  }
});

test('finding intake: an explicitly linked repeat reuses active or closed work without changing UNKNOWN attempts', () => {
  for (const closed of [false, true]) {
    let events = stamped(seed());
    const first = intake(events), correction = items(first)[0];
    events = stamped([...events, ...first, ...review('REV-2', 'R-3'),
      { type: 'item.updated', id: correction.id, fields: { meta: { hold: true, unknown_attempt: '/retained/attempt.json' } } },
      { type: 'run.started', id: 'R-4', item: correction.id, meta: { dispatch_attempt: 'UNKNOWN' } },
      ...(closed ? [{ type: 'item.closed', id: correction.id, as: 'done' }] : [])]);
    const before = fold(events), bytes = JSON.stringify(events);
    const next = intake(events, report([{ role: 'engineer', title: 'A differently worded fix',
      extra: { review_findings: [first[0].findings[0].key] } }]), `- [Major] ${major}`, 'R-3');
    assert.equal(items(next).length, 0);
    assert.deepEqual(next.map(event => event.type), ['change.reviewed']);
    assert.equal(next[0].findings[0].key, first[0].findings[0].key);
    assert.deepEqual(fold([...events, ...next]).items.get(correction.id), before.items.get(correction.id));
    assert.equal(JSON.stringify(events), bytes);
  }
});

test('finding intake: identity includes immutable source range, evidence and covered commits', () => {
  const events = stamped(seed()), first = intake(events), original = first[0].findings[0].key;
  for (const changed of [{ head: 'f'.repeat(40) }, { base: 'f'.repeat(40) },
    { reportHash: 'f'.repeat(64) }, { diff_sha256: 'f'.repeat(64) }, { scope: { commits: ['f'.repeat(40)] } }]) {
    const next = intake(stamped([...events, ...first, ...review('REV-2', 'R-3', { ...target, ...changed })]), report(), `- [Major] ${major}`, 'R-3');
    assert.equal(items(next).length, 1);
    assert.notEqual(next[0].findings[0].key, original);
  }
  const firstReview = fold(events).items.get('REV-1'), finding = { severity: 'major', text: major };
  const reversed = structuredClone(firstReview);
  firstReview.meta.review_target.scope.commits = [target.head, target.base];
  reversed.meta.review_target.scope.commits = [target.base, target.head];
  assert.equal(reviewFindingKey(firstReview, finding), reviewFindingKey(reversed, finding));
});

test('finding intake: explicit finding links distinguish equal titles and coalesce duplicate proposals', () => {
  const events = stamped(seed()), body = `- [Major] ${major}\n- [Minor] ${minor}`;
  const proposal = finding => ({ role: 'engineer', title: 'Repair source', extra: { review_findings: [finding] } });
  const add = intake(events, report([proposal(major), proposal(major), proposal(minor)]), body);
  assert.equal(items(add).length, 2);
  assert.equal(bindings(add).length, 2);
  assert.throws(() => intake(events, report([proposal('unknown finding')]), body), /missing\/ambiguous/);
  assert.throws(() => intake(events, report([{ role: 'engineer', title: 'Unbound A' },
    { role: 'engineer', title: 'Unbound B' }]), body), /explicit review_findings/);
  assert.throws(() => intake(events, report([{ role: 'engineer', title: major },
    { role: 'engineer', title: minor }]), body), /explicit review_findings/);
});

test('finding intake: exact legacy proposals are reused while historical duplicate items and verdicts remain', () => {
  const proposal = { role: 'engineer', title: 'Repair source', why: 'Resolve the review', accept: ['Keep native guards'] };
  const legacy = id => ({ type: 'item.added', id, role: 'engineer', title: proposal.title, why: proposal.why,
    accept: proposal.accept, parent: 'REV-1', from_run: 'R-2' });
  const events = stamped([...seed(), legacy('ENG-2'), legacy('ENG-3'),
    { type: 'run.started', id: 'R-4', item: 'ENG-3', meta: { dispatch_attempt: 'UNKNOWN' } },
    { type: 'change.reviewed', review_run: 'R-90', review_key: 'historical', verdict: 'FAIL' }]);
  const before = fold(events), add = intake(events, report([proposal]), `- [Major] ${major}\n- [Minor] ${minor}`);
  assert.equal(items(add).length, 0);
  assert.deepEqual(bindings(add).map(event => event.correction_item), ['ENG-2', 'ENG-2']);
  assert.deepEqual(fold([...events, ...add]).items.get('ENG-3'), before.items.get('ENG-3'));
  assert.deepEqual(fold([...events, ...add]).runs.get('R-4'), before.runs.get('R-4'));
  assert.equal(add.some(event => ['item.closed', 'run.abandoned', 'run.started'].includes(event.type)), false);
});

test('finding intake: renamed legacy corrections recover immutable creation while active and UNKNOWN attempts remain', () => {
  const proposal = { role: 'engineer', title: 'Repair all findings', why: 'Resolve the review',
    accept: [major], extra: { severity: 'major', detail: 'Original proposal detail' } };
  for (const attempt of ['active', 'UNKNOWN']) {
    const events = stamped([...seed(), { type: 'item.added', id: 'ENG-2', role: 'engineer',
      title: proposal.title, why: proposal.why, accept: proposal.accept, meta: proposal.extra,
      parent: 'REV-1', from_run: 'R-2' },
    { type: 'item.updated', id: 'ENG-2', fields: { title: 'Renamed correction', parent: 'G-3',
      accept: ['Refined acceptance'], meta: { detail: 'Edited display detail', original_review_parent: 'REV-1', hold: true } } },
    { type: 'run.started', id: 'R-4', item: 'ENG-2', meta: { dispatch_attempt: attempt } },
    { type: 'change.reviewed', review_run: 'R-90', review_key: 'historical', verdict: 'FAIL' }]);
    const before = fold(events), bytes = JSON.stringify(events);
    const add = intake(events, report([proposal]), `- [Major] ${major}\n- [Minor] ${minor}`);
    assert.equal(items(add).length, 0);
    assert.deepEqual(bindings(add).map(event => event.correction_item), ['ENG-2', 'ENG-2']);
    assert.equal(new Set(bindings(add).map(event => event.finding_key)).size, 2);
    const after = fold([...events, ...add]), correction = after.items.get('ENG-2');
    for (const field of ['title', 'parent', 'accept', 'created', 'runs'])
      assert.deepEqual(correction[field], before.items.get('ENG-2')[field]);
    assert.equal(correction.meta.detail, 'Edited display detail');
    assert.equal(correction.meta.hold, true);
    assert.equal(correction.meta.review_round_cap, 1);
    assert.equal(correction.meta.review_fix_of, `ENG-1:${target.head}`);
    assert.deepEqual(after.runs.get('R-4'), before.runs.get('R-4'));
    assert.deepEqual(after.items.get('REV-1'), before.items.get('REV-1'));
    assert.deepEqual(after.items.get('ENG-1'), before.items.get('ENG-1'));
    assert.equal(add.some(event => ['item.closed', 'run.abandoned', 'run.started'].includes(event.type)), false);
    assert.equal(JSON.stringify(events), bytes, 'original creations, verdicts and attempts retain their bytes');
  }
});

test('finding intake: legacy recovery retains a bound duplicate and refuses ambiguous or conflicting ownership', () => {
  const proposal = { role: 'engineer', title: 'Repair findings' };
  const legacy = id => ({ type: 'item.added', id, role: 'engineer', title: proposal.title,
    parent: 'REV-1', from_run: 'R-2' });
  const events = stamped([...seed(), legacy('ENG-2'), legacy('ENG-3')]);
  const finding = intake(stamped(seed()))[0].findings[0];
  const binding = { type: 'review.finding-linked', finding_key: finding.key, correction_item: 'ENG-3' };
  const add = intake(stamped([...events, binding]), report([proposal]), `- [Major] ${major}\n- [Minor] ${minor}`);
  assert.equal(items(add).length, 0);
  assert.deepEqual(bindings(add).map(event => event.correction_item), ['ENG-3']);
  assert.deepEqual(fold([...events, ...add]).items.get('ENG-2'), fold(events).items.get('ENG-2'));
  for (const corrupt of [
    { type: 'item.updated', id: 'ENG-2', fields: { meta: { review_fix_of: 'another source' } } },
    { type: 'item.updated', id: 'ENG-2', fields: { meta: { review_source_item: 'ENG-99' } } },
    { type: 'item.updated', id: 'ENG-2', fields: { meta: { review_owner_run: 'R-99' } } },
    { type: 'item.updated', id: 'ENG-2', fields: { role: 'writer' } },
    { ...legacy('ENG-2'), title: 'A different creation reuses the ID' },
  ]) {
    const retained = stamped([...events, corrupt, { type: 'run.started', id: 'R-4', item: 'ENG-2',
      meta: { dispatch_attempt: 'UNKNOWN' } }]), bytes = JSON.stringify(retained);
    assert.throws(() => intake(retained, report([proposal]), `- [Major] ${major}\n- [Minor] ${minor}`), /missing\/UNKNOWN|ambiguous|changed/);
    assert.equal(JSON.stringify(retained), bytes);
  }
  const foreign = stamped([...events, { type: 'item.added', id: 'ENG-4', role: 'engineer', title: 'Other correction' },
    { ...binding, correction_item: 'ENG-4' }]);
  assert.throws(() => intake(foreign, report([proposal]), `- [Major] ${major}\n- [Minor] ${minor}`), /conflicting/);
});

test('finding intake: final commit rechecks finding dedup after another intake appended during preparation', t => {
  const f = orgFixture(t);
  transact(f.dir, () => ({ add: [...seed(), ...review('REV-2', 'R-3')] }));
  let stale, callbacks = 0;
  const result = transact(f.dir, (events) => {
    callbacks++;
    return { add: intake(events) };
  }, { subjects: ['R-2'], prepare: (_state, events) => {
    stale = intake(events);
    transact(f.dir, current => ({ add: intake(current, report(), `- [Major] ${major}`, 'R-3') }));
  } });
  assert.equal(items(stale).length, 1, 'both producers initially saw no correction');
  assert.equal(callbacks, 1);
  assert.equal(items(result.added).length, 0, 'stale prepared allocation is never committed');
  const committed = loadEvents(f.dir).events;
  assert.equal(items(committed).filter(event => event.meta?.review_fix_of).length, 1);
  assert.equal(committed.filter(event => event.type === 'change.reviewed').length, 2);
  assert.equal(bindings(committed).length, 1);
});

test('finding intake: missing or conflicting retained bindings refuse allocation instead of replacing an attempt', () => {
  const events = stamped(seed()), first = intake(events), binding = bindings(first)[0];
  const duplicate = { ...items(first)[0], id: 'ENG-3' };
  for (const corrupt of [
    [...events, binding, ...review('REV-2', 'R-3')],
    [...events, ...first, duplicate, ...review('REV-2', 'R-3')],
    [...events, ...first, { type: 'item.updated', id: binding.correction_item,
      fields: { meta: { review_fix_of: 'a different immutable source' } } }, ...review('REV-2', 'R-3')],
  ]) assert.throws(() => intake(stamped(corrupt), report(), `- [Major] ${major}`, 'R-3'), /conflicting|missing\/UNKNOWN|changed/);
});

test('finding intake: bare failed judgments and proposal-only reports stay idempotent without inventing verdict findings', () => {
  const events = stamped(seed());
  for (const data of [report(), report([{ role: 'engineer', title: 'Repair the unspecified failure' }])]) {
    const first = intake(events, data, '');
    assert.equal(items(first).length, 1);
    assert.deepEqual(first[0].findings, []);
    const next = intake(stamped([...events, ...first, ...review('REV-2', 'R-3')]), data, '', 'R-3');
    assert.equal(items(next).length, 0);
  }
  assert.equal(items(intake(events, { ...report(), extra: { verdict: 'PASS' } }, '')).length, 0);
});

test('finding intake: record ingest shares correction intake and keeps unrelated proposals and immutable report bytes', t => {
  const f = orgFixture(t);
  transact(f.dir, () => ({ add: seed() }));
  const file = path.join(f.root, 'review.md');
  const data = { run: 'R-2', ...report([{ role: 'engineering', title: 'Repair all findings', blocking: true },
    { role: 'writer', title: 'Document the correction', blocking: false }]), summary: 'Immutable review completed', headline: 'Review completed', verdict: 'FAIL' };
  data.findings = [{ severity: 'major', text: major }, { severity: 'minor', text: minor }];
  const bytes = `---\n${JSON.stringify(data)}\n---\n- [Major] codec.mjs:41 - Short Major summary\n- [Minor] codec.mjs:50 - Short Minor summary\n`;
  assert.deepEqual(readReport(bytes).errors, []);
  fs.writeFileSync(file, bytes);
  const output = f.ok(['ingest', file]);
  assert.match(output, /Repair all findings/);
  const committed = f.events(), corrections = items(committed).filter(event => event.meta?.review_fix_of);
  assert.equal(corrections.length, 1);
  assert.equal(items(committed).filter(event => event.role === 'writer').length, 1);
  assert.equal(bindings(committed).length, 2);
  assert.deepEqual(intake(committed, readReport(bytes).report, readReport(bytes).body), [], 'service intake reuses record-ingested findings');
  assert.equal(committed.filter(event => event.type === 'link.added' && event.blocker === corrections[0].id).length, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'reports/R-2.md'), 'utf8'), bytes);
  const count = committed.length;
  assert.match(f.ok(['ingest', file]), /already recorded/);
  assert.equal(f.events().length, count);
});
