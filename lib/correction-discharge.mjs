// Evidence intake for the existing single formal correction, not another judge.
// Missing/red/unrun controls leave acceptance Unknown and retain the report.
import fs, { observeGitQuery } from './record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function evidenceOnlyHead(run, finding, gate, reviewedHead) {
  // No synthetic landing: prove this exact checked commit is already on main and
  // contains the reviewed head, using the owning run's original lane inventory,
  // not a worker declaration.
  if (!run.meta.lane || !/^[a-f0-9]{40}$/.test(finding.head) || gate.head !== finding.head ||
      gate.branch !== `lane/${run.meta.lane}` || !/^[a-f0-9]{64}$/.test(gate.key)) return false;
  const common = fs.realpathSync(run.meta.dispatch_project), directory = path.join(common, 'lane-validation');
  const receipt = gate.history_receipt ?? path.join(directory, `${gate.key}.json`);
  const expectedDirectory = gate.history_receipt ? path.join(directory, 'history', digest(JSON.stringify(gate.branch))) : directory;
  if (path.dirname(fs.realpathSync(receipt)) !== fs.realpathSync(expectedDirectory)) return false;
  const original = JSON.parse(fs.readFileSync(receipt));
  if (JSON.stringify(Object.entries(original).sort()) !== JSON.stringify(Object.entries(gate).sort())) return false;
  const at = Date.parse(gate.observed_at ?? gate.started_at), start = Date.parse(run.started.at);
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start ||
      run.report && !(at <= Date.parse(run.report.at))) return false;
  for (const file of [gate.log, gate.execution_receipt]) {
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(directory)) return false;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => observeGitQuery(JSON.stringify([common, args, []]), () =>
    execFileSync('git', args, { cwd: common, env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  return git(['rev-parse', '--path-format=absolute', '--git-common-dir']) === common &&
    git(['rev-parse', `${finding.head}^{commit}`]) === finding.head &&
    git(['rev-parse', `${finding.head}^{tree}`]) === gate.tree &&
    git(['merge-base', finding.head, 'refs/heads/main']) === finding.head &&
    git(['merge-base', reviewedHead, finding.head]) === reviewedHead;
}

function durableCopy(reference, root, original) {
  const file = fs.realpathSync(reference?.evidence);
  if (!file.startsWith(root + path.sep) || !fs.lstatSync(file).isFile()) throw Error('prior proof is not durable');
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== reference.sha256 || !bytes.equals(original)) throw Error('prior proof changed');
  return { evidence: file, sha256: reference.sha256 };
}

function priorChecks({ run, finding, gate, root }) {
  // Older non-lane consumers have no lane receipt inventory. Native lane runs
  // bind this inventory to their recorded Git common directory and branch.
  if (!run.meta.lane) return [];
  if (gate.branch !== `lane/${run.meta.lane}`) throw Error('receipt branch differs');
  const directory = path.join(fs.realpathSync(run.meta.dispatch_project), 'lane-validation');
  const history = path.join(directory, 'history', digest(JSON.stringify(gate.branch)));
  const files = gate.history_receipt ? [] : fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => path.join(directory, name));
  if (gate.history_receipt && path.dirname(fs.realpathSync(gate.history_receipt)) !== fs.realpathSync(history)) throw Error('history source differs');
  if (gate.history_receipt) {
    const observed = JSON.parse(fs.readFileSync(gate.history_receipt));
    if (Object.entries(observed).some(([key, value]) => JSON.stringify(gate[key]) !== JSON.stringify(value))) throw Error('final observation changed');
  }
  if (fs.existsSync(history)) files.push(...fs.readdirSync(history).filter(name => name.endsWith('.json')).map(name => path.join(history, name)));
  const start = Date.parse(run.started.at);
  if (!Number.isFinite(start)) throw Error('run start missing');
  const verified = [], seen = new Set();
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    let previous;
    try { previous = JSON.parse(bytes); }
    catch (error) { if (path.dirname(file) === history) throw error; else continue; }
    // New cache entries have independent immutable observations; legacy keyed
    // receipts remain discoverable until all producers use the new format.
    if (path.dirname(file) === directory && previous.history_receipt) continue;
    const at = Date.parse(previous.observed_at ?? previous.started_at);
    if (previous.schema !== 'lane-validation/v1' || previous.branch !== gate.branch || previous.command !== gate.command ||
        !Number.isFinite(at) || at < start || previous.head === gate.head && previous.log === gate.log) continue;
    const identity = `${previous.head}:${previous.log}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const saved = finding.prior_checks?.find(p => p.head === previous.head && p.sha256 === digest(bytes));
    if (!saved || saved.command !== previous.command || previous.head !== gate.head &&
        (saved.next_head !== gate.head || typeof saved.reason !== 'string' || !saved.reason.trim())) throw Error('prior check/head-change record missing');
    const receipt = durableCopy(saved, root, bytes);
    const log = durableCopy(saved.log, root, fs.readFileSync(previous.log));
    const execution = durableCopy(saved.execution_receipt, root, fs.readFileSync(previous.execution_receipt));
    if (digest(JSON.stringify(fs.readFileSync(log.evidence, 'utf8'))) !== previous.log_hash) throw Error('prior log differs');
    verified.push({ ...receipt, head: previous.head, next_head: saved.next_head, reason: saved.reason,
      command: previous.command, log, execution_receipt: execution });
  }
  return verified;
}
export function correctionDischargeEvents({ state, run, report, sha256, org }) {
  const item = state.items.get(run.item), declaration = report.extra?.correction_discharge;
  if (!item?.meta.review_fix_of || report.outcome !== 'done') return [];
  if (run.discharges?.some(e => e.report_sha256 === sha256 && e.claim_generation === run.owner_generation &&
      e.review_key === item.meta.review_fix_of)) return [];
  // Use the existing note event so sealed recovery readers need no capability
  // change. A refusal explains missing proof without discharging or rejecting
  // the report; unchanged repeated intake does not duplicate the diagnostic.
  const refuse = reason => {
    const text = `Correction discharge unavailable for report ${sha256}: ${reason}`;
    return run.notes?.some(n => n.text === text) ? [] : [{ type: 'note.added', id: run.id,
      kind: 'correction-discharge', text, decision: false }];
  };
  if (!declaration) return refuse('correction_discharge declaration is missing');
  if (declaration.review_key !== item.meta.review_fix_of || declaration.run !== run.id ||
      declaration.claim_generation !== run.owner_generation || run.owner_generation == null)
    return refuse('declaration review key, run or claim generation does not match the owner');
  const keys = item.meta.review_finding_keys ?? [];
  if (!keys.length || item.runs.at(-1) !== run.id) return refuse('assigned findings or current correction run are missing');
  let verified;
  try { verified = verifyCorrectionFindings({ state, run, item, declaration, org }); }
  catch (error) { return refuse(error.message); }
  return [{ type: 'correction.discharged', item: item.id, run: run.id, report_sha256: sha256,
    claim_generation: run.owner_generation, review_key: item.meta.review_fix_of, findings: verified }];
}

// Shared by ordinary report intake and explicit retained-landing reconciliation.
export function verifyCorrectionFindings({ state, run, item, declaration, org, proofRun = run, retained = false }) {
  const keys = item.meta.review_finding_keys ?? [], bindings = item.finding_bindings ?? [];
  const verified = [];
  const refuse = reason => { throw Error(reason); };
  let stage = 'original finding binding';
  try {
    for (const key of keys) {
      stage = `finding ${key}: original binding`;
      const finding = declaration.findings?.find(f => f.key === key);
      const original = bindings.find(b => b.finding_key === key && b.correction_item === item.id &&
        b.source_item === item.meta.review_source_item && b.review_run === item.created.run &&
        item.meta.review_fix_of === `${b.source_item}:${b.head}`);
      const reviewer = state.runs.get(original?.review_run), review = state.items.get(original?.review_item);
      if (!original || finding?.result !== 'PASS' || !finding.command?.trim() ||
          reviewer?.report?.sha256 !== original.report_sha256 || reviewer?.item !== original.review_item ||
          review?.meta.review_source_run !== item.meta.review_source_run ||
          original.finding.severity === 'major' && finding.requirement !== item.meta.review_correction_checks?.[key])
        return refuse(`${stage}, PASS result, command or required Major control does not match`);
      const landing = retained ? null : run.landings?.at(-1);
      if (landing && (landing.head !== finding.head || landing.project !== run.meta.dispatch_project ||
          landing.producer?.ownership_generation !== run.owner_generation))
        return refuse(`finding ${key}: landed head, project or ownership generation differs`);
      // Require durable proof in this owning record, independent of lane cleanup.
      stage = `finding ${key}: durable gate evidence`;
      const file = fs.realpathSync(finding.evidence), root = fs.realpathSync(path.join(org, 'evidence'));
      if (!file.startsWith(root + path.sep) || !fs.lstatSync(file).isFile()) return refuse(`${stage} is outside the owning record`);
      const bytes = fs.readFileSync(file), gate = JSON.parse(bytes);
      if (digest(bytes) !== finding.sha256) return refuse(`${stage} hash differs`);
      if (gate.schema !== 'lane-validation/v1') return refuse(`${stage} schema differs`);
      if (gate.head !== finding.head) return refuse(`finding ${key}: gate head differs from final head; a required rebase needs final-head proof`);
      if (gate.command !== finding.command) return refuse(`finding ${key}: gate command differs`);
      if (gate.executed !== true || gate.exit_code !== 0 || gate.signal != null || gate.outcome !== 'green' || gate.gate_timeout)
        return refuse(`finding ${key}: gate is unrun, failed, signalled or timed out`);
      if (gate.tap_totals !== null && (!Array.isArray(gate.tap_totals) ||
          gate.tap_totals.some(t => !t || t.fail > 0 || t.cancelled > 0))) return refuse(`finding ${key}: TAP totals are missing, malformed, failed or cancelled`);
      stage = `finding ${key}: evidence-only main ancestry, reviewed head and original receipt`;
      if (!landing && !evidenceOnlyHead(proofRun, finding, gate, original.head)) return refuse(`${stage} does not match`);
      stage = `finding ${key}: check log`;
      const output = fs.readFileSync(gate.log);
      // lane-validation/v1 hashes the JSON encoding of its UTF-8 log text.
      if (digest(JSON.stringify(output.toString('utf8'))) !== gate.log_hash) return refuse(`${stage} hash differs`);
      stage = `finding ${key}: execution receipt`;
      const execution = JSON.parse(fs.readFileSync(gate.execution_receipt));
      if (execution.command_started !== true || execution.exit_code !== 0 || execution.signal != null ||
          execution.gate_timeout || execution.cleanup_error || !(execution.attempts >= 1))
        return refuse(`finding ${key}: execution receipt does not prove a completed successful command`);
      stage = `finding ${key}: prior check preservation`;
      const prior = priorChecks({ run: proofRun, finding, gate, root });
      // Null totals say only that the log had no summary lines, not that the
      // command was declared non-TAP; keep that fact for the release owner.
      verified.push({ key, head: finding.head, command: finding.command, evidence: file, sha256: finding.sha256,
        finding_seq: original.seq, execution_receipt: gate.execution_receipt, prior_checks: prior,
        ...(gate.tap_totals === null ? { no_tap_summary: true } : {}) });
    }
  } catch (error) { throw Error(`${stage}: ${error.message}`); }
  return verified;
}

