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

import { acquireWatcherLock } from './lock.mjs';
import { readReport } from '../lib/report.mjs';
import { findOrgDir } from '../lib/store.mjs';
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
    spawn: { type: 'boolean', default: false },
    detach: { type: 'boolean', default: false },
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

const startGraceMs = loadTimeout(numberOption('start-grace') * 1_000);
const idleGraceMs = numberOption('idle-grace') * 1_000;
const longAfterMs = numberOption('long-after') * 1_000;
const retryAfterMs = numberOption('retry-after') * 1_000;
const deliveryAttempts = numberOption('delivery-attempts', { min: 1 });
const dry = opt['dry-run'];
const orgCommand = opt['org-cli'] ? [opt['org-cli']] : [process.execPath, LOCAL_ORG];
const log = (message) => process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  ${message}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, { env } = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
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
  return jsonResult(org(['show', runId, '--json']), `org show ${runId}`);
}

function agentStatus(agent) {
  const result = run(opt.herdr, ['agent', 'get', agent]);
  if (result.error) return { state: 'unavailable', error: result.error.message };
  try {
    const body = JSON.parse(result.status === 0 ? result.stdout : (result.stderr || result.stdout));
    if (body.error?.code === 'agent_not_found') return { state: null };
    if (body.error) return { state: 'unavailable', error: `${body.error.code}: ${body.error.message}` };
    const state = (body.result ?? body).agent?.agent_status;
    return state ? { state, sequence: (body.result ?? body).agent.state_change_seq } : { state: 'unavailable', error: 'Herdr returned no agent state' };
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

function waitForSignal(agent, until, reportPath, timeoutMs, beforeStamp) {
  return new Promise((resolve) => {
    let settled = false;
    let watcher;
    let timer;
    let child;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
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
  });
}

async function deliver(message, sound = 'request', id, { allowQueued = false } = {}) {
  log(message);
  if (dry) return true;
  const result = await promptSupervisor(opt.to, message, {
    org: opt.org, cwd: opt.cwd, inbox: opt.inbox, herdr: opt.herdr, attempts: deliveryAttempts,
    retrySeconds: retryAfterMs / 1000, sound, title: `${runId} watch could not deliver`, id, log,
  });
  if (result.delivered) return true;
  if (allowQueued && result.queued && Number.isInteger(result.owner_pid) && result.owner_pid > 0) return true;
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
  process.stdout.write(`${JSON.stringify({ run: runId, pid: child.pid, identity, log: logPath })}\n`);
}

function acquireLock() {
  const release = acquireWatcherLock({ org: opt.org, run: runId });
  process.once('exit', release);
  return release;
}

function closeOwnTab() {
  if (dry || !opt['close-tab-on-exit'] || !process.env.HERDR_TAB_ID) return;
  const child = spawn(opt.herdr, ['tab', 'close', process.env.HERDR_TAB_ID], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function watch() {
  let current = readRun();
  const item = current.item;
  const agent = opt.agent ?? current.meta?.agent;
  const reportPath = path.resolve(opt.report ?? current.report_path ?? '');
  if (!item) throw new Error(`${runId} has no item`);
  if (!agent) throw new Error(`${runId} has no worker agent; pass --agent`);
  if (!current.report_path && !opt.report) throw new Error(`${runId} has no report path; pass --report`);
  log(`watching ${runId} (${item}): worker ${agent}, report ${reportPath}, supervisor ${opt.to}`);
  if (process.send) process.send({ ready: runId, identity: ownerIdentity(process.pid) });

  let lastNotice;
  let lastUnavailableLog;
  let pendingUnavailable;
  let longNotified = false;
  let longNotice;
  let longNoticeId;
  let longNextAt;
  let idleGraceUntil;
  let observedWorking = false;
  let lastWorkingAt;
  let startupWaitingLogged = false;
  let noticeSequence = 0;
  let previousState;
  const armedAt = Date.now();
  const startedAt = Date.parse(current.started?.at ?? '') || Date.now();
  const sendOnce = async (message, sound, { fatal = false, id } = {}) => {
    if (message === lastNotice) return true;
    try {
      const digest = crypto.createHash('sha256').update(message).digest('hex');
      await deliver(message, sound, id ?? `watch:${runId}:${noticeSequence}:${digest}`, { allowQueued: !fatal });
      lastNotice = message;
      return true;
    } catch (error) {
      if (fatal) throw error;
      log(`${error.message}; continuing to watch ${runId}`);
      return false;
    }
  };

  if (dry) {
    const status = agentStatus(agent);
    const state = status.state ?? 'gone';
    const report = reportState(reportPath);
    log(`[dry-run] worker=${state} report=${report.kind}${status.error ? ` error=${status.error}` : ''}; no wait or delivery performed`);
    return;
  }

  for (;;) {
    current = readRun();
    if (current.abandoned) {
      log(`${runId} was abandoned; stopping`);
      return;
    }
    const beforeStamp = fileStamp(reportPath);
    let report = reportState(reportPath);
    const status = agentStatus(agent);
    const observedAt = new Date().toISOString();
    const state = status.state;
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
        observeProcessEnd({ current, state, now: () => observedAt,
          eligible: true, lastWorkingAt,
          record: args => {
            const result = org(args);
            if (result.error || result.status !== 0) throw Error('process-end metadata write failed');
          } });
      } catch { log('run process-end metadata could not be saved; continuing to watch'); }
    };
    if (report.kind === 'valid' && workerFinished) {
      saveProcessEnd();
      const headline = report.report.headline ?? report.report.summary;
      await deliver(reportNotice({
        run: runId, item, outcome: report.report.outcome, headline,
        report: reportPath, check: 'pass',
      }), 'done', `watch:${runId}:final`);
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
      const signal = await waitForSignal(agent, ['working'], reportPath, startupGraceRemaining, beforeStamp);
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
        const signal = await waitForSignal(agent, ['working', 'blocked'], reportPath, remaining, beforeStamp);
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
    const signal = await waitForSignal(agent, until, reportPath, untilLong, beforeStamp);
    if (signal === 'long') continue;
    if (signal === 'wait-failed') {
      log(`Herdr wait failed; rechecking after ${retryAfterMs / 1_000}s`);
      await delay(retryAfterMs);
    }
  }
}

try {
  if (opt.detach && !dry) {
    await detachWatcher();
  } else if (opt.spawn) {
    spawnWatcher();
  } else {
    const release = dry ? () => {} : acquireLock();
    try { await watch(); } finally { release(); }
    closeOwnTab();
  }
} catch (error) {
  process.stderr.write(`watch: ${error.message}\n`);
  process.exitCode = 1;
}
