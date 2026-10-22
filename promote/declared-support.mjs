// Generic containment, immutable Git bindings and finite attempt clocks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { refuse, relative, MAX_BYTES } from './declaration.mjs';

export function remaining(deadline) {
  const ms = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || ms <= 0) throw Object.assign(Error('DECLARED_GATE_TIMEOUT: attempt deadline exceeded'), { code: 'DECLARED_GATE_TIMEOUT' });
  return ms;
}
export function git(root, args, deadline = Date.now() + 20000) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: Math.min(20000, remaining(deadline)), maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw refuse(`Git binding unavailable: ${r.stderr || r.error?.message || r.status}`);
  return r.stdout.trim();
}
export function contained(root, name = '.') {
  if (!relative(name, { dot: true })) throw refuse('cwd/input must be project-relative');
  const base = fs.realpathSync(root), resolved = fs.realpathSync(path.resolve(base, name));
  const rel = path.relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw refuse('cwd/input escapes the project');
  return resolved;
}
export function captureGit(cwd, common, deadline) {
  if (fs.realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], deadline)) !== common) throw refuse('candidate Git common directory changed');
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], deadline)) throw refuse('candidate tracked/untracked content changed');
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD'], deadline);
  return { head: git(cwd, ['rev-parse', 'HEAD'], deadline), tree: git(cwd, ['rev-parse', 'HEAD^{tree}'], deadline), branch };
}
