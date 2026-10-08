// Stop the owned group plus descendants proven by a pre-signal parent walk.
// Escaped groups get individual, birth-confirmed signals, never a broad kill.
import { lookupProcess } from '../lib/processes.mjs';
import { probe } from './lock-support.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function descendants(rows, root) {
  const found = new Map();
  for (const row of rows.values()) {
    const seen = new Set();
    for (let pid = row.pid; rows.has(pid) && !seen.has(pid); pid = rows.get(pid).ppid) {
      if (pid === root) { found.set(row.pid, row); break; }
      seen.add(pid);
    }
  }
  return found;
}
export async function stopGateGroup(pgid, { graceMs = 1000, tracked = new Map(), rootIdentity, ownsGroup = true, firstSignal = 'SIGTERM', lookup = lookupProcess, signal = process.kill.bind(process) } = {}) {
  const snapshot = lookup(undefined, { identityOnly: true });
  if (!snapshot.ok) throw Error(`cannot snapshot gate descendants: ${snapshot.error}`);
  // A reused group-leader PID proves the original group has disappeared.
  // It cannot authorize signalling the replacement or its new descendants.
  if (rootIdentity && snapshot.value.get(pgid)?.identity && snapshot.value.get(pgid).identity !== rootIdentity) return;
  for (const [pid, row] of descendants(snapshot.value, pgid)) tracked.set(pid, row);
  // Include same-group orphans while the owned PGID still exists.
  for (const row of snapshot.value.values()) if (ownsGroup && row.pgid === pgid) tracked.set(row.pid, row);
  const live = () => {
    const rows = [];
    for (const saved of tracked.values()) {
      const now = lookup(saved.pid, { identityOnly: true });
      if (!now.ok) throw Error(`cannot confirm gate descendant ${saved.pid}: ${now.error}`);
      if (now.value?.identity === saved.identity) rows.push(now.value);
    }
    return rows;
  };
  const send = kind => {
    const rows = live();
    // A matching group member proves this is still the owned group.
    if (ownsGroup && rows.some(row => row.pgid === pgid)) {
      try { signal(-pgid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const row of rows.filter(row => !ownsGroup || row.pgid !== pgid)) {
      // Confirm immediately before each individual signal (PID reuse safe).
      const now = lookup(row.pid, { identityOnly: true });
      if (!now.ok) throw Error(now.error);
      if (now.value?.identity !== row.identity) continue;
      try { signal(row.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  send(firstSignal);
  const deadline = Date.now() + graceMs;
  while (((ownsGroup && probe(-pgid) !== false) || live().length) && Date.now() < deadline) await sleep(25);
  send('SIGKILL');
  // Keep the slot until the kernel confirms both the group and escaped children
  // have gone. Unknown identity/probe state cannot authorize slot release.
  while ((ownsGroup && probe(-pgid) !== false) || live().length) await sleep(25);
}
