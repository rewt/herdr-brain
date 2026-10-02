// Notice delivery is at-least-once: unlike promotion, a dead sender's lock
// can be recovered automatically. Never remove a live or unidentified owner.
import fs from 'node:fs';
import path from 'node:path';

function acquireLock(directory, { waitMs = 0 } = {}) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const candidate = fs.mkdtempSync(`${directory}.new-`);
  const deadline = Date.now() + waitMs;
  try {
    const fd = fs.openSync(path.join(candidate, 'owner.json'), 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: process.argv }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    for (;;) {
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
  let released = false;
  return () => { if (!released) { fs.rmSync(directory, { recursive: true }); released = true; } };
}

export function ownerPid(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')).pid; }
  catch { return null; }
}
function dead(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
export function noticeLock(directory, { waitMs = 0 } = {}) {
  try {
    if (dead(ownerPid(directory))) throw new Error(`locked: ${directory}; dead owner`);
    return acquireLock(directory, { waitMs });
  }
  catch (error) {
    if (!error.message.startsWith('locked:') || !dead(ownerPid(directory))) throw error;
    // Serialize stale-owner recovery, then re-read: another contender might
    // already have installed a live owner. Recovery guards use the same rule.
    const release = noticeLock(`${directory}.recovery`, { waitMs: 5000 });
    try {
      if (dead(ownerPid(directory))) fs.rmSync(directory, { recursive: true });
      return acquireLock(directory, { waitMs });
    } finally { release(); }
  }
}
