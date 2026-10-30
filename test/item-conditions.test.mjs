import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold, extendFold, itemConditions, itemStatus, dependencyReleases } from '../lib/state.mjs';
import { blockReason } from '../lib/render.mjs';
import { buildProjectPage } from '../lib/project-page.mjs';
import { correctionDischargeEvents } from '../lib/correction-discharge.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';
import { setupOrg } from './helpers.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), reportHash = 'c'.repeat(64), reviewHash = 'd'.repeat(64), project = '/fixture/.git';
const stamp = rows => rows.map((e, i) => ({ seq: i + 1, at: '2026-10-30T20:00:00Z', by: 'fixture', ...e }));
const target = () => ({ head, base, reportHash, source_provenance: { claim_generation: 3 }, scope: { commits: [head] } });
const seed = () => stamp([
  { type: 'item.added', id: 'ENG-1', role: 'engineer' },
  { type: 'run.started', id: 'R-1', item: 'ENG-1', meta: { dispatch_project: project } },
  { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } },
  { type: 'change.landed', run: 'R-1', item: 'ENG-1', head, base, project, producer: { ownership_generation: 3 } },
  { type: 'report.ingested', run: 'R-1', sha256: reportHash, report: { outcome: 'done' } },
  { type: 'item.added', id: 'REV-1', role: 'reviewer', meta: { review_source_item: 'ENG-1', review_source_run: 'R-1', review_target: target(), review_round_cap: 1 } },
  { type: 'run.started', id: 'R-2', item: 'REV-1' },
]);
const judge = (verdict = 'PASS') => [
  { type: 'report.ingested', run: 'R-2', sha256: reviewHash, report: { outcome: 'done', extra: { verdict } } },
  { type: 'change.reviewed', item: 'ENG-1', head, base, review_key: `ENG-1:${head}`, review_item: 'REV-1', review_run: 'R-2', verdict,
    source_run: 'R-1', source_report_sha256: reportHash, source_claim_generation: 3, report_sha256: reviewHash, covered_commits: [head], intent_fulfilled: true },
];
const state = extra => fold(stamp([...seed(), ...extra]));

test('ordinary completion releases unrelated work during async review; accepted edges opt in', () => {
  const s = state([
    { type: 'item.added', id: 'ENG-2', role: 'engineer' },
    { type: 'item.added', id: 'ENG-3', role: 'engineer' },
    { type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-2' },
    { type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-3', requires: 'accepted' },
  ]);
  assert.equal(itemConditions(s, 'ENG-1').Completed.status, 'True');
  assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'Unknown');
  assert.equal(itemConditions(s, 'ENG-1').phase, 'in-review');
  assert.equal(itemStatus(s, 'ENG-2'), 'ready');
  assert.equal(itemStatus(s, 'ENG-3'), 'blocked');
  assert.match(blockReason(s, 'ENG-3')[0], /acceptance Unknown/);
  extendFold(s, stamp(judge()).map((e, i) => ({ ...e, seq: s.eventCount + i + 1 })));
  assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'True');
  assert.equal(itemStatus(s, 'ENG-3'), 'ready');
  assert.equal(itemConditions(s, 'ENG-1').phase, 'accepted');
});

test('stale, foreign, unbound, retargeted and newer-run judgments accept nothing', () => {
  for (const patch of [{ source_run: 'R-999' }, { source_report_sha256: 'e'.repeat(64) }, { source_claim_generation: 44 },
    { head: 'f'.repeat(40) }, { base: head }, { report_sha256: 'f'.repeat(64) }, { covered_commits: [] }, { source_claim_generation: null }, { intent_fulfilled: false }]) {
    const rows = judge(); Object.assign(rows[1], patch);
    assert.notEqual(itemConditions(state(rows), 'ENG-1').Accepted.status, 'True', JSON.stringify(patch));
  }
  for (const edit of [
    { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } },
    { type: 'item.updated', id: 'REV-1', fields: { meta: { review_target: { ...target(), head: base } } } },
    { type: 'run.started', id: 'R-3', item: 'ENG-1' },
    { type: 'item.reopened', id: 'ENG-1' },
  ]) assert.notEqual(itemConditions(state([...judge(), edit]), 'ENG-1').Accepted.status, 'True');
  const historical = judge(); delete historical[1].source_run;
  assert.equal(itemConditions(state(historical), 'ENG-1').Accepted.status, 'Unknown');
  const negative = state(judge('FAIL'));
  assert.equal(itemConditions(negative, 'ENG-1').Accepted.status, 'False');
  assert.equal(itemConditions(negative, 'ENG-1').phase, 'needs-work');
  assert.equal(dependencyReleases(negative, 'REV-1', 'ENG-1', 'done'), false, 'negative verdict hold is unchanged');
});

test('review intake binds judgment to original capture and source report rather than a live head', () => {
  const events = seed(), s = fold(events), result = reviewResultEvents({ state: s, events, run: s.runs.get('R-2'),
    report: { outcome: 'done', extra: { verdict: 'PASS', acceptance: { fulfilled: true, source_run: 'R-1', source_report_sha256: reportHash, head, claim_generation: 3 } } }, sha256: reviewHash });
  assert.equal(result[0].source_run, 'R-1');
  assert.equal(result[0].source_report_sha256, reportHash);
  assert.equal(result[0].source_claim_generation, 3);
  assert.equal(result[0].intent_fulfilled, true);
});

test('plans accept a completed report without questions/reviews; done-only code and missing-result packets remain Unknown', () => {
  const rows = stamp([
    { type: 'item.added', id: 'PLAN-1', role: 'planner' },
    { type: 'run.started', id: 'R-1', item: 'PLAN-1' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: reportHash },
  ]);
  assert.equal(itemConditions(fold(rows), 'PLAN-1').Accepted.status, 'True');
  assert.equal(itemConditions(fold(stamp([...rows, { type: 'item.added', id: 'HUM-1', role: 'human', parent: 'PLAN-1' }])), 'PLAN-1').Accepted.status, 'False');
  assert.equal(itemConditions(fold(stamp([...rows, { type: 'item.added', id: 'REV-1', role: 'reviewer', parent: 'PLAN-1' }])), 'PLAN-1').Accepted.status, 'Unknown');
  const packet = state([]);
  assert.equal(itemConditions(packet, 'ENG-1').Accepted.status, 'Unknown', 'ENG-1035 packet supplies selected command and assertions, no actual result or judgment');
  assert.equal(itemConditions(packet, 'ENG-1').Completed.status, 'True');
});

test('Progressing has True/False/Unknown witnesses; inactivity is a diagnostic with no scheduling effect', () => {
  const s = fold(seed().slice(0, 3));
  assert.equal(itemConditions(s, 'ENG-1').Progressing.status, 'Unknown');
  const progress = { run: 'R-1', claim_generation: 3, from_seq: 2, to_seq: 3, available: true };
  assert.equal(itemConditions(s, 'ENG-1', { progress }).Progressing.status, 'False');
  assert.equal(itemStatus(s, 'ENG-1'), 'active');
  extendFold(s, [seed()[3]]);
  assert.equal(itemConditions(s, 'ENG-1', { progress: { ...progress, to_seq: 4 } }).Progressing.status, 'True');
  const noSource = fold(seed().slice(0, 3));
  assert.equal(itemConditions(noSource, 'ENG-1', { progress: { ...progress, claim_generation: 99 } }).Progressing.status, 'Unknown');
  assert.equal(itemConditions(noSource, 'ENG-1', { progress: { ...progress, available: false } }).Progressing.status, 'Unknown');
  assert.equal(itemConditions(state(judge()), 'ENG-1').Progressing.status, 'False');
});

function correction(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'item-discharge-'));
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = path.join(root, '.org'); fs.mkdirSync(path.join(org, 'evidence'), { recursive: true });
  const output = path.join(org, 'evidence', 'check.log'), execution = `${output}.execution.json`, receipt = path.join(org, 'evidence', 'gate.json');
  fs.writeFileSync(output, 'TAP fixture: exact Major trigger corrected\n');
  fs.writeFileSync(execution, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1 }));
  const command = 'node test/helpers/run.mjs test/codec.test.mjs';
  const gate = { schema: 'lane-validation/v1', head, command, executed: true, exit_code: 0, signal: null, outcome: 'green',
    log: output, log_hash: createHash('sha256').update(fs.readFileSync(output)).digest('hex'), execution_receipt: execution };
  const save = () => { fs.writeFileSync(receipt, JSON.stringify(gate)); return createHash('sha256').update(fs.readFileSync(receipt)).digest('hex'); };
  const rows = stamp([...seed(), ...judge('FAIL'),
    { type: 'item.added', id: 'ENG-4', role: 'engineer', parent: 'REV-1', from_run: 'R-2', meta: { review_fix_of: `ENG-1:${head}`,
      review_source_item: 'ENG-1', review_source_run: 'R-1', review_finding_keys: ['finding-1'], review_correction_checks: { 'finding-1': 'Reject malformed paths' } } },
    { type: 'review.finding-linked', correction_item: 'ENG-4', finding_key: 'finding-1', source_item: 'ENG-1', head, base,
      review_item: 'REV-1', review_run: 'R-2', report_sha256: reviewHash, finding: { severity: 'major', text: 'Reject malformed paths' } },
    { type: 'run.started', id: 'R-4', item: 'ENG-4', meta: { dispatch_project: project } },
    { type: 'run.claimed', run: 'R-4', owner: { controller: 'brain' } },
  ]);
  rows.push({ type: 'change.landed', run: 'R-4', item: 'ENG-4', head, base, project, producer: { ownership_generation: rows.length }, seq: rows.length + 1 });
  const s = fold(rows), run = s.runs.get('R-4');
  const finding = { key: 'finding-1', result: 'PASS', command, head, evidence: receipt, sha256: save(), requirement: 'Reject malformed paths' };
  const report = { outcome: 'done', extra: { correction_discharge: { run: run.id, claim_generation: run.owner_generation,
    review_key: `ENG-1:${head}`, findings: [finding] } } };
  return { s, run, report, finding, gate, save, org, output, execution };
}

test('correction discharge consumes original findings and actual green receipts; missing/red/changed/unrun results do not discharge', t => {
  const f = correction(t), intake = () => correctionDischargeEvents({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  assert.equal(intake().length, 1);
  for (const patch of [{ result: 'unrun' }, { result: undefined }, { sha256: '0'.repeat(64) }, { head: base }, { requirement: 'Unrelated control' }, { key: 'other' }]) {
    const original = { ...f.finding }; Object.assign(f.finding, patch); assert.deepEqual(intake(), [], JSON.stringify(patch)); Object.assign(f.finding, original);
  }
  for (const patch of [{ executed: false }, { exit_code: 1 }, { outcome: 'red' }, { tap_totals: { fail: 1 } }]) {
    const original = { ...f.gate }; Object.assign(f.gate, patch); f.finding.sha256 = f.save(); assert.deepEqual(intake(), []); Object.assign(f.gate, original); delete f.gate.tap_totals; f.finding.sha256 = f.save();
  }
  fs.writeFileSync(f.output, 'changed'); assert.deepEqual(intake(), []);
});

test('a completed correction alone does not accept; exact discharge accepts without rewriting FAIL or adding a review', t => {
  const f = correction(t), add = correctionDischargeEvents({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  extendFold(f.s, [{ type: 'report.ingested', run: f.run.id, report: f.report, sha256: reviewHash, seq: f.s.eventCount + 1 }]);
  assert.equal(itemConditions(f.s, 'ENG-4').Accepted.status, 'Unknown');
  assert.equal(itemConditions(f.s, 'ENG-1').Accepted.status, 'False');
  extendFold(f.s, stamp(add).map(e => ({ ...e, seq: f.s.eventCount + 1 })));
  assert.equal(itemConditions(f.s, 'ENG-4').Accepted.status, 'True');
  assert.equal(itemConditions(f.s, 'ENG-1').Accepted.status, 'True');
  assert.equal(f.s.runs.get('R-2').report.extra.verdict, 'FAIL');
  assert.equal([...f.s.items.values()].filter(q => q.role === 'reviewer').length, 1);
});

test('page and item/dependency phases consume the same exact conditions', () => {
  const rows = stamp([...seed(), ...judge()]), s = fold(rows);
  const doc = buildProjectPage({ reader: { state: s, events: () => rows, verify() {}, position: { lastSeq: rows.length } },
    org: '/fixture/.org', project: { identity: project, canonical: '/fixture' } });
  const row = doc.work.find(w => w.id === 'ENG-1');
  assert.equal(row.conditions.Accepted.status, 'True');
  assert.equal(row.phase, 'accepted');
  assert.equal(row.completion, 'accepted completion (exact-target PASS)');
});

test('CLI acceptance links name consumer, wake fact and stuck owner; old completion links remain unchanged', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.ok(['add', 'Plan', '--role', 'planner']); f.ok(['add', 'Consumer', '--role', 'engineer']);
  f.ok(['block', 'ENG-1', '--by', 'PLAN-1', '--requires', 'accepted']);
  const edge = f.events().find(e => e.type === 'link.added');
  assert.equal(edge.requires, 'accepted'); assert.equal(edge.consumer, 'ENG-1'); assert.equal(edge.stuck_owner, 'ENG-1');
  assert.ok(edge.wake.includes('change.reviewed'));
  assert.match(f.fail(['block', 'ENG-1', '--by', 'PLAN-1', '--requires', 'completed']), /explicitly unblock/);
  f.ok(['unblock', 'ENG-1', '--by', 'PLAN-1']); f.ok(['block', 'ENG-1', '--by', 'PLAN-1']);
  assert.equal(f.events().filter(e => e.type === 'link.added').at(-1).requires, undefined);
});
