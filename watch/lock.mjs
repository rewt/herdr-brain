import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ownerAlive, ownerIdentity, readOwnerProcess } from '../lib/process-owner.mjs';

// Publish a complete, nonempty guard directory. Recovery unlinks only the
// observed owner's unique filename; a delayed recovery cannot erase a new guard.
function reclamationGuard(directory, owner, readProcess, run) {
  const token = randomUUID(), name = `${token}.json`;
  const candidate = fs.mkdtempSync(`${directory}.new-`);
  const removeEmpty = () => {
    try { fs.rmdirSync(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
  try {
    fs.writeFileSync(path.join(candidate, name), JSON.stringify({ ...owner, token }), { flag: 'wx' });
    for (;;) {
      try {
        fs.renameSync(candidate, directory);
        return () => {
          try { fs.unlinkSync(path.join(directory, name)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          removeEmpty();
        };
      } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      try {
        if (!fs.lstatSync(directory).isDirectory()) throw Error(`invalid watcher reclamation guard for ${run}; inspect`);
        const entries = fs.readdirSync(directory);
        if (!entries.length) { removeEmpty(); continue; }
        if (entries.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(entries[0]))
          throw Error(`invalid watcher reclamation guard for ${run}; inspect`);
        const file = path.join(directory, entries[0]);
        if (!fs.lstatSync(file).isFile()) throw Error(`invalid watcher reclamation owner for ${run}; inspect`);
        const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (`${prior.token}.json` !== entries[0]) throw Error(`invalid watcher reclamation owner for ${run}; inspect`);
        if (ownerAlive(prior, readProcess)) throw Error(`another watcher is reclaiming ${run}`);
        fs.unlinkSync(file);
        removeEmpty();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
}

export function acquireWatcherLock({ org, run, directory = path.join(fs.realpathSync(org), 'watch/locks'), pid = process.pid, readProcess = readOwnerProcess }) {
  fs.mkdirSync(directory, { recursive: true });
  const digest = createHash('sha256').update(`${fs.realpathSync(org)}\0${run}`).digest('hex').slice(0, 16);
  const lock = path.join(directory, `herdr-watch-${digest}.lock`);
  const owner = JSON.stringify({ pid, identity: ownerIdentity(pid, readProcess) });
  let prior;
  try { prior = fs.readFileSync(lock, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${lock}.${randomUUID()}.tmp`;
  let releaseGuard;
  try {
    if (prior !== undefined) {
      const previous = /^\d+$/.test(prior) ? { pid: Number(prior) } : JSON.parse(prior);
      if (ownerAlive(previous, readProcess)) throw new Error(`another watcher (pid ${previous.pid}) already owns ${run}`);
      releaseGuard = reclamationGuard(`${lock}.reclaim`, JSON.parse(owner), readProcess, run);
      // The guard covers the comparison, deletion AND replacement publication.
      if (fs.readFileSync(lock, 'utf8') !== prior) throw new Error(`watcher lock changed for ${run}; inspect`);
      fs.unlinkSync(lock);
    }
    // Publish only complete JSON. A hard link is atomic and never replaces an
    // existing owner, unlike rename; the staging file shares the lock's device.
    fs.writeFileSync(temp, owner, { flag: 'wx' });
    fs.linkSync(temp, lock);
  }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`another watcher already owns ${run}`);
    throw error;
  }
  finally {
    try { fs.rmSync(temp, { force: true }); }
    finally { releaseGuard?.(); }
  }
  return () => {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); }
    catch { /* Already released. */ }
  };
}
