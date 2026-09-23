// Read projections for the live Projects trial. Session metadata is display-only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildBoard } from '../lib/model.mjs';

export function canonical(file) {
  if (!file) return null;
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

export function createIdentityReader() {
  const cache = new Map();
  return function identity(folder) {
    if (!folder) return null;
    const cwd = canonical(folder);
    if (cache.has(cwd)) return cache.get(cwd);
    try { if (!fs.statSync(cwd).isDirectory()) return null; } catch { return null; }
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 2000 });
    const key = r.status === 0 ? canonical(r.stdout.trim()) : cwd;
    const root = r.status === 0 && path.basename(key) === '.git' ? path.dirname(key) : cwd;
    const value = { key, root, cwd, git: r.status === 0, name: path.basename(root) || root };
    cache.set(cwd, value);
    return value;
  };
}

export function workspaceIdentity(w, identity) {
  const wt = w.worktree;
  return wt?.repo_key ? { key: canonical(wt.repo_key), root: wt.repo_root, cwd: wt.checkout_path, git: true, name: wt.repo_name }
    : identity(w.cwd ?? w.path);
}

export function catalog(configured, workspaces, identity, opened = []) {
  const result = [...configured, ...opened].map((p) => {
    const repo = identity(p.cwd);
    return { ...p, id: p.id ?? `configured:${p.name}`, repoKey: repo?.key, root: repo?.root ?? p.cwd, git: Boolean(repo?.git), configured: Boolean(p.org) };
  });
  const known = new Set(result.map(p => p.repoKey).filter(Boolean));
  for (const w of workspaces) {
    const repo = workspaceIdentity(w, identity);
    if (!repo?.key || known.has(repo.key)) continue;
    known.add(repo.key);
    result.push({ id: `discovered:${repo.key}`, name: repo.name ?? path.basename(repo.root), cwd: repo.root, root: repo.root, repoKey: repo.key, git: repo.git, org: null, configured: false });
  }
  return result;
}

export function projectView(project, data, identity) {
  const empty = { sessions: [], goals: [], tasks: [], needs: [], later: [], parked: [], allNeeds: [], spaces: [], tabs: [], items: [], itemsById: new Map() };
  if (!project) return empty;
  const spaces = data.workspaces.filter(w => workspaceIdentity(w, identity)?.key === project.repoKey && project.repoKey);
  const spacesById = new Map(spaces.map(w => [w.workspace_id, w]));
  // Current cwd wins over a workspace label. Repo names and branch prefixes are
  // never used to assign sessions or decide whether a checkout is a worktree.
  const agents = data.agents.filter(a => a.cwd ? identity(a.cwd)?.key === project.repoKey && project.repoKey : spacesById.has(a.workspace));
  const repoOf = cwd => { const r = identity(cwd); return r ? { root: r.key, name: r.name, path: r.root, git: r.git } : null; };
  const sameRun = r => !r.workspace || identity(r.workspace)?.key === project.repoKey;
  const today = data.today ? { ...data.today, running: (data.today.running ?? []).filter(sameRun), agent_runs: (data.today.agent_runs ?? []).filter(sameRun) } : null;
  const board = buildBoard({ today, brain: data.brain, herdr: { ok: true, agents }, tabs: data.tabs.map(t => ({ tab: t.tab_id, label: t.label, workspace: t.workspace_id })), repoOf, projectName: project.name, fallbackCwd: project.cwd });
  const items = data.status?.items ?? [];
  const itemsById = new Map(items.map(i => [i.id, i]));
  const goalOf = item => { const visited = new Set(); for (let i = item; i && !visited.has(i.id); i = itemsById.get(i.parent)) { if (i.kind === 'goal') return i.id; visited.add(i.id); } return null; };
  const sessions = board.groups.flatMap(g => g.rows).filter(row => row.live).map(row => ({ ...row, pane: row.live?.pane, tab: row.live?.tab, space: row.live?.workspace,
    task: itemsById.has(row.run?.item) ? row.run.item : null, goal: goalOf(itemsById.get(row.run?.item)),
    recorded: Boolean(row.run && !(today?.running ?? []).some(r => r.run === row.run.run)),
  }));
  // A pane can cd into this project while its workspace belongs to another repo.
  // Keep its actual checkout available, without reparenting that workspace.
  const tabIds = new Set(sessions.map(s => s.tab));
  const tabs = data.tabs.filter(t => spacesById.has(t.workspace_id) || tabIds.has(t.tab_id));
  return { ...empty, items, itemsById, board, sessions, spaces, tabs,
    goals: items.filter(i => i.kind === 'goal' && !i.closed),
    tasks: items.filter(i => i.kind !== 'goal' && i.role !== 'human' && !['done', 'dropped'].includes(i.status)).map(i => ({ ...i, goal: goalOf(i) })),
    needs: board.waiting.filter(i => i.kind !== 'fold' && !i.foldedIn),
    later: board.waiting.filter(i => i.foldedIn === 'later'), parked: board.waiting.filter(i => i.foldedIn === 'stages'), allNeeds: board.waiting.filter(i => i.kind !== 'fold'),
  };
}

export function folderPath(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Enter a folder path.');
  const cwd = canonical(path.resolve(value.replace(/^~(?=$|\/)/, os.homedir())));
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Choose a directory.');
  return cwd;
}

export function acceptanceCriteria(item) {
  return (Array.isArray(item.accept) ? item.accept : [item.accept]).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

export function relatedWork(model, itemId) {
  const within = id => {
    const visited = new Set();
    for (let item = model.itemsById.get(id); item && !visited.has(item.id); item = model.itemsById.get(item.parent)) {
      if (item.id === itemId) return true;
      visited.add(item.id);
    }
    return false;
  };
  const linked = model.sessions.filter(a => a.task && within(a.task));
  return { tasks: model.tasks.filter(t => t.id !== itemId && within(t.id)), current: linked.filter(a => !a.recorded), historical: linked.filter(a => a.recorded), unlinked: model.sessions.filter(a => !a.task).length };
}
