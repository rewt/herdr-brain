import fs from 'node:fs';
import path from 'node:path';
import { createProcessTracker } from './processes.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

// Native snapshots can race short-lived transports. Retry only refused
// inspections; stopFixtureInbox still confirms ownership before every signal
// and resumes confirmed suspended processes before refusing an inspection.
export async function stopOwnedInbox(file, options) {
  const deadline = Date.now() + loadTimeout(5000);
  for (;;) {
    try { return await stopFixtureInbox(file, options); }
    catch (error) {
      if (!/^Cannot confirm fixture inbox (children|owner|shutdown):/.test(error.message) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
}

// Call only after the fixture's senders/watchers have stopped. Lock metadata is
// a candidate, not signal authority: require the exact owner argv and its own
// detached group (or the bounded runner's test group), then pin its birth tuple
// and freshly confirm every individual signal.
export async function stopFixtureInbox(file, { script, tracker = createProcessTracker() }) {
  const lock = `${file}.owner.lock`;
  let owner;
  for (;;) {
    if (!fs.existsSync(lock)) return;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // Removal can unlink owner.json before its directory disappears. A
      // missing or incomplete receipt is a handoff, never signal authority.
      if (!fs.existsSync(lock)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const expected = [process.execPath, script, '--inbox', file, '--owner-worker'];
  if (!Number.isInteger(owner.pid) || owner.pid <= 1 || !Array.isArray(owner.argv) ||
      !owner.argv.every(arg => typeof arg === 'string') || expected.some((arg, index) => owner.argv[index] !== arg))
    throw Error(`Cannot confirm fixture inbox owner argv: ${file}`);
  const snapshot = tracker.snapshot();
  if (!snapshot.ok) throw Error(`Cannot confirm fixture inbox owner: ${file}`);
  const row = snapshot.value.get(owner.pid), caller = snapshot.value.get(process.pid);
  if (!row || /^Z/.test(row.state)) return;
  // A different command at the recorded PID is a gone owner, not authority to
  // signal the replacement or a reason to retain this fixture's directory.
  if (row.command !== owner.argv.join(' ')) return;
  if (!caller || (row.pgid !== row.pid && row.pgid !== caller.pgid))
    throw Error(`Cannot confirm fixture inbox owner identity: ${file}`);
  const entry = { pid: row.pid, identity: row.identity, command: row.command, group: false };
  return stopFixtureProcessTree(entry, { tracker, ownerGroup: row.pgid, description: file });
}

// The caller supplies its already captured owned birth/command and group.
// Every signal is independently confirmed again by the native tracker.
export async function stopFixtureProcessTree(entry, { tracker = createProcessTracker(), ownerGroup, description }) {
  const file = description ?? `owned producer ${entry.pid}`;
  if (!Number.isInteger(ownerGroup) || ownerGroup <= 1) throw Error(`Cannot confirm fixture producer group: ${file}`);
  const signal = (target, name) => {
    const result = tracker.killProcess(target, name);
    if (!result.ok) throw Error(`Cannot stop fixture inbox process ${target.pid}`);
    return result.signaled;
  };
  // Freeze this confirmed producer and its captured descendants. This closes
  // the spawn/removal race without signaling the test's
  // entire group or leaving a slow fake Herdr command writing into deleted files.
  if (!signal(entry, 'SIGSTOP')) return;
  const owned = new Map([[entry.pid, entry]]);
  try {
    let current;
    for (;;) {
      current = tracker.snapshot();
      if (!current.ok) throw Error(`Cannot confirm fixture inbox children: ${file}`);
      const ownerRow = current.value.get(entry.pid);
      if (!ownerRow || /^Z/.test(ownerRow.state)) break;
      if (ownerRow.identity !== entry.identity || ownerRow.command !== entry.command) break;
      if (ownerRow.pgid !== ownerGroup) throw Error(`Fixture inbox owner group changed: ${file}`);
      if (!/^T/.test(ownerRow.state)) { await new Promise(resolve => setTimeout(resolve, 20)); continue; }
      // Freeze the whole observed producer tree before removal. Killing only a
      // direct transport can orphan its still-running Git/measurement child.
      // Repeat after suspension so a last fork is captured, without a timer or
      // granting ownership to unrelated members of the test's process group.
      const family = new Set([entry.pid]);
      let changed;
      do {
        changed = false;
        for (const child of current.value.values()) if (family.has(child.ppid) && !family.has(child.pid) && !/^Z/.test(child.state)) {
          family.add(child.pid); changed = true;
        }
      } while (changed);
      let waiting = false;
      for (const pid of family) {
        if (pid === entry.pid) continue;
        const child = current.value.get(pid), prior = owned.get(pid);
        if (child.pgid !== ownerGroup) throw Error(`Fixture inbox child escaped its owner group: ${pid}`);
        if (prior && (prior.identity !== child.identity || prior.command !== child.command)) throw Error(`Fixture inbox child identity changed: ${pid}`);
        const target = prior ?? { pid, identity: child.identity, command: child.command, group: false };
        owned.set(pid, target);
        if (!/^T/.test(child.state)) { signal(target, 'SIGSTOP'); waiting = true; }
      }
      if (!waiting) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const target of [...owned.values()].reverse()) signal(target, 'SIGKILL');
  } catch (error) {
    // Preserve the directory and never leave a confirmed owner suspended when
    // a lookup refuses cleanup. Never signal an unconfirmed process group.
    for (const target of owned.values()) signal(target, 'SIGCONT');
    throw error;
  }
  while (owned.size) {
    const current = tracker.snapshot();
    if (!current.ok) throw Error(`Cannot confirm fixture inbox shutdown: ${file}`);
    for (const [pid, target] of owned) {
      const live = current.value.get(pid);
      if (!live || /^Z/.test(live.state) || live.identity !== target.identity || live.command !== target.command) owned.delete(pid);
    }
    if (!owned.size) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Delivery tests can let their owner finish naturally. Settle uses explicit
// owned shutdown above instead.
export async function waitForInboxIdle(file) {
  while (fs.existsSync(`${file}.owner.lock`))
    await new Promise((resolve) => setTimeout(resolve, 20));
}
