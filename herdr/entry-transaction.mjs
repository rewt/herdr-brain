// The recovery receipt is durable before the first machine file changes.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function state(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`refusing non-plain machine file: ${file}`);
    return { content: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 };
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
export const same = (a, b) => a?.content === b?.content && a?.mode === b?.mode;
function apply(file, value, temporary) {
  writable(file);
  if (value) write(file, value, false, temporary);
  else if (state(file)) { fs.unlinkSync(file); syncDirectory(path.dirname(file)); }
}
export function recover(journal, bin, runtimeRoot) {
  const receipt = state(journal);
  if (!receipt) return;
  const plan = JSON.parse(receipt.content);
  const names = ['codex', 'claude', 'monitor-codex', 'monitor-claude', '.monitor-entry.json', '.monitor-shell.json'];
  const shells = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
  const valid = (value) => value === null || (typeof value?.content === 'string' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777);
  if (plan.bin !== bin || !Number.isInteger(plan.pid) || plan.pid < 1 || !Array.isArray(plan.changes) || plan.changes.some((change) =>
    !path.isAbsolute(change.file) || !(path.dirname(change.file) === bin ? names.includes(path.basename(change.file)) : shells.includes(path.basename(change.file))) ||
    !valid(change.before) || !valid(change.after) ||
    (change.temporary !== null && (typeof change.temporary !== 'string' || !change.temporary.startsWith(`${change.file}.`) || !/^[a-f0-9-]{36}\.tmp$/u.test(change.temporary.slice(change.file.length + 1))))) ||
    (plan.runtime && (path.dirname(plan.runtime) !== runtimeRoot || !/^[a-f0-9]{64}$/u.test(path.basename(plan.runtime))))) throw new Error('invalid entry recovery receipt');
  if (plan.pid !== process.pid) {
    try { process.kill(plan.pid, 0); throw new Error(`entry installation still running as pid ${plan.pid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const change of [...plan.changes].reverse()) {
    // A terminated process can leave a synced replacement before its rename.
    // Its exclusive temporary path is part of the same recovery receipt.
    if (change.temporary && state(change.temporary)) { fs.unlinkSync(change.temporary); syncDirectory(path.dirname(change.temporary)); }
    const current = state(change.file);
    // A chmod on an untouched file belongs to the caller, not this transaction.
    if (same(current, change.before) || (current && change.before && current.content === change.before.content)) continue;
    if (!same(current, change.after)) throw new Error(`recovery file changed: ${change.file}; retain ${journal}`);
    apply(change.file, change.before, change.temporary);
  }
  if (plan.runtime) fs.rmSync(plan.runtime, { recursive: true, force: true });
  fs.unlinkSync(journal); syncDirectory(path.dirname(journal));
}
export function transact(journal, bin, runtimeRoot, changes, runtime) {
  changes = changes.map((change) => ({ ...change, temporary: `${change.file}.${randomUUID()}.tmp` }));
  for (const change of changes) writable(change.file);
  writable(journal);
  // A fully written, synced file is linked exclusively into place, so another
  // installer cannot overwrite a live transaction's recovery receipt.
  write(journal, { content: JSON.stringify({ bin, pid: process.pid, changes, runtime: runtime?.created ? runtime.directory : null }) + '\n', mode: 0o600 }, true);
  try {
    runtime?.prepare();
    for (const change of changes) {
      if (!same(state(change.file), change.before)) throw new Error(`machine file changed during installation: ${change.file}`);
      apply(change.file, change.after, change.temporary);
    }
    fs.unlinkSync(journal); syncDirectory(path.dirname(journal));
  } catch (error) {
    try { recover(journal, bin, runtimeRoot); }
    catch (recovery) { throw new Error(`${error.message}; ${recovery.message}`); }
    throw error;
  }
}
