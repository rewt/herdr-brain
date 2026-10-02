// An outer watchdog can reap registered groups even if a test's event loop
// blocks and node:test cannot run its teardown hooks.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function identity(pid) {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' }).stdout?.trim();
}

export function processRegistries(env = process.env) {
  return [...new Set([
    env.TEST_PROCESS_REGISTRY,
    ...JSON.parse(env.TEST_PROCESS_ANCESTOR_REGISTRIES ?? '[]'),
  ].filter(Boolean))];
}

function identities() {
  // One bounded snapshot keeps watchdog cleanup bounded even with many entries.
  const snapshot = spawnSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
  return new Map((snapshot.stdout ?? '').trim().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? [[Number(match[1]), match[2]]] : [];
  }));
}

// Injectable OS operations allow deterministic PID-reuse regression tests;
// obtaining an actual reused PID would depend on host load and PID allocation.
export function createProcessTracker({
  readIdentity = identity,
  readIdentities = identities,
  sendSignal = (pid, signal) => process.kill(pid, signal),
  append = (file, entry) => fs.appendFileSync(file, JSON.stringify(entry) + '\n'),
} = {}) {
  const registered = new Map();
  const signal = (entry, current) => {
    if (current && current !== entry.identity) return; // PID now belongs to someone else.
    try { sendSignal(entry.group && process.platform !== 'win32' ? -entry.pid : entry.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  return {
    registerProcess(pid, group = true, registries = processRegistries()) {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid fixture pid: ${pid}`);
      const start = readIdentity(pid);
      let registration = registered.get(pid);
      if (!registration || registration.entry.identity !== start || registration.entry.group !== group) {
        registration = { entry: { pid, group, identity: start }, written: new Set() };
        registered.set(pid, registration);
      }
      for (const file of registries) if (!registration.written.has(file)) {
        append(file, registration.entry);
        registration.written.add(file);
      }
      return registration.entry;
    },
    killProcess(entry) { signal(entry, readIdentity(entry.pid)); },
    killProcesses(entries) {
      const current = readIdentities();
      // Newer descendants come before their watchdogs, including a worker
      // cleaning up its own registry after its parent was killed with SIGKILL.
      for (const entry of [...entries].reverse()) signal(entry, current.get(entry.pid));
    },
  };
}

export const { registerProcess, killProcess, killProcesses } = createProcessTracker();
