#!/usr/bin/env node
// Compatibility CLI for the shared record/Git/job retirement contract.
// --ledger-dir and --keep-sessions remain accepted for installed callers;
// labels, ledgers and session display metadata never authorize retirement.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { planRetirement, matchingRun, matchingRunEvidence } from '../lib/retire.mjs';
import { createRetirement, isShellOnly } from '../lib/retire-runtime.mjs';
export { matchingRun, isShellOnly };

const canonicalPath = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);

function matchingOccupant(agent, { pane, workspace, cwd, terminal_id, agent_session_id }) {
  return Boolean(pane && pane === agent.pane_id && workspace && workspace === agent.workspace_id &&
    cwd && agent.cwd && canonicalPath(cwd) === canonicalPath(agent.cwd) &&
    (terminal_id || agent_session_id) &&
    (!terminal_id || terminal_id === agent.terminal_id) &&
    (!agent_session_id || agent_session_id === agent.agent_session?.value));
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

// Keep the refusal reason alongside eligibility so views identify the guard
// that actually retained the worker, after checking its launch identity.
export function reportEvidenceFromRecords(agents, runs, items) {
  const eligible = new Set(), reportKeepReasons = new Map();
  for (const agent of agents) {
    const { run, ambiguous } = matchingRunEvidence(agent, runs);
    let why;
    if (ambiguous) {
      why = `ambiguous recorded launch identity for ${agent.name}`;
    } else if (!run && runs.some((r) => r.meta?.agent === agent.name)) {
      why = `recorded launch identity does not match ${agent.name}`;
    } else if (!run?.report) {
      why = `no recorded report for ${agent.name}`;
    } else if (waitingOnRecord({ items }, run)) {
      why = ['blocked', 'needs_human'].includes(run.report.outcome)
        ? `waiting on recorded ${run.report.outcome} outcome for ${agent.name}`
        : `waiting on recorded item or blockers for ${agent.name}`;
    }
    if (why) {
      const previous = reportKeepReasons.get(agent.name);
      reportKeepReasons.set(agent.name, previous && previous !== why ? `${previous}; ${why}` : why);
    } else eligible.add(agent.name);
  }
  // Duplicate observations of a reused name must all match the record; one
  // valid occupant cannot authorize a mismatched second occupant.
  return { reportedAgents: new Set([...eligible].filter((name) => !reportKeepReasons.has(name))), reportKeepReasons };
}

export function reportedAgentsFromRecords(agents, runs, items) {
  return reportEvidenceFromRecords(agents, runs, items).reportedAgents;
}

// Compatibility name; all callers now share the retirement policy.
export function planTidy(snapshot) {
  return planRetirement({ ...snapshot, record: snapshot.record ?? { runs: snapshot.runs ?? [], items: snapshot.items ?? [] } });
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

function main() {
  const { values: opt } = parseArgs({ options: {
    cwd: { type: 'string' }, org: { type: 'string' },
    'ledger-dir': { type: 'string' }, 'keep-sessions': { type: 'string', default: '1' },
    herdr: { type: 'string', default: 'herdr' }, 'org-cli': { type: 'string' },
    'org-cli-arg': { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
  } });
  if (!opt.cwd) throw Error('usage: tidy-tabs.mjs --cwd CHECKOUT [--org DIR] [--dry-run]');
  const retirement = createRetirement({ cwd: opt.cwd, org: opt.org, herdr: opt.herdr,
    record: opt['org-cli'] ? [opt['org-cli'], ...opt['org-cli-arg']] : undefined,
    log: entry => console.log(JSON.stringify(entry)) });
  const plan = retirement.plan();
  for (const k of plan.keep) console.log(`${opt['dry-run'] ? '[dry-run] ' : ''}keep ${k.tab_id}: ${k.why}`);
  for (const diagnostic of plan.diagnostics) console.log(JSON.stringify(diagnostic));
  if (opt['dry-run']) for (const c of plan.close) console.log(`[dry-run] would close ${c.tab_id}: ${c.why}`);
  else {
    // A close changes the authority of recorded siblings in its lane, so the
    // executor refuses them for a replan. Replan only those tabs from a fresh
    // observation while each pass still closes one; every retry runs the full
    // policy and token recheck, and the set shrinks every pass.
    let results = retirement.apply(plan);
    for (;;) {
      const replan = new Set(results.filter(r => r.action === 'skip-close' &&
        r.why === 'authority changed since plan; replan required').map(r => r.tab_id));
      if (!replan.size || !results.some(r => r.action === 'closed')) break;
      const fresh = retirement.plan();
      for (const k of fresh.keep) if (replan.has(k.tab_id)) console.log(`keep ${k.tab_id}: ${k.why}`);
      results = retirement.apply({ ...fresh, close: fresh.close.filter(c => replan.has(c.tab_id)),
        sessionReleases: [], laneClose: [], workspaceClose: [] });
    }
  }
}
if (isMain(import.meta.url)) {
  try { main(); } catch (e) { console.error(`tidy-tabs: ${e.message}`); process.exitCode = 1; }
}
