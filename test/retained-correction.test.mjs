import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initOrg, loadEvents } from '../lib/store.mjs';
import { fold, itemConditions, itemStatus, dependencyReleases, retainedCorrectionResolution } from '../lib/state.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { retainedCorrectionEvents, reconcileCorrectionCommand } from '../lib/retained-correction.mjs';
import { requireCorrectedMajors } from '../lib/consumer-offer.mjs';
import { reviewFindingKey } from '../line-service/review-findings.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = 'node test/helpers/run.mjs --test-name-pattern="^exact required witness$" test/witness.test.mjs';
const cli = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));

// Synthetic historical receipts exercise the writer. They execute no old
// correction control and are never offered as live product acceptance proof.
function fixture(t, { supportingChecks } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-writer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  const repo = path.join(root, 'repo'), org = path.join(root, '.org');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(org, 'reports'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'seed'), 'seed\n'); git('add', '.'); git('commit', '-m', 'Seed');
  const seed = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'older'), 'older\n'); git('add', '.'); git('commit', '-m', 'Earlier landing');
  const earlier = git('rev-parse', 'HEAD');
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
    run: 'R-4', claim_generation: generation, review_key: `ENG-1:${base}`, findings: [structuredClone(check)] },
    ...(supportingChecks ? { correction_supporting_checks: supportingChecks } : {}) });
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
  // An independent control with its own gate, log, execution sidecar and manifest.
  const control = (name, controlCommand, patch = {}) => {
    const saved = path.join(archive, name), output = path.join(directory, `${name}.log`), sidecar = `${output}.execution.json`, text = `ok 1 - ${name}\n`;
    fs.mkdirSync(saved, { recursive: true }); fs.writeFileSync(output, text);
    fs.writeFileSync(sidecar, JSON.stringify({ command_started: true, exit_code: 0, signal: null, attempts: 1 }));
    const record = { ...gate, key: hash(name), command: controlCommand, log: output, log_hash: hash(JSON.stringify(text)), execution_receipt: sidecar, ...patch };
    fs.writeFileSync(path.join(directory, `${record.key}.json`), JSON.stringify(record));
    const files = { gate: path.join(saved, 'gate.json'), log: path.join(saved, 'run.log'), execution: path.join(saved, 'execution.json') };
    fs.writeFileSync(files.gate, JSON.stringify(record)); fs.copyFileSync(output, files.log); fs.copyFileSync(sidecar, files.execution);
    const ref = file => ({ evidence: file, sha256: hash(fs.readFileSync(file)) });
    const entries = Object.fromEntries(Object.values(files).map(file => [path.basename(file), ref(file).sha256]));
    fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify(entries));
    return { result: 'PASS', head: checked, command: controlCommand, ...ref(files.gate), log: ref(files.log), execution_receipt: ref(files.execution),
      manifest: ref(path.join(saved, 'manifest.json')), proof: reference('R-4') };
  };
  const intake = () => retainedCorrectionEvents({ state: state(), events: rows, plan, org, authority });
  const apply = () => { const result = intake(); result.add.forEach(add); return result; };
  return { root, repo, org, project, rows, state, add, report, start, reference, plan, authority, intake, apply, gate, check, save, git, log, execution, base, head, checked, seed, earlier, control };
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

test('writer refuses a retained landing that does not follow the reviewed head', t => {
  const f = fixture(t), generation = f.state().runs.get('R-3').owner_generation;
  const earlier = f.add({ type: 'change.landed', item: 'ENG-1', run: 'R-3', project: f.project, head: f.earlier, base: f.seed,
    producer: { ownership_generation: generation } });
  f.plan.landing = { ...f.plan.landing, seq: earlier.seq, head: f.earlier, base: f.seed };
  assert.throws(f.intake, /does not follow the reviewed head/);
});

test('every named supporting check needs its own green control, which an offer also has to contain', t => {
  const vm = 'node test/helpers/run.mjs test/vm-control.test.mjs';
  // The real report shape: the witness and a red control listed side by side.
  const f = fixture(t, { supportingChecks: [{ name: 'witness-green', command, exit_code: 0 }, { name: 'vm-control-red', command: vm, exit_code: 1 }] });
  assert.throws(f.intake, /required supporting control is missing/);
  f.plan.findings[0].supporting_checks = [f.control('vm', vm, { exit_code: 1, outcome: 'red' })];
  assert.throws(f.intake, /gate is unrun, failed/);
  f.plan.findings[0].supporting_checks = [f.control('vm', 'node unrelated-green.mjs')];
  assert.throws(f.intake, /required supporting control is missing/);
  f.plan.findings[0].supporting_checks = [f.control('vm', vm)];
  const receipt = f.apply().result.receipt;
  assert.deepEqual(receipt.findings.map(row => row.command), [command, vm]);
  assert.equal(receipt.proofs.length, 2);
  assert.equal(itemConditions(f.state(), 'ENG-4').Accepted.status, 'True');
  const offer = () => requireCorrectedMajors(f.state(), { commit: f.checked, majors: { corrections: [{ item: 'ENG-4' }] } }, f.repo);
  offer();
  const later = f.git('commit-tree', `${f.checked}^{tree}`, '-p', f.checked, '-m', 'Later supporting proof');
  f.rows.find(e => e.type === 'correction.discharged').findings[1].head = later;
  assert.throws(offer, /unresolved or unaccounted recorded Major: ENG-4/);
});

test('offer check accepts a verified retained correction and refuses unproven forms', t => {
  const refused = /unresolved or unaccounted recorded Major: ENG-4/;
  const offer = (f, commit = f.checked, items = ['ENG-4']) =>
    requireCorrectedMajors(f.state(), { commit, majors: { corrections: items.map(item => ({ item })) } }, f.repo);
  const f = fixture(t);
  assert.throws(() => offer(f), refused);
  f.apply();
  assert.equal(f.state().runs.get('R-4').report.outcome, 'blocked'); assert.equal(f.state().runs.get('R-4').landings, undefined);
  offer(f);
  assert.throws(() => offer(f, f.checked, []), refused);
  assert.throws(() => offer(f, f.head), refused);
  assert.throws(() => offer(f, f.base), refused);
  const receipt = f.rows.find(e => e.type === 'correction.discharged'), original = structuredClone(receipt);
  // A real landing of the producer outside the packet commit, otherwise fully verified.
  const side = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'Unrelated side landing');
  const outside = f.add({ type: 'change.landed', item: 'ENG-1', run: 'R-3', project: f.project, head: side, base: f.base,
    producer: { ownership_generation: f.state().runs.get('R-3').owner_generation } });
  receipt.retained_landing = { ...receipt.retained_landing, seq: outside.seq, head: side };
  const held = () => { const s = f.state(), item = s.items.get('ENG-4'); return retainedCorrectionResolution(s, item, s.runs.get('R-4')); };
  assert.ok(held());
  assert.throws(() => offer(f), refused);
  Object.assign(receipt, structuredClone(original));
  receipt.resolution_sha256 = 'not-a-verified-resolution';
  assert.equal(held(), undefined);
  assert.throws(() => offer(f), refused);
  Object.assign(receipt, structuredClone(original));
  offer(f);
  f.add({ type: 'item.reopened', id: 'ENG-4' });
  assert.ok(held());
  assert.throws(() => offer(f), refused);

  // The ordinary done same-run discharge keeps its own path.
  const g = fixture(t), generation = g.start('R-8', 'ENG-4', 'proof');
  g.add({ type: 'change.landed', item: 'ENG-4', run: 'R-8', project: g.project, head: g.checked, base: g.head, producer: { ownership_generation: generation } });
  const done = g.report('R-8', { outcome: 'done' }), binding = g.state().items.get('ENG-4').finding_bindings[0];
  g.add({ type: 'correction.discharged', item: 'ENG-4', run: 'R-8', report_sha256: done.sha256, claim_generation: generation,
    review_key: `ENG-1:${g.base}`, findings: [{ key: binding.finding_key, head: g.checked, finding_seq: binding.seq }] });
  offer(g);
  assert.throws(() => offer(g, g.checked, []), refused);
  assert.throws(() => offer(g, g.head), refused);
});

// The cases above inject mutate, so none of them shares one observation scope.
// This one spawns the actual command: native sender, mutate and planTransaction.
test('record command applies once through its real planned transaction, after a refusal and with a replay', t => {
  const f = fixture(t), file = path.join(f.root, 'plan.json'), log = path.join(f.org, 'events.jsonl'), bin = path.join(f.root, 'bin');
  fs.writeFileSync(file, JSON.stringify(f.plan));
  fs.writeFileSync(path.join(f.root, '.identity-root'), '');
  initOrg(f.org);
  fs.writeFileSync(log, f.rows.map(row => JSON.stringify(row) + '\n').join(''));
  const agent = { name: 'supervisor-fixture', terminal_id: 'terminal-fixture', agent_session: { value: 'session-fixture' },
    pane_id: 'fixture:p1', workspace_id: 'fixture', cwd: f.repo };
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get'&&a[2]===${JSON.stringify(agent.pane_id)})console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));else process.exit(1);
`, { mode: 0o755 });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'HERDR_BRAIN_ROOT')),
    ORG_DIR: f.org, ORG_ACTOR: agent.name, HERDR_ENV: '1', HERDR_PANE_ID: agent.pane_id, HERDR_WORKSPACE_ID: agent.workspace_id,
    CODEX_THREAD_ID: agent.agent_session.value, PATH: `${bin}:${process.env.PATH}` };
  const invoke = () => spawnSync(process.execPath, [cli, 'reconcile-correction', '--file', file], { cwd: f.repo, env, encoding: 'utf8' });
  const hold = path.join(f.repo, '.lane/supervisor/HOLD'), before = fs.readFileSync(log);
  fs.mkdirSync(path.dirname(hold), { recursive: true }); fs.writeFileSync(hold, 'hold');
  const refused = invoke();
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /STOP\/HOLD/);
  assert.deepEqual(fs.readFileSync(log), before);
  fs.unlinkSync(hold);
  const applied = invoke();
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout), saved = () => loadEvents(f.org).events;
  assert.equal(result.replayed, false); assert.deepEqual(result.completed, ['ENG-4', 'ENG-5']);
  assert.equal(saved().filter(e => e.type === 'correction.discharged').length, 1);
  assert.equal(itemConditions(fold(saved()), 'ENG-4').Accepted.status, 'True');
  const committed = fs.readFileSync(log), replay = invoke();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.deepEqual(fs.readFileSync(log), committed);
});
