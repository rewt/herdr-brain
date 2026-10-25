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
export async function stopGateGroup(pgid, { tracked = new Map(), rootIdentity, ownsGroup = true, ownedChild = false, firstSignal = 'SIGTERM', lookup = lookupProcess, signal = process.kill.bind(process), onCapture } = {}) {
  // A detached leader that is still our unreaped child cannot have its PID or
  // PGID reused. Establish this ownership before any identity lookup or signal.
  const owned = ownsGroup && ownedChild;
  let groupGone = false, identityError, captureError;
  const groupLive = () => {
    if (groupGone) return false;
    if (probe(-pgid) === false) { groupGone = true; return false; }
    return true;
  };
  const uncertain = message => {
    if (!owned) throw Error(message);
    identityError ??= Error(message);
  };
  const snapshot = lookup(undefined, { identityOnly: true });
  if (!snapshot.ok) uncertain(`cannot snapshot gate descendants: ${snapshot.error}`);
  const snapshotRows = snapshot.ok ? snapshot.value : new Map();
  // A reused group-leader PID proves the original group has disappeared.
  // It cannot authorize signalling the replacement or its new descendants.
  if (!owned && rootIdentity && snapshotRows.get(pgid)?.identity && snapshotRows.get(pgid).identity !== rootIdentity) return;
  for (const [pid, row] of descendants(snapshotRows, pgid)) tracked.set(pid, row);
  // Include same-group orphans while the owned PGID still exists.
  for (const row of snapshotRows.values()) if (ownsGroup && row.pgid === pgid) tracked.set(row.pid, row);
  // Receipt owners can preserve this complete final walk before signals stop
  // either the descendants or a child's own in-flight process measurement.
  if (snapshot.ok) {
    try { onCapture?.(new Map(tracked)); }
    catch (error) { captureError = error instanceof Error ? error : Error(String(error)); }
  }
  const live = () => {
    const rows = [];
    for (const saved of tracked.values()) {
      if (owned && saved.pgid === pgid) continue; // group liveness is confirmed by the kernel
      const now = lookup(saved.pid, { identityOnly: true });
      if (!now.ok) { uncertain(`cannot confirm gate descendant ${saved.pid}: ${now.error}`); continue; }
      if (now.value?.identity === saved.identity) rows.push(now.value);
    }
    return rows;
  };
  const send = kind => {
    if (owned && groupLive()) {
      try { signal(-pgid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const rows = live();
    // After leader exit, require a matching member before signalling its group.
    if (!owned && ownsGroup && rows.some(row => row.pgid === pgid)) {
      try { signal(-pgid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const row of rows.filter(row => !ownsGroup || row.pgid !== pgid)) {
      // Confirm immediately before each individual signal (PID reuse safe).
      const now = lookup(row.pid, { identityOnly: true });
      if (!now.ok) { uncertain(now.error); continue; }
      if (now.value?.identity !== row.identity) continue;
      try { signal(row.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  // Null joins observed completion without selecting any signal.
  if (firstSignal !== null) send(firstSignal);
  // Keep the slot until the kernel confirms both the group and escaped children
  // have gone. Unknown identity/probe state cannot authorize slot release.
  while ((ownsGroup && groupLive()) || live().length) await sleep(25);
  // Unknown escaped identities retain the slot, but must not prevent the requested stop of
  // the group whose ownership was established while its leader was our child.
  if (identityError) throw identityError;
  if (captureError) throw captureError;
}
