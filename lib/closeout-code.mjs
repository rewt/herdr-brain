// Bind imports to physical bytes, independently of a mutable `current` alias.
import fs, { observeGit } from './record-observation.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkBundle, projectPin, selectRelease } from './releases.mjs';
import { captureProductCheckout, releaseMetadata } from './product-files.mjs';
import { gitProject } from './project.mjs';
import { findOrgDir } from './store.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const git = (cwd, args) => {observeGit(cwd);return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function closerGraph(codeRoot, files) {
  const pending = ['supervisor/closeout.mjs'], found = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (found.has(file)) continue;
    if (!files[file]) throw Error(`closer graph is not committed: ${file}`);
    found.add(file);
    if (!file.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(codeRoot, file), 'utf8');
    // Literal static/dynamic imports and URL-loaded runtime assets. The whole
    // checkout is still verified above; only unrelated bytes leave this epoch.
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (target.startsWith('../') || target === '..') throw Error('closer graph leaves its source');
      if (files[target]) pending.push(target);
      else if (/\.(mjs|json|sh)$/.test(target)) throw Error(`closer runtime dependency missing: ${target}`);
    }
  }
  return [...found].sort().map(file => [file, files[file]]);
}

export function closeoutCodeIdentity(codeRoot = root, { verifyFiles = false } = {}) {
  codeRoot = fs.realpathSync(codeRoot);
  if (releaseMetadata.some(file => fs.lstatSync(path.join(codeRoot, file), { throwIfNoEntry: false }))) {
    const release = checkBundle(codeRoot, { verifyFiles });
    return { kind: 'release', root: codeRoot, commit: release.commit,
      manifest: sha(fs.readFileSync(path.join(codeRoot, '.release-manifest.json'))),
      files: sha(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(codeRoot, '.release-manifest.json'))).files).sort().map(file => {
        const s = fs.lstatSync(path.join(codeRoot, file));
        if (!s.isFile()) throw Error('closer release file is redirected');
        return [file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
      }))) };
  }
  const { root, common, commit, tree, files } = captureProductCheckout(codeRoot);
  return { kind: 'checkout', root, common, commit, tree, graph: 'closer-imports/v1', files: sha(JSON.stringify(closerGraph(root, files))) };
}

// The consumer bootstrap dynamically loads its graph after this capture.
export const loadedCloseoutCode = (() => {
  try { return { identity: closeoutCodeIdentity(root, { verifyFiles: true }) }; }
  catch (error) { return { error: error.message, root }; }
})();

export function closeoutEpoch(project) {
  return { branch: git(project.canonical, ['symbolic-ref', '--short', 'HEAD']), tip: git(project.canonical, ['rev-parse', 'HEAD']) };
}

export function captureCloseoutLaunch(project, loaded = loadedCloseoutCode) {
  return { ...loaded, epoch: closeoutEpoch(project) };
}

export function bindCloseoutCode(project, loaded = loadedCloseoutCode) {
  if (loaded.error) throw Error(loaded.error);
  const binding = { code: loaded.identity, epoch: loaded.epoch ?? closeoutEpoch(project) };
  const verify = () => {
    let current;
    try { current = { code: closeoutCodeIdentity(binding.code.root), epoch: closeoutEpoch(project) }; }
    catch (error) { current = { error: error.message, epoch: closeoutEpoch(project) }; }
    const stable = value => value.code?.kind === 'checkout' && value.code.graph === 'closer-imports/v1'
      ? { code: { kind: value.code.kind, root: value.code.root, common: value.code.common, graph: value.code.graph, files: value.code.files }, branch: value.epoch.branch }
      : value;
    if (JSON.stringify(stable(current)) !== JSON.stringify(stable(binding))) throw Object.assign(Error('closer code identity or main branch changed; exact requests retained for a fresh drain'),
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

// This is an observation, never a lock acquisition or recovery. In particular,
// a stored PID, a past deadline, an evaluation or an old worker log cannot prove
// the original consumer's outcome or release. Do not call the process source.
function storedClaim(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return { state: 'absent', liveness: 'UNKNOWN' };
  if (!stat.isDirectory()) throw Error('closeout claim directory is redirected; keep original owner');
  const file = path.join(directory, 'owner.json'), selected = fs.lstatSync(file);
  if (!selected.isFile()) throw Error('closeout owner is redirected or not a regular file; keep');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino) throw Error('closeout owner changed before observation; keep');
    const bytes = fs.readFileSync(fd), after = fs.lstatSync(file), parent = fs.lstatSync(directory);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        stat.dev !== parent.dev || stat.ino !== parent.ino) throw Error('closeout owner changed during observation; keep');
    return { state: 'stored', owner: JSON.parse(bytes), liveness: 'UNKNOWN',
      receipt: { dev: before.dev, ino: before.ino, sha256: sha(bytes) } };
  } finally { fs.closeSync(fd); }
}

export function readCloseoutOwnerStatus({ cwd = process.cwd(), org, env = process.env } = {}) {
  const project = gitProject(cwd), { ORG_DIR, ...discoveryEnv } = env;
  const record = findOrgDir({ cwd: project.canonical, env: discoveryEnv });
  if (!record || !org || fs.realpathSync(record) !== fs.realpathSync(org)) throw Error('closeout record/project binding differs; no owner observation');
  const directory = path.join(project.identity, 'closeout');
  const inspect = () => {
    const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (parent && !parent.isDirectory()) throw Error('closeout directory is redirected; keep original owner');
    const retirement = fs.lstatSync(path.join(project.identity, 'retirement'), { throwIfNoEntry: false });
    if (retirement && !retirement.isDirectory()) throw Error('retirement directory is redirected; keep original owner');
    return { consumer: storedClaim(path.join(directory, 'consumer.lock')), queue: storedClaim(path.join(directory, 'queue.lock')),
      retirement: storedClaim(path.join(project.identity, 'retirement/owner.lock')) };
  };
  const claims = inspect();
  let successor;
  try { successor = { root: resolveFreshCloseoutCode(project), capabilities: null, reason: 'fresh selection only; its implementation has not executed' }; }
  catch (error) { successor = { root: null, capabilities: null, reason: error.message }; }
  if (JSON.stringify(claims) !== JSON.stringify(inspect())) throw Error('closeout claims changed during observation; repeat only after changed input');
  return { schema: 'closeout-owner-status/v1', observed_at: new Date().toISOString(), project: project.canonical, identity: project.identity, org: fs.realpathSync(org),
    source: { identity: loadedCloseoutCode.identity ?? null, error: loadedCloseoutCode.error ?? null,
      capabilities: { named_sessions: true, zero_elapsed_budget: true, owner_status_read_only: true } },
    successor, claims, original_outcome: 'UNKNOWN', original_release: 'UNKNOWN', effects: 0,
    required_evidence: ['original command terminal/outcome bound to the stored owner and exact named keys', 'original consumer, queue and retirement claim release; a later owner must stay intact'],
    authority: 'observation only; no successor, retry, recovery or native effect authorized' };
}
