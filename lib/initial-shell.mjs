// Creation-time identity only. Never infer a launch from an existing workspace.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lookupProcess } from './processes.mjs';
import { writeFileAtomic } from './store.mjs';

export const initialShellDirectory = common => path.join(common, 'retirement/initial-shells');
export const initialShellFile = (common, tab) => path.join(initialShellDirectory(common), createHash('sha256').update(tab).digest('hex') + '.json');
const text = value => typeof value === 'string' && value.length > 0;
export function validInitialShell(receipt) {
  return receipt?.schema === 'initial-shell/v1' &&
    ['common', 'cwd', 'workspace', 'tab', 'pane', 'terminal'].every(k => text(receipt[k])) &&
    path.isAbsolute(receipt.common) && path.isAbsolute(receipt.cwd) &&
    Number.isSafeInteger(receipt.shell?.pid) && receipt.shell.pid > 0 &&
    ['identity', 'command'].every(k => text(receipt.shell[k])) &&
    (receipt.claimed === undefined || receipt.claimed === true);
}

export function recordInitialShell({ common, cwd, created, h, readProcess = pid => lookupProcess(pid, { identityOnly: true }) }) {
  // worktree.create always creates; worktree.open must explicitly say it did.
  if (!(created?.already_open === false || created?.type === 'worktree_created') || created.already_open === true) return null;
  const workspace = created.workspace?.workspace_id, tab = created.tab?.tab_id, pane = created.root_pane?.pane_id;
  if (![workspace, tab, pane].every(text) || created.tab.workspace_id !== workspace ||
      created.root_pane.workspace_id !== workspace || created.root_pane.tab_id !== tab) return null;
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
    shell: { pid: shell.pid, identity: shell.identity, command: shell.command } };
  const file = initialShellFile(receipt.common, tab);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A reused native ID or repeated invocation cannot replace earlier evidence.
  fs.writeFileSync(file, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

// Claim before starting anything in a reused initial pane. Keep the original
// receipt so neither this path nor the legacy exception can forget the claim.
export function claimInitialShell(common, tab) {
  const file = initialShellFile(common, tab);
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!validInitialShell(receipt)) throw Error('invalid initial shell receipt');
  writeFileAtomic(file, JSON.stringify({ ...receipt, claimed: true }) + '\n');
}
