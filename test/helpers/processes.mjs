// Only a fresh, successful start-time AND command match authorizes a signal.
import { lookupProcess } from '../../lib/processes.mjs';
export { lookupProcess, parseProcessLookup } from '../../lib/processes.mjs';

const same = (entry, current) => current && entry.identity === current.identity && entry.command === current.command;
const complete = (row) => row && Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid) && Number.isInteger(row.pgid) && typeof row.state === 'string' && !!row.state && typeof row.identity === 'string' && !!row.identity && typeof row.command === 'string' && !!row.command;

export function createProcessTracker({
  readIdentity = (pid) => lookupProcess(pid),
  readIdentities = () => lookupProcess(),
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
    registerProcess(pid, group = false, receipt) {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid fixture pid: ${pid}`);
      const result = readIdentity(pid);
      if (receipt && result?.ok && result.value === null) return null;
      if (!result?.ok || !complete(result.value) || result.value.pid !== pid) {
        const error = `cannot establish ownership of PID ${pid}: ${result?.error ?? 'absent or incomplete identity'}`;
        fail(error); throw new Error(error);
      }
      if (receipt) {
        const { suite, command } = receipt;
        const leader = readIdentity(suite.pid);
        if (!leader?.ok || !complete(leader.value) || leader.value.pid !== suite.pid ||
            !same(suite, leader.value) || leader.value.pgid !== suite.pid || /^Z/.test(leader.value.state)) {
          throw new Error(`cannot verify live suite group ${suite.pid}`);
        }
        // A receipt supplies a candidate PID, never proof of ownership. A
        // replacement must not become owned merely because its lookup succeeds.
        if (result.value.pgid !== suite.pid || result.value.command !== command || /^Z/.test(result.value.state)) {
          report(`receipt PID ${pid} is not the expected fixture in suite group ${suite.pid}; no signal sent`);
          return null;
        }
      }
      return entryFor(result.value, group);
    },
    killProcess: signal,
    drainExitedGuards(rows, commands, { drainMs, now = Date.now,
      pause = () => new Promise(resolve => setTimeout(resolve, 20)) } = {}) {
      // Only exact source-bound native --watch commands with departed parents
      // may drain. Live-parent guards and arbitrary fixtures still fail.
      const pending = rows.filter(row => row.ppid === 1 && commands.has(row.command));
      if (!pending.length) return null;
      return (async () => {
        const end = now() + drainMs;
        while (pending.length) {
          for (let index = pending.length - 1; index >= 0; index--) {
            const entry = pending[index];
            const current = readIdentity(entry.pid);
            if (!current?.ok) throw Error(`fixture guard PID ${entry.pid} lookup failed: ${current?.error ?? 'incomplete result'}`);
            if (current.value === null || (complete(current.value) && current.value.pid === entry.pid && /^Z/.test(current.value.state))) {
              pending.splice(index, 1);
              continue;
            }
            if (!complete(current.value) || current.value.pid !== entry.pid || !same(entry, current.value) ||
                current.value.ppid !== 1 || current.value.pgid !== entry.pgid) {
              throw Error(`fixture guard PID ${entry.pid} identity changed during drain`);
            }
          }
          if (!pending.length) return;
          if (now() >= end) throw Error(`fixture guard drain exceeded ${drainMs}ms: ${pending.map(row => row.pid).join(', ')}`);
          await pause();
        }
      })();
    },
    auditGroup(entry) {
      const current = snapshot();
      if (!current.ok) return current;
      const leader = current.value.get(entry.pid);
      if (!same(entry, leader) || leader.pgid !== entry.pid) return fail('suite group leader identity changed or disappeared');
      return { ok: true, survivors: [...current.value.values()].filter(row => row.pgid === entry.pid && row.pid !== entry.pid && !/^Z/.test(row.state)) };
    },
  };
}

export const { registerProcess, killProcess, auditGroup, drainExitedGuards } = createProcessTracker();
