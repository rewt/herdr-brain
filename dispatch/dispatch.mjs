#!/usr/bin/env node
// Coordination is a foreground CLI. Only watch owns a background process.
import { ownerAlive } from '../lib/process-owner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync,spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig, resolveRoute, resolveLaunchRoute } from '../lanes/routes.mjs';
import { BRAIN_CONTROLLER, brainOwner, claimRun, readOwnedRun, requireController, fenceOwner, continueOwnerRelease } from '../lib/run-owner.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { waitForProvingHold, RESERVATION_WAIT_EXPIRED_CODE } from '../test-slot/reservations.mjs';
import { admissionDeadline } from '../lib/deadline.mjs';
import { readTiming, timedMemoryWait, timingMetadata, readAdmissionTiming, admissionTimingMetadata } from '../lib/run-timing.mjs';
import { gitProject } from '../lib/project.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';
import { bundleRelease, forwardRelease, continueRelease, operationFile } from '../lib/releases.mjs';
import { hookReviewDialog, codexProfile } from './hook-review.mjs';
import { effectiveWorkerIdentity, workerReceipt, sharesWorker } from '../lib/worker-identity.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { nativeProcess, observeSessionBinding } from './session-bind.mjs';
import { acquireSessionCapLock, checkSessionCap } from './session-cap.mjs';
import { checkSourceAdmission, matchesDispatchStart } from './unlanded-cap.mjs';
import { quote } from '../lib/shell.mjs';
import { isQueueReview, validateQueuedReview, reviewQueueBrief, reviewQueueRoute } from '../line-service/review-queue.mjs';
import { dispatchInput } from '../line-service/phase1.mjs';

const local = (file) => fileURLToPath(new URL(file, import.meta.url));
const { values: opt, positionals } = parseArgs({ usage: "Usage: node dispatch/dispatch.mjs ITEM --lane TOPIC --route ROUTE --brief FILE [OPTIONS] | --retry R-n|JOURNAL | --status R-n|JOURNAL\nAdmission counts running native workers/reviewers and durable uncertain starts under dispatch.max_sessions. Unlanded lifecycle history is diagnostic only. --from-run retains same-item/current-run guards; --unblocks records a genuine landing dependency and never bypasses native capacity.", allowPositionals: true, options: {
  controller: { type: 'string', default: BRAIN_CONTROLLER },
  repo: { type: 'string', default: process.cwd() }, org: { type: 'string', default: process.env.ORG_DIR },
  lane: { type: 'string' }, route: { type: 'string' }, brief: { type: 'string' }, report: { type: 'string' },
  awaited: { type: 'boolean' }, 'awaited-step': { type: 'string' },
  to: { type: 'string' }, base: { type: 'string' }, extra: { type: 'string' },
  reuse: { type: 'string' }, retry: { type: 'string' }, status: { type: 'string' },
  adopt: { type: 'string' }, fresh: { type: 'boolean' }, resend: { type: 'boolean' },
  'accept-delivered': { type: 'boolean' }, 'recover-run': { type: 'string' },
  'from-run': { type: 'string' }, unblocks: { type: 'string' },
  detach:{type:'boolean'},
  'org-cli': { type: 'string' }, 'lane-cli': { type: 'string' }, 'watch-cli': { type: 'string' },
}});
const cli = (name, fallback) => opt[`${name}-cli`] ? [opt[`${name}-cli`]] : [process.execPath, local(fallback)];
const recordCLI = cli('org', '../bin/org.mjs');
const laneCLI = cli('lane', '../lanes/lane.mjs');
const watchCLI = cli('watch', '../watch/watch.mjs');
let job, journal, lock, contender, ownsLock = false, observationDeadline;
let releaseAdmission;
let controllerDeadline=Infinity;
const atomic = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
};
const save = () => {
  const write = () => atomic(journal, job);
  if (job.ownership && job.run) return fenceOwner(job.org, job.run, job.ownership, write);
  if (job.predecessor) return fenceOwner(job.org, job.predecessor.run, job.predecessor.binding, write);
  return write();
};
function claimAdmission() {
  if (!job.run) return;
  const desired = job.predecessor?.binding.owner ?? brainOwner(opt.controller);
  const claim = claimRun({ org: job.org, run: job.run, owner: desired, predecessor: job.predecessor, admission: true });
  job.ownership = { owner: claim.owner, generation: claim.generation };
  save();
}
function command(argv, args, cwd = job?.repo ?? path.resolve(opt.repo)) {
  const remaining = Math.min(observationDeadline??Infinity,controllerDeadline)-Date.now();
  if (remaining !== undefined && remaining <= 0) throw Error('session observation deadline expired');
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ORG_DIR: job?.org ?? opt.org },
    timeout:Math.max(1,Math.min(120000,remaining??120000)),killSignal:'SIGTERM',
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`${argv[0]} ${args[0]}: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()}`);
    error.recordRefusal = !result.error && !result.signal && result.status === 1 &&
      result.stderr.trim().split('\n').at(-1).startsWith('record: ');
    throw error;
  }
  return result.stdout.trim();
}
const record = (args) => command(recordCLI, args);
const identityState = () => fold(loadEvents(job?.org ?? opt.org).events);
const lane = (args) => command(laneCLI, args);
function projectExceptionAddress(repo, config, route) {
  const explicit = process.env.MONITOR_SUPERVISOR_AGENT?.trim();
  if (explicit) return { to: explicit, source: 'parent MONITOR_SUPERVISOR_AGENT' };
  // Launch env is child-only; resolve its effective value without mutating the
  // dispatcher's environment. Later route entries override dispatch defaults.
  const launch = resolveLaunchRoute(config, { route });
  const setting = launch.env.filter(pair => pair.startsWith('MONITOR_SUPERVISOR_AGENT=')).at(-1);
  const configured = setting?.slice('MONITOR_SUPERVISOR_AGENT='.length).trim();
  if (configured) return { to: configured, source: 'effective launch MONITOR_SUPERVISOR_AGENT' };
  try {
    const policy = readProjectPolicy(repo, 'promote', process.env, { canonical: gitProject(repo).canonical });
    if (policy.config.to) return { to: policy.config.to.trim(), source: 'project promote.to', file: policy.file };
    return { to: null, source: 'unknown', reason: 'No project-specific exception address is configured.' };
  } catch (error) {
    // Address discovery supplies guidance, never a new dispatch readiness gate.
    return { to: null, source: 'unknown', reason: error.message };
  }
}
const git = (args, cwd) => command(['git'], args, cwd);
const json = (text) => { const value = JSON.parse(text); if (value.error) throw new Error(JSON.stringify(value.error)); return value.result ?? value; };
const refusal = (code, message) => Object.assign(new Error(message), { code });
const dispatchCodes = new Set(['REUSE_RUN_OPEN', 'REUSE_MISMATCH', 'REUSE_IDENTITY_UNKNOWN', 'REUSE_WORKER_BUSY',
  'FROM_RUN_OTHER_ITEM', 'FROM_RUN_SUPERSEDED', 'DISPATCH_FAILED', 'DISPATCH_STOPPED', 'DISPATCH_HOOK_REVIEW',
  'DISPATCH_UNLANDED_CAP', 'DISPATCH_UNBLOCKS_INVALID']);
function checkOrigin(runId, item, current = true) {
  const origin = json(record(['show', runId, '--json']));
  if (!/^R-\d+$/.test(runId) || origin.item !== item.id) throw refusal('FROM_RUN_OTHER_ITEM', '--from-run must name a run on the dispatched item');
  const later = item.runs.slice(item.runs.indexOf(runId) + 1);
  if (current && later.length) throw refusal('FROM_RUN_SUPERSEDED', `${runId} is superseded by ${later.join(', ')}`);
}
function checkReuse(prior, request) {
  // Explicit reuse can cross items; only --from-run binds item currentness.
  // Workspace and live occupant evidence are checked at the worker stage.
  if (!prior.report && !prior.abandoned) throw refusal('REUSE_RUN_OPEN', 'reuse run must be reported or abandoned; finish the previous run first');
  if (prior.meta?.lane !== request.lane || prior.meta?.route !== request.route ||
      Object.entries(request.declared).some(([key, value]) => (prior.meta?.[key] ?? null) !== value)) {
    throw refusal('REUSE_MISMATCH', 'reuse run must match item, lane, route and declared harness/model/effort; use a fresh worker');
  }
  checkReuseOccupant(prior, request.run);
}
function checkReuseOccupant(prior, currentRun) {
  const state = identityState();
  const holders = [...state.runs.values()].filter(other => other.id !== currentRun &&
    other.started.seq > prior.started.seq && !other.report && !other.abandoned && sharesWorker(prior, other, state));
  if (holders.length) throw refusal('REUSE_WORKER_BUSY', `reuse worker is held by an open run: ${holders.map(run => run.id).join(', ')}`);
}
const herdr = (args) => json(command(['herdr'], args));
const note = (text) => record(['note', job.run, `Dispatch: ${text}`]);
let dispatchWaits, admissionWaits;
function timingFailure(phase) {
  // Missing telemetry is visible without persisting arbitrary errors or making
  // the record CLI (or even this diagnostic write) a dispatch prerequisite.
  job.timing_missing = (job.timing_missing ?? 0) + 1;
  try { save(); } catch {}
  try { process.stderr.write(`dispatch: run timing ${phase} failed; continuing with missing data\n`); } catch {}
}
function syncTiming() {
  if (!job.run) return;
  try {
    const value = timingMetadata(readTiming(journal).filter(e => e.kind !== 'process_end'), job.run);
    if (value !== dispatchWaits) {
      record(['set', job.run, `dispatch_waits=${value}`]);
      dispatchWaits = value;
    }
    const admission = readAdmissionTiming(journal);
    if (admission.length) {
      const value = admissionTimingMetadata(admission, job.run);
      if (value !== admissionWaits) {
        record(['set', job.run, `dispatch_admission_waits=${value}`]);
        admissionWaits = value;
      }
    }
  } catch { timingFailure('sync'); }
}
function memoryGate(kind, label, check) {
  const deadline = admissionDeadline();
  return timedMemoryWait({ journal, run: job.run, item: job.item, lane: job.lane, kind,
    wait: () => waitForProvingHold({ label, check, deadline }), persist: syncTiming, onError: timingFailure });
}
function locate(value) {
  if (!/^R-\d+$/.test(value)) return path.resolve(value);
  const run = json(record(['show', value, '--json']));
  if (!run.meta?.dispatch_journal) throw new Error(`${value} has no dispatch journal`);
  return run.meta.dispatch_journal;
}
function worktree() {
  const entries = git(['worktree', 'list', '--porcelain']).split('\n\n');
  const entry = entries.find((text) => text.split('\n').includes(`branch refs/heads/lane/${job.lane}`));
  return entry?.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
}
function liveWorker(worker) {
  lane(['verify-agent', worker.agentName, job.workspace]);
  const agent = herdr(['agent', 'get', worker.agentName]).agent;
  if (!agent || agent.name !== worker.agentName || agent.pane_id !== worker.pane || agent.workspace_id !== worker.workspaceId ||
      fs.realpathSync(agent.cwd) !== job.workspace ||
      (worker.terminalId && agent.terminal_id !== worker.terminalId) ||
      (worker.agentSessionId && agent.agent_session?.value !== worker.agentSessionId)) {
    throw new Error('worker occupant identity changed; inspect it before recovery');
  }
  return agent;
}
function observeNative() {
  const agent = liveWorker(job.worker);
  const readNative = a => nativeProcess(a, herdr(['pane', 'process-info', '--pane', job.worker.pane]).process_info,
    pid => lookupProcess(pid, { identityOnly: true,
      allowance: ms => observationDeadline === undefined ? ms : Math.max(1, Math.min(ms, observationDeadline - Date.now())), pause: () => {} }));
  const native = readNative(agent);
  const after = liveWorker(job.worker);
  if (agent.agent_session?.value && agent.agent_session.value !== after.agent_session?.value) throw Error('native session changed during observation');
  if (after.agent_session?.value) {
    const checked = readNative(after);
    if (checked.pid !== native.pid || checked.identity !== native.identity) throw Error('native process changed during observation');
  }
  return { process: native, session: after.agent_session?.value };
}
function captureLaunchProcess() {
  // Pin once alongside the original worker identity, before its receipt and
  // watcher. Recovery never replaces missing or old continuity evidence.
  job.launchProcess = null;
  try { job.launchProcess = observeNative().process; } catch {}
}
function admission(repo, org, common) {
  const { config } = loadDiscoveredRoutes({ cwd: repo });
  const evidence = checkSessionCap({ config, org, common, agent: name => herdr(['agent', 'get', name]).agent,
    processInfo: pane => herdr(['pane', 'process-info', '--pane', pane]).process_info, excludeStartJournal: journal,excludePendingJournal:journal,kind:job?.reviewQueue?'review':'build' });
  if (job) job.sessionCap = evidence;
  return evidence;
}
function unlandedAdmission(request, { requireLink = false } = {}) {
  const { config } = loadDiscoveredRoutes({ cwd: request.repo });
  return checkSourceAdmission({ config, org: request.org, common: request.common, request, requireLink });
}
function requestStarts() {
  return loadEvents(job.org).events.filter(event => event.type === 'run.started' && matchesDispatchStart(event, { ...job, journal }));
}
function prepareSessionBinding(run) {
  const binding = job.sessionBinding;
  if (job.worker.agentSessionId || run.meta.dispatch_attempt !== job.token ||
      binding?.status === 'bound' || binding?.proposed) return;
  // A new delivery (or explicit confirmation of uncertain delivery) gets one
  // bounded observation window. Keep the original launch continuity and receipt:
  // recovery must never pin a replacement occupant or rewrite a saved proposal.
  const receipt = binding ? binding.receipt
    : workerReceipt(json(record(['show', job.run, '--json'])), identityState());
  const prompted = Date.now();
  job.sessionBinding = { status: 'observing', process: binding ? binding.process : job.launchProcess ?? null, receipt,
    prompted_at: new Date(prompted).toISOString(), deadline: new Date(prompted + 60000).toISOString() };
}
async function bindSession() {
  const binding = job.sessionBinding;
  if (!binding || ['bound', 'unbound'].includes(binding.status)) return;
  // An exact saved proposal may be retried after the deadline. Observation may not.
  observationDeadline = binding.proposed ? undefined : Date.parse(binding.deadline);
  try {
    await observeSessionBinding({ job: { ...job, journal }, save, observe: observeNative,
      record: () => {
        // Only observations use the launch-window timeout. The writer checks
        // its deadline under the record lock and must finish its transaction.
        observationDeadline = undefined;
        return record(['session-bind', '--journal', journal]);
      } });
  } finally { observationDeadline = undefined; }
}
function capture(name) {
  lane(['verify-agent', name, job.workspace]);
  const agent = herdr(['agent', 'get', name]).agent;
  if (!agent?.pane_id || !agent.workspace_id) throw new Error('agent has no pane/workspace identity');
  return { agentName: name, pane: agent.pane_id, workspaceId: agent.workspace_id,
    terminalId: agent.terminal_id ?? null, agentSessionId: agent.agent_session?.value ?? null, cwd: job.workspace };
}
function lockJob() {
  lock = `${journal}.lock`;
  // Publish a unique contender before inspecting any owner. Every later contender
  // sees this live PID and refuses; stale cleanup can never delete a new owner's
  // contender. This also serializes takeover of the original single-file lock.
  const directory = `${lock}s`;
  fs.mkdirSync(directory, { recursive: true });
  contender = path.join(directory, `${process.pid}-${randomUUID()}`);
  fs.writeFileSync(contender, '', { flag: 'wx', mode: 0o600 });
  for (const entry of fs.readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (file === contender) continue;
    const pid = Number(entry.split('-')[0]);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid dispatch lock owner; inspect request locks');
    try { process.kill(pid, 0); throw new Error(`dispatch is already running (pid ${pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid dispatch lock owner; inspect request lock');
    try { process.kill(pid, 0); throw new Error(`dispatch is already running (pid ${pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  ownsLock = true;
}
async function main() {
  if (!positionals.length && !opt.retry && !opt.status) {
    process.stdout.write(`dispatch ITEM --lane TOPIC --route ROUTE --brief FILE --report FILE [--org DIR] [--to AGENT] [--awaited [--awaited-step TEXT]]\nRecord is discovered from the canonical project. Routes carry a suggested preset; ask the operator before adopting it.\nStart the native harness through Herdr; ordinary report notices default to the recorded worker. Workers self-land finished source under the current operator waiver, start one async post-code review and report focused checks once. Only the canonical supervisor starts housekeeping.\n`);
    return;
  }
  opt.org ??= findOrgDir({ cwd: opt.repo });
  if (!opt.org) throw new Error('--org DIR or ORG_DIR is required');
  if (opt['awaited-step'] !== undefined && (!opt.awaited || !opt['awaited-step'].trim())) throw new Error('--awaited-step requires --awaited and nonempty text');
  if ((opt.adopt && opt.fresh) || (opt.resend && opt['accept-delivered'])) throw new Error('choose one launch recovery and one delivery recovery');
  if (opt.status) {
    journal = locate(opt.status);
    process.stdout.write(`${fs.readFileSync(journal, 'utf8')}\n`);
    return;
  }
  if (opt.retry) {
    if (positionals.length || ['lane', 'route', 'brief', 'report', 'reuse', 'base', 'extra', 'awaited', 'awaited-step', 'unblocks'].some((key) => opt[key] !== undefined)) {
      throw new Error('--retry uses the saved request; do not supply new work flags');
    }
    journal = locate(opt.retry);
    lockJob();
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (saved.org !== fs.realpathSync(opt.org)) throw new Error('retry belongs to a different record');
    const boundRun = saved.run ?? saved.fromRun;
    if (boundRun) {
      const binding = requireController(readOwnedRun(saved.org, boundRun), opt.controller);
      if (saved.ownership && saved.ownership.generation !== binding.generation) throw new Error('RUN_OWNED_ELSEWHERE: dispatch receipt has an earlier claim');
      const target = binding.owner.release.root;
      if (target !== bundleRelease().root) {
        fs.unlinkSync(lock); ownsLock = false;
        fs.unlinkSync(contender); contender = null;
        process.exitCode = continueOwnerRelease('dispatch/dispatch.mjs', binding); return;
      }
      continueOwnerRelease('dispatch/dispatch.mjs', binding);
    }
    if (saved.release && saved.release.root !== bundleRelease().root) {
      operationFile('dispatch/dispatch.mjs', saved.release);
      // Read under the existing lock. Only transfer the bundle identity;
      // the receiving retry takes the lock and reads fresh progress again.
      if (fs.readFileSync(lock, 'utf8') !== String(process.pid)) throw Error('dispatch lock changed before release handoff');
      fs.unlinkSync(lock); ownsLock = false;
      fs.unlinkSync(contender); contender = null;
      process.exitCode = continueRelease('dispatch/dispatch.mjs', saved.release);
      return;
    }
    job = saved;
    if(job.detached)controllerDeadline=Date.now()+600000;
    if (opt['from-run'] !== undefined) {
      if (job.fromRun && job.fromRun !== opt['from-run']) throw new Error('--from-run cannot replace the saved origin');
      checkOrigin(opt['from-run'], json(record(['show', job.item, '--json'])), !job.run && job.stage !== 'starting');
      job.fromRun = opt['from-run'];
      job.predecessor ??= { run: job.fromRun, binding: requireController(readOwnedRun(job.org, job.fromRun), opt.controller) };
    }
  } else {
    let predecessor;
    if (opt['from-run']) {
      predecessor = { run: opt['from-run'], binding: requireController(readOwnedRun(opt.org, opt['from-run']), opt.controller) };
      const bound = continueOwnerRelease('dispatch/dispatch.mjs', predecessor.binding);
      if (bound !== null) { process.exitCode = bound; return; }
    }
    // The existing launcher selector may explicitly choose this development
    // dispatcher for a NEW request, including a home-bound/pinned project.
    // Retry and predecessor handling above always retain their saved owner.
    let sourceSelection;
    if (!predecessor && process.env.HERDR_BRAIN_ROOT) {
      const actual = bundleRelease(), requested = fs.realpathSync(process.env.HERDR_BRAIN_ROOT);
      if (actual.commit || requested !== actual.root) throw new Error('HERDR_BRAIN_ROOT must match the invoked development source root; no dispatch created');
      sourceSelection = { kind: 'explicit-brain-root', root: actual.root, head: git(['rev-parse', 'HEAD'], actual.root) };
    }
    const forwarded = predecessor || sourceSelection ? null : forwardRelease('dispatch/dispatch.mjs', opt.repo);
    if (forwarded !== null) { process.exitCode = forwarded; return; }
    if (opt.adopt || opt.fresh || opt.resend || opt['accept-delivered'] || opt['recover-run']) throw new Error('recovery flags require --retry');
    if (positionals.length !== 1 || !opt.lane || !opt.route || !opt.brief) throw new Error('usage: dispatch.mjs ITEM --org DIR --lane TOPIC --route ROUTE --brief FILE [--report FILE] [--to AGENT] [--base REF] [--reuse R-n] [--extra TEXT] | --retry R-n|JOURNAL | --status R-n|JOURNAL');
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(opt.lane)) throw new Error('lane must be short kebab-case');
    const repo = fs.realpathSync(path.resolve(opt.repo));
    const org = fs.realpathSync(path.resolve(opt.org));
    const brief = fs.realpathSync(path.resolve(opt.brief));
    if (!fs.statSync(brief).isFile() || !fs.readFileSync(brief, 'utf8').trim()) throw new Error('brief must be a nonempty file');
    // Validate item, target and launch route before opening a lane or starting a run.
    const item = json(record(['show', positionals[0], '--json']));
    if (Object.hasOwn(item, 'item') || !Array.isArray(item.runs)) throw new Error('dispatch ITEM must be an item, not a run');
    let reviewQueue;
    if (isQueueReview(item)) {
      if (opt.reuse || opt['from-run'] || opt.unblocks) throw Error('queued review cannot replace/reuse a source item review');
      const events = loadEvents(org).events;
      reviewQueue = validateQueuedReview({ item, state: fold(events), events, org, repo });
      if (opt.base !== reviewQueue.head || !opt.lane.startsWith('review-')) throw Error('queued review requires its exact captured head in a genuine review lane');
    }
    if (opt['from-run'] !== undefined) {
      checkOrigin(opt['from-run'], item);
    }
    if (opt.to !== undefined) herdr(['agent', 'get', opt.to]);
    const { config } = loadDiscoveredRoutes({ cwd: repo });
    if (reviewQueue && opt.route !== reviewQueueRoute(config)) throw Error('queued review must use the normal reviewer route');
    const declared = resolveRoute(config, { route: opt.route });
    resolveLaunchRoute(config, { route: opt.route });
    const declaredFields = { harness: declared.kind, model: declared.model ?? null, effort: declared.effort ?? null };
    if (opt.reuse) checkReuse(json(record(['show', opt.reuse, '--json'])), { lane: opt.lane, route: opt.route, declared: declaredFields });
    const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo));
    unlandedAdmission({ repo, org, common, item: item.id, fromRun: opt['from-run'], unblocks: opt.unblocks });
    if (!opt.reuse) admission(repo, org, common);
    const token = randomUUID();
    const directory = path.join(org, 'dispatch');
    fs.mkdirSync(directory, { recursive: true });
    journal = path.join(directory, `${token}.json`);
    job = { token, repo, org, common, predecessor, release: bundleRelease(), sourceSelection: sourceSelection ?? null,
      operatorRecordCommand: [process.execPath, local('../bin/org.mjs')],
      operatorRecordRoot: bundleRelease().root,
      operatorPlainText: true,
      item: positionals[0], lane: opt.lane, route: opt.route, reviewQueueProtocol: 1,
      ...(reviewQueue ? { reviewQueue, reviewQueueBrief: reviewQueueBrief(item) } : {}),
      brief, report: opt.report ?? null, to: opt.to ?? null,
      base: git(['rev-parse', `${opt.base ?? 'HEAD'}^{commit}`], repo), extra: opt.extra ?? '', reuse: opt.reuse ?? null, fromRun: opt['from-run'] ?? null, unblocks: opt.unblocks ?? null,
      declared: declaredFields, exceptionAddress: projectExceptionAddress(repo, config, opt.route),
      stage: 'open', run: null };
    // Only routing fields are frozen. Lifecycle paths keep their original config provenance.
    job.routeConfig = path.join(directory, `${token}.routes.json`);
    atomic(job.routeConfig, mergeRoutesConfig([config]));
    if (opt.awaited) record(['set', job.item, 'meta.notify=supervisor', ...(opt['awaited-step'] ? [`meta.notify_step=${opt['awaited-step']}`] : [])]);
    save();
    lockJob();
  }
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (common !== job.common) throw new Error('repository common-directory identity changed');
  if (!job.reuse && (['open', 'start', 'starting', 'worker'].includes(job.stage) ||
      (job.stage === 'launching' && opt.fresh))) admission(job.repo, job.org, common);
  const stop = path.join(gitProject(job.repo).canonical, '.lane/supervisor/STOP');
  const checkStop = () => {
    if(Date.now()>=controllerDeadline)throw Object.assign(Error('detached controller command budget exhausted; original journal retained'),{code:'DISPATCH_CONTROLLER_DEADLINE'});
    if (fs.existsSync(stop) || fs.existsSync(path.join(path.dirname(stop), 'HOLD'))) {
      const error = new Error('Supervisor STOP appeared before dispatch; no new worker launched');
      error.code = 'DISPATCH_STOPPED';
      throw error;
    }
    if(job.lineInput){
      const events=loadEvents(job.org).events,state=fold(events),item=state.items.get(job.item);
      if(!item||item.closed||item.meta.hold||item.meta.held||item.meta.operator_reserved||item.meta.reserved||item.role==='human')throw Error('detached item closed/held/reserved before native effect');
      if(job.run){
        if(item.runs.at(-1)!==job.run)throw Error('detached run superseded before native effect');
        state.items.set(item.id,{...item,runs:item.runs.filter(id=>id!==job.run)});state.runs.delete(job.run);
      }
      if(dispatchInput({events,state,item:state.items.get(job.item)})!==job.lineInput)throw Error('detached readiness or genuine changed input differs from its frozen request');
    }
    if (job.reviewQueue) {
      const events = loadEvents(job.org).events, state = fold(events), item = state.items.get(job.item);
      if (!item || item.closed || item.meta.hold || item.meta.held) throw Error('queued review item closed/held before native effect');
      const target = validateQueuedReview({ item, state, events, org: job.org, repo: job.repo, allowRun: job.run, allowJournal: journal });
      if (JSON.stringify(target) !== JSON.stringify(job.reviewQueue)) throw Error('saved review dispatch target/evidence changed');
      if (job.workspace) {
        const actual=gitProject(job.workspace);
        if(actual.identity!==job.common||actual.checkout!==job.workspace||actual.canonical!==job.repo||job.workspace===job.repo||fs.realpathSync(worktree())!==job.workspace)throw Error('review workspace path/common-directory differs from its own registered lane');
        if(git(['rev-parse', 'HEAD'], job.workspace) !== target.head)throw Error('review lane no longer has the immutable captured source');
      }
    }
  };
  if(opt.detach){
    if(opt.retry||job.stage!=='open'||job.detached)throw Error('--detach is only for one new frozen request; never resubmit a saved launch');
    const release=acquireSessionCapLock(common,{check:checkStop});
    try{
      const events=loadEvents(job.org).events,state=fold(events);job.lineInput=dispatchInput({events,state,item:state.items.get(job.item)});
      if(!job.lineInput)throw Error('detached start needs ready work or a genuinely changed blocked report');
      admission(job.repo,job.org,common);checkStop();job.detached=true;job.recordOnlyNotices=true;job.phase1_protocol=1;save();
    }finally{release();}
    // Durable original request precedes spawn. The child takes the SAME request
    // lock; a lost spawn result is retained and never automatically relaunched.
    const output=fs.openSync(`${journal}.driver.log`,'a',0o600);
    try{
      if(!ownsLock||fs.readFileSync(lock,'utf8')!==String(process.pid))throw Error('detached request ownership changed before handoff');
      fs.unlinkSync(lock);ownsLock=false;if(contender){fs.unlinkSync(contender);contender=null;}
      const args=[local('../dispatch/dispatch.mjs'),'--retry',journal,'--repo',job.repo,'--org',job.org,'--controller',opt.controller,
        ...(opt['org-cli']?['--org-cli',opt['org-cli']]:[]),...(opt['lane-cli']?['--lane-cli',opt['lane-cli']]:[]),...(opt['watch-cli']?['--watch-cli',opt['watch-cli']]:[])];
      const child=spawn(process.execPath,args,{cwd:job.repo,env:process.env,detached:true,stdio:['ignore',output,output]});child.on('error',e=>fs.appendFileSync(`${journal}.driver.log`,`${e.message}\n`));child.unref();
      fs.mkdirSync(`${journal}.driver`,{recursive:true});
      fs.writeFileSync(`${journal}.driver/launch.json`,JSON.stringify({pid:child.pid??null,at:new Date().toISOString(),journal,command_limit_ms:120000,controller_budget_ms:600000})+'\n',{flag:'wx',mode:0o600});
      process.stdout.write(JSON.stringify({result:'detached',journal,run:null,item:job.item,pid:child.pid??null})+'\n');return;
    }finally{fs.closeSync(output);}
  }
  if (opt['recover-run']) {
    if (job.run || !requestStarts().some(start => start.id === opt['recover-run'])) throw new Error('recovery run does not belong to this request');
    job.run = opt['recover-run']; claimAdmission(); job.stage = 'worker'; save();
  }
  if (job.stage === 'open') {
    unlandedAdmission(job);
    if (job.fromRun) checkOrigin(job.fromRun, json(record(['show', job.item, '--json'])));
    if (job.reuse) checkReuse(json(record(['show', job.reuse, '--json'])), job);
    memoryGate('memory_open', 'dispatch', checkStop);
    if (!worktree()) lane(['open', job.lane, ...(job.base ? [job.base] : []), '--git-only']);
    job.workspace = fs.realpathSync(worktree());
    // prepare validates that the registered lane is owned by this repository.
    lane(['prepare', job.lane]);
    if (job.base) {
      if (git(['status', '--porcelain=v1'], job.workspace)) throw new Error('base fast-forward requires a clean lane');
      git(['merge', '--ff-only', '--no-edit', '--', job.base], job.workspace);
    }
    job.stage = 'start'; save();
  }
  if (job.stage === 'starting') {
    const matches = requestStarts();
    if (matches.length === 1) {
      job.run = matches[0].id; claimAdmission(); job.stage = 'worker'; save();
    } else if (matches.length === 0 && job.startRefused) {
      job.stage = 'start'; save();
    } else {
      throw new Error('record start outcome is unknown or has multiple matches; inspect record and use --recover-run R-n');
    }
  }
  if (job.stage === 'start') {
    if (job.fromRun) checkOrigin(job.fromRun, json(record(['show', job.item, '--json'])));
    if (job.reuse) checkReuse(json(record(['show', job.reuse, '--json'])), job);
    // Save the pending start's item/exception reservation before spawning its
    // writer; it survives coordinator death until a recorded start replaces it.
    // Reuse shares this admission too. Never hold the project lock over memory
    // waits; session launch takes the same lock again for its independent cap.
    releaseAdmission = acquireSessionCapLock(common, { check: checkStop });
    job.unlandedCap = unlandedAdmission(job);
    if (job.unblocks) {
      record(['block', job.unblocks, '--by', job.item]);
      job.unlandedCap = unlandedAdmission(job, { requireLink: true });
    }
    delete job.startRefused;
    job.stage = 'starting'; save();
    let output;
    try { output = record(['start', job.item, '--route', job.route, '--route-config', job.routeConfig,
      '--workspace', job.workspace, '--meta', `lane=${job.lane}`, '--meta', `dispatch_journal=${journal}`,
      '--meta', `dispatch_attempt=${job.token}`, '--meta', `dispatch_project=${job.common}`, '--meta', `dispatch_record=${job.org}`,
      '--meta', `dispatch_unlanded_admitted=${job.unlandedCap.admission.admitted}`,
      ...(job.unlandedCap.admission.kind === 'review' ? ['--meta', 'dispatch_role=review'] : []),
      ...(job.fromRun ? ['--meta', `dispatch_from_run=${job.fromRun}`] : []),
      ...(job.unblocks ? ['--meta', `dispatch_unblocks=${job.unblocks}`] : []),
      ...(!['regular', 'review'].includes(job.unlandedCap.admission.kind) ? ['--meta', `dispatch_unlanded_exception=${job.unlandedCap.admission.kind}`] : []),
      ...(job.fromRun ? ['--if-current-run', job.fromRun] : []),
      ...(job.reuse ? ['--meta', `continuation_of=${job.reuse}`, '--meta', 'same_session=true'] : []),
      ...(job.report ? ['--report', path.resolve(job.workspace, job.report)] : [])]); }
    catch (error) {
      if (error.recordRefusal && /R-\d+ is superseded by R-\d+/.test(error.message)) error.code = 'FROM_RUN_SUPERSEDED';
      job.startRefused = error.recordRefusal === true; save(); throw error;
    }
    job.run = output.match(/^(R-\d+) started/m)?.[1];
    if (!job.run) throw new Error('record start returned no run id; inspect record before retry');
    claimAdmission();
    job.stage = 'worker'; save();
    releaseAdmission(); releaseAdmission = undefined;
    note(`run started; request ${journal}`);
  }
  claimAdmission();
  const run = json(record(['show', job.run, '--json']));
  if ((run.abandoned || run.report) && job.stage !== 'complete') throw new Error('run is already abandoned or reported; start a new run');
  if (run.item !== job.item || run.meta?.dispatch_journal !== journal || fs.realpathSync(run.workspace) !== job.workspace) throw new Error('run no longer matches dispatch request');
  if (run.meta?.route !== job.route || Object.entries(job.declared).some(([key, value]) => (run.meta?.[key] ?? null) !== value)) throw new Error('run routing metadata changed; inspect before recovery');
  if (job.stage === 'complete' && (run.report || run.abandoned)) {
    if (job.sessionBinding && !job.sessionBinding.proposed) {
      job.sessionBinding.status = 'unbound'; job.sessionBinding.reason = 'run finished before binding';
    }
    await bindSession();
    delete job.error; save();
    outputReceipt(); return;
  }
  if (job.stage === 'complete') {
    const identity = effectiveWorkerIdentity(run, identityState());
    if (identity.identity_conflict) throw Error('conflicting worker session identity; inspect before recovery');
    liveWorker({ ...job.worker, agentSessionId: identity.agent_session_id ?? job.worker.agentSessionId });
  }
  dispatchWaits = run.meta?.dispatch_waits;
  admissionWaits = run.meta?.dispatch_admission_waits;
  syncTiming();
  // start may have committed the run before failing to materialize its brief.
  // The existing record command recreates a missing brief from durable context.
  if (!fs.existsSync(run.brief_path)) record(['brief', job.run]);
  if (job.stage === 'launching') {
    if (opt.fresh) {
      job.stage = 'worker'; save();
      note('caller requested a fresh launch after inspecting the uncertain prior attempt');
    } else {
      if (!opt.adopt) throw new Error('worker launch outcome is unknown; inspect lane, then use --adopt AGENT or --fresh (never auto-relaunch)');
      job.worker = capture(opt.adopt); captureLaunchProcess(); job.stage = 'record-worker'; save();
      note(`caller adopted worker ${opt.adopt} after uncertain launch`);
    }
  }
  if (job.stage === 'worker') {
    memoryGate('memory_worker', 'dispatch worker', checkStop);
    if (job.reuse) {
      const prior = json(record(['show', job.reuse, '--json']));
      const identity = effectiveWorkerIdentity(prior, identityState());
      checkReuse(prior, job);
      if (fs.realpathSync(prior.workspace) !== job.workspace) throw refusal('REUSE_MISMATCH', 'reuse run must match item, lane, route and declared harness/model/effort; use a fresh worker');
      if (identity.identity_conflict || (!identity.agent_session_id && !identity.terminal_id)) throw refusal('REUSE_IDENTITY_UNKNOWN', 'reuse needs consistent recorded occupant identity; use a fresh worker');
      job.worker = { agentName: identity.agent, pane: identity.pane, workspaceId: identity.worker_workspace,
        terminalId: identity.terminal_id, agentSessionId: identity.agent_session_id };
      let agent;
      try { agent = liveWorker(job.worker); }
      catch (error) { error.code ??= 'REUSE_IDENTITY_UNKNOWN'; throw error; }
      if (!['idle', 'done'].includes(agent.agent_status)) throw refusal('REUSE_WORKER_BUSY', 'reuse worker must be idle or done');
    } else {
      // Early counts are advisory. Serialize only the final recount and launch,
      // after both memory waits and lane/record preparation have finished.
      releaseAdmission = timedMemoryWait({ journal, run: job.run, item: job.item, lane: job.lane, kind: 'admission_lock',
        wait: () => acquireSessionCapLock(common, { check: checkStop }), persist: syncTiming, onError: timingFailure });
      admission(job.repo, job.org, common);
      checkStop();
      job.stage = 'launching'; save();
      job.native_launch_attempted=true;save();
      const output = lane(['dispatch', job.lane, '--route', job.route, '--route-config', job.routeConfig, '--json', '--memory-checked',
        ...(job.reviewQueue ? ['--expected-head',job.reviewQueue.head] : [])]);
      const launched = JSON.parse(output);
      if (launched.result === 'stopped') {
        job.stage = 'worker'; save();
        const error = new Error(launched.reason);
        error.code = 'DISPATCH_STOPPED';
        throw error;
      }
      job.worker = json(output);
    }
    // Publish the bound worker before releasing admission. Native process
    // observation can wait on Herdr; until saved, this occupant counts unknown.
    job.launchProcess = null;
    job.stage = 'record-worker'; save();
    releaseAdmission?.(); releaseAdmission = undefined;
    captureLaunchProcess(); save();
  }
  if (job.stage === 'record-worker') {
    liveWorker(job.worker);
    const worker = job.worker;
    record(['worker', job.run, '--agent', worker.agentName, '--pane', worker.pane,
      '--worker-workspace', worker.workspaceId, '--cwd', job.workspace,
      ...(worker.agentSessionId ? ['--agent-session-id', worker.agentSessionId] : []),
      ...(worker.terminalId ? ['--terminal-id', worker.terminalId] : [])]);
    note(`worker ${worker.agentName} in ${worker.pane} recorded; prompt not sent`);
    job.stage = 'watch'; save();
  }
  if (job.stage === 'watch' || job.stage === 'prompting' || job.stage === 'prompt' || job.stage === 'complete') {
    liveWorker(job.worker);
    // Re-arm only through watch's exclusive per-run lock. It refuses duplicates.
    if (!job.watcher) {
      // Choose the ordinary recipient only after immutable worker recording and
      // live occupant verification. Saved/explicit recipients remain unchanged.
      job.to ??= job.worker.agentName;
      save();
      job.watcher = json(command(watchCLI, [job.run, '--controller', opt.controller, '--org', job.org, '--to', job.to,
        '--cwd', job.repo, '--detach', '--log', path.join(job.org, 'dispatch', `${job.run}.watch.log`),
        ...(opt['org-cli'] ? ['--org-cli', opt['org-cli']] : []),...(job.recordOnlyNotices?['--record-only']:[])]));
      save();
    } else {
      if (!ownerAlive(job.watcher)) {
        job.watcher = null; save();
        throw new Error('watcher stopped; retry to re-arm it without replaying the prompt');
      }
    }
    if (!Number.isInteger(job.watcher.pid) || job.watcher.pid < 1) throw new Error('watcher returned an invalid PID');
    if (!ownerAlive(job.watcher)) throw new Error('watcher stopped before its receipt was recorded');
    record(['set', job.run, `watcher_pid=${job.watcher.pid}`, `watcher_identity=${job.watcher.identity}`, `watcher_log=${job.watcher.log}`]);
    if (job.stage === 'watch') note(`watcher ready (pid ${job.watcher.pid}); prompt not sent`);
    if (job.stage === 'watch') { job.stage = 'prompt'; save(); }
    if (job.stage === 'prompting' && opt['accept-delivered']) {
      prepareSessionBinding(run);
      job.stage = 'complete'; save();
      note('caller confirmed the uncertain prompt was delivered; no resend');
    }
    if (job.stage === 'prompting' && !opt.resend) throw new Error('prompt delivery outcome is unknown; inspect worker, then --accept-delivered or --resend only if delivery did not land');
    if (job.stage === 'prompt' || (job.stage === 'prompting' && opt.resend)) {
      liveWorker(job.worker);
      if (job.declared.harness === 'codex') {
        const screen = command(['herdr'], ['pane', 'read', job.worker.pane, '--source', 'visible', '--format', 'text']);
        const dialog = hookReviewDialog(screen);
        if (dialog) {
          const launch = resolveLaunchRoute(JSON.parse(fs.readFileSync(job.routeConfig, 'utf8')), { route: job.route });
          const profile = codexProfile(launch.args);
          const scope = profile ? `profile ${JSON.stringify(profile)} (-p ${JSON.stringify(profile)})`
            : 'the configured default profile (no -p/--profile in the saved route)';
          const error = new Error(`Codex hook-review dialog "${dialog}" blocks worker ${job.worker.agentName} in ${job.worker.pane}, ${scope}; brief not sent. Open /hooks in that worker session and review the hooks in that profile, then retry with --retry ${job.run}. Hook trust is the operator's decision.`);
          error.code = 'DISPATCH_HOOK_REVIEW';
          throw error;
        }
      }
      if (job.reuse) checkReuseOccupant(json(record(['show', job.reuse, '--json'])), job.run);
      const validation = job.reviewQueue ? 'Independent code/evidence review: zero build, test, prepare, install or check commands; zero reviewer suites. Preserve inherited producer evidence and never label an unrun check PASS.' : `Run only the ask's or explicit --extra scope's focused check selection once through ${JSON.stringify(process.execPath)} ${JSON.stringify(local('../lanes/lane.mjs'))} check --cmd 'COMMAND' on the clean committed candidate before reporting, using the existing project runner and preserving file groups and limits. When checks run, this writes .lane/gate.json and the shared lane-validation receipt with command, exit status, TAP totals and Node version for settle to inherit. If no check is selected or applicable, report the selection/scope and unrun truth; do not substitute a blanket default/fast/npm suite or label unrun checks PASS. Do not add a tier run or repeat tests solely to create a receipt. Self-land finished source without a test/review readiness gate; the one full final-release obligation stays with its release coordinator.`;
      job.exceptionAddress ??= projectExceptionAddress(job.repo, JSON.parse(fs.readFileSync(job.routeConfig, 'utf8')), job.route);
      const exception = job.exceptionAddress.to ? `your PROJECT SUPERVISOR at ${JSON.stringify(job.exceptionAddress.to)}`
        : 'your PROJECT SUPERVISOR; its project-specific exception address is UNKNOWN, so report that missing address without inventing a recipient';
      const reviewDirection = job.reviewQueue ? 'Review only the captured immutable diff/evidence; no source edits, landing, tests or second review.' : job.reviewQueueProtocol ? 'Hand the immutable landed base/head and producer evidence through your report to the single record queue-review path; the line service creates/dispatches the one review item. Never start a parallel settle/lane review, wait for a verdict to land, or replace an existing/UNKNOWN attempt.' : 'Start ONE independent async post-code review through the existing route, zero reviewer suites; do not wait for its verdict to land.';
      const owner = `Your recorded worker agent is ${job.worker.agentName}; the existing report watcher targets ${job.to}. Retain that watcher. ${job.reviewQueue ? '' : 'Self-land your own finished committed source through lane promote under the current operator waiver, with clean worktree/rebase/FF and native identity/claim/source/CAS/STOP/HOLD safety. '}${reviewDirection} Use --to ${job.worker.agentName} for your ordinary settle/queued-promotion notices and existing prompt delivery for review completion. Own the correction/fix-forward and report actual receipts once. Route actual unsafe/native/identity/ownership/reserved/failed exceptions to ${exception}; never invoke supervisor cycle mutations or borrow supervisor identity.`;
      // New requests pin their producer command. Older saved jobs/prompts retain
      // their original behavior rather than receiving a retroactive instruction.
      const wording = job.operatorPlainText ? ` --happened '<what happened in plain words>' --action '<what you need to do, usually Nothing needed.>' --details ${quote(`${job.item}; ${job.run}; technical references`)}` : '';
      const composition = job.operatorPlainText ? ' EVERY message addressed to the operator must read naturally: one-line headline, what happened, whether you need to do anything, then ONE trailing Details line. Author the main text for a non-agent reader; bare item/run IDs, hashes, receipt/source jargon and shorthand such as bootstrap5 or record-only belong only in Details. A pending reserved decision must say a decision is needed, never Nothing needed. Internal agent coordination and owned callbacks keep their technical contracts.' : '';
      const producer = job.operatorRecordCommand ? `For OPERATOR-addressed status/fyi/done/questions, store an envelope in the owning record with this explicit source command: ${job.operatorRecordRoot ? `HERDR_BRAIN_ROOT=${quote(job.operatorRecordRoot)} ` : ''}ORG_DIR=${quote(job.org)} ORG_ACTOR=${quote(job.worker.agentName)} ${job.operatorRecordCommand.map(quote).join(' ')} messages send --id ${quote(`${job.run}:operator:STABLE_NOTICE_ID`)} --kind notice --run ${quote(job.run)} --item ${quote(job.item)} --summary '<one-line summary>'${wording}. Reuse the stable ID for a retry; use kind fyi for fyi and question/request for judgment, with --correlation THREAD and --reply-to ID when applicable. Pull messages digest on demand with the same source command. Ordinary OPERATOR-addressed messages are record-only and never typed into an operator pane. Only an actual pending human question already explicitly operator_reserved in the record, referenced with --question HUM-n, pushes once through the existing native inbox and Brain Chat filtering. Routine T2 questions do not become reserved. Internal owned report/watch callbacks and project T2/BrainChat delivery retain their existing native paths and recipients; retain the watcher. Do not fabricate native bindings or change pins, saved jobs or long-lived sessions.${composition}` : '';
      const prompt = `You are run ${job.run} on org item ${job.item}. Read ${job.brief} (the ask) and ${run.brief_path} (the record context and report template), then do the work. Write the report to ${run.report_path}; the report's run field is ${job.run}.\n\n${owner}${producer ? `\n\n${producer}` : ''}\n\n${validation}${job.reviewQueueBrief ? `\n\n${job.reviewQueueBrief}` : ''}${job.extra ? `\n\n${job.extra}` : ''}`;
      if (job.reviewQueue) checkStop();
      prepareSessionBinding(run);
      job.stage = 'prompting'; save();
      herdr(['agent', 'prompt', job.worker.agentName, prompt]);
      job.stage = 'complete'; save();
      note(`prompt sent; worker ${job.worker.agentName} and watcher ${job.watcher.pid} started`);
    }
  }
  await bindSession();
  delete job.error; save();
  outputReceipt();
}
function outputReceipt() {
  const binding = job.sessionBinding?.proposed && job.sessionBinding.status === 'observing'
    ? { status: 'unknown', retry: `node dispatch/dispatch.mjs --retry ${job.run}` }
    : { status: job.sessionBinding?.status ?? (job.worker.agentSessionId ? 'recorded' : 'unbound') };
  process.stdout.write(`${JSON.stringify({ run: job.run, item: job.item, lane: job.lane, route: job.route, ...job.declared,
    agent: job.worker.agentName, pane: job.worker.pane, watcher: job.watcher, journal, binding, legacy: job.unlandedCap?.legacy })}\n`);
}
try { await main(); }
catch (error) {
  if (job && journal && ownsLock) {
    job.error = error.message;
    if(job.detached&&!job.native_launch_attempted&&!job.worker&&!['starting','launching','prompting'].includes(job.stage))job.detached_refused=true;
    save();
    if (job.run) try { note(`incomplete at ${job.stage}: ${error.message}; retry with --retry ${job.run}`); } catch {}
  }
  process.stderr.write(`dispatch: ${error.message}${journal ? `\nrequest: ${journal}` : ''}\n`);
  if (error.code === 'DISPATCH_STOPPED') {
    process.stdout.write(`${JSON.stringify({ result: 'stopped', run: job.run, item: job.item, lane: job.lane,
      reason: error.message, stage: job.stage, journal })}\n`);
  } else if (error.code === RESERVATION_WAIT_EXPIRED_CODE) {
    process.stdout.write(`${JSON.stringify({ result: 'deferred', code: error.code, reason: error.message,
      elapsed_ms: error.elapsed_ms, run: job.run, item: job.item, stage: job.stage, journal })}\n`);
    process.exitCode = 75;
  } else if (error.code === 'DISPATCH_HOOK_REVIEW') {
    process.stdout.write(`${JSON.stringify({ result: 'blocked', code: error.code, run: job.run, item: job.item,
      agent: job.worker.agentName, pane: job.worker.pane, reason: error.message, stage: job.stage, journal })}\n`);
    process.exitCode = 1;
  } else {
    // Coordinators inherit stderr for live waits; retain failure evidence on
    // their captured stdout as well, including failures before a journal exists.
    process.stdout.write(`${JSON.stringify({ result: 'failed', code: dispatchCodes.has(error.code) ? error.code : 'DISPATCH_FAILED', reason: error.message, journal })}\n`);
    process.exitCode = 1;
  }
} finally {
  releaseAdmission?.();
  if(opt.retry&&job?.detached&&journal&&ownsLock){
    fs.mkdirSync(`${journal}.driver`,{recursive:true});const fd=fs.openSync(`${journal}.driver/results.jsonl`,'a',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),journal,stage:job.stage,run:job.run,exit_code:process.exitCode??0,error:job.error??null,native_launch_attempted:job.native_launch_attempted??false})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  if (ownsLock) try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {}
  if (contender) try { fs.unlinkSync(contender); } catch {}
}
