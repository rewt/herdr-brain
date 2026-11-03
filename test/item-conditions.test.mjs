import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fold, extendFold, itemConditions, itemStatus, dependencyReleases, acceptanceTarget } from '../lib/state.mjs';
import { blockReason } from '../lib/render.mjs';
import { buildProjectPage } from '../lib/project-page.mjs';
import { correctionDischargeEvents } from '../lib/correction-discharge.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';
import { setupOrg } from './helpers.mjs';
import { validateTree } from '../lanes/validation.mjs';
import { transact } from '../lib/store.mjs';
import { readReport } from '../lib/report.mjs';

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
const dischargeFacts = input => correctionDischargeEvents(input).filter(e => e.type === 'correction.discharged');

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

test('a PASS with a done Minor follow-up stays accepted and releases accepted dependencies', () => {
  const k = 'minor-1';
  const rows = [...judge(),
    { type: 'item.added', id: 'ENG-4', role: 'engineer', from_run: 'R-2', meta: {
      review_fix_of: `ENG-1:${head}`, review_source_item: 'ENG-1', review_source_run: 'R-1',
      severity: 'minor', review_finding_keys: [k] } },
    { type: 'review.finding-linked', correction_item: 'ENG-4', finding_key: k, source_item: 'ENG-1', head,
      review_item: 'REV-1', review_run: 'R-2', finding: { severity: 'minor' } },
    { type: 'run.started', id: 'R-4', item: 'ENG-4' },
    { type: 'report.ingested', run: 'R-4', sha256: reviewHash, report: { outcome: 'done' } },
    { type: 'item.added', id: 'ENG-3', role: 'engineer' },
    { type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-3', requires: 'accepted' },
  ];
  for (const events of [rows, [...rows, { type: 'item.closed', id: 'ENG-4', as: 'dropped' }]]) {
    const s = state(events);
    assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'True');
    assert.equal(itemConditions(s, 'ENG-1').phase, 'accepted');
    assert.equal(itemStatus(s, 'ENG-3'), 'ready');
  }
  const s = state(structuredClone(rows));
  assert.equal(itemConditions(s, 'ENG-4').Accepted.status, 'Unknown', 'done is not discharge');
  s.items.get('ENG-4').finding_bindings[0].finding.severity = 'major';
  assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'Unknown', 'a done Major needs proof');
  assert.equal(itemStatus(s, 'ENG-3'), 'blocked');
  s.runs.get('R-4').report = null;
  assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'False', 'unfinished Major still gates a PASS');
  const negative = state(rows);
  negative.runs.get('R-1').judgments[0].verdict = 'FAIL';
  assert.equal(itemConditions(negative, 'ENG-1').Accepted.status, 'False', 'a Minor bound to FAIL still gates');
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

test('historical or incomplete review bindings never declare intent fulfilled', () => {
  for (const edit of [
    s => { delete s.items.get('REV-1').acceptance_capture; },
    s => { delete s.items.get('REV-1').acceptance_capture.source_run; },
    s => { delete s.items.get('REV-1').acceptance_capture.target.claim_generation; },
    s => { s.items.get('REV-1').acceptance_capture.target.claim_generation = null; },
    s => { delete s.runs.get('R-1').report.sha256; },
  ]) {
    const events = seed(), s = fold(events); edit(s);
    const capture = s.items.get('REV-1').acceptance_capture;
    const report = { outcome: 'done', extra: { verdict: 'PASS', acceptance: { fulfilled: true, head,
      source_run: capture?.source_run, source_report_sha256: capture ? s.runs.get('R-1').report.sha256 : undefined,
      claim_generation: capture?.target.claim_generation } } };
    const facts = reviewResultEvents({ state: s, events, run: s.runs.get('R-2'), report, sha256: reviewHash });
    assert.equal(facts[0].intent_fulfilled, false);
  }
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

function correction(t, existingOrg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'item-discharge-'));
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = existingOrg ?? path.join(root, '.org'); fs.mkdirSync(path.join(org, 'evidence'), { recursive: true });
  const output = path.join(org, 'evidence', 'check.log'), execution = `${output}.execution.json`, receipt = path.join(org, 'evidence', 'gate.json');
  fs.writeFileSync(output, 'TAP fixture: exact Major trigger corrected\n');
  fs.writeFileSync(execution, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1 }));
  const command = 'node test/helpers/run.mjs test/codec.test.mjs';
  const gate = { schema: 'lane-validation/v1', head, command, executed: true, exit_code: 0, signal: null, outcome: 'green',
    tap_totals: [], log: output, log_hash: createHash('sha256').update(JSON.stringify(fs.readFileSync(output, 'utf8'))).digest('hex'), execution_receipt: execution };
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
  return { s, run, report, finding, gate, save, org, output, execution, rows };
}

test('correction discharge consumes original findings and actual green receipts; missing/red/changed/unrun results do not discharge', t => {
  const f = correction(t), intake = () => dischargeFacts({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  assert.equal(intake().length, 1);
  for (const patch of [{ result: 'unrun' }, { result: undefined }, { sha256: '0'.repeat(64) }, { head: base }, { requirement: 'Unrelated control' }, { key: 'other' }]) {
    const original = { ...f.finding }; Object.assign(f.finding, patch); assert.deepEqual(intake(), [], JSON.stringify(patch)); Object.assign(f.finding, original);
  }
  for (const patch of [{ executed: false }, { exit_code: 1 }, { outcome: 'red' }, { tap_totals: undefined }, { tap_totals: [{ fail: 1 }] }, { tap_totals: [{ fail: 0, cancelled: 1 }] }, { tap_totals: { fail: 0 } }]) {
    const original = { ...f.gate }; Object.assign(f.gate, patch); f.finding.sha256 = f.save(); assert.deepEqual(intake(), []); Object.assign(f.gate, original); f.finding.sha256 = f.save();
  }
  fs.writeFileSync(f.output, 'changed'); assert.deepEqual(intake(), []);
});

test('discharge diagnostics name the first missing proof, preserve Unknown and deduplicate notes', t => {
  const f = correction(t);
  const intake = () => correctionDischargeEvents({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  f.gate.head = base; f.finding.sha256 = f.save();
  const notes = intake();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'note.added');
  assert.equal(notes[0].id, f.run.id);
  assert.match(notes[0].text, /gate head differs from final head.*rebase/);
  extendFold(f.s, notes.map(e => ({ ...e, seq: f.s.eventCount + 1 })));
  assert.deepEqual(intake(), []);
  fs.unlinkSync(f.finding.evidence);
  assert.match(intake()[0].text, /durable gate evidence.*ENOENT/);
  f.gate.head = head; f.finding.sha256 = f.save();
  fs.writeFileSync(f.output, 'changed');
  assert.match(intake()[0].text, /check log hash differs/);
  extendFold(f.s, [{ type: 'report.ingested', run: f.run.id, report: f.report, sha256: reviewHash, seq: f.s.eventCount + 1 }]);
  assert.equal(itemConditions(f.s, f.run.item).Accepted.status, 'Unknown');
});

test('intake retains a done report with missing proof without calling its diagnostic a discharge', t => {
  const cli = setupOrg(); t.after(() => fs.rmSync(cli.root, { recursive: true, force: true }));
  const f = correction(t, cli.dir);
  transact(cli.dir, () => ({ add: f.rows.slice(0, -1).map(({ seq, ...event }) => event) }));
  const file = path.join(cli.root, 'missing-proof.md');
  const bytes = `---\nrun: R-4\noutcome: done\nsummary: Proof unavailable\nheadline: Proof unavailable\n---\nOriginal report retained.\n`;
  fs.writeFileSync(file, bytes);
  cli.ok(['ingest', file]);
  const before = cli.events();
  assert.equal(before.at(-1).type, 'note.added');
  assert.match(before.at(-1).text, /declaration is missing/);
  assert.equal(itemConditions(fold(before), 'ENG-4').Accepted.status, 'Unknown');
  assert.doesNotMatch(cli.ok(['ingest', file]), /correction discharged/);
  assert.deepEqual(cli.events(), before);
  assert.equal(fs.readFileSync(path.join(cli.dir, 'reports/R-4.md'), 'utf8'), bytes);
});

test('correction discharge accepts explicit non-TAP green proof but retains failed and missing execution', t => {
  const f = correction(t);
  f.gate.tap_totals = null; f.finding.sha256 = f.save();
  const intake = () => dischargeFacts({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  const bytes = fs.readFileSync(f.finding.evidence);
  assert.equal(intake().length, 1);
  for (const patch of [{ command_started: false }, { exit_code: 1 }, { signal: 'SIGTERM' }, { gate_timeout: true }, { cleanup_error: 'held' }, { attempts: 0 }]) {
    fs.writeFileSync(f.execution, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1, ...patch }));
    assert.deepEqual(intake(), [], JSON.stringify(patch));
  }
  fs.writeFileSync(f.execution, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1 }));
  assert.equal(intake().length, 1, 'original green execution recovers without running a check');
  assert.deepEqual(fs.readFileSync(f.finding.evidence), bytes);
  extendFold(f.s, intake().map(e => ({ ...e, seq: f.s.eventCount + 1 })));
  assert.deepEqual(intake(), [], 'same report cannot discharge twice');
});

test('same-report correction ingest reconciles original non-TAP proof once without rewriting reports or adding review', t => {
  const cli = setupOrg(); t.after(() => fs.rmSync(cli.root, { recursive: true, force: true }));
  const f = correction(t, cli.dir); f.gate.tap_totals = null; f.finding.sha256 = f.save();
  transact(cli.dir, () => ({ add: f.rows.slice(0, -1).map(({ seq, ...event }) => event) }));
  const run = fold(cli.events()).runs.get(f.run.id);
  transact(cli.dir, () => ({ add: [{ type: 'change.landed', run: run.id, item: run.item, head, base, project,
    producer: { ownership_generation: run.owner_generation } }] }));
  f.report.extra.correction_discharge.claim_generation = run.owner_generation;
  const bytes = `---\n${JSON.stringify({ run: run.id, outcome: 'done', summary: 'Correction proof preserved',
    headline: 'Correction proof preserved', correction_discharge: f.report.extra.correction_discharge })}\n---\nOriginal immutable report.\n`;
  const sha256 = createHash('sha256').update(bytes).digest('hex'), parsed = readReport(bytes);
  assert.deepEqual(parsed.errors, []);
  const stored = path.join(cli.dir, 'reports', `${run.id}.md`); fs.writeFileSync(stored, bytes);
  transact(cli.dir, () => ({ add: [{ type: 'report.ingested', run: run.id, item: run.item, report: parsed.report, sha256 }] }));
  const before = cli.events(), gateBytes = fs.readFileSync(f.finding.evidence);
  assert.match(cli.ok(['ingest', stored]), /correction discharged/);
  const after = cli.events();
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1).type, 'correction.discharged');
  assert.equal(after.at(-1).report_sha256, sha256);
  assert.equal(itemConditions(fold(after), run.item).Accepted.status, 'True');
  assert.equal(fs.readFileSync(stored, 'utf8'), bytes);
  assert.deepEqual(fs.readFileSync(f.finding.evidence), gateBytes);
  cli.ok(['ingest', stored]); assert.equal(cli.events().length, after.length);
  const changed = path.join(cli.root, 'changed.md'); fs.writeFileSync(changed, bytes + 'Changed');
  assert.match(cli.fail(['ingest', changed]), /already has a report/);
  assert.equal(cli.events().filter(e => e.type === 'item.added' && e.role === 'reviewer').length, 1);
});

test('evidence-only correction requires an exact main ancestor and original run lane receipt', t => {
  const f = correction(t), repo = path.join(path.dirname(f.org), 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'seed'), 'existing source'); git('add', '.'); git('commit', '-m', 'Existing source');
  const checkedHead = git('rev-parse', 'HEAD'); git('checkout', '-b', 'lane/correction');
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  f.run.landings = []; f.run.meta.dispatch_project = common; f.run.meta.lane = 'correction';
  const command = `'${process.execPath}' -e 'console.log("existing documentation verified")'`;
  const gate = validateTree({ cwd: repo, common, command, tier: 'fast' });
  assert.equal(gate.executed, true); assert.equal(gate.tap_totals, null); assert.equal(gate.exit_code, 0);
  Object.assign(f.gate, gate); Object.assign(f.finding, { head: checkedHead, command, sha256: f.save() });
  const intake = () => dischargeFacts({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  assert.equal(intake().length, 1);
  for (const patch of [{ head: head }, { tree: head }, { branch: 'lane/foreign' }, { started_at: '2020-01-01T00:00:00Z' }]) {
    const original = { ...f.gate }; Object.assign(f.gate, patch); f.finding.sha256 = f.save();
    assert.deepEqual(intake(), [], JSON.stringify(patch)); Object.assign(f.gate, original); f.finding.sha256 = f.save();
  }
  git('update-ref', '-d', 'refs/heads/main');
  assert.deepEqual(intake(), [], 'missing main never accepts');
  git('update-ref', 'refs/heads/main', checkedHead);
  assert.equal(intake().length, 1, 'main ancestry recovers using the same proof');
  const receipt = f.gate.history_receipt ?? path.join(common, 'lane-validation', `${gate.key}.json`);
  const original = fs.readFileSync(receipt); fs.writeFileSync(receipt, '{}');
  assert.deepEqual(intake(), [], 'copied declaration alone cannot replace the native receipt');
  fs.writeFileSync(receipt, original);
  f.report.outcome = 'failed'; assert.deepEqual(intake(), [], 'red evidence-only runs remain unresolved');

  f.report.outcome = 'done';
  const verified = intake();
  assert.equal(verified.length, 1, 'restoring the original proof recovers without replaying the check');
  extendFold(f.s, [{ type: 'report.ingested', run: f.run.id, report: f.report, sha256: reviewHash, seq: f.s.eventCount + 1 },
    { type: 'item.added', id: 'ENG-5', role: 'engineer', seq: f.s.eventCount + 2 },
    { type: 'link.added', blocker: f.run.item, blocked: 'ENG-5', requires: 'accepted', seq: f.s.eventCount + 3 }]);
  assert.equal(itemConditions(f.s, f.run.item).Accepted.status, 'Unknown', 'a report declaration alone is not verified discharge');
  assert.equal(itemStatus(f.s, 'ENG-5'), 'blocked');
  extendFold(f.s, verified.map(e => ({ ...e, seq: f.s.eventCount + 1 })));
  const accepted = itemConditions(f.s, f.run.item);
  assert.equal(accepted.Accepted.status, 'True');
  assert.equal(accepted.SourceDelivered.status, 'Unknown');
  assert.equal(accepted.phase, 'accepted');
  assert.ok(accepted.Accepted.evidence.some(e => e.type === 'correction.discharged'));
  assert.equal(itemStatus(f.s, 'ENG-5'), 'ready');
  assert.equal(f.run.landings.length, 0, 'acceptance does not invent a source landing');
  assert.equal(f.s.runs.get('R-2').report.extra.verdict, 'FAIL');

  for (const patch of [{ run: 'R-999' }, { item: 'ENG-999' }, { report_sha256: reportHash },
    { claim_generation: f.run.owner_generation + 1 }, { review_key: 'ENG-1:foreign' },
    { findings: [] }, { findings: [{ ...verified[0].findings[0], key: 'foreign' }] },
    { findings: [{ ...verified[0].findings[0], finding_seq: 0 }] },
    { findings: [{ ...verified[0].findings[0], head: 'not-a-commit' }] },
    { findings: [...verified[0].findings, { ...verified[0].findings[0], head: base }] }]) {
    const stale = structuredClone(f.s);
    Object.assign(stale.runs.get(f.run.id).discharges[0], patch);
    assert.equal(itemConditions(stale, f.run.item).Accepted.status, 'Unknown', JSON.stringify(patch));
    assert.equal(itemStatus(stale, 'ENG-5'), 'blocked');
  }
  const unclaimed = structuredClone(f.s), unclaimedRun = unclaimed.runs.get(f.run.id);
  unclaimedRun.owner_generation = unclaimedRun.discharges[0].claim_generation = null;
  assert.equal(itemConditions(unclaimed, f.run.item).Accepted.status, 'Unknown', 'a missing claim cannot bind a discharge');
  for (const patch of [{ head: checkedHead }, { head: checkedHead, project: '/foreign/.git' },
    { head: checkedHead, producer: { ownership_generation: 0 } }, { head: base }]) {
    const landed = structuredClone(f.s);
    landed.runs.get(f.run.id).landings = [{ project: common, producer: { ownership_generation: f.run.owner_generation }, ...patch }];
    const conditions = itemConditions(landed, f.run.item);
    assert.equal(conditions.Accepted.status, patch.head === checkedHead && !patch.project && !patch.producer ? 'True' : 'Unknown',
      'recorded source must retain its exact head, project and claim binding: ' + JSON.stringify(patch));
  }
});

test('a completed correction alone does not accept; exact discharge accepts without rewriting FAIL or adding a review', t => {
  const f = correction(t), add = dischargeFacts({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  extendFold(f.s, [{ type: 'report.ingested', run: f.run.id, report: f.report, sha256: reviewHash, seq: f.s.eventCount + 1 }]);
  assert.equal(itemConditions(f.s, 'ENG-4').Accepted.status, 'Unknown');
  assert.equal(itemConditions(f.s, 'ENG-1').Accepted.status, 'False');
  extendFold(f.s, stamp(add).map(e => ({ ...e, seq: f.s.eventCount + 1 })));
  assert.equal(itemConditions(f.s, 'ENG-4').Accepted.status, 'True');
  assert.equal(itemConditions(f.s, 'ENG-1').Accepted.status, 'True');
  assert.equal(f.s.runs.get('R-2').report.extra.verdict, 'FAIL');
  assert.equal([...f.s.items.values()].filter(q => q.role === 'reviewer').length, 1);
});

test('rebased correction keeps stale proof Unknown and discharges only its green final-head control', t => {
  const f = correction(t), repo = path.join(path.dirname(f.org), 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Correction fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'seed'), 'broken'); git('add', 'seed'); git('commit', '-m', 'Baseline');
  git('checkout', '-b', 'lane/correction');
  fs.writeFileSync(path.join(repo, 'seed'), 'fixed'); git('commit', '-am', 'Correct exact trigger');
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  f.run.meta.dispatch_project = common; f.run.meta.lane = 'correction';
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("seed", "utf8"), "fixed"); console.log("TAP version 13\\n1..1\\nok 1 - exact trigger corrected\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0");'`;
  const capture = () => validateTree({ cwd: repo, common, command, tier: 'fast' });
  const before = capture();
  assert.equal(before.executed, true); assert.equal(before.exit_code, 0);
  Object.assign(f.gate, before); f.finding.command = command; f.finding.sha256 = f.save();
  const intake = () => dischargeFacts({ state: f.s, run: f.run, report: f.report, sha256: reviewHash, org: f.org });
  const originalBytes = fs.readFileSync(before.history_receipt);
  const originalGate = path.join(f.org, 'evidence', 'pre-rebase-gate.json');
  fs.writeFileSync(originalGate, originalBytes);
  for (const file of [before.log, before.execution_receipt]) fs.copyFileSync(file, path.join(f.org, 'evidence', path.basename(file)));
  const reference = evidence => ({ evidence, sha256: createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') });
  git('checkout', 'main');
  fs.writeFileSync(path.join(repo, 'unrelated'), 'main moved'); git('add', 'unrelated'); git('commit', '-m', 'Advance main');
  const landingBase = git('rev-parse', 'HEAD');
  git('checkout', 'lane/correction'); git('rebase', '--', 'main');
  const rebasedHead = git('rev-parse', 'HEAD');
  assert.notEqual(rebasedHead, before.head);
  assert.equal(git('diff', `${before.head}^`, before.head), git('diff', landingBase, rebasedHead), 'owned diff is byte-identical');
  extendFold(f.s, [{ type: 'change.landed', run: f.run.id, item: f.run.item, head: rebasedHead, base: landingBase,
    project: common, producer: { ownership_generation: f.run.owner_generation }, seq: f.s.eventCount + 1 }]);
  f.finding.head = rebasedHead;
  assert.deepEqual(intake(), [], 'pre-rebase green receipt cannot discharge the new landed head');
  f.gate.head = rebasedHead;
  for (const result of [{ executed: false, exit_code: 0, outcome: 'green' }, { executed: true, exit_code: 1, outcome: 'red' }]) {
    Object.assign(f.gate, result); f.finding.sha256 = f.save();
    assert.deepEqual(intake(), [], 'unrun/red final-head proof cannot discharge');
  }
  const after = capture();
  assert.equal(after.head, rebasedHead); assert.equal(after.executed, true); assert.equal(after.reused, false);
  assert.equal(after.exit_code, 0); assert.notEqual(after.execution_receipt, before.execution_receipt);
  Object.assign(f.gate, after); f.finding.sha256 = f.save();
  assert.deepEqual(fs.readFileSync(before.history_receipt), originalBytes, 'validation retains its actual earlier receipt');
  assert.deepEqual(intake(), [], 'green final-head proof alone cannot omit the earlier receipt');
  const prior = { ...reference(originalGate), head: before.head, next_head: rebasedHead, command,
    reason: 'Required rebase onto advanced main',
    log: reference(path.join(f.org, 'evidence', path.basename(before.log))),
    execution_receipt: reference(path.join(f.org, 'evidence', path.basename(before.execution_receipt))) };
  f.finding.prior_checks = [prior];
  for (const field of ['head', 'next_head', 'reason', 'command']) {
    const value = prior[field]; delete prior[field];
    assert.deepEqual(intake(), [], `missing ${field} cannot discharge`); prior[field] = value;
  }
  for (const proof of [prior, prior.log, prior.execution_receipt]) {
    const bytes = fs.readFileSync(proof.evidence), hash = proof.sha256;
    fs.writeFileSync(proof.evidence, 'changed');
    proof.sha256 = reference(proof.evidence).sha256;
    assert.deepEqual(intake(), [], 'even rehashed tampering with a preserved artifact cannot discharge');
    fs.writeFileSync(proof.evidence, bytes); proof.sha256 = hash;
  }
  const facts = intake();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].findings[0].head, rebasedHead);
  assert.equal(facts[0].findings[0].command, f.gate.command);
  assert.equal(facts[0].findings[0].prior_checks[0].head, before.head);
  assert.equal(facts[0].findings[0].prior_checks[0].next_head, rebasedHead);
  assert.equal(f.s.runs.get('R-2').report.extra.verdict, 'FAIL');
  assert.equal([...f.s.items.values()].filter(item => item.role === 'reviewer').length, 1);
});

test('page and record agree for ordinary and native-landings captures after repeated normalization', () => {
  for (const native of [false, true]) {
    const rows = stamp([...seed(), ...judge()]);
    if (native) {
      const target = rows.find(e => e.id === 'REV-1').meta.review_target;
      Object.assign(target, { evidence_kind: 'native-landings/v1', source_group: { report_sha256: null } });
      delete target.reportHash;
      assert.deepEqual(acceptanceTarget(acceptanceTarget(target)), acceptanceTarget(target));
      assert.equal(acceptanceTarget(acceptanceTarget(target)).report_sha256, null);
    }
    const s = fold(rows);
    const doc = buildProjectPage({ reader: { state: s, events: () => rows, verify() {}, position: { lastSeq: rows.length } },
      org: '/fixture/.org', project: { identity: project, canonical: '/fixture' } });
    const row = doc.work.find(w => w.id === 'ENG-1');
    assert.equal(itemConditions(s, 'ENG-1').Accepted.status, 'True');
    assert.equal(row.conditions.Accepted.status, itemConditions(s, 'ENG-1').Accepted.status);
    assert.equal(row.phase, 'accepted');
    assert.equal(row.completion, 'accepted completion (exact-target PASS)');
  }
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
