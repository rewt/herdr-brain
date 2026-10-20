// Git identity is project identity, including linked worktrees and symlinks.
// No harness metadata participates in discovery or authorization.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs';

export function ignoreRuntime(project) {
  const file = path.join(project.identity, 'info/exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const additions = ['.org/', '.lane/'].filter((s) => !before.split('\n').includes(s));
  if (additions.length) fs.appendFileSync(file, `\n${additions.join('\n')}\n`);
}

export function gitProject(cwd = process.cwd(), { deadline, timeoutMs, env, includeHead = false } = {}) {
  const git = (dir, args) => {
    const remaining = deadline === undefined ? Infinity : deadline - Date.now();
    if (remaining <= 0) throw Error('project decision deadline reached');
    const timeout = Math.min(timeoutMs ?? Infinity, remaining);
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
      ...(Number.isFinite(timeout) ? { timeout: Math.max(1, Math.floor(timeout)), killSignal: 'SIGKILL' } : {}),
    }).trim();
  };
  // Most identity fences enter at the checkout root. Ask Git for both paths
  // in one fresh invocation; canonical discovery below is still performed.
  const paths = git(cwd, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']).split('\n');
  const checkout = realpathSync(paths.length === 2 ? paths[0] : git(cwd, ['rev-parse', '--show-toplevel']));
  // Preserve relative Git-selector semantics for a subdirectory invocation,
  // and the original single-path parsing for unusual newline-bearing paths.
  const identity = realpathSync(paths.length === 2 && realpathSync(cwd) === checkout ? paths[1]
    : git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const entries = git(checkout, ['worktree', 'list', '--porcelain']).split('\n\n');
  for (const entry of entries) {
    const candidate = entry.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
    if (!candidate) continue;
    try {
      // The ordinary main checkout's .git directory is already the common
      // directory we resolved through Git. Git files (linked worktrees and
      // separate git dirs) still need Git to identify their own directory.
      const marker = path.join(candidate, '.git');
      const directory = fs.statSync(marker, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(marker)
        : realpathSync(git(candidate, ['rev-parse', '--path-format=absolute', '--git-dir']));
      if (directory === identity) {
        return { checkout, canonical: realpathSync(candidate), identity,
          ...(includeHead ? { head: entry.split('\n').find(line => line.startsWith('HEAD '))?.slice(5) } : {}) };
      }
    } catch {}
  }
  throw new Error('canonical checkout is unavailable');
}
