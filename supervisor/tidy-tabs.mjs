#!/usr/bin/env node
// tidy-tabs: close the Herdr tabs a project's loop has finished with, so they
// don't pile up. Supervisor housekeeping; no model is involved.
//
//   tidy-tabs.mjs --cwd CHECKOUT [--org DIR] [--ledger-dir DIR] [--keep-sessions N] [--dry-run]
//
// Closes, in the canonical checkout's workspace and its lane workspaces:
//   - "watch R-n" / "deliver R-n" tabs whose script has exited (only a shell is left);
//   - finished session tabs ("settle R-n", "executive", "plan", "audit") whose
//     settle-/exec-/plan-/audit- agent is idle or done, keeping the newest N (default 1);
//   - lane worker tabs whose lane-* agents are idle or done and whose runs have a
//     recorded report in org (needs --org), or whose review sessions have a
//     newer verdict record under docs/reviews/<topic>/.
// Never closes a tab with a working, blocked or unnamed agent (an operator's chat),
// a tab with any other running program, an unrecognized tab, or the tab it runs in.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { loadTimeout } from '../lib/deadline.mjs';

const WATCHER = /^(watch|deliver) R-\d+$/;
const SESSION_LABEL = /^(settle R-\d+|executive|plan|audit)$/;
const SESSION_AGENT = /^(settle|exec|plan|audit)-/;
const FINISHED = new Set(['idle', 'done']);
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish']);
const canonicalPath = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);

function matchingOccupant(agent, { pane, workspace, cwd, terminal_id, agent_session_id }) {
  return Boolean(pane && pane === agent.pane_id && workspace && workspace === agent.workspace_id &&
    cwd && agent.cwd && canonicalPath(cwd) === canonicalPath(agent.cwd) &&
    (terminal_id || agent_session_id) &&
    (!terminal_id || terminal_id === agent.terminal_id) &&
    (!agent_session_id || agent_session_id === agent.agent_session?.value));
}

// Names locate the newest record; pane, workspace, cwd and immutable occupant
// identity prove that it belongs to the live worker. Session metadata cannot
// supply missing record evidence.
export function matchingRun(agent, runs) {
  const matches = runs.filter((r) => r.meta?.agent === agent.name);
  matches.sort((a, b) => (b.started?.seq ?? 0) - (a.started?.seq ?? 0));
  if (!matches.length || (matches[1] && matches[0].started?.seq === matches[1].started?.seq)) return null;
  const run = matches[0], meta = run.meta;
  if (!matchingOccupant(agent, { ...meta, workspace: meta.worker_workspace, cwd: run.workspace })) return null;
  return run;
}

export function waitingOnRecord(snapshot, run) {
  const item = snapshot.items.find((i) => i.id === run.item);
  return !item || ['blocked', 'needs_human'].includes(item.status) ||
    ['blocked', 'needs_human'].includes(run.report?.outcome) ||
    (item.blocked_by ?? []).some((id) => {
      const blocker = snapshot.items.find((i) => i.id === id);
      return !blocker || !['done', 'dropped'].includes(blocker.status) ||
        (blocker.closed && blocker.meta?.answer === 'no');
    });
}

export function reportedAgentsFromRecords(agents, runs, items) {
  const eligible = new Set(), ineligible = new Set();
  for (const agent of agents) {
    const run = matchingRun(agent, runs);
    (run?.report && !waitingOnRecord({ items }, run) ? eligible : ineligible).add(agent.name);
  }
  // Duplicate observations of a reused name must all match the record; one
  // valid occupant cannot authorize a mismatched second occupant.
  return new Set([...eligible].filter((name) => !ineligible.has(name)));
}

// Pure: decide which tabs to close from one observation of Herdr, org and the ledger.
// snapshot = { tabs: [{tab_id, label, workspace_id, lane}], panes: [{pane_id, tab_id, shellOnly}],
//   agents: [{name, status, pane_id}], reportedAgents: Set<name>, reviewedAgents: Set<name>,
//   sessionOrder: Map<name, sortKey>,
//   selfTab, keepSessions }
export function planTidy(snapshot) {
  const {
    tabs, panes, agents, reportedAgents = new Set(), reviewedAgents = new Set(),
    sessionOrder = new Map(), selfTab = null, keepSessions = 1, workerEligibility = null,
  } = snapshot;
  const close = [];
  const keep = [];
  const sessionCandidates = [];
  for (const tab of tabs) {
    const skip = (why) => keep.push({ tab_id: tab.tab_id, label: tab.label, why });
    if (tab.tab_id === selfTab) { skip('this tab'); continue; }
    const tabPanes = panes.filter((p) => p.tab_id === tab.tab_id);
    // Closing the UI's selected tab moves operator focus to a neighbour. Keep
    // it even when its worker is finished; the next background tick can close it.
    if (tab.focused || tabPanes.some((p) => p.focused)) { skip('operator is focused here'); continue; }
    const tabAgents = agents.filter((a) => a.tab_id === tab.tab_id || tabPanes.some((p) => p.pane_id === a.pane_id));
    if (!tabPanes.length) { skip('no panes observed'); continue; }
    if (tabAgents.some((a) => !a.name)) { skip('an unnamed agent (an operator chat) is here'); continue; }
    if (tabAgents.some((a) => !FINISHED.has(a.status))) { skip('an agent here is still active'); continue; }
    // Herdr enumerations are separate calls. A later agent can reveal a new
    // pane or a moved pane that was absent from the earlier topology.
    if (tabAgents.some((a) => !tabPanes.some((p) => p.pane_id === a.pane_id) ||
        (a.tab_id && a.tab_id !== tab.tab_id) ||
        (a.workspace_id && a.workspace_id !== tab.workspace_id)) ||
        tabPanes.some((p) => (p.workspace_id && p.workspace_id !== tab.workspace_id) ||
          panes.some((other) => other.pane_id === p.pane_id && other.tab_id !== tab.tab_id))) {
      skip('agent and pane topology disagree'); continue;
    }
    const bareShells = tabPanes.filter((p) => !agents.some((a) => a.pane_id === p.pane_id));
    if (bareShells.some((p) => !p.shellOnly)) { skip('a program is still running here'); continue; }

    if (!tab.lane && WATCHER.test(tab.label)) {
      if (tabAgents.length) skip('an agent is in a watcher tab');
      else close.push({ tab_id: tab.tab_id, label: tab.label, why: 'the watcher has exited' });
      continue;
    }
    // Housekeeping supplies record + Git authorization, keyed by live pane.
    // Its strict mode never falls back to labels, review files or session metadata.
    if (workerEligibility !== null) {
      if (tabAgents.length && tabAgents.every((a) => workerEligibility.has(a.pane_id))) {
        close.push({ tab_id: tab.tab_id, label: tab.label,
          why: tabAgents.map((a) => workerEligibility.get(a.pane_id)).join('; ') });
      } else skip('no settled recorded worker authorization for every agent');
      continue;
    }
    if (!tab.lane && SESSION_LABEL.test(tab.label)) {
      if (tabAgents.length && tabAgents.every((a) => SESSION_AGENT.test(a.name))) {
        sessionCandidates.push({ tab, key: Math.max(...tabAgents.map((a) => sessionOrder.get(a.name) ?? -Infinity)), names: tabAgents.map((a) => a.name) });
      } else skip('no finished session agent here');
      continue;
    }
    if (tab.lane && tabAgents.length && tabAgents.every((a) => a.name.startsWith('lane-'))) {
      const unrecorded = tabAgents.filter((a) => !reportedAgents.has(a.name) && !reviewedAgents.has(a.name));
      if (unrecorded.length) skip(`no recorded report for ${unrecorded.map((a) => a.name).join(', ')}`);
      else {
        const reviews = tabAgents.filter((a) => reviewedAgents.has(a.name) && !reportedAgents.has(a.name));
        const record = reviews.length === tabAgents.length ? 'review verdict' : 'result';
        close.push({ tab_id: tab.tab_id, label: tab.label, why: `worker finished and its ${record} is recorded (${tabAgents.map((a) => a.name).join(', ')})` });
      }
      continue;
    }
    skip('not a tab this tool manages');
  }
  sessionCandidates.sort((a, b) => b.key - a.key);
  sessionCandidates.forEach((c, i) => {
    if (i < keepSessions) keep.push({ tab_id: c.tab.tab_id, label: c.tab.label, why: 'newest finished session, kept for reading' });
    else close.push({ tab_id: c.tab.tab_id, label: c.tab.label, why: `session finished (${c.names.join(', ')})` });
  });
  return { close, keep };
}

// Pure: locate verdict evidence only; this does not authorize a live occupant.
// A review session has completion evidence only when a verdict for its lane topic is
// newer than the session. This prevents an earlier review round from closing a
// later review tab on the same lane.
export function reviewedAgentsFromRecords(sessions, reviewRecords) {
  const newest = new Map();
  for (const r of reviewRecords) {
    if (!r?.topic || !r.verdict || !Number.isFinite(r.mtimeMs)) continue;
    newest.set(r.topic, Math.max(newest.get(r.topic) ?? -Infinity, r.mtimeMs));
  }
  return new Set(sessions
    .filter((s) => /^review(?:-[a-z0-9][a-z0-9-]*)?$/.test(s?.role ?? '') && s?.name && s?.topic && Number.isFinite(Date.parse(s.created_at)))
    .filter((s) => (newest.get(s.topic) ?? -Infinity) > Date.parse(s.created_at))
    .map((s) => s.name));
}

// A verdict belongs to the recorded reviewer, never to a later occupant using
// its name. The registry records the lane branch rather than an absolute cwd;
// Git resolves that branch to its checkout. Registry metadata only constrains
// verdict evidence and cannot establish completion on its own.
export function reviewedOccupantsFromRecords(agents, sessions, reviewRecords, laneRoots, repoRoot) {
  const eligible = new Set(), ineligible = new Set();
  for (const agent of agents) {
    const matches = sessions.filter((s) => s.name === agent.name);
    matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const session = matches[0];
    const unambiguous = session && matches.every((s, i) => i === 0 ||
      (Number.isFinite(Date.parse(s.created_at)) && Date.parse(s.created_at) < Date.parse(session.created_at)));
    const complete = unambiguous && reviewedAgentsFromRecords([session], reviewRecords).has(agent.name);
    const matchesLive = complete && session.repo && canonicalPath(session.repo) === canonicalPath(repoRoot) && matchingOccupant(agent, {
      ...session, cwd: laneRoots.get(session.lane),
    });
    (matchesLive ? eligible : ineligible).add(agent.name);
  }
  return new Set([...eligible].filter((name) => !ineligible.has(name)));
}

export function reviewVerdict(text) {
  return /^\s*\*\*(PASS|NEEDS-WORK|FAIL)\*\*/.exec(text ?? '')?.[1] ?? null;
}

function laneSessions(checkout) {
  const dir = path.join(checkout, '.lane', 'sessions.json.d');
  const sessions = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.endsWith('.done.json')) continue;
      try { sessions.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))); } catch { /* incomplete session record */ }
    }
  } catch { /* no lane registry */ }
  return sessions;
}

function reviewRecords(roots) {
  const records = [];
  for (const root of new Set(roots)) {
    const reviews = path.join(root, 'docs', 'reviews');
    let topics;
    try { topics = fs.readdirSync(reviews, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const topic of topics) {
      const dir = path.join(reviews, topic.name);
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const full = path.join(dir, file);
        try {
          const verdict = reviewVerdict(fs.readFileSync(full, 'utf8'));
          records.push({ topic: topic.name, verdict, mtimeMs: fs.statSync(full).mtimeMs });
        } catch { /* a disappearing or unreadable record proves nothing */ }
      }
    }
  }
  return records;
}

// Ledger lines look like "HH:MM:SS name mode subject" in sessions-YYYY-MM-DD.log.
export function sessionOrderFromLedgers(files) {
  const order = new Map();
  for (const { day, text } of files) {
    for (const line of text.split('\n')) {
      const m = /^(\d{2}:\d{2}:\d{2}) (\S+)/.exec(line);
      if (m) order.set(m[2], Date.parse(`${day}T${m[1]}`));
    }
  }
  return order;
}

export function isShellOnly(processInfo) {
  const fg = processInfo?.foreground_processes ?? [];
  return fg.length > 0 && fg.every((p) => SHELLS.has(p.name) || SHELLS.has(p.argv0) || p.pid === processInfo.shell_pid);
}

function main() {
  const { values: opt } = parseArgs({
    options: {
      cwd: { type: 'string' },
      org: { type: 'string' },
      'ledger-dir': { type: 'string' },
      'keep-sessions': { type: 'string', default: '1' },
      herdr: { type: 'string', default: 'herdr' },
      'org-cli': { type: 'string', default: 'org' },
      'org-cli-arg': { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!opt.cwd) {
    console.error('usage: tidy-tabs.mjs --cwd CHECKOUT [--org DIR] [--ledger-dir DIR] [--keep-sessions N] [--dry-run]');
    process.exit(2);
  }
  const checkout = fs.realpathSync(opt.cwd);
  const invoke = (exe, args, env = process.env) => {
    const r = spawnSync(exe, args, { cwd: checkout, encoding: 'utf8', env,
      timeout: loadTimeout(10000), maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`${exe} ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.error?.message || r.stdout || `exit ${r.status}`).trim()}`);
    return r.stdout;
  };
  const herdr = (args) => {
    const data = JSON.parse(invoke(opt.herdr, args));
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result ?? data;
  };
  const array = (value, what) => {
    if (!Array.isArray(value)) throw new Error(`incomplete ${what}`);
    return value;
  };
  const commonAt = (root) => fs.realpathSync(invoke('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const common = commonAt(checkout);
  function observe() {
    const mine = array(herdr(['workspace', 'list']).workspaces, 'workspaces').filter((w) => {
      const wt = w.worktree;
      if (!wt?.checkout_path || !wt.repo_root || !wt.repo_key) return false;
      try {
        return fs.realpathSync(wt.repo_key) === common && commonAt(wt.repo_root) === common &&
          (!fs.existsSync(wt.checkout_path) || commonAt(wt.checkout_path) === common);
      } catch { return false; }
    });
    const tabs = [], panes = [];
    for (const w of mine) {
      for (const t of array(herdr(['tab', 'list', '--workspace', w.workspace_id]).tabs, 'tabs')) {
        tabs.push({ ...t, label: t.label ?? '', workspace_id: w.workspace_id, lane: Boolean(w.worktree.is_linked_worktree) });
      }
      for (const p of array(herdr(['pane', 'list', '--workspace', w.workspace_id]).panes, 'panes')) {
        const info = herdr(['pane', 'process-info', '--pane', p.pane_id]).process_info;
        if (!info || !Array.isArray(info.foreground_processes)) throw new Error('incomplete process info');
        panes.push({ ...p, shellOnly: isShellOnly(info) });
      }
    }
    const agents = array(herdr(['agent', 'list']).agents, 'agents').map((a) => ({ ...a, status: a.agent_status }));
    let reportedAgents = new Set(), recordedNames = new Set();
    if (opt.org) {
      const data = JSON.parse(invoke(opt['org-cli'], [...opt['org-cli-arg'], 'status', '--json'], { ...process.env, ORG_DIR: opt.org }));
      if (data.error) throw new Error(JSON.stringify(data.error));
      const runs = array((data.result ?? data).runs, 'record runs');
      const items = array((data.result ?? data).items, 'record items');
      reportedAgents = reportedAgentsFromRecords(agents, runs, items);
      // A review file cannot override a waiting/open run or a failed identity
      // match for a recorded worker with the same name.
      recordedNames = new Set(runs.map((run) => run.meta?.agent));
    }
    const laneRoots = new Map();
    for (const entry of invoke('git', ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
      const fields = entry.split('\0'), root = fields.find((f) => f.startsWith('worktree '))?.slice(9);
      const branch = fields.find((f) => f.startsWith('branch refs/heads/'))?.slice(18);
      if (root && branch) laneRoots.set(branch, root);
    }
    const reviewedAgents = new Set([...reviewedOccupantsFromRecords(agents, laneSessions(checkout),
      reviewRecords([checkout, ...mine.filter((w) => w.worktree.is_linked_worktree).map((w) => w.worktree.checkout_path)]), laneRoots, checkout)]
      .filter((name) => !recordedNames.has(name)));
    const ledgerDir = opt['ledger-dir'] ?? path.join(checkout, '.lane/supervisor');
    const ledgers = [];
    try {
      for (const f of fs.readdirSync(ledgerDir)) {
        const m = /^sessions-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
        if (m) ledgers.push({ day: m[1], text: fs.readFileSync(path.join(ledgerDir, f), 'utf8') });
      }
    } catch { /* no ledger: sessions are ordered as unknown */ }
    return { tabs, panes, agents, reportedAgents, reviewedAgents,
      sessionOrder: sessionOrderFromLedgers(ledgers), selfTab: process.env.HERDR_TAB_ID ?? null,
      keepSessions: Number(opt['keep-sessions']) };
  }
  const { close, keep } = planTidy(observe());
  if (opt['dry-run']) {
    for (const k of keep) console.log(`[dry-run] keep ${k.tab_id} "${k.label}": ${k.why}`);
  }
  let closed = 0;
  for (const c of close) {
    if (opt['dry-run']) { console.log(`[dry-run] would close ${c.tab_id} "${c.label}": ${c.why}`); continue; }
    // Recheck all evidence before each close; a worker can resume while we scan.
    if (!planTidy(observe()).close.some((tab) => tab.tab_id === c.tab_id)) continue;
    try { invoke(opt.herdr, ['tab', 'close', c.tab_id]); closed++; console.log(`closed ${c.tab_id} "${c.label}": ${c.why}`); }
    catch (error) { process.exitCode = 1; console.error(`could not close ${c.tab_id} "${c.label}": ${error.message}`); }
  }
  if (!opt['dry-run']) console.log(`tidy-tabs: closed ${closed} of ${close.length} finished tab(s) for ${path.basename(checkout)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`tidy-tabs: ${error.message}`); process.exitCode = 1; }
}
