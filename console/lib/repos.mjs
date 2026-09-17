// Which repository a folder belongs to. A worktree belongs to its main repository:
// git's common directory is the same for both. Answers are cached for the session.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function gitCommonDir(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function homePath(p, home = os.homedir()) {
  const h = home.replace(/\/+$/, '');
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

// repoOf(cwd) → { root, name, path, git } or null for a folder that does not exist.
export function createRepoResolver({ git = gitCommonDir, exists = fs.existsSync, home = os.homedir() } = {}) {
  const cache = new Map();
  return function repoOf(cwd) {
    if (!cwd) return null;
    if (cache.has(cwd)) return cache.get(cwd);
    let repo = null;
    if (exists(cwd)) {
      const common = git(cwd);
      if (common) {
        const root = path.basename(common) === '.git' ? path.dirname(common) : common;
        repo = { root, name: path.basename(root).replace(/\.git$/, ''), path: homePath(root, home), git: true };
      } else {
        repo = { root: cwd, name: path.basename(cwd) || cwd, path: homePath(cwd, home), git: false };
      }
    }
    cache.set(cwd, repo);
    return repo;
  };
}
