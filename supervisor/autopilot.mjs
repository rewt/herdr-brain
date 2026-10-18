// Model-free notice policy. Only existing CLIs mutate the record or cycle.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { loadEvents, readConfig, writeFileAtomic } from '../lib/store.mjs';
import { bundleRelease } from '../lib/releases.mjs';
import { fold } from '../lib/state.mjs';
import { readReport } from '../lib/report.mjs';
import { approvalPolicy, reportCategoryFlags } from '../lib/discernment.mjs';
import { readConfig as housekeepingConfig } from '../housekeeping/config.mjs';
import { receiptDirectory } from './context.mjs';
import { noticeLock } from './notice-lock.mjs';
import { cleanPassScope } from './clean-pass.mjs';
import { greenIdentity, greenPassScope } from './green-pass.mjs';
import { fastPathTiming } from './fast-path-timing.mjs';
import { liveNativeWorker } from '../promote/native-context.mjs';
import { queueJobs } from '../promote/promote.mjs';

export const POLICY = 'notice-autopilot/v1';
const liveGreen = { identity: greenIdentity, scope: greenPassScope };
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
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => !['enabled', 'cohort', ...(policy.cohort === 'green-pass' ? ['green'] : [])].includes(k)) ||
      (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') ||
      (policy.cohort !== undefined && typeof policy.cohort !== 'string')) throw Error('autopilot.enabled must be true|false; cohort must be a string');
  return { enabled: policy.enabled === true, cohort: policy.cohort ?? null, file, ...(policy.cohort === 'green-pass' ? { green: policy.green } : {}) };
}

function execute(file, args, options) {
  return spawnSync(process.execPath, [file, ...args], { ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function runIdentity(project, run) {
  try { return run.workspace && gitProject(run.workspace).identity; }
  catch {
    const settle = read(path.join(project.org, 'settle', `${run.id}.json`));
    const dispatch = run.meta.dispatch_journal && read(run.meta.dispatch_journal);
    return settle?.run === run.id ? settle.common : dispatch?.run === run.id && dispatch.workspace === run.workspace ? dispatch.common : null;
  }
}

function authority(project, runId, { pendingReport = false, green = liveGreen } = {}) {
  const live = gitProject(project.repo);
  if (live.identity !== project.identity || live.canonical !== project.repo || fs.realpathSync(project.org) !== project.org) throw Error('autopilot project binding changed');
  const settings = autopilotSettings(project.repo);
  if (!settings.enabled) throw Error('AUTOPILOT_DISABLED: autopilot disabled in project config');
  if (!['clean-pass', 'green-pass'].includes(settings.cohort)) throw Error('AUTOPILOT_COHORT_UNKNOWN: select the clean-pass or green-pass cohort or use the ordinary path');
  if (settings.cohort === 'green-pass') green.identity({ ...project, bindings: settings.green });
  if (fs.existsSync(path.join(project.repo, '.lane/supervisor/STOP'))) throw Error('STOP disables autopilot');
  if (!housekeepingConfig(path.join(project.repo, '.housekeeping.json')).enabled) throw Error('paused housekeeping disables autopilot');
  const { events, tornTail } = loadEvents(project.org);
  if (tornTail) throw Error('incomplete record event; inspect');
  const state = fold(events), config = readConfig(project.org);
  if (approvalPolicy(config, 'tooling') !== 'auto') throw Error('tooling actions require operator authority');
  if (!runId) return { state, settings };
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
  if (runIdentity(project, run) !== project.identity) throw Error('run has no verified project binding');
  return { state, run, item, report, settings };
}

function cohortScope(project, bound, options, green = liveGreen) {
  if (bound.settings.cohort === 'clean-pass') return cleanPassScope({ repo: project.repo, workspace: bound.run.workspace, ...options });
  return green.scope({ ...project, workspace: bound.run.workspace, ...options, bindings: bound.settings.green,
    report: bound.report, run: bound.run.id, item: bound.item, reportRoot: path.dirname(bound.run.report_path) });
}

// A receipt is an action journal, never work status. Intent precedes every
// command; a lost reply wakes the supervisor instead of replaying side effects.
export function autopilotNotice(entry, { execute: call = execute, nativeWorker: worker = liveNativeWorker, green = liveGreen } = {}) {
  if (!entry.project) return null; // Unbound/legacy transports retain delivery.
  const project = entry.project;
  const authorize = (runId, options = {}) => authority(project, runId, { ...options, green });
  const report = /^\[org-report\] run=(R-\d+) item=(\S+) outcome=(done|blocked|needs_human|failed) headline=/.exec(entry.message);
  const promotion = /^\[promote-queue\] id=([a-zA-Z0-9-]+) lane=(\S+) outcome=(\S+)(?: |$)/.exec(entry.message);
  // Report intake/follow-ups remain unique per run. Promotion interruptions and
  // completions are distinct producer notice IDs, despite sharing a job ID.
  const key = report ? `report:${report[1]}` : `notice:${entry.id}`;
  const file = path.join(receiptDirectory(project.org, project.identity), 'autopilot', `${digest(key)}.json`);
  let receipt = { policy: POLICY, key, project, release: bundleRelease(), notice: entry.message, notice_id: entry.id, actions: [], started: new Date().toISOString() }, release;
  const save = () => writeFileAtomic(file, JSON.stringify(receipt, null, 2) + '\n', 0o600);
  // Classified report/promotion exceptions retain foreground policy evidence.
  // Every other notice and classification failure keeps the original payload.
  const summary = reason => report || promotion
    ? `${entry.message}\n[autopilot] ${report?.[1] ?? promotion?.[1]} ${line(reason)} receipt=${file}`
    : entry.message;
  const finish = (disposition, reason, unchanged = false) => {
    receipt.disposition = disposition; receipt.reason = line(reason); receipt.finished = new Date().toISOString();
    if (runId) {
      try {
        let terminal = Boolean(receipt.actions.length || receipt.scope || (promotion && runId)) &&
          (disposition === 'wake' || /promotion recorded|already closed|notification|watched fix/.test(reason));
        // Telemetry must not mutate a reopened/superseded item, or write past
        // a kill switch that appeared while a command was running.
        if (terminal) { try { authorize(runId, { pendingReport: true }); } catch { terminal = false; } }
        receipt.measurement = fastPathTiming(project, runId, receipt, { terminal });
      }
      catch (error) { receipt.measurement_error = error.message; }
    }
    save();
    return { disposition, receipt: file, summary: unchanged ? entry.message : receipt.delivery_summary ?? summary(reason) };
  };
  // If the action receipt cannot safely be written, the inbox journals this
  // diagnostic with the policy result while delivery still uses only summary.
  const retained = reason => ({ disposition: 'wake', receipt: file, reason: line(reason), summary: entry.message });
  let runId = report?.[1], alreadyClosed;
  const exception = (code, reason) => { receipt.exception = code; return finish('wake', `${code}: ${reason}`, code === 'AUTOPILOT_DISABLED'); };
  const git = (cwd, args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error(`AUTOPILOT_SCOPE_UNKNOWN: ${r.stderr || r.error?.message || 'Git unavailable'}`);
    return r.stdout.trim();
  };
  const landingFile = () => path.join(path.dirname(file), 'landings', `${runId}.json`);
  const landingReceipt = item => {
    const saved = read(landingFile());
    if (saved && (saved.run !== runId || saved.item !== item.id || JSON.stringify(saved.project) !== JSON.stringify(project))) throw Error('landing notification binding changed');
    return saved;
  };
  const landed = result => {
    if (result.result !== 'recorded_promotion') return finish('wake', result.result ?? 'unknown promotion result');
    const { item } = authorize(runId);
    if (item.closed?.as !== 'done') throw Error('promotion returned without recorded item closure');
    if (item.meta.notify !== 'supervisor') return finish('handled', 'promotion recorded');
    if (result.run !== runId || result.item !== item.id) throw Error('landed result differs from bound run and item');
    const marker = landingFile(), unlock = noticeLock(`${marker}.lock`);
    try {
      const prior = landingReceipt(item);
      if (prior) {
        return finish('handled', 'landing notification already journaled');
      }
      receipt.delivery_summary = `[autopilot] ${line(item.id)} landed${item.meta.notify_step ? `; unblocks: ${line(item.meta.notify_step)}` : ''}`;
      // Save the delivery text before the dedup marker. If interrupted here,
      // receipt recovery still wakes with this text; the inbox owns retries.
      save();
      writeFileAtomic(marker, JSON.stringify({ project, run: runId, item: item.id, notice_id: entry.id, receipt: file }) + '\n', 0o600);
      return finish('wake', 'awaited item landed');
    } finally { unlock(); }
  };
  try {
    release = noticeLock(`${file}.lock`);
    let prior;
    try {
      prior = read(file);
      if (!prior && promotion) {
        const legacy = path.join(path.dirname(file), `${digest(`promotion:${promotion[1]}`)}.json`);
        const saved = read(legacy);
        // Keep old evidence intact. A completed/uncertain command for this
        // outcome must not become executable again when receipt keys change.
        const outcome = saved && /^\[promote-queue\] id=\S+ lane=\S+ outcome=(\S+)/.exec(saved.notice)?.[1];
        if (saved && (outcome === promotion[3] || (saved.actions?.length && !saved.disposition) || saved.actions?.some(a => a.phase !== 'acknowledged'))) {
          if (saved.key !== `promotion:${promotion[1]}` || saved.policy !== POLICY || JSON.stringify(saved.project) !== JSON.stringify(project)) return retained('legacy autopilot receipt binding changed');
          prior = { ...saved, key, legacy_receipt: legacy };
        }
      }
    }
    catch (error) { return retained(`unreadable action receipt: ${error.message}`); }
    if (prior) {
      if (prior.key !== key || prior.policy !== POLICY || JSON.stringify(prior.project) !== JSON.stringify(project)) return retained('autopilot receipt binding changed');
      receipt = prior;
    }
    const watch = /^\[(?:watch-no-report|watch-long-running|watch-blocked|watch-invalid-report|watch-unavailable)\] run=(R-\d+) item=(\S+)(?: |$)/.exec(entry.message);
    // Abandoned workers can still emit queued watcher/report notices. Suppress
    // only fixed prefixes bound to a verified run in this project's record.
    if (report || watch) {
      try {
        const { state } = authorize(), match = report ?? watch, run = state.runs.get(match[1]);
        if (run?.abandoned && run.item === match[2] && runIdentity(project, run) === project.identity)
          return finish('handled', `abandoned run ${run.id}; notice dropped`);
      } catch { /* Damaged/unavailable evidence retains the usual delivery. */ }
    }
    // Intermediate and unknown notices need no record or status projection.
    // Policy diagnostics belong only in their receipt, never in the payload.
    if (!report && !promotion) return finish('wake', `unrecognised notice: ${line(entry.message)}`);
    const selected = authorize().settings;
    if (report) {
      if (report[3] !== 'done') return finish('wake', `worker reported ${report[3]}`);
      runId = report[1];
      const { run } = authorize(runId, { pendingReport: true });
      if (run.item !== report[2]) throw Error('notice item differs from record');
    } else if (promotion) {
      if (promotion[3] !== 'promoted') {
        const queue = read(path.join(project.identity, 'promote/queue.json'));
        const job = queue?.identity === project.identity && queueJobs(queue).find(j => j.id === promotion[1]);
        if (job?.run && job.topic === promotion[2] && job.org === project.org && job.outcome === promotion[3]) {
          runId = job.run; receipt.exception = job.code ?? `PROMOTION_${promotion[3].toUpperCase()}`;
        }
        return finish('wake', `promotion ${promotion[3]}`);
      }
      const queue = read(path.join(project.identity, 'promote/queue.json'));
      if (queue?.identity !== project.identity) throw Error('promotion queue binding missing or changed');
      const job = queueJobs(queue).find(j => j.id === promotion[1]);
      if (!job || job.outcome !== 'promoted' || job.topic !== promotion[2] || job.org !== project.org) throw Error('promotion notice differs from queue receipt');
      if (!/^R-\d+$/.test(job.run ?? '')) throw Error('promotion receipt has no run binding; inspect queue evidence');
      runId = job.run;
      const { item } = authorize(runId);
      alreadyClosed = item.closed?.as === 'done' && (item.meta.notify !== 'supervisor' || landingReceipt(item));
    }
    if (receipt.actions.some(a => a.phase !== 'acknowledged')) return finish('wake', 'uncertain autopilot command; inspect before recovery');
    if (receipt.actions.length && !receipt.disposition) return finish('wake', 'interrupted autopilot sequence; inspect acknowledged actions');
    if (receipt.disposition) return { disposition: receipt.disposition, receipt: file,
      summary: receipt.delivery_summary ?? (receipt.error ? entry.message : summary(receipt.reason)) };
    if (alreadyClosed) return finish('handled', 'promotion already closed');
    const command = (name, file, args, { json = true, pendingReport = false } = {}) => {
      const current = authorize(runId, { pendingReport }); // Re-read STOP, pause, authority and record.
      if (JSON.stringify(current.settings) !== JSON.stringify(selected)) throw Error('AUTOPILOT_COHORT_CHANGED: cohort configuration changed during admission');
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
      catch (error) {
        action.output = stdout; save();
        if (r.error || r.signal || r.status !== 0) throw Error(`${path.basename(file)}: ${r.stderr || r.error?.message || r.signal || `exit ${r.status}`}`);
        throw error;
      }
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
      return landed(result);
    }
    const saved = read(path.join(project.org, 'settle', `${runId}.json`));
    const bound = authorize(runId, { pendingReport: true });
    if (!bound.item.closed && bound.run.workspace && fs.existsSync(bound.run.workspace)) {
      const head = git(bound.run.workspace, ['rev-parse', 'HEAD']);
      const base = git(bound.run.workspace, ['merge-base', git(project.repo, ['rev-parse', 'HEAD']), head]);
      const scope = cohortScope(project, bound, { base, head, review: saved?.review }, green);
      receipt.scope = scope; save();
      if (!scope.eligible) return exception(scope.code, scope.reason);
    }
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
    if (result.result === 'recorded_promotion') return landed(result);
    if (result.result === 'promotable_with_findings') return exception('AUTOPILOT_FINDINGS', 'clean-pass requires zero findings; capped acceptance uses the ordinary path');
    if (result.result !== 'promotable') return finish('wake', `${result.result ?? 'unknown result'}: ${result.reason ?? 'inspect evidence'}`);
    if (result.review?.verdict !== 'PASS') return exception('AUTOPILOT_PASS_MISSING', 'promotable result lacks PASS');
    const clean = settled?.review?.text?.match(/## Findings\n([\s\S]*?)(?=\n## )/)?.[1]?.trim();
    if (clean !== 'None' || (result.findings && result.findings !== 'None')) return exception('AUTOPILOT_FINDINGS', 'clean-pass requires an explicit empty Findings section');
    if (result.run !== runId || settled?.run !== runId || settled.common !== project.identity || settled.org !== project.org || settled.stage !== 'complete' ||
        settled.review.verdict !== 'PASS' || settled.review.sha256 !== digest(settled.review.text) || result.review.sha256 !== settled.review.sha256 ||
        result.reviewed_commit !== settled.head || result.head !== settled.finalHead || settled.result?.result !== 'promotable')
      return exception('AUTOPILOT_PASS_STALE', 'PASS or candidate binding differs from completed settlement');
    const ready = authorize(runId);
    const scope = cohortScope(project, ready, { base: settled.mainHead, head: result.head, review: settled.review }, green);
    receipt.scope = scope; save();
    if (!scope.eligible) return exception(scope.code, scope.reason);
    if (!worker(project.identity)) return exception('AUTOPILOT_NO_NATIVE_WORKER', 'no live native promote worker; supervisor must use the bare enqueue in its authorized context');
    const why = `${POLICY}: clean PASS promotes in ${scope.area}; project tooling authority is auto; settle and queue recheck readiness`;
    const promoted = command('enqueue promotion', supervisor, ['promote', runId, '--existing-worker', '--why', why, ...args]);
    if (promoted.phase !== 'acknowledged') return finish('wake', promoted.reason ?? promoted.result ?? 'promotion enqueue not acknowledged');
    return finish('handled', 'clean PASS promotion queued');
  } catch (error) {
    // A contending/live owner must retain its receipt untouched.
    if (!release) return retained(error.message);
    receipt.error = error.message; // Keep full diagnostic evidence behind the compact wake.
    const named = /((?:AUTOPILOT|GREEN)_[A-Z_]+):/.exec(error.message);
    if (named) return exception(named[1], error.message.slice(named.index + named[0].length).trim());
    return finish('wake', error.message, true);
  } finally { release?.(); }
}
