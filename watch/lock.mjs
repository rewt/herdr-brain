import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ownerAlive, ownerIdentity, readOwnerProcess } from '../lib/process-owner.mjs';

export function acquireWatcherLock({ org, run, directory = path.join(fs.realpathSync(org), 'watch/locks'), pid = process.pid, readProcess = readOwnerProcess }) {
  fs.mkdirSync(directory, { recursive: true });
  const digest = createHash('sha256').update(`${fs.realpathSync(org)}\0${run}`).digest('hex').slice(0, 16);
  const lock = path.join(directory, `herdr-watch-${digest}.lock`);
  const owner = JSON.stringify({ pid, identity: ownerIdentity(pid, readProcess) });
  let prior;
  try { prior = fs.readFileSync(lock, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior !== undefined) {
    const owner = /^\d+$/.test(prior) ? { pid: Number(prior) } : JSON.parse(prior);
    if (ownerAlive(owner, readProcess)) throw new Error(`another watcher (pid ${owner.pid}) already owns ${run}`);
    if (fs.readFileSync(lock, 'utf8') !== prior) throw new Error(`watcher lock changed for ${run}; inspect`);
    fs.unlinkSync(lock);
  }
  try { fs.writeFileSync(lock, owner, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`another watcher already owns ${run}`);
    throw error;
  }
  return () => {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); }
    catch { /* Already released. */ }
  };
}
