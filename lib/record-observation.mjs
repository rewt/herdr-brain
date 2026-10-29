// Synchronous, opt-in read sets for record planning. This facade never patches
// node:fs. Outside captureReads it is the ordinary filesystem API. Native/effect
// guards must still run at their own mutation boundary, never from this cache.
import native from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';

const active = new AsyncLocalStorage();
// Provenance matters: a native refusal with a conflict-shaped code is still a
// refusal. Only our pre-effect source fences grant permission to prepare again.
const sourceConflicts = new WeakSet();
export function recordSourceConflict(message, code = 'RECORD_OBSERVATION_CONFLICT', ErrorType = Error) {
  const error = Object.assign(new ErrorType(message), { code });
  sourceConflicts.add(error);
  return error;
}
export const isRecordSourceConflict = error => sourceConflicts.has(error);
const conflict = recordSourceConflict;
const filePath = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
function signature(file, listing = false) {
  try {
    const link = native.lstatSync(file, { bigint: true }), stat = native.statSync(file, { bigint: true });
    const identity = s => [s.dev, s.ino, s.birthtimeNs, s.mode, s.rdev].map(String);
    // libc resolves the complete path (including ancestor symlinks) in one
    // native call. Do not cache it across reads or validation: a retargeted
    // ancestor must still invalidate the exact same identity/version fence.
    const resolved = native.realpathSync.native(file);
    // Git legitimately uses the null device as an empty configuration source.
    // Writes (including stderr) change its timestamps without changing what a
    // read can return. Keep path, device/link identity and mode exact; regular
    // files and every other device retain their full version fence.
    const nullDevice = resolved === '/dev/null' && stat.isCharacterDevice();
    return JSON.stringify([resolved, identity(link), identity(stat),
      ...((!stat.isDirectory() && !nullDevice) || listing ? [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(link.ctimeNs)] : []),
      ...(nullDevice && link.isSymbolicLink() ? [String(link.ctimeNs)] : [])]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return error.code;
    throw error;
  }
}
function observe(file, listing = false) {
  const scope = active.getStore();
  if (!scope || typeof filePath(file) !== 'string') return;
  const absolute = path.resolve(filePath(file)), key = `${listing}:${absolute}`, value = signature(absolute, listing);
  if (scope.files.has(key) && scope.files.get(key).value !== value) throw conflict(`record observation changed while planning: ${absolute}`);
  scope.files.set(key, { file: absolute, listing, value });
}
const reads = new Set(['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'existsSync', 'readdirSync', 'accessSync']);
const wrappers = new Map();
export default new Proxy(native, { get(target, key) {
  if (key === 'openSync') return open;
  if (key === 'closeSync') return close;
  if (!reads.has(key)) return target[key];
  if (!wrappers.has(key)) wrappers.set(key, (...args) => {
    const scope = active.getStore(), file = typeof args[0] === 'number' ? scope?.fds.get(args[0]) : args[0];
    observe(file, key === 'readdirSync');
    try { return target[key](...args); }
    finally { observe(file, key === 'readdirSync'); }
  });
  return wrappers.get(key);
} });
function open(file, ...args) {
  const scope = active.getStore();
  if (!scope) return native.openSync(file, ...args);
  observe(file);
  const fd = native.openSync(file, ...args);
  scope.fds.set(fd, path.resolve(filePath(file)));
  observe(file);
  return fd;
}
function close(fd) {
  const scope = active.getStore(), file = scope?.fds.get(fd);
  try { return native.closeSync(fd); }
  finally { if (file) { observe(file); scope.fds.delete(fd); } }
}
export function captureReads(fn) {
  const scope = readScope();
  let value;
  try { value = active.run(scope, fn); }
  catch (error) { if (scope.recordEffects) error.recordEffectsObserved = true; throw error; }
  if (value && typeof value.then === 'function') throw Error('record planning must be synchronous');
  const validate = () => {
    validateFiles(scope.files);
    for (const row of scope.queries.values()) validateQuery(row);
  };
  try { validate(); }
  catch (error) { if (scope.recordEffects) error.recordEffectsObserved = true; throw error; }
  // Semantic rechecks and their input discovery happen before the record lock.
  // Only this short-lived physical fence crosses lock acquisition. Unrelated
  // Git/config changes during planning can still pass the semantic comparison.
  const seal = () => {
    const sealed = readScope(true);
    try {
      validateFiles(scope.files);
      active.run(sealed, () => {
        for (const row of scope.queries.values()) validateQuery(row, true);
      });
      validateFiles(sealed.files, 'record Git observation conflict');
      validateFiles(scope.files);
    } catch (error) { if (scope.recordEffects) error.recordEffectsObserved = true; throw error; }
    return () => {
      validateFiles(scope.files);
      validateFiles(sealed.files, 'record Git observation conflict');
    };
  };
  return { value, validate, seal, recordEffects: scope.recordEffects };
}
const readScope = (sealing = false) => ({ files: new Map(), fds: new Map(), git: new Set(), queries: new Map(), recordEffects: false, sealing });
function validateFiles(files, label = 'record observation conflict') {
  for (const row of files.values()) if (signature(row.file, row.listing) !== row.value)
    throw conflict(`${label}: ${row.file} changed; no append was made`);
}
function queryRead(key, read) {
  try { return read(); }
  catch (cause) {
    if (isRecordSourceConflict(cause)) throw cause;
    const error = conflict(`record Git observation conflict: ${key} could not be revalidated; no append was made: ${cause.message}`, 'RECORD_PLANNING_CONFLICT');
    error.cause = cause;
    throw error;
  }
}
function validateQuery(row, sealing = false) {
  const value = queryRead(row.key, () => {
    if (sealing) row.inputs?.();
    return (sealing ? row.sealRead : row.read)();
  });
  if (value !== row.value) throw conflict(`record Git observation conflict: ${row.key} changed; no append was made`);
}
// Git query keys encode cwd/argv and optionally the selected GIT_* environment.
// Seal refs, registrations and config only for the recheck-to-commit interval;
// none of these identity/ref queries reads a worktree index.
function queryInputs(key) {
  const [cwd, args, environment] = JSON.parse(key);
  if (typeof cwd !== 'string' || !Array.isArray(args)) throw Error('invalid Git observation key');
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const env = environment ? { ...base, ...Object.fromEntries(environment) } : process.env;
  observeGit(cwd, env, { index: false, required: true });
  // Code-identity queries deliberately clear inherited selectors. Cover that
  // physical repository too when a key does not specify its environment.
  if (!environment && Object.keys(process.env).some(name => name.startsWith('GIT_')))
    observeGit(cwd, base, { index: false, required: true });
}
// Fence the semantic result of an identity/ref query, rather than every Git
// index/config/ref timestamp throughout planning. The real command is repeated
// outside the append lock; seal() supplies the stat-only commit fence.
export function observeGitQuery(key,read) {
  const scope=active.getStore();
  if (scope?.sealing) queryInputs(key);
  const value=scope ? queryRead(key,read) : read();
  if(!scope)return value;
  const prior=scope.queries.get(key);
  if(prior&&prior.value!==value)throw conflict(`record Git observation changed while planning: ${key}`);
  scope.queries.set(key,{key,value,read,sealRead:read,inputs:()=>queryInputs(key)});
  return value;
}
// Pure projections explicitly own their semantic inputs. Used for discovery
// cache/absence probes whose raw timestamps are not allocation authority.
export function observeReadProjection(key,read) {
  const scope=active.getStore(), isolated=()=>active.run(undefined,read);
  const value=scope?.sealing ? queryRead(key,read) : isolated();
  if (!scope) return value;
  const prior=scope.queries.get(key);
  if (prior && prior.value!==value) throw conflict(`record Git observation changed while planning: ${key}`);
  scope.queries.set(key,{key,value,read:isolated,sealRead:read});
  return value;
}
// Configuration reads can publish an audit. Even an explicitly pure planner
// loses replay permission if such a nested record transaction was attempted.
export function noteRecordEffect() { const scope = active.getStore(); if (scope) scope.recordEffects = true; }
export function runRecordEffect(fn) {
  noteRecordEffect();
  // A nested effect must finish using its own guards. Do not mistake its writes
  // for read-set changes halfway through a durable append or native callback.
  return active.run(undefined, fn);
}

// Git's subprocess reads are not visible to the facade. Fence its mutable
// inputs before executing a query. Objects are addressed by immutable hashes;
// refs, packed refs, configuration, indexes and worktree registrations are not.
// Directory listings fence newly created refs/registrations as well as removals.
export function observeGit(cwd, env = process.env, { index = true, required = false } = {}) {
  const scope = active.getStore();
  if (!scope) return;
  // Identity-only queries do not read the index. Keep that cohort distinct so
  // a later status/source query still upgrades to the complete index fence.
  const key = JSON.stringify([path.resolve(cwd), Object.entries(env).filter(([k]) => k.startsWith('GIT_')), index]);
  if (scope.git.has(key)) return;
  scope.git.add(key);
  for (let dir = path.resolve(cwd);;) {
    observe(path.join(dir, '.git'));
    if (path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  const git = args => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let directories;
  try { directories = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).split('\n'); }
  catch (error) { if (required) throw error; return; } // Ordinary callers retain their non-Git behavior.
  const tree = directory => {
    observe(directory, true);
    if (!native.existsSync(directory)) return;
    for (const entry of native.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) tree(file); else observe(file);
    }
  };
  for (const dir of new Set(directories)) {
    observe(dir);
    for (const file of ['HEAD', 'commondir', 'gitdir', 'config', 'config.worktree', ...(index ? ['index'] : []), 'packed-refs', 'shallow', 'info/grafts', 'objects/info/alternates']) observe(path.join(dir, file));
    tree(path.join(dir, 'refs'));
    tree(path.join(dir, 'reftable'));
    const worktrees = path.join(dir, 'worktrees');
    observe(worktrees, true);
    if (native.existsSync(worktrees)) for (const entry of native.readdirSync(worktrees)) {
      const target = path.join(worktrees, entry);
      observe(target);
      for (const file of ['HEAD', 'commondir', 'gitdir', 'config.worktree']) observe(path.join(target, file));
    }
  }
  for (const file of [env.GIT_CONFIG_SYSTEM || '/etc/gitconfig', env.GIT_CONFIG_GLOBAL || path.join(env.HOME || '', '.gitconfig'), path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config'), 'git/config')]) observe(file);
  // Includes may live outside the checkout. Track every actual config origin.
  for (const line of git(['config', '--show-origin', '--list']).split('\n')) {
    if (line.startsWith('file:')) observe(line.slice(5, line.indexOf('\t')));
  }
}
