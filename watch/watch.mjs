#!/usr/bin/env node
// Wait for one recorded run without inference, validate its report, and deliver
// a compact notice to a supervisor agent. Herdr's wait is server-side blocking;
// fs.watch catches a report that lands without another agent state change.

import { ownerIdentity } from '../lib/process-owner.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { retirementHold, RETIREMENT_HOLD_REASON } from '../lib/retire-hold.mjs';
import { bundleRelease, continueRelease, forwardRelease } from '../lib/releases.mjs';

import { acquireWatcherLock } from './lock.mjs';
import { createRunEventTail } from './record-tail.mjs';
import {registrationFile, stepFile, readJson, nativeBinding, sameNative, observerReceipt, digest, readWatchSubject} from './shared.mjs';
import {herdrSocketPath} from '../lanes/board/herdr-client.mjs';
import { readReport } from '../lib/report.mjs';
import { BRAIN_CONTROLLER, readOwnedRun, requireController, assertOwner, fenceOwner, continueOwnerRelease } from '../lib/run-owner.mjs';
import { writeFileAtomic,transact } from '../lib/store.mjs';
import { findOrgDir, LOG_FILE } from '../lib/store.mjs';
import { observeProcessEnd } from '../lib/run-timing.mjs';
import { inboxPath, promptSupervisor, readInbox } from '../supervisor/prompt-supervisor.mjs';
import {
  blockedNotice,
  invalidReportNotice,
  longRunningNotice,
  noReportNotice,
  reportNotice,
  unavailableNotice,
} from './notice.mjs';

const SELF = fileURLToPath(import.meta.url);
const LOCAL_ORG = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));

const { values: opt, positionals, tokens } = parseArgs({ usage: "Usage: node watch/watch.mjs R-n --org DIR [OPTIONS]",
  allowPositionals: true,
  tokens: true,
  options: {
    org: { type: 'string' },
    controller: { type: 'string', default: BRAIN_CONTROLLER },
    to: { type: 'string', default: process.env.MONITOR_SUPERVISOR_AGENT || 'supervisor-herdr' },
    agent: { type: 'string' },
    report: { type: 'string' },
    'start-grace': { type: 'string', default: '60' },
    'idle-grace': { type: 'string', default: '0' },
    'long-after': { type: 'string', default: '3600' },
    'retry-after': { type: 'string', default: '10' },
    'delivery-attempts': { type: 'string', default: '5' },
    inbox: { type: 'string' },
    'org-cli': { type: 'string' },
    herdr: { type: 'string', default: 'herdr' },
    shared: { type: 'boolean', default: false },
    step: { type: 'boolean', default: false },
    spawn: { type: 'boolean', default: false },
    detach: { type: 'boolean', default: false },
    'record-only':{type:'boolean',default:false},
    log: { type: 'string' },
    workspace: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    'close-tab-on-exit': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const runId = positionals[0];
opt.cwd = path.resolve(opt.cwd);
opt.org = opt.org ? path.resolve(opt.org) : findOrgDir({ cwd: opt.cwd });
if (!/^R-\d+$/.test(runId ?? '') || !opt.org) {
  process.stderr.write('usage: watch.mjs R-n [--org DIR] [--cwd PROJECT] [--to AGENT] [--spawn] [--start-grace SECONDS] [--idle-grace SECONDS] [--long-after SECONDS] [--dry-run]; a record must be supplied or discovered\n');
  process.exit(2);
}

function numberOption(name, { min = 0 } = {}) {
  const value = Number(opt[name]);
  if (!Number.isFinite(value) || value < min) {
    process.stderr.write(`watch: --${name} must be a number >= ${min}\n`);
    process.exit(2);
  }
  return value;
}

let startGraceMs = loadTimeout(numberOption('start-grace') * 1_000);
const idleGraceMs = numberOption('idle-grace') * 1_000;
const longAfterMs = numberOption('long-after') * 1_000;
const retryAfterMs = numberOption('retry-after') * 1_000;
const deliveryAttempts = numberOption('delivery-attempts', { min: 1 });
const dry = opt['dry-run'];
if ((opt.shared || opt.step) && (opt.spawn || opt.detach || opt['close-tab-on-exit'] || dry) || opt.shared && opt.step) throw Error('shared/step observation cannot combine with detached, visible or dry-run watch');
let deferStep;
let sharedRegistration;
let ownership;
const recordFile = path.join(opt.org, LOG_FILE);
const watchReceipt = path.join(opt.org, 'watch', `${runId}.json`);
function reserveWatch(intent, id) {
  fenceOwner(opt.org, runId, ownership, () => {
    const prior = fs.existsSync(watchReceipt) ? JSON.parse(fs.readFileSync(watchReceipt, 'utf8')) : {};
    writeFileAtomic(watchReceipt, JSON.stringify({ ...prior, ownership, intent,
      inbox: path.resolve(opt.inbox ?? inboxPath({ org: opt.org, cwd: opt.cwd })),
      deliveries: [...new Set([...(prior.deliveries ?? []), ...(id ? [id] : [])])] }) + '\n');
  });
}
function finishWatch() {
  fenceOwner(opt.org, runId, ownership, () => {
    const prior = JSON.parse(fs.readFileSync(watchReceipt, 'utf8'));
    delete prior.intent;
    writeFileAtomic(watchReceipt, JSON.stringify(prior) + '\n');
  });
}
const orgCommand = opt['org-cli'] ? [opt['org-cli']] : [process.execPath, LOCAL_ORG];
const log = (message) => process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  ${message}\n`);
const delay = (ms) => opt.step && deferStep ? deferStep(ms) : new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, { env } = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout:120000,killSignal:'SIGTERM',
    env: { ...process.env, ...env },
  });
}

function org(args) {
  const [command, ...prefix] = orgCommand;
  return run(command, [...prefix, ...args], { env: { ORG_DIR: opt.org } });
}

function jsonResult(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`);
  try {
    const body = JSON.parse(result.stdout);
    return body.result ?? body;
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

function readRun() {
  if(opt.step)return readWatchSubject(opt.org,runId);
  return jsonResult(org(['show', runId, '--json', ...(opt.step ? ['--compact'] : [])]), `org show ${runId}`);
}

function agentStatus(agent) {
  let result = run(opt.herdr, ['agent', 'get', agent]);
  if(sharedRegistration&&result.status!==0){
    try{if(JSON.parse(result.stderr||result.stdout).error?.code==='agent_not_found')result=run(opt.herdr,['agent','get',sharedRegistration.native.pane]);}catch{}
  }
  if (result.error) return { state: 'unavailable', error: result.error.message };
  try {
    const body = JSON.parse(result.status === 0 ? result.stdout : (result.stderr || result.stdout));
    if (body.error?.code === 'agent_not_found') return { state: null };
    if (body.error) return { state: 'unavailable', error: `${body.error.code}: ${body.error.message}` };
    const native = (body.result ?? body).agent;
    if (sharedRegistration && !sameNative(sharedRegistration.native, native)) return {state:'unavailable',error:'original native occupant changed; retained for the recorded stuck owner'};
    const state = native?.agent_status;
    return state ? { state, native, sequence: native.state_change_seq, completion: native.completion_seq } : { state: 'unavailable', error: 'Herdr returned no agent state' };
  } catch (error) {
    const detail = (result.stderr || result.stdout).trim();
    return { state: 'unavailable', error: detail || `invalid Herdr response (${error.message})` };
  }
}

function reportState(reportPath) {
  let text;
  try {
    const stat = fs.statSync(reportPath);
    if (!stat.isFile() || stat.size === 0) return { kind: 'missing' };
    text = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  const checked = org(['check', reportPath]);
  if (checked.status !== 0 || checked.error) {
    return {
      kind: 'invalid',
      error: (checked.stderr || checked.stdout || checked.error?.message || 'org check failed')
        .split('\n').map((line) => line.trim()).filter(Boolean).at(-1),
    };
  }
  const parsed = readReport(text);
  if (!parsed.report || parsed.errors.length > 0) {
    return { kind: 'invalid', error: parsed.errors.join('; ') || 'report could not be parsed' };
  }
  if (parsed.report.run && parsed.report.run !== runId) {
    return { kind: 'invalid', error: `report run ${parsed.report.run} does not match watched run ${runId}` };
  }
  const ok = checked.stdout.split('\n').findLast((line) => line.startsWith('ok:')) ?? 'ok';
  return { kind: 'valid', report: parsed.report, check: ok };
}

function existingDirectory(file) {
  let directory = path.dirname(path.resolve(file));
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return directory;
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function waitForSignal(agent, until, reportPath, timeoutMs, beforeStamp, recordChanged, stopFile) {
  if (opt.step) return deferStep(timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    let watcher;
    let timer;
    let controlTimer;
    const controlWatchers = [];
    let child;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(controlTimer);
      watcher?.close();
      for (const controlWatcher of controlWatchers) controlWatcher.close();
      if (child && child.exitCode === null) child.kill('SIGTERM');
      resolve(reason);
    };
    const directory = existingDirectory(reportPath);
    if (directory) {
      try {
        const reportDirectory = path.dirname(path.resolve(reportPath));
        const reportName = path.basename(reportPath);
        watcher = fs.watch(directory, (_event, filename) => {
          if (directory !== reportDirectory || filename == null || String(filename) === reportName) finish('report');
        });
        // Resource exhaustion and filesystem teardown can surface after
        // fs.watch returns. Herdr remains an independent wake-up path.
        watcher.on('error', () => {
          watcher?.close();
          watcher = undefined;
        });
      } catch { /* Herdr state still wakes us. */ }
    }
    // Completion/transfer and STOP need not change the worker or its report.
    // Unrelated appends advance only the byte cursor, keeping this same wait.
    // Cheap stats cover lost watches, replacement and removed directories.
    const checkControl = () => {
      if (fs.existsSync(stopFile)) finish('stop');
      else if (recordChanged()) finish('record');
    };
    for (const file of [recordFile, stopFile]) {
      const directory = existingDirectory(file);
      if (!directory) continue;
      try {
        const controlWatcher = fs.watch(directory, checkControl);
        controlWatcher.on('error', () => { controlWatcher.close(); checkControl(); });
        controlWatchers.push(controlWatcher);
      } catch { /* The stat fallback remains live. */ }
    }
    controlTimer = setInterval(checkControl, 30_000);
    const args = ['agent', 'wait', agent, ...until.flatMap((state) => ['--until', state])];
    child = spawn(opt.herdr, args, { stdio: 'ignore' });
    child.once('error', () => finish('wait-failed'));
    child.once('close', (code, signal) => {
      if (settled || signal === 'SIGTERM') return;
      finish(code === 0 ? 'agent' : 'wait-failed');
    });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish('long'), Math.max(0, timeoutMs));
    // Close the gap between the caller's inspection and fs.watch becoming live.
    if (fileStamp(reportPath) !== beforeStamp) finish('report');
    checkControl();
  });
}

async function deliver(message, sound = 'request', id, { allowQueued = false } = {}) {
  log(message);
  if (dry) return true;
  if(opt['record-only']){
    reserveWatch('record-only',id);
    if(opt.step){
      transact(opt.org,events=>{
        assertOwner(readOwnedRun(opt.org,runId,events),ownership);
        const text=`[watch record-only] ${message}`,prior=events.find(e=>e.type==='note.added'&&e.id===runId&&e.watch_notice_id===id);
        if(prior){if(prior.text!==text||digest(prior.watch_ownership)!==digest(ownership))throw Error('original watcher notice changed');return{add:[]};}
        return{add:[{type:'note.added',id:runId,text,decision:false,watch_notice_id:id,watch_ownership:ownership}]};
      },{strictTail:true,actor:process.env.ORG_ACTOR??'watch'});
    }else{
      const r=org(['note',runId,`[watch record-only] ${message}`]);
      if(r.error||r.status!==0)throw Error(`record-only watch notice refused: ${r.stderr||r.error?.message||r.status}`);
    }
    finishWatch();return true;
  }
  reserveWatch('delivery', id);
  let correlation;
  try { correlation = { run: runId, record: opt.org, project: gitProject(opt.cwd).identity }; }
  catch { /* Standalone/legacy records retain the conservative transport barrier. */ }
  const result = await promptSupervisor(opt.to, message, {
    org: opt.org, cwd: opt.cwd, inbox: opt.inbox, herdr: opt.herdr, attempts: deliveryAttempts,
    correlation,
    retrySeconds: retryAfterMs / 1000, sound, title: `${runId} watch could not deliver`, id, log,
  });
  if (result.delivered) { finishWatch(); return true; }
  if (allowQueued && result.queued && Number.isInteger(result.owner_pid) && result.owner_pid > 0) {
    log(`${id} queued/retained by inbox owner ${result.owner_pid}`);
    return true;
  }
  throw new Error(`could not deliver to ${opt.to}: ${result.delivery_error}; inbox=${result.inbox}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function spawnWatcher() {
  let workspace = opt.workspace ?? process.env.HERDR_WORKSPACE_ID;
  if (!workspace) {
    const workspaces = jsonResult(run(opt.herdr, ['workspace', 'list']), 'herdr workspace list').workspaces ?? [];
    const cwd = path.resolve(opt.cwd);
    workspace = workspaces.find((entry) => entry.worktree?.checkout_path
      && path.resolve(entry.worktree.checkout_path) === cwd)?.workspace_id;
  }
  if (!workspace) throw new Error(`--spawn found no Herdr workspace for ${path.resolve(opt.cwd)}; pass --workspace`);
  const argv = watcherArgs('--spawn').concat('--close-tab-on-exit');
  const command = [process.execPath, SELF, ...argv].map(shellQuote).join(' ');
  if (dry) {
    log(`[dry-run] would create tab "watch ${runId}" in ${workspace} and run ${command}`);
    return;
  }
  const created = jsonResult(run(opt.herdr, [
    'tab', 'create', '--workspace', workspace, '--cwd', path.resolve(opt.cwd), '--label', `watch ${runId}`, '--no-focus',
  ]), 'herdr tab create');
  const pane = created.root_pane?.pane_id;
  if (!pane) throw new Error('herdr tab create returned no root pane');
  const started = run(opt.herdr, ['pane', 'run', pane, command]);
  if (started.error || started.status !== 0) throw new Error(`could not start watcher in ${pane}: ${(started.stderr || started.stdout || started.error?.message).trim()}`);
  log(`watching ${runId} in ${pane}`);
}

function watcherArgs(mode) {
  // Freeze discovery and the named recipient before crossing a process or pane
  // boundary, where cwd and adapter environment can differ. Replace supplied
  // values in place so command receipts retain their order; add only omissions.
  const original = process.argv.slice(2);
  const frozen = new Set(['org', 'cwd', 'to']);
  const argv = [];
  const appendMissing = () => {
    for (const name of frozen) argv.push(`--${name}`, opt[name]);
    frozen.clear();
  };
  for (const token of tokens) {
    if (token.kind === 'option') {
      if (`--${token.name}` === mode) continue;
      if (['org', 'cwd', 'to'].includes(token.name)) {
        if (frozen.delete(token.name)) argv.push(`--${token.name}`, opt[token.name]);
        continue;
      }
      argv.push(original[token.index]);
      if (token.value !== undefined && !token.inlineValue) argv.push(token.value);
    } else {
      // Added options must precede a caller's positional-only boundary.
      if (token.kind === 'option-terminator') appendMissing();
      argv.push(original[token.index]);
    }
  }
  appendMissing();
  return argv;
}

// The parent returns only after the child has acquired the run lock and read
// its worker/report configuration. No supervisor pane identity is inherited.
async function detachWatcher() {
  if (opt.spawn || dry || !opt.log) throw new Error('--detach requires --log and cannot combine with --spawn or --dry-run');
  const logPath = path.resolve(opt.log);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a', 0o600);
  const env = { ...process.env };
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) delete env[key];
  let child;
  try {
    child = spawn(process.execPath, [SELF, ...watcherArgs('--detach')], {
      cwd: path.resolve(opt.cwd), env, detached: true, stdio: ['ignore', fd, fd, 'ipc'],
    });
  } finally { fs.closeSync(fd); }
  let identity;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`watcher startup timed out; inspect ${logPath}`));
    }, loadTimeout(10_000));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`watcher exited during startup (${code}); inspect ${logPath}`)); });
    child.once('message', (message) => {
      if (message?.ready !== runId) return;
      identity = message.identity;
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      resolve();
    });
  });
  process.stdout.write(`${JSON.stringify({ run: runId, pid: child.pid, identity, log: logPath, release: bundleRelease() })}\n`);
}

function acquireLock() {
  const release = acquireWatcherLock({ org: opt.org, run: runId });
  process.once('exit', release);
  return release;
}

function ownTabRetirementHold() {
  // Only an explicit non-repository result at the starting cwd can bypass
  // canonical discovery. Later Git or hold lookup failures must keep the tab.
  const probe = run('git', ['-C', opt.cwd, 'rev-parse', '--show-toplevel'], { env: { LC_ALL: 'C' } });
  if (!probe.error && probe.status === 128 &&
      /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point\b)/.test(probe.stderr)) return null;
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(probe.stderr.trim() || `Git checkout lookup exited ${probe.status}`);
  return retirementHold(gitProject(opt.cwd).canonical);
}

async function closeOwnTab() {
  if (!dry && ownership) {
    try { assertOwner(readOwnedRun(opt.org, runId), ownership); } catch { return; }
  }
  if (dry || !opt['close-tab-on-exit'] || !process.env.HERDR_TAB_ID) return;
  try {
    const held = ownTabRetirementHold();
    if (held) { log(JSON.stringify({ action: 'held', tab_id: process.env.HERDR_TAB_ID, why: held })); return; }
  } catch (error) {
    log(JSON.stringify({ action: 'held', tab_id: process.env.HERDR_TAB_ID, why: RETIREMENT_HOLD_REASON, error: error.message }));
    return;
  }
  // The close may kill this process. Commit the completed hand-off before
  // spawning it, under the same owner fence; no post-close callback is needed.
  fenceOwner(opt.org, runId, ownership, () => {
    const prior = fs.existsSync(watchReceipt) ? JSON.parse(fs.readFileSync(watchReceipt, 'utf8')) : {};
    if (prior.intent === 'cleanup') delete prior.intent;
    writeFileAtomic(watchReceipt, JSON.stringify({ ...prior, ownership, cleanup: { tab: process.env.HERDR_TAB_ID, state: 'handed-off' } }) + '\n');
    const child = spawn(opt.herdr, ['tab', 'close', process.env.HERDR_TAB_ID], { detached: true, stdio: 'ignore' });
    child.once('error', error => log(`watch tab close failed: ${error.message}`));
    child.unref();
  });
}

async function watch() {
  let current = readRun();
  const item = current.item;
  const agent = opt.agent ?? current.meta?.agent;
  const reportPath = path.resolve(opt.report ?? current.report_path ?? '');
  let canonical = opt.cwd;
  try { canonical = gitProject(opt.cwd).canonical; } catch { /* Standalone record. */ }
  const stopFile = path.join(canonical, '.lane/supervisor/STOP');
  if (!item) throw new Error(`${runId} has no item`);
  if (!agent) throw new Error(`${runId} has no worker agent; pass --agent`);
  if (!current.report_path && !opt.report) throw new Error(`${runId} has no report path; pass --report`);
  log(`watching ${runId} (${item}): worker ${agent}, report ${reportPath}, supervisor ${opt.to}`);
  if (process.send) process.send({ ready: runId, identity: ownerIdentity(process.pid) });

  const signature = digest({ownership, org:opt.org,cwd:opt.cwd,to:opt.to,agent,reportPath,
    recordOnly:opt['record-only'],startGrace:opt['start-grace'],idleGraceMs,longAfterMs,retryAfterMs});
  const saved = opt.step ? readJson(stepFile(opt.org,runId)) : null;
  if(saved?.resolved_start_grace_ms!==undefined)startGraceMs=saved.resolved_start_grace_ms;
  if (saved && saved.signature !== signature) throw Error('saved watcher step binding changed; retain it');
  let {lastNotice,lastUnavailableLog,pendingUnavailable,longNotified=false,longNotice,longNoticeId,longNextAt,
    idleGraceUntil,observedWorking=false,lastWorkingAt,startupWaitingLogged=false,noticeSequence=0,previousState,
    availableHash,armedAt=Date.now(),startedAt=Date.parse(current.started?.at ?? '') || Date.now()} = saved?.state ?? {};
  const checkpoint = (phase, timeoutMs, error) => {
    if (!opt.step) return;
    const state = {lastNotice,lastUnavailableLog,pendingUnavailable,longNotified,longNotice,longNoticeId,longNextAt,
      idleGraceUntil,observedWorking,lastWorkingAt,startupWaitingLogged,noticeSequence,previousState,availableHash,armedAt,startedAt};
    const file=stepFile(opt.org,runId);fs.mkdirSync(path.dirname(file),{recursive:true});
    writeFileAtomic(file,JSON.stringify({schema:'brain.watch-step/v1',run:runId,signature,ownership,phase,state,resolved_start_grace_ms:startGraceMs,
      pid:process.pid,identity:ownerIdentity(process.pid),at:new Date().toISOString(),rss_bytes:process.memoryUsage().rss,high_water_rss_bytes:process.resourceUsage().maxRSS*1024,
      next_at:timeoutMs===undefined?null:Date.now()+Math.max(0,timeoutMs),...(error?{error}: {})})+'\n');
  };
  deferStep = timeoutMs => {checkpoint('waiting',timeoutMs);throw Object.assign(Error('finite watch deferred'),{code:'WATCH_DEFERRED'});};
  checkpoint('running');
  // A crash restarts this same duty and stable notice IDs. Inbox uncertainty
  // remains with its original delivery owner; no replacement is introduced.
  const finishStep = error => checkpoint(error?'failed':'complete',undefined,error?.message);
  try {
  const sendOnce = async (message, sound, { fatal = false, id } = {}) => {
    if (message === lastNotice) return true;
    try {
      const digest = crypto.createHash('sha256').update(message).digest('hex');
      await deliver(message, sound, id ?? `watch:${runId}:${noticeSequence}:${digest}`, { allowQueued: !fatal || opt.step });
      lastNotice = message;
      return true;
    } catch (error) {
      if (fatal) throw error;
      log(`${error.message}; continuing to watch ${runId}`);
      return false;
    }
  };
  const deliverFinal = (report) => deliver(reportNotice({
    run: runId, item, outcome: report.outcome, headline: report.headline ?? report.summary,
    report: reportPath, check: 'pass',
  }), 'done', `watch:${runId}:final`, {allowQueued:true});

  if (dry) {
    const status = agentStatus(agent);
    const state = status.state ?? 'gone';
    const report = reportState(reportPath);
    log(`[dry-run] worker=${state} report=${report.kind}${status.error ? ` error=${status.error}` : ''}; no wait or delivery performed`);
    return;
  }

  for (;;) {
    // Capture the cursor before reading state so an append during inspection
    // is still checked after the filesystem subscriptions become live.
    const recordChanged = createRunEventTail(recordFile, { run: runId, item });
    if (fs.existsSync(stopFile) || opt.step && (fs.existsSync(path.join(canonical,'.lane/supervisor/HOLD')) || fs.existsSync(path.join(opt.org,'STOP')))) { checkpoint('held');log(opt.step?'Supervisor STOP/HOLD; stopping without delivery':'Supervisor STOP; stopping without delivery'); return; }
    let owned;
    try { owned = assertOwner(readOwnedRun(opt.org, runId), ownership); } catch (error) { log(`${error.message}; stopping without delivery`); return; }
    current = readRun();
    if(opt.step){
      const m=current.meta,n=sharedRegistration.native;
      if(m.identity_conflict||m.agent!==n.agent||m.pane!==n.pane||m.worker_workspace!==n.workspace||m.terminal_id!==n.terminal||current.workspace!==n.cwd||m.agent_session_id&&m.agent_session_id!==n.session)throw Error('original record/native worker binding changed; retain shared duty');
    }
    if (owned.abandoned || current.abandoned) {
      log(`${runId} was abandoned; stopping`);
      return;
    }
    // Ingestion already validated and froze the final report. The worker can
    // still appear active, or its mutable report file can be gone by this pass.
    // Adopt the same final notice ID through the existing recipient/input gate.
    // Keep opt.to: dispatch may intentionally record the worker as recipient.
    const ingested = owned.report ?? current.report;
    if (ingested) {
      await deliverFinal(ingested);
      log(`${runId} final notice confirmed from its ingested report`);
      return;
    }
    const beforeStamp = fileStamp(reportPath);
    let report = reportState(reportPath);
    const publishAvailable = () => {if(report.kind==='valid')try{
      const hash=crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
      if(hash!==availableHash){const hint=org(['report-available','--run',runId,'--sha256',hash]);
        if(!hint.error&&hint.status===0)availableHash=hash;}
    }catch{/* The original watcher continues; the finite line reconciles lost hints. */}};
    if(!opt.step)publishAvailable();
    const status = agentStatus(agent);
    const observedAt = new Date().toISOString();
    const state = status.state;
    if(opt.step&&state!=='unavailable')publishAvailable();
    if (status.sequence !== undefined) noticeSequence = status.sequence;
    else if (state === 'working' && previousState !== 'working') noticeSequence++;
    previousState = state;

    const workerStillRunning = state === 'working' || state === 'unknown';
    const workerFinished = state === 'idle' || state === 'done' || state === null;
    // The worker can finish and rewrite its report between the first report
    // read and the state read. Once it is terminal, read again so delivery
    // reflects the file it actually stopped with.
    if (workerFinished) report = reportState(reportPath);
    const saveProcessEnd = () => {
      try {
        let reserved = false;
        observeProcessEnd({ current, state, now: () => observedAt,
          eligible: true, lastWorkingAt, beforeWrite: () => { reserveWatch('process-end'); reserved = true; },
          record: args => {
            const result = org(args);
            if (result.error || result.status !== 0) throw Error('process-end metadata write failed');
          } });
        if (reserved) finishWatch();
      } catch { log('run process-end metadata could not be saved; continuing to watch'); }
    };
    if (report.kind === 'valid' && workerFinished) {
      saveProcessEnd();
      await deliverFinal(report.report);
      log(`validated by ${report.check}`);
      return;
    }
    if (state === 'unavailable') {
      const message = unavailableNotice({ run: runId, item, agent, error: status.error });
      if (message !== lastUnavailableLog) log(message);
      lastUnavailableLog = message;
      pendingUnavailable = message;
      await delay(retryAfterMs);
      continue;
    }
    lastUnavailableLog = undefined;
    if (state === 'working' || state === 'unknown') {
      if (state === 'working') { observedWorking = true; lastWorkingAt = observedAt; }
      idleGraceUntil = undefined;
      // A resumed worker starts a new attempt. Its next identical stop must be
      // reported again rather than deduped against the previous attempt.
      lastNotice = undefined;
    }
    if (pendingUnavailable) {
      if (await sendOnce(pendingUnavailable)) pendingUnavailable = undefined;
    }

    const startupGraceRemaining = observedWorking ? 0 : Math.max(0, (armedAt + startGraceMs) - Date.now());
    if (!observedWorking && !workerStillRunning && startupGraceRemaining > 0) {
      if (!startupWaitingLogged) {
        log(`waiting up to ${startGraceMs / 1_000}s for ${agent} to start before treating ${state ?? 'gone'} as terminal`);
        startupWaitingLogged = true;
      }
      const signal = await waitForSignal(agent, ['working'], reportPath, startupGraceRemaining, beforeStamp, recordChanged, stopFile);
      if (signal === 'wait-failed') await delay(Math.min(retryAfterMs, startupGraceRemaining));
      continue;
    }
    if (observedWorking && report.kind === 'missing' && (state === 'idle' || state === 'done') && idleGraceMs > 0) {
      if (idleGraceUntil === undefined) {
        idleGraceUntil = Date.now() + idleGraceMs;
        log(`waiting up to ${idleGraceMs / 1_000}s for ${agent}'s report or resume before sending a no-report notice`);
      }
      const remaining = Math.max(0, idleGraceUntil - Date.now());
      if (remaining > 0) {
        const signal = await waitForSignal(agent, ['working', 'blocked'], reportPath, remaining, beforeStamp, recordChanged, stopFile);
        if (signal === 'wait-failed') await delay(Math.min(retryAfterMs, remaining));
        continue;
      }
    }
    // Startup and idle grace have resolved. A later observed resume supersedes
    // this terminal attempt, while a lost record reply replays its journal time.
    if (workerFinished) saveProcessEnd();
    if (report.kind === 'invalid' && !['working', 'unknown'].includes(state)) {
      await sendOnce(
        invalidReportNotice({ run: runId, item, agent, report: reportPath, error: report.error }),
        undefined,
        { fatal: state === null },
      );
      if (state === null) throw new Error(`worker ${agent} is gone with an invalid report`);
    } else if (state === null) {
      await sendOnce(
        noReportNotice({ run: runId, item, agent, state: 'gone', report: reportPath }),
        undefined,
        { fatal: true },
      );
      throw new Error(`worker ${agent} is gone without a valid report`);
    } else if (state === 'blocked') {
      await sendOnce(blockedNotice({ run: runId, item, agent, report: reportPath }));
    } else if (state === 'idle' || state === 'done') {
      await sendOnce(noReportNotice({ run: runId, item, agent, state, report: reportPath }));
    }

    const elapsed = Date.now() - startedAt;
    longNextAt ??= startedAt + longAfterMs;
    if (!longNotified && Date.now() >= longNextAt && workerStillRunning) {
      if (!longNotice) {
        // One logical event per run. Adopt even legacy IDs and retain the
        // journaled elapsed-minute payload when a watcher is restarted.
        const prior = readInbox(path.resolve(opt.inbox ?? inboxPath({ org: opt.org, cwd: opt.cwd })))
          .find((entry) => entry.message.startsWith(`[watch-long-running] run=${runId} `));
        longNoticeId = prior?.id ?? `watch:${runId}:long-running`;
        longNotice = prior?.message ?? longRunningNotice({
          run: runId, item, agent, minutes: Math.max(1, Math.floor(elapsed / 60_000)),
        });
      }
      longNotified = await sendOnce(longNotice, undefined, { id: longNoticeId });
      if (!longNotified) longNextAt = Date.now() + retryAfterMs;
    }

    const until = workerStillRunning
      ? ['idle', 'done', 'blocked']
      : state === 'blocked' ? ['working', 'idle', 'done'] : ['working'];
    const untilLong = !longNotified && workerStillRunning
      ? Math.max(0, longNextAt - Date.now())
      : undefined;
    const signal = await waitForSignal(agent, until, reportPath, untilLong, beforeStamp, recordChanged, stopFile);
    if (signal === 'long') continue;
    if (signal === 'wait-failed') {
      log(`Herdr wait failed; rechecking after ${retryAfterMs / 1_000}s`);
      await delay(retryAfterMs);
    }
  }
  } catch(error) {
    if(error.code==='WATCH_DEFERRED') return;
    finishStep(error);throw error;
  }
  finally {if(opt.step && readJson(stepFile(opt.org,runId))?.phase==='running') finishStep();}
}

function registerShared() {
  const current=readRun(),project=gitProject(opt.cwd),source=bundleRelease().root;
  const host=observerReceipt(opt.org,{repo:project.canonical,project:project.identity,source,socket:herdrSocketPath()});
  if(fs.existsSync(path.join(project.canonical,'.lane/supervisor/STOP')) || fs.existsSync(path.join(project.canonical,'.lane/supervisor/HOLD'))) throw Error('STOP/HOLD prevents shared registration');
  const file=registrationFile(opt.org,runId),prior=readJson(file);
  if(prior){
    if(digest(prior.ownership)!==digest(ownership)||prior.to!==opt.to||prior.cwd!==opt.cwd||prior.source!==source)throw Error('original shared observation binding changed');
  }else{
    if(current.meta?.watcher_pid||fs.existsSync(watchReceipt))throw Error('existing watcher/receipt retained; live watcher migration is excluded');
    const native=jsonResult(run(opt.herdr,['agent','get',opt.agent??current.meta?.agent]),'original worker').agent;
    const binding=nativeBinding(native),m=current.meta??{};
    if(!sameNative(binding,native)||binding.agent!==m.agent||binding.pane!==m.pane||binding.workspace!==m.worker_workspace||binding.terminal!==m.terminal_id||binding.cwd!==current.workspace||m.agent_session_id&&binding.session!==m.agent_session_id)throw Error('exact original native worker binding required');
    const argv=watcherArgs('--shared');
    fenceOwner(opt.org,runId,ownership,()=>{
      fs.mkdirSync(path.dirname(file),{recursive:true});
      if(fs.existsSync(file))throw Error('shared registration raced; retain original');
      writeFileAtomic(file,JSON.stringify({schema:'brain.shared-watch/v1',run:runId,org:opt.org,project:project.identity,repo:project.canonical,cwd:opt.cwd,source,release:bundleRelease(),ownership,
        native:binding,to:opt.to,report:path.resolve(opt.report??current.report_path),argv,
        consumer:'watch/watch.mjs --step',wake_fact:'native lifecycle, report/record change or coarse-safety-reconciliation',stuck_owner:opt.to})+'\n');
    });
  }
  process.stdout.write(JSON.stringify({run:runId,pid:host.pid,identity:host.identity,log:host.log,shared:file,release:bundleRelease()})+'\n');
}

try {
  // Installed adapters enter through an absolute bundle path after resolving
  // the project. Re-arm must still recover the dispatch's original bundle.
  const actual = bundleRelease();
  let saved;
  if (!dry) {
    ownership = requireController(readOwnedRun(opt.org, runId), opt.controller);
    const bound = continueOwnerRelease('watch/watch.mjs', ownership);
    if (bound !== null) process.exit(bound);
  }
  if (actual.commit) {
    const current = readRun();
    if (current.meta?.dispatch_journal) {
      let contents;
      try { contents = fs.readFileSync(current.meta.dispatch_journal, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Match cold-start entry: an absent journal has no saved binding.
      if (contents !== undefined) {
        const receipt = JSON.parse(contents);
        if (receipt.run !== runId) throw Error('dispatch receipt does not match watched run');
        if (!receipt.release) throw Error('operation-release-missing: identify the legacy dispatch runtime before re-arming');
        saved = receipt.release;
      }
    }
  }
  const forwarded = ownership ? null : saved ? (saved.root === actual.root ? null : continueRelease('watch/watch.mjs', saved))
    : forwardRelease('watch/watch.mjs', opt.cwd);
  if (forwarded !== null) process.exit(forwarded);
  if(opt.step){
    sharedRegistration=readJson(registrationFile(opt.org,runId));
    if(!sharedRegistration||digest(sharedRegistration.ownership)!==digest(ownership)||sharedRegistration.to!==opt.to||sharedRegistration.cwd!==opt.cwd||sharedRegistration.source!==bundleRelease().root)throw Error('original shared registration required');
  }
  if (opt.shared || !opt.step && readJson(registrationFile(opt.org,runId))) {
    const release=acquireLock();try{registerShared();}finally{release();}
  } else if (opt.detach && !dry) {
    await detachWatcher();
  } else if (opt.spawn) {
    spawnWatcher();
  } else {
    const release = dry ? () => {} : acquireLock();
    try {
      if (!dry) fenceOwner(opt.org, runId, ownership, () => {});
      await watch();
    } finally { release(); }
    await closeOwnTab();
  }
} catch (error) {
  process.stderr.write(`watch: ${error.message}\n`);
  process.exitCode = 1;
}
