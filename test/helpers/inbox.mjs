import fs from 'node:fs';
import path from 'node:path';
import { createProcessTracker } from './processes.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

// Call only after the fixture's senders/watchers have stopped. Lock metadata is
// a candidate, not signal authority: require the exact owner argv and its own
// detached group (or the bounded runner's test group), then pin its birth tuple
// and freshly confirm every individual signal.
export async function stopFixtureInbox(file, { script, tracker = createProcessTracker() }) {
  const lock = `${file}.owner.lock`;
  if (!fs.existsSync(lock)) return;
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
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
  const signal = (target, name) => {
    const result = tracker.killProcess(target, name);
    if (!result.ok) throw Error(`Cannot stop fixture inbox process ${target.pid}`);
    return result.signaled;
  };
  // Freeze only this confirmed producer while capturing its current transport
  // children. This closes the spawn/removal race without signaling the test's
  // entire group or leaving a slow fake Herdr command writing into deleted files.
  if (!signal(entry, 'SIGSTOP')) return;
  const owned = new Map([[entry.pid, entry]]);
  try {
    let current;
    const stoppedBy = Date.now() + 5000;
    for (;;) {
      current = tracker.snapshot();
      if (!current.ok) throw Error(`Cannot confirm fixture inbox children: ${file}`);
      const ownerRow = current.value.get(entry.pid);
      if (!ownerRow || /^Z/.test(ownerRow.state)) return;
      if (ownerRow.identity !== entry.identity || ownerRow.command !== entry.command) return;
      if (ownerRow.pgid !== row.pgid) throw Error(`Fixture inbox owner group changed: ${file}`);
      if (/^T/.test(ownerRow.state)) break;
      if (Date.now() >= stoppedBy) throw Error(`Fixture inbox owner did not stop: ${file}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const child of current.value.values()) {
      if (child.ppid !== entry.pid || /^Z/.test(child.state)) continue;
      if (child.pgid !== row.pgid) throw Error(`Fixture inbox child escaped its owner group: ${child.pid}`);
      const target = { pid: child.pid, identity: child.identity, command: child.command, group: false };
      owned.set(child.pid, target);
      signal(target, 'SIGKILL');
    }
    signal(entry, 'SIGKILL');
  } catch (error) {
    // Preserve the directory and never leave a confirmed owner suspended when
    // a lookup refuses cleanup. Never signal an unconfirmed process group.
    signal(entry, 'SIGCONT');
    throw error;
  }
  const deadline = Date.now() + 5000;
  while (owned.size) {
    const current = tracker.snapshot();
    if (!current.ok) throw Error(`Cannot confirm fixture inbox shutdown: ${file}`);
    for (const [pid, target] of owned) {
      const live = current.value.get(pid);
      if (!live || /^Z/.test(live.state) || live.identity !== target.identity || live.command !== target.command) owned.delete(pid);
    }
    if (!owned.size) return;
    if (Date.now() >= deadline) throw Error(`fixture inbox processes did not exit: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Delivery tests can let their owner finish naturally. A failed bounded wait
// preserves evidence; settle uses explicit owned shutdown above instead.
export async function waitForInboxIdle(file) {
  const deadline = Date.now() + loadTimeout(5000);
  while (fs.existsSync(`${file}.owner.lock`) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (fs.existsSync(`${file}.owner.lock`)) throw new Error(`fixture inbox owner did not exit: ${file}`);
}
