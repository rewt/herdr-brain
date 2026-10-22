// Bind imports to physical bytes, independently of a mutable `current` alias.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkBundle, projectPin, selectRelease } from './releases.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function closeoutCodeIdentity(codeRoot = root, { verifyFiles = false } = {}) {
  codeRoot = fs.realpathSync(codeRoot);
  if (fs.existsSync(path.join(codeRoot, '.release-commit'))) {
    const release = checkBundle(codeRoot, { verifyFiles });
    return { kind: 'release', root: codeRoot, commit: release.commit,
      manifest: sha(fs.readFileSync(path.join(codeRoot, '.release-manifest.json'))),
      files: sha(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(codeRoot, '.release-manifest.json'))).files).sort().map(file => {
        const s = fs.lstatSync(path.join(codeRoot, file));
        if (!s.isFile()) throw Error('closer release file is redirected');
        return [file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
      }))) };
  }
  if (git(codeRoot, ['status', '--porcelain', '--untracked-files=no'])) throw Error('closer code checkout is not clean; cleanup pending');
  return { kind: 'checkout', root: codeRoot, commit: git(codeRoot, ['rev-parse', 'HEAD']) };
}

// Evaluated before the consumer and retirement modules. A checkout move during
// loading is detected before claim/selection, never accepted as new imports.
export const loadedCloseoutCode = (() => {
  try { return { identity: closeoutCodeIdentity(root, { verifyFiles: true }) }; }
  catch (error) { return { error: error.message, root }; }
})();

export function closeoutEpoch(project) {
  return { branch: git(project.canonical, ['symbolic-ref', '--short', 'HEAD']), tip: git(project.canonical, ['rev-parse', 'HEAD']) };
}

export function bindCloseoutCode(project, loaded = loadedCloseoutCode) {
  if (loaded.error) throw Error(loaded.error);
  const binding = { code: loaded.identity, epoch: closeoutEpoch(project) };
  const verify = () => {
    let current;
    try { current = { code: closeoutCodeIdentity(binding.code.root), epoch: closeoutEpoch(project) }; }
    catch (error) { current = { error: error.message, epoch: closeoutEpoch(project) }; }
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw Object.assign(Error('closer code identity or main epoch changed; exact requests retained for a fresh drain'),
      { code: 'CLOSEOUT_CODE_CHANGED', binding, current });
  };
  verify();
  return { binding, verify };
}

export function resolveFreshCloseoutCode(project, bound = loadedCloseoutCode.identity) {
  if (!bound) throw Error('closer launch code identity is unavailable; explicit drain required');
  const pin = projectPin(project.canonical);
  // Keep explicit installed pins, using the normal adoption/acceptance rules.
  if (pin?.release || pin?.home_binding) return selectRelease(project.canonical, bound.kind === 'release' ? path.dirname(path.dirname(bound.root)) : undefined).root;
  if (bound.kind === 'release') return bound.root;
  let common;
  try { common = fs.realpathSync(git(bound.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); } catch { /* refused below */ }
  return common === project.identity ? project.canonical : bound.root;
}
