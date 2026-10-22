#!/usr/bin/env node
// A durable FIFO and one detached, finite drain worker. No model calls.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { closeoutPolicy, claimRetirementOwner, retryPromotionCloseout } from '../lib/closeout.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { policyLocation, present, homeProject } from '../lib/config-home.mjs';
import { readPolicyFile, validatePromote } from '../lib/config-policy.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { findOrgDir, loadEvents, withLock, writeFileAtomic } from '../lib/store.mjs';
import { guardPromotionJob, readOwnedRun, requireController, ownerBinding, sameOwner, brainOwner, continueOwnerRelease } from '../lib/run-owner.mjs';
import { bundleRelease, forwardRelease, operationFile } from '../lib/releases.mjs';
import { acquireLock, PROMOTION_LOCK_WAIT_MS } from '../lanes/promotion-lock.mjs';
import { createRetirement } from '../lib/retire-runtime.mjs';
import { consumeRetirement } from '../lib/retire-trigger.mjs';
import { retirementHold } from '../lib/retire-hold.mjs';
import { promptSupervisor, inboxPath } from '../supervisor/prompt-supervisor.mjs';
import { runProjectGateSync } from './gate-profile.mjs';
import { reconcileBatchCompletion, accountUncapturedMember } from './completion.mjs';
import { verifyTrainResult, terminalTrainJobs } from './evidence.mjs';
import { probeNativeGate, nativeWorkerEvidence, liveNativeWorker } from './native-context.mjs';
import { CAPABILITIES, DECLARED_SCHEMA, sameDeclaration, snapshotDeclaration, refuse as declaredRefusal } from './declaration.mjs';
import { readDeclared, fenceDeclaredMode } from '../lanes/validation.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { bindRequirements, assertBoundRequirements } from './declared-selection.mjs';
import { fenceGateIdentity, resolveGateProfile } from './gate-profile.mjs';
import { runTrain } from './train.mjs';

const SELF = fileURLToPath(import.meta.url);
const LANE = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const singleLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
const capableWorkers = new Set();
export function requireDeclaredWorker(release, canonical) {
  if (!release) throw declaredRefusal('declared jobs require a bound capable worker');
  const worker = operationFile('promote/promote.mjs', release);
  if (capableWorkers.has(worker)) return;
  const result = spawnSync(process.execPath, [worker, '--capabilities'], { cwd: canonical, encoding: 'utf8', timeout: 2000, maxBuffer: 65536 });
  let capabilities;
  try { capabilities = JSON.parse(result.stdout); } catch {}
  if (result.error || result.status !== 0 || JSON.stringify(capabilities) !== JSON.stringify(CAPABILITIES)) throw declaredRefusal('bound release does not support the declaration, typed selection and execution receipt; keep this project held');
  capableWorkers.add(worker);
}

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

function declaredWork(project) {
  const file = path.join(project.identity, 'promote/queue.json');
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return [...(data.pending ?? []), ...(data.current?.jobs ?? (data.current ? [data.current] : [])), ...(data.interrupted ?? []).flatMap(batch => batch.jobs ?? [batch]),
    ...(data.results ?? []).filter(job => job.cleanup?.state === 'pending')].filter(job => job.gate_mode);
}
function hasDeclaredWork(project) { return declaredWork(project).length > 0; }
export function fenceDeclaredTarget(project, { jobs: supplied = [] } = {}) {
  const jobs = [...declaredWork(project), ...supplied.filter(job => job.gate_mode)];
  fenceDeclaredMode(project.canonical, { captured: [...jobs, ...supplied] });
  const declared = jobs.length || readDeclared(project.canonical, { audit: false });
  if (!declared) return false;
  executionIdentity(project);
  for (const job of jobs) executionIdentity(project, { bound: job.execution_identity ?? null });
  const file = path.join(project.identity, 'promote/queue.json');
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const batch of [data.current, ...(data.interrupted ?? [])]) {
      if (!batch?.jobs?.some(job => job.gate_mode)) continue;
      const receipt = path.join(project.identity, 'promote/batches', batch.id, 'train.json');
      if (fs.existsSync(receipt)) fenceGateIdentity(project.canonical, process.env, { captured: JSON.parse(fs.readFileSync(receipt, 'utf8')) });
    }
  }
  return true;
}
export function queueFor(cwd, { readOnly = false } = {}) {
  const binding = homeProject(cwd, process.env, { inspection: true }), project = binding?.git ?? gitProject(cwd);
  if (!readOnly) {
    fenceDeclaredTarget(project);
    homeProject(cwd);
    if (!hasDeclaredWork(project)) readDeclared(project.canonical);
  }
  if (binding) for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  const directory = path.join(project.identity, 'promote');
  const file = path.join(directory, 'queue.json');
  if (!readOnly) fs.mkdirSync(directory, { recursive: true });
  const load = () => {
    if (!fs.existsSync(file)) return { identity: project.identity, pending: [], current: null, results: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.identity !== project.identity || !Array.isArray(data.pending) || !Array.isArray(data.results)) throw new Error('invalid promotion queue identity or contents');
    return data;
  };
  const transaction = (fn) => {
    fenceDeclaredMode(project.canonical, { captured: declaredWork(project) });
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
  const { onOutput, ...commandOptions } = options;
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...commandOptions });
  onOutput?.(r.stdout ?? '');
  if (r.error || r.status !== 0) throw new Error(singleLine(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`));
  return (r.stdout ?? '').trim();
}
function git(cwd, args) { return invoke('git', ['-C', cwd, ...args]); }
function settingsRefusal(code, reason) {
  return Object.assign(new Error(`${code}: ${singleLine(reason)}`), { code });
}
function promotionSettings(project) {
  const selected = policyLocation(project.canonical, 'promote', process.env, { canonical: project.canonical });
  if (selected.home) return readPolicyFile(selected.file, 'promote');
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
  try {
    const declaration = tracked ? checked(read(['show', `${commit}:.promote.json`])) : '{}';
    // Adoption opts into the shared strict reader. Legacy projects retain
    // their committed-at-HEAD parser and refusal messages byte for byte.
    config = selected.binding ? validatePromote(parseUniqueJson(declaration)) : JSON.parse(declaration);
  }
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
    org, expectedHead, run, claimedBy: opt['claimed-by'], claimGeneration: opt['claim-generation'] === undefined ? undefined : Number(opt['claim-generation']), existingWorker: opt['existing-worker'] === true,
    superseded: opt['superseded-runs'] === undefined ? [] : JSON.parse(opt['superseded-runs']),
    requiredTests: opt['required-tests'] === undefined ? [] : JSON.parse(opt['required-tests']),
    validate,
    laneConfig: process.env.LANE_CONFIG ? path.resolve(process.env.LANE_CONFIG) : null };
}

export function checkDeclaredJobs(queue, jobs, { recoveryFirst = true } = {}) {
  fenceDeclaredTarget(queue.project, { jobs });
  const recovered = new Set(), deferred = new Set();
  // Every stage, including recovery, retains the original identity fence.
  for (const job of jobs.filter(job => job.gate_mode)) {
    if (job.gate_mode !== DECLARED_SCHEMA || job.validate != null || job.laneConfig != null) throw declaredRefusal('incompatible queued job requires explicit disposition and re-enqueue');
    if (!job.declared) throw declaredRefusal('captured declaration is missing');
    executionIdentity(queue.project, { bound: job.execution_identity ?? null });
    assertBoundRequirements(job.requiredTests ?? [], job.declared.value);
  }
  const data = queue.load();
  for (const batch of [data.current, ...(data.interrupted ?? [])]) {
    if (!batch?.jobs) continue;
    const members = jobs.filter(job => batch.jobs.some(member => member.id === job.id));
    if (!members.length) continue;
    const file = path.join(queue.directory, 'batches', batch.id, 'train.json');
    const terminal = terminalTrainJobs({ file, project: queue.project, jobs: members });
    for (const id of terminal) recovered.add(id);
    if (recoveryFirst && terminal.size) for (const member of members) deferred.add(member.id);
  }
  const unfinished = jobs.filter(job => !recovered.has(job.id) && !deferred.has(job.id));
  const current = unfinished.length ? readDeclared(queue.project.canonical) : null;
  if (current) executionIdentity(queue.project);
  for (const job of unfinished) {
    if (!current && !job.gate_mode) continue;
    if (job.gate_mode !== DECLARED_SCHEMA || job.validate != null || job.laneConfig != null) throw declaredRefusal('incompatible queued job; explicit disposition and re-enqueue required');
    sameDeclaration(job.declared, current);
    requireDeclaredWorker(job.release, queue.project.canonical);
  }
}

export function enqueue(queue, topics, options) {
  fenceDeclaredTarget(queue.project);
  options = { ...options, release: bundleRelease() };
  const declared = readDeclared(queue.project.canonical, { override: options.validate });
  if (declared) {
    const identity = executionIdentity(queue.project);
    if (options.laneCLI && options.laneCLI !== LANE) throw declaredRefusal('declared jobs require the capable bundled lane CLI');
    requireDeclaredWorker(options.release, queue.project.canonical);
    resolveGateProfile(queue.project.canonical); // full host profile before queue writes
    const requiredTests = bindRequirements(options.requiredTests ?? [], declared.value);
    options = { ...options, laneCLI: LANE, validate: null, laneConfig: null, gate_mode: declared.schema,
      declared: snapshotDeclaration(declared), execution_identity: identity, requiredTests };
  } else if (options.requiredTests !== undefined && (!Array.isArray(options.requiredTests) || options.requiredTests.length > 512 || options.requiredTests.some(f => typeof f !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f)))) throw Error('invalid required test files');
  if (options.expectedHead !== undefined && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedHead) || topics.length !== 1)) throw new Error('expected head requires one lane and a full commit hash');
  if (options.run !== undefined && (!/^R-\d+$/.test(options.run) || options.expectedHead === undefined || !options.org)) throw new Error('run binding requires a record, run ID and expected head');
  if (options.superseded !== undefined && (!Array.isArray(options.superseded) || (options.superseded.length && !options.run) || new Set(options.superseded).size !== options.superseded.length || options.superseded.some(id => !/^R-\d+$/.test(id)))) throw Error('invalid explicit superseded runs');
  for (const topic of topics) if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(topic)) throw new Error(`invalid lane topic: ${topic}`);
  const heads = new Map(declared ? topics.map(topic => [topic, options.expectedHead ?? git(queue.project.canonical, ['rev-parse', '--verify', `refs/heads/lane/${topic}`])]) : []);
  const admit = () => queue.transaction((data) => {
    if (options.existingWorker && !liveNativeWorker(queue.project.identity)) throw settingsRefusal('AUTOPILOT_NO_NATIVE_WORKER', 'no live native promote worker; supervisor must use the bare enqueue in its authorized context');
    return topics.map((topic) => {
      const owned = options.run ? readOwnedRun(options.org, options.run) : null;
      if (owned) {
        if (options.claimedBy) {
          const binding = requireController(owned, options.claimedBy);
          if (!sameOwner(binding.owner, brainOwner(options.claimedBy)) || (options.claimGeneration !== undefined && binding.generation !== options.claimGeneration)) throw Error(`RUN_OWNED_ELSEWHERE: ${owned.id} owner=${JSON.stringify(owned.owner)} generation=${owned.owner_generation}`);
        } else if (owned.owner && !owned.owner.legacy) throw Error(`RUN_OWNED_ELSEWHERE: ${owned.id} owner=${JSON.stringify(owned.owner)}`);
        if (owned.owner) options.ownership = ownerBinding(owned);
      }
      const existing = queueJobs({ ...data, results: [] }).find((job) => job?.topic === topic && !(job.phase === 'completed' && ['refused', 'timeout'].includes(job.result?.outcome)));
      if (existing) {
        if (JSON.stringify(existing.superseded ?? []) !== JSON.stringify(options.superseded ?? []) || JSON.stringify(existing.requiredTests ?? []) !== JSON.stringify(options.requiredTests ?? []) || existing.expectedHead !== (heads.get(topic) ?? options.expectedHead) || existing.run !== options.run || (options.run !== undefined && existing.org !== options.org)) throw new Error(`pending promotion for ${topic} has a different head or run binding; inspect queue before enqueuing`);
        return { id: existing.id, topic, duplicate: true };
      }
      const record = options.run ? loadEvents(options.org) : null;
      if (record?.tornTail) throw Error('incomplete record event; nothing queued');
      const job = { id: randomUUID(), topic, queued: new Date().toISOString(), ...options,
        ...(declared ? { expectedHead: heads.get(topic) } : {}),
        ...(record ? { admittedSeq: record.events.at(-1)?.seq ?? 0 } : {}) };
      data.pending.push(job);
      return { id: job.id, topic, duplicate: false };
    });
  });
  // Serialize admission (including its durable queue commit) with record writes.
  // A writer that saw no queued member must finish before its admission snapshot;
  // otherwise a note could slip between the guard's queue read and enqueue.
  return options.run ? withLock(options.org, admit) : admit();
}

function cleanup(job, queue, workspace) {
  guardPromotionJob(job);
  const org = job.org ?? findOrgDir({ cwd: queue.project.canonical });
  // No record authorizes no tab retirement. This is a durable informational
  // outcome; Git-only cleanup must still prove vacancy through the lane guard.
  if (!org) return { warnings: [], diagnostics: ['no record discovered; finished tabs preserved'] };
  const warnings = [];
  const log = entry => {
    fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify(entry) + '\n');
    if (['keep', 'held', 'close-failed', 'skip-close'].includes(entry.action)) warnings.push(singleLine(JSON.stringify(entry)));
  };
  try {
    const retirement = createRetirement({ cwd: queue.project.canonical, org, herdr: job.herdr,
      main: git(queue.project.canonical, ['symbolic-ref', '--short', 'HEAD']), selfTab: null, log });
    const plan = retirement.plan(workspace);
    for (const kept of plan.keep) log({ action: 'keep', ...kept });
    for (const diagnostic of plan.diagnostics) log({ action: 'reference-diagnostic', ...diagnostic });
    retirement.apply(plan, workspace);
  } catch (error) { warnings.push(`tab cleanup: ${error.message}`); }
  return { warnings, diagnostics: [] };
}

function perform(job, queue) {
  guardPromotionJob(job);
  const native = probeNativeGate();
  if (!native.ok) return { outcome: 'refused', code: native.code, reason: native.reason, native_context: native };
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

async function performBatch(batch, queue, settings) {
  // The train checks ownership inside per-member capture. Checking all jobs
  // here would turn one invalid binding into an interruption of every sibling.
  const first = batch.jobs[0], cwd = queue.project.canonical;
  const env = { ...process.env, LANE_VALIDATE: first.validate ?? undefined, LANE_CONFIG: first.laneConfig ?? undefined };
  delete env.HERDR_PANE_ID; delete env.HERDR_TAB_ID; delete env.HERDR_WORKSPACE_ID;
  const directory = path.join(queue.directory, 'batches', batch.id);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'train.log');
  if (!fs.existsSync(receipt)) writeFileAtomic(receipt, JSON.stringify({ schema: first.gate_mode ? 'promotion-train/v2' : 'promotion-train/v1', id: batch.id,
    identity: queue.project.identity, jobs: batch.jobs, phase: 'pending', started_at: new Date().toISOString() }, null, 2) + '\n');
  // A completed train only needs record recovery. Do not re-enter its host
  // admission, preparation, validation or integration command.
  let retained = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (retained.phase !== 'complete' && terminalTrainJobs({ file: receipt, project: queue.project, jobs: batch.jobs }).size) {
    await runTrain({ file: receipt, canonical: cwd, identity: queue.project.identity,
      main: retained.integration_branch ?? retained.completion?.branch, prepare: [],
      validation: { declared: batch.jobs[0].declared }, recoveryOnly: true });
    retained = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  }
  if (retained.phase === 'complete') {
    if (batch.jobs.some(job => job.gate_mode)) {
      const verified = terminalTrainJobs({ file: receipt, project: queue.project, jobs: batch.jobs });
      if (batch.jobs.some(job => !verified.has(job.id))) throw declaredRefusal('terminal train binding or execution evidence cannot be verified; preserve the batch for inspection');
    }
    return batch.jobs.map(job => ({ job, result: { ...retained.results[job.id], log, receipt,
      ...(retained.host_receipt ? { host_receipt: retained.host_receipt } : {}) } }));
  }
  checkDeclaredJobs(queue, batch.jobs.filter(job => !retained.results?.[job.id]), { recoveryFirst: false });
  const refuseNative = native => {
    const retained = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    retained.native_context = native; retained.results ??= {};
    // Integrated checkpoints belong to recovery, never to a new refusal.
    if (!retained.attempts?.length) {
      for (const job of batch.jobs) retained.results[job.id] = { outcome: 'refused', code: native.code, reason: native.reason, batch: batch.id };
      retained.phase = 'complete'; retained.groups = [];
      writeFileAtomic(receipt, JSON.stringify(retained, null, 2) + '\n');
      return batch.jobs.map(job => ({ job, result: { ...retained.results[job.id], log, receipt } }));
    }
    writeFileAtomic(receipt, JSON.stringify(retained, null, 2) + '\n');
    throw settingsRefusal(native.code, `${native.reason}; prior integration checkpoints retained for inspection`);
  };
  const native = probeNativeGate();
  if (!native.ok) return refuseNative(native);
  const output = fs.openSync(log, 'a');
  let r;
  try { r = runProjectGateSync({ canonical: cwd, receipt, settings,
    argv: [first.laneCLI, 'promote-batch', receipt], cwd, env, stdio: ['ignore', output, output] }); }
  finally { fs.closeSync(output); }
  const hostFile = path.join(directory, 'host-gate.json');
  if (r.status !== 0 && fs.existsSync(hostFile)) {
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    // The host may refuse before replacing a prior command_started marker.
    // Its native refusal must retain checkpoints and block automatic replay.
    if (host.phase === 'refused' && host.code?.startsWith('PROMOTE_NATIVE_')) {
      const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      return refuseNative({ ...saved.native_context, ok: false, code: host.code, reason: host.reason });
    }
    if (host.phase === 'timeout') {
      const train = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      train.results ??= {};
      // The host's TERM can unblock spawnSync before it terminates the train.
      // That last preparation may checkpoint a refusal during cancellation;
      // the confirmed host timeout owns only those interrupted members.
      const last = train.attempts?.at(-1);
      const cancelled = new Set(last?.phase === 'invalid' && last.prepare?.failure?.signal ? last.ids : []);
      const limit = host.gate_timeout?.kind === 'idle' ? 'no-output' : 'wall-clock';
      const reason = `gate ${limit} limit exceeded; ${batch.jobs.length === 1 ? 'lane isolated for correction' : 'batch timed out; re-enqueue lanes individually'}`;
      for (const job of batch.jobs) {
        if (!train.results[job.id] || (train.results[job.id].outcome === 'refused' && cancelled.has(job.id)))
          train.results[job.id] = { outcome: 'timeout', reason, batch: batch.id, host_receipt: hostFile };
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
  const held = retirementHold(queue.project.canonical) ? ':held' : '';
  if (!org) return `no-record${held}`;
  const stat = fs.statSync(path.join(org, 'events.jsonl'));
  const request = path.join(org, 'retirement/request.json');
  return `${stat.size}:${stat.mtimeMs}:${fs.existsSync(request) ? JSON.parse(fs.readFileSync(request, 'utf8')).revision : 0}${held}`;
}

export function finishCleanup(job, result, queue, { now = Date.now() } = {}) {
  fenceDeclaredTarget(queue.project, { jobs: [job] });
  if (job.gate_mode) executionIdentity(queue.project, { bound: job.execution_identity ?? null });
  const delegated = () => ({ ...result, cleanup: { state: 'complete', owner: 'closeout-queue' },
    reason: 'green fast-forward; closeout delegated to the event queue' });
  let ownership;
  const warnings = [];
  let held;
  const checkHold = () => {
    held = retirementHold(queue.project.canonical);
    if (!held) return;
    fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify({ action: 'held', why: held }) + '\n');
    throw Error(held);
  };
  const diagnostics = (result.warnings ?? []).filter(w => w.startsWith('velocity record:'));
  try {
    if (closeoutPolicy(queue.project.canonical)) return delegated();
    ownership = claimRetirementOwner(queue.project.identity, { waitMs: 1000 });
    if (closeoutPolicy(queue.project.canonical)) return delegated();
    checkHold();
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
      catch {
        if (workspace) {
          const retirement = createRetirement({ cwd: queue.project.canonical, org: job.org, herdr: job.herdr,
            log: row => fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify(row) + '\n') });
          for (const ws of retirement.observe(workspace).workspaces.filter(w => w.worktree.checkout_path === workspace)) retirement.closeEmptyWorkspace(ws.workspace_id, workspace);
        }
        return { ...result, warnings: diagnostics, cleanup: { state: 'complete' }, reason: 'green fast-forward; cleanup complete' };
      }
      throw Error('lane branch remains without its worktree; inspect before cleanup');
    }
    const tabs = cleanup(job, queue, workspace);
    warnings.push(...tabs.warnings);
    diagnostics.push(...tabs.diagnostics);
    checkHold();
    if (!warnings.length) invoke(process.execPath, [job.laneCLI, 'close', job.topic, '--git-only', '--expected-tip', result.tip], {
      cwd: queue.project.canonical, env: { ...process.env, ORG_DIR: job.org ?? undefined, HERDR_RETIRE_HERDR: job.herdr, LANE_CONFIG: job.laneConfig ?? undefined },
      onOutput: output => {
        for (const line of output.split('\n').filter(Boolean)) {
          let entry; try { entry = JSON.parse(line); } catch { entry = { action: 'lane-close-output', text: line }; }
          fs.appendFileSync(path.join(queue.directory, `${job.id}-cleanup.jsonl`), JSON.stringify(entry) + '\n');
        }
      } });
  } catch (error) { warnings.push(`lane cleanup: ${error.message}`); }
  finally { ownership?.(); }
  let revision;
  try { revision = cleanupRevision(job, queue); } catch (e) { revision = `unreadable:${e.message}`; }
  const attempts = (result.cleanup?.revision === revision ? result.cleanup.attempts ?? 0 : 0) + 1;
  return { ...result, warnings: [...diagnostics, ...warnings], cleanup: { state: warnings.length ? 'pending' : 'complete', warnings,
    ...(held ? { outcome: 'held' } : {}),
    revision, attempts, attempted_at: now, next_attempt_at: now + Math.min(3600000, 60000 * 2 ** (attempts - 1)),
    last_refusal: warnings.length ? warnings.join('; ') : null },
    reason: warnings.length ? `integrated-but-cleanup-pending: ${warnings.join('; ')}` : 'green fast-forward; cleanup complete' };
}

// Restart/reconciliation retries only the cleanup checkpoint, never the gate.
export function retryCleanup(queue, options = {}) {
  fenceDeclaredTarget(queue.project);
  for (const job of queue.load().results.filter(row => row.cleanup?.state === 'pending' && row.gate_mode))
    executionIdentity(queue.project, { bound: job.execution_identity ?? null });
  // Housekeeping and the drain share this queue-owned retry lock. Keep the
  // short queue transactions available to enqueuers and bundle continuations.
  const release = acquireLock(path.join(queue.directory, 'cleanup.lock'));
  try { return retryCleanupLocked(queue, options); }
  finally { release(); }
}
function retryCleanupLocked(queue, { now = Date.now() } = {}) {
  for (const saved of queue.load().results.filter(r => r.outcome === 'promoted' && r.cleanup?.state === 'pending' && r.reconciliation?.state !== 'pending')) {
    if (saved.gate_mode) executionIdentity(queue.project, { bound: saved.execution_identity ?? null });
    let revision;
    try { revision = cleanupRevision(saved, queue); } catch (e) { revision = `unreadable:${e.message}`; }
    if (saved.cleanup.revision === revision && ((saved.cleanup.attempts ?? 0) >= 5 || now < saved.cleanup.next_attempt_at)) continue;
    if (saved.release && saved.release.root !== bundleRelease().root) {
      try {
        invoke(process.execPath, [operationFile('promote/promote.mjs', saved.release), '--cleanup-job', saved.id, '--repo', queue.project.canonical]);
      } catch (error) {
        queue.transaction(data => {
          const row = data.results.findLast(r => r.id === saved.id);
          if (!row) return;
          const warnings = [`lane cleanup: ${error.message}`];
          const attempts = (row.cleanup?.revision === revision ? row.cleanup.attempts ?? 0 : 0) + 1;
          Object.assign(row, { warnings: [...(row.warnings ?? []).filter(w => w.startsWith('velocity record:')), ...warnings],
            cleanup: { state: 'pending', warnings, revision, attempts, attempted_at: now,
              next_attempt_at: now + Math.min(3600000, 60000 * 2 ** (attempts - 1)), last_refusal: warnings.join('; ') },
            reason: `integrated-but-cleanup-pending: ${warnings.join('; ')}` });
        });
      }
      continue;
    }
    const result = finishCleanup(saved, saved, queue, { now });
    queue.transaction(data => {
      const row = data.results.findLast(r => r.id === saved.id);
      if (row) Object.assign(row, result);
    });
  }
}

function consumeRequests(queue) {
  try {
    if (closeoutPolicy(queue.project.canonical)) {
      const completedJobs = queue.load().closeout_pending ?? [];
      for (const org of new Set(completedJobs.map(job => job.org).filter(Boolean)))
        retryPromotionCloseout({ cwd: queue.project.canonical, org, jobs: completedJobs.filter(job => job.org === org) });
      if (completedJobs.length) queue.transaction(data => {
        data.closeout_pending = (data.closeout_pending ?? []).filter(job => !completedJobs.some(done => done.id === job.id));
      });
      return;
    }
    const jobs = queueJobs(queue.load());
    const discovered = findOrgDir({ cwd: queue.project.canonical });
    const orgs = new Set([discovered, ...jobs.map(j => j.org)].filter(Boolean));
    const ownership = claimRetirementOwner(queue.project.identity, { waitMs: 1000 });
    try {
    for (const org of orgs) try {
      consumeRetirement({ org, retirement: () => createRetirement({ cwd: queue.project.canonical, org,
        herdr: jobs.find(j => j.org === org)?.herdr, log: result => process.stderr.write(JSON.stringify(result) + '\n') }),
        output: result => { if (result.action === 'held') process.stderr.write(JSON.stringify(result) + '\n'); } });
    } catch (e) { process.stderr.write(`integrated-but-cleanup-pending: retirement catch-up: ${e.message}\n`); }
    } finally { ownership(); }
  } catch (e) { process.stderr.write(`integrated-but-cleanup-pending: retirement discovery: ${e.message}\n`); }
}

function finishBatchJob(job, result, queue) {
  if (job.gate_mode) executionIdentity(queue.project, { bound: job.execution_identity ?? null });
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
      release = acquireLock(path.join(queue.project.identity, 'lane-promote.lock'), { waitMs: PROMOTION_LOCK_WAIT_MS });
      if (!verifyTrainResult({ ...result, id: job.id }, { project: queue.project, saved: { head: job.expectedHead, run: job.run, org: job.org, lane: job.topic } })) throw Error('lane replacement lacks original integrated proof');
      if (git(result.workspace, ['rev-parse', 'HEAD']) !== result.tip) invoke(process.execPath, [fileURLToPath(new URL('../settle/replace-lane-head.mjs', import.meta.url)), JSON.stringify({
        workspace: result.workspace, repo: queue.project.canonical, common: queue.project.identity,
        branch: `refs/heads/lane/${job.topic}`, from: result.source_head, to: result.tip,
        main: git(queue.project.canonical, ['symbolic-ref', '--short', 'HEAD']),
        mainHead: git(queue.project.canonical, ['rev-parse', 'HEAD']),
      })], { cwd: queue.project.canonical });
      const replaced = { ...result, replacement_pending: false, warnings: [], reason: 'green batch fast-forward; lane replacement recovered' };
      // The retirement reader must observe the verified replacement checkpoint
      // before cleanup. A local-only update still looks like live replacement
      // work to the shared guard, including the child Git-only lane close.
      queue.transaction(data => {
        const member = data.current?.results?.find(entry => entry.job.id === job.id);
        if (!member || member.result.tip !== result.tip || member.result.receipt !== result.receipt)
          throw Error('current replacement checkpoint changed');
        member.result = replaced;
      });
      result = replaced;
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
  // A resumed native refusal is a distinct exception, not a rewrite of the
  // immutable earlier interruption notice. Repeated copies adopt this ID.
  const nativeRefusal = result.outcome === 'interrupted' && result.code?.startsWith('PROMOTE_NATIVE_');
  const suffix = nativeRefusal ? `:native-refusal:${createHash('sha256').update(message).digest('hex').slice(0, 16)}` : result.reconciliation?.state === 'pending' ? `:reconciliation-pending:${createHash('sha256').update(message).digest('hex').slice(0, 16)}` : reconciled ? ':reconciled' : resumed ? ':complete' : '';
  const { id: deliveryId, ...delivery } = await promptSupervisor(job.to, message, {
    inbox: inboxPath({ org: job.org, cwd: queue.project.canonical }),
    herdr: job.herdr, attempts: job.attempts, retrySeconds: job.retry,
    // Durable inbox ownership lets queue accounting finish without waiting for
    // a busy composer. An explicitly configured caller wait remains supported.
    waitSeconds: process.env.SUPERVISOR_INPUT_WAIT_SECONDS ?? 0,
    id: `promote:${job.id}${suffix}`, title: 'Promotion notice undelivered',
    shadowEvidence: { channel: 'promote-queue', validated: true, outcome: result.outcome },
    log: (line) => process.stderr.write(line + '\n'),
  });
  return { ...delivery, delivery_id: deliveryId };
}

export async function drain(queue, { attempted = new Set() } = {}) {
  checkDeclaredJobs(queue, queueJobs(queue.load()).filter(job => !job.finished));
  let release;
  let handedOff = false;
  const rememberCompletion = (data, job, result) => {
    if (job.org && job.run && result.outcome === 'promoted' && result.tip && result.reconciliation?.state !== 'pending' && result.cleanup?.owner === 'closeout-queue') {
      // Persist the bounded notification outbox with completion. A crash before
      // finally can replay these exact jobs without visiting promotion history.
      data.closeout_pending ??= [];
      if (!data.closeout_pending.some(row => row.id === job.id))
        data.closeout_pending.push({ id: job.id, org: job.org, topic: job.topic, run: job.run, tip: result.tip });
    }
  };
  // Serialize the startup/empty-exit handoff with enqueuers. A worker releases
  // ownership while still holding queue.lock, so an enqueue cannot be stranded.
  queue.transaction(() => {
    const lock = path.join(queue.directory, 'worker.lock');
    try { release = acquireLock(lock); }
    catch (error) {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || (owner.argv?.[1] !== SELF &&
          !(owner.project === queue.project.identity && owner.release?.root && owner.argv?.[1] === path.join(owner.release.root, 'promote/promote.mjs')))) throw error;
      // EPERM means the owner exists but this caller (another user or a sandbox) may not signal it.
      try { process.kill(owner.pid, 0); } catch (signal) { if (signal.code !== 'EPERM') throw error; }
    }
    if (release) {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      writeFileAtomic(path.join(lock, 'owner.json'), JSON.stringify({ ...owner, ...nativeWorkerEvidence() }) + '\n');
    }
  });
  if (!release) { process.send?.({ ready: true, already_running: true }); return; }
  const ownerFile = path.join(queue.directory, 'worker.lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  writeFileAtomic(ownerFile, JSON.stringify({ ...owner, project: queue.project.identity, release: bundleRelease(),
    ...(hasDeclaredWork(queue.project) || readDeclared(queue.project.canonical) ? { execution_identity: executionIdentity(queue.project) } : {}) }) + '\n');
  let acknowledged = false;
  try {
    for (;;) {
      // Git can be slow. Read a committed snapshot without queue.lock so
      // enqueuers remain free to append while this worker waits for settings.
      const snapshot = queue.load();
      let policy;
      if (!snapshot.current && !(snapshot.interrupted ?? []).some(batch => !batch.native_refusal && !attempted.has(batch.id)) && snapshot.pending.length) {
        try { const settings = promotionSettings(queue.project); policy = { maxBatch: settings.max_batch ?? Infinity, settings }; }
        catch (error) { policy = { error }; }
      }
      const entry = queue.transaction((data) => {
        const candidate = data.current ?? (data.interrupted ?? []).find(batch => !batch.native_refusal && !attempted.has(batch.id)) ?? data.pending[0];
        if (candidate) checkDeclaredJobs(queue, candidate.jobs ?? [candidate]);
        const admitted = candidate?.release ?? candidate?.jobs?.[0]?.release;
        // Transfer before dequeuing: persisting a new job as "promoting"
        // would make the receiving worker classify its first attempt as a crash.
        if (admitted && admitted.root !== bundleRelease().root) return { handoff: admitted };
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
        const resume = (data.interrupted ?? []).findIndex(batch => !batch.native_refusal && !attempted.has(batch.id));
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
          const key = job => JSON.stringify([job.laneCLI, job.validate ?? null, job.laneConfig ?? null, Boolean(job.run), job.declared?.source.digest ?? null]);
          const jobs = [next];
          while (jobs.length < policy.maxBatch && data.pending.length && key(data.pending[0]) === key(next)) {
            checkDeclaredJobs(queue, [data.pending[0]]);
            jobs.push(data.pending.shift());
          }
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
      if (!acknowledged) {
        process.send?.({ ready: true }); acknowledged = true;
        // Catch-up must not strand a freshly dequeued job as current before
        // its attempt. Per-job cleanup and finally handle the busy iteration.
        if (!entry) { consumeRequests(queue); retryCleanup(queue); }
      }
      if (!entry) break;
      if (entry.handoff) {
        const admitted = entry.handoff;
        const worker = operationFile('promote/promote.mjs', admitted);
        // The shared worker lock serializes versions. Transfer only after the
        // durable queue checkpoint, and never resolve the project's new pin.
        release(); release = null; handedOff = true;
        invoke(process.execPath, [worker, '--drain', '--repo', queue.project.canonical,
          '--attempted-batches', JSON.stringify([...attempted])], { stdio: 'inherit' });
        return;
      }
      const { job, newlyDequeued } = entry;
      if (job.jobs) {
        let batch = job;
        attempted.add(batch.id);
        if (batch.phase === 'batching') {
          try {
            // A new batch reuses the settings snapshot it was formed from; a resumed one reads HEAD.
            const results = await performBatch(batch, queue, newlyDequeued ? policy?.settings : undefined);
            const completion = reconcileBatchCompletion({ project: queue.project, jobs: batch.jobs, results });
            batch = { ...batch, phase: 'batch-delivering', results: completion.results, deliveredCount: 0 };
            if (completion.pending) batch.error = completion.reason;
            else delete batch.error;
          } catch (error) {
            const directory = path.join(queue.directory, 'batches', batch.id);
            const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'train.log');
            const hostReceipt = path.join(directory, 'host-gate.json');
            const results = batch.jobs.map(member => ({ job: member, result: {
              outcome: 'interrupted', reason: error.code ? error.message : 'batch interrupted; inspect the receipt and log, then resume --drain',
              ...(error.code ? { code: error.code } : {}), receipt, log, batch: batch.id,
              ...(fs.existsSync(hostReceipt) ? { host_receipt: hostReceipt } : {}),
            } }));
            batch = { ...batch, phase: 'batch-delivering', error: error.message, results, deliveredCount: 0,
              ...(error.code?.startsWith('PROMOTE_NATIVE_') ? { native_refusal: { code: error.code, reason: error.message } } : {}) };
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
            rememberCompletion(data, member.job, result);
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
        rememberCompletion(data, job, result);
        data.current = null;
      });
      process.stdout.write(JSON.stringify({ id: job.id, topic: job.topic, ...result, ...delivery }) + '\n');
    }
  } finally {
    try { if (!handedOff) { consumeRequests(queue); retryCleanup(queue); } } finally { release?.(); }
  }
}

async function start(queue) {
  checkDeclaredJobs(queue, queueJobs(queue.load()).filter(job => !job.finished));
  const output = fs.openSync(path.join(queue.directory, 'worker.log'), 'a');
  const env = { ...process.env };
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR']) delete env[key];
  const snapshot = queue.load();
  const first = snapshot.current ?? snapshot.interrupted?.[0] ?? snapshot.pending[0];
  const admitted = first?.release ?? first?.jobs?.[0]?.release;
  const worker = admitted ? operationFile('promote/promote.mjs', admitted) : SELF;
  const child = spawn(process.execPath, [worker, '--drain', '--repo', queue.project.canonical], {
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
    'claimed-by': { type: 'string' }, 'claim-generation': { type: 'string' },
    'delivery-attempts': { type: 'string' }, 'retry-seconds': { type: 'string' },
    'superseded-runs': { type: 'string' }, 'required-tests': { type: 'string' }, 'expected-head': { type: 'string' }, 'if-current-run': { type: 'string' },
    'existing-worker': { type: 'boolean' }, resume: { type: 'boolean' }, drain: { type: 'boolean' }, status: { type: 'boolean' },
    'cleanup-job': { type: 'string' },
    capabilities: { type: 'boolean' },
    'attempted-batches': { type: 'string' },
  } });
  if (opt.capabilities) { process.stdout.write(JSON.stringify(CAPABILITIES) + '\n'); return; }
  if (opt['existing-worker'] && (opt.resume || opt.drain)) throw Error('--existing-worker is enqueue-only; it never starts or resumes a worker');
  const target = gitProject(opt.repo);
  const declaredTarget = !opt.status && fenceDeclaredTarget(target);
  // --drain/--cleanup-job are continuations of recorded operations, not new
  // admissions. Their immutable path chooses the bundle even after a re-pin.
  if (!opt.drain && !opt['cleanup-job']) {
    const org = opt.org ?? findOrgDir({ cwd: opt.repo });
    const owned = opt['if-current-run'] && org ? readOwnedRun(org, opt['if-current-run']) : null;
    const bound = owned?.owner && opt['claimed-by'] ? requireController(owned, opt['claimed-by']) : null;
    if (declaredTarget && bound) requireDeclaredWorker(bundleRelease(bound.owner.release.root), target.canonical);
    const forwarded = bound ? continueOwnerRelease('promote/promote.mjs', bound) : forwardRelease('promote/promote.mjs', opt.repo,
      { beforeForward: declaredTarget ? selected => requireDeclaredWorker(selected, target.canonical) : undefined });
    if (forwarded !== null) { process.exitCode = forwarded; return; }
  }
  const queue = queueFor(opt.repo, { readOnly: opt.status });
  if (opt['cleanup-job']) {
    const saved = queue.load().results.findLast(row => row.id === opt['cleanup-job']);
    if (!saved || saved.release?.root !== bundleRelease().root || saved.cleanup?.state !== 'pending' || saved.reconciliation?.state === 'pending') throw Error('cleanup continuation does not match this bundle and pending receipt');
    const result = finishCleanup(saved, saved, queue);
    queue.transaction(data => Object.assign(data.results.findLast(row => row.id === saved.id), result));
    return;
  }
  if (opt.status) { process.stdout.write(JSON.stringify({ queue: queue.file, ...queue.load() }, null, 2) + '\n'); return; }
  if (opt['attempted-batches'] !== undefined && !opt.drain) throw Error('--attempted-batches requires --drain');
  if (opt.drain) {
    const attempted = JSON.parse(opt['attempted-batches'] ?? '[]');
    if (!Array.isArray(attempted) || attempted.some(id => typeof id !== 'string' || !id)) throw Error('invalid attempted batch continuation');
    await drain(queue, { attempted: new Set(attempted) }); return;
  }
  if (opt.resume) {
    if (positionals.length) throw Error('--resume takes no lane topics');
    checkDeclaredJobs(queue, queueJobs(queue.load()).filter(job => !job.finished));
    // Only an explicit native resume may release a capability refusal. Ordinary
    // drains leave it intact while processing unrelated requests.
    if (queue.load().interrupted?.some(batch => batch.native_refusal)) {
      const native = probeNativeGate();
      if (!native.ok) throw settingsRefusal(native.code, native.reason);
      queue.transaction(data => {
        for (const batch of data.interrupted ?? []) if (batch.native_refusal) {
          const file = path.join(queue.directory, 'batches', batch.id, 'train.json');
          const train = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (train.id !== batch.id || train.identity !== queue.project.identity) throw Error('native resume receipt binding changed');
          train.native_resumptions = [...(train.native_resumptions ?? []), { refusal: batch.native_refusal, native_context: native }];
          writeFileAtomic(file, JSON.stringify(train, null, 2) + '\n');
          delete batch.native_refusal;
        }
      });
    }
    const worker = await start(queue);
    process.stdout.write(JSON.stringify({ worker, queue: queue.file }) + '\n'); return;
  }
  if (!positionals.length) throw new Error('usage: promote.mjs TOPIC [TOPIC ...] [--repo PROJECT] [--to SUPERVISOR] | --status | --drain');
  const jobs = enqueue(queue, positionals, settings(queue.project, opt));
  const worker = opt['existing-worker'] ? { already_running: true } : await start(queue);
  process.stdout.write(JSON.stringify({ jobs, worker, queue: queue.file }) + '\n');
}
if (isMain(import.meta.url)) main().catch((error) => {
  // This refusal is atomic under queue.lock, before any admission or worker start.
  if (error.code === 'AUTOPILOT_NO_NATIVE_WORKER') process.stdout.write(JSON.stringify({ result: 'not_queued', code: error.code, reason: error.message }) + '\n');
  console.error(`promote: ${error.message}`); process.exitCode = 1;
});
