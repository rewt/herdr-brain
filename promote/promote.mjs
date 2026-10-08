#!/usr/bin/env node
// A durable FIFO and one detached, finite drain worker. No model calls.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';
import { promptSupervisor, inboxPath } from '../supervisor/prompt-supervisor.mjs';
import { runProjectGateSync } from './gate-profile.mjs';

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
function promotionSettings(project) {
  // Only the canonical committed declaration can change queue policy. Lane
  // copies and untracked/edited host files cannot override the batch limit.
  const tracked = git(project.canonical, ['ls-tree', '--name-only', 'HEAD', '--', '.promote.json']);
  const config = tracked ? JSON.parse(git(project.canonical, ['show', 'HEAD:.promote.json'])) : {};
  if (config.max_batch !== undefined && (!Number.isSafeInteger(config.max_batch) || config.max_batch < 1)) {
    throw new Error('promote max_batch must be a positive integer');
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
    requiredTests: opt['required-tests'] === undefined ? [] : JSON.parse(opt['required-tests']),
    workflow: opt.workflow ?? process.env.PROMOTE_WORKFLOW_ENGINE === '1',
    validate,
    laneConfig: process.env.LANE_CONFIG ? path.resolve(process.env.LANE_CONFIG) : null };
}

export function enqueue(queue, topics, options) {
  if (options.requiredTests !== undefined && (!Array.isArray(options.requiredTests) || options.requiredTests.length > 512 || options.requiredTests.some(f => typeof f !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f)))) throw Error('invalid required test files');
  if (options.expectedHead !== undefined && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedHead) || topics.length !== 1)) throw new Error('expected head requires one lane and a full commit hash');
  if (options.run !== undefined && (!/^R-\d+$/.test(options.run) || options.expectedHead === undefined || !options.org)) throw new Error('run binding requires a record, run ID and expected head');
  for (const topic of topics) if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(topic)) throw new Error(`invalid lane topic: ${topic}`);
  return queue.transaction((data) => topics.map((topic) => {
    const existing = queueJobs({ ...data, results: [] }).find((job) => job?.topic === topic && !(job.phase === 'completed' && job.result?.outcome === 'refused'));
    if (existing) {
      if (JSON.stringify(existing.requiredTests ?? []) !== JSON.stringify(options.requiredTests ?? []) || existing.expectedHead !== options.expectedHead || existing.run !== options.run || (options.run !== undefined && existing.org !== options.org)) throw new Error(`pending promotion for ${topic} has a different head or run binding; inspect queue before enqueuing`);
      return { id: existing.id, topic, duplicate: true };
    }
    const job = { id: randomUUID(), topic, queued: new Date().toISOString(), ...options };
    data.pending.push(job);
    return { id: job.id, topic, duplicate: false };
  }));
}

function cleanup(job, queue, workspace) {
  if (!job.org) return ['no record discovered; finished tabs preserved'];
  const warnings = [];
  try {
    createHousekeeping({ cwd: queue.project.canonical, org: job.org, herdr: job.herdr, main: git(queue.project.canonical, ['symbolic-ref', '--short', 'HEAD']), selfTab: null,
      log: (entry) => {
        fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify(entry) + '\n');
        if (['close-failed', 'skip-close'].includes(entry.action)) warnings.push(singleLine(JSON.stringify(entry)));
      } }).tick({ cleanup: true, resume: false, workspacePath: workspace });
  } catch (error) { warnings.push(`tab cleanup: ${error.message}`); }
  return warnings;
}

function perform(job, queue) {
  const cwd = queue.project.canonical;
  const env = { ...process.env, LANE_VALIDATE: job.validate ?? undefined, LANE_CONFIG: job.laneConfig ?? undefined };
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
  const reason = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).findLast((line) => /^lane:/.test(line)) ?? r.error?.message ?? `lane promote exited ${r.status}`;
  if (r.error || r.status !== 0) return { outcome: 'refused', reason: singleLine(reason()), log };
  try {
    const tip = job.expectedHead ?? git(cwd, ['rev-parse', 'HEAD']);
    // Persist success before cleanup: a crash must not cause a second gate/FF.
    queue.transaction((data) => { data.current = { ...job, phase: 'promoted', tip, log }; });
    const warnings = workspace ? cleanup(job, queue, workspace) : ['lane worktree no longer present'];
    try {
      // The lane CLI's generic close removes its entire Herdr workspace. Queue
      // cleanup closes only authorized finished tabs, so protect remaining chats.
      const closed = invoke(process.execPath, [job.laneCLI, 'close', job.topic, '--git-only', '--expected-tip', tip], { cwd, env });
      fs.appendFileSync(log, closed + '\n');
    } catch (error) { warnings.push(`lane close: ${error.message}`); }
    return { outcome: 'promoted', tip, reason: warnings.length ? warnings.join('; ') : 'green fast-forward; lane closed', warnings, log };
  } catch (error) {
    return { outcome: 'promoted', reason: `fast-forward succeeded; post-promotion bookkeeping failed: ${error.message}; lane kept for inspection`, warnings: [error.message], log };
  }
}

function performBatch(batch, queue) {
  const first = batch.jobs[0], cwd = queue.project.canonical;
  const env = { ...process.env, LANE_VALIDATE: first.validate ?? undefined, LANE_CONFIG: first.laneConfig ?? undefined,
    PROMOTE_WORKFLOW_ENGINE: first.workflow === undefined ? process.env.PROMOTE_WORKFLOW_ENGINE : first.workflow ? '1' : '0' };
  delete env.HERDR_PANE_ID; delete env.HERDR_TAB_ID; delete env.HERDR_WORKSPACE_ID;
  const directory = path.join(queue.directory, 'batches', batch.id);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'train.log');
  if (!fs.existsSync(receipt)) writeFileAtomic(receipt, JSON.stringify({ schema: 'promotion-train/v1', id: batch.id,
    identity: queue.project.identity, jobs: batch.jobs, phase: 'pending' }, null, 2) + '\n');
  const output = fs.openSync(log, 'a');
  let r;
  try { r = runProjectGateSync({ canonical: cwd, receipt,
    argv: [first.laneCLI, 'promote-batch', receipt, ...(first.workflow ? ['--workflow'] : [])], cwd, env, stdio: ['ignore', output, output] }); }
  finally { fs.closeSync(output); }
  const hostFile = path.join(directory, 'host-gate.json');
  if (r.status !== 0 && fs.existsSync(hostFile)) {
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    if (!host.command_started && host.phase === 'refused') {
      // A capped transition/slot wait is a visible pre-execution refusal,
      // never red test evidence or an interrupted Git integration.
      const train = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (!train.attempts?.length) {
        train.results ??= {};
        for (const job of batch.jobs) train.results[job.id] ??= { outcome: 'refused', reason: host.reason, batch: batch.id, host_receipt: hostFile };
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

function finishBatchJob(job, result, queue) {
  if (result.outcome !== 'promoted') return result;
  const warnings = [...(result.warnings ?? [])];
  if (result.report_to_main_s !== null && result.report_to_main_s !== undefined && job.org && job.run) {
    try {
      const text = `Promotion: report-to-main ${result.report_to_main_s.toFixed(3)} seconds; report ${result.report_at}; main ${result.integrated_at}; batch ${result.batch}; tip ${result.tip}; receipt ${result.receipt}`;
      const env = { ...process.env, ORG_DIR: job.org };
      const run = JSON.parse(invoke(process.execPath, [RECORD, 'show', job.run, '--json'], { cwd: queue.project.canonical, env }));
      if (!run.notes.some(note => note.text === text)) invoke(process.execPath, [RECORD, 'note', job.run, text], { cwd: queue.project.canonical, env });
    } catch (error) { warnings.push(`velocity record: ${error.message}`); }
  }
  // Only failed integration/replacement proof requires retaining the lane.
  // A velocity note is telemetry and must not prevent lifecycle cleanup.
  if ((result.warnings?.length ?? 0) === 0 && result.workspace) {
    warnings.push(...cleanup(job, queue, result.workspace));
    try {
      invoke(process.execPath, [job.laneCLI, 'close', job.topic, '--git-only', '--expected-tip', result.tip], {
        cwd: queue.project.canonical, env: { ...process.env, LANE_CONFIG: job.laneConfig ?? undefined } });
    } catch (error) { warnings.push(`lane close: ${error.message}`); }
  }
  return { ...result, warnings, reason: warnings.length ? warnings.join('; ') : result.reason };
}

export function notice(job, result) {
  return `[promote-queue] id=${job.id} lane=${job.topic} outcome=${result.outcome} reason=${JSON.stringify(singleLine(result.reason))} log=${result.log ?? ''}${result.receipt ? ` receipt=${result.receipt}` : ''}${result.host_receipt ? ` host-receipt=${result.host_receipt}` : ''}`;
}
async function deliver(job, result, queue) {
  const message = notice(job, result);
  const resumed = result.outcome !== 'interrupted' && queue.load().results.some(prior => prior.id === job.id && prior.outcome === 'interrupted');
  const { id: deliveryId, ...delivery } = await promptSupervisor(job.to, message, {
    inbox: inboxPath({ org: job.org, cwd: queue.project.canonical }),
    herdr: job.herdr, attempts: job.attempts, retrySeconds: job.retry,
    id: `promote:${job.id}${resumed ? ':complete' : ''}`, title: 'Promotion notice undelivered',
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
      try { process.kill(owner.pid, 0); } catch { throw error; }
    }
  });
  if (!release) { process.send?.({ ready: true, already_running: true }); return; }
  process.send?.({ ready: true });
  const attempted = new Set();
  try {
    for (;;) {
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
        const maxBatch = promotionSettings(queue.project).max_batch ?? Infinity;
        const next = data.pending.shift();
        if (!next) { release(); release = null; return null; }
        if (next.laneCLI === LANE) {
          // Snapshot whatever is available now. No accumulation timer/window.
          // Different command/config inputs retain their independent gates.
          const key = job => JSON.stringify([job.laneCLI, job.validate ?? null, job.laneConfig ?? null, job.workflow ?? false]);
          const jobs = [next];
          while (jobs.length < maxBatch && data.pending.length && key(data.pending[0]) === key(next)) jobs.push(data.pending.shift());
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
      if (!entry) break;
      const { job, newlyDequeued } = entry;
      if (job.jobs) {
        let batch = job;
        attempted.add(batch.id);
        if (batch.phase === 'batching') {
          try {
            const results = performBatch(batch, queue);
            batch = { ...batch, phase: 'batch-delivering', results, deliveredCount: 0 };
            delete batch.error;
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
  } finally { release?.(); }
}

async function start(queue) {
  const output = fs.openSync(path.join(queue.directory, 'worker.log'), 'a');
  const env = { ...process.env };
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR', 'PROMOTE_WORKFLOW_ENGINE']) delete env[key];
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
    child.once('message', (value) => finish(null, { pid: child.pid, ...value }));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`worker exited ${code} before startup; inspect worker.log; queue retained`)));
  });
}

async function main() {
  const { values: opt, positionals } = parseArgs({ usage: "Usage: node promote/promote.mjs TOPIC [TOPIC ...] [OPTIONS] | --status | --drain", allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, to: { type: 'string' },
    validate: { type: 'string' }, herdr: { type: 'string' }, 'lane-cli': { type: 'string' },
    'delivery-attempts': { type: 'string' }, 'retry-seconds': { type: 'string' },
    'required-tests': { type: 'string' }, 'expected-head': { type: 'string' }, 'if-current-run': { type: 'string' },
    drain: { type: 'boolean' }, status: { type: 'boolean' }, workflow: { type: 'boolean' },
  } });
  const queue = queueFor(opt.repo);
  if (opt.status) { process.stdout.write(JSON.stringify({ queue: queue.file, ...queue.load() }, null, 2) + '\n'); return; }
  if (opt.drain) { await drain(queue); return; }
  if (!positionals.length) throw new Error('usage: promote.mjs TOPIC [TOPIC ...] [--repo PROJECT] [--to SUPERVISOR] | --status | --drain');
  const jobs = enqueue(queue, positionals, settings(queue.project, opt));
  const worker = await start(queue);
  process.stdout.write(JSON.stringify({ jobs, worker, queue: queue.file }) + '\n');
}
if (isMain(import.meta.url)) main().catch((error) => { console.error(`promote: ${error.message}`); process.exitCode = 1; });
