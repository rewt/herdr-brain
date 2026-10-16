import fs from 'node:fs';
import { TEST_SLOT_PATH, holderState } from '../test-slot/test-slot.mjs';
import { readTestSlotQueue } from '../test-slot/ticket-queue.mjs';
import { safeProject, safeStatus, safeTime, safeWorktree, within, WITHHELD } from './rows.mjs';
import { runCommand } from './source.mjs';

export function parseMemory(text, platform) {
  if (platform === 'linux') {
    const match = /^MemAvailable:\s+(\d+) kB\s*$/m.exec(text);
    return match ? Number(match[1]) * 1024 : null;
  }
  if (platform === 'darwin') {
    const size = /page size of (\d+) bytes/.exec(text);
    const pages = ['free', 'inactive', 'speculative'].map(name => new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'm').exec(text));
    return size && pages.every(Boolean) ? Number(size[1]) * pages.reduce((sum, m) => sum + Number(m[1]), 0) : null;
  }
  return null;
}
export async function availableMemory() {
  try {
    if (process.platform === 'linux') return parseMemory(fs.readFileSync('/proc/meminfo', 'utf8'), 'linux');
    if (process.platform === 'darwin') {
      const r = await runCommand('vm_stat', [], { timeout: 2000 });
      return r.code ? null : parseMemory(r.text, 'darwin');
    }
  } catch { /* Unknown is a fact, not raw diagnostic output. */ }
  return null;
}
export async function paneState({ command = 'herdr', env = process.env } = {}) {
  const r = await runCommand(command, ['agent', 'list'], { env, timeout: 3000 });
  if (r.code) return { state: 'unavailable', panes: new Set() };
  try {
    const agents = JSON.parse(r.text).result?.agents;
    if (!Array.isArray(agents)) throw Error();
    return { state: 'available', panes: new Set(agents.map(a => a.pane_id).filter(id => typeof id === 'string' && /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(id))) };
  } catch { return { state: 'unavailable', panes: new Set() }; }
}
export function readSlot({ lockPath = TEST_SLOT_PATH, projects = [], now = Date.now() } = {}) {
  let holder = null, state = 'free', tickets = [];
  try {
    const fd = fs.openSync(lockPath, 'r');
    try { holder = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
    state = holderState(holder).state;
  }
  catch (e) { if (e.code !== 'ENOENT') state = 'unknown'; }
  try { tickets = readTestSlotQueue(lockPath, { prune: false, now }).tickets.filter(t => ['live', 'unknown'].includes(t.state)); }
  catch { state = 'unknown'; }
  const cwd = safeWorktree(holder?.cwd);
  const project = projects.find(p => p.paths.some(root => cwd !== WITHHELD && within(root, cwd)));
  const acquired = safeTime(holder?.acquiredAt);
  const heldSeconds = typeof acquired === 'string' && acquired !== WITHHELD ? Math.max(0, Math.floor((now - Date.parse(acquired)) / 1000)) : null;
  return {
    state, label: holder ? safeStatus(holder.label) : null, project: project ? safeProject(project.name) : null, heldSeconds,
    queueLength: tickets.length,
    // These validated paths stay inside collection and are never returned by the CLI.
    holderWorktree: state !== 'gone' && holder ? cwd : null,
    queueWorktrees: tickets.map(t => safeWorktree(t.ticket?.cwd)),
  };
}
export function rowSlot(worktree, slot) {
  if (!worktree || worktree === WITHHELD) return '';
  const match = cwd => cwd && cwd !== WITHHELD && within(worktree, cwd);
  if (match(slot.holderWorktree)) return 'holder';
  const index = slot.queueWorktrees.findIndex(match);
  return index < 0 ? '' : `#${index + 1} in queue`;
}
