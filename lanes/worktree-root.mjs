// One precedence rule for lane creation and adoption's frozen migration.
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { configBase } from '../lib/config-policy.mjs';

export function resolveWorktreeRoot({ cwd, repository, config, sources, boundary, explicitConfig, parentConfig, env = process.env }) {
  if (env.LANE_WORKTREE_ROOT !== undefined) {
    const path = resolve(cwd, env.LANE_WORKTREE_ROOT);
    return { path, base: path, source: 'env' };
  }
  // Configured roots beat fleet mappings; existing lanes retain their paths.
  if (Object.hasOwn(config, 'worktree_root')) {
    const source = sources.get('worktree_root');
    const base = resolve(configBase(source, repository, env, 'worktree_root'), config.worktree_root);
    return { path: join(base, basename(repository)), base, source };
  }
  if (boundary.project && !explicitConfig) return { path: boundary.project.worktrees, base: boundary.project.worktrees, source: boundary.fleet.file };
  if (!explicitConfig && parentConfig !== undefined) {
    const base = join(dirname(parentConfig), '.worktrees');
    return { path: join(base, basename(repository)), base, source: parentConfig };
  }
  const base = join(env.HOME ?? homedir(), '.herdr', 'worktrees');
  return { path: join(base, basename(repository)), base, source: 'default' };
}
