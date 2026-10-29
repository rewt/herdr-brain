// Notice delivery is at-least-once: unlike promotion, a dead sender's lock
// can be recovered automatically. Never remove a live or unidentified owner.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function acquireLock(directory, { waitMs = 0, deadline: hardDeadline } = {}) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const candidate = fs.mkdtempSync(`${directory}.new-`);
  const deadline = Math.min(hardDeadline ?? Infinity, Date.now() + (hardDeadline === undefined ? loadTimeout(waitMs) : waitMs));
  try {
    const fd = fs.openSync(path.join(candidate, 'owner.json'), 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID(), at: new Date().toISOString(), argv: process.argv }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    for (;;) {
      if (hardDeadline !== undefined && Date.now() >= hardDeadline) throw new Error(`locked: ${directory}; decision deadline reached`);
      // Publish the directory WITH its owner metadata. A crash before this
      // rename leaves only a harmless candidate, never an ownerless lock.
      if (!fs.existsSync(directory)) {
        try { fs.renameSync(candidate, directory); break; }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      }
      if (Date.now() >= deadline) throw new Error(`locked: ${directory}; owner is live or unidentified`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
  const owner = readOwner(directory);
  let released = false;
  return () => { if (!released) { removeOwner(directory, owner); released = true; } };
}

function readOwner(directory) {
  try {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) return null;
    const fd = fs.openSync(path.join(directory, 'owner.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) return null;
      const bytes = fs.readFileSync(fd, 'utf8');
      return { owner: JSON.parse(bytes), bytes, identity: [stat.dev, stat.ino, stat.birthtimeNs].join(':') };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
const matches = (a, b) => a && b && a.identity === b.identity && a.bytes === b.bytes;
export function ownerPid(directory) {
  return readOwner(directory)?.owner?.pid ?? null;
}
function removeOwner(directory, owner) {
  if (!matches(readOwner(directory), owner)) return false;
  fs.unlinkSync(path.join(directory, 'owner.json'));
  // A contender that already observed no lock can rename its candidate over
  // this now-empty directory. Never recurse into that new owner's lock.
  try { fs.rmdirSync(directory); }
  catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
  return true;
}
function dead(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
export function noticeLock(directory, { waitMs = 0, deadline, recover = true, onRecovery = () => {} } = {}) {
  // Explicit controls can refuse an occupied lock without probing or recovering
  // its owner. This also respects old retained transport owners.
  if (!recover) return acquireLock(directory, { waitMs, deadline });
  try {
    if (dead(ownerPid(directory))) throw new Error(`locked: ${directory}; dead owner`);
    return acquireLock(directory, { waitMs, deadline });
  }
  catch (error) {
    if (!error.message.startsWith('locked:') || !dead(ownerPid(directory))) throw error;
    // Serialize stale-owner recovery, then re-read: another contender might
    // already have installed a live owner. Recovery guards use the same rule.
    const release = noticeLock(`${directory}.recovery`, { waitMs: 5000, deadline, onRecovery });
    try {
      const prior = readOwner(directory);
      if (dead(prior?.owner?.pid)) {
        const receipt = { directory, owner: prior.owner, lock_identity: prior.identity,
          owner_sha256: createHash('sha256').update(prior.bytes).digest('hex'),
          proof: { method: 'kill(pid, 0)', result: 'ESRCH', checked_at: new Date().toISOString() } };
        // Durable intent must succeed before unlink. Re-read the exact owner
        // and repeat the death probe after any caller-supplied receipt I/O.
        onRecovery({ ...receipt, phase: 'intent' });
        if (!matches(readOwner(directory), prior) || !dead(prior.owner.pid) || !removeOwner(directory, prior))
          throw Error(`locked: ${directory}; recovery owner changed`);
        onRecovery({ ...receipt, phase: 'recovered' });
      }
      return acquireLock(directory, { waitMs, deadline });
    } finally { release(); }
  }
}
