// A nonempty directory is published atomically. Stale reclaimers unlink only
// the dead owner's unique file; rmdir can never remove a new nonempty lock.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function emptyDirectory(directory) {
  try { fs.rmdirSync(directory); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}
function reclaim(directory) {
  let entries;
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`entry lock is not a directory: ${directory}`);
    entries = fs.readdirSync(directory);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) { emptyDirectory(directory); return; }
  if (entries.length !== 1 || !/^[1-9][0-9]*-[a-f0-9-]{36}\.json$/u.test(entries[0])) throw new Error(`invalid entry lock: ${directory}`);
  const file = path.join(directory, entries[0]);
  let owner;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`invalid entry lock owner: ${file}`);
    owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Number.isInteger(owner.pid) || owner.pid < 1 || `${owner.pid}-${owner.token}.json` !== entries[0]) throw new Error(`invalid entry lock owner: ${file}`);
  if (alive(owner.pid)) return;
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  emptyDirectory(directory);
}
export function withInstallationLock(directory, action) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const owner = { pid: process.pid, token: randomUUID() };
  const name = `${owner.pid}-${owner.token}.json`;
  const candidate = `${directory}.${owner.token}.tmp`;
  fs.mkdirSync(candidate, { mode: 0o700 });
  let held = false;
  try {
    fs.writeFileSync(path.join(candidate, name), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + 30000;
    while (!held) {
      try { fs.renameSync(candidate, directory); held = true; }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        reclaim(directory);
        if (Date.now() >= deadline) throw new Error(`timed out waiting for entry installation lock: ${directory}`);
        pause(25);
      }
    }
    return action(owner);
  } finally {
    if (held) {
      try { fs.unlinkSync(path.join(directory, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      emptyDirectory(directory);
    } else fs.rmSync(candidate, { recursive: true, force: true });
  }
}
