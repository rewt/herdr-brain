// An explicit record writer for retained source plus later correction proof.
// It never ingests a replacement report or attributes source to the proof run.
import fs from './record-observation.mjs';
import scratchFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { observeGitQuery } from './record-observation.mjs';
import { UserError } from './store.mjs';
import { readReport } from './report.mjs';
import { readOwnedRun } from './run-owner-guard.mjs';
import { dispatchSourceBinding } from './source-provenance.mjs';
import { verifyCorrectionFindings } from './correction-discharge.mjs';
import { retainedCompletionEvents, stable } from './completion.mjs';
import { trialOwnerHold } from './item-launch-hold.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { readProjectPolicy } from './config-policy.mjs';
import { lineDirectory } from '../line-service/cutoff.mjs';
import { reviewFindingKey } from '../line-service/review-findings.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = text => { throw new UserError(`retained correction: ${text}`); };
const sha = value => /^[a-f0-9]{64}$/.test(value ?? '');

function immutableReport(org, run, expected) {
  if (!run?.report || !sha(expected) || run.report.sha256 !== expected) fail('report binding differs');
  const root = fs.realpathSync(path.join(org, 'reports'));
  const file = fs.realpathSync(path.resolve(org, run.report.file ?? `reports/${run.id}.md`));
  const bytes = fs.readFileSync(file);
  if (!file.startsWith(root + path.sep) || digest(bytes) !== expected) fail('immutable report bytes differ');
  const parsed = readReport(bytes.toString('utf8'));
  if (parsed.errors.length || parsed.report.run !== run.id || parsed.report.outcome !== run.report.outcome)
    fail('immutable report identity or outcome differs');
  return parsed.report;
}

function originalRun(state, events, org, project, reference) {
  const run = state.runs.get(reference?.run);
  if (!run || run.item !== reference.item || run.owner_generation !== reference.claim_generation)
    fail('run, item or original claim differs');
  readOwnedRun(org, run.id, events);
  dispatchSourceBinding({ run, events, identity: project, org });
  return { run, report: immutableReport(org, run, reference.report_sha256) };
}

function durableEvidence(org, check) {
  const root = fs.realpathSync(path.join(org, 'evidence'));
  const read = ref => {
    const file = fs.realpathSync(ref?.evidence), bytes = fs.readFileSync(file);
    if (!file.startsWith(root + path.sep) || !fs.lstatSync(file).isFile() || digest(bytes) !== ref.sha256)
      fail('durable evidence hash or location differs');
    return { file, bytes };
  };
  const manifest = read(check.manifest), entries = JSON.parse(manifest.bytes);
  if (!entries || Array.isArray(entries) || !Object.keys(entries).length) fail('manifest is empty');
  for (const [name, hash] of Object.entries(entries)) {
    if (path.basename(name) !== name || !sha(hash)) fail('manifest entry differs');
    read({ evidence: path.join(path.dirname(manifest.file), name), sha256: hash });
  }
  const gate = JSON.parse(read(check).bytes);
  for (const [ref, original] of [[check, check.evidence], [check.log, gate.log], [check.execution_receipt, gate.execution_receipt]]) {
    const saved = read(ref);
    if (path.dirname(saved.file) !== path.dirname(manifest.file) || entries[path.basename(saved.file)] !== ref.sha256 ||
        !saved.bytes.equals(fs.readFileSync(original))) fail('manifest or original gate/log/execution differs');
  }
  return gate;
}

function retainedSource(project, landing, checked, reviewed) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = args => observeGitQuery(JSON.stringify([project, args, []]), () =>
    execFileSync('git', args, { cwd: project, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  if (git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim() !== project ||
      git(['merge-base', landing.base, landing.head]).trim() !== landing.base ||
      git(['merge-base', landing.head, checked]).trim() !== landing.head)
    fail('retained landing ancestry differs');
  // A landing already inside the reviewed head is part of what was reviewed.
  if (git(['merge-base', reviewed, landing.base]).trim() !== reviewed) fail('retained landing does not follow the reviewed head');
  // An ancestor can have been reverted. Reverse-check the original patch in a
  // scratch copy of only its paths at the checked commit; no index/worktree edit.
  const patch = git(['diff', '--binary', '--full-index', landing.base, landing.head]);
  if (!patch.trim()) fail('retained landing has no source change');
  const files = git(['diff', '--name-only', '-z', landing.base, landing.head]).split('\0').filter(Boolean);
  const directory = scratchFs.mkdtempSync(path.join(os.tmpdir(), 'retained-correction-'));
  try {
    for (const file of files) {
      const destination = path.resolve(directory, file);
      if (!destination.startsWith(directory + path.sep)) fail('unsafe retained source path');
      const mode = git(['ls-tree', checked, '--', file]).split(' ')[0];
      if (!mode) continue;
      if (!['100644', '100755'].includes(mode)) fail('retained source needs an ordinary file');
      scratchFs.mkdirSync(path.dirname(destination), { recursive: true });
      scratchFs.writeFileSync(destination, git(['show', `${checked}:${file}`]));
    }
    execFileSync('git', ['apply', '--reverse', '--check', '-'], { cwd: directory, env, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) { fail(`retained source is absent at checked head: ${error.message}`); }
  finally { scratchFs.rmSync(directory, { recursive: true, force: true }); }
}

export function retainedCorrectionEvents({ state, events, plan, org, authority }) {
  if (plan?.version !== 1 || !/^[\w.:-]+$/.test(plan.id ?? '') || plan.org !== org ||
      plan.project !== authority?.project || authority.org !== org || !plan.why?.trim()) fail('resolution identity or authority differs');
  const fingerprint = digest(stable(plan));
  const previous = events.find(e => e.type === 'correction.discharged' && e.resolution_id === plan.id);
  if (previous) {
    if (previous.resolution_sha256 !== fingerprint) fail('resolution ID already has different inputs');
    return { add: [], result: { replayed: true, receipt: previous } };
  }
  const { run, report } = originalRun(state, events, org, plan.project, plan.correction);
  const item = state.items.get(run.item), declaration = report.extra?.correction_discharge;
  if (!['done', 'blocked'].includes(report.outcome) || item.runs.at(-1) !== run.id ||
      !declaration || declaration.run !== run.id || declaration.claim_generation !== run.owner_generation ||
      declaration.review_key !== item.meta.review_fix_of || item.meta.review_fix_of !== plan.review_key ||
      !(item.meta.review_finding_keys?.length) || plan.findings?.length !== item.meta.review_finding_keys.length)
    fail('current correction report or original finding declaration differs');
  const { run: producer } = originalRun(state, events, org, plan.project, plan.landing);
  const landing = producer.landings?.find(l => l.seq === plan.landing.seq);
  if (!landing || landing.head !== plan.landing.head || landing.base !== plan.landing.base ||
      landing.project !== plan.project || landing.producer?.ownership_generation !== producer.owner_generation ||
      ![item.id, item.meta.review_source_item].includes(producer.item)) fail('retained landing or producer generation differs');
  const verified = [], proofs = [];
  for (const key of item.meta.review_finding_keys) {
    const finding = plan.findings.find(f => f.key === key), original = declaration.findings?.find(f => f.key === key);
    const binding = item.finding_bindings?.find(b => b.finding_key === key);
    const reviewer = state.runs.get(binding?.review_run);
    immutableReport(org, reviewer, binding?.report_sha256);
    const review = state.items.get(binding.review_item), captured = events.find(e => e.seq === review?.created.seq);
    if (!captured?.meta?.review_target || stable(captured.meta.review_target) !== stable(review.meta.review_target) ||
        reviewFindingKey({ meta: captured.meta }, binding.finding) !== key)
      fail('immutable review target or finding content differs');
    if (!finding || finding.command !== original?.command || finding.requirement !== original?.requirement)
      fail('original required command or finding differs');
    const required = binding.finding.severity === 'major' ? report.extra?.correction_supporting_checks ?? [] : [];
    const controls = [finding, ...(finding.supporting_checks ?? [])];
    if (required.some(r => !controls.some(c => c.command === r.command))) fail('required supporting control is missing');
    for (const control of controls) {
      const { run: proofRun } = originalRun(state, events, org, plan.project, control.proof);
      durableEvidence(org, control);
      retainedSource(plan.project, landing, control.head, binding.head);
      const findings = verifyCorrectionFindings({ state, run, item: { ...item, meta: { ...item.meta, review_finding_keys: [key] } },
        declaration: { findings: [{ ...control, key, requirement: finding.requirement }] }, org, proofRun, retained: true });
      verified.push(...findings);
      proofs.push({ run: proofRun.id, claim_generation: proofRun.owner_generation, report_sha256: proofRun.report.sha256,
        manifest: control.manifest, log: control.log, execution_receipt: control.execution_receipt });
    }
  }
  const discharge = { type: 'correction.discharged', item: item.id, run: run.id, report_sha256: run.report.sha256,
    claim_generation: run.owner_generation, review_key: item.meta.review_fix_of, findings: verified,
    resolution_kind: 'retained-landing/v1', resolution_id: plan.id, resolution_sha256: fingerprint, why: plan.why,
    original_outcome: report.outcome, retained_landing: { ...landing, report_sha256: producer.report.sha256 }, proof: proofs[0], proofs,
    authority };
  const entries = [{ item: item.id, run: run.id, expected: plan.expected, why: plan.why }, ...(plan.duplicates ?? []).map(d => ({ ...d, duplicate: true }))];
  for (const entry of entries) {
    const hold = trialOwnerHold(state, entry.item);
    if (hold) fail(hold.reason);
  }
  const add = [discharge];
  for (const entry of entries) add.push(...retainedCompletionEvents(state, [...events, ...add], { ...entry, discharge }));
  return { add, result: { replayed: false, receipt: discharge, completed: entries.map(e => e.item) } };
}

export function reconcileCorrectionCommand(argv, { openOrg, mutate, out, sender = nativeSender }) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { file: { type: 'string' } } });
  if (positionals.length || !values.file) fail('usage: record reconcile-correction --file JSON');
  const ctx = openOrg({ readOnly: true }), plan = JSON.parse(fs.readFileSync(values.file));
  const { result } = mutate(ctx, (state, events) => {
    const binding = sender(ctx.dir), repo = binding.project.canonical;
    const env = { ...process.env };
    for (const key of ['LANE_CONFIG', 'PROMOTE_CONFIG', 'MONITOR_SUPERVISOR_AGENT']) delete env[key];
    const supervisor = readProjectPolicy(repo, 'promote', env, { canonical: repo }).config.to;
    if (!supervisor || binding.native.name !== supervisor) fail('requires the actual owning PROJECT SUPERVISOR');
    for (const file of [path.join(lineDirectory(ctx.dir, binding.project.identity), 'STOP'),
      path.join(repo, '.lane/supervisor/STOP'), path.join(repo, '.lane/supervisor/HOLD')])
      if (fs.existsSync(file)) fail('STOP/HOLD prevents reconciliation');
    return retainedCorrectionEvents({ state, events, plan, org: ctx.dir,
      authority: { native_caller: binding.native, project: binding.project.identity, org: binding.org } });
  });
  out(JSON.stringify(result) + '\n');
}
