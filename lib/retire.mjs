// Pure retirement policy. All paths and process identities are observed by the
// adapter; this module neither reads files nor changes the record or Herdr.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { roleIs } from './roles.mjs';
import { exitCommandFor } from '../lanes/routes.mjs';

const rows = value => value instanceof Map ? [...value.values()] : value ?? [];
const finished = agent => ['idle', 'done'].includes(agent.agent_status ?? agent.status);
const session = agent => agent.agent_session?.value ?? agent.agent_session_id;
const samePath = (a, b) => Boolean(a && b && path.normalize(a) === path.normalize(b));
const inside = (a, b) => samePath(a, b) || Boolean(a && b && a.startsWith(b + path.sep));
const stamp = value => Number.isSafeInteger(value) && value > 0;
function unfinishedReason(agent) {
  return `occupant ${agent.name} is ${agent.agent_status ?? agent.status ?? 'unknown'}`;
}

// A complete, healthy tree may contain helpers only below the one native
// foreground process. A sibling shell job, missing parent or cycle never passes.
function agentTree(agent, pane) {
  const info = pane?.process_info, fg = info?.foreground_processes;
  const raw = info?.process_tree_raw ?? info?.process_tree;
  if (pane?.shellOnly || info?.process_tree_complete !== true || !Array.isArray(raw) || fg?.length !== 1) return null;
  const tree = new Map(raw.map(row => [row.pid, row]));
  if (tree.size !== raw.length || !tree.has(info.shell_pid) || fg[0].pid === info.shell_pid ||
      raw.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 || !row.identity || !row.command || !row.state || /^[TXZ]/i.test(row.state))) return null;
  const root = tree.get(fg[0].pid), shell = tree.get(info.shell_pid);
  if (!root || root.ppid !== shell.pid || tree.has(shell.ppid) || (fg[0].identity && fg[0].identity !== root.identity) ||
      root.command.replace(/^\[|\]$/g, '') !== fg[0].name ||
      (fg[0].name !== agent.agent && path.basename(fg[0].argv0 ?? '') !== agent.agent)) return null;
  for (const row of tree.values()) {
    if (row.pid === shell.pid) continue;
    const seen = new Set();
    let current = row;
    while (current?.pid !== root.pid) {
      if (!current || current.pid === shell.pid || seen.has(current.pid)) return null;
      seen.add(current.pid); current = tree.get(current.ppid);
    }
  }
  return { root, shell };
}

const occupantIdentity = a => [a.name, a.agent, a.pane_id, a.workspace_id, a.cwd, a.terminal_id, session(a)];
function sameExitOccupant(candidate, snapshot) {
  const ps = snapshot.panes.filter(p => p.tab_id === candidate.tab_id);
  if (ps.length !== 1 || ps[0].pane_id !== candidate.pane || ps[0].process_info?.shell_pid !== candidate.shell.pid) return false;
  const shell = ps[0].process_info.process_tree?.find(row => row.pid === candidate.shell.pid);
  if (!shell || shell.identity !== candidate.shell.identity || shell.command !== candidate.shell.command) return false;
  return snapshot.agents.filter(a => a.tab_id === candidate.tab_id || a.pane_id === candidate.pane)
    .every(a => JSON.stringify(occupantIdentity(a)) === JSON.stringify(candidate.occupant));
}

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

export function chainFor(record, run, pruned = new Set()) {
  const items = rows(record.items), runs = rows(record.runs);
  let root = items.find(i => i.id === run.item);
  const visited = new Set();
  // Reviewer panes belong to the engineer's correction/integration chain.
  while (root && roleIs(root, 'REV') && root.parent && !visited.has(root.id)) {
    visited.add(root.id); root = items.find(i => i.id === root.parent);
  }
  const ids = new Set(root ? [root.id] : [run.item]);
  const expand = new Set(ids);
  let changed = true;
  const addBlocker = id => {
    if (!ids.has(id)) { ids.add(id); changed = true; }
    // A satisfied blocker contributes only its own terminal check. A separate
    // parent/child path can still include its subtree in the root's chain.
    if (!items.find(i => i.id === id)?.closed && !expand.has(id)) { expand.add(id); changed = true; }
  };
  while (changed) {
    changed = false;
    for (const i of items) if (expand.has(i.parent) && !expand.has(i.id) && !pruned.has(i.id)) { ids.add(i.id); expand.add(i.id); changed = true; }
    for (const link of record.links ?? []) if (expand.has(link.blocked)) addBlocker(link.blocker);
    for (const i of items.filter(i => expand.has(i.id))) for (const id of i.blocked_by ?? []) addBlocker(id);
  }
  return { root, ids, items, runs, links: record.links ?? [] };
}

function followUpsFor(chain, git) {
  const unchanged = { items: [], ids: chain.ids };
  if (!chain.root || git?.integrated !== true || git.error || !git.path) return unchanged;
  let candidates = chain.items.filter(item => chain.ids.has(item.id) && item.id !== chain.root.id &&
    chain.ids.has(item.parent) && !item.closed &&
    // Review PASS and declined-answer guards retain their existing meaning.
    !roleIs(item, 'REV') && item.meta?.answer !== 'no' &&
    chain.runs.some(run => run.id === item.created?.run && chain.ids.has(run.item))).map(item => {
    const subtree = new Set([item.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of chain.items) if (subtree.has(child.parent) && !subtree.has(child.id)) {
        subtree.add(child.id); changed = true;
      }
    }
    return { item, subtree };
  }).filter(({ subtree }) => !chain.runs.some(run => subtree.has(run.item) && (!run.workspace || inside(run.workspace, git.path))));
  while (candidates.length) {
    // Prune child edges only. A dependency from retained source work can still
    // reach a candidate or its descendants and revoke that whole exemption.
    const source = chainFor(chain, { item: chain.root.id }, new Set(candidates.map(c => c.item.id)));
    const blocked = new Set(source.ids), blockers = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      const add = id => {
        blockers.add(id);
        if (!blocked.has(id)) { blocked.add(id); changed = true; }
      };
      // Include paths through satisfied blockers without expanding their child
      // chains, preserving the earlier settled-blocker terminal checks.
      for (const link of chain.links) if (blocked.has(link.blocked)) add(link.blocker);
      for (const item of chain.items) if (blocked.has(item.id)) for (const id of item.blocked_by ?? []) add(id);
    }
    const eligible = candidates.filter(({ subtree }) => ![...subtree].some(id => source.ids.has(id) || blockers.has(id)));
    if (eligible.length === candidates.length) return { items: candidates.map(c => c.item), ids: source.ids };
    candidates = eligible;
  }
  return unchanged;
}

export function terminalReason(chain, git) {
  if (!chain.root?.closed) return 'review, correction or integration chain is still open';
  const { ids } = followUpsFor(chain, git);
  for (const id of ids) {
    const item = chain.items.find(i => i.id === id);
    if (!item) return `unknown chain item ${id}`;
    const runs = chain.runs.filter(r => r.item === id);
    if (runs.some(r => !r.report && !r.abandoned)) return `open run on ${id}`;
    const latest = runs.sort((a, b) => (b.started?.seq ?? 0) - (a.started?.seq ?? 0))[0];
    if (!item.closed && ['blocked', 'needs_human', 'failed'].includes(latest?.report?.outcome)) return `${id} awaits correction or disposition`;
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

export function matchingRelease(snapshot, agent, run, git) {
  if (!run) return null;
  return (snapshot.releases ?? []).find(r => r.run === run.id && r.confirmed === true &&
    r.pane === agent.pane_id && r.terminal === agent.terminal_id && session(agent) && r.session === session(agent) &&
    r.workspace === agent.workspace_id && samePath(r.cwd, run.workspace) && stamp(r.seq) && r.seq > run.report?.seq &&
    git?.common === snapshot.common && !git.error);
}

function occupantReason(snapshot, agent, pane, workspace, git) {
  if (!agent.name) return 'unnamed operator occupant';
  if (!finished(agent)) return unfinishedReason(agent);
  const run = matchingRun(agent, snapshot.record?.runs);
  if (!run) return `unknown or mismatched recorded launch identity for ${agent.name}`;
  if (session(agent) && !run.meta.agent_session_id) return `unknown recorded native session identity for ${agent.name}`;
  const chain = chainFor(snapshot.record, run);
  const ref = referenceReason(snapshot, { ...chain, run, pane: pane.pane_id, cwd: run.workspace, lane: run.meta?.lane, head: git?.head });
  if (ref) return ref;
  const incoming = (snapshot.handoffs ?? []).find(h => h.to === run.id && h.confirmed === true && stamp(h.seq) &&
    rows(snapshot.record.runs).some(from => from.id === h.from && from.item === run.item && from.started.seq < run.started.seq &&
      snapshot.agents.some(a => a.pane_id !== agent.pane_id && matchingRun(a, snapshot.record.runs)?.id === from.id)));
  if (incoming) return `retained successor for handoff from ${incoming.from}`;
  // Warm context survives report/correction gaps unless this exact idle session
  // has an explicit, post-report release. All earlier safety guards still hold.
  if (!stamp(run.report?.seq)) return `${run.id} report is not ingested`;
  const release = matchingRelease(snapshot, agent, run, git);
  if (release && release.head !== git.head) return `release for ${run.id} is stale: head moved`;
  if (!release && !chain.items.find(i => i.id === run.item)?.closed && ['blocked', 'needs_human', 'failed'].includes(run.report.outcome)) return `${run.id} awaits correction or disposition`;
  const reason = terminalReason(chain, git);
  if (reason && !release) return reason;
  // An explicit record event can release an old round, but never the retained
  // successor, a reused session, or an old pane with a live callback/reference.
  const handoff = (snapshot.handoffs ?? []).find(h => h.from === run.id && h.confirmed === true && stamp(h.seq));
  if (handoff) {
    const successor = rows(snapshot.record.runs).find(r => r.id === handoff.to);
    const live = snapshot.agents.find(a => matchingRun(a, snapshot.record.runs)?.id === successor?.id);
    const successorGit = (snapshot.git ?? []).find(g => samePath(g.path, successor?.workspace));
    if (successor && live && successor.item === run.item && successor.started.seq > run.started.seq &&
        live.pane_id !== agent.pane_id && (!session(agent) || session(agent) !== session(live)) &&
        snapshot.panes.some(p => p.pane_id === live.pane_id) && !successor.abandoned &&
        (!session(live) || Boolean(successor.meta.agent_session_id)) &&
        successorGit?.common === snapshot.common && !successorGit.error &&
        ['working', 'idle', 'done', 'blocked'].includes(live.agent_status ?? live.status)) return null;
    return 'handoff successor is not retained with its recorded launch identity';
  }
  if (rows(snapshot.record.runs).some(r => samePath(r.workspace, run.workspace) && !r.report && !r.abandoned &&
      (!release || r.id === run.id || r.meta?.run === run.id || r.meta?.pane === agent.pane_id ||
        r.meta?.agent_session_id === session(agent)))) return 'open run in lane';
  if (!git || git.common !== snapshot.common || !samePath(git.path, workspace.worktree.checkout_path)) return 'unknown or mismatched Git identity';
  if (!release && (!git.clean || (!git.integrated && !git.archived))) return 'lane is not clean and integrated or archived';
  return null;
}

// Optional observation from canonical enrollment history. It can only keep;
// withdrawing a receipt merely restores every ordinary retirement guard.
function standardSlotReason(snapshot, { tab, workspace, cwd } = {}) {
  const evidence = snapshot.standardSlots;
  if (evidence === undefined) return null; // No receipts: existing behaviour.
  if (evidence?.schema !== 'standard-slot-history/v1' || !Array.isArray(evidence.slots) || !Array.isArray(evidence.errors) || evidence.errors.some(e => typeof e !== 'string' || !e)) return 'unknown standard-slot protection evidence; project kept';
  if (evidence.errors.length) return evidence.errors[0];
  for (const slot of evidence.slots) {
    const declared = slot?.standardSlot === 'logs' ? ['viewer', 'triage'] : ['primary'];
    if (!slot || slot.common !== snapshot.common || ['tab', 'workspace', 'checkout', 'uid', 'server'].some(key => typeof slot[key] !== 'string' || !slot[key]) || !path.isAbsolute(slot.checkout) ||
        !['chat', 'supervisor', 'logs'].includes(slot.standardSlot) || !Array.isArray(slot.panes) || slot.panes.length !== declared.length ||
        slot.panes.some(p => typeof p?.pane !== 'string' || !p.pane || !declared.includes(p.paneSlot)) || new Set(slot.panes.map(p => p.paneSlot)).size !== declared.length) return 'mismatched standard-slot protection identity; project kept';
    if ((tab && (slot.tab === tab.tab_id || slot.panes.some(p => snapshot.panes?.some(live => live.tab_id === tab.tab_id && live.pane_id === p.pane)))) ||
        (workspace && slot.workspace === workspace) || (cwd && (samePath(slot.checkout, cwd) || snapshot.workspaces?.some(w => w.workspace_id === slot.workspace && samePath(w.worktree?.checkout_path, cwd))))) return `adopted standard slot ${slot.standardSlot} (${slot.uid}); explicit withdrawal required`;
  }
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

// Launch receipts describe one short-lived process, never a display session.
// An exited callback can release its unchanged shell; a watcher may also retire
// itself at its final instruction, with no other process or occupant present.
function callbackReason(snapshot, receipt, ps, agents, ws, git) {
  if (ps.length !== 1 || ps[0].pane_id !== receipt.pane || receipt.workspace !== ws.workspace_id ||
      receipt.common !== snapshot.common || !samePath(receipt.cwd, ws.worktree.checkout_path)) return 'callback launch topology changed';
  const p = ps[0], info = p.process_info, self = snapshot.selfRetirement;
  const own = receipt.kind === 'watcher' && self?.tab === receipt.tab && self.pane === receipt.pane && self.pid === receipt.process.pid;
  if (!receipt.process_gone && !own) return 'recorded callback process is still live or unknown';
  if (agents.some(a => !receipt.agent || a.name !== receipt.agent || a.pane_id !== receipt.pane ||
      a.workspace_id !== receipt.workspace || !samePath(a.cwd, receipt.cwd) ||
      (receipt.terminal_id && a.terminal_id !== receipt.terminal_id) ||
      (receipt.agent_session_id && session(a) !== receipt.agent_session_id) ||
      (session(a) && !receipt.agent_session_id) ||
      (!receipt.terminal_id && !receipt.agent_session_id))) return 'callback has another, working or unknown occupant';
  const busy = agents.find(a => !finished(a));
  if (busy) return unfinishedReason(busy);
  if (own && agents.length) return 'self-retiring watcher has an agent occupant';
  const roots = new Set([receipt.shell.pid, ...(own ? [receipt.process.pid] : [])]);
  if (!info || info.shell_pid !== receipt.shell.pid || info.process_tree_complete !== true || !Array.isArray(info.process_tree) ||
      !info.foreground_processes?.length || info.foreground_processes.some(row => !roots.has(row.pid)) ||
      [...roots].some(pid => !info.process_tree.some(row => row.pid === pid && row.identity === (pid === receipt.shell.pid ? receipt.shell.identity : receipt.process.identity) &&
        row.command === (pid === receipt.shell.pid ? receipt.shell.command : receipt.process.command))) ||
      info.process_tree.some(row => !roots.has(row.pid) || !row.identity || !row.command || !row.state || /^[TXZ]/.test(row.state)) ||
      (!own && !p.shellOnly)) return 'callback shell or process identity changed, or another process remains';
  if (!git?.clean || !git.integrated) return 'callback checkout is not clean and integrated';
  const run = rows(snapshot.record.runs).find(r => r.id === receipt.run);
  if (receipt.run && !stamp(run?.report?.seq)) return 'callback report is not ingested';
  if (receipt.kind === 'watcher' && !receipt.run) return 'watcher has no recorded run';
  const chain = run ? chainFor(snapshot.record, run) : { ids: new Set() };
  const refs = { ...snapshot, references: (snapshot.references ?? []).filter(ref => !(own && ref.kind === 'watcher callback' && ref.pid === self.pid && ref.identity === receipt.process.identity)) };
  const ref = referenceReason(refs, { ids: chain.ids, run, cwd: receipt.cwd, pane: receipt.pane, lane: git.lane, head: git.head });
  if (ref) return ref;
  if (receipt.kind !== 'watcher') {
    if (run) { const reason = terminalReason(chain, git); if (reason) return reason; }
    if (rows(snapshot.record.runs).some(r => samePath(r.workspace, receipt.cwd) && !r.report && !r.abandoned)) return 'open run uses callback checkout';
  }
  return null;
}
export function planRetirement(snapshot) {
  const { now, diagnostics, runs, items, callbackPruning, events, ...raw } = snapshot;
  const authority = { ...raw, agents: (snapshot.agents ?? []).map(a => ({ name: a.name, agent: a.agent,
    agent_status: a.agent_status ?? a.status, pane_id: a.pane_id, tab_id: a.tab_id, workspace_id: a.workspace_id,
    cwd: a.cwd, terminal_id: a.terminal_id, agent_session_id: session(a), state_change_seq: a.state_change_seq })),
    panes: (snapshot.panes ?? []).map(p => ({ ...p, process_info: p.process_info ? {
      shell_pid: p.process_info.shell_pid, process_tree_complete: p.process_info.process_tree_complete,
      foreground_processes: p.process_info.foreground_processes?.map(row => ({ pid: row.pid, identity: row.identity,
        command: row.command, ppid: row.ppid, name: row.name, argv0: row.argv0 })),
      process_tree: p.process_info.process_tree?.map(row => ({ pid: row.pid, identity: row.identity, command: row.command, ppid: row.ppid })),
    } : undefined })),
    tabs: (snapshot.tabs ?? []).map(t => ({ tab_id: t.tab_id, workspace_id: t.workspace_id, focused: t.focused })),
    workspaces: (snapshot.workspaces ?? []).map(w => ({ workspace_id: w.workspace_id, worktree: w.worktree, persistent: w.persistent, operator: w.operator, lab_owned: w.lab_owned })) };

  const token = createHash('sha256').update(JSON.stringify(stable(authority))).digest('hex');
  const close = [], keep = [], panes = [];
  for (const tab of snapshot.tabs ?? []) {
    const ps = (snapshot.panes ?? []).filter(p => p.tab_id === tab.tab_id);
    const agents = (snapshot.agents ?? []).filter(a => a.tab_id === tab.tab_id || ps.some(p => p.pane_id === a.pane_id));
    const ws = (snapshot.workspaces ?? []).find(w => w.workspace_id === tab.workspace_id);
    const git = (snapshot.git ?? []).find(g => samePath(g.path, ws?.worktree?.checkout_path));
    const receipts = (snapshot.callbacks ?? []).filter(r => r.tab === tab.tab_id);
    const callback = receipts.length === 1 ? receipts[0] : null;
    let reason = snapshot.retirementHold ?? (snapshot.errors ?? [])[0], needsExit = false, exitTree;
    reason ??= standardSlotReason(snapshot, { tab });
    if (!reason && ((tab.tab_id === snapshot.selfTab && tab.tab_id !== snapshot.selfRetirement?.tab) || tab.focused || ps.some(p => p.focused))) reason = 'operator focus or this tab';
    if (!reason && ((!ws?.worktree?.is_linked_worktree && !callback) || ws.persistent || ws.operator || ws.lab_owned ||
        (snapshot.labWorkspaces ?? []).includes(ws.workspace_id))) reason = 'persistent, operator or lab workspace';
    if (!reason && git && !git.error && !git.lane && !git.archived && !callback) reason = 'persistent or detached desk workspace';
    if (!reason && (!ps.length || (!agents.length && !callback))) reason = 'unknown occupant or unrecorded shell';
    if (!reason && git?.error) reason = git.error;
    if (!reason && (ws.worktree.repo_key !== snapshot.common || !git || git.common !== snapshot.common)) reason = 'wrong or unknown canonical repository identity';
    if (!reason && (agents.some(a => !ps.some(p => p.pane_id === a.pane_id) || (a.tab_id && a.tab_id !== tab.tab_id) || a.workspace_id !== tab.workspace_id) ||
        ps.some(p => (p.workspace_id && p.workspace_id !== tab.workspace_id) || snapshot.panes.some(q => q.pane_id === p.pane_id && q.tab_id !== tab.tab_id)))) reason = 'agent and pane topology disagree';
    if (!reason && callback) {
      reason = callbackReason(snapshot, callback, ps, agents, ws, git);
      // Reuse the entire ordinary callback policy on the prospective bare shell.
      // The recorded callback must be this foreground agent, not a live watcher.
      if (agents.length === 1 && ps.length === 1 && !callback.process_gone &&
          (exitTree = agentTree(agents[0], ps[0])) && callback.process.pid === exitTree.root.pid &&
          callback.process.identity === exitTree.root.identity && callback.process.command === exitTree.root.command) {
        const pane = { ...ps[0], shellOnly: true, process_info: { ...ps[0].process_info,
          process_tree: [exitTree.shell], foreground_processes: [{ ...exitTree.shell, name: exitTree.shell.command.replace(/^\[|\]$/g, '') }] } };
        reason = callbackReason(snapshot, { ...callback, process_gone: true }, [pane], agents, ws, git);
        needsExit = !reason;
      }
    }
    if (!reason && !callback && ps.some(p => !agents.some(a => a.pane_id === p.pane_id))) reason = 'unknown or unrecorded shell occupant';
    if (!reason && !callback) for (const a of agents) {
      const p = ps.find(p => p.pane_id === a.pane_id);
      // A process snapshot must exist even for idle native agent occupants.
      if (!p?.process_info || !Array.isArray(p.process_info.foreground_processes) || !p.process_info.foreground_processes.length) { reason = 'unknown occupant process state'; break; }
      const info = p.process_info, roots = new Set([info.shell_pid, ...info.foreground_processes.map(process => process.pid)]);
      const descendants = ps.length === 1 && agents.length === 1 ? agentTree(a, p) : null;
      if (info.process_tree_complete !== true || !Array.isArray(info.process_tree) ||
          [...roots].some(pid => !info.process_tree.some(row => row.pid === pid && row.identity && row.state && row.command)) ||
          info.process_tree.some(row => !row.identity || !row.state || /^[TXZ]/.test(row.state) || !roots.has(row.pid))) {
        if (!descendants) { reason = 'background or unknown pane process remains'; break; }
        needsExit = true; exitTree = descendants;
      }
      if (info.foreground_processes.some(process => process.pid !== info.shell_pid &&
          !info.process_tree.some(row => row.pid === process.pid && row.command.replace(/^\[|\]$/g, '') === process.name))) { reason = 'kernel process differs from foreground observation'; break; }
      if (!p.shellOnly && p.process_info.foreground_processes.some(process =>
        process.name !== a.agent && path.basename(process.argv0 ?? '') !== a.agent)) { reason = 'another or unknown foreground process is here'; break; }
      if (!samePath(a.cwd, ws.worktree.checkout_path)) { reason = 'occupant cwd differs from lane'; break; }
      reason = occupantReason(snapshot, a, p, ws, git);
      if (reason) break;
    }
    if (!reason && needsExit && !exitCommandFor(agents[0].agent)) reason = 'agent kind has no declared exit command';
    const tabAuthority = { ...authority,
      callbacks: (snapshot.callbacks ?? []).filter(receipt => receipt.tab === tab.tab_id),
      tabs: authority.tabs.filter(t => t.tab_id === tab.tab_id), panes: authority.panes.filter(p => p.tab_id === tab.tab_id || ps.some(q => q.pane_id === p.pane_id)),
      agents: authority.agents.filter(a => agents.some(original => original.pane_id === a.pane_id) || (snapshot.handoffs ?? []).some(h =>
        agents.some(old => matchingRun(old, snapshot.record.runs)?.id === h.from) && matchingRun(a, snapshot.record.runs)?.id === h.to)),
    };
    const tabToken = createHash('sha256').update(JSON.stringify(stable(tabAuthority))).digest('hex');
    const released = agents.filter(a => matchingRelease(snapshot, a, matchingRun(a, snapshot.record.runs), git)).map(a => matchingRun(a, snapshot.record.runs).id);
    const decision = { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label ?? '',
      decision: reason ? 'keep' : needsExit ? 'exit' : 'release',
      ...(needsExit && !reason ? { exit: exitCommandFor(agents[0].agent), agent: agents[0].name, pane: ps[0].pane_id,
        occupant: occupantIdentity(agents[0]), shell: { pid: exitTree.shell.pid, identity: exitTree.shell.identity, command: exitTree.shell.command } } : {}),
      why: reason ?? (needsExit ? 'recorded idle agent and its descendants; exit before closing the shell' : callback ? `recorded ${callback.kind} callback complete; unchanged process and shell identity` : released.length ? `record release for ${released.join(', ')}; exact session and head` : `${agents.map(a => matchingRun(a, snapshot.record.runs)?.id).join(', ')}: ingested report and terminal chain, or confirmed retained successor`), token: tabToken };
    (reason ? keep : close).push(decision);
    for (const p of ps) panes.push({ ...decision, pane_id: p.pane_id });
  }
  const laneClose = [], laneKeep = [];
  if (snapshot.removal) {
    const reason = laneRemovalReason(snapshot, snapshot.removal.cwd);
    (reason ? laneKeep : laneClose).push({ ...snapshot.removal, token, decision: reason ? 'keep' : 'release', why: reason ?? 'lane removal preconditions verified' });
  }
  const followUps = new Map();
  for (const git of snapshot.git ?? []) for (const run of rows(snapshot.record?.runs).filter(r => inside(r.workspace, git.path))) {
    for (const item of followUpsFor(chainFor(snapshot.record, run), git).items) if (!followUps.has(item.id)) followUps.set(item.id, {
      type: 'follow-up', item: item.id, title: item.title, owner: item.role ?? 'unknown', cwd: git.path,
      reason: `${item.id}: ${item.title ?? ''}; owner role ${item.role ?? 'unknown'}`,
      nextAction: 'dispatch or disposition in its own lane',
    });
  }
  return { close, keep, panes, laneClose, laneKeep, ...(snapshot.retirementHold ? { held: snapshot.retirementHold } : {}), diagnostics: [...(diagnostics ?? []),
    ...followUps.values(),
    ...[...new Set(snapshot.errors ?? [])].map(reason => ({ reason, scope: 'project' })),
    ...(snapshot.git ?? []).filter(g => g.error).map(g => ({ reason: g.error, cwd: g.path }))], token };
}

// One executor for every close path. Read failures and concurrent reactivation
// are refusals, never permissions. Callers log the fresh refusal reason.
export function executeRetirement(plan, { observe, close, closeWorkspace, removeLane, exit, exitObserved = () => {},
  lockTab = () => () => {}, exitTimeoutMs = 60000, now = Date.now,
  pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  hold = () => null, log = () => {} }) {
  const results = [];
  const held = (candidate, why) => {
    const result = { ...candidate, decision: 'keep', action: 'held', why };
    log(result); results.push(result);
  };
  const initialHold = hold() ?? plan.held;
  if (initialHold) {
    for (const candidate of [...(plan.close ?? []), ...(plan.keep ?? []), ...(plan.workspaceClose ?? []), ...(plan.laneClose ?? []), ...(plan.laneKeep ?? [])]) held(candidate, initialHold);
    return results;
  }
  for (const candidate of plan.close) {
    let unlock;
    try {
      unlock = lockTab(candidate.tab_id);
      let reason = hold();
      if (reason) { held(candidate, reason); continue; }
      let snapshot = observe(), fresh = planRetirement(snapshot);
      reason = hold() ?? snapshot.retirementHold;
      if (reason) { held(candidate, reason); continue; }
      let current = [...fresh.close, ...fresh.keep].find(t => t.tab_id === candidate.tab_id);
      if (!current) { results.push({ action: 'already-gone', ...candidate }); continue; }
      if (current.decision !== candidate.decision || current.decision === 'keep' || current.token !== candidate.token) {
        const result = { ...current, action: 'skip-close', why: current.decision === 'keep' ? current.why : 'authority changed since plan; replan required' };
        log(result); results.push(result); continue;
      }
      if (current.decision === 'exit') {
        if (!exit) throw Error('agent exit transport is unavailable');
        exit(current);
        const until = now() + Math.min(60000, Math.max(0, exitTimeoutMs));
        for (;;) {
          snapshot = observe();
          reason = hold() ?? snapshot.retirementHold;
          if (reason) break;
          if (!sameExitOccupant(candidate, snapshot)) { reason = 'occupant or shell identity changed during agent exit'; break; }
          const pane = snapshot.panes.find(p => p.pane_id === candidate.pane);
          if (pane.shellOnly && pane.process_info.process_tree?.length === 1) { exitObserved(); break; }
          if (now() >= until) { reason = 'agent did not exit through its exit command'; break; }
          pause(Math.min(250, until - now()));
        }
        if (reason) {
          const result = { ...candidate, decision: 'keep', action: 'skip-close', why: reason }; log(result); results.push(result); continue;
        }
        // The exit is not close authority. Re-observe after the wait and use the
        // ordinary release policy, still bound to the original shell/occupant.
        snapshot = observe(); fresh = planRetirement(snapshot);
        reason = hold() ?? snapshot.retirementHold;
        current = [...fresh.close, ...fresh.keep].find(t => t.tab_id === candidate.tab_id);
        if (!sameExitOccupant(candidate, snapshot)) reason ??= 'occupant or shell identity changed during agent exit';
        const pane = snapshot.panes.find(p => p.pane_id === candidate.pane);
        if (!pane?.shellOnly || pane.process_info.process_tree?.length !== 1) reason ??= 'another process appeared after agent exit';
        if (reason || current?.decision !== 'release') {
          const result = { ...candidate, decision: 'keep', action: 'skip-close', why: reason ?? current?.why ?? 'tab disappeared during agent exit' };
          log(result); results.push(result); continue;
        }
      }
      close(current.tab_id);
      const result = { ...current, action: 'closed' }; log(result); results.push(result);
    } catch (error) {
      const result = { ...candidate, ...(candidate.decision === 'exit' ? { decision: 'keep' } : {}),
        action: error.code === 'RETIREMENT_DEADLINE' ? 'deferred' : candidate.decision === 'exit' ? 'skip-close' : 'close-failed', why: error.message, error: error.message };
      log(result); results.push(result);
      if (result.action === 'deferred') return results;
    } finally { unlock?.(); }
  }
  for (const candidate of plan.laneClose ?? []) {
    try {
      let reason = hold();
      if (reason) { held(candidate, reason); continue; }
      const snapshot = observe(), fresh = planRetirement(snapshot);
      reason = hold() ?? snapshot.retirementHold;
      if (reason) { held(candidate, reason); continue; }
      const current = [...fresh.laneClose, ...fresh.laneKeep].find(row => row.branch === candidate.branch);
      if (!current || current.decision !== 'release' || current.token !== candidate.token) {
        const result = { ...candidate, action: 'skip-close', why: current?.decision === 'keep' ? current.why : 'authority changed since lane removal plan' };
        log(result); results.push(result); continue;
      }
      removeLane(current);
      const result = { ...current, action: 'lane-removed' }; log(result); results.push(result);
    } catch (error) {
      const result = { ...candidate, action: 'close-failed', why: error.message }; log(result); results.push(result);
    }
  }
  for (const candidate of plan.workspaceClose ?? []) {
    try {
      let holdReason = hold();
      if (holdReason) { held(candidate, holdReason); continue; }
      const snapshot = observe(), fresh = planRetirement(snapshot);
      holdReason = hold() ?? snapshot.retirementHold;
      if (holdReason) { held(candidate, holdReason); continue; }
      const reason = standardSlotReason(snapshot, { workspace: candidate.workspace_id, cwd: candidate.cwd }) ?? laneRemovalReason(snapshot, candidate.cwd);
      if (reason || fresh.token !== candidate.token) {
        const result = { ...candidate, action: 'skip-close', why: reason ?? 'authority changed since empty workspace plan' };
        log(result); results.push(result); continue;
      }
      closeWorkspace(candidate.workspace_id);
      const result = { ...candidate, action: 'closed' }; log(result); results.push(result);
    } catch (error) {
      const result = { ...candidate, action: error.code === 'RETIREMENT_DEADLINE' ? 'deferred' : 'close-failed', why: error.message }; log(result); results.push(result);
      if (result.action === 'deferred') return results;
    }
  }
  return results;
}

// Git-only removal requires zero live panes, including releasable panes which
// have not actually been closed. A kept/unknown pane can never lose its cwd.
export function laneRemovalReason(snapshot, cwd) {
  if (snapshot.retirementHold) return snapshot.retirementHold;
  if (snapshot.errors?.length) return snapshot.errors[0];
  const protection = standardSlotReason(snapshot, { cwd });
  if (protection) return protection;
  const runs = rows(snapshot.record?.runs).filter(r => inside(r.workspace, cwd) ||
    (snapshot.removal && r.meta?.lane === snapshot.removal.branch.slice(5)));
  if (runs.some(r => !r.report && !r.abandoned)) return 'open recorded run uses lane';
  const git = snapshot.git?.find(g => samePath(g.path, cwd));
  const ids = new Set(runs.flatMap(r => [...chainFor(snapshot.record, r).ids]));
  for (const run of runs) {
    const reason = terminalReason(chainFor(snapshot.record, run), git);
    if (reason) return reason;
  }
  if (git?.error) return git.error;
  if (snapshot.removal && (!git?.clean || (!git.integrated && !git.archived))) return 'lane is not clean and integrated or archived';
  const ref = referenceReason(snapshot, { ids, runIds: new Set(runs.map(r => r.id)), cwd,
    lane: git?.lane ?? runs.find(r => r.meta?.lane)?.meta.lane, head: git?.head });
  if (ref) return ref;
  const ws = snapshot.workspaces.filter(w => samePath(w.worktree?.checkout_path, cwd));
  if (ws.some(w => w.lab_owned || w.operator || w.persistent || !w.worktree.is_linked_worktree)) return 'persistent, operator or lab workspace';
  if (snapshot.panes.some(p => ws.some(w => w.workspace_id === p.workspace_id) || snapshot.tabs.some(t => t.tab_id === p.tab_id && ws.some(w => w.workspace_id === t.workspace_id))) ||
      snapshot.agents.some(a => inside(a.cwd, cwd))) return 'occupied lane; retire panes before removing the worktree';
  return null;
}
