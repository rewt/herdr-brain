// Retirement is repeatable after fresh observation, so a proven dead owner may
// be recovered. A live or unreadable owner never grants recovery authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerAlive, ownerIdentity, readOwnerProcess } from './process-owner.mjs';
import { loadTimeout } from './deadline.mjs';

const read = directory => {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); }
  catch { return null; }
};
const matches = (a, b) => a && b && a.pid === b.pid && a.identity === b.identity && a.token === b.token;
function remove(directory, owner) {
  if (!matches(read(directory), owner)) return;
  fs.unlinkSync(path.join(directory, 'owner.json'));
  // A contender may publish into the empty directory. Do not recurse into a
  // newly published owner's lock when releasing or reclaiming the old one.
  try { fs.rmdirSync(directory); }
  catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; }
}

export const RETIREMENT_DEADLINE_MESSAGE = 'retirement deadline reached; request remains pending';

export function retirementDeadline() {
  return Object.assign(Error(RETIREMENT_DEADLINE_MESSAGE), { code: 'RETIREMENT_DEADLINE' });
}

export function retirementLock(directory, { waitMs = 0, deadline = Infinity, readProcess = readOwnerProcess } = {}) {
  const checkDeadline = () => { if (Date.now() >= deadline) throw retirementDeadline(); };
  checkDeadline();
  const owner = { pid: process.pid, identity: ownerIdentity(process.pid, readProcess), token: randomUUID(),
    at: new Date().toISOString(), argv: process.argv };
  checkDeadline();
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const candidate = fs.mkdtempSync(`${directory}.new-`);
  const until = Math.min(deadline, Date.now() + loadTimeout(waitMs));
  try {
    const fd = fs.openSync(path.join(candidate, 'owner.json'), 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    for (;;) {
      checkDeadline();
      if (!fs.existsSync(directory)) {
        try { fs.renameSync(candidate, directory); return () => remove(directory, owner); }
        catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
      }
      const prior = read(directory);
      let gone = false;
      try { gone = prior && !ownerAlive(prior, readProcess); } catch { /* unknown owners retain their lock */ }
      if (gone) {
        // Serialize recovery and repeat the birth check before removal. Recovery
        // locks have the same dead-owner rule, so their own crash is recoverable.
        const release = retirementLock(`${directory}.recovery`, { waitMs, deadline, readProcess });
        try {
          const current = read(directory);
          if (current && !ownerAlive(current, readProcess)) remove(directory, current);
        } finally { release(); }
        continue;
      }
      if (Date.now() >= until) throw Error(`locked: ${directory}; owner is live or unknown`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, until - Date.now()));
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}
