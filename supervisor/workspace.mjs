// Resolve a live canonical workspace without relying on UI-published metadata.
// worktree list resolves Git from --cwd, including unseen background shells.
import { realpathSync } from 'node:fs';
import { gitProject } from '../lib/project.mjs';

const samePath = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
};

export function canonicalWorkspaceId(cwd, herdr) {
  const project = gitProject(cwd);
  if (!samePath(cwd, project.canonical)) throw new Error(`${cwd} is not the canonical checkout`);
  const listed = herdr(['worktree', 'list', '--cwd', project.canonical]);
  if (!listed.ok) throw new Error(`herdr worktree list failed: ${listed.error}`);
  const { source, worktrees } = listed.result ?? {};
  if (!samePath(source?.repo_key, project.identity) ||
      !samePath(source?.repo_root, project.canonical) ||
      !samePath(source?.source_checkout_path, project.canonical)) {
    throw new Error(`Herdr worktree source has a repository identity mismatch for ${project.canonical}`);
  }
  const rows = worktrees?.filter((w) => samePath(w.path, project.canonical) && w.is_linked_worktree === false);
  const id = rows?.length === 1 ? rows[0].open_workspace_id : undefined;
  if (typeof id !== 'string' || !id) throw new Error(`no Herdr workspace has ${project.canonical} as its canonical checkout`);
  const live = herdr(['workspace', 'list']);
  if (!live.ok) throw new Error(`herdr workspace list failed: ${live.error}`);
  const workspace = live.result?.workspaces?.find((w) => w.workspace_id === id);
  if (!workspace) throw new Error(`Herdr workspace ${id} is no longer open`);
  // Missing UI metadata is expected in a cold background workspace. Conflicting
  // metadata is never overridden by the native resolver receipt.
  const metadata = workspace.worktree;
  if (metadata !== undefined && (!samePath(metadata.repo_key, project.identity) ||
      !samePath(metadata.repo_root, project.canonical) ||
      !samePath(metadata.checkout_path, project.canonical) || metadata.is_linked_worktree !== false)) {
    throw new Error(`Herdr workspace ${id} has a repository identity mismatch; refusing stale metadata`);
  }
  return id;
}
