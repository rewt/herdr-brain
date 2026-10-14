#!/usr/bin/env node
// A model-free queue outside the core record. Only explicit admission starts a
// finite detached worker, inheriting that admitting process's native permissions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, transact } from '../lib/store.mjs';
import { requestRetirement } from '../lib/retire-trigger.mjs';
import { fold } from '../lib/state.mjs';
import { plainDirectory, writeFileAtomic } from '../lib/files.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { environmentFingerprint, validationEnvironment } from '../lanes/validation.mjs';
import { promptSupervisor, inboxPath } from '../supervisor/prompt-supervisor.mjs';
import { limitSeconds } from '../test-slot/limits.mjs';
import { sha256, fileSha256, parseExpectations, evaluate } from './expectations.mjs';

const SELF = fileURLToPath(import.meta.url);
const SLOT = fileURLToPath(new URL('../test-slot/test-slot.mjs', import.meta.url));
const EXECUTE = fileURLToPath(new URL('./execute.mjs', import.meta.url));
const stamp = () => new Date().toISOString();
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const optional = file => fs.existsSync(file) ? read(file) : null;
const privateDir = directory => { plainDirectory(directory); fs.chmodSync(directory, 0o700); return directory; };
const safeID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);

// Resolve missing paths through their nearest existing ancestor, including
// aliases, before comparing boundaries. This does not create either store.
function resolvedPath(file) {
  let parent = path.resolve(file), suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}
const within = (directory, root) => {
  const relative = path.relative(root, directory);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
function untrustedLocations(project, untrustedRoots, jobs, ownDesk) {
  const worktrees = git(project.canonical, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  return [project.canonical, project.identity, ...worktrees.filter(root => !ownDesk || resolvedPath(root) !== ownDesk), findOrgDir({ cwd: project.canonical }),
    '/tmp', '/private/tmp', os.tmpdir(), process.env.TMPDIR, ...untrustedRoots,
    ...jobs.map(job => job.org)].filter(Boolean).map(resolvedPath);
}
function checkStore(project, directory, untrustedRoots, jobs = []) {
  const roots = [...untrustedLocations(project, untrustedRoots, jobs), ...jobs.map(job => resolvedPath(job.desk))];
  if (roots.some(root => within(resolvedPath(directory), root))) throw Error('trusted store must be outside the repository, Git common directory, worktrees, desks, record, system temp directories and untrusted roots');
}
function checkDesk(project, job, untrustedRoots, data) {
  const desk = resolvedPath(job.desk);
  // A persistent runner-owned desk is itself a registered worktree. Exempt only
  // that worktree entry; every other protected root still applies to its path.
  const ownDesk = data.desks[job.desk]?.identity === project.identity ? desk : null;
  const roots = untrustedLocations(project, untrustedRoots, [...data.jobs, job], ownDesk);
  if (roots.some(root => within(desk, root))) throw Error('desk must be outside the repository, Git common directory, worktrees, record, system temp directories and untrusted roots');
}
export function queueFor(repo = process.cwd(), stateDir, { untrustedRoots = [] } = {}) {
  const project = gitProject(repo);
  untrustedRoots = [...untrustedRoots, ...(process.env.VERIFY_UNTRUSTED_ROOTS ?? '').split(path.delimiter).filter(Boolean)].map(resolvedPath);
  const directory = resolvedPath(stateDir ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'herdr-monitor/verify', sha256(project.identity)));
  checkStore(project, directory, untrustedRoots);
  const file = path.join(directory, 'queue.json');
  const load = () => {
    const data = optional(file) ?? { schema: 'verify-queue/v1', identity: project.identity, jobs: [], desks: {}, runner: null };
    if (data.schema !== 'verify-queue/v1' || data.identity !== project.identity || !Array.isArray(data.jobs)) throw Error('invalid verification queue identity or contents');
    return data;
  };
  const transaction = fn => {
    checkStore(project, directory, untrustedRoots, load().jobs);
    privateDir(directory);
    const release = acquireLock(path.join(directory, 'queue.lock'), { waitMs: 5000 });
    try { const data = load(), result = fn(data); writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o600); return result; }
    finally { release(); }
  };
  // Submission, status and explicit admission read this untrusted inbox. A worker
  // never derives authority or publication evidence from it.
  const inboxDirectory = path.join(project.identity, 'verify-inbox'), inboxFile = path.join(inboxDirectory, 'inbox.json');
  const loadInbox = () => {
    const data = optional(inboxFile) ?? { schema: 'verify-inbox/v1', identity: project.identity, jobs: [] };
    if (data.schema !== 'verify-inbox/v1' || data.identity !== project.identity || !Array.isArray(data.jobs)) throw Error('invalid verification inbox identity or contents');
    return data;
  };
  const inbox = { directory: inboxDirectory, load: loadInbox, transaction: fn => {
    privateDir(inboxDirectory);
    const release = acquireLock(path.join(inboxDirectory, 'inbox.lock'), { waitMs: 5000 });
    try { const data = loadInbox(), result = fn(data); writeFileAtomic(inboxFile, JSON.stringify(data, null, 2) + '\n', 0o600); return result; }
    finally { release(); }
  } };
  return { project, directory, load, transaction, inbox, untrustedRoots,
    checkStore: jobs => checkStore(project, directory, untrustedRoots, jobs),
    checkDesk: job => checkDesk(project, job, untrustedRoots, load()) };
}

// The only scheduling policy: submission order among admitted, unfinished jobs.
export function orderedJobs(data) { return data.jobs.filter(job => job.admission && !job.completed_at).sort((a, b) => a.submission_order - b.submission_order); }
// Runtime bookkeeping is deliberately excluded. Everything supplied at submit,
// including delivery executables and destinations, belongs to the admission.
const specFields = ['id', 'repo', 'identity', 'org', 'item', 'submitter', 'submitted_at', 'sha', 'tree', 'group',
    'desk', 'desk_name', 'argv', 'prepare', 'expectations', 'timeout_seconds', 'idle_timeout_seconds',
    'wait_seconds', 'label', 'to', 'herdr'];
const jobSpec = job => Object.fromEntries(specFields.map(key => [key, job[key]]));
export function jobDigest(job) { return sha256(JSON.stringify(jobSpec(job))); }
export function receiptPath(queue, job) { return path.join(queue.directory, 'jobs', job.id, 'receipt.json'); }
export function writeReceipt(file, receipt) {
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return sha256(bytes);
}
function checkItem(org, item) {
  if (!fold(loadEvents(org).events).items.has(item)) throw Error(`unknown item ${item}`);
}
export function submit(queue, opt, argv, prepare = null) {
  if (!argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw Error('submit requires command argv after --');
  if (prepare && (!prepare.length || prepare.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw Error('--prepare requires command argv');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(opt.sha ?? '')) throw Error('--sha requires a full commit hash');
  const sha = git(queue.project.canonical, 'rev-parse', '--verify', `${opt.sha}^{commit}`);
  if (sha !== opt.sha) throw Error('--sha must name the exact commit');
  const tree = git(queue.project.canonical, 'rev-parse', `${sha}^{tree}`);
  const org = fs.realpathSync(opt.org ?? findOrgDir({ cwd: queue.project.canonical }) ?? '');
  checkItem(org, opt.item);
  if (opt.group !== undefined && !safeID(opt.group)) throw Error('invalid group ID');
  const deskName = opt.desk ?? 'default';
  if (!path.isAbsolute(deskName) && !safeID(deskName)) throw Error('--desk requires a name or absolute path');
  const desk = path.isAbsolute(deskName) ? path.resolve(deskName) : path.join(queue.directory, 'desks', deskName);
  if (queue.directory === desk || queue.directory.startsWith(desk + path.sep)) throw Error('desk cannot contain the runner state');
  const wall = Number(opt['timeout-seconds'] ?? 4500), idle = Number(opt['idle-timeout-seconds'] ?? 300);
  limitSeconds(wall, '--timeout-seconds'); limitSeconds(idle, '--idle-timeout-seconds');
  const wait = Number(opt.wait ?? 86400);
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > 9999999) throw Error('--wait requires bounded whole seconds');
  const to = opt.to ?? process.env.MONITOR_SUPERVISOR_AGENT ?? 'supervisor-herdr';
  if (!to.trim()) throw Error('notice recipient must be nonempty');
  const expectations = parseExpectations(opt);
  const job = { id: randomUUID(), repo: queue.project.canonical, identity: queue.project.identity, org, item: opt.item,
    submitter: process.env.ORG_ACTOR ?? 'human', submitted_at: stamp(), sha, tree, group: opt.group ?? null,
    desk, desk_name: deskName, argv, prepare, expectations, timeout_seconds: wall, idle_timeout_seconds: idle,
    wait_seconds: wait, label: opt.label ?? `verify ${opt.item}`, to, herdr: opt.herdr ?? 'herdr' };
  queue.checkStore([job]);
  queue.checkDesk(job);
  queue.inbox.transaction(data => {
    for (const prior of data.jobs) if (desk !== prior.desk && (desk.startsWith(prior.desk + path.sep) || prior.desk.startsWith(desk + path.sep))) throw Error('desk worktrees must not overlap');
    const first = job.group && data.jobs.find(prior => prior.group === job.group);
    if (first && (first.sha !== sha || first.tree !== tree)) throw Error(`group ${job.group} is fixed at sha ${first.sha} tree ${first.tree}`);
    data.jobs.push(job);
  });
  return { job: job.id, receipt: receiptPath(queue, job), spec_sha256: jobDigest(job) };
}

// An existing worker cannot inherit a later admitter's permission context. Refuse
// overlapping admission rather than guessing from harness/provider metadata.
export function admit(queue, references) {
  const expected = new Map();
  for (const reference of references) {
    const match = typeof reference === 'string' && reference.match(/^(.+)=([a-f0-9]{64})$/);
    if (!match || !safeID(match[1])) throw Error('admit requires JOB=SPEC_SHA256 for every job; bare IDs refuse');
    if (expected.has(match[1])) throw Error('admit requires unique job IDs');
    expected.set(match[1], match[2]);
  }
  const ids = [...expected.keys()];
  if (!ids.length) throw Error('admit requires JOB=SPEC_SHA256');
  const submitted = queue.inbox.load();
  const specs = submitted.jobs.filter(job => ids.includes(job.id)).map(jobSpec);
  for (const id of ids) {
    const matches = specs.filter(job => job.id === id), job = matches[0];
    if (matches.length !== 1 || !safeID(id)) throw Error(`unknown or duplicate submitted job ${id}`);
    if (jobDigest(job) !== expected.get(id)) throw Error(`inbox spec digest differs for job ${id}; inspect status and admit its current digest`);
    if (job.repo !== queue.project.canonical || job.identity !== queue.project.identity || typeof job.org !== 'string' || typeof job.desk !== 'string' || !path.isAbsolute(job.desk)) throw Error(`invalid submitted spec for job ${id}`);
    checkItem(job.org, job.item);
    queue.checkDesk(job);
  }
  queue.checkStore(specs);
  const admission = { token: randomUUID(), admitted_at: stamp(), admitted_by: process.env.ORG_ACTOR ?? 'human', jobs: {} };
  return queue.transaction(data => {
    if (data.runner) throw Error('a verification admission is active; inspect status, then recover if the worker stopped (never remove a live worker lock)');
    if (fs.existsSync(path.join(queue.directory, 'worker.lock'))) throw Error('worker lock remains; inspect its owner and surviving processes before recovery');
    for (const id of ids) {
      const matches = data.jobs.filter(job => job.id === id), job = matches[0];
      if (matches.length > 1) throw Error(`duplicate job ${id}`);
      if (job?.completed_at || fs.existsSync(receiptPath(queue, { id }))) throw Error(`job ${id} already has a receipt`);
      if (job?.started_at || job?.retry_required_at) throw Error(`job ${id} was interrupted; inspect it and retry as a new job`);
      if (job && jobDigest(job) !== expected.get(id)) throw Error(`admitted spec is immutable for job ${id}; changed content requires a new job`);
    }
    for (const spec of specs) {
      for (const prior of data.jobs) {
        if (prior.id === spec.id) continue;
        if (spec.desk !== prior.desk && (within(spec.desk, prior.desk) || within(prior.desk, spec.desk))) throw Error('desk worktrees must not overlap');
        if (spec.group && prior.group === spec.group && (spec.sha !== prior.sha || spec.tree !== prior.tree)) throw Error(`group ${spec.group} is fixed at sha ${prior.sha} tree ${prior.tree}`);
      }
      let job = data.jobs.find(job => job.id === spec.id);
      if (!job) { job = spec; data.jobs.push(job); }
      job.submission_order = submitted.jobs.findIndex(row => row.id === job.id);
      const digest = jobDigest(job);
      admission.jobs[job.id] = digest;
      job.admission = { token: admission.token, admitted_at: admission.admitted_at, admitted_by: admission.admitted_by, spec_sha256: digest };
    }
    data.runner = admission;
    return admission;
  });
}
function clean(desk) {
  if (git(desk, 'status', '--porcelain', '--untracked-files=all')) throw Error(`desk is dirty: ${desk}`);
}
function deskFor(queue, job) {
  queue.checkDesk(job);
  const registered = queue.load().desks[job.desk];
  if (!registered) {
    if (fs.existsSync(job.desk)) throw Error(`desk was not created by this runner: ${job.desk}`);
    plainDirectory(path.dirname(job.desk));
    git(job.repo, 'worktree', 'add', '--detach', job.desk, job.sha);
    queue.transaction(data => { data.desks[job.desk] = { identity: job.identity, created_at: stamp() }; });
  }
  plainDirectory(job.desk, { create: false });
  if (gitProject(job.desk).identity !== job.identity || git(job.desk, 'rev-parse', '--show-toplevel') !== fs.realpathSync(job.desk) || git(job.desk, 'branch', '--show-current')) throw Error('desk must be its registered detached worktree');
}
function restore(job, previous) {
  // This is a dedicated runner-created worktree, never a worker's checkout.
  git(job.desk, 'checkout', '--detach', '--force', previous);
  git(job.desk, 'reset', '--hard', previous);
  git(job.desk, 'clean', '-fd'); // ignored pnpm/build caches deliberately survive
  clean(job.desk);
  if (git(job.desk, 'rev-parse', 'HEAD') !== previous) throw Error('desk restoration changed its commit');
}
async function runSlot(queue, job, directory, log) {
  const args = [SLOT, 'run', job.label, '--wait', String(job.wait_seconds),
    '--wait-receipt-path', path.join(directory, 'slot-wait.json'), '--result-path', path.join(directory, 'slot-result.json'),
    '--timeout-seconds', String(job.timeout_seconds + 60), '--idle-timeout-seconds', String(job.idle_timeout_seconds + 60),
    '--project-common', job.identity, '--tier', 'verify', '--', process.execPath, EXECUTE, '--hold', JSON.stringify(job), directory];
  // Never inherit a stale slot token into an admitted job as nesting authority.
  const env = validationEnvironment(process.env);
  delete env.MONITOR_TEST_SLOT_TOKEN; delete env.BCH_CLOAK_TEST_SLOT_TOKEN;
  return await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: job.desk, env, stdio: ['ignore', log, log] });
    proc.once('error', reject); proc.once('exit', (exit, signal) => resolve({ exit, signal }));
  });
}
export async function perform(queue, job) {
  const directory = privateDir(path.join(queue.directory, 'jobs', job.id));
  const receipt = receiptPath(queue, job);
  if (fs.existsSync(receipt)) throw Error('receipt already exists; execution will not be replayed');
  const logPath = path.join(directory, 'execution.log'), log = fs.openSync(logPath, 'wx', 0o600);
  const start = process.hrtime.bigint();
  const result = { schema: 'verify-receipt/v1', job: job.id, repo: job.repo, repo_identity: job.identity,
    item: job.item, submitter: job.submitter, group: job.group, sha: job.sha, tree: job.tree,
    desk: job.desk, desk_previous_sha: null, argv: job.argv, prepare: job.prepare ? { argv: job.prepare, exit: null, duration_s: null } : 'none',
    environment_fingerprint: environmentFingerprint({ env: validationEnvironment(process.env), prepare: job.prepare ?? [] }),
    submitted_at: job.submitted_at, admitted_at: job.admission.admitted_at, admitted_by: job.admission.admitted_by,
    admitted_spec_sha256: job.admission.spec_sha256,
    slot_wait_started_at: null, granted_at: null, slot_waits: [], started_at: null, finished_at: null,
    exit: null, signal: null, outcome: 'error', timeout: null, reaped_processes: [] };
  let previous, checkedOut = false, halted = false, safeToRestore = true;
  try {
    deskFor(queue, job);
    previous = result.desk_previous_sha = git(job.desk, 'rev-parse', 'HEAD');
    clean(job.desk);
    checkedOut = true; git(job.desk, 'checkout', '--detach', job.sha);
    if (git(job.desk, 'rev-parse', 'HEAD^{tree}') !== job.tree) throw Error('desk tree differs from submitted tree');
    git(job.desk, 'clean', '-fd');
    writeFileAtomic(path.join(directory, 'spec.json'), JSON.stringify(job), 0o600);
    result.slot_wait_started_at = stamp();
    safeToRestore = false;
    const wrapper = await runSlot(queue, job, directory, log);
    const wait = optional(path.join(directory, 'slot-wait.json'));
    const envelope = optional(path.join(directory, 'slot-result.json'));
    const execution = optional(path.join(directory, 'job-result.json'));
    const phases = optional(path.join(directory, 'phases.json'));
    result.slot_waits = wait?.waits ?? [];
    result.granted_at = wait?.acquired_at ?? null;
    result.started_at = execution?.started_at ?? null;
    result.slot_execution = execution;
    result.slot_envelope = envelope;
    result.timeout = execution?.gate_timeout ?? envelope?.gate_timeout ?? null;
    result.reaped_processes = phases?.reaped ?? [];
    if (phases?.tracking_interrupted) result.tracking_interrupted = phases.tracking_interrupted;
    safeToRestore = (Boolean(envelope?.finished_at) && !envelope.cleanup_error && !execution?.cleanup_error && phases?.cleanup_confirmed === true) || (!envelope && wrapper.exit === 75);
    if (phases?.prepare && phases.prepare !== 'none') result.prepare = { ...result.prepare, ...phases.prepare };
    result.command = phases?.command ?? null;
    result.exit = phases?.command?.exit ?? null;
    result.signal = phases?.command?.signal ?? execution?.signal ?? envelope?.signal ?? wrapper.signal;
    const checked = await evaluate(job.expectations, { desk: job.desk, exit: result.exit, signal: result.signal, log: path.join(directory, 'command.log') });
    Object.assign(result, checked);
    if (!wait || !execution?.finished_at || !safeToRestore || execution.cleanup_error || phases?.error || phases?.command?.error || wrapper.exit !== 0 || phases?.wrapper?.exit !== 0 || result.timeout || !phases?.command?.finished_at || (job.prepare && phases?.prepare?.exit !== 0)) {
      result.error = envelope?.cleanup_error ?? execution?.cleanup_error ?? phases?.cleanup_error ?? phases?.error ?? (result.timeout ? `job ${result.timeout.kind} timeout` : !wait ? 'slot not granted; see private execution log' : 'execution or prepare did not complete successfully');
      halted = !safeToRestore || Boolean(execution?.cleanup_error || phases?.error);
    } else result.outcome = checked.expectations.every(row => row.passed) ? 'pass' : 'fail';
  } catch (error) { result.error = error.message; halted = true; }
  finally {
    if (checkedOut && safeToRestore) {
      try { restore(job, previous); result.desk_restored = true; }
      catch (error) { result.outcome = 'error'; result.restore_error = error.message; halted = true; }
    }
    fs.closeSync(log);
  }
  if (!result.expectations) result.expectations = job.expectations.map(expectation => ({ ...expectation, passed: false, error: 'job did not complete' }));
  result.finished_at = stamp(); result.duration_s = Number(process.hrtime.bigint() - start) / 1e9;
  const logs = ['execution', 'prepare', 'command'].map(name => path.join(directory, `${name}.log`)).filter(file => fs.existsSync(file));
  result.logs = await Promise.all(logs.map(async file => ({ path: file, sha256: await fileSha256(file) })));
  result.halted = halted;
  const hash = writeReceipt(receipt, result);
  // Publication provenance is committed before either delivery boundary. A
  // crash before this transaction leaves an unverified receipt, never evidence.
  queue.transaction(data => {
    const row = data.jobs.find(row => row.id === job.id);
    if (!row?.started_at || row.admission?.token !== job.admission.token || row.admission.spec_sha256 !== jobDigest(job) || jobDigest(row) !== jobDigest(job)) throw Error(`publication has no matching started admission for job ${job.id}`);
    row.receipt_sha256 = hash;
  });
  return { receipt, sha256: hash, outcome: result.outcome, halted };
}

export async function deliver(queue, job, completed, notify = promptSupervisor) {
  const text = `[verify] job=${job.id} item=${job.item} outcome=${completed.outcome} receipt=${completed.receipt} sha256=${completed.sha256}`;
  // The record lock makes recovery idempotent across a lost note acknowledgement.
  transact(job.org, events => {
    if (!fold(events).items.has(job.item)) throw Error(`unknown item ${job.item}`);
    return { add: events.some(event => event.type === 'note.added' && event.id === job.item && event.text === text) ? [] : [{ type: 'note.added', id: job.item, text, decision: false }] };
  }, { actor: job.submitter });
  await notify(job.to, text, { org: job.org, cwd: job.repo, inbox: inboxPath({ org: job.org }),
    id: `verify:${job.id}`, herdr: job.herdr, waitSeconds: 0, pollSeconds: 1 });
}
function resetAdmissions(data, token, { unstartedOnly = false } = {}) {
  for (const job of data.jobs.filter(job => !job.completed_at && job.admission?.token === token && (!unstartedOnly || !job.started_at))) {
    job.previous_admissions = [...(job.previous_admissions ?? []), job.admission];
    delete job.admission;
  }
}
function runnerError(queue, token, error) {
  queue.transaction(data => {
    if (data.runner?.token !== token) return;
    data.runner.error = error.message;
    data.runner.failed_at = stamp();
    resetAdmissions(data, token, { unstartedOnly: true });
  });
}
function published(queue, job) {
  const receipt = receiptPath(queue, job), bytes = fs.readFileSync(receipt), result = JSON.parse(bytes);
  const hash = sha256(bytes);
  if (!job.started_at || !job.admission?.token || !job.receipt_sha256 || job.receipt_sha256 !== hash) throw Error(`unverified receipt for job ${job.id}: no matching runner-recorded publication`);
  if (result.schema !== 'verify-receipt/v1' || result.job !== job.id || job.admission.spec_sha256 !== jobDigest(job) || result.admitted_spec_sha256 !== job.admission.spec_sha256 || result.admitted_at !== job.admission.admitted_at || result.admitted_by !== job.admission.admitted_by) throw Error(`receipt does not match admitted spec for job ${job.id}`);
  return { receipt, sha256: hash, outcome: result.outcome, halted: result.halted };
}
export async function drain(queue, admitted, { notify } = {}) {
  // The allowlist comes from the admitting process through argv, never queue.json.
  const { token, admitted_at, admitted_by } = admitted ?? {};
  const digests = new Map(Object.entries(admitted?.jobs ?? {}));
  if (typeof token !== 'string' || !digests.size || [...digests].some(([id, digest]) => !safeID(id) || !/^[a-f0-9]{64}$/.test(digest))) throw Error('worker requires the exact admitted job digests');
  const check = job => {
    if (jobDigest(job) !== digests.get(job.id)) throw Error(`admitted spec digest differs for job ${job.id}; a new explicit admission is required`);
  };
  queue.checkStore(queue.load().jobs); privateDir(queue.directory);
  const release = acquireLock(path.join(queue.directory, 'worker.lock'));
  try {
    queue.transaction(data => {
      if (data.runner?.token !== token) throw Error('worker has no matching explicit admission');
      data.runner.pid = process.pid;
    });
    process.send?.({ ready: true });
    for (;;) {
      const data = queue.load();
      for (const id of digests.keys()) if (data.jobs.filter(job => job.id === id).length > 1) throw Error(`duplicate admitted job ${id}`);
      const job = orderedJobs(data).find(job => digests.has(job.id) && job.admission.token === token);
      if (!job) break;
      check(job);
      job.admission = { token, admitted_at, admitted_by, spec_sha256: digests.get(job.id) };
      const file = receiptPath(queue, job);
      if (fs.existsSync(file)) throw Error(`receipt already exists for job ${job.id}; this worker did not write it; recover must verify publication`);
      if (job.started_at) throw Error(`interrupted job ${job.id}; inspect execution and descendants before recovery; retry is a new job`);
      queue.transaction(data => { const row = data.jobs.find(row => row.id === job.id); check(row); row.started_at = stamp(); });
      const completed = await perform(queue, job);
      await deliver(queue, job, completed, notify);
      queue.transaction(data => { Object.assign(data.jobs.find(row => row.id === job.id), completed, { completed_at: stamp() }); });
      try { requestRetirement({ org: job.org, cwd: job.repo, source: `verify job ${job.id} completion` }); } catch (e) { process.stderr.write(`retirement request deferred: ${e.message}\n`); }
      if (completed.halted) {
        queue.transaction(data => { data.halted = { job: job.id, receipt: completed.receipt, at: stamp() }; });
        break;
      }
    }
    queue.transaction(data => {
      // A halted batch cannot leave jobs apparently runnable by a worker whose
      // permission context no longer exists. They require a new explicit admit.
      resetAdmissions(data, token);
      if (data.runner?.token === token) data.runner = null;
    });
  } catch (error) {
    runnerError(queue, token, error);
    throw error;
  } finally { release(); }
}
export async function recover(queue, { notify } = {}) {
  // Acquiring, rather than deleting, this lock excludes both live workers and
  // concurrent recovery. Crash locks still require inspection by the operator.
  queue.checkStore(queue.load().jobs); privateDir(queue.directory);
  const release = acquireLock(path.join(queue.directory, 'worker.lock'));
  let token;
  try {
    token = queue.load().runner?.token;
    const recovered = { delivered: [], needs_retry: [], pending_admission: [], unverified: [] };
    const jobs = queue.load().jobs;
    const directory = path.join(queue.directory, 'jobs');
    if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const receipt = path.join(directory, entry.name, 'receipt.json');
      if (entry.isDirectory() && !jobs.some(job => job.id === entry.name) && fs.existsSync(receipt)) recovered.unverified.push({ job: entry.name, receipt, error: 'no admitted trusted job' });
    }
    for (const job of jobs) {
      if (!safeID(job.id)) throw Error('invalid job ID during recovery');
      if (fs.existsSync(receiptPath(queue, job))) {
        let completed;
        try { completed = published(queue, job); }
        catch (error) { recovered.unverified.push({ job: job.id, receipt: receiptPath(queue, job), error: error.message }); }
        if (completed) {
          await deliver(queue, job, completed, notify);
          queue.transaction(data => { Object.assign(data.jobs.find(row => row.id === job.id), completed, { completed_at: job.completed_at ?? stamp() }); });
          recovered.delivered.push(job.id); continue;
        }
      }
      if (job.completed_at) continue;
      if (job.started_at) {
        queue.transaction(data => { const row = data.jobs.find(row => row.id === job.id); row.retry_required_at ??= stamp(); });
        recovered.needs_retry.push(job.id);
      } else if (!job.completed_at) recovered.pending_admission.push(job.id);
    }
    queue.transaction(data => {
      const tokens = new Set(data.jobs.filter(job => !job.completed_at && job.admission).map(job => job.admission.token));
      for (const token of tokens) resetAdmissions(data, token);
      if (data.runner) data.last_runner = { ...data.runner, recovered_at: stamp() };
      data.runner = null;
    });
    return recovered;
  } catch (error) {
    if (token) runnerError(queue, token, error);
    throw error;
  } finally { release(); }
}
export async function startWorker(queue, admission) {
  const output = fs.openSync(path.join(queue.directory, 'worker.log'), 'a', 0o600);
  let child;
  try { child = spawn(process.execPath, [SELF, '--worker', JSON.stringify(admission), '--repo', queue.project.canonical, '--state-dir', queue.directory,
    ...queue.untrustedRoots.flatMap(root => ['--untrusted-root', root])], {
    cwd: queue.project.canonical, env: validationEnvironment(process.env), detached: true, stdio: ['ignore', output, output, 'ipc'],
  }); } finally { fs.closeSync(output); }
  return await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); child.removeAllListeners(); if (child.connected) child.disconnect(); child.unref(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(Error(`worker startup unconfirmed; inspect ${queue.directory}/worker.log`)), 5000);
    child.once('error', finish); child.once('exit', code => finish(Error(`worker exited ${code}; inspect worker.log`)));
    child.once('message', message => finish(message.ready ? null : Error(message.error ?? 'worker startup failed')));
  });
}
export function status(queue, { id, group } = {}) {
  const data = queue.load();
  const trusted = new Map(data.jobs.map(job => [job.id, job]));
  const submitted = new Map(queue.inbox.load().jobs.map(job => [job.id, jobSpec(job)]));
  const rows = [...new Set([...submitted.keys(), ...trusted.keys()])].map(id => {
    const saved = trusted.get(id);
    const spec = saved && (saved.admission || saved.started_at || saved.retry_required_at || saved.completed_at) ? jobSpec(saved) : submitted.get(id);
    const runtime = Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => !specFields.includes(key)));
    return { ...runtime, ...(spec ?? { id }), spec_sha256: spec ? jobDigest(spec) : null };
  });
  const jobs = rows.filter(job => (!id || job.id === id) && (!group || job.group === group)).map(job => ({ ...job,
    receipt: receiptPath(queue, job), state: job.completed_at ? job.outcome : job.retry_required_at ? 'needs-retry' : job.started_at ? 'running-or-interrupted' : job.admission ? 'admitted' : 'pending-admission' }));
  return { identity: data.identity, runner: data.runner, last_runner: data.last_runner ?? null, halted: data.halted ?? null, jobs };
}
export function initStore(queue) {
  queue.checkStore([...queue.load().jobs, ...queue.inbox.load().jobs]);
  plainDirectory(path.dirname(queue.directory));
  let created = false;
  try { fs.mkdirSync(queue.directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) fs.chmodSync(queue.directory, 0o700);
  plainDirectory(queue.directory, { create: false });
  const stat = fs.statSync(queue.directory);
  if (stat.uid !== process.getuid()) throw Error('trusted store has a different owner');
  if ((stat.mode & 0o7777) !== 0o700) throw Error('trusted store must have mode 0700');
  return queue.directory;
}
export function probeStore(queue) {
  const file = path.join(queue.directory, `.probe-${randomUUID()}`);
  let created = false;
  try {
    const fd = fs.openSync(file, 'wx', 0o600); created = true;
    fs.closeSync(fd);
    fs.unlinkSync(file);
    return { state: 'writable', writable: true, code: null, error: null };
  } catch (error) {
    const code = error.code ?? null;
    const state = !created && ['EACCES', 'EPERM'].includes(code) ? 'protected' : !created && code === 'ENOENT' ? 'absent' : 'unknown';
    return { state, writable: state === 'protected' ? false : null, code,
      error: `${code ?? 'error'}: ${error.message}${state === 'absent' ? '; run verify init from the trusted side' : ''}` };
  }
}
export async function main(args = process.argv.slice(2)) {
  const separator = args.indexOf('--');
  let options = separator < 0 ? args : args.slice(0, separator), prepare = null;
  const prepareAt = options.indexOf('--prepare');
  if (prepareAt >= 0) { prepare = options.slice(prepareAt + 1); options = options.slice(0, prepareAt); }
  const { values: opt, positionals } = parseArgs({ args: options, allowPositionals: true, options: {
    ...Object.fromEntries(['repo', 'org', 'item', 'sha', 'label', 'to', 'desk', 'group', 'state-dir', 'timeout-seconds', 'idle-timeout-seconds', 'wait', 'worker', 'herdr'].map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(['expect', 'expect-tap', 'expect-vitest', 'expect-test', 'expect-file', 'expect-json'].map(name => [name, { type: 'string', multiple: true }])),
    'untrusted-root': { type: 'string', multiple: true },
    admit: { type: 'boolean' },
  }, usage: 'verify.mjs submit OPTIONS [--prepare CMD ARGS...] -- CMD ARGS... | admit JOB=SPEC_SHA256... | status [JOB] [--group ID] | recover | init [--state-dir DIR] | probe-store [--state-dir DIR]' });
  const queue = queueFor(opt.repo, opt['state-dir'], { untrustedRoots: opt['untrusted-root'] });
  if (opt.worker) return await drain(queue, JSON.parse(opt.worker));
  const [action, ...ids] = positionals;
  if (action === 'submit') {
    if (ids.length) throw Error('unexpected submit argument');
    const submitted = submit(queue, opt, separator < 0 ? [] : args.slice(separator + 1), prepare);
    console.log(JSON.stringify(submitted));
    if (opt.admit) { const admission = admit(queue, [`${submitted.job}=${submitted.spec_sha256}`]); await startWorker(queue, admission); }
    return;
  }
  if (action === 'admit') { const admission = admit(queue, ids); await startWorker(queue, admission); console.log(JSON.stringify({ admitted: admission.jobs })); return; }
  if (action === 'status' && ids.length <= 1) { console.log(JSON.stringify(status(queue, { id: ids[0], group: opt.group }))); return; }
  if (action === 'recover' && !ids.length) { console.log(JSON.stringify(await recover(queue))); return; }
  if (action === 'init' && !ids.length) { console.log(initStore(queue)); return; }
  if (action === 'probe-store' && !ids.length) {
    const probe = probeStore(queue); console.log(JSON.stringify(probe));
    if (probe.writable === null) process.exitCode = 1;
    return;
  }
  throw Error('usage: verify.mjs submit|admit|status|recover|init|probe-store; see --help');
}
if (isMain(import.meta.url)) {
  try { await main(); }
  catch (error) { process.send?.({ ready: false, error: error.message }); console.error(`verify: ${error.message}`); process.exitCode = 1; }
}
