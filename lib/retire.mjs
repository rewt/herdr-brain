// Pure retirement policy. All paths and process identities are observed by the
// adapter; this module neither reads files nor changes the record or Herdr.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { roleIs } from './roles.mjs';

const rows = value => value instanceof Map ? [...value.values()] : value ?? [];
const finished = agent => ['idle', 'done'].includes(agent.agent_status ?? agent.status);
const session = agent => agent.agent_session?.value ?? agent.agent_session_id;
const samePath = (a, b) => Boolean(a && b && path.normalize(a) === path.normalize(b));
const inside = (a, b) => samePath(a, b) || Boolean(a && b && a.startsWith(b + path.sep));
const stamp = value => Number.isSafeInteger(value) && value > 0;

export function matchingRun(agent, runs) {
  const candidates = rows(runs).filter(r => r.meta?.agent === agent.name ||
    (r.meta?.pane === agent.pane_id && r.meta?.worker_workspace === agent.workspace_id) ||
    (session(agent) && r.meta?.agent_session_id === session(agent)));
  candidates.sort((a, b) => (b.started?.seq ?? 0) - (a.started?.seq ?? 0));
  const r = candidates[0], m = r?.meta;
  if (!r || (candidates[1] && candidates[1].started?.seq === r.started?.seq)) return null;
  return m.agent === agent.name && m.pane === agent.pane_id && m.worker_workspace === agent.workspace_id && samePath(r.workspace, agent.cwd) &&
    Boolean(m.terminal_id || m.agent_session_id) && (!m.terminal_id || m.terminal_id === agent.terminal_id) &&
    (!m.agent_session_id || m.agent_session_id === session(agent)) ? r : null;
}

function chainFor(record, run) {
  const items = rows(record.items), runs = rows(record.runs);
  let root = items.find(i => i.id === run.item);
  const visited = new Set();
  // Reviewer panes belong to the engineer's correction/integration chain.
  while (root && roleIs(root, 'REV') && root.parent && !visited.has(root.id)) {
    visited.add(root.id); root = items.find(i => i.id === root.parent);
  }
  const ids = new Set(root ? [root.id] : [run.item]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of items) if (ids.has(i.parent) && !ids.has(i.id)) { ids.add(i.id); changed = true; }
    for (const link of record.links ?? []) if (ids.has(link.blocked) && !ids.has(link.blocker)) { ids.add(link.blocker); changed = true; }
    for (const i of items.filter(i => ids.has(i.id))) for (const id of i.blocked_by ?? []) {
      if (!ids.has(id)) { ids.add(id); changed = true; }
    }
  }
  return { root, ids, items, runs };
}

function terminalReason(chain) {
  if (!chain.root?.closed) return 'review, correction or integration chain is still open';
  for (const id of chain.ids) {
    const item = chain.items.find(i => i.id === id);
    if (!item) return `unknown chain item ${id}`;
    const runs = chain.runs.filter(r => r.item === id);
    if (runs.some(r => !r.report && !r.abandoned)) return `open run on ${id}`;
    const latest = runs.sort((a, b) => (b.started?.seq ?? 0) - (a.started?.seq ?? 0))[0];
    if (['blocked', 'needs_human', 'failed'].includes(latest?.report?.outcome)) return `${id} awaits correction or disposition`;
    if (item.meta?.answer === 'no') return `declined blocker ${id}`;
    if (item.closed?.as === 'dropped') continue;
    if (roleIs(item, 'REV')) {
      if (!stamp(latest?.report?.seq) || latest.report.outcome !== 'done' ||
          String(latest.report.extra?.verdict ?? '').trim().toUpperCase() !== 'PASS') return `review ${id} has no terminal PASS`;
    } else if (!item.closed) return `chain item ${id} has no recorded disposition`;
  }
  return null;
}

function referenceReason(snapshot, context) {
  for (const ref of snapshot.references ?? []) {
    if (ref.global || (ref.item && context.ids.has(ref.item)) || (ref.run && (context.run?.id === ref.run || context.runIds?.has(ref.run))) ||
        (ref.pane && context.pane === ref.pane) || (ref.lane && context.lane === ref.lane) ||
        (ref.cwd && (inside(ref.cwd, context.cwd) || inside(context.cwd, ref.cwd))) ||
        (ref.head && ref.head === context.head) || (ref.label && context.cwd && ref.label.includes(context.cwd)))
      return `${ref.kind ?? 'live'} reference ${ref.job ?? ref.owner ?? ''}`.trim();
  }
  return null;
}

function occupantReason(snapshot, agent, pane, workspace, git) {
  if (!agent.name) return 'unnamed operator occupant';
  if (!finished(agent)) return `occupant ${agent.name} is ${agent.agent_status ?? agent.status ?? 'unknown'}`;
  const run = matchingRun(agent, snapshot.record?.runs);
  if (!run) return `unknown or mismatched recorded launch identity for ${agent.name}`;
  const chain = chainFor(snapshot.record, run);
  const ref = referenceReason(snapshot, { ...chain, run, pane: pane.pane_id, cwd: run.workspace, lane: run.meta?.lane, head: git?.head });
  if (ref) return ref;
  // An explicit record event can release an old round, but never the retained
  // successor, a reused session, or an old pane with a live callback/reference.
  const handoff = (snapshot.handoffs ?? []).find(h => h.from === run.id && h.confirmed === true && stamp(h.seq));
  if (handoff) {
    const successor = rows(snapshot.record.runs).find(r => r.id === handoff.to);
    const live = snapshot.agents.find(a => matchingRun(a, snapshot.record.runs)?.id === successor?.id);
    if (successor && live && successor.item === run.item && successor.started.seq > run.started.seq &&
        live.pane_id !== agent.pane_id && (!session(agent) || session(agent) !== session(live)) &&
        snapshot.panes.some(p => p.pane_id === live.pane_id) && !successor.abandoned && !successor.report &&
        ['working', 'idle', 'done', 'blocked'].includes(live.agent_status ?? live.status)) return null;
    return 'handoff successor is not retained with its recorded launch identity';
  }
  if (!stamp(run.report?.seq)) return `${run.id} report is not ingested`;
  if (['blocked', 'needs_human', 'failed'].includes(run.report.outcome)) return `${run.id} awaits correction or disposition`;
  const reason = terminalReason(chain);
  if (reason) return reason;
  if (rows(snapshot.record.runs).some(r => samePath(r.workspace, run.workspace) && !r.report && !r.abandoned)) return 'open run in lane';
  if (!git || git.common !== snapshot.common || !samePath(git.path, workspace.worktree.checkout_path)) return 'unknown or mismatched Git identity';
  if (!git.clean || (!git.integrated && !git.archived)) return 'lane is not clean and integrated or archived';
  return null;
}

// Tokens bind the entire authority observation, including occupants/processes,
// native session, record revision, references and Git head. Time itself is not
// authority; expiry is reclassified by the adapter on each fresh observation.
function stable(v) {
  if (v instanceof Map) return stable([...v.values()]);
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
export function planRetirement(snapshot) {
  const { now, diagnostics, runs, items, ...raw } = snapshot;
  const authority = { ...raw, agents: snapshot.agents.map(a => ({ name: a.name, agent: a.agent,
    agent_status: a.agent_status ?? a.status, pane_id: a.pane_id, tab_id: a.tab_id, workspace_id: a.workspace_id,
    cwd: a.cwd, terminal_id: a.terminal_id, agent_session_id: session(a), state_change_seq: a.state_change_seq })) };

  const token = createHash('sha256').update(JSON.stringify(stable(authority))).digest('hex');
  const close = [], keep = [], panes = [];
  for (const tab of snapshot.tabs ?? []) {
    const ps = (snapshot.panes ?? []).filter(p => p.tab_id === tab.tab_id);
    const agents = (snapshot.agents ?? []).filter(a => a.tab_id === tab.tab_id || ps.some(p => p.pane_id === a.pane_id));
    const ws = (snapshot.workspaces ?? []).find(w => w.workspace_id === tab.workspace_id);
    const git = (snapshot.git ?? []).find(g => samePath(g.path, ws?.worktree?.checkout_path));
    let reason = (snapshot.errors ?? [])[0];
    if (!reason && (tab.tab_id === snapshot.selfTab || tab.focused || ps.some(p => p.focused))) reason = 'operator focus or this tab';
    if (!reason && (!ws?.worktree?.is_linked_worktree || ws.persistent || ws.operator || ws.lab_owned ||
        (snapshot.labWorkspaces ?? []).includes(ws.workspace_id))) reason = 'persistent, operator or lab workspace';
    if (!reason && git && !git.error && !git.lane && !git.archived) reason = 'persistent or detached desk workspace';
    if (!reason && (!ps.length || !agents.length)) reason = 'unknown occupant or unrecorded shell';
    if (!reason && git?.error) reason = git.error;
    if (!reason && (ws.worktree.repo_key !== snapshot.common || !git || git.common !== snapshot.common)) reason = 'wrong or unknown canonical repository identity';
    if (!reason && (agents.some(a => !ps.some(p => p.pane_id === a.pane_id) || (a.tab_id && a.tab_id !== tab.tab_id) || a.workspace_id !== tab.workspace_id) ||
        ps.some(p => (p.workspace_id && p.workspace_id !== tab.workspace_id) || snapshot.panes.some(q => q.pane_id === p.pane_id && q.tab_id !== tab.tab_id)))) reason = 'agent and pane topology disagree';
    if (!reason && ps.some(p => !agents.some(a => a.pane_id === p.pane_id))) reason = 'unknown or unrecorded shell occupant';
    if (!reason) for (const a of agents) {
      const p = ps.find(p => p.pane_id === a.pane_id);
      // A process snapshot must exist even for idle native agent occupants.
      if (!p?.process_info || !Array.isArray(p.process_info.foreground_processes) || !p.process_info.foreground_processes.length) { reason = 'unknown occupant process state'; break; }
      const info = p.process_info, roots = new Set([info.shell_pid, ...info.foreground_processes.map(process => process.pid)]);
      if (info.process_tree_complete !== true || !Array.isArray(info.process_tree) ||
          [...roots].some(pid => !info.process_tree.some(row => row.pid === pid && row.identity && row.state)) ||
          info.process_tree.some(row => !row.identity || !row.state || !roots.has(row.pid))) { reason = 'background or unknown pane process remains'; break; }
      if (!p.shellOnly && p.process_info.foreground_processes.some(process =>
        process.name !== a.agent && path.basename(process.argv0 ?? '') !== a.agent)) { reason = 'another or unknown foreground process is here'; break; }
      if (!samePath(a.cwd, ws.worktree.checkout_path)) { reason = 'occupant cwd differs from lane'; break; }
      reason = occupantReason(snapshot, a, p, ws, git);
      if (reason) break;
    }
    const tabAuthority = { ...authority,
      tabs: [tab], panes: snapshot.panes.filter(p => p.tab_id === tab.tab_id || ps.some(q => q.pane_id === p.pane_id)),
      agents: authority.agents.filter(a => agents.some(original => original.pane_id === a.pane_id) || (snapshot.handoffs ?? []).some(h =>
        agents.some(old => matchingRun(old, snapshot.record.runs)?.id === h.from) && matchingRun(a, snapshot.record.runs)?.id === h.to)),
    };
    const tabToken = createHash('sha256').update(JSON.stringify(stable(tabAuthority))).digest('hex');
    const decision = { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label ?? '',
      decision: reason ? 'keep' : 'release', why: reason ?? `${agents.map(a => matchingRun(a, snapshot.record.runs)?.id).join(', ')}: ingested report and terminal chain, or confirmed retained successor`, token: tabToken };
    (reason ? keep : close).push(decision);
    for (const p of ps) panes.push({ ...decision, pane_id: p.pane_id });
  }
  return { close, keep, panes, diagnostics: diagnostics ?? [], token };
}

// One executor for every close path. Read failures and concurrent reactivation
// are refusals, never permissions. Callers log the fresh refusal reason.
export function executeRetirement(plan, { observe, close, closeWorkspace, log = () => {} }) {
  const results = [];
  for (const candidate of plan.close) {
    try {
      const fresh = planRetirement(observe());
      const current = [...fresh.close, ...fresh.keep].find(t => t.tab_id === candidate.tab_id);
      if (!current) { results.push({ action: 'already-gone', ...candidate }); continue; }
      if (current.decision !== 'release' || current.token !== candidate.token) {
        const result = { ...current, action: 'skip-close', why: current.decision === 'keep' ? current.why : 'authority changed since plan; replan required' };
        log(result); results.push(result); continue;
      }
      close(current.tab_id);
      const result = { ...current, action: 'closed' }; log(result); results.push(result);
    } catch (error) {
      const result = { ...candidate, action: 'close-failed', why: error.message, error: error.message };
      log(result); results.push(result);
    }
  }
  for (const candidate of plan.workspaceClose ?? []) {
    try {
      const snapshot = observe(), fresh = planRetirement(snapshot);
      const reason = laneRemovalReason(snapshot, candidate.cwd);
      if (reason || fresh.token !== candidate.token) {
        const result = { ...candidate, action: 'skip-close', why: reason ?? 'authority changed since empty workspace plan' };
        log(result); results.push(result); continue;
      }
      closeWorkspace(candidate.workspace_id);
      const result = { ...candidate, action: 'closed' }; log(result); results.push(result);
    } catch (error) {
      const result = { ...candidate, action: 'close-failed', why: error.message }; log(result); results.push(result);
    }
  }
  return results;
}

// Git-only removal requires zero live panes, including releasable panes which
// have not actually been closed. A kept/unknown pane can never lose its cwd.
export function laneRemovalReason(snapshot, cwd) {
  if (snapshot.errors?.length) return snapshot.errors[0];
  const runs = rows(snapshot.record?.runs).filter(r => samePath(r.workspace, cwd));
  if (runs.some(r => !r.report && !r.abandoned)) return 'open recorded run uses lane';
  const ids = new Set(runs.flatMap(r => [...chainFor(snapshot.record, r).ids]));
  const git = snapshot.git?.find(g => samePath(g.path, cwd));
  if (git?.error) return git.error;
  const ref = referenceReason(snapshot, { ids, runIds: new Set(runs.map(r => r.id)), cwd,
    lane: git?.lane ?? runs.find(r => r.meta?.lane)?.meta.lane, head: git?.head });
  if (ref) return ref;
  const ws = snapshot.workspaces.filter(w => samePath(w.worktree?.checkout_path, cwd));
  if (ws.some(w => w.lab_owned || w.operator || w.persistent || !w.worktree.is_linked_worktree)) return 'persistent, operator or lab workspace';
  if (snapshot.panes.some(p => ws.some(w => w.workspace_id === p.workspace_id) || snapshot.tabs.some(t => t.tab_id === p.tab_id && ws.some(w => w.workspace_id === t.workspace_id))) ||
      snapshot.agents.some(a => inside(a.cwd, cwd))) return 'occupied lane; retire panes before removing the worktree';
  return null;
}
