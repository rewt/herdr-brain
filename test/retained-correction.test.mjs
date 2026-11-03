import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fold, itemConditions, itemStatus, dependencyReleases } from '../lib/state.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { retainedCorrectionEvents, reconcileCorrectionCommand } from '../lib/retained-correction.mjs';
import { reviewFindingKey } from '../line-service/review-findings.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = 'node test/helpers/run.mjs --test-name-pattern="^exact required witness$" test/witness.test.mjs';

// Synthetic historical receipts exercise the writer. They execute no old
// correction control and are never offered as live product acceptance proof.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-writer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  const repo = path.join(root, 'repo'), org = path.join(root, '.org');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(org, 'reports'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'source'), 'broken\n');
  fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ to: 'supervisor-fixture' }));
  git('add', '.'); git('commit', '-m', 'Reviewed source');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'source'), 'fixed\n'); git('commit', '-am', 'Real retained correction');
  const head = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'later'), 'independent\n'); git('add', '.'); git('commit', '-m', 'Later proof source');
  const checked = git('rev-parse', 'HEAD'), project = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  git('checkout', '-b', 'lane/proof');
  const rows = [], add = event => { const row = { seq: rows.length + 1, at: '2026-10-30T20:00:00Z', by: 'fixture', ...event }; rows.push(row); return row; };
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: repo, identity: project } };
  const start = (id, item, lane) => {
    add({ type: 'run.started', id, item, workspace: repo, meta: { lane, dispatch_project: project, dispatch_record: org,
      dispatch_attempt: id, dispatch_journal: path.join(org, `${id}.json`) } });
    return add({ type: 'run.claimed', run: id, owner, project, record: org }).seq;
  };
  const report = (run, data) => {
    const bytes = `---\n${JSON.stringify({ run, summary: 'Immutable fixture report', headline: 'Immutable fixture report', ...data })}\n---\nOriginal fixture bytes.\n`;
    fs.writeFileSync(path.join(org, 'reports', `${run}.md`), bytes);
    const { correction_discharge, correction_supporting_checks, ...ordinary } = data;
    return add({ type: 'report.ingested', run, file: `reports/${run}.md`, sha256: hash(bytes),
      report: { ...ordinary, extra: { ...(data.extra ?? {}), ...(correction_discharge ? { correction_discharge } : {}),
        ...(correction_supporting_checks ? { correction_supporting_checks } : {}) } } });
  };
  add({ type: 'item.added', id: 'ENG-1', role: 'engineer' }); start('R-1', 'ENG-1', 'original');
  report('R-1', { outcome: 'done' });
  const reviewMeta = { review_source_item: 'ENG-1', review_source_run: 'R-1', review_target: { base, head: base } };
  const key = reviewFindingKey({ meta: reviewMeta }, { severity: 'major', text: 'Exact original trigger' });
  add({ type: 'item.added', id: 'REV-1', role: 'reviewer', meta: reviewMeta });
  start('R-2', 'REV-1', 'review'); const review = report('R-2', { outcome: 'done', extra: { verdict: 'FAIL' } });
  add({ type: 'link.added', blocker: 'REV-1', blocked: 'ENG-1' });
  const producerGeneration = start('R-3', 'ENG-1', 'producer');
  const landing = add({ type: 'change.landed', item: 'ENG-1', run: 'R-3', project, head, base,
    producer: { ownership_generation: producerGeneration } });
  report('R-3', { outcome: 'done' });
  const requirement = `${command}; prove the exact original Major trigger with no duplicate mutation`;
  add({ type: 'item.added', id: 'ENG-4', role: 'engineer', parent: 'REV-1', from_run: 'R-2', meta: {
    review_source_item: 'ENG-1', review_source_run: 'R-1', review_fix_of: `ENG-1:${base}`,
    review_finding_keys: [key], review_correction_checks: { [key]: requirement } } });
  add({ type: 'review.finding-linked', correction_item: 'ENG-4', finding_key: key, source_item: 'ENG-1', head: base, base,
    review_item: 'REV-1', review_run: 'R-2', report_sha256: review.sha256, finding: { severity: 'major', text: 'Exact original trigger' } });
  const generation = start('R-4', 'ENG-4', 'proof');
  const directory = path.join(project, 'lane-validation'), archive = path.join(org, 'evidence', 'ENG-4', 'R-4');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(archive, { recursive: true });
  const log = path.join(directory, 'proof.log'), execution = `${log}.execution.json`;
  fs.writeFileSync(log, 'ok 1 - exact required witness\n');
  fs.writeFileSync(execution, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1 }));
  const gate = { schema: 'lane-validation/v1', key: 'b'.repeat(64), branch: 'lane/proof', head: checked,
    tree: git('rev-parse', `${checked}^{tree}`), command, executed: true, outcome: 'green', exit_code: 0, signal: null,
    tap_totals: [{ pass: 1, fail: 0, cancelled: 0 }], started_at: '2026-10-30T20:00:00Z', log,
    log_hash: hash(JSON.stringify(fs.readFileSync(log, 'utf8'))), execution_receipt: execution };
  const gateFile = path.join(archive, 'focused.gate.json'), manifest = path.join(archive, 'manifest.json');
  const check = { key, result: 'PASS', head: checked, command, requirement, evidence: gateFile,
    log: { evidence: path.join(archive, 'focused.log') }, execution_receipt: { evidence: path.join(archive, 'focused.execution.json') },
    manifest: { evidence: manifest } };
  const save = () => {
    fs.writeFileSync(path.join(directory, `${gate.key}.json`), JSON.stringify(gate));
    fs.writeFileSync(gateFile, JSON.stringify(gate)); check.sha256 = hash(fs.readFileSync(gateFile));
    for (const [ref, source] of [[check.log, log], [check.execution_receipt, execution]]) {
      fs.copyFileSync(source, ref.evidence); ref.sha256 = hash(fs.readFileSync(source));
    }
    fs.writeFileSync(manifest, JSON.stringify(Object.fromEntries([check, check.log, check.execution_receipt].map(ref => [path.basename(ref.evidence), ref.sha256]))));
    check.manifest.sha256 = hash(fs.readFileSync(manifest));
  };
  save();
  report('R-4', { outcome: 'blocked', blockers: ['Current-run source binding unavailable'], correction_discharge: {
    run: 'R-4', claim_generation: generation, review_key: `ENG-1:${base}`, findings: [structuredClone(check)] } });
  add({ type: 'item.added', id: 'ENG-5', role: 'engineer', parent: 'ENG-1', meta: {} });
  add({ type: 'link.added', blocker: 'ENG-5', blocked: 'ENG-1' });
  add({ type: 'item.added', id: 'ENG-6', role: 'engineer' });
  add({ type: 'link.added', blocker: 'ENG-4', blocked: 'ENG-6', requires: 'accepted' });
  const state = () => fold(rows);
  const reference = id => { const r = state().runs.get(id); return { item: r.item, run: id, claim_generation: r.owner_generation, report_sha256: r.report.sha256 }; };
  check.proof = reference('R-4');
  const plan = { version: 1, id: 'fixture:retained:1', org, project, why: 'Reconcile the retained correction with exact later proof',
    correction: reference('R-4'), review_key: `ENG-1:${base}`, expected: completionFingerprint(state(), 'ENG-4'),
    landing: { ...reference('R-3'), seq: landing.seq, head, base }, findings: [check],
    duplicates: [{ item: 'ENG-5', expected: completionFingerprint(state(), 'ENG-5'), why: 'The same retained fixture correction fulfills this obligation' }] };
  const authority = { project, org, native_caller: { name: 'supervisor-fixture' } };
  const intake = () => retainedCorrectionEvents({ state: state(), events: rows, plan, org, authority });
  const apply = () => { const result = intake(); result.add.forEach(add); return result; };
  return { root, repo, org, project, rows, state, add, report, start, reference, plan, authority, intake, apply, gate, check, save, git, log, execution, base, head, checked };
}

test('retained writer resolves immutable blocked proof, closes duplicate work and keeps ownership and negative hold distinct', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.org, 'reports/R-4.md'));
  assert.equal(itemConditions(f.state(), 'ENG-4').Accepted.status, 'False');
  assert.equal(itemStatus(f.state(), 'ENG-5'), 'ready');
  const result = f.apply(), receipt = result.result.receipt, s = f.state();
  assert.equal(receipt.retained_landing.head, f.head); assert.equal(receipt.findings[0].head, f.checked);
  assert.equal(itemConditions(s, 'ENG-4').Completed.status, 'True');
  assert.equal(itemConditions(s, 'ENG-4').Accepted.status, 'True');
  assert.equal(itemConditions(s, 'ENG-4').SourceDelivered.status, 'Unknown');
  assert.equal(s.runs.get('R-4').report.outcome, 'blocked'); assert.equal(s.runs.get('R-4').landings, undefined);
  assert.equal(itemStatus(s, 'ENG-5'), 'done'); assert.deepEqual(s.items.get('ENG-5').runs, []);
  assert.equal(dependencyReleases(s, 'ENG-4', 'ENG-6', itemStatus(s, 'ENG-4')), true);
  assert.equal(dependencyReleases(s, 'REV-1', 'ENG-1', 'done'), false);
  assert.equal(s.runs.get('R-2').report.extra.verdict, 'FAIL');
  assert.ok(s.links.some(l => l.blocker === 'ENG-5' && l.blocked === 'ENG-1'));
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'reports/R-4.md')), before);
  assert.deepEqual(f.intake().add, []); assert.equal(f.intake().result.replayed, true);
  f.plan.why = 'changed'; assert.throws(f.intake, /different inputs/);
});

test('writer refuses changed finding, reports, claim, project and ancestry; unchanged path recovers after missing proof', t => {
  const f = fixture(t), snapshot = structuredClone(f.plan), originalRows = structuredClone(f.rows);
  const edits = [
    () => { f.plan.findings[0].key = 'other'; },
    () => { f.plan.findings[0].command = 'node unrelated-green.mjs'; },
    () => { f.plan.findings[0].requirement = 'different'; },
    () => { f.plan.correction.report_sha256 = '0'.repeat(64); },
    () => { f.plan.correction.claim_generation++; },
    () => { f.plan.landing.claim_generation++; },
    () => { f.plan.findings[0].proof.claim_generation++; },
    () => { f.plan.project = '/foreign/.git'; },
    () => { f.plan.landing.head = f.base; },
    () => { f.rows.find(e => e.type === 'review.finding-linked').report_sha256 = '0'.repeat(64); },
    () => { f.rows.find(e => e.type === 'review.finding-linked').finding_key = 'missing'; },
    () => { f.rows.find(e => e.type === 'review.finding-linked').finding.text = 'changed'; },
    () => { f.rows.find(e => e.type === 'run.claimed' && e.run === 'R-3').project = '/foreign/.git'; },
    () => { f.rows.find(e => e.type === 'change.landed').producer.ownership_generation++; },
    () => { f.rows.find(e => e.type === 'item.added' && e.id === 'ENG-4').meta.hold = true; },
    () => { f.rows.find(e => e.type === 'item.added' && e.id === 'ENG-5').meta.operator_reserved = true; },
    () => { f.rows.push({ type: 'run.started', id: 'R-9', item: 'ENG-5', seq: 100 }); },
  ];
  for (const edit of edits) {
    edit(); assert.throws(f.intake); Object.assign(f.plan, structuredClone(snapshot)); f.rows.splice(0, f.rows.length, ...structuredClone(originalRows));
  }
  const reportFile = path.join(f.org, 'reports/R-2.md'), bytes = fs.readFileSync(reportFile);
  fs.appendFileSync(reportFile, 'changed'); assert.throws(f.intake, /report bytes/); fs.writeFileSync(reportFile, bytes);
  const gateFile = f.plan.findings[0].evidence, gateBytes = fs.readFileSync(gateFile);
  fs.unlinkSync(gateFile); assert.throws(f.intake); assert.deepEqual(f.rows, originalRows);
  fs.writeFileSync(gateFile, gateBytes); assert.ok(f.intake().add.length);
  f.git('update-ref', 'refs/heads/main', f.base); assert.throws(f.intake, /ancestry|main/);
  f.git('update-ref', 'refs/heads/main', f.checked); assert.ok(f.intake().add.length);
});

test('red, unrun, tampered log/execution/manifest and reverted source never consume the correction', t => {
  const f = fixture(t), originalGate = structuredClone(f.gate);
  for (const patch of [{ executed: false }, { exit_code: 1 }, { outcome: 'red' }, { tap_totals: undefined },
    { tap_totals: [{ pass: 0, fail: 1, cancelled: 0 }] }, { branch: 'lane/foreign' }, { tree: f.base }]) {
    Object.assign(f.gate, patch); f.save(); assert.throws(f.intake); Object.assign(f.gate, originalGate); f.save();
  }
  const log = fs.readFileSync(f.log), execution = fs.readFileSync(f.execution);
  fs.writeFileSync(f.log, 'tampered'); f.save(); assert.throws(f.intake, /log hash/); fs.writeFileSync(f.log, log); f.save();
  fs.writeFileSync(f.execution, JSON.stringify({ command_started: false, exit_code: 0, attempts: 1 })); f.save();
  assert.throws(f.intake, /execution/); fs.writeFileSync(f.execution, execution); f.save();
  fs.appendFileSync(f.check.manifest.evidence, 'tampered'); assert.throws(f.intake, /evidence hash/); f.save();
  fs.writeFileSync(path.join(f.repo, 'source'), 'broken\n'); f.git('commit', '-am', 'Revert correction');
  const reverted = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/heads/main', reverted);
  f.check.head = reverted; f.gate.head = reverted; f.gate.tree = f.git('rev-parse', `${reverted}^{tree}`); f.save();
  assert.throws(f.intake, /source is absent/);
  assert.equal(itemConditions(f.state(), 'ENG-4').Accepted.status, 'False');
});

test('later proof can belong to a separate run while original source and blocked outcome stay retained', t => {
  const f = fixture(t);
  f.add({ type: 'item.added', id: 'ENG-7', role: 'engineer' }); f.start('R-7', 'ENG-7', 'proof');
  f.report('R-7', { outcome: 'done' }); f.check.proof = f.reference('R-7');
  const result = f.apply();
  assert.equal(result.result.receipt.proof.run, 'R-7');
  assert.equal(result.result.receipt.retained_landing.run, 'R-3');
  assert.equal(itemConditions(f.state(), 'ENG-4').Accepted.status, 'True');
});

test('record entry requires actual supervisor authority and STOP/HOLD; refusal appends nothing', t => {
  const f = fixture(t), file = path.join(f.root, 'plan.json'); fs.writeFileSync(file, JSON.stringify(f.plan));
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ to: 'supervisor-fixture' }));
  let native = 'foreign', calls = 0;
  const invoke = () => reconcileCorrectionCommand(['--file', file], {
    openOrg: () => ({ dir: f.org }), out: () => {},
    sender: () => ({ project: { canonical: f.repo, identity: f.project }, org: f.org, native: { name: native } }),
    mutate: (ctx, fn) => { const result = fn(f.state(), f.rows); calls++; result.add.forEach(f.add); return result; },
  });
  assert.throws(invoke, /actual owning PROJECT SUPERVISOR/); assert.equal(calls, 0);
  native = 'supervisor-fixture'; fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.lane/supervisor/HOLD'), 'hold'); assert.throws(invoke, /STOP\/HOLD/); assert.equal(calls, 0);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/HOLD')); invoke(); assert.equal(calls, 1);
  invoke(); assert.equal(calls, 2); assert.equal(f.rows.filter(e => e.type === 'correction.discharged').length, 1);
});
