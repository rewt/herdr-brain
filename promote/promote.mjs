#!/usr/bin/env node
// A durable FIFO and one detached, finite drain worker. No model calls.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { createRetirement } from '../supervisor/retire.mjs';
import { consumeRetirement } from '../lib/retire-trigger.mjs';
import { promptSupervisor, inboxPath } from '../supervisor/prompt-supervisor.mjs';
import { runProjectGateSync } from './gate-profile.mjs';
import { reconcileBatchCompletion, accountUncapturedMember } from './completion.mjs';
import { verifyTrainResult } from './evidence.mjs';

const SELF = fileURLToPath(import.meta.url);
const LANE = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const singleLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);

export function queueJobs(data) {
  const members = current => current?.jobs ? current.jobs.map(job => {
    const member = current.results?.find(r => r.job.id === job.id);
    return member ? { ...job, phase: 'completed', result: member.result, ...member.result } : { ...job, phase: current.phase, batch: current.id };
  }) : current ? [current] : [];
  const rows = [...data.results, ...(data.interrupted ?? []).flatMap(members), ...members(data.current), ...data.pending];
  // An interrupted notice and its eventual outcome share a request id.
  // Keep the complete history on disk, but readers must see the latest state.
  return [...new Map(rows.map(job => [job.id, job])).values()];
}

export function queueFor(cwd) {
  const project = gitProject(cwd);
  const directory = path.join(project.identity, 'promote');
  const file = path.join(directory, 'queue.json');
  fs.mkdirSync(directory, { recursive: true });
  const load = () => {
    if (!fs.existsSync(file)) return { identity: project.identity, pending: [], current: null, results: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.identity !== project.identity || !Array.isArray(data.pending) || !Array.isArray(data.results)) throw new Error('invalid promotion queue identity or contents');
    return data;
  };
  const transaction = (fn) => {
    const release = acquireLock(path.join(directory, 'queue.lock'), { waitMs: 5000 });
    try {
      const data = load();
      const result = fn(data);
      writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
      return result;
    } finally { release(); }
  };
  return { project, directory, file, load, transaction };
}

function invoke(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(singleLine(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`));
  return r.stdout.trim();
}
function git(cwd, args) { return invoke('git', ['-C', cwd, ...args]); }
function settingsRefusal(code, reason) {
  return Object.assign(new Error(`${code}: ${singleLine(reason)}`), { code });
}
function promotionSettings(project) {
  // Only the canonical committed declaration can change queue policy. Lane
  // copies and untracked/edited host files cannot override the batch limit.
  // Bound the whole snapshot below the worker's startup acknowledgement wait.
  const deadline = Date.now() + loadTimeout(2000);
  const read = args => spawnSync('git', ['-C', project.canonical, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1, deadline - Date.now()),
  });
  const checked = result => {
    if (result.error || result.status !== 0) throw settingsRefusal('PROMOTION_SETTINGS_GIT_FAILED',
      `cannot read committed promotion settings: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status}`}`);
    return result.stdout.trim();
  };
  const head = read(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head.error && head.status === 1 && !head.stderr && !head.stdout) {
    // An unborn branch has no committed configuration. Confirm the branch ref
    // is absent so other Git failures cannot silently turn policy into defaults.
    const branch = checked(read(['symbolic-ref', '--quiet', 'HEAD']));
    const ref = read(['show-ref', '--verify', '--quiet', branch]);
    if (!ref.error && ref.status === 1 && !ref.stderr && !ref.stdout) return {};
    checked(ref);
  }
  const commit = checked(head);
  const tracked = checked(read(['ls-tree', '--name-only', commit, '--', '.promote.json']));
  let config;
  try { config = tracked ? JSON.parse(checked(read(['show', `${commit}:.promote.json`]))) : {}; }
  catch (error) {
    if (error.code === 'PROMOTION_SETTINGS_GIT_FAILED') throw error;
    throw settingsRefusal('PROMOTION_SETTINGS_INVALID', `invalid committed .promote.json: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw settingsRefusal('PROMOTION_SETTINGS_INVALID', 'committed .promote.json must be an object');
  }
  if (config.max_batch !== undefined && (!Number.isSafeInteger(config.max_batch) || config.max_batch < 1)) {
    throw settingsRefusal('PROMOTION_SETTINGS_INVALID', 'promote max_batch must be a positive integer');
  }
  return config;
}
function settings(project, opt) {
  const config = promotionSettings(project);
  const to = opt.to ?? config.to ?? 'supervisor-herdr';
  const attempts = Number(opt['delivery-attempts'] ?? config.delivery_attempts ?? 5);
  const retry = Number(opt['retry-seconds'] ?? config.retry_seconds ?? 10);
  if (typeof to !== 'string' || !to.trim() || !Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(retry) || retry < 0) throw new Error('invalid supervisor or delivery settings');
  const validate = opt.validate ?? process.env.LANE_VALIDATE ?? config.validate ?? null;
  if (validate !== null && (typeof validate !== 'string' || !validate.trim())) throw new Error('validation override must be a nonempty command');
  const laneCLI = path.resolve(opt['lane-cli'] ?? LANE);
  const expectedHead = opt['expected-head'];
  const run = opt['if-current-run'];
  if (expectedHead !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHead)) throw new Error('--expected-head requires a full commit hash');
  if (run !== undefined && (!/^R-\d+$/.test(run) || expectedHead === undefined)) throw new Error('--if-current-run requires a run ID and --expected-head');
  const org = opt.org ? fs.realpathSync(path.resolve(opt.org)) : findOrgDir({ cwd: project.canonical });
  if (run !== undefined && !org) throw new Error('--if-current-run requires a record');
  return { to, attempts, retry, herdr: opt.herdr ?? 'herdr', laneCLI,
    org, expectedHead, run,
    superseded: opt['superseded-runs'] === undefined ? [] : JSON.parse(opt['superseded-runs']),
    requiredTests: opt['required-tests'] === undefined ? [] : JSON.parse(opt['required-tests']),
    validate,
    laneConfig: process.env.LANE_CONFIG ? path.resolve(process.env.LANE_CONFIG) : null };
}

export function enqueue(queue, topics, options) {
  if (options.requiredTests !== undefined && (!Array.isArray(options.requiredTests) || options.requiredTests.length > 512 || options.requiredTests.some(f => typeof f !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f)))) throw Error('invalid required test files');
  if (options.expectedHead !== undefined && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedHead) || topics.length !== 1)) throw new Error('expected head requires one lane and a full commit hash');
  if (options.run !== undefined && (!/^R-\d+$/.test(options.run) || options.expectedHead === undefined || !options.org)) throw new Error('run binding requires a record, run ID and expected head');
  if (options.superseded !== undefined && (!Array.isArray(options.superseded) || (options.superseded.length && !options.run) || new Set(options.superseded).size !== options.superseded.length || options.superseded.some(id => !/^R-\d+$/.test(id)))) throw Error('invalid explicit superseded runs');
  for (const topic of topics) if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(topic)) throw new Error(`invalid lane topic: ${topic}`);
  return queue.transaction((data) => topics.map((topic) => {
    const existing = queueJobs({ ...data, results: [] }).find((job) => job?.topic === topic && !(job.phase === 'completed' && ['refused', 'timeout'].includes(job.result?.outcome)));
    if (existing) {
      if (JSON.stringify(existing.superseded ?? []) !== JSON.stringify(options.superseded ?? []) || JSON.stringify(existing.requiredTests ?? []) !== JSON.stringify(options.requiredTests ?? []) || existing.expectedHead !== options.expectedHead || existing.run !== options.run || (options.run !== undefined && existing.org !== options.org)) throw new Error(`pending promotion for ${topic} has a different head or run binding; inspect queue before enqueuing`);
      return { id: existing.id, topic, duplicate: true };
    }
    const job = { id: randomUUID(), topic, queued: new Date().toISOString(), ...options };
    data.pending.push(job);
    return { id: job.id, topic, duplicate: false };
  }));
}

function cleanup(job, queue, workspace) {
  const warnings = [];
  const log = entry => {
    fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify(entry) + '\n');
    if (['keep', 'close-failed', 'skip-close'].includes(entry.action)) warnings.push(singleLine(JSON.stringify(entry)));
  };
  try {
    const retirement = createRetirement({ cwd: queue.project.canonical, org: job.org, herdr: job.herdr,
      main: git(queue.project.canonical, ['symbolic-ref', '--short', 'HEAD']), selfTab: null, log });
    const plan = retirement.plan(workspace);
    for (const kept of plan.keep) log({ action: 'keep', ...kept });
    for (const diagnostic of plan.diagnostics) log({ action: 'reference-diagnostic', ...diagnostic });
    retirement.apply(plan, workspace);
  } catch (error) { warnings.push(`tab cleanup: ${error.message}`); }
  return warnings;
}

function perform(job, queue) {
  const cwd = queue.project.canonical;
  const env = { ...process.env, ORG_DIR: job.org ?? undefined, HERDR_RETIRE_HERDR: job.herdr, LANE_VALIDATE: job.validate ?? undefined, LANE_CONFIG: job.laneConfig ?? undefined };
  delete env.HERDR_PANE_ID; delete env.HERDR_TAB_ID; delete env.HERDR_WORKSPACE_ID;
  const log = path.join(queue.directory, `${job.id}.log`);
  const entries = git(cwd, ['worktree', 'list', '--porcelain']).split('\n\n');
  const workspace = entries.find((entry) => entry.split('\n').includes(`branch refs/heads/lane/${job.topic}`))
    ?.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
  const output = fs.openSync(log, 'a');
  let r;
  const args = [job.laneCLI, 'promote', job.topic,
    ...(job.expectedHead !== undefined ? ['--expected-head', job.expectedHead] : []),
    ...(job.run !== undefined ? ['--if-current-run', job.run, '--org', job.org] : [])];
  try { r = spawnSync(process.execPath, args, { cwd, env, stdio: ['ignore', output, output] }); }
  finally { fs.closeSync(output); }
  const reason = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).findLast((line) => /^(?:lane:|GATE_TIMEOUT:)/.test(line)) ?? r.error?.message ?? `lane promote exited ${r.status}`;
  if (r.error || r.status !== 0) {
    const detail = reason();
    if (r.status === 124 && /GATE_TIMEOUT:/.test(detail)) {
      const limit = /GATE_TIMEOUT: idle/.test(detail) ? 'no-output' : 'wall-clock';
      return { outcome: 'timeout', reason: `gate ${limit} limit exceeded; lane isolated for correction`, log };
    }
    return { outcome: 'refused', reason: singleLine(detail), log };
  }
  try {
    const tip = job.expectedHead ?? git(cwd, ['rev-parse', 'HEAD']);
    // Persist success before cleanup: a crash must not cause a second gate/FF.
    queue.transaction((data) => { data.current = { ...job, phase: 'promoted', tip, log }; });
    return finishCleanup(job, { outcome: 'promoted', tip, workspace, log,
      reason: 'green fast-forward' }, queue);
  } catch (error) {
    return { outcome: 'promoted', reason: `fast-forward succeeded; post-promotion bookkeeping failed: ${error.message}; lane kept for inspection`, warnings: [error.message], log };
  }
}

function performBatch(batch, queue, settings) {
  const first = batch.jobs[0], cwd = queue.project.canonical;
  const env = { ...process.env, LANE_VALIDATE: first.validate ?? undefined, LANE_CONFIG: first.laneConfig ?? undefined };
  delete env.HERDR_PANE_ID; delete env.HERDR_TAB_ID; delete env.HERDR_WORKSPACE_ID;
  const directory = path.join(queue.directory, 'batches', batch.id);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'train.log');
  if (!fs.existsSync(receipt)) writeFileAtomic(receipt, JSON.stringify({ schema: 'promotion-train/v1', id: batch.id,
    identity: queue.project.identity, jobs: batch.jobs, phase: 'pending', started_at: new Date().toISOString() }, null, 2) + '\n');
  // A completed train only needs record recovery. Do not re-enter its host
  // admission, preparation, validation or integration command.
  const retained = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (retained.phase === 'complete') return batch.jobs.map(job => ({ job, result: { ...retained.results[job.id], log, receipt,
    ...(retained.host_receipt ? { host_receipt: retained.host_receipt } : {}) } }));
  const output = fs.openSync(log, 'a');
  let r;
  try { r = runProjectGateSync({ canonical: cwd, receipt, settings,
    argv: [first.laneCLI, 'promote-batch', receipt], cwd, env, stdio: ['ignore', output, output] }); }
  finally { fs.closeSync(output); }
  const hostFile = path.join(directory, 'host-gate.json');
  if (r.status !== 0 && fs.existsSync(hostFile)) {
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    if (host.phase === 'timeout') {
      const train = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      train.results ??= {};
      const limit = host.gate_timeout?.kind === 'idle' ? 'no-output' : 'wall-clock';
      const reason = `gate ${limit} limit exceeded; ${batch.jobs.length === 1 ? 'lane isolated for correction' : 'batch timed out; re-enqueue lanes individually'}`;
      for (const job of batch.jobs) {
        train.results[job.id] ??= { outcome: 'timeout', reason, batch: batch.id, host_receipt: hostFile };
        if (['timeout', 'refused'].includes(train.results[job.id].outcome)) accountUncapturedMember(train, job);
      }
      train.phase = 'complete'; train.groups = [];
      writeFileAtomic(receipt, JSON.stringify(train, null, 2) + '\n');
      return batch.jobs.map(job => ({ job, result: { ...train.results[job.id], log, receipt } }));
    }
    if (!host.command_started && host.phase === 'refused') {
      // A capped transition/slot wait is a visible pre-execution refusal,
      // never red test evidence or an interrupted Git integration.
      const train = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (!train.attempts?.length) {
        train.results ??= {};
        for (const job of batch.jobs) train.results[job.id] ??= { outcome: 'refused', reason: host.reason,
          ...(host.code ? { code: host.code } : {}), batch: batch.id, host_receipt: hostFile };
        train.phase = 'complete'; train.groups = [];
        writeFileAtomic(receipt, JSON.stringify(train, null, 2) + '\n');
        return batch.jobs.map(job => ({ job, result: { ...train.results[job.id], log, receipt } }));
      }
      // An earlier attempt may already have fast-forwarded (including a lost
      // response). Retain its checkpoints and let the next drain reconcile it;
      // a new guard wait cannot turn an integrated commit into a refusal.
    }
  }
  if (r.error || r.status !== 0) throw new Error(`batch interrupted or refused; main only moves for a green batch; inspect ${receipt} and ${log}, then resume --drain`);
  const train = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (train.phase !== 'complete') throw new Error(`incomplete batch receipt: ${receipt}`);
  return batch.jobs.map(job => ({ job, result: { ...train.results[job.id], log, receipt,
    ...(train.host_receipt ? { host_receipt: train.host_receipt } : {}) } }));
}

function cleanupRevision(job, queue) {
  const org = job.org ?? findOrgDir({ cwd: queue.project.canonical });
  if (!org) return 'no-record';
  const stat = fs.statSync(path.join(org, 'events.jsonl'));
  const request = path.join(org, 'retirement/request.json');
  return `${stat.size}:${stat.mtimeMs}:${fs.existsSync(request) ? JSON.parse(fs.readFileSync(request, 'utf8')).revision : 0}`;
}

export function finishCleanup(job, result, queue, { now = Date.now() } = {}) {
  const warnings = [];
  const diagnostics = (result.warnings ?? []).filter(w => w.startsWith('velocity record:'));
  try {
    if (job.run) {
      const env = { ...process.env, ORG_DIR: job.org };
      const run = JSON.parse(invoke(process.execPath, [RECORD, 'show', job.run, '--json'], { cwd: queue.project.canonical, env }));
      const item = JSON.parse(invoke(process.execPath, [RECORD, 'show', run.item, '--json'], { cwd: queue.project.canonical, env }));
      if (!run.report?.seq || !item.closed || item.runs.at(-1) !== run.id) throw Error('record chain remains open or run changed; lane retained');
    }
    const entries = git(queue.project.canonical, ['worktree', 'list', '--porcelain']).split('\n\n');
    const workspace = result.workspace ?? entries.find(e => e.split('\n').includes(`branch refs/heads/lane/${job.topic}`))?.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
    if (!workspace || !fs.existsSync(workspace)) {
      // A prior cleanup may have completed before its checkpoint was saved.
      try { git(queue.project.canonical, ['rev-parse', '--verify', `refs/heads/lane/${job.topic}`]); }
      catch { return { ...result, cleanup: { state: 'complete' } }; }
      throw Error('lane branch remains without its worktree; inspect before cleanup');
    }
    warnings.push(...cleanup(job, queue, workspace));
    if (!warnings.length) invoke(process.execPath, [job.laneCLI, 'close', job.topic, '--git-only', '--expected-tip', result.tip], {
      cwd: queue.project.canonical, env: { ...process.env, ORG_DIR: job.org ?? undefined, HERDR_RETIRE_HERDR: job.herdr, LANE_CONFIG: job.laneConfig ?? undefined } });
  } catch (error) { warnings.push(`lane cleanup: ${error.message}`); }
  let revision;
  try { revision = cleanupRevision(job, queue); } catch (e) { revision = `unreadable:${e.message}`; }
  const attempts = (result.cleanup?.revision === revision ? result.cleanup.attempts ?? 0 : 0) + 1;
  return { ...result, warnings: [...diagnostics, ...warnings], cleanup: { state: warnings.length ? 'pending' : 'complete', warnings,
    revision, attempts, attempted_at: now, next_attempt_at: now + Math.min(3600000, 60000 * 2 ** (attempts - 1)),
    last_refusal: warnings.length ? warnings.join('; ') : null },
    reason: warnings.length ? `integrated-but-cleanup-pending: ${warnings.join('; ')}` : 'green fast-forward; cleanup complete' };
}

// Restart/reconciliation retries only the cleanup checkpoint, never the gate.
export function retryCleanup(queue, { now = Date.now() } = {}) {
  for (const saved of queue.load().results.filter(r => r.outcome === 'promoted' && r.cleanup?.state === 'pending' && r.reconciliation?.state !== 'pending')) {
    let revision;
    try { revision = cleanupRevision(saved, queue); } catch (e) { revision = `unreadable:${e.message}`; }
    if (saved.cleanup.revision === revision && ((saved.cleanup.attempts ?? 0) >= 5 || now < saved.cleanup.next_attempt_at)) continue;
    const result = finishCleanup(saved, saved, queue, { now });
    queue.transaction(data => {
      const row = data.results.findLast(r => r.id === saved.id);
      if (row) Object.assign(row, result);
    });
  }
}

function consumeRequests(queue) {
  try {
    const jobs = queueJobs(queue.load());
    const discovered = findOrgDir({ cwd: queue.project.canonical });
    const orgs = new Set([discovered, ...jobs.map(j => j.org)].filter(Boolean));
    for (const org of orgs) try {
      consumeRetirement({ org, retirement: () => createRetirement({ cwd: queue.project.canonical, org,
        herdr: jobs.find(j => j.org === org)?.herdr, log: result => process.stderr.write(JSON.stringify(result) + '\n') }) });
    } catch (e) { process.stderr.write(`integrated-but-cleanup-pending: retirement catch-up: ${e.message}\n`); }
  } catch (e) { process.stderr.write(`integrated-but-cleanup-pending: retirement discovery: ${e.message}\n`); }
}

function finishBatchJob(job, result, queue) {
  if (result.outcome !== 'promoted' || result.reconciliation?.state === 'pending') return result;
  const warnings = result.replacement_pending ? [] : [...(result.warnings ?? [])];
  if (result.report_to_main_s !== null && result.report_to_main_s !== undefined && job.org && job.run) {
    try {
      const text = `Promotion: report-to-main ${result.report_to_main_s.toFixed(3)} seconds; report ${result.report_at}; main ${result.integrated_at}; batch ${result.batch}; tip ${result.tip}; receipt ${result.receipt}`;
      const env = { ...process.env, ORG_DIR: job.org };
      const run = JSON.parse(invoke(process.execPath, [RECORD, 'show', job.run, '--json'], { cwd: queue.project.canonical, env }));
      if (!run.notes.some(note => note.text === text)) invoke(process.execPath, [RECORD, 'note', job.run, text], { cwd: queue.project.canonical, env });
    } catch (error) { warnings.push(`velocity record: ${error.message}`); }
  }
  // Reconciliation precedes telemetry and every lifecycle cleanup operation.
  // Failed integration/replacement proof also requires retaining the lane.
  // A velocity note is telemetry and must not prevent lifecycle cleanup.
  if (job.run && result.reconciliation?.state === 'complete') {
    const env = { ...process.env, ORG_DIR: job.org };
    try {
      const run = JSON.parse(invoke(process.execPath, [RECORD, 'show', job.run, '--json'], { cwd: queue.project.canonical, env }));
      const item = JSON.parse(invoke(process.execPath, [RECORD, 'show', run.item, '--json'], { cwd: queue.project.canonical, env }));
      if (!item.closed || item.runs.at(-1) !== run.id) throw Error('item reopened or run superseded after completion; lane retained');
    } catch (error) { return { ...result, warnings: [...warnings, error.message], reason: error.message }; }
  }
  if (result.replacement_pending && result.reconciliation?.state === 'complete') {
    let release;
    try {
      release = acquireLock(path.join(queue.project.identity, 'lane-promote.lock'));
      if (!verifyTrainResult({ ...result, id: job.id }, { project: queue.project, saved: { head: job.expectedHead, run: job.run, org: job.org, lane: job.topic } })) throw Error('lane replacement lacks original integrated proof');
      if (git(result.workspace, ['rev-parse', 'HEAD']) !== result.tip) invoke(process.execPath, [fileURLToPath(new URL('../settle/replace-lane-head.mjs', import.meta.url)), JSON.stringify({
        workspace: result.workspace, repo: queue.project.canonical, common: queue.project.identity,
        branch: `refs/heads/lane/${job.topic}`, from: result.source_head, to: result.tip,
        main: git(queue.project.canonical, ['symbolic-ref', '--short', 'HEAD']),
        mainHead: git(queue.project.canonical, ['rev-parse', 'HEAD']),
      })], { cwd: queue.project.canonical });
      result = { ...result, replacement_pending: false, warnings: [], reason: 'green batch fast-forward; lane replacement recovered' };
    } catch (error) { return { ...result, reason: `lane replacement pending: ${error.message}` }; }
    finally { release?.(); }
  }
  if ((result.warnings?.length ?? 0) === 0 && result.workspace) return finishCleanup(job, { ...result, warnings }, queue);
  return { ...result, warnings, cleanup: { state: 'pending', warnings },
    reason: `integrated-but-cleanup-pending: ${warnings.join('; ') || result.reason}` };
}

export function notice(job, result) {
  if (result.pending) return `[promote-queue] id=${job.id} outcome=${result.outcome} code=${result.code} pending=${JSON.stringify(result.pending)} reason=${JSON.stringify(singleLine(result.reason))}`;
  return `[promote-queue] id=${job.id} lane=${job.topic} outcome=${result.outcome}${result.code ? ` code=${result.code}` : ''} reason=${JSON.stringify(singleLine(result.reason))} log=${result.log ?? ''}${result.receipt ? ` receipt=${result.receipt}` : ''}${result.host_receipt ? ` host-receipt=${result.host_receipt}` : ''}`;
}
async function deliver(job, result, queue) {
  const message = notice(job, result);
  const resumed = result.outcome !== 'interrupted' && queue.load().results.some(prior => prior.id === job.id && prior.outcome === 'interrupted');
  const reconciled = result.reconciliation?.state === 'complete' && queue.load().results.some(prior => prior.id === job.id && prior.reconciliation?.state === 'pending');
  const suffix = result.reconciliation?.state === 'pending' ? `:reconciliation-pending:${createHash('sha256').update(message).digest('hex').slice(0, 16)}` : reconciled ? ':reconciled' : resumed ? ':complete' : '';
  const { id: deliveryId, ...delivery } = await promptSupervisor(job.to, message, {
    inbox: inboxPath({ org: job.org, cwd: queue.project.canonical }),
    herdr: job.herdr, attempts: job.attempts, retrySeconds: job.retry,
    // Durable inbox ownership lets queue accounting finish without waiting for
    // a busy composer. An explicitly configured caller wait remains supported.
    waitSeconds: process.env.SUPERVISOR_INPUT_WAIT_SECONDS ?? 0,
    id: `promote:${job.id}${suffix}`, title: 'Promotion notice undelivered',
    log: (line) => process.stderr.write(line + '\n'),
  });
  return { ...delivery, delivery_id: deliveryId };
}

export async function drain(queue) {
  let release;
  // Serialize the startup/empty-exit handoff with enqueuers. A worker releases
  // ownership while still holding queue.lock, so an enqueue cannot be stranded.
  queue.transaction(() => {
    try { release = acquireLock(path.join(queue.directory, 'worker.lock')); }
    catch (error) {
      const ownerFile = path.join(queue.directory, 'worker.lock', 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || owner.argv?.[1] !== SELF) throw error;
      // EPERM means the owner exists but this caller (another user or a sandbox) may not signal it.
      try { process.kill(owner.pid, 0); } catch (signal) { if (signal.code !== 'EPERM') throw error; }
    }
  });
  if (!release) { process.send?.({ ready: true, already_running: true }); return; }
  let acknowledged = false;
  const attempted = new Set();
  try {
    consumeRequests(queue);
    retryCleanup(queue);
    for (;;) {
      // Git can be slow. Read a committed snapshot without queue.lock so
      // enqueuers remain free to append while this worker waits for settings.
      const snapshot = queue.load();
      let policy;
      if (!snapshot.current && !(snapshot.interrupted ?? []).some(batch => !attempted.has(batch.id)) && snapshot.pending.length) {
        try { const settings = promotionSettings(queue.project); policy = { maxBatch: settings.max_batch ?? Infinity, settings }; }
        catch (error) { policy = { error }; }
      }
      const entry = queue.transaction((data) => {
        if (data.current) {
          // Old workers leaked freshness into their promoted checkpoint. Never
          // trust a persisted flag to authorize replay of an external effect.
          const job = { ...data.current };
          delete job.fresh;
          data.current = job;
          return { job, newlyDequeued: false };
        }
        // Retry each suspended batch once per drain. Another exception keeps
        // its receipt resumable while allowing later requests to run now.
        const resume = (data.interrupted ?? []).findIndex(batch => !attempted.has(batch.id));
        if (resume >= 0) {
          const [saved] = data.interrupted.splice(resume, 1);
          const job = { ...saved, phase: 'batching' };
          delete job.results; delete job.deliveredCount;
          data.current = job;
          return { job, newlyDequeued: false };
        }
        const next = data.pending[0];
        if (!next) { release(); release = null; return null; }
        // An enqueue after the empty snapshot needs a settings read on the
        // next iteration; never read Git while holding this transaction.
        if (!policy) return { retry: true };
        if (policy.error) {
          const error = policy.error;
          // Persist before acknowledging startup or exiting. Pending requests
          // retain their order and can be retried after the settings are fixed.
          data.refusal = { id: randomUUID(), outcome: 'refused', code: error.code, reason: error.message,
            pending: data.pending.map(job => job.id), at: new Date().toISOString() };
          return { refusal: data.refusal, recipient: next };
        }
        delete data.refusal;
        data.pending.shift();
        if (next.laneCLI === LANE) {
          // Snapshot whatever is available now. No accumulation timer/window.
          // Different command/config inputs retain their independent gates.
          // Older jobs still carry "workflow": false; the retired engine flag is ignored.
          const key = job => JSON.stringify([job.laneCLI, job.validate ?? null, job.laneConfig ?? null, Boolean(job.run)]);
          const jobs = [next];
          while (jobs.length < policy.maxBatch && data.pending.length && key(data.pending[0]) === key(next)) jobs.push(data.pending.shift());
          const job = { id: randomUUID(), phase: 'batching', jobs };
          data.current = job;
          return { job, newlyDequeued: true };
        }
        const job = { ...next, phase: 'promoting' };
        delete job.fresh;
        data.current = job;
        // Freshness belongs only to this dequeue, never to queue.json.
        return { job, newlyDequeued: true };
      });
      if (entry?.retry) continue;
      if (entry?.refusal) {
        if (!acknowledged) process.send?.({ ready: false, refusal: entry.refusal });
        else {
          const delivery = await deliver({ ...entry.recipient, id: entry.refusal.id }, entry.refusal, queue);
          queue.transaction(data => { data.refusal = { ...entry.refusal, ...delivery }; });
        }
        throw Object.assign(new Error(entry.refusal.reason), { code: entry.refusal.code });
      }
      // Ready means the queue checkpoint exists, including batch membership.
      // Git settings reads must not leave a successful startup ahead of it.
      if (!acknowledged) { process.send?.({ ready: true }); acknowledged = true; }
      if (!entry) break;
      const { job, newlyDequeued } = entry;
      if (job.jobs) {
        let batch = job;
        attempted.add(batch.id);
        if (batch.phase === 'batching') {
          try {
            // A new batch reuses the settings snapshot it was formed from; a resumed one reads HEAD.
            const results = performBatch(batch, queue, newlyDequeued ? policy?.settings : undefined);
            const completion = reconcileBatchCompletion({ project: queue.project, jobs: batch.jobs, results });
            batch = { ...batch, phase: 'batch-delivering', results: completion.results, deliveredCount: 0 };
            if (completion.pending) batch.error = completion.reason;
            else delete batch.error;
          } catch (error) {
            const directory = path.join(queue.directory, 'batches', batch.id);
            const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'train.log');
            const hostReceipt = path.join(directory, 'host-gate.json');
            const results = batch.jobs.map(member => ({ job: member, result: {
              outcome: 'interrupted', reason: 'batch interrupted; inspect the receipt and log, then resume --drain', receipt, log, batch: batch.id,
              ...(fs.existsSync(hostReceipt) ? { host_receipt: hostReceipt } : {}),
            } }));
            batch = { ...batch, phase: 'batch-delivering', error: error.message, results, deliveredCount: 0 };
          }
          queue.transaction(data => { data.current = batch; });
        }
        for (let index = batch.deliveredCount; index < batch.results.length; index++) {
          const member = batch.results[index];
          // Complete and persist this member before its notice enters the input
          // gate. Recovery must reuse the exact outcome bound to that notice,
          // without repeating cleanup or promotion while the operator types.
          const result = batch.phase === 'completed' ? member.result : finishBatchJob(member.job, member.result, queue);
          queue.transaction(data => {
            member.result = result; batch.phase = 'completed'; data.current = batch;
          });
          const delivery = await deliver(member.job, result, queue);
          queue.transaction(data => {
            data.results.push({ ...member.job, ...result, ...delivery, finished: new Date().toISOString() });
            batch.deliveredCount = index + 1; batch.phase = 'batch-delivering'; data.current = batch;
          });
          process.stdout.write(JSON.stringify({ id: member.job.id, topic: member.job.topic, ...result, ...delivery }) + '\n');
        }
        queue.transaction(data => {
          if (batch.error) { data.interrupted ??= []; data.interrupted.push({ ...batch, phase: 'batching' }); }
          data.current = null;
        });
        continue;
      }
      let result;
      if (job.phase === 'completed') result = job.result;
      else if (job.phase === 'promoted' && job.tip) {
        // The acknowledged integration checkpoint survived a lost cleanup
        // reply. Verify containment, then resume only resource retirement.
        try {
          git(queue.project.canonical, ['merge-base', '--is-ancestor', job.tip, 'HEAD']);
          result = finishCleanup(job, { outcome: 'promoted', tip: job.tip, log: job.log }, queue);
        } catch (e) { result = { outcome: 'interrupted', tip: job.tip, reason: `integration checkpoint cannot be verified: ${e.message}; lane retained`, log: job.log }; }
      }
      else if (!newlyDequeued) result = { outcome: 'interrupted', tip: job.tip,
        reason: `previous worker stopped in ${job.phase}; lane preserved; inspect Git and log before explicitly re-enqueuing`, log: job.log ?? path.join(queue.directory, `${job.id}.log`) };
      else {
        try { result = perform(job, queue); }
        catch (error) { result = { outcome: 'refused', reason: error.message, log: path.join(queue.directory, `${job.id}.log`) }; }
      }
      queue.transaction((data) => { data.current = { ...job, phase: 'completed', result }; });
      const delivery = await deliver(job, result, queue);
      queue.transaction((data) => {
        data.results.push({ ...job, ...result, ...delivery, finished: new Date().toISOString() });
        data.current = null;
      });
      process.stdout.write(JSON.stringify({ id: job.id, topic: job.topic, ...result, ...delivery }) + '\n');
    }
  } finally {
    try { consumeRequests(queue); retryCleanup(queue); } finally { release?.(); }
  }
}

async function start(queue) {
  const output = fs.openSync(path.join(queue.directory, 'worker.log'), 'a');
  const env = { ...process.env };
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR']) delete env[key];
  const child = spawn(process.execPath, [SELF, '--drain', '--repo', queue.project.canonical], {
    cwd: queue.project.canonical, detached: true, stdio: ['ignore', output, output, 'ipc'], env,
  });
  fs.closeSync(output);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.connected) child.disconnect(); child.unref();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('worker startup unconfirmed; inspect worker.log and locks; queued requests retained')), loadTimeout(5000));
    child.once('message', (value) => value.refusal
      ? finish(new Error(`${value.refusal.reason}; queued requests retained; inspect --status`))
      : finish(null, { pid: child.pid, ...value }));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`worker exited ${code} before startup; inspect worker.log; queue retained`)));
  });
}

async function main() {
  const { values: opt, positionals } = parseArgs({ usage: "Usage: node promote/promote.mjs TOPIC [TOPIC ...] [OPTIONS] | --status | --drain", allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, to: { type: 'string' },
    validate: { type: 'string' }, herdr: { type: 'string' }, 'lane-cli': { type: 'string' },
    'delivery-attempts': { type: 'string' }, 'retry-seconds': { type: 'string' },
    'superseded-runs': { type: 'string' }, 'required-tests': { type: 'string' }, 'expected-head': { type: 'string' }, 'if-current-run': { type: 'string' },
    resume: { type: 'boolean' }, drain: { type: 'boolean' }, status: { type: 'boolean' },
  } });
  const queue = queueFor(opt.repo);
  if (opt.status) { process.stdout.write(JSON.stringify({ queue: queue.file, ...queue.load() }, null, 2) + '\n'); return; }
  if (opt.drain) { await drain(queue); return; }
  if (opt.resume) {
    if (positionals.length) throw Error('--resume takes no lane topics');
    const worker = await start(queue);
    process.stdout.write(JSON.stringify({ worker, queue: queue.file }) + '\n'); return;
  }
  if (!positionals.length) throw new Error('usage: promote.mjs TOPIC [TOPIC ...] [--repo PROJECT] [--to SUPERVISOR] | --status | --drain');
  const jobs = enqueue(queue, positionals, settings(queue.project, opt));
  const worker = await start(queue);
  process.stdout.write(JSON.stringify({ jobs, worker, queue: queue.file }) + '\n');
}
if (isMain(import.meta.url)) main().catch((error) => { console.error(`promote: ${error.message}`); process.exitCode = 1; });
