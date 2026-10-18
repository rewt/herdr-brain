// Creation-time identity only. Never infer a launch from an existing workspace.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lookupProcess } from './processes.mjs';
import { writeFileAtomic } from './files.mjs';
import { retirementLock } from './retire-lock.mjs';

export const initialShellDirectory = common => path.join(common, 'retirement/initial-shells');
export const initialShellFile = (common, tab) => path.join(initialShellDirectory(common), createHash('sha256').update(tab).digest('hex') + '.json');
const text = value => typeof value === 'string' && value.length > 0;
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const initialShellLock = (common, tab, options) => retirementLock(path.join(common, 'retirement/tabs', createHash('sha256').update(tab).digest('hex')), options);
const laneOpenFile = (common, cwd) => path.join(common, 'retirement/lane-opens', createHash('sha256').update(cwd).digest('hex') + '.json');
export function recordLaneOpen(common, cwd, base) {
  common = fs.realpathSync(common); cwd = fs.realpathSync(cwd);
  if (!commit(base)) throw Error('invalid lane opening base');
  writeFileAtomic(laneOpenFile(common, cwd), JSON.stringify({ schema: 'lane-open/v1', common, cwd, base }) + '\n', 0o600);
}

// Missing provenance never proves a lane has finished. A terminal recorded
// chain may supply that disposition; otherwise retain fresh/unknown lanes.
export function initialShellHistory(common, cwd, head, branch, git) {
  try {
    let origin;
    try { origin = JSON.parse(fs.readFileSync(laneOpenFile(common, cwd), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (origin && (origin.schema !== 'lane-open/v1' || origin.common !== common || origin.cwd !== cwd || !commit(origin.base) ||
        git(['rev-parse', '--verify', `${origin.base}^{commit}`]) !== origin.base)) return 'unknown';
    if (origin?.base === head) return 'fresh';
    const entries = git(['reflog', 'show', '--format=%H%x00%gs', `refs/heads/${branch}`]).split('\n').filter(Boolean).map(line => line.split('\0'));
    if (entries.length && entries[0][0] === head && entries.every(row => row.length === 2)) {
      const creation = entries.at(-1);
      if (creation[1].startsWith('branch: Created from ')) return creation[0] === head ? 'fresh' : 'progressed';
    }
    return origin ? 'progressed' : 'unknown';
  } catch { return 'unknown'; }
}
export function validInitialShell(receipt) {
  return receipt?.schema === 'initial-shell/v1' &&
    ['common', 'cwd', 'workspace', 'tab', 'pane', 'terminal'].every(k => text(receipt[k])) &&
    path.isAbsolute(receipt.common) && path.isAbsolute(receipt.cwd) &&
    Number.isSafeInteger(receipt.shell?.pid) && receipt.shell.pid > 0 &&
    ['identity', 'command'].every(k => text(receipt.shell[k])) &&
    (receipt.claimed === undefined || receipt.claimed === true);
}

export function recordInitialShell({ common, cwd, created, h, claimed = false, locked = false, deadline,
  readProcess = pid => lookupProcess(pid, { identityOnly: true }) }) {
  // worktree.create always creates; worktree.open must explicitly say it did.
  if (!(created?.already_open === false || created?.type === 'worktree_created') || created.already_open === true) return null;
  const workspace = created.workspace?.workspace_id, tab = created.tab?.tab_id, pane = created.root_pane?.pane_id;
  if (![workspace, tab, pane].every(text) || created.tab.workspace_id !== workspace ||
      created.root_pane.workspace_id !== workspace || created.root_pane.tab_id !== tab) return null;
  const unlock = locked ? null : initialShellLock(common, tab, { deadline });
  try {
    const info = h(['pane', 'process-info', '--pane', pane])?.process_info;
    const current = h(['pane', 'get', pane])?.pane;
    if (current?.pane_id !== pane || !text(current.terminal_id) || !current.foreground_cwd ||
        (created.root_pane.terminal_id && created.root_pane.terminal_id !== current.terminal_id) ||
        (current.tab_id && current.tab_id !== tab) || (current.workspace_id && current.workspace_id !== workspace) ||
        current.agent || current.agent_session || current.display_agent || current.name || current.launch_pending ||
        fs.realpathSync(current.foreground_cwd) !== fs.realpathSync(cwd) ||
        info?.foreground_processes?.length !== 1 || info.foreground_processes[0].pid !== info.shell_pid) return null;
    const result = info.process_tree_complete === true && Array.isArray(info.process_tree)
      ? { ok: true, value: info.process_tree.find(row => row.pid === info.shell_pid) } : readProcess(info.shell_pid);
    const shell = result.ok && result.value;
    if (!shell?.identity || !shell.command || !/^\[?-?(?:zsh|bash|sh|fish|dash|ash|ksh)\]?$/.test(shell.command)) return null;
    const receipt = { schema: 'initial-shell/v1', common: fs.realpathSync(common), cwd: fs.realpathSync(cwd),
      workspace, tab, pane, terminal: current.terminal_id,
      shell: { pid: shell.pid, identity: shell.identity, command: shell.command }, ...(claimed ? { claimed: true } : {}) };
    const file = initialShellFile(receipt.common, tab);
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (!(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e; }
    // Only an invocation-owned native creation may replace a recycled tab ID.
    // Re-observing the same terminal/shell cannot erase an earlier claim.
    if (validInitialShell(previous) && previous.terminal === receipt.terminal &&
        ['pid', 'identity', 'command'].every(k => previous.shell[k] === receipt.shell[k]))
      throw Object.assign(Error('EEXIST: initial shell identity already recorded'), { code: 'EEXIST' });
    writeFileAtomic(file, JSON.stringify(receipt) + '\n', 0o600);
    return receipt;
  } finally { unlock?.(); }
}

// Claim before starting anything in a reused initial pane. Keep the original
// receipt so neither this path nor the legacy exception can forget the claim.
export function claimInitialShell(common, tab, { locked = false } = {}) {
  const unlock = locked ? null : initialShellLock(common, tab);
  try {
    const file = initialShellFile(common, tab);
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw Error('initial shell receipt is missing; initial pane retained'); throw e; }
    if (!validInitialShell(receipt)) throw Error('invalid initial shell receipt');
    writeFileAtomic(file, JSON.stringify({ ...receipt, claimed: true }) + '\n', 0o600);
  } finally { unlock?.(); }
}
