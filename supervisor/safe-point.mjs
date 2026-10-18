// Observation only. No lock acquisition, stale recovery, input or lifecycle API.
import fs from 'node:fs';
import path from 'node:path';
import { findOrgDir } from '../lib/store.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { readInbox } from './prompt-supervisor.mjs';
import { invokeHerdr } from './herdr-edge.mjs';

const live = row => !/^[ZX]/.test(row.state);
function under(pid, ancestor, rows) {
  const seen = new Set();
  while (rows.has(pid)) {
    if (pid === ancestor) return true;
    if (seen.has(pid)) throw Error('process ancestry contains a cycle');
    seen.add(pid); pid = rows.get(pid).ppid;
  }
  return false;
}
const binding = (pane, agents) => {
  const occupants = agents.filter(a => a.pane_id === pane.pane_id);
  if (occupants.length !== 1 || !occupants[0].name || occupants[0].workspace_id !== pane.workspace_id)
    throw Error('pane needs exactly one named agent in its workspace');
  const a = occupants[0];
  return { pane: pane.pane_id, workspace: pane.workspace_id, terminal: pane.terminal_id,
    name: a.name, agentTerminal: a.terminal_id, session: a.agent_session?.value, cwd: a.cwd };
};

export function safePoint({ cwd = process.cwd(), org, pane, herdr = 'herdr', readProcess = lookupProcess, call } = {}) {
  if (typeof pane !== 'string' || !pane.trim()) throw Error('--pane is required');
  org ??= findOrgDir({ cwd });
  if (!org) throw Error('no record discovered');
  org = fs.realpathSync(org);
  call ??= args => {
    const reply = JSON.parse(invokeHerdr(herdr, args));
    if (!reply.result || reply.ok === false || reply.error) throw Error('invalid Herdr read reply');
    return reply.result;
  };
  const reasons = [], checks = { processes: null, record_lock: null, notices: null };
  const unknown = (source, error) => reasons.push({ kind: 'unknown', source, message: `${source}: ${error.message}` });
  let first, name = null, workspace = null;
  try {
    const physical = call(['pane', 'get', pane]).pane;
    if (physical?.pane_id !== pane || !physical.workspace_id) throw Error('named pane missing from reply');
    const agents = call(['agent', 'list']).agents;
    if (!Array.isArray(agents)) throw Error('agent list unavailable');
    first = binding(physical, agents); name = first.name; workspace = first.workspace;
  } catch (error) { unknown('pane agent', error); }

  try {
    if (!first) throw Error('pane agent binding unavailable');
    const info = call(['pane', 'process-info', '--pane', pane]).process_info;
    if (!Number.isSafeInteger(info?.shell_pid) || info.shell_pid < 1 || !Array.isArray(info.foreground_processes)) throw Error('incomplete pane process info');
    const snapshot = readProcess();
    if (!snapshot?.ok || !(snapshot.value instanceof Map)) throw Error(snapshot?.error ?? 'complete process source unavailable');
    const rows = snapshot.value;
    for (const [pid, row] of rows) if (pid !== row.pid || !Number.isSafeInteger(pid) || pid < 1 ||
        !Number.isSafeInteger(row.ppid) || row.ppid < 0 || !row.state || !row.identity || !row.command) throw Error('incomplete process row');
    if (!rows.has(info.shell_pid) || !live(rows.get(info.shell_pid))) throw Error('pane shell absent from process source');
    const foreground = [...new Set(info.foreground_processes.map(p => p.pid))].filter(pid => pid !== info.shell_pid);
    if (!foreground.length || foreground.some(pid => !rows.has(pid) || !live(rows.get(pid)) || !under(pid, info.shell_pid, rows)))
      throw Error('foreground harness absent, dead or outside pane shell');
    const roots = foreground.filter(pid => !foreground.some(other => other !== pid && under(pid, other, rows)));
    if (roots.length !== 1) throw Error('foreground harness root is ambiguous');
    const root = roots[0], observers = new Set();
    // Running this check from the agent creates its own shell/Node ancestry.
    // Exclude only that exact branch; sibling/background jobs remain visible.
    const observerBranch = process.pid !== root && under(process.pid, root, rows);
    if (observerBranch) {
      for (let pid = process.pid; pid !== root; pid = rows.get(pid).ppid) observers.add(pid);
    }
    const children = [...rows.values()].filter(row => row.pid !== root && live(row) && !observers.has(row.pid) &&
      !(observerBranch && under(row.pid, process.pid, rows)) && under(row.pid, root, rows));
    checks.processes = { harness_pid: root, observer_pids: [...observers], children };
    for (const child of children) reasons.push({ kind: 'child_process', pid: child.pid,
      message: `PID ${child.pid} under harness ${root}: ${child.command}` });
  } catch (error) { unknown('processes', error); }

  const lock = path.join(org, 'lock');
  try {
    try { fs.lstatSync(lock); }
    catch (error) { if (error.code === 'ENOENT') { checks.record_lock = { held: false, path: lock }; } else throw error; }
    if (!checks.record_lock) {
      let owner = null;
      try { owner = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(); } catch { /* Unknown owner still holds. */ }
      checks.record_lock = { held: true, path: lock, owner };
      reasons.push({ kind: 'record_lock', message: `record lock present: ${lock}${owner ? ` (pid ${owner})` : ' (owner unknown)'}` });
    }
  } catch (error) { unknown('record lock', error); }

  try {
    if (!name) throw Error('slot agent name unavailable');
    const inbox = path.join(org, 'supervisor/inbox.log');
    let absent = false;
    try { fs.lstatSync(inbox); }
    catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
    // Distinguish a missing journal from a dangling link or unreadable source;
    // readInbox's legacy exists check alone cannot make that distinction.
    if (!absent && !fs.statSync(inbox).isFile()) throw Error('inbox is not a regular file');
    const entries = absent ? [] : readInbox(inbox);
    if (entries.some(e => typeof e.to !== 'string' || !e.to || !e.id)) throw Error('incomplete notice addressing');
    const pending = entries.filter(e => e.to === name && !['sent', 'handled'].includes(e.state));
    checks.notices = { inbox, pending: pending.map(e => ({ id: e.id, state: e.state })) };
    for (const entry of pending) reasons.push({ kind: entry.state === 'uncertain' ? 'unacknowledged_notice' : 'undelivered_notice', id: entry.id,
      message: `notice ${entry.id} to ${name}: ${entry.state === 'uncertain' ? 'delivery unacknowledged' : 'undelivered'}` });
  } catch (error) { unknown('notices', error); }

  if (first) try {
    const physical = call(['pane', 'get', pane]).pane, agents = call(['agent', 'list']).agents;
    if (physical?.pane_id !== pane || !Array.isArray(agents) || JSON.stringify(binding(physical, agents)) !== JSON.stringify(first))
      throw Error('pane agent changed during observation');
  } catch (error) { unknown('pane recheck', error); }
  return { pane, workspace, agent: name, safe: reasons.length === 0, checks, reasons };
}
