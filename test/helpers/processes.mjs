// Only a fresh, successful start-time AND command match authorizes a signal.
import { spawnSync } from 'node:child_process';

const fields = ['pid=', 'ppid=', 'pgid=', 'stat=', 'lstart=', 'command='].join(',');
const same = (entry, current) => current && entry.identity === current.identity && entry.command === current.command;
const complete = (row) => row && Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid) && Number.isInteger(row.pgid) && typeof row.state === 'string' && !!row.state && typeof row.identity === 'string' && !!row.identity && typeof row.command === 'string' && !!row.command;

export function parseProcessLookup(result, pid) {
  if (result.error || result.signal) return { ok: false, error: result.error?.message ?? `ps terminated by ${result.signal}` };
  if (pid && result.status === 1 && !result.stdout && !result.stderr) return { ok: true, value: null };
  if (result.status !== 0 || result.stderr?.trim() || !result.stdout?.endsWith('\n')) return { ok: false, error: `failed or incomplete ps output (status ${result.status})` };
  const rows = new Map();
  for (const line of result.stdout.trimEnd().split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) return { ok: false, error: 'malformed or truncated ps record' };
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], identity: match[5].replace(/\s+/g, ' '), command: match[6] };
    if (!complete(row) || rows.has(row.pid)) return { ok: false, error: 'incomplete or duplicate ps identity' };
    rows.set(row.pid, row);
  }
  if (pid) {
    if (rows.size !== 1 || !rows.has(pid)) return { ok: false, error: 'ps did not return the requested PID' };
    return { ok: true, value: rows.get(pid) };
  }
  // A complete system snapshot must contain its live caller as an anchor.
  if (!rows.has(process.pid)) return { ok: false, error: 'ps snapshot omitted its caller' };
  return { ok: true, value: rows };
}

function lookup(pid) {
  const result = spawnSync('ps', ['-ww', '-o', fields, ...(pid ? ['-p', String(pid)] : ['-A'])], {
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return parseProcessLookup(result, pid);
}

export function createProcessTracker({
  readIdentity = (pid) => lookup(pid),
  readIdentities = () => lookup(),
  sendSignal = (pid, signal) => process.kill(pid, signal),
  report = (message) => console.error(`Fixture cleanup: ${message}`),
} = {}) {
  const fail = (message) => { report(`${message}; no signal sent`); return { ok: false, error: message }; };
  const entryFor = (row, group = false) => ({ pid: row.pid, group, identity: row.identity, command: row.command });
  const snapshot = () => {
    let result;
    try { result = readIdentities(); } catch (error) { return fail(`process snapshot failed: ${error.message}`); }
    if (!result?.ok || !(result.value instanceof Map) || ![...result.value].every(([pid, row]) => complete(row) && pid === row.pid)) return fail(`process snapshot failed: ${result?.error ?? 'incomplete identities'}`);
    return result;
  };
  const signal = (entry, name = 'SIGKILL') => {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 1 || typeof entry.identity !== 'string' || !entry.identity || typeof entry.command !== 'string' || !entry.command) return fail(`PID ${entry?.pid ?? 'unknown'} has no complete owned identity`);
    let result;
    try { result = readIdentity(entry.pid); } catch (error) { return fail(`PID ${entry.pid} lookup failed: ${error.message}`); }
    if (!result?.ok) return fail(`PID ${entry.pid} lookup failed: ${result?.error ?? 'incomplete result'}`);
    if (result.value === null) return { ok: true, signaled: false, reason: 'absent' }; // Never a group-kill license.
    if (!complete(result.value) || result.value.pid !== entry.pid) return fail(`PID ${entry.pid} lookup returned an incomplete identity`);
    if (/^Z/.test(result.value.state)) return { ok: true, signaled: false, reason: 'absent' };
    if (!same(entry, result.value)) { report(`PID ${entry.pid} start time or command changed; ${name} skipped`); return { ok: true, signaled: false, reason: 'changed' }; }
    if (entry.group && result.value.pgid !== entry.pid) return fail(`PID ${entry.pid} is no longer its owned group leader`);
    // No await, cached snapshot or fallback between this confirmation and kill.
    try { sendSignal(entry.group && process.platform !== 'win32' ? -entry.pid : entry.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') return fail(`PID ${entry.pid} ${name} failed: ${error.message}`); }
    return { ok: true, signaled: true };
  };
  return {
    snapshot,
    registerProcess(pid, group = false) {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid fixture pid: ${pid}`);
      const result = readIdentity(pid);
      if (!result?.ok || !complete(result.value) || result.value.pid !== pid) {
        const error = `cannot establish ownership of PID ${pid}: ${result?.error ?? 'absent or incomplete identity'}`;
        fail(error); throw new Error(error);
      }
      return entryFor(result.value, group);
    },
    killProcess: signal,
    auditGroup(entry) {
      const current = snapshot();
      if (!current.ok) return current;
      const leader = current.value.get(entry.pid);
      if (!same(entry, leader) || leader.pgid !== entry.pid) return fail('suite group leader identity changed or disappeared');
      return { ok: true, survivors: [...current.value.values()].filter(row => row.pgid === entry.pid && row.pid !== entry.pid && !/^Z/.test(row.state)) };
    },
  };
}

export const { registerProcess, killProcess, auditGroup } = createProcessTracker();
