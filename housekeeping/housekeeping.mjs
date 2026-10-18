#!/usr/bin/env node
// Project housekeeping: a deterministic schedule, with record/Git authority.
import { ownerAlive, ownerIdentity } from '../lib/process-owner.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { matchingRun, waitingOnRecord } from '../supervisor/tidy-tabs.mjs';
import { createRetirement } from '../lib/retire-runtime.mjs';
import { planRetirement } from '../lib/retire.mjs';
import { consumeRetirement } from '../lib/retire-trigger.mjs';
import { retirementStatus } from '../lib/retire-status.mjs';
import { publishProjectSummary } from '../lib/project-summary.mjs';
import { noticeIdleRetirement } from './retirement-notices.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { readConfig } from './config.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { resumeInbox, inboxPath } from '../supervisor/prompt-supervisor.mjs';
export { readConfig } from './config.mjs';

const LOCAL_RECORD = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const TIDY = fileURLToPath(new URL('../supervisor/tidy-tabs.mjs', import.meta.url));
const FINISHED = new Set(['idle', 'done']);
const canonicalPath = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
export const RESUME = 'Housekeeping: a stray terminal mouse-wheel escape interrupted this open recorded run. Continue exactly where you left off and write the requested report.';

export function interruptedComposer(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const index = lines.findLastIndex((line) => /^\s*›/.test(line));
  if (index < 0) return false;
  const composer = lines[index].replace(/^\s*›\s*/, '').trim();
  // Only wheel junk: never erase an operator's words, even beside an escape.
  if (!/^(?:(?:\x1b\[)?<6[4-7];\d+;\d+[Mm]\s*)+$/.test(composer)) return false;
  if (lines[index + 1]?.trim()) return false; // Wrapped input isn't safe to erase.
  // The interruption must be the most recent output, not history above a final reply.
  // Scan rows once: a multiline whitespace regex can backtrack exponentially.
  let last = index - 1;
  while (last >= 0) {
    const line = lines[last].trim();
    if (line && !/^Something went wrong\?/.test(line)) break;
    last--;
  }
  return last >= 0 && /^■ (?:Conversation|Turn) interrupted\b/.test(lines[last].trim());
}

function gitCheckout(directory) {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? canonicalPath(result.stdout.trim()) : null;
}

function requireStableRuntime(file) {
  const checkout = gitCheckout(path.dirname(file));
  if (!checkout) return; // Installed release/plugin copies need no Git checkout.
  const result = spawnSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const first = result.stdout?.split('\n').find((line) => line.startsWith('worktree '));
  if (result.status !== 0 || !first) throw new Error(`cannot establish runtime checkout: ${file}`);
  if (checkout !== canonicalPath(first.slice(9))) {
    throw new Error(`live housekeeping cannot run code from a linked worktree: ${file}; use the canonical checkout or installed plugin, or --once --dry-run`);
  }
}

function executablePath(command) {
  const candidates = command.includes(path.sep) ? [path.resolve(command)] :
    (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.resolve(directory, command));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  throw new Error(`record CLI is missing or not executable: ${command}`);
}

export { matchingRun } from '../supervisor/tidy-tabs.mjs';

export function resumeKey(run, agent) {
  return JSON.stringify([run.id, agent.pane_id, agent.terminal_id, agent.agent_session?.value, agent.state_change_seq]);
}

// Finished sessions are independent of lane promotion and the slower cleanup
// interval. A failed tidy is evidence for the log, never a reason to skip recovery.
export function tidyFinishedTabs({ cwd, org, herdr = 'herdr', record = [process.execPath, LOCAL_RECORD],
  dryRun = false, command = spawnSync, log = () => {} }) {
  const args = [TIDY, '--cwd', cwd, '--org', org, '--herdr', herdr,
    '--org-cli', record[0], ...record.slice(1).flatMap((arg) => ['--org-cli-arg', arg]),
    ...(dryRun ? ['--dry-run'] : [])];
  let output = '';
  try {
    const result = command(process.execPath, args, { cwd, encoding: 'utf8',
      timeout: loadTimeout(30000), maxBuffer: 32 * 1024 * 1024 });
    output = result.stdout?.trim() ?? '';
    if (result.error || result.status !== 0) {
      throw new Error((result.stderr || result.error?.message || result.stdout || `exit ${result.status}`).trim());
    }
    log({ action: 'tidy-tabs', output, dryRun });
    return true;
  } catch (error) {
    log({ action: 'tidy-failed', error: error.message, output, dryRun });
    return false;
  }
}

export function createHousekeeping({ cwd, org, main = 'main', herdr = 'herdr', record = [process.execPath, LOCAL_RECORD],
  command = spawnSync, log = () => {}, selfTab = process.env.HERDR_TAB_ID ?? null, stateDir }) {
  const invoke = (exe, args, extra = {}) => {
    const r = command(exe, args, { cwd, encoding: 'utf8', timeout: loadTimeout(10000),
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ORG_DIR: org }, ...extra });
    if (r.error || r.status !== 0) throw new Error(`${exe} ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}`);
    return r.stdout.trim();
  };
  const retirement = createRetirement({ cwd, org, main, herdr, record, command, selfTab, log });
  const common = retirement.common;
  const observe = workspacePath => {
    const snapshot = retirement.observe(workspacePath);
    return { ...snapshot, runs: snapshot.record.runs, items: snapshot.record.items };
  };
  const tidy = snapshot => planRetirement(snapshot);
  function candidate(snapshot, agent) {
    if (agent.agent !== 'codex' || !FINISHED.has(agent.agent_status) || !Number.isInteger(agent.state_change_seq)) return null;
    const run = matchingRun(agent, snapshot.runs);
    const ws = snapshot.workspaces.find((w) => w.workspace_id === agent.workspace_id);
    if (!run || waitingOnRecord(snapshot, run) || run.report || run.abandoned || !ws?.worktree.is_linked_worktree ||
        canonicalPath(ws.worktree.checkout_path) !== canonicalPath(run.workspace) || agent.tab_id === selfTab) return null;
    // A report on disk may be awaiting ingestion: don't restart finished work.
    if (run.report_path && fs.existsSync(run.report_path)) return null;
    if (!interruptedComposer(invoke(herdr, ['agent', 'read', agent.pane_id, '--source', 'visible']))) return null;
    return run;
  }
  function tick({ cleanup = true, resume = true, dryRun = false, seen = new Set(), remember = () => {}, workspacePath,
    now = new Date().toISOString() } = {}) {
    let consumed;
    // A hint is only a reason to re-observe through the guarded executor. Do
    // not acknowledge requests during previews or workspace-scoped checks.
    if (!dryRun && !workspacePath) {
      try {
        consumed = consumeRetirement({ org, deadline: Date.now() + loadTimeout(30000),
          retirement: ({ deadline }) => createRetirement({ cwd, org, main, herdr, record, command, selfTab, log, deadline }) });
        if (consumed.handled || consumed.pending) log({ ...consumed, action: 'retirement-consumed' });
      } catch (error) { log({ action: 'retirement-failed', error: error.message }); }
    }
    const snapshot = observe(workspacePath); // Any failed read aborts the tick, never implies gone.
    if (!workspacePath && !dryRun) try {
      const summary = publishProjectSummary({ cwd, org, snapshot, command, main, now });
      log({ action: 'summary-published', generated_at: summary.generated_at });
    } catch (error) { log({ action: 'summary-publish-failed', error: error.message }); }
    if (!workspacePath) try {
      noticeIdleRetirement({ status: retirementStatus(snapshot, { generatedAt: now }), snapshot,
        stateDir, cwd, org, herdr, dryRun, log });
    } catch (error) { log({ action: 'retirement-notice-failed', error: error.message }); }
    const selected = workspacePath ? new Set(snapshot.workspaces.filter(w => canonicalPath(w.worktree.checkout_path) === canonicalPath(workspacePath)).map(w => w.workspace_id)) : null;
    const allPlan = cleanup ? tidy(snapshot) : { close: [], keep: [] };
    const plan = selected ? { ...allPlan, close: allPlan.close.filter(t => selected.has(t.workspace_id)), keep: allPlan.keep.filter(t => selected.has(t.workspace_id)) } : allPlan;
    log({ action: 'scan', close: plan.close.length, keep: plan.keep.length, cleanup, resume, dryRun });
    for (const tab of plan.keep) log({ action: 'keep', ...tab, dryRun });
    for (const diagnostic of plan.diagnostics ?? []) log({ action: 'reference-diagnostic', ...diagnostic });
    if (dryRun) for (const tab of plan.close) log({ action: 'would-close', ...tab });
    else if (!consumed?.results) retirement.apply(plan, workspacePath, snapshot);
    if (resume) for (const agent of snapshot.agents) {
      const run = candidate(snapshot, agent);
      if (!run || seen.has(resumeKey(run, agent))) continue;
      if (dryRun) { log({ action: 'would-resume', run: run.id, pane: agent.pane_id }); continue; }
      const fresh = observe(workspacePath);
      const live = fresh.agents.find((a) => a.pane_id === agent.pane_id);
      if (!live || resumeKey(run, live) !== resumeKey(run, agent) || !candidate(fresh, live)) continue;
      const key = resumeKey(run, agent);
      // Persist BEFORE input: uncertain input is never replayed, including after restart.
      remember(key); seen.add(key);
      try {
        invoke(herdr, ['agent', 'send-keys', agent.pane_id, 'ctrl+e', 'ctrl+u', 'ctrl+u']);
        const checked = observe(workspacePath);
        const occupant = checked.agents.find((a) => a.pane_id === agent.pane_id);
        const currentRun = occupant && matchingRun(occupant, checked.runs);
        if (!currentRun || currentRun.id !== run.id || currentRun.report || currentRun.abandoned ||
            waitingOnRecord(checked, currentRun) || !FINISHED.has(occupant.agent_status) ||
            resumeKey(run, occupant) !== key || (currentRun.report_path && fs.existsSync(currentRun.report_path))) {
          log({ action: 'skip-resume', run: run.id, pane: agent.pane_id, why: 'worker or record changed after clearing wheel junk' });
          continue;
        }
        invoke(herdr, ['agent', 'prompt', agent.pane_id, RESUME]);
        log({ action: 'resumed', run: run.id, pane: agent.pane_id, seq: agent.state_change_seq, why: 'interrupted open run with only mouse-wheel escape text in the composer' });
      } catch (error) { log({ action: 'resume-failed', run: run.id, pane: agent.pane_id, error: error.message }); }
    }
    return plan;
  }
  return { tick, common };
}

export function discoverProject(directory, orgOverride, env = process.env) {
  const cwd = canonicalPath(directory);
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const first = r.stdout.split('\n').find((line) => line.startsWith('worktree '));
  if (!first) throw new Error('no canonical Git checkout');
  const checkout = canonicalPath(first.slice(9));
  const org = orgOverride ? path.resolve(orgOverride) : findOrgDir({ cwd, env }) ?? findOrgDir({ cwd: checkout, env });
  const branch = spawnSync('git', ['-C', checkout, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' });
  if (branch.status !== 0) throw new Error('canonical checkout is detached; supply an attached project checkout');
  const identity = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (identity.status !== 0) throw new Error('cannot establish repository identity');
  const common = fs.realpathSync(identity.stdout.trim());
  return { cwd: checkout, org, main: branch.stdout.trim(), common };
}

async function main() {
  const { values: opt } = parseArgs({ options: {
    cwd: { type: 'string', default: process.cwd() }, org: { type: 'string' }, config: { type: 'string' },
    main: { type: 'string' }, 'state-dir': { type: 'string' },
    herdr: { type: 'string', default: 'herdr' }, 'org-cli': { type: 'string' },
    resume: { type: 'boolean' }, once: { type: 'boolean' }, loop: { type: 'boolean' }, start: { type: 'boolean' }, 'dry-run': { type: 'boolean', default: false },
  } });
  if ([opt.once, opt.loop, opt.start].filter(Boolean).length !== 1) throw new Error('usage: housekeeping.mjs (--start|--once|--loop) [--cwd PROJECT] [--org DIR] [--config FILE] [--dry-run] [--state-dir DIR]');
  if (opt.resume && !opt.start) throw new Error('--resume requires --start');
  const project = discoverProject(opt.cwd, opt.org);
  if (!project?.org) { process.stdout.write(`${JSON.stringify({ action: project ? 'no-record' : 'no-project', cwd: project?.cwd ?? opt.cwd })}\n`); return; }
  const script = fs.realpathSync(SELF);
  const recordCLI = opt['org-cli'] ? [executablePath(opt['org-cli'])] : [fs.realpathSync(process.execPath), fs.realpathSync(LOCAL_RECORD)];
  if (!opt['dry-run']) {
    for (const file of [script, ...recordCLI]) requireStableRuntime(file);
    if (gitCheckout(canonicalPath(opt.cwd)) !== project.cwd) {
      throw new Error('run live housekeeping from the canonical project checkout; lane workers use --once --dry-run');
    }
  }
  const cwd = project.cwd, configFile = path.resolve(opt.config ?? path.join(cwd, '.housekeeping.json'));
  // Keep a project with no ignore/config setup clean. Bookkeeping lives beside
  // the discovered record, separated by canonical repository identity.
  const key = createHash('sha256').update(project.common).digest('hex');
  const stateDir = path.resolve(opt['state-dir'] ?? path.join(project.org, 'housekeeping', key));
  const config = readConfig(configFile);
  if (!config.enabled && !opt['dry-run']) { process.stdout.write(`${JSON.stringify({ action: 'disabled' })}\n`); return; }
  fs.mkdirSync(stateDir, { recursive: true });
  const log = (entry) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    fs.appendFileSync(path.join(stateDir, 'actions.jsonl'), line);
    process.stdout.write(line);
  };
  const lock = path.join(stateDir, 'lock');
  if (opt.start) {
    if (opt['dry-run']) { log({ action: 'would-start', cwd, org: project.org }); return; }
    if (opt.resume && config.resume === false) { log({ action: 'resume-disabled' }); return; }
    const releaseStart = noticeLock(path.join(stateDir, 'start.lock'), { waitMs: 6500 });
    try {
      if (fs.existsSync(lock)) {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || owner.cwd !== cwd || owner.org !== project.org || owner.config !== configFile) throw new Error('housekeeping lock belongs to a different project/record/config');
        if (typeof owner.script !== 'string' || !Array.isArray(owner.record_cli) || !owner.record_cli.length) {
          throw new Error(`housekeeping lock has no runtime identity; inspect ${lock} before restarting`);
        }
        if ([owner.script, ...owner.record_cli].some((file) => typeof file !== 'string' || !fs.existsSync(file))) {
          throw new Error(`stale housekeeping runtime path; inspect ${lock} before restarting`);
        }
        if (owner.script !== script || JSON.stringify(owner.record_cli) !== JSON.stringify(recordCLI)) {
          throw new Error(`housekeeping lock belongs to a different runtime; inspect ${lock} before restarting`);
        }
        if (ownerAlive(owner)) { log({ action: 'already-running', pid: owner.pid, state_dir: stateDir }); return; }
        if (!opt.resume) throw new Error(`stale housekeeping lock for pid ${owner.pid}; inspect ${lock} before removing it`);
        // Only the validated matching runtime with a confirmed dead owner is recoverable.
        fs.rmSync(lock, { recursive: true });
        log({ action: 'recovered-dead-owner', pid: owner.pid, state_dir: stateDir });
      }
      const args = ['--cwd', cwd, '--org', project.org, '--config', configFile, '--state-dir', stateDir,
        '--main', opt.main ?? project.main, '--herdr', opt.herdr,
        ...(opt['org-cli'] ? ['--org-cli', recordCLI[0]] : [])];
      const output = fs.openSync(path.join(stateDir, 'schedule.log'), 'a');
      const child = spawn(process.execPath, [script, ...args, '--loop'], {
        cwd, detached: true, stdio: ['ignore', output, output, 'ipc'],
        // A detached timer owns no pane/tab. Inheriting its first worker's tab
        // would permanently exempt that worker after it finishes.
        env: { ...process.env, HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' },
      });
      fs.closeSync(output);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.disconnect(); child.unref(); reject(new Error('schedule startup unconfirmed; inspect schedule.log before retrying')); }, loadTimeout(5000));
        child.once('message', (message) => {
          clearTimeout(timer); child.disconnect(); child.unref();
          if (message?.ready) { log({ action: 'started', pid: child.pid, state_dir: stateDir }); resolve(); }
          else reject(new Error('schedule startup failed'));
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`schedule exited ${code}; inspect schedule.log`)); });
      });
      return;
    } finally { releaseStart(); }
  }
  const identity = ownerIdentity(process.pid);
  fs.mkdirSync(lock); // Fail closed on overlap or an unrecovered crash.
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, identity, cwd, org: project.org, config: configFile,
    script, record_cli: recordCLI }));
  let stopped = false, wake;
  const stop = () => { stopped = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const seenFile = path.join(stateDir, 'resume-attempts.jsonl');
    const seen = new Set(fs.existsSync(seenFile) ? fs.readFileSync(seenFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
    const runner = createHousekeeping({ cwd, org: project.org, main: opt.main ?? project.main, herdr: opt.herdr, log,
      record: recordCLI, stateDir });
    process.send?.({ ready: true });
    let lastCleanup = -Infinity;
    do {
      let config;
      try {
        config = readConfig(configFile);
        if (!config.enabled && !opt['dry-run']) { log({ action: 'disabled' }); break; }
        tidyFinishedTabs({ cwd, org: project.org, herdr: opt.herdr, record: recordCLI,
          dryRun: opt['dry-run'], log });
        if (!opt['dry-run']) {
          const pid = await resumeInbox(inboxPath({ org: project.org, cwd }));
          if (pid) log({ action: 'supervisor-inbox-owned', pid });
        }
        const cleanup = Date.now() - lastCleanup >= config.cleanup_seconds * 1000;
        runner.tick({ cleanup, resume: config.resume !== false, dryRun: opt['dry-run'], seen,
          remember: (key) => fs.appendFileSync(seenFile, `${JSON.stringify(key)}\n`) });
        if (cleanup) lastCleanup = Date.now();
      } catch (error) {
        log({ action: 'error', error: error.message });
        if (opt.once) throw error;
        // Invalid config switches off; an absent override uses defaults.
        if (!config) break;
      }
      if (opt.once || stopped) break;
      await new Promise((resolve) => { const timer = setTimeout(resolve, config.tick_seconds * 1000); wake = () => { clearTimeout(timer); resolve(); }; });
    } while (!stopped);
  } finally {
    fs.rmSync(lock, { recursive: true });
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
if (isMain(import.meta.url)) {
  main().catch((error) => { console.error(`housekeeping: ${error.message}`); process.exitCode = 1; });
}
