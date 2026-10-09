// The recovery receipt is durable before the first machine file changes.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function state(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`refusing non-plain machine file: ${file}`);
    return { content: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writable(file) {
  if (state(file)) fs.accessSync(file, fs.constants.W_OK);
  let directory = path.dirname(file);
  while (!fs.existsSync(directory)) directory = path.dirname(directory);
  fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
}
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(file, value, exclusive = false, stagedFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = stagedFile ?? `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, value.mode);
  try {
    try { fs.writeFileSync(fd, value.content); fs.fchmodSync(fd, value.mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
export const same = (a, b) => (!a || !b) ? a === b : a.mode === b.mode && a.content.equals(b.content);
export function bytes(value) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('invalid encoded machine bytes');
  return Buffer.from(value, 'base64');
}
const encode = (value) => value && { content: value.content.toString('base64'), mode: value.mode };
const decode = (value) => value && { content: bytes(value.content), mode: value.mode };
function save(journal, plan, exclusive = false) {
  const stored = { ...plan, changes: plan.changes.map((change) => ({ ...change, before: encode(change.before), after: encode(change.after) })) };
  write(journal, { content: Buffer.from(JSON.stringify(stored) + '\n'), mode: 0o600 }, exclusive);
}
function apply(file, value, temporary) {
  writable(file);
  if (value) write(file, value, false, temporary);
  else if (state(file)) { fs.unlinkSync(file); syncDirectory(path.dirname(file)); }
}
export function recover(journal, bin, runtimeRoot) {
  const receipt = state(journal);
  if (!receipt) return;
  const plan = JSON.parse(receipt.content.toString('utf8'));
  // Every managed wrapper can appear in a journal, even before its write starts.
  const names = ['codex', 'claude', 'monitor-codex', 'monitor-claude', 'monitor', 'herdr-read', '.monitor-entry.json', '.monitor-shell.json', '.monitor-native-hooks.json'];
  const shells = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
  const valid = (value) => value === null || (typeof value?.content === 'string' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777);
  if (plan.version !== 2 || typeof plan.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(plan.token) || plan.bin !== bin || !Number.isInteger(plan.pid) || plan.pid < 1 || !Array.isArray(plan.changes) || plan.changes.some((change) =>
    !path.isAbsolute(change.file) || !(path.dirname(change.file) === bin ? names.includes(path.basename(change.file)) : [...shells, 'hooks.json', 'settings.json'].includes(path.basename(change.file))) ||
    !valid(change.before) || !valid(change.after) || typeof change.started !== 'boolean' ||
    (change.temporary !== null && (typeof change.temporary !== 'string' || !change.temporary.startsWith(`${change.file}.`) || !/^[a-f0-9-]{36}\.tmp$/u.test(change.temporary.slice(change.file.length + 1))))) ||
    (plan.runtime && (path.dirname(plan.runtime.directory) !== runtimeRoot || !/^[a-f0-9]{64}$/u.test(path.basename(plan.runtime.directory)) ||
      plan.runtime.token !== plan.token || plan.runtime.temporary !== path.join(runtimeRoot, `.runtime-${plan.token}.tmp`)))) throw new Error('invalid or older entry recovery receipt; retain it for its original installer');
  for (const change of plan.changes) { change.before = decode(change.before); change.after = decode(change.after); }
  if (plan.directories !== undefined && (!Array.isArray(plan.directories) || plan.directories.some(directory =>
    !path.isAbsolute(directory) || !plan.changes.some(change => change.file.startsWith(`${directory}${path.sep}`))))) throw new Error('invalid entry recovery directories');
  if (plan.pid !== process.pid) {
    try { process.kill(plan.pid, 0); throw new Error(`entry installation still running as pid ${plan.pid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const change of [...plan.changes].reverse()) {
    if (!change.started) continue;
    // A terminated process can leave a synced replacement before its rename.
    // Its exclusive temporary path is part of the same recovery receipt.
    if (change.temporary && state(change.temporary)) { fs.unlinkSync(change.temporary); syncDirectory(path.dirname(change.temporary)); }
    const current = state(change.file);
    if (same(current, change.before)) continue;
    if (!same(current, change.after)) {
      // A chmod on untouched before-bytes belongs to the caller. Check the
      // exact after-state first: a mode-only replacement has those bytes too.
      if (current && change.before && current.content.equals(change.before.content)) continue;
      throw new Error(`recovery file changed: ${change.file}; retain ${journal}`);
    }
    apply(change.file, change.before, change.temporary);
  }
  if (plan.runtime) {
    for (const directory of [plan.runtime.temporary, plan.runtime.directory]) {
      if (!fs.existsSync(directory)) continue;
      if (!fs.lstatSync(directory).isDirectory()) throw new Error(`runtime recovery path changed: ${directory}`);
      const owner = state(path.join(directory, '.monitor-runtime-owner.json'));
      if (owner && JSON.parse(owner.content.toString('utf8')).token === plan.token) fs.rmSync(directory, { recursive: true });
      else if (directory === plan.runtime.temporary && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      else if (directory === plan.runtime.directory) continue; // Another transaction's runtime is never ours to remove.
      else throw new Error(`runtime is not owned by this recovery: ${directory}; retain ${journal}`);
      syncDirectory(runtimeRoot);
    }
  }
  for (const directory of [...(plan.directories ?? [])].sort((a,b) => b.length-a.length)) {
    try { fs.rmdirSync(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
  fs.unlinkSync(journal); syncDirectory(path.dirname(journal));
}
export function transact(journal, bin, runtimeRoot, changes, runtime, owner) {
  changes = changes.map((change) => ({ ...change, started: false, temporary: `${change.file}.${randomUUID()}.tmp` }));
  // Reject the complete stale plan before publishing a journal or mutating any
  // runtime/file. Matching after-bytes alone never establish write ownership.
  for (const change of changes) {
    if (!same(state(change.file), change.before)) throw new Error(`machine file changed during planning: ${change.file}`);
    writable(change.file);
  }
  runtime?.validate();
  writable(journal);
  // A fully written, synced file is linked exclusively into place, so another
  // installer cannot overwrite a live transaction's recovery receipt.
  const directories = new Set();
  for (const change of changes) {
    let directory = path.dirname(change.file);
    while (!fs.existsSync(directory)) { directories.add(directory); directory = path.dirname(directory); }
  }
  const plan = { version: 2, bin, pid: process.pid, token: owner.token, changes, directories: [...directories],
    runtime: runtime?.created ? { directory: runtime.directory, temporary: runtime.temporary, token: owner.token } : null };
  save(journal, plan, true);
  try {
    runtime?.prepare();
    for (const change of changes) {
      if (!same(state(change.file), change.before)) throw new Error(`machine file changed during installation: ${change.file}`);
      change.started = true; save(journal, plan);
      apply(change.file, change.after, change.temporary);
    }
    fs.unlinkSync(journal); syncDirectory(path.dirname(journal));
  } catch (error) {
    try { recover(journal, bin, runtimeRoot); }
    catch (recovery) { throw new Error(`${error.message}; ${recovery.message}`); }
    throw error;
  }
}
