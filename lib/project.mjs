// Git identity is project identity, including linked worktrees and symlinks.
// No harness metadata participates in discovery or authorization.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export function gitProject(cwd = process.cwd()) {
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const checkout = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const identity = realpathSync(git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const entries = git(checkout, ['worktree', 'list', '--porcelain']).split('\n\n');
  for (const entry of entries) {
    const candidate = entry.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
    if (!candidate) continue;
    try {
      if (realpathSync(git(candidate, ['rev-parse', '--path-format=absolute', '--git-dir'])) === identity) {
        return { checkout, canonical: realpathSync(candidate), identity };
      }
    } catch {}
  }
  throw new Error('canonical checkout is unavailable');
}
