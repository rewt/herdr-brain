// Synchronous, opt-in read sets for record planning. This facade never patches
// node:fs. Outside captureReads it is the ordinary filesystem API. Native/effect
// guards must still run at their own mutation boundary, never from this cache.
import native from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';

const active = new AsyncLocalStorage();
const conflict = message => Object.assign(Error(message), { code: 'RECORD_OBSERVATION_CONFLICT' });
const filePath = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
function signature(file, listing = false) {
  try {
    const link = native.lstatSync(file, { bigint: true }), stat = native.statSync(file, { bigint: true });
    const identity = s => [s.dev, s.ino, s.birthtimeNs, s.mode].map(String);
    // libc resolves the complete path (including ancestor symlinks) in one
    // native call. Do not cache it across reads or validation: a retargeted
    // ancestor must still invalidate the exact same identity/version fence.
    return JSON.stringify([native.realpathSync.native(file), identity(link), identity(stat),
      ...(!stat.isDirectory() || listing ? [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(link.ctimeNs)] : [])]);
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
  const scope = { files: new Map(), fds: new Map(), git: new Set(), recordEffects: false };
  let value;
  try { value = active.run(scope, fn); }
  catch (error) { if (scope.recordEffects) error.recordEffectsObserved = true; throw error; }
  if (value && typeof value.then === 'function') throw Error('record planning must be synchronous');
  const validate = () => {
    for (const row of scope.files.values()) if (signature(row.file, row.listing) !== row.value)
      throw conflict(`record observation conflict: ${row.file} changed; no append was made`);
  };
  try { validate(); }
  catch (error) { if (scope.recordEffects) error.recordEffectsObserved = true; throw error; }
  return { value, validate, recordEffects: scope.recordEffects };
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
export function observeGit(cwd, env = process.env) {
  const scope = active.getStore();
  if (!scope) return;
  const key = JSON.stringify([path.resolve(cwd), Object.entries(env).filter(([k]) => k.startsWith('GIT_'))]);
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
  catch { return; } // The checked caller retains its ordinary non-Git behavior.
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
    for (const file of ['HEAD', 'commondir', 'gitdir', 'config', 'config.worktree', 'index', 'packed-refs', 'shallow', 'info/grafts', 'objects/info/alternates']) observe(path.join(dir, file));
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
