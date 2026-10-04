// Model-free notice policy. Only existing CLIs mutate the record or cycle.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { loadEvents, readConfig, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { readReport } from '../lib/report.mjs';
import { approvalPolicy, reportCategoryFlags } from '../lib/discernment.mjs';
import { readConfig as housekeepingConfig } from '../housekeeping/config.mjs';
import { receiptDirectory } from './context.mjs';
import { noticeLock } from './notice-lock.mjs';
import { queueJobs } from '../promote/promote.mjs';

export const POLICY = 'notice-autopilot/v1';
const local = name => fileURLToPath(new URL(name, import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const line = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
const entries = value => value == null ? [] : Array.isArray(value) ? value : [value];
const fields = (report, name) => entries(report?.[name] ?? report?.extra?.[name]);
const moved = result => result?.result === 'escalate' && result.reason === 'base branch moved; use --retry to recapture and rebase';

export function autopilotSettings(repo) {
  const file = path.join(repo, '.supervisor.json'), config = fs.existsSync(file) ? read(file) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => k !== 'autopilot')) throw Error('invalid supervisor config');
  const policy = config.autopilot === undefined ? {} : config.autopilot;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => k !== 'enabled') ||
      (policy.enabled !== undefined && typeof policy.enabled !== 'boolean')) throw Error('autopilot.enabled must be true|false');
  return { enabled: policy.enabled !== false, file };
}

function execute(file, args, options) {
  return spawnSync(process.execPath, [file, ...args], { ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function authority(project, runId, { pendingReport = false } = {}) {
  const live = gitProject(project.repo);
  if (live.identity !== project.identity || live.canonical !== project.repo || fs.realpathSync(project.org) !== project.org) throw Error('autopilot project binding changed');
  if (!autopilotSettings(project.repo).enabled) throw Error('autopilot disabled in project config');
  if (fs.existsSync(path.join(project.repo, '.lane/supervisor/STOP'))) throw Error('STOP disables autopilot');
  if (!housekeepingConfig(path.join(project.repo, '.housekeeping.json')).enabled) throw Error('paused housekeeping disables autopilot');
  const { events, tornTail } = loadEvents(project.org);
  if (tornTail) throw Error('incomplete record event; inspect');
  const state = fold(events), config = readConfig(project.org);
  if (approvalPolicy(config, 'tooling') !== 'auto') throw Error('tooling actions require operator authority');
  if (!runId) return { state };
  const run = state.runs.get(runId), item = run && state.items.get(run.item);
  if (!run || !item || run.abandoned || item.runs.at(-1) !== runId) throw Error('unknown, abandoned or superseded run');
  if (item.role === 'human' || item.meta.operator_reserved || ['publish', 'priorities'].includes(item.meta.category) ||
      (item.meta.category && approvalPolicy(config, item.meta.category) !== 'auto')) throw Error('operator-reserved item or category');
  if (item.closed && (item.closed.as !== 'done' || item.closed.seq < (run.report?.seq ?? Infinity))) throw Error('item closure requires inspection');
  if (!item.closed && events.some(e => e.type === 'item.closed' && e.id === item.id && e.seq > (run.report?.seq ?? Infinity))) throw Error('item reopened after completion');
  // Watch checks the worker file; handle owns conditional, immutable intake.
  // Only that first handle may use a preflight of the run-bound file. Every
  // subsequent mutation must have an immutable report in the event fold.
  let report = run.report;
  if (!report && pendingReport) {
    const parsed = readReport(fs.readFileSync(run.report_path, 'utf8'));
    if (parsed.errors.length || parsed.report.run !== runId) throw Error(`invalid report for ${runId}: ${parsed.errors.join('; ') || 'run field mismatch'}`);
    report = parsed.report;
  }
  if (!report || report.outcome !== 'done' || fields(report, 'questions').length || entries(report.blockers).length) throw Error('worker outcome, questions or blockers need judgment');
  for (const decision of fields(report, 'decisions')) {
    if (!decision?.category || ['publish', 'priorities'].includes(decision.category) || approvalPolicy(config, decision.category) !== 'auto') throw Error('report decision needs operator judgment');
  }
  if (reportCategoryFlags(config, report).length) throw Error('report category evidence needs inspection');
  let identity;
  try { identity = run.workspace && gitProject(run.workspace).identity; }
  catch {
    const settle = read(path.join(project.org, 'settle', `${runId}.json`));
    const dispatch = run.meta.dispatch_journal && read(run.meta.dispatch_journal);
    identity = settle?.run === runId ? settle.common : dispatch?.run === runId && dispatch.workspace === run.workspace ? dispatch.common : null;
  }
  if (identity !== project.identity) throw Error('run has no verified project binding');
  return { state, run, item };
}

function findings(text) {
  const rows = typeof text === 'string' ? text.trim().split('\n').filter(s => s.trim()) : [];
  if (!rows.length || rows.some(s => !/^- \[(Moderate|Minor)\] .+:[1-9][0-9]* - .+; Fix: .+$/.test(s))) return false;
  return true;
}

// A receipt is an action journal, never work status. Intent precedes every
// command; a lost reply wakes the supervisor instead of replaying side effects.
export function autopilotNotice(entry, { execute: call = execute } = {}) {
  if (!entry.project) return null; // Unbound/legacy transports retain delivery.
  const project = entry.project;
  const report = /^\[org-report\] run=(R-\d+) item=(\S+) outcome=(done|blocked|needs_human|failed) headline=/.exec(entry.message);
  const promotion = /^\[promote-queue\] id=([a-zA-Z0-9-]+) lane=(\S+) outcome=(\S+)(?: |$)/.exec(entry.message);
  const key = report ? `report:${report[1]}` : promotion ? `promotion:${promotion[1]}` : `notice:${entry.id}`;
  const file = path.join(receiptDirectory(project.org, project.identity), 'autopilot', `${digest(key)}.json`);
  let receipt = { policy: POLICY, key, project, notice: entry.message, notice_id: entry.id, actions: [], started: new Date().toISOString() }, release;
  const save = () => writeFileAtomic(file, JSON.stringify(receipt, null, 2) + '\n', 0o600);
  // Keep the fixed report envelope so existing foreground handle callers can
  // route an exception; narrative is replaced by bounded policy evidence.
  const summary = reason => report ? `[org-report] run=${report[1]} item=${report[2]} outcome=${report[3]} headline=autopilot: ${line(reason)} receipt=${file}`
    : `[autopilot] ${promotion?.[1] ?? 'notice'} ${line(reason)} receipt=${file}`;
  const finish = (disposition, reason) => {
    receipt.disposition = disposition; receipt.reason = line(reason); receipt.finished = new Date().toISOString(); save();
    return { disposition, receipt: file, summary: summary(reason) };
  };
  let runId;
  try {
    release = noticeLock(`${file}.lock`);
    let prior;
    try { prior = read(file); }
    catch (error) { return { disposition: 'wake', receipt: file, summary: summary(`unreadable action receipt: ${error.message}`) }; }
    if (prior) {
      if (prior.key !== key || prior.policy !== POLICY || JSON.stringify(prior.project) !== JSON.stringify(project)) return { disposition: 'wake', receipt: file, summary: summary('autopilot receipt binding changed') };
      receipt = prior;
    }
    authority(project);
    if (report) {
      if (report[3] !== 'done') return finish('wake', `worker reported ${report[3]}`);
      runId = report[1];
      const { run } = authority(project, runId, { pendingReport: true });
      if (run.item !== report[2]) throw Error('notice item differs from record');
    } else if (promotion) {
      if (promotion[3] !== 'promoted') return finish('wake', `promotion ${promotion[3]}`);
      const queue = read(path.join(project.identity, 'promote/queue.json'));
      if (queue?.identity !== project.identity) throw Error('promotion queue binding missing or changed');
      const job = queueJobs(queue).find(j => j.id === promotion[1]);
      if (!job || job.outcome !== 'promoted' || job.topic !== promotion[2] || job.org !== project.org) throw Error('promotion notice differs from queue receipt');
      runId = job.run;
      const { item } = authority(project, runId);
      if (item.closed?.as === 'done') return finish('handled', 'promotion already closed');
    } else return finish('wake', `unrecognised notice: ${line(entry.message)}`);
    if (receipt.actions.some(a => a.phase !== 'acknowledged')) return finish('wake', 'uncertain autopilot command; inspect before recovery');
    if (receipt.actions.length && !receipt.disposition) return finish('wake', 'interrupted autopilot sequence; inspect acknowledged actions');
    if (receipt.disposition) return { disposition: receipt.disposition, receipt: file,
      summary: summary(receipt.reason) };
    const command = (name, file, args, { json = true, pendingReport = false } = {}) => {
      authority(project, runId, { pendingReport }); // Re-read STOP, pause, authority and record.
      const action = { name, file, args, phase: 'started', at: new Date().toISOString() };
      receipt.actions.push(action); save();
      const reply = call(file, args, { cwd: project.repo, env: { ...process.env, ORG_DIR: project.org, ORG_ACTOR: 'supervisor-autopilot' } });
      // Legacy/injected executors return stdout for successful calls. The
      // native executor retains the exit and streams, including refusals.
      const r = typeof reply === 'string' ? { status: 0, stdout: reply } : reply;
      action.exit_code = r.status ?? null; action.stderr = r.stderr ?? ''; action.signal = r.signal ?? null;
      if (r.error) action.error = r.error.message;
      const stdout = r.stdout ?? '';
      let result;
      try { result = json ? JSON.parse(stdout) : stdout.trim(); }
      catch (error) { action.output = stdout; save(); throw error; }
      action.result = result;
      if (r.error || r.signal || r.status !== 0) {
        action.output = stdout; save();
        const journal = path.join(project.org, 'settle', `${runId}.json`);
        const saved = json && !promotion && args[0] === 'handle' && moved(result) && result.run === runId && result.journal === journal ? read(journal) : null;
        // Settle exits one for this precise recoverable refusal. Bind it to
        // the retained receipt; arbitrary exit-one JSON is never authority.
        if (r.error || r.signal || r.status !== 1 || saved?.common !== project.identity || saved.run !== runId || saved.org !== project.org || saved.error !== result.reason)
          throw Error(`${path.basename(file)}: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
      }
      action.phase = 'acknowledged'; action.finished = new Date().toISOString(); save();
      return result;
    };
    const args = ['--repo', project.repo, '--org', project.org, '--role', 'supervisor', '--to', entry.to];
    const supervisor = local('./supervisor.mjs');
    if (promotion) {
      const result = command('close promoted item', supervisor, ['handle', '--notice', entry.message, ...args]);
      return finish(result.result === 'recorded_promotion' ? 'handled' : 'wake', result.result ?? 'unknown promotion result');
    }
    const saved = read(path.join(project.org, 'settle', `${runId}.json`));
    if (saved && (saved.common !== project.identity || saved.run !== runId || (saved.stage !== 'complete' && !moved(saved.result)))) throw Error('uncertain or interrupted settlement; inspect retained receipt');
    let result = command('handle done report', supervisor, ['handle', runId, ...args], { pendingReport: true });
    if (result.review?.verdict === 'FAIL') return finish('wake', 'review FAIL');
    if (moved(result) && !receipt.retry_used) {
      receipt.retry_used = true; save();
      result = command('retry base movement once', supervisor, ['handle', runId, '--retry', '--repo', project.repo, '--org', project.org, '--role', 'supervisor']);
    }
    if (result.review?.verdict === 'FAIL') return finish('wake', 'review FAIL');
    const settled = read(path.join(project.org, 'settle', `${runId}.json`));
    const reviewText = settled?.review?.text ?? '';
    const policy = result.review_policy;
    if (policy?.cap > 0 && policy.round >= policy.cap && /\[Major\]/.test(result.findings ?? reviewText)) return finish('wake', 'Major findings at review cap');
    if (result.result === 'fix_round' && policy?.cap > 0 && policy.round >= policy.cap && result.review?.verdict === 'NEEDS-WORK') return finish('wake', 'correction findings at review cap require judgment');
    if (result.result === 'fix_round') return finish('handled', 'watched fix already dispatched');
    if (result.result === 'recorded_promotion') return finish('handled', 'promotion recorded');
    const accepted = result.result === 'promotable_with_findings';
    if (result.result !== 'promotable' && !accepted) return finish('wake', `${result.result ?? 'unknown result'}: ${result.reason ?? 'inspect evidence'}`);
    if (!accepted && result.review?.verdict !== 'PASS') return finish('wake', 'promotable result lacks PASS');
    if (accepted && (result.review?.verdict !== 'NEEDS-WORK' || !findings(result.findings) || !(policy?.cap > 0 && policy.round >= policy.cap))) return finish('wake', 'capped findings are not proved Moderate/Minor');
    if (accepted) {
      receipt.follow_up = command('file findings follow-up', local('../bin/org.mjs'), ['add', `Review follow-up for ${runId}`, '--parent', report[2],
        '--role', 'engineer', '--capability', 'tooling', '--meta', `autopilot_key=${key}`, `--accept=${result.findings}`], { json: false });
      if (!/^ENG-\d+$/.test(receipt.follow_up)) throw Error('follow-up response is uncertain');
    }
    const why = `${POLICY}: ${accepted ? `accept capped Moderate/Minor findings; follow-up ${receipt.follow_up}` : 'PASS promotes'}; project tooling authority is auto; settle and queue recheck readiness`;
    const promoted = command('enqueue promotion', supervisor, ['promote', runId, ...(accepted ? ['--accept-findings'] : []), '--why', why, ...args]);
    if (promoted.phase !== 'acknowledged') return finish('wake', promoted.reason ?? promoted.result ?? 'promotion enqueue not acknowledged');
    return finish('handled', accepted ? `findings filed in ${receipt.follow_up}; promotion queued` : 'PASS promotion queued');
  } catch (error) {
    // A contending/live owner must retain its receipt untouched.
    if (!release) return { disposition: 'wake', receipt: file, summary: `[autopilot] ${line(error.message)} receipt=${file}` };
    receipt.error = error.message; // Keep full diagnostic evidence behind the compact wake.
    return finish('wake', error.message);
  } finally { release?.(); }
}
