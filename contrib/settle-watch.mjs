#!/usr/bin/env node
// settle-watch: wait for one org run's worker to stop, then open a fresh settle
// session to handle the result. Pilot tooling, deliberately outside the org core:
// it knows about Herdr, lane configuration and Claude; org does not.
//
// No model is involved while waiting. `herdr agent wait` blocks inside the Herdr
// server, so there is no polling loop here.
//
//   settle-watch.mjs R-n --org DIR --cwd CHECKOUT --lane-config FILE --checklist FILE [--ledger-dir DIR] [--dry-run]
//   settle-watch.mjs R-n ... --spawn     # open a visible "watch R-n" tab and run there
//   settle-watch.mjs --open [--focus TEXT] ...   # open a "continue" executive session now
//
// Brakes: a STOP file in --ledger-dir blocks every new session, and at most
// --max-sessions-per-day sessions are opened per local day there. The ledger
// defaults to the checklist's directory for compatibility with older callers.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRetirement } from '../supervisor/retire.mjs';
import { parseArgs } from '../lib/cli-help.mjs';

const SELF = fileURLToPath(import.meta.url);
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: 'string' },
    cwd: { type: 'string' },
    'lane-config': { type: 'string' },
    checklist: { type: 'string' },
    'ledger-dir': { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    account: { type: 'string' },
    'permission-mode': { type: 'string', default: 'auto' },
    launcher: { type: 'string', default: path.join(os.homedir(), 'bin/ai') },
    'cmem-domain': { type: 'string', default: path.join(os.homedir(), 'development/claude-mem/bin/cmem-domain') },
    spawn: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    focus: { type: 'string' },
    'max-sessions-per-day': { type: 'string', default: '12' },
    'add-dir': { type: 'string', multiple: true, default: [] },
    'close-tab-on-exit': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const runId = positionals[0];
if ((opt.open ? runId !== undefined : !/^R-\d+$/.test(runId ?? '')) || !opt.org || !opt.cwd || !opt['lane-config'] || !opt.checklist) {
  console.error('usage: settle-watch.mjs (R-n [--spawn] | --open [--focus TEXT]) --org DIR --cwd CHECKOUT --lane-config FILE --checklist FILE [--ledger-dir DIR] [--account NAME] [--model M] [--effort E] [--dry-run]');
  process.exit(2);
}
const dry = opt['dry-run'];
const subject = runId ?? 'executive';

const log = (msg) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`);
const die = (msg) => { log(`STOP: ${msg}`); notify(`settle-watch ${subject}: stopped`, msg); process.exit(1); };

// Model and effort come from the lane config's route table so there is one place
// to tune what each role costs, and the console can show the same names. --model
// and --effort still override for a single launch; the old flat opus/high remains
// the fallback when a route is missing, so a stale config never silently downgrades.
const ROUTE_FOR = { settle: 'settle', continue: 'executive' };
function route(mode) {
  const key = ROUTE_FOR[mode] ?? mode;
  let routes = {};
  try { routes = JSON.parse(fs.readFileSync(opt['lane-config'], 'utf8')).routes ?? {}; }
  catch (err) { log(`route table unreadable (${err.message}); using opus/high`); }
  const r = routes[key] ?? {};
  // Two kinds are supported: claude (the original) and codex (added 2026-09-20 so the
  // settle loop keeps running while the Claude plan is exhausted). Anything else dies.
  const kind = r.kind ?? 'claude';
  if (kind !== 'claude' && kind !== 'codex') die(`route "${key}" is kind "${r.kind}", but settle-watch only starts claude or codex sessions`);
  if (!routes[key]) log(`no "${key}" route in ${opt['lane-config']}; using opus/high`);
  // For codex the effort travels as `-c model_reasoning_effort=…`; a route may carry its
  // own args (profile, extra -c), and the lane config's always_args.codex are appended
  // unless the same option is already present — the rule lane.mjs dispatch applies.
  let alwaysCodex = [];
  try { alwaysCodex = JSON.parse(fs.readFileSync(opt['lane-config'], 'utf8')).always_args?.codex ?? []; } catch {}
  return { key, kind, model: opt.model ?? r.model ?? 'opus', effort: opt.effort ?? r.effort ?? 'high', args: r.args ?? [], alwaysCodex };
}

function run(cmd, args, { env, quiet } = {}) {
  // Node's default 1 MB output cap killed a watcher once the org record grew (ENOBUFS).
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (!quiet && r.status !== 0) log(`${cmd} ${args[0]} ${args[1] ?? ''} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r;
}

function herdr(args, env) {
  const r = run('herdr', args, { quiet: true, env });
  let body;
  try { body = JSON.parse(r.stdout); } catch { body = null; }
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() || `exit ${r.status}` };
  return { ok: true, result: body?.result ?? {} };
}

// Mutating calls go through here so --dry-run can show them without acting.
function act(label, cmd, args, opts) {
  if (dry) { log(`[dry-run] ${label}: ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`); return { ok: true, result: {} }; }
  if (cmd === 'herdr') return herdr(args, opts?.env);
  const r = run(cmd, args, opts);
  return { ok: r.status === 0, stdout: r.stdout };
}

function notify(title, body) {
  if (dry) return log(`[dry-run] notify: ${title} — ${body}`);
  run('herdr', ['notification', 'show', title, '--body', body, '--sound', 'request'], { quiet: true });
}

const orgEnv = { ORG_DIR: opt.org };
// Only the watched run: the whole status document grows with the organization.
function orgRun() {
  const r = run('org', ['show', runId, '--json'], { env: orgEnv, quiet: true });
  if (r.status !== 0) {
    if (/unknown item or run/.test(r.stderr)) return undefined;
    die(`org show ${runId} failed for ${opt.org}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return JSON.parse(r.stdout);
}

function agentStatus(name) {
  const r = herdr(['agent', 'get', name]);
  return r.ok ? r.result.agent?.agent_status ?? 'unknown' : null; // null: the agent is gone
}

function waitFor(name, states) {
  if (dry) { log(`[dry-run] would block: herdr agent wait ${name} ${states.map((s) => `--until ${s}`).join(' ')}`); return true; }
  log(`waiting for ${name} to reach ${states.join('|')} (no polling; Herdr blocks)`);
  return run('herdr', ['agent', 'wait', name, ...states.flatMap((s) => ['--until', s])], { quiet: true }).status === 0;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A failed wait must not turn into a busy loop.
const backoff = () => { log('herdr agent wait failed; retrying in 30 s'); sleep(30_000); };

function reportReady(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

// The workspace whose canonical checkout is --cwd. Ids can change across Herdr
// restarts, so resolve at use time rather than configuring one.
function workspaceId() {
  const r = herdr(['workspace', 'list']);
  if (!r.ok) die(`herdr workspace list failed: ${r.error}`);
  const want = path.resolve(opt.cwd);
  const ws = r.result.workspaces.find((w) => w.worktree && !w.worktree.is_linked_worktree && path.resolve(w.worktree.checkout_path) === want);
  if (!ws) die(`no Herdr workspace has ${want} as its canonical checkout`);
  return ws.workspace_id;
}

function newTab(label, env) {
  const args = ['tab', 'create', '--workspace', workspaceId(), '--cwd', opt.cwd, '--label', label, '--no-focus'];
  for (const e of env) args.push('--env', e);
  const r = act('open tab', 'herdr', args);
  if (!r.ok) die(`could not open tab "${label}": ${r.error}`);
  if (dry) return 'wXX:pX';
  if (!r.result.root_pane?.pane_id) die(`tab "${label}" opened but herdr returned no pane id`);
  return r.result.root_pane.pane_id;
}

// All retirement goes through the record/Git/job planner. In particular, a
// report file or a launched settle session cannot authorize closing its worker.
function retireTabs() {
  try {
    const retirement = createRetirement({ cwd: opt.cwd, org: opt.org,
      log: entry => log(JSON.stringify(entry)) });
    const plan = retirement.plan();
    for (const kept of plan.keep) log(`keep ${kept.tab_id}: ${kept.why}`);
    if (!dry) retirement.apply(plan);
  } catch (error) { log(`retirement kept panes: ${error.message}`); }
}
function closeOwnTab() {
  if (!opt['close-tab-on-exit'] || dry || !process.env.HERDR_TAB_ID || !process.env.HERDR_PANE_ID) return;
  try {
    const retirement = createRetirement({ cwd: opt.cwd, org: opt.org,
      selfRetirement: { tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID, pid: process.pid },
      log: entry => log(JSON.stringify(entry)) });
    const plan = retirement.plan();
    retirement.apply({ ...plan, close: plan.close.filter(t => t.tab_id === process.env.HERDR_TAB_ID) });
    for (const kept of plan.keep.filter(t => t.tab_id === process.env.HERDR_TAB_ID)) log(`keep ${kept.tab_id}: ${kept.why}`);
  } catch (error) { log(`self-retirement kept watcher: ${error.message}`); }
}
const finish = (msg) => { if (msg) log(msg); closeOwnTab(); process.exit(0); };
function closeWorkerTab() { retireTabs(); }
function pruneSessionTabs() { retireTabs(); }

// --spawn: run this same watcher inside a visible tab, so it outlives whoever armed it.
if (opt.spawn && !opt.open) {
  const argv = process.argv.slice(2).filter((a) => a !== '--spawn').concat('--close-tab-on-exit');
  const command = [process.execPath, SELF, ...argv].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const pane = newTab(`watch ${runId}`, []);
  if (!dry) sleep(3_000);
  const r = act('start watcher', 'herdr', ['pane', 'run', pane, command]);
  if (!r.ok) die(`could not start the watcher in ${pane}: ${r.error}`);
  log(`watcher for ${runId} running in pane ${pane}`);
  process.exit(0);
}

// A lock holder exists while signal 0 reaches it or is refused with EPERM (another user or a
// sandboxed caller); only a missing process makes a lock stale.
const holderExists = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// One watcher per run.
const lock = path.join(os.tmpdir(), `settle-watch-${crypto.createHash('sha256').update(path.resolve(opt.org)).digest('hex').slice(0, 12)}-${runId}.lock`);
if (!dry && !opt.open) {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (holderExists(pid)) die(`another watcher (pid ${pid}) already owns ${runId}`);
  } catch { /* no lock */ }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} });
}
if (!dry && !opt.open && process.env.HERDR_TAB_ID && process.env.HERDR_PANE_ID) {
  try { createRetirement({ cwd: opt.cwd, org: opt.org }).recordCallback({ kind: 'watcher', pane: process.env.HERDR_PANE_ID, pid: process.pid, run: runId }); }
  catch (error) { log(`watcher launch receipt unavailable: ${error.message}`); }
}

// Account and memory settings exactly as `ai claude` would choose them in --cwd.
// Herdr starts the canonical `claude` binary, bypassing the launcher, so without
// this the session falls back to the default config dir (a different login).
const PERSONA_VARS = ['AI_PERSONA', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'CODEX_HOME'];
function launchSettings() {
  const clean = { ...process.env };
  for (const v of PERSONA_VARS) delete clean[v];
  const personaArgs = opt.account ? ['env', opt.account] : ['env'];
  const persona = spawnSync(opt.launcher, personaArgs, { cwd: opt.cwd, env: clean, encoding: 'utf8' });
  const env = (persona.stdout ?? '').split('\n').filter((l) => PERSONA_VARS.some((v) => l.startsWith(`${v}=`)));
  if (persona.status !== 0 || !env.some((l) => l.startsWith('CLAUDE_CONFIG_DIR='))) {
    die(`${opt.launcher} env ${opt.account ?? ''} did not yield CLAUDE_CONFIG_DIR for ${opt.cwd}; refusing to start a session on an unknown account`);
  }
  const args = [];
  const mem = spawnSync(opt['cmem-domain'], ['launch-args', 'claude', opt.cwd], { encoding: 'utf8' });
  if (mem.status === 0) {
    for (const line of mem.stdout.split('\n')) {
      if (line.startsWith('env ')) env.push(line.slice(4));
      else if (line.startsWith('arg ')) args.push(line.slice(4));
    }
  } else {
    const cfg = JSON.parse(fs.readFileSync(opt['lane-config'], 'utf8'));
    log(`cmem-domain unavailable (${(mem.stderr || '').trim().slice(0, 120)}); using ${opt['lane-config']} memory settings`);
    env.push(...(cfg.dispatch?.env ?? []));
    args.push(...(cfg.always_args?.claude ?? []));
  }
  env.push(`ORG_DIR=${opt.org}`, 'MONITOR_ENTRY_BYPASS=1');
  return { env, args };
}

// Brakes checked before any session opens.
const supervisorDir = path.resolve(opt['ledger-dir'] ?? path.dirname(path.resolve(opt.checklist)));
function prepareSupervisorDir() {
  if (dry) return;
  try {
    fs.mkdirSync(supervisorDir, { recursive: true });
  } catch (err) {
    die(`could not create ledger directory ${supervisorDir}: ${err.message}`);
  }
}
function brakes() {
  const stop = path.join(supervisorDir, 'STOP');
  if (fs.existsSync(stop)) die(`${stop} exists, so no session was opened (delete it to resume; the work is untouched)`);
  const ledger = path.join(supervisorDir, `sessions-${new Date().toLocaleDateString('sv')}.log`);
  const count = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0;
  const max = Number(opt['max-sessions-per-day']);
  if (count >= max) die(`${count} sessions already opened today (limit ${max}), so no session was opened for ${subject}`);
  log(`session ${count + 1} of at most ${max} today`);
  return ledger;
}

// Sessions take turns: a second session deciding at the same time could launch
// the same ready work twice. Hold a short lock across check-and-start; once a
// session is started and prompted it shows as working, which the next check sees.
const openLock = path.join(supervisorDir, '.session-open.lock');
function takeTurn() {
  if (dry) return;
  for (;;) {
    try {
      fs.mkdirSync(openLock);
      fs.writeFileSync(path.join(openLock, 'pid'), String(process.pid));
      process.on('exit', () => { try { if (fs.readFileSync(path.join(openLock, 'pid'), 'utf8') === String(process.pid)) fs.rmSync(openLock, { recursive: true }); } catch {} });
    } catch {
      let holder = NaN;
      try { holder = Number(fs.readFileSync(path.join(openLock, 'pid'), 'utf8')); } catch {}
      if (!holderExists(holder)) { try { fs.rmSync(openLock, { recursive: true }); } catch {} continue; }
      log(`another watcher (pid ${holder}) is opening a session; waiting`);
      sleep(10_000);
      continue;
    }
    const agents = herdr(['agent', 'list']).result?.agents ?? [];
    const busy = agents.filter((a) => /^(settle-|exec-)/.test(a.name ?? '') && a.agent_status === 'working');
    if (busy.length === 0) return;
    fs.rmSync(openLock, { recursive: true });
    log(`waiting for ${busy.map((a) => a.name).join(', ')} to finish before opening another session`);
    for (const a of busy) if (!waitFor(a.name, ['idle', 'done', 'blocked'])) backoff();
  }
}
const releaseTurn = () => { if (!dry) try { fs.rmSync(openLock, { recursive: true }); } catch {} };

function openSession({ mode, r }) {
  prepareSupervisorDir();
  takeTurn();
  const ledger = brakes();
  pruneSessionTabs();
  const { env, args: extra } = launchSettings();
  log(`launch env: ${env.map((e) => e.split('=')[0] === 'CLAUDE_CONFIG_DIR' || e.startsWith('AI_PERSONA') ? e : e.split('=')[0]).join(' ')}`);
  const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
  const name = mode === 'settle' ? `settle-${runId.toLowerCase()}-${hhmm}` : `exec-${hhmm}`;
  const label = mode === 'settle' ? `settle ${runId}` : 'executive';
  // org records this session as the actor, so its answers are not mistaken for the operator's.
  env.push(`ORG_ACTOR=${name}`);

  const pick = route(mode);
  log(`route ${pick.key}: model ${pick.model}, effort ${pick.effort}${opt.account ? `, account ${opt.account}` : ''}`);

  const pane = newTab(label, env);
  let startArgs;
  if (pick.kind === 'codex') {
    // codex CLI: -m <model> -c model_reasoning_effort=<effort> [route args] [always_args.codex].
    // No --add-dir / --permission-mode / --name: those are claude flags. Route args come
    // after the effort so a route's own -c can override it.
    const codexArgs = ['-m', pick.model, '-c', `model_reasoning_effort=${pick.effort}`, ...pick.args];
    const groups = [];
    for (const token of pick.alwaysCodex) {
      if (token.startsWith('-') || groups.length === 0) groups.push([token]); else groups.at(-1).push(token);
    }
    for (const [option, ...values] of groups) {
      if (!codexArgs.some((a) => a === option || a.startsWith(`${option}=`))) codexArgs.push(option, ...values);
    }
    startArgs = ['agent', 'start', name, '--kind', 'codex', '--pane', pane, '--timeout', '120000', '--', ...codexArgs];
  } else {
    startArgs = ['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--',
      ...extra, ...opt['add-dir'].flatMap((d) => ['--add-dir', d]),
      '--model', pick.model, '--effort', pick.effort, '--permission-mode', opt['permission-mode'], '--name', name];
  }
  let started;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!dry) sleep(3_000); // a new tab's shell needs a moment to reach its prompt
    // Herdr takes the agent's config dir (CLAUDE_CONFIG_DIR) from the caller of
    // `agent start`, not from the tab, so the account must be in this call's env.
    started = act('start agent', 'herdr', startArgs, { env: Object.fromEntries(env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])) });
    if (started.ok) break;
    log(`agent start attempt ${attempt} failed: ${started.error}`);
  }
  if (!started.ok) die(`settle session did not start in ${pane}: ${started.error}`);
  if (!dry) try { createRetirement({ cwd: opt.cwd, org: opt.org }).recordCallback({
    kind: mode === 'settle' ? 'settle' : 'executive', pane, agent: name, ...(runId ? { run: runId } : {}) }); }
  catch (error) { log(`session launch receipt unavailable: ${error.message}`); }
  const want = env.find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
  if (!dry && want && pick.kind === 'claude') {
    const shell = herdr(['pane', 'process-info', '--pane', pane]).result?.process_info?.shell_pid;
    const kids = shell ? run('pgrep', ['-P', String(shell)], { quiet: true }).stdout.trim().split('\n').filter(Boolean) : [];
    const envs = kids.map((k) => run('ps', ['eww', '-o', 'command=', '-p', k], { quiet: true }).stdout);
    if (!envs.some((e) => e.split(' ').includes(want))) log(`WARNING: ${name} does not show ${want} in its environment; check which account it is using`);
    else log(`${name} is running with ${want}`);
  }

  if (!dry) fs.appendFileSync(ledger, `${new Date().toTimeString().slice(0, 8)} ${name} ${mode} ${runId ?? ''}\n`);

  const prompt = (mode === 'settle' ? [
    `You are a fresh, short-lived orchestrator for this project. Read ${opt.checklist} and follow it exactly.`,
    `Mode: settle. The run that just stopped is ${runId} (worker ${r.meta.agent}, report ${r.report_path}).`,
    r.meta.legacy_brief ? 'It is a legacy run: its report has no org front matter; see the checklist.' : '',
  ] : [
    `You are a fresh, short-lived orchestrator for this project. Read ${opt.checklist} and follow it exactly.`,
    'Mode: continue. No run just stopped: act on pending decisions and ready work within your authority.',
    opt.focus ? `Focus: ${opt.focus}` : '',
  ]).concat(`ORG_DIR=${opt.org}`).filter(Boolean).join(' ');
  const prompted = act('prompt agent', 'herdr', ['agent', 'prompt', name, prompt]);
  if (!prompted.ok) die(`settle session ${name} started but was not prompted: ${prompted.error}`);
  if (!dry) herdr(['agent', 'wait', name, '--until', 'working', '--timeout', '60000']);
  releaseTurn();
  if (!dry) {
    sleep(15_000);
    const screen = run('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--format', 'text'], { quiet: true }).stdout ?? '';
    if (/Please run \/login|Not logged in|Login expired|Invalid API key/i.test(screen)) {
      die(`session ${name} is not logged in (tab "${label}"); nothing was done`);
    }
    if (agentStatus(name) !== 'working') log(`note: ${name} is ${agentStatus(name)} 15 s after its prompt`);
  }

  if (mode === 'settle') {
    act('record hand-off', 'org', ['set', runId, `settled_by=${name}`], { env: orgEnv });
    notify(`${runId} is ready to settle`, `Worker ${r.meta.agent} stopped; fresh session ${name} opened in tab "${label}".`);
    log(`${dry ? '[dry-run] would hand' : 'handed'} ${runId} to ${name}`);
  } else {
    notify('bch-cloak executive session opened', `${name} in tab "${label}"${opt.focus ? `: ${opt.focus}` : ''}`);
    log(`${dry ? '[dry-run] would open' : 'opened'} executive session ${name}`);
  }
}

// --open: a continue session now, no run to follow.
if (opt.open) {
  openSession({ mode: 'continue' });
  process.exit(0);
}

// Main: follow one worker until it stops with a report, then hand off.
const initial = orgRun();
if (!initial) die(`${runId} is not in ${opt.org}`);
if (initial.report) finish(`${runId} already has a recorded report; nothing to watch`);
if (initial.abandoned) finish(`${runId} was abandoned; nothing to watch`);
if (initial.meta.settled_by) {
  if (agentStatus(initial.meta.settled_by) !== null) finish(`${runId} is already with live session ${initial.meta.settled_by}`);
  log(`${runId} was handed to ${initial.meta.settled_by}, which no longer exists; handing it again`);
}
const handedTo = initial.meta.settled_by ?? null;
const agent = initial.meta.agent;
if (!agent) die(`${runId} has no agent recorded (org set ${runId} agent=<name>)`);
log(`watching ${runId}: worker ${agent}, report ${initial.report_path}`);

if (dry) {
  log(`[dry-run] worker is ${agentStatus(agent) ?? 'gone'}; report ${reportReady(initial.report_path) ? 'exists' : 'not written yet'}`);
  waitFor(agent, ['idle', 'done', 'blocked']);
  log('[dry-run] when it stops with a report, the watcher would do this:');
  openSession({ mode: 'settle', r: initial });
  process.exit(0);
}

let notified = null; // the state we last told the operator about
for (;;) {
  const state = agentStatus(agent);
  const r = orgRun();
  if (r.report || (r.meta.settled_by && r.meta.settled_by !== handedTo)) { retireTabs(); finish(`${runId} was settled elsewhere`); }

  if (state === 'working' || state === 'unknown') {
    notified = null;
    if (!waitFor(agent, ['idle', 'done', 'blocked'])) backoff();
    continue;
  }
  if (state === 'blocked') {
    if (notified !== 'blocked') notify(`${runId} needs you`, `Worker ${agent} is blocked (a permission prompt or a question).`);
    notified = 'blocked';
    if (!waitFor(agent, ['working'])) backoff();
    continue;
  }
  if (reportReady(r.report_path)) {
    // Preserve the legacy settle handoff (including legacy report formats).
    // The shared planner independently requires ingestion before any close.
    openSession({ mode: 'settle', r });
    closeWorkerTab(agent);
    finish();
  }
  if (state === null) die(`worker ${agent} is gone and no report exists at ${r.report_path}`);
  if (notified !== 'no-report') notify(`${runId} stopped without a report`, `Worker ${agent} is ${state} but ${r.report_path} does not exist yet.`);
  notified = 'no-report';
  if (!waitFor(agent, ['working'])) backoff();
}
