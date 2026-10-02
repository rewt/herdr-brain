#!/usr/bin/env node
// A durable FIFO and one detached, finite drain worker. No model calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';

const SELF = fileURLToPath(import.meta.url);
const LANE = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const singleLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);

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
function settings(project, opt) {
  const configFile = path.join(project.canonical, '.promote.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const to = opt.to ?? config.to ?? 'supervisor-herdr';
  const attempts = Number(opt['delivery-attempts'] ?? config.delivery_attempts ?? 5);
  const retry = Number(opt['retry-seconds'] ?? config.retry_seconds ?? 10);
  if (typeof to !== 'string' || !to.trim() || !Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(retry) || retry < 0) throw new Error('invalid supervisor or delivery settings');
  const validate = opt.validate ?? process.env.LANE_VALIDATE ?? config.validate ?? null;
  if (validate !== null && (typeof validate !== 'string' || !validate.trim())) throw new Error('validation override must be a nonempty command');
  const laneCLI = path.resolve(opt['lane-cli'] ?? LANE);
  return { to, attempts, retry, herdr: opt.herdr ?? 'herdr', laneCLI,
    org: opt.org ? path.resolve(opt.org) : findOrgDir({ cwd: project.canonical }),
    validate,
    laneConfig: process.env.LANE_CONFIG ? path.resolve(process.env.LANE_CONFIG) : null };
}

export function enqueue(queue, topics, options) {
  for (const topic of topics) if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(topic)) throw new Error(`invalid lane topic: ${topic}`);
  return queue.transaction((data) => topics.map((topic) => {
    const existing = [data.current, ...data.pending].find((job) => job?.topic === topic);
    if (existing) return { id: existing.id, topic, duplicate: true };
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
  try { r = spawnSync(process.execPath, [job.laneCLI, 'promote', job.topic], { cwd, env, stdio: ['ignore', output, output] }); }
  finally { fs.closeSync(output); }
  const reason = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).findLast((line) => /^lane:/.test(line)) ?? r.error?.message ?? `lane promote exited ${r.status}`;
  if (r.error || r.status !== 0) return { outcome: 'refused', reason: singleLine(reason()), log };
  try {
    const tip = git(cwd, ['rev-parse', `refs/heads/lane/${job.topic}`]);
    // Persist success before cleanup: a crash must not cause a second gate/FF.
    queue.transaction((data) => { data.current = { ...job, phase: 'promoted', tip, log }; });
    const warnings = workspace ? cleanup(job, queue, workspace) : ['lane worktree no longer present'];
    try {
      if (git(cwd, ['rev-parse', `refs/heads/lane/${job.topic}`]) !== tip) throw new Error('lane tip changed after promotion; lane kept');
      git(cwd, ['merge-base', '--is-ancestor', tip, 'HEAD']);
      // The lane CLI's generic close removes its entire Herdr workspace. Queue
      // cleanup closes only authorized finished tabs, so protect remaining chats.
      const closed = invoke(process.execPath, [job.laneCLI, 'close', job.topic, '--git-only'], { cwd, env });
      fs.appendFileSync(log, closed + '\n');
    } catch (error) { warnings.push(`lane close: ${error.message}`); }
    return { outcome: 'promoted', tip, reason: warnings.length ? warnings.join('; ') : 'green fast-forward; lane closed', warnings, log };
  } catch (error) {
    return { outcome: 'promoted', reason: `fast-forward succeeded; post-promotion bookkeeping failed: ${error.message}; lane kept for inspection`, warnings: [error.message], log };
  }
}

export function notice(job, result) {
  return `[promote-queue] id=${job.id} lane=${job.topic} outcome=${result.outcome} reason=${JSON.stringify(singleLine(result.reason))} log=${result.log ?? ''}`;
}
async function deliver(job, result, queue) {
  const message = notice(job, result);
  let error;
  for (let attempt = 1; attempt <= job.attempts; attempt++) {
    try {
      invoke(job.herdr, ['agent', 'prompt', job.to, message], { cwd: queue.project.canonical, timeout: 10000 });
      return { delivered: true, message };
    } catch (e) { error = e.message; }
    if (attempt < job.attempts) await delay(job.retry * 1000);
  }
  try { invoke(job.herdr, ['notification', 'show', 'Promotion notice undelivered', '--body', message], { timeout: 10000 }); } catch {}
  return { delivered: false, message, delivery_error: error };
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
  try {
    for (;;) {
      const job = queue.transaction((data) => {
        if (data.current) return data.current;
        const next = data.pending.shift();
        if (!next) { release(); release = null; return null; }
        data.current = { ...next, phase: 'promoting' };
        return { ...data.current, fresh: true };
      });
      if (!job) break;
      let result;
      if (job.phase === 'completed') result = job.result;
      else if (!job.fresh) result = { outcome: 'interrupted', tip: job.tip,
        reason: `previous worker stopped in ${job.phase}; lane preserved; inspect Git and log before explicitly re-enqueuing`, log: job.log ?? path.join(queue.directory, `${job.id}.log`) };
      else {
        try { result = perform(job, queue); }
        catch (error) { result = { outcome: 'refused', reason: error.message, log: path.join(queue.directory, `${job.id}.log`) }; }
      }
      queue.transaction((data) => { data.current = { ...job, fresh: undefined, phase: 'completed', result }; });
      const delivery = await deliver(job, result, queue);
      queue.transaction((data) => {
        data.results.push({ ...job, fresh: undefined, ...result, ...delivery, finished: new Date().toISOString() });
        data.current = null;
      });
      process.stdout.write(JSON.stringify({ id: job.id, topic: job.topic, ...result, ...delivery }) + '\n');
    }
  } finally { release?.(); }
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
    const timer = setTimeout(() => finish(new Error('worker startup unconfirmed; inspect worker.log and locks; queued requests retained')), 5000);
    child.once('message', (value) => finish(null, { pid: child.pid, ...value }));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`worker exited ${code} before startup; inspect worker.log; queue retained`)));
  });
}

async function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, to: { type: 'string' },
    validate: { type: 'string' }, herdr: { type: 'string' }, 'lane-cli': { type: 'string' },
    'delivery-attempts': { type: 'string' }, 'retry-seconds': { type: 'string' },
    drain: { type: 'boolean' }, status: { type: 'boolean' },
  } });
  const queue = queueFor(opt.repo);
  if (opt.status) { process.stdout.write(JSON.stringify({ queue: queue.file, ...queue.load() }, null, 2) + '\n'); return; }
  if (opt.drain) { await drain(queue); return; }
  if (!positionals.length) throw new Error('usage: promote.mjs TOPIC [TOPIC ...] [--repo PROJECT] [--to SUPERVISOR] | --status | --drain');
  const jobs = enqueue(queue, positionals, settings(queue.project, opt));
  const worker = await start(queue);
  process.stdout.write(JSON.stringify({ jobs, worker, queue: queue.file }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch((error) => { console.error(`promote: ${error.message}`); process.exitCode = 1; });
