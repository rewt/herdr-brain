#!/usr/bin/env node
// tidy-tabs: close the Herdr tabs a project's loop has finished with, so they
// don't pile up. Pilot tooling beside settle-watch; no model is involved.
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
import { parseArgs } from 'node:util';

const WATCHER = /^(watch|deliver) R-\d+$/;
const SESSION_LABEL = /^(settle R-\d+|executive|plan|audit)$/;
const SESSION_AGENT = /^(settle|exec|plan|audit)-/;
const FINISHED = new Set(['idle', 'done']);
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish']);

// Pure: decide which tabs to close from one observation of Herdr, org and the ledger.
// snapshot = { tabs: [{tab_id, label, workspace_id, lane}], panes: [{pane_id, tab_id, shellOnly}],
//   agents: [{name, status, pane_id}], reportedAgents: Set<name>, reviewedAgents: Set<name>,
//   sessionOrder: Map<name, sortKey>,
//   selfTab, keepSessions }
export function planTidy(snapshot) {
  const {
    tabs, panes, agents, reportedAgents = new Set(), reviewedAgents = new Set(),
    sessionOrder = new Map(), selfTab = null, keepSessions = 1,
  } = snapshot;
  const close = [];
  const keep = [];
  const sessionCandidates = [];
  for (const tab of tabs) {
    const skip = (why) => keep.push({ tab_id: tab.tab_id, label: tab.label, why });
    if (tab.tab_id === selfTab) { skip('this tab'); continue; }
    const tabPanes = panes.filter((p) => p.tab_id === tab.tab_id);
    const tabAgents = tabPanes.map((p) => agents.find((a) => a.pane_id === p.pane_id)).filter(Boolean);
    if (!tabPanes.length) { skip('no panes observed'); continue; }
    if (tabAgents.some((a) => !a.name)) { skip('an unnamed agent (an operator chat) is here'); continue; }
    if (tabAgents.some((a) => !FINISHED.has(a.status))) { skip('an agent here is still active'); continue; }
    const bareShells = tabPanes.filter((p) => !agents.some((a) => a.pane_id === p.pane_id));
    if (bareShells.some((p) => !p.shellOnly)) { skip('a program is still running here'); continue; }

    if (!tab.lane && WATCHER.test(tab.label)) {
      if (tabAgents.length) skip('an agent is in a watcher tab');
      else close.push({ tab_id: tab.tab_id, label: tab.label, why: 'the watcher has exited' });
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

// Pure: a review session is complete only when a verdict for its lane topic is
// newer than the session. This prevents an earlier review round from closing a
// later review tab on the same lane.
export function reviewedAgentsFromRecords(sessions, reviewRecords) {
  const newest = new Map();
  for (const r of reviewRecords) {
    if (!r?.topic || !r.verdict || !Number.isFinite(r.mtimeMs)) continue;
    newest.set(r.topic, Math.max(newest.get(r.topic) ?? -Infinity, r.mtimeMs));
  }
  return new Set(sessions
    .filter((s) => s?.role === 'review' && s?.name && s?.topic && Number.isFinite(Date.parse(s.created_at)))
    .filter((s) => (newest.get(s.topic) ?? -Infinity) > Date.parse(s.created_at))
    .map((s) => s.name));
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

function herdr(args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).result; } catch { return null; }
}

function main() {
  const { values: opt } = parseArgs({
    options: {
      cwd: { type: 'string' },
      org: { type: 'string' },
      'ledger-dir': { type: 'string' },
      'keep-sessions': { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!opt.cwd) {
    console.error('usage: tidy-tabs.mjs --cwd CHECKOUT [--org DIR] [--ledger-dir DIR] [--keep-sessions N] [--dry-run]');
    process.exit(2);
  }
  const checkout = path.resolve(opt.cwd);
  const ws = herdr(['workspace', 'list']);
  if (!ws) { console.error('tidy-tabs: herdr is not reachable; nothing closed'); process.exit(1); }
  const mine = ws.workspaces.filter((w) => w.worktree && (
    (!w.worktree.is_linked_worktree && path.resolve(w.worktree.checkout_path) === checkout)
    || (w.worktree.is_linked_worktree && path.resolve(w.worktree.repo_root ?? '') === checkout)));
  if (!mine.some((w) => !w.worktree.is_linked_worktree)) { console.error(`tidy-tabs: no Herdr workspace has ${checkout} as its checkout; nothing closed`); process.exit(1); }

  const tabs = [];
  const panes = [];
  for (const w of mine) {
    const lane = Boolean(w.worktree.is_linked_worktree);
    for (const t of herdr(['tab', 'list', '--workspace', w.workspace_id])?.tabs ?? []) tabs.push({ tab_id: t.tab_id, label: t.label ?? '', workspace_id: w.workspace_id, lane });
    for (const p of herdr(['pane', 'list', '--workspace', w.workspace_id])?.panes ?? []) {
      const info = herdr(['pane', 'process-info', '--pane', p.pane_id])?.process_info;
      panes.push({ pane_id: p.pane_id, tab_id: p.tab_id, shellOnly: isShellOnly(info) });
    }
  }
  const agents = (herdr(['agent', 'list'])?.agents ?? []).map((a) => ({ name: a.name ?? null, status: a.agent_status, pane_id: a.pane_id }));

  let reportedAgents = new Set();
  if (opt.org) {
    const r = spawnSync('org', ['status', '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ORG_DIR: opt.org } });
    if (r.status === 0) reportedAgents = new Set(JSON.parse(r.stdout).runs.filter((x) => x.report && x.meta?.agent).map((x) => x.meta.agent));
    else console.error(`tidy-tabs: org status failed for ${opt.org}; lane worker tabs are left alone`);
  }
  const reviewedAgents = reviewedAgentsFromRecords(
    laneSessions(checkout),
    reviewRecords([checkout, ...mine.filter((w) => w.worktree?.is_linked_worktree).map((w) => w.worktree.checkout_path)]),
  );

  const ledgerDir = opt['ledger-dir'] ?? path.join(checkout, '.lane/supervisor');
  const ledgers = [];
  try {
    for (const f of fs.readdirSync(ledgerDir)) {
      const m = /^sessions-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m) ledgers.push({ day: m[1], text: fs.readFileSync(path.join(ledgerDir, f), 'utf8') });
    }
  } catch { /* no ledger: sessions are ordered as unknown */ }

  const { close } = planTidy({
    tabs, panes, agents, reportedAgents, reviewedAgents,
    sessionOrder: sessionOrderFromLedgers(ledgers),
    selfTab: process.env.HERDR_TAB_ID ?? null,
    keepSessions: Number(opt['keep-sessions']),
  });
  let closed = 0;
  for (const c of close) {
    if (opt['dry-run']) { console.log(`[dry-run] would close ${c.tab_id} "${c.label}": ${c.why}`); continue; }
    const r = spawnSync('herdr', ['tab', 'close', c.tab_id], { encoding: 'utf8' });
    if (r.status === 0) { closed++; console.log(`closed ${c.tab_id} "${c.label}": ${c.why}`); }
    else console.log(`could not close ${c.tab_id} "${c.label}": ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
  }
  if (!opt['dry-run']) console.log(`tidy-tabs: closed ${closed} of ${close.length} finished tab(s) for ${path.basename(checkout)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
