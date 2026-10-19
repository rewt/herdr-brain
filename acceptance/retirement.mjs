import assert from 'node:assert/strict';
import { lookupProcess } from '../lib/processes.mjs';
import { ownerAlive } from '../lib/process-owner.mjs';
import { HarnessLimit } from './limits.mjs';

// Retain the actual shell and descendants, not just the foreground stand-in.
// A native tab-close reply can arrive before its PTY processes have exited.
export function scriptedProcesses(job, { h, readProcesses = () => lookupProcess(undefined, { identityOnly: true }) }) {
  const info = h('pane', 'process-info', '--pane', job.pane).process_info;
  const observed = readProcesses();
  if (!observed.ok || !observed.value.has(info?.shell_pid))
    throw new HarnessLimit(`cannot observe ${job.run} scripted shell: ${observed.error ?? 'shell process missing'}`);
  return [...observed.value.values()].filter(row => {
    const seen = new Set();
    for (let pid = row.pid; !seen.has(pid); pid = observed.value.get(pid)?.ppid) {
      if (pid === info.shell_pid) return true;
      if (!observed.value.has(pid)) break;
      seen.add(pid);
    }
    return false;
  }).map(({ pid, identity, command }) => ({ pid, identity, command }));
}

export async function awaitScriptedExit(job, processes, { until, alive = ownerAlive }) {
  await until(() => processes.every(process => !alive(process)), `${job.run} scripted shell and workers exit`, 30_000);
}

// Match the real supervisor's S7 ordering: guarded pane retirement, confirmed
// process exit, then lane removal. The product's cwd guard remains authoritative.
export async function retireScriptedWorker(job, { h, retire, until }) {
  const processes = scriptedProcesses(job, { h });
  const result = retire(job);
  assert.ok(result.results.some(entry => entry.action === 'closed' &&
    entry.workspace_id === job.info.meta.worker_workspace), `${job.run}: guarded retirement did not close its worker`);
  await awaitScriptedExit(job, processes, { until });
  return { action: 'scripted-worker-retired', run: job.run, processes, results: result.results };
}
