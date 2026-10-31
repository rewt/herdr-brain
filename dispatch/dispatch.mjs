#!/usr/bin/env node
// Coordination is a foreground CLI. Only watch owns a background process.
import { ownerAlive } from '../lib/process-owner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawnSync,spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig, resolveRoute, resolveLaunchRoute, resumeSessionArguments } from '../lanes/routes.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { resumeSource } from './resume-source.mjs';
import { prepareResumeDelivery, observeResumeDelivery } from './resume-delivery.mjs';
import { BRAIN_CONTROLLER, brainOwner, claimRun, readOwnedRun, requireController, fenceOwner, continueOwnerRelease } from '../lib/run-owner.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { waitForProvingHold, RESERVATION_WAIT_EXPIRED_CODE } from '../test-slot/reservations.mjs';
import { admissionDeadline } from '../lib/deadline.mjs';
import { readTiming, timedMemoryWait, timingMetadata, readAdmissionTiming, admissionTimingMetadata } from '../lib/run-timing.mjs';
import { gitProject } from '../lib/project.mjs';
import { bundleRelease, forwardRelease, continueRelease, operationFile, checkRelease, requireReadyAcceptance } from '../lib/releases.mjs';
import {probationRuntime} from '../line-service/probation.mjs';
import { hookReviewDialog, codexProfile } from './hook-review.mjs';
import { effectiveWorkerIdentity, workerReceipt, sharesWorker } from '../lib/worker-identity.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { nativeProcess, observeSessionBinding } from './session-bind.mjs';
import { acquireSessionCapLock, checkSessionCap, dispatchPool } from './session-cap.mjs';
import { checkSourceAdmission, matchesDispatchStart } from './unlanded-cap.mjs';
import { quote } from '../lib/shell.mjs';
import { isQueueReview, validateQueuedReview, reviewQueueBrief, reviewQueueRoute,reserveUnstartedReview } from '../line-service/review-queue.mjs';
import { dispatchInput } from '../line-service/phase1.mjs';
import {preflightContinuation} from './preflight.mjs';
import {foregroundCommand} from './foreground-command.mjs';
import {lockRequest} from './request-lock.mjs';
import {resolvedNotStarted} from './not-started.mjs';
import {originalPrestartProof,reviewDigest,reviewPlain} from '../line-service/review-resolutions.mjs';
import {checkDispatchEligibility,launchDigest} from './launch-guard.mjs';
import { createWorkerBrief, validateWorkerBrief, validateLineExecution, compatibleLineBrief, lineWorkerPrompt, projectExceptionAddress } from '../lib/worker-brief.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';
import {claimRetirementOwner,claimRetirementAllocation} from '../lib/closeout.mjs';
import {recordDispatchCompletion} from './completion.mjs';
import { dispatchLaneName } from '../lib/lane-name.mjs';
import { saveDispatchJournal, sourceConflict } from './journal-save.mjs';

const local = (file) => fileURLToPath(new URL(file, import.meta.url));
const { values: opt, positionals } = parseArgs({ usage: "Usage: node dispatch/dispatch.mjs ITEM --lane TOPIC --route ROUTE --brief FILE [OPTIONS] | --retry R-n|JOURNAL | --status R-n|JOURNAL\nAdmission counts running native workers/reviewers and durable uncertain starts under dispatch.max_sessions. Unlanded lifecycle history is diagnostic only. --from-run retains same-item/current-run guards; --unblocks records a genuine landing dependency and never bypasses native capacity.", allowPositionals: true, options: {
  controller: { type: 'string' },
  repo: { type: 'string', default: process.cwd() }, org: { type: 'string', default: process.env.ORG_DIR },
  lane: { type: 'string' }, route: { type: 'string' }, brief: { type: 'string' }, report: { type: 'string' },
  awaited: { type: 'boolean' }, 'awaited-step': { type: 'string' },
  'watch-mode': {type:'string'},
  to: { type: 'string' }, base: { type: 'string' }, extra: { type: 'string' },
  reuse: { type: 'string' }, retry: { type: 'string' }, status: { type: 'string' },
  'resume-session': { type: 'string' },
  adopt: { type: 'string' }, fresh: { type: 'boolean' }, resend: { type: 'boolean' },
  'accept-delivered': { type: 'boolean' }, 'recover-run': { type: 'string' },
  'from-run': { type: 'string' }, unblocks: { type: 'string' },
  detach:{type:'boolean'}, abandon:{type:'boolean'},'abandon-reason':{type:'string'},
  'continue-preflight':{type:'boolean'},
  'continue-review':{type:'boolean'},
  'resolve-not-started':{type:'string'},disposition:{type:'string'},'decision-seq':{type:'string'},id:{type:'string'},'changed-source':{type:'string'},role:{type:'string'},
  'org-cli': { type: 'string' }, 'lane-cli': { type: 'string' }, 'watch-cli': { type: 'string' },
}});
const cli = (name, fallback) => opt[`${name}-cli`] ? [opt[`${name}-cli`]] : [process.execPath, local(fallback)];
let recordCLI = cli('org', '../bin/org.mjs');
let laneCLI = cli('lane', '../lanes/lane.mjs');
let watchCLI = cli('watch', '../watch/watch.mjs');
if(opt['watch-mode']!==undefined&&!['process','shared'].includes(opt['watch-mode']))throw Error('--watch-mode must be process or shared');
if(opt['watch-mode']!==undefined&&(opt.retry||opt.status||opt.reuse||opt['resume-session']))throw Error('--watch-mode applies only to a new ordinary dispatch; retain saved watcher mode');
const invocationKeys = ['controller', 'org-cli', 'lane-cli', 'watch-cli'];
const invocation = () => Object.fromEntries(invocationKeys.filter(key => opt[key] !== undefined).map(key => [key, opt[key]]));
const invocationFlags = () => Object.entries(invocation()).flatMap(([key, value]) => [`--${key}`, value]);
let job, journal, lock, contender, ownsLock = false, observationDeadline;
let releaseAdmission;
let controllerDeadline=Infinity;
let preflight;
let reviewContinuation;
let completionAttempted = false;
function originalReviewContinuation(saved){
  const events=loadEvents(saved.org).events,proof=originalPrestartProof({events,org:saved.org,common:saved.common,journal,job:saved,requestHash:reviewDigest(reviewPlain(journal))});
  if(proof?.type!=='review.original-continuation'){
    if(opt['continue-review']||saved.reviewContinuations?.length)throw Error('original review continuation proof is UNKNOWN');
    return null;
  }
  const consumed=saved.reviewContinuations?.some(c=>c.original_prestart_seq===proof.seq&&c.request_sha256===proof.request_sha256);
  const zero=!consumed&&proof.kind==='typed-pre-native-worker-barrier'&&saved.stage==='worker'&&saved.native_launch_attempted===false&&!saved.worker&&!saved.launchProcess&&!saved.sessionBinding;
  const idle=(consumed||proof.kind==='bound-unprompted-original')&&['watch','prompt'].includes(saved.stage)&&saved.native_launch_attempted===true&&saved.worker?.agentSessionId&&saved.launchProcess?.identity&&!saved.sessionBinding;
  if((!zero&&!idle)||saved.release?.root!==bundleRelease().root)throw Error('original review continuation is UNKNOWN or progressed; retain the original attempt');
  return proof;
}
function checkReviewContinuationNative(){
  if(!reviewContinuation)return;
  if(!job.worker?.agentSessionId||!job.launchProcess?.identity)throw Error('original unprompted native continuity is UNKNOWN');
  const native=observeNative();
  if(!['idle','done'].includes(native.status)||native.session!==job.worker.agentSessionId||native.process.pid!==job.launchProcess.pid||native.process.identity!==job.launchProcess.identity)throw Error('original unprompted native process/session changed or is active before prompt');
}
const atomic = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
};
const save = () => saveDispatchJournal({ write: () => atomic(journal, job), reserve: write => {
  if (job.ownership && job.run) return fenceOwner(job.org, job.run, job.ownership, write);
  if (job.predecessor) return fenceOwner(job.org, job.predecessor.run, job.predecessor.binding, write);
  return write();
} });
function claimAdmission() {
  if (!job.run) return;
  const desired = job.predecessor?.binding.owner ?? brainOwner(opt.controller);
  const claim = claimRun({ org: job.org, run: job.run, owner: desired, predecessor: job.predecessor, admission: true });
  job.ownership = { owner: claim.owner, generation: claim.generation };
  save();
}
function command(argv, args, cwd = job?.repo ?? path.resolve(opt.repo), mutation = false) {
  const remaining = Math.min(observationDeadline??Infinity,controllerDeadline)-Date.now();
  if (remaining !== undefined && remaining <= 0) throw Error('session observation deadline expired');
  // Mutations use measured inactivity, never a wall-clock kill. A lost reply
  // cannot establish whether their effect committed, even when stdout is empty.
  const owned=mutation||opt.detach||job?.detached,execute=owned?foregroundCommand:spawnSync;
  const result = execute(argv[0], [...argv.slice(1), ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ORG_DIR: job?.org ?? opt.org },
    timeout:owned?0:Math.max(1,Math.min(120000,remaining??120000)),killSignal:'SIGTERM',
  });
  if (result.error || result.signal || result.status !== 0) {
    const error = new Error(`${argv[0]} ${args[0]}: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()}`);
    error.code=outcomeFailure({code:result.error?.code,receipt:result}).code;
    error.receipt = { status: result.status, signal: result.signal ?? null, stdout: result.stdout ?? '',
      stderr: result.stderr ?? '', ...(result.error ? { error: result.error.code ?? result.error.message } : {}) };
    if (mutation && (result.signal || result.error && !['ENOENT','ENOTDIR','EACCES','EPERM'].includes(result.error.code))) {
      error.code = 'DISPATCH_OUTCOME_UNKNOWN';
    }
    error.recordRefusal = !result.error && !result.signal && Number.isInteger(result.status) && result.status !== 0 &&
      result.stderr.trim().split('\n').at(-1).startsWith('record: ');
    if(argv===laneCLI&&!result.error&&!result.signal)try{
      const receipt=JSON.parse(result.stdout);
      if(receipt.code==='DISPATCH_INPUT_CHANGED')Object.assign(error,{code:receipt.code,launch_input:receipt.launch_input});
    }catch{/* Other native/command refusals keep their original evidence. */}
    throw error;
  }
  return result.stdout.trim();
}
const allocationEffect=operation=>{
  // Fixtures can shorten contention waits while retaining the real lock refusal.
  const waitMs=Number(process.env.HERDR_DISPATCH_RETIREMENT_WAIT_MS??60000);
  // Refuse a retirement of this exact allocation before taking the project
  // lock. Waiting on it with owner.lock held would block unrelated launches.
  const allocation=claimRetirementAllocation(job.common,`lane/${job.lane}`,{deadline:controllerDeadline});
  try{
    const release=claimRetirementOwner(job.common,{waitMs,deadline:controllerDeadline});
    try{return operation();}finally{release();}
  }finally{allocation();}
};
const recordCommand = args => command(recordCLI,args,undefined,args[0] !== 'show');
const record = args => ['start','worker'].includes(args[0]) ? allocationEffect(()=>recordCommand(args)) : recordCommand(args);
const identityState = () => fold(loadEvents(job?.org ?? opt.org).events);
const lane = args => ['open','prepare','dispatch'].includes(args[0]) ? allocationEffect(()=>command(laneCLI,args,undefined,true)) : command(laneCLI,args);
const git = (args, cwd) => command(['git'], args, cwd, args[0] === 'merge');
const json = (text) => { const value = JSON.parse(text); if (value.error) throw new Error(JSON.stringify(value.error)); return value.result ?? value; };
const refusal = (code, message) => Object.assign(new Error(message), { code });
const dispatchCodes = new Set(['REUSE_RUN_OPEN', 'REUSE_MISMATCH', 'REUSE_IDENTITY_UNKNOWN', 'REUSE_WORKER_BUSY',
  'FROM_RUN_OTHER_ITEM', 'FROM_RUN_SUPERSEDED', 'DISPATCH_FAILED', 'DISPATCH_STOPPED', 'DISPATCH_HOOK_REVIEW',
  'DISPATCH_UNLANDED_CAP', 'DISPATCH_UNBLOCKS_INVALID', 'DISPATCH_INPUT_CHANGED']);
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
const herdr = (args) => json(command(['herdr'], args, undefined, args[0] === 'agent' && args[1] === 'prompt'));
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
  if (job.resumeSession && agent?.agent_session?.value && agent.agent_session.value !== job.resumeSession)
    throw Error('resumed native conversation differs from the requested saved session');
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
  return { process: native, session: after.agent_session?.value, status: after.agent_status };
}
function captureLaunchProcess() {
  // Pin once alongside the original worker identity, before its receipt and
  // watcher. Recovery never replaces missing or old continuity evidence.
  job.launchProcess = null;
  try { job.launchProcess = observeNative().process; } catch {}
}
function admission(repo, org, common,kind=dispatchPool({job})) {
  const { config } = loadDiscoveredRoutes({ cwd: repo });
  const evidence = checkSessionCap({ config, org, common, agent: name => herdr(['agent', 'get', name]).agent,
    processInfo: pane => herdr(['pane', 'process-info', '--pane', pane]).process_info, excludeStartJournal: journal,excludePendingJournal:journal,kind });
  if (job) job.sessionCap = evidence;
  return evidence;
}
function unlandedAdmission(request, { requireLink = false } = {}) {
  const { config } = loadDiscoveredRoutes({ cwd: request.repo });
  return checkSourceAdmission({ config, org: request.org, common: request.common, request, requireLink });
}
function requestStarts(request = job) {
  return loadEvents(request.org).events.filter(event => event.type === 'run.started' && matchesDispatchStart(event, { ...request, journal }));
}
function originalUnclaimedStart(saved, run) {
  // A start can commit before its first claim does. This is continuation of
  // that exact pre-native request, never admission of arbitrary legacy work.
  if (run.owner || saved.stage !== 'starting' || saved.run !== run.id || saved.ownership ||
      !saved.release || saved.native_launch_attempted !== false || saved.worker || saved.launchProcess ||
      saved.sessionBinding || saved.watcher || run.report || run.abandoned ||
      ['agent', 'pane', 'worker_workspace', 'terminal_id', 'agent_session_id'].some(key => run.meta?.[key] != null)) return false;
  const starts = requestStarts(saved), start = starts[0];
  if (!(starts.length === 1 && start.id === run.id && start.meta.dispatch_record === saved.org &&
    start.meta.lane === saved.lane && start.meta.route === saved.route &&
    (start.meta.dispatch_from_run ?? null) === (saved.fromRun ?? null) &&
    (start.meta.dispatch_unblocks ?? null) === (saved.unblocks ?? null) &&
    Object.entries(saved.declared).every(([key, value]) => (start.meta[key] ?? null) === value) &&
    run.item === saved.item)) return false;
  try {
    return fs.realpathSync(start.workspace) === fs.realpathSync(saved.workspace) &&
      fs.realpathSync(run.workspace) === fs.realpathSync(saved.workspace);
  } catch { return false; }
}
function retryCommand(error) {
  // Terminal refusals retain their evidence without actionable retry advice.
  if (error && (['RUN_OWNED_ELSEWHERE','DISPATCH_OUTCOME_UNKNOWN','DISPATCH_LANE_OCCUPIED'].includes(error.code) ||
      /^(?:RUN_OWNED_ELSEWHERE:|original dispatch was terminally abandoned;|run is already abandoned or reported;|resume launch\/delivery outcome must be retained;)/.test(error.message))) return undefined;
  return [process.execPath, local('./dispatch.mjs'), '--repo', job.repo, '--org', job.org,
    ...invocationFlags(), '--retry', job.run ?? journal].map(quote).join(' ');
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
  const prompted = job.resumeDeliveryProtocol ? Date.parse(job.resumeDelivery.started_at) : Date.now();
  job.sessionBinding = { status: 'observing', process: binding ? binding.process : job.launchProcess ?? null, receipt,
    prompted_at: new Date(prompted).toISOString(), deadline: new Date(prompted + 60000).toISOString() };
}
async function bindSession() {
  const binding = job.sessionBinding;
  if (!binding || binding.record_refusal || binding.status === 'bound' ||
      binding.status === 'unbound' && (!opt.retry || !binding.proposed)) return;
  // Only explicit retry reopens an unbound saved proposal. Automatic replay
  // still selects observing proposals, and a recorded refusal stays final.
  if (binding.status === 'unbound') { binding.status = 'observing'; save(); }
  // An exact saved proposal may be retried after the deadline. Observation may not.
  observationDeadline = binding.proposed ? undefined : Date.parse(binding.deadline);
  try {
    await observeSessionBinding({ job: { ...job, journal }, save, observe: observeNative,
      qualify: job.resumeDeliveryProtocol ? seen => {
        const receipt = observeResumeDelivery(job.resumeDelivery, job.worker.agentName);
        if (!receipt) return null;
        if (seen.session && seen.session !== receipt.session) throw Error('native and transcript session identities differ');
        job.resumeDelivery.receipt = receipt; save();
        return receipt.session;
      } : undefined,
      record: () => {
        // Only observations use the launch-window timeout. The writer checks
        // the saved observation against its original window under the lock.
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
  const held=lockRequest(journal);lock=held.lock;contender=held.contender;ownsLock=true;
}
function ensureWatcher() {
  if (!job.watcher) {
    // Fresh workers select their recipient after recording. New resumes pin
    // their proposed native name and supervisor before command-line delivery.
    job.to ??= job.worker.agentName;
    save();
    job.watcher = json(command(watchCLI, [job.run, '--controller', opt.controller, '--org', job.org, '--to', job.to,
      '--cwd', job.repo, ...(job.resumeDeliveryProtocol ? ['--agent', job.resumeDelivery.agentName] : []), ...(job.watchMode==='shared'?['--shared']:['--detach', '--log', path.join(job.org, 'dispatch', `${job.run}.watch.log`)]),
      ...(opt['org-cli'] ? ['--org-cli', opt['org-cli']] : []),...(job.recordOnlyNotices?['--record-only']:[])], undefined, true));
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
}
function workPrompt(run, workerName = job.worker.agentName) {
  const validation = job.reviewQueue ? 'Independent code/evidence review: zero build, test, prepare, install or check commands; zero reviewer suites. Preserve inherited producer evidence and never label an unrun check PASS.' : `Run only the ask's or explicit --extra scope's focused check selection once through ${JSON.stringify(process.execPath)} ${JSON.stringify(local('../lanes/lane.mjs'))} check --cmd 'COMMAND' on the clean committed candidate before reporting, using the existing project runner and preserving file groups and limits. When checks run, this writes .lane/gate.json and the shared lane-validation receipt with command, exit status, TAP totals and Node version for settle to inherit. If no check is selected or applicable, report the selection/scope and unrun truth; do not substitute a blanket default/fast/npm suite or label unrun checks PASS. Do not add a tier run or repeat tests solely to create a receipt. Self-land finished source without a test/review readiness gate; the one full final-release obligation stays with its release coordinator.`;
  job.exceptionAddress ??= projectExceptionAddress(job.repo, JSON.parse(fs.readFileSync(job.routeConfig, 'utf8')), job.route);
  const exception = job.exceptionAddress.to ? `your PROJECT SUPERVISOR at ${JSON.stringify(job.exceptionAddress.to)}`
    : 'your PROJECT SUPERVISOR; its project-specific exception address is UNKNOWN, so report that missing address without inventing a recipient';
  const reviewDirection = job.reviewQueue ? 'Review only the captured immutable diff/evidence; no source edits, landing, tests or second review.' : job.reviewQueueProtocol ? 'Hand the immutable landed base/head and producer evidence through your report to the single record queue-review path; the line service creates/dispatches the one review item. Never start a parallel settle/lane review, wait for a verdict to land, or replace an existing/UNKNOWN attempt.' : 'Start ONE independent async post-code review through the existing route, zero reviewer suites; do not wait for its verdict to land.';
  const owner = `Your recorded worker agent is ${workerName}; the existing report watcher targets ${job.to}. Retain that watcher. ${job.reviewQueue ? '' : 'Self-land your own finished committed source through lane promote under the current operator waiver, with clean worktree/rebase/FF and native identity/claim/source/CAS/STOP/HOLD safety. '}${reviewDirection} Use --to ${workerName} for your ordinary settle/queued-promotion notices and existing prompt delivery for review completion. Own the correction/fix-forward and report actual receipts once. Route actual unsafe/native/identity/ownership/reserved/failed exceptions to ${exception}; never invoke supervisor cycle mutations or borrow supervisor identity.`;
  // New requests pin their producer command. Older saved jobs/prompts retain
  // their original behavior rather than receiving a retroactive instruction.
  const wording = job.operatorPlainText ? ` --happened '<what happened in plain words>' --action '<what you need to do, usually Nothing needed.>' --details ${quote(`${job.item}; ${job.run}; technical references`)}` : '';
  const composition = job.operatorPlainText ? ' EVERY message addressed to the operator must read naturally: one-line headline, what happened, whether you need to do anything, then ONE trailing Details line. Author the main text for a non-agent reader; bare item/run IDs, hashes, receipt/source jargon and shorthand such as bootstrap5 or record-only belong only in Details. A pending reserved decision must say a decision is needed, never Nothing needed. Internal agent coordination and owned callbacks keep their technical contracts.' : '';
  const producer = job.operatorRecordCommand ? `For OPERATOR-addressed status/fyi/done/questions, store an envelope in the owning record with this explicit source command: ${job.operatorRecordRoot ? `HERDR_BRAIN_ROOT=${quote(job.operatorRecordRoot)} ` : ''}ORG_DIR=${quote(job.org)} ORG_ACTOR=${quote(workerName)} ${job.operatorRecordCommand.map(quote).join(' ')} messages send --id ${quote(`${job.run}:operator:STABLE_NOTICE_ID`)} --kind notice --run ${quote(job.run)} --item ${quote(job.item)} --summary '<one-line summary>'${wording}. Reuse the stable ID for a retry; use kind fyi for fyi and question/request for judgment, with --correlation THREAD and --reply-to ID when applicable. Pull messages digest on demand with the same source command. Ordinary OPERATOR-addressed messages are record-only and never typed into an operator pane. Only an actual pending human question already explicitly operator_reserved in the record, referenced with --question HUM-n, pushes once through the existing native inbox and Brain Chat filtering. Routine T2 questions do not become reserved. Internal owned report/watch callbacks and project T2/BrainChat delivery retain their existing native paths and recipients; retain the watcher. Do not fabricate native bindings or change pins, saved jobs or long-lived sessions.${composition}` : '';
  return job.workerBrief ? lineWorkerPrompt({ job: { ...job, worker: { ...job.worker, agentName: workerName } }, run, brief: fs.readFileSync(run.brief_path, 'utf8'), producer, node: process.execPath, laneCLI: local('../lanes/lane.mjs') })
    : `You are run ${job.run} on org item ${job.item}. Read ${job.brief} (the ask) and ${run.brief_path} (the record context and report template), then do the work. Write the report to ${run.report_path}; the report's run field is ${job.run}.\n\n${owner}${producer ? `\n\n${producer}` : ''}\n\n${validation}${job.reviewQueueBrief ? `\n\n${job.reviewQueueBrief}` : ''}${job.extra ? `\n\n${job.extra}` : ''}`;
}
async function main() {
  if(opt['resolve-not-started']){
    if(positionals.length||opt.retry||opt.detach||opt.status)throw Error('not-started resolution never dispatches or retries');
    const {resolveNotStarted}=await import('./not-started.mjs');
    const result=resolveNotStarted({repo:opt.repo,org:opt.org??findOrgDir({cwd:opt.repo}),journal:opt['resolve-not-started'],disposition:opt.disposition,decisionSeq:Number(opt['decision-seq']),id:opt.id,changedSource:opt['changed-source'],role:opt.role});
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
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
  if((opt.abandon||opt['abandon-reason'])&&(!opt.retry||!opt.abandon||!opt['abandon-reason']?.trim()))throw Error('authorized abandonment requires --retry --abandon --abandon-reason TEXT');
  if (opt.retry) {
    if (positionals.length || ['lane', 'route', 'brief', 'report', 'reuse', 'resume-session', 'base', 'extra', 'awaited', 'awaited-step', 'unblocks'].some((key) => opt[key] !== undefined)) {
      throw new Error('--retry uses the saved request; do not supply new work flags');
    }
    journal = locate(opt.retry);
    lockJob();
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (saved.org !== fs.realpathSync(opt.org)) throw new Error('retry belongs to a different record');
    // New journals retain their original command selection. Older requests keep
    // their existing explicit-flag/default behavior; never backfill their bytes.
    for (const key of invocationKeys) {
      if (saved.invocation && opt[key] !== undefined && opt[key] !== saved.invocation[key])
        throw new Error(`--retry cannot replace saved --${key}`);
      opt[key] ??= saved.invocation?.[key];
    }
    opt.controller ??= BRAIN_CONTROLLER;
    recordCLI = cli('org', '../bin/org.mjs');
    laneCLI = cli('lane', '../lanes/lane.mjs');
    watchCLI = cli('watch', '../watch/watch.mjs');
    // Refuse before admission, recovery or stage effects. Assigning job would
    // also let the failure handler mutate this retained request and completion.
    if (opt.abandon && ['open', 'start', 'starting'].includes(saved.stage))
      throw Error(`terminal abandonment refuses saved ${saved.stage} request; retain original allocation/start evidence`);
    if(resolvedNotStarted({events:loadEvents(saved.org).events,org:saved.org,common:saved.common,journal}))throw Error('original request archived NOT STARTED; never retry it; only the existing line may use its changed input');
    // A consumed proof still governs delivery after interruption. The saved
    // request and immutable archive, rather than an optional flag, select it.
    if(saved.reviewQueue||saved.reviewContinuations?.length||opt['continue-review'])reviewContinuation=originalReviewContinuation(saved);
    if(reviewContinuation&&(opt.detach||opt['continue-preflight']||opt.adopt||opt.fresh||opt.resend||opt['accept-delivered']||opt['recover-run']||opt['from-run']))throw Error('original review continuation cannot change launch or delivery recovery');
    if(opt['continue-preflight']){
      preflight=preflightContinuation({journal,repo:saved.repo,org:saved.org,common:saved.common,root:bundleRelease().root,events:loadEvents(saved.org).events});
      if(!preflight)throw Error('original preflight has no positive original prelaunch continuation; retain unknown/native/foreign/spent request');
    }
    const boundRun = saved.run ?? saved.fromRun;
    const owned = boundRun && readOwnedRun(saved.org, boundRun);
    if (owned && !originalUnclaimedStart(saved, owned)) {
      const binding = requireController(owned, opt.controller);
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
    if(job.terminal_abandonment&&!opt.abandon)throw Error('original dispatch was terminally abandoned; no launch or prompt retry');
    if (job.resumeDeliveryProtocol && (opt.fresh || opt.adopt || opt.resend || opt['accept-delivered']))
      throw Error('resume launch/delivery outcome must be retained; no replacement, adoption, confirmation or resend');
    if (opt['from-run'] !== undefined) {
      if (job.fromRun && job.fromRun !== opt['from-run']) throw new Error('--from-run cannot replace the saved origin');
      checkOrigin(opt['from-run'], json(record(['show', job.item, '--json'])), !job.run && job.stage !== 'starting');
      job.fromRun = opt['from-run'];
      job.predecessor ??= { run: job.fromRun, binding: requireController(readOwnedRun(job.org, job.fromRun), opt.controller) };
    }
  } else {
    opt.controller ??= BRAIN_CONTROLLER;
    if(opt['continue-review'])throw Error('--continue-review requires the original --retry journal');
    if(opt['continue-preflight'])throw Error('--continue-preflight requires the original --retry journal');
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
    if (opt.reuse) throw refusal('REUSE_REMOVED', 'new work starts fresh; use --resume-session UUID through the ai identity wrapper to resume saved context in a fresh allocation');
    if (positionals.length !== 1 || !opt.lane || !opt.route || !opt.brief) throw new Error('usage: dispatch.mjs ITEM --org DIR --lane TOPIC --route ROUTE --brief FILE [--report FILE] [--to AGENT] [--base REF] [--reuse R-n] [--extra TEXT] | --retry R-n|JOURNAL | --status R-n|JOURNAL');
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(opt.lane)) throw new Error('lane must be short kebab-case');
    const repo = fs.realpathSync(path.resolve(opt.repo));
    const org = fs.realpathSync(path.resolve(opt.org));
    const brief = fs.realpathSync(path.resolve(opt.brief));
    if (!fs.statSync(brief).isFile() || !fs.readFileSync(brief, 'utf8').trim()) throw new Error('brief must be a nonempty file');
    // Validate item, target and launch route before opening a lane or starting a run.
    const item = json(record(['show', positionals[0], '--json']));
    if (Object.hasOwn(item, 'item') || !Array.isArray(item.runs)) throw new Error('dispatch ITEM must be an item, not a run');
    const existingLanes = new Set(git(['for-each-ref', '--format=%(refname)', 'refs/heads/lane/'], repo).split('\n'));
    opt.lane = dispatchLaneName(opt.lane, item.id, { existing: Boolean(opt['resume-session']) || existingLanes.has(`refs/heads/lane/${opt.lane}`) });
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
    if (reviewQueue && opt.route !== reviewQueueRoute(config, item, fold(loadEvents(org).events))) throw Error('queued review must use the normal reviewer route');
    const declared = resolveRoute(config, { route: opt.route });
    resolveLaunchRoute(config, { route: opt.route });
    if (opt['resume-session']) resumeSessionArguments(resolveLaunchRoute(config, { route: opt.route }), opt['resume-session']);
    const correction = correctionSource({ item, state: fold(loadEvents(org).events), events: loadEvents(org).events, repo, org });
    if (correction && opt.base && git(['rev-parse', `${opt.base}^{commit}`], repo) !== correction.base) throw Error('fix base differs from actual saved author branch or main');
    const declaredFields = { harness: declared.kind, model: declared.model ?? null, effort: declared.effort ?? null };
    const exceptionAddress = projectExceptionAddress(repo, config, opt.route);
    const resume = opt['resume-session'] ? resumeSource({ events: loadEvents(org).events,
      session: opt['resume-session'], item, lane: opt.lane, harness: declared.kind, repo }) : null;
    if (resume && (!exceptionAddress.to || opt.to && opt.to !== exceptionAddress.to))
      throw Error('resume requires its configured project supervisor as watcher recipient');
    if (resume && opt.base && git(['rev-parse', `${opt.base}^{commit}`], repo) !== resume.base)
      throw Error('resume base differs from the saved branch or main');
    const workerBrief = opt.detach ? createWorkerBrief({ item, ask: brief, askText: fs.readFileSync(brief, 'utf8'), extra: opt.extra,
      project: repo, org, lane: opt.lane, route: opt.route, harness: declared.kind,
      reviewRoute: reviewQueue ? opt.route : reviewQueueRoute(config), exception: exceptionAddress }) : undefined;
    if (opt.reuse) checkReuse(json(record(['show', opt.reuse, '--json'])), { lane: opt.lane, route: opt.route, declared: declaredFields });
    const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo));
    unlandedAdmission({ repo, org, common, item: item.id, fromRun: opt['from-run'], unblocks: opt.unblocks });
    if (!opt.reuse) admission(repo, org, common,dispatchPool({item,job:{reviewQueue}}));
    const token = randomUUID();
    const directory = path.join(org, 'dispatch');
    fs.mkdirSync(directory, { recursive: true });
    journal = path.join(directory, `${token}.json`);
    const actual=bundleRelease(),runtimeHome=path.dirname(path.dirname(actual.root));
    const probation=actual.commit?probationRuntime(repo,{root:actual.root,home:runtimeHome})?.probation:undefined;
    if(actual.commit&&!probation)requireReadyAcceptance(checkRelease(runtimeHome,actual.id),runtimeHome);
    job = { token, repo, org, common, predecessor, release: bundleRelease(), sourceSelection: sourceSelection ?? null,...(probation?{probation}:{}),
      invocation: invocation(), watchMode:opt['watch-mode']??'process', workerSessionWaitProtocol: 1,
      operatorRecordCommand: [process.execPath, local('../bin/org.mjs')],
      operatorRecordRoot: bundleRelease().root,
      operatorPlainText: true,
      item: positionals[0], lane: opt.lane, route: opt.route, reviewQueueProtocol: 1,
      ...(reviewQueue ? { reviewQueue, reviewQueueBrief: reviewQueueBrief(item) } : {}),
      ...(dispatchPool({item})==='decision'?{decisionQueue:{key:item.meta.decision_request?.key}}:{}),
      brief, report: opt.report ?? null, to: opt.to ?? (resume ? exceptionAddress.to : null),
      base: git(['rev-parse', `${resume?.base ?? correction?.base ?? opt.base ?? 'HEAD'}^{commit}`], repo), extra: [opt.extra, correction?.brief].filter(Boolean).join('\n\n'), reuse: null, resumeSession: opt['resume-session'] ?? null,
      ...(resume ? { resume, resumeDeliveryProtocol: 1 } : {}),
      ...(correction ? { correction, correctionLaunchProtocol: 1 } : {}), fromRun: opt['from-run'] ?? null, unblocks: opt.unblocks ?? null,
      declared: declaredFields, exceptionAddress, ...(workerBrief ? { workerBrief } : {}),
      stage: 'open', run: null,native_launch_attempted:false,completion_protocol:1,...(opt.detach?{phase1_protocol:1,detachedRequested:true}:{}) };
    // Only routing fields are frozen. Lifecycle paths keep their original config provenance.
    job.routeConfig = path.join(directory, `${token}.routes.json`);
    atomic(job.routeConfig, mergeRoutesConfig([config]));
    if(reviewQueue)reserveUnstartedReview({org,repo,journal,job});
    if (opt.awaited) record(['set', job.item, 'meta.notify=supervisor', ...(opt['awaited-step'] ? [`meta.notify_step=${opt['awaited-step']}`] : [])]);
    save();
    lockJob();
  }
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (common !== job.common) throw new Error('repository common-directory identity changed');
  if (!job.reuse && (['open', 'start', 'starting', 'worker'].includes(job.stage) ||
      (job.stage === 'launching' && opt.fresh))) admission(job.repo, job.org, common);
  const stop = path.join(gitProject(job.repo).canonical, '.lane/supervisor/STOP');
  const checkStop = ({boundary='launch'}={}) => {
    if(Date.now()>=controllerDeadline)throw Object.assign(Error('detached controller command budget exhausted; original journal retained'),{code:'DISPATCH_CONTROLLER_DEADLINE'});
    if (fs.existsSync(stop) || fs.existsSync(path.join(path.dirname(stop), 'HOLD'))) {
      const error = new Error('Supervisor STOP appeared before dispatch; no new worker launched');
      error.code = 'DISPATCH_STOPPED';
      throw error;
    }
    if((job.detached||job.detachedRequested)&&fs.existsSync(path.join(job.org,'line-service',
      createHash('sha256').update(JSON.stringify(job.common)).digest('hex').slice(0,20),'STOP')))throw Object.assign(Error('service STOP appeared before detached effect'),{code:'DISPATCH_STOPPED'});
    checkDispatchEligibility(job,journal,{boundary});
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
  if(reviewContinuation){
    checkStop();const fresh=originalReviewContinuation(job);
    if(fresh.seq!==reviewContinuation.seq)throw Error('original continuation proof changed');
    if(git(['status','--porcelain=v1'],job.workspace))throw Error('original review continuation worktree is dirty');
    if(job.worker)checkReviewContinuationNative();
    if(!job.reviewContinuations?.some(c=>c.original_prestart_seq===fresh.seq)){
      job.reviewContinuations=[...(job.reviewContinuations??[]),{original_prestart_seq:fresh.seq,request_sha256:fresh.request_sha256,kind:fresh.kind}];save();
    }
  }
  if(opt.detach||opt['continue-preflight']){
    if(!preflight&&(opt.retry||job.stage!=='open'||job.detached))throw Error('--detach is only for one new frozen request; never resubmit a saved launch');
    const release=acquireSessionCapLock(common,{check:checkStop});
    try{
      const events=loadEvents(job.org).events,state=fold(events),input=dispatchInput({events,state,item:state.items.get(job.item),org:job.org,identity:job.common});
      if(!input||job.lineInput&&job.lineInput!==input)throw Error('detached start needs unchanged ready work or genuinely changed blocked input');
      if(preflight){const fresh=preflightContinuation({journal,repo:job.repo,org:job.org,common,root:bundleRelease().root,events});
        if(!fresh||fresh.request_sha256!==preflight.request_sha256||fresh.capability!==preflight.capability)throw Error('original preflight evidence changed before continuation');
        job.preflightContinuations=[...(job.preflightContinuations??[]),{at:new Date().toISOString(),capability:fresh.capability,request_sha256:fresh.original_prestart?.request_sha256??fresh.request_sha256,terminal_sha256:fresh.terminal_sha256,prior_error:job.error,native_launch_attempted:fresh.native_launch_attempted,...(fresh.original_prestart?{original_prestart_seq:fresh.original_prestart.seq}:{})}];
        delete job.error;delete job.failure;job.detached_refused=false;if(!fresh.original_prestart)job.native_launch_attempted=false;}
      job.lineInput=input;admission(job.repo,job.org,common);checkStop();job.detached=true;job.recordOnlyNotices=true;job.phase1_protocol=1;save();
    }finally{release();}
    // Durable original request precedes spawn. The child takes the SAME request
    // lock; a lost spawn result is retained and never automatically relaunched.
    const output=fs.openSync(`${journal}.driver.log`,'a',0o600);
    try{
      if(!ownsLock||fs.readFileSync(lock,'utf8')!==String(process.pid))throw Error('detached request ownership changed before handoff');
      fs.unlinkSync(lock);ownsLock=false;if(contender){fs.unlinkSync(contender);contender=null;}
      const args=[local('../dispatch/dispatch.mjs'),'--retry',journal,'--repo',job.repo,'--org',job.org,...invocationFlags()];
      const child=spawn(process.execPath,args,{cwd:job.repo,env:process.env,detached:true,stdio:['ignore',output,output]});child.on('error',e=>fs.appendFileSync(`${journal}.driver.log`,`${e.message}\n`));child.unref();
      fs.mkdirSync(`${journal}.driver`,{recursive:true});
      const launch={pid:child.pid??null,at:new Date().toISOString(),journal,command_limit_ms:null,controller_budget_ms:null,stop_policy:'measured no-output AND confirmed no-activity; unknown retained',...(preflight?{continuation:preflight.capability}:{})};
      if(preflight)fs.appendFileSync(`${journal}.driver/continuations.jsonl`,JSON.stringify(launch)+'\n',{mode:0o600});
      else fs.writeFileSync(`${journal}.driver/launch.json`,JSON.stringify(launch)+'\n',{flag:'wx',mode:0o600});
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
    if (!worktree()) lane(['open', job.lane, ...(job.base ? [job.base] : []), '--git-only',
      ...(job.resume ? ['--reopen-at', job.resume.workspace] : [])]);
    job.workspace = fs.realpathSync(worktree());
    if (job.resume && job.workspace !== job.resume.workspace) throw Error('resumed worktree differs from the saved session path');
    // prepare validates that the registered lane is owned by this repository.
    lane(['prepare', job.lane]);
    if (job.base) {
      if (git(['status', '--porcelain=v1'], job.workspace)) throw new Error('base fast-forward requires a clean lane');
      allocationEffect(()=>git(['merge', '--ff-only', '--no-edit', '--', job.base], job.workspace));
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
      throw refusal('DISPATCH_OUTCOME_UNKNOWN', 'record start outcome is unknown or has multiple matches; inspect record and use --recover-run R-n');
    }
  }
  if (job.stage === 'start') {
    if (job.workerBrief) {
      job.workerBrief.workspace = job.workspace;
      validateWorkerBrief(job.workerBrief, { execution: true });
    }
    if (job.fromRun) checkOrigin(job.fromRun, json(record(['show', job.item, '--json'])));
    if (job.reuse) checkReuse(json(record(['show', job.reuse, '--json'])), job);
    // Save the pending start's item/exception reservation before spawning its
    // writer; it survives coordinator death until a recorded start replaces it.
    // Reuse shares this admission too. Never hold the project lock over memory
    // waits; session launch takes the same lock again for its independent cap.
    releaseAdmission = acquireSessionCapLock(common, { check: checkStop });
    // Two dispatchers can pass early admission together. Re-read ownership
    // after taking the shared start lock, before either can append a new run.
    checkStop();
    job.unlandedCap = unlandedAdmission(job);
    if (job.unblocks) {
      record(['block', job.unblocks, '--by', job.item]);
      job.unlandedCap = unlandedAdmission(job, { requireLink: true });
    }
    delete job.startRefused;
    // Custom record CLIs retain their synchronous contract. Save this choice
    // before invoking the writer so recovery uses the original protocol.
    if (!opt['org-cli']) job.startPreparation = { status: 'pending' };
    job.stage = 'starting'; save();
    let output;
    try { output = record(['start', job.item, '--route', job.route, '--route-config', job.routeConfig,
      '--workspace', job.workspace, '--meta', `lane=${job.lane}`, '--meta', `dispatch_journal=${journal}`,
      ...(job.startPreparation ? ['--defer-preparation'] : []),
      '--meta', `dispatch_attempt=${job.token}`, '--meta', `dispatch_project=${job.common}`, '--meta', `dispatch_record=${job.org}`,
      '--meta', `dispatch_unlanded_admitted=${job.unlandedCap.admission.admitted}`,
      ...(job.workerBrief ? ['--meta', `worker_brief=${JSON.stringify(job.workerBrief)}`] : []),
      ...(['review','decision'].includes(job.unlandedCap.admission.kind) ? ['--meta', `dispatch_role=${job.unlandedCap.admission.kind}`] : []),
      ...(job.fromRun ? ['--meta', `dispatch_from_run=${job.fromRun}`] : []),
      ...(job.unblocks ? ['--meta', `dispatch_unblocks=${job.unblocks}`] : []),
      ...(!['regular', 'review','decision'].includes(job.unlandedCap.admission.kind) ? ['--meta', `dispatch_unlanded_exception=${job.unlandedCap.admission.kind}`] : []),
      ...(job.fromRun ? ['--if-current-run', job.fromRun] : []),
      ...(job.reuse ? ['--meta', `continuation_of=${job.reuse}`, '--meta', 'same_session=true'] : []),
      ...(job.report ? ['--report', path.resolve(job.workspace, job.report)] : [])]); }
    catch (error) {
      // A nonzero exit can follow run.started (brief/report preparation happens
      // after append). Only a successful readback with no match can establish
      // that a record refusal did not commit this request's start.
      let starts;
      try { starts = requestStarts(); }
      catch (readbackError) { error.message += `; start readback unavailable: ${readbackError.message}`; }
      if (!starts || starts.length) {
        error.code = 'DISPATCH_OUTCOME_UNKNOWN';
        error.recordRefusal = false;
      }
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
  if(opt.abandon){
    if(run.report)throw Error('reported dispatch needs no abandonment');
    if(!job.terminal_abandonment){
      if(run.abandoned)throw Error('abandonment belongs to another producer; retain its evidence');
      const zero=job.stage==='worker'&&job.native_launch_attempted===false&&!job.worker&&!job.launchProcess&&!job.sessionBinding;
      const unprompted=['watch','prompt'].includes(job.stage)&&job.worker?.agentSessionId&&job.launchProcess?.identity&&!job.sessionBinding;
      if(!zero&&!unprompted)throw Error('terminal abandonment requires original positive never-started or bound unprompted proof; UNKNOWN is retained');
      let proof={kind:'original-pre-native-terminal'};
      if(unprompted){const seen=observeNative();
        if(!['idle','done'].includes(seen.status)||seen.session!==job.worker.agentSessionId||seen.process.pid!==job.launchProcess.pid||seen.process.identity!==job.launchProcess.identity)
          throw Error('original unprompted native allocation changed or working; abandonment refused');
        proof={kind:'original-unprompted-terminal',native:seen,worker:job.worker};}
      job.terminal_abandonment={reason:opt['abandon-reason'],authorized_by:'explicit-original-dispatch-abandon',proof};save();
    }
    recordDispatchCompletion({job,journal,exitCode:1});completionAttempted=true;
    process.stdout.write(JSON.stringify({result:'abandoned',run:job.run,item:job.item,journal})+'\n');return;
  }
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
  // The start/retirement admission locks have been released. Preparation has
  // its own saved status and may resume on this run without replaying start.
  if (job.startPreparation?.status === 'pending') {
    record(['brief', job.run, '--prepare-start']);
    job.startPreparation.status = 'complete'; save();
  } else if (!fs.existsSync(run.brief_path)) record(['brief', job.run]);
  if (job.workerBrief && job.native_launch_attempted === false && !job.worker) {
    const original = fs.readFileSync(run.brief_path, 'utf8');
    const compatible = compatibleLineBrief({ job, run, brief: original });
    if (compatible !== original) {
      fenceOwner(job.org, job.run, job.ownership, () => {
        const archive = run.brief_path + '.pre-contract.md';
        if (!fs.existsSync(archive)) fs.writeFileSync(archive, original, {flag:'wx',mode:0o600});
        writeFileAtomic(run.brief_path, compatible, 0o600);
      });
    }
  }
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
      if (job.workerBrief) validateLineExecution({ job, run, brief: fs.readFileSync(run.brief_path, 'utf8') });
      if (job.resumeDeliveryProtocol) {
        if (!job.resumeDelivery) {
          const marker = `__BRAIN_RESUME_WORKER_${job.token}__`;
          const route = resolveLaunchRoute(JSON.parse(fs.readFileSync(job.routeConfig, 'utf8')), { route: job.route });
          job.resumeDelivery = prepareResumeDelivery({ route, session: job.resumeSession, workspace: job.workspace,
            template: workPrompt(run, marker), marker });
          job.resumeDelivery.agentName = `resume-${job.token.replaceAll('-', '').slice(0, 24)}`;
          save();
        }
        ensureWatcher();
      }
      job.stage = 'launching'; save();
      job.native_launch_attempted=true;save();
      const output = lane(['dispatch', job.lane, '--route', job.route, '--route-config', job.routeConfig, '--json', '--memory-checked',
        '--dispatch-journal',journal,'--dispatch-sha256',launchDigest(fs.readFileSync(journal)),
        ...(job.reviewQueue ? ['--expected-head',job.reviewQueue.head] : [])]);
      const launched = JSON.parse(output);
      if (launched.result === 'stopped') {
        job.stage = 'worker'; save();
        const error = new Error(launched.reason);
        error.code = 'DISPATCH_STOPPED';
        throw error;
      }
      job.worker = json(output);
      if (job.resumeDeliveryProtocol) {
        if (job.worker.agentName !== job.resumeDelivery.agentName) throw Error('resumed worker differs from its proposed launch name');
        job.resumeDelivery.native_session_at_launch = job.worker.agentSessionId;
        // A launch identity is diagnostic until fresh transcript delivery qualifies it.
        job.worker.agentSessionId = null;
      }
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
    note(`worker ${worker.agentName} in ${worker.pane} recorded; ${job.resumeDeliveryProtocol ? 'task submitted on resume command line' : 'prompt not sent'}`);
    job.stage = 'watch'; save();
  }
  if (job.stage === 'watch' || job.stage === 'prompting' || job.stage === 'prompt' || job.stage === 'complete') {
    liveWorker(job.worker);
    // Re-arm only through watch's exclusive per-run lock. It refuses duplicates.
    ensureWatcher();
    if (job.stage === 'watch') note(`watcher ready (pid ${job.watcher.pid}); ${job.resumeDeliveryProtocol ? 'resume task awaiting transcript qualification' : 'prompt not sent'}`);
    if (job.stage === 'watch' && job.resumeDeliveryProtocol) {
      prepareSessionBinding(run);
      job.stage = 'complete'; save();
    }
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
      const prompt = workPrompt(run);
      // A guard refusal here proves the prompt was never sent; keep stage
      // 'prompt' so the line can positively finalize the unprompted worker.
      checkReviewContinuationNative();
      checkStop({boundary:'prompt'});
      prepareSessionBinding(run);
      job.stage = 'prompting'; save();
      herdr(['agent', 'prompt', job.worker.agentName, prompt]);
      job.stage = 'complete'; save();
      note(`prompt sent; worker ${job.worker.agentName} and watcher ${job.watcher.pid} started`);
    }
  }
  await bindSession();
  delete job.error;delete job.failure; save();
  outputReceipt();
}
function outputReceipt(pending) {
  // Publish before returning success. Exhausted publication is bookkeeping
  // still pending on this same launch, never a failed start for callers to redo.
  completionAttempted = true;
  try { recordDispatchCompletion({ job, journal, exitCode: 0 }); }
  catch (error) {
    pending ??= { reason: error.message };
    process.stderr.write(`dispatch: completion status could not be recorded: ${error.message}\n`);
  }
  const completion = pending ? { status: 'pending', ...pending, retry: `node dispatch/dispatch.mjs --retry ${job.run}` } : undefined;
  const binding = job.sessionBinding?.proposed && job.sessionBinding.status === 'observing'
    ? { status: 'unknown', retry: `node dispatch/dispatch.mjs --retry ${job.run}` }
    : { status: job.sessionBinding?.status ?? (job.worker.agentSessionId ? 'recorded' : 'unbound') };
  process.stdout.write(`${JSON.stringify({ run: job.run, item: job.item, lane: job.lane, route: job.route, ...job.declared,
    agent: job.worker.agentName, pane: job.worker.pane, watcher: job.watcher, journal, binding, legacy: job.unlandedCap?.legacy,
    ...(completion ? { result: 'launched', completion } : {}) })}\n`);
}
try { await main(); }
catch (error) {
  if (job?.stage === 'complete' && ownsLock && sourceConflict(error) && !error.dispatchJournalEffectStarted) {
    process.stderr.write(`dispatch: launch delivered; completion pending: ${error.message}\nrequest: ${journal}\n`);
    outputReceipt({ reason: error.message });
  } else {
    const retry = job && journal && ownsLock ? retryCommand(error) : undefined;
    const receipt = error.receipt ?? job?.failure?.receipt ?? null;
    const readback = error.code === 'DISPATCH_OUTCOME_UNKNOWN' ? {
      hint: 'Inspect the original journal and record before any continuation; never redispatch, replay or replace this attempt.',
      journal: [process.execPath, local('./dispatch.mjs'), '--repo', job.repo, '--org', job.org, '--status', journal].map(quote).join(' '),
      record: `ORG_DIR=${quote(job.org)} ${[...recordCLI, 'show', job.run ?? job.item, '--json'].map(quote).join(' ')}`,
      org: job.org,
      ...(job.stage === 'starting' && job.native_launch_attempted === false ? { start_recovery: {
        condition: 'The original command has exited, and readback confirms exactly one current matching committed start with no native launch. A run can be recorded open without a pane.',
        action: 'Resume only this original journal to claim that recorded run and launch its worker; do not issue a new dispatch. Missing or ambiguous starts require project supervisor inspection.',
        command: [process.execPath, local('./dispatch.mjs'), '--repo', job.repo, '--org', job.org, ...invocationFlags(), '--retry', journal].map(quote).join(' '),
      } } : {}),
    } : undefined;
    if (job && journal && ownsLock) {
      job.error = error.message;
      job.failure={...outcomeFailure(error),kind:['DISPATCH_SESSION_CAP','DISPATCH_REVIEW_CAP','DISPATCH_DECISION_CAP'].includes(error.code)?'capacity':outcomeFailure(error).kind,stage:job.stage,observed_at:new Date().toISOString(),native_launch_attempted:job.native_launch_attempted??null,...(error.sessions?{capacity:error.sessions}:{}),...(error.launch_input?{launch_input:error.launch_input}:{})};
      if (readback) Object.assign(job.failure, { code: 'DISPATCH_OUTCOME_UNKNOWN', kind: 'unknown', receipt, readback });
      if (error.occupied) job.failure.occupied = error.occupied;
      if(job.detached&&!job.native_launch_attempted&&!job.worker&&!['starting','launching','prompting'].includes(job.stage))job.detached_refused=true;
      save();
      if (job.run) try { note(`incomplete at ${job.stage}: ${error.message}${retry ? `; retry with ${retry}` : ''}`); } catch {}
    }
    process.stderr.write(`dispatch: ${error.message}${journal ? `\nrequest: ${journal}` : ''}${retry ? `\nretry: ${retry}` : ''}\n`);
    if (readback) {
      process.stdout.write(`${JSON.stringify({ result: 'unknown', code: error.code, reason: error.message,
        run: job.run, item: job.item, stage: job.stage, native_launch_attempted: job.native_launch_attempted ?? null, journal, receipt, readback })}\n`);
      process.exitCode = 1;
    } else if (error.code === 'DISPATCH_LANE_OCCUPIED') {
      process.stdout.write(`${JSON.stringify({ result: 'blocked', code: error.code, reason: error.message,
        item: job.item, lane: job.lane, journal, occupied: error.occupied })}\n`);
      process.exitCode = 1;
    } else if (error.code === 'DISPATCH_STOPPED') {
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
      process.stdout.write(`${JSON.stringify({ result: 'failed', code: dispatchCodes.has(error.code) ? error.code : 'DISPATCH_FAILED', reason: error.message, journal, ...(retry ? { retry } : {}) })}\n`);
      process.exitCode = 1;
    }
  }
} finally {
  releaseAdmission?.();
  if((opt.retry&&job?.detached||opt.detach&&process.exitCode)&&journal&&ownsLock){
    fs.mkdirSync(`${journal}.driver`,{recursive:true});const fd=fs.openSync(`${journal}.driver/results.jsonl`,'a',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),journal,stage:job.stage,run:job.run,exit_code:process.exitCode??0,error:job.error??null,code:job.failure?.code??null,native_launch_attempted:job.native_launch_attempted??null})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  if(!completionAttempted&&job&&journal&&ownsLock&&(job.stage==='complete'||process.exitCode||job.failure?.code==='DISPATCH_STOPPED'))try{recordDispatchCompletion({job,journal,exitCode:process.exitCode??0});}catch(error){process.stderr.write(`dispatch: completion status could not be recorded: ${error.message}\n`);process.exitCode??=1;}
  if (ownsLock) try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {}
  if (contender) try { fs.unlinkSync(contender); } catch {}
}
