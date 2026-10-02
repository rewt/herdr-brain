// An outer watchdog can reap registered groups even if a test's event loop
// blocks and node:test cannot run its teardown hooks.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const registered = new Map();
function identity(pid) {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' }).stdout?.trim();
}
export function registerProcess(pid, group = true) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid fixture pid: ${pid}`);
  if (registered.has(pid)) return registered.get(pid);
  const entry = { pid, group, identity: identity(pid) };
  registered.set(pid, entry);
  if (process.env.TEST_PROCESS_REGISTRY) fs.appendFileSync(process.env.TEST_PROCESS_REGISTRY, JSON.stringify(entry) + '\n');
  return entry;
}
export function killProcess(entry) {
  const current = identity(entry.pid);
  if (current && current !== entry.identity) return; // PID was reused.
  try { process.kill(entry.group && process.platform !== 'win32' ? -entry.pid : entry.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export function killProcesses(entries) {
  // One bounded snapshot keeps watchdog cleanup bounded even with many entries.
  const snapshot = spawnSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
  const identities = new Map((snapshot.stdout ?? '').trim().split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? [Number(match[1]), match[2]] : [];
  }));
  for (const entry of entries) {
    const current = identities.get(entry.pid);
    if (current && current !== entry.identity) continue;
    try { process.kill(entry.group && process.platform !== 'win32' ? -entry.pid : entry.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
