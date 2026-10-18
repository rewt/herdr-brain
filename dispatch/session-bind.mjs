import { performance } from 'node:perf_hooks';
import { ownerIdentity } from '../lib/process-owner.mjs';
import path from 'node:path';

// Pin the actual native foreground process, not its persistent terminal/shell.
// An unreadable source or ambiguous foreground is no continuity evidence.
export function nativeProcess(agent, info, readOwner) {
  const fg = info?.foreground_processes;
  if (!Array.isArray(fg) || fg.length !== 1 || fg[0].pid === info.shell_pid ||
      (fg[0].name !== agent.agent && path.basename(fg[0].argv0 ?? '') !== agent.agent))
    throw Error('native foreground process is unavailable or ambiguous');
  const pid = fg[0].pid;
  return { pid, identity: ownerIdentity(pid, readOwner) };
}

// The deadline is created and saved BEFORE delivery. Never initialize it here:
// crash recovery has only the remainder of the original launch opportunity.
export async function observeSessionBinding({ job, save, observe, record, now = Date.now,
  monotonic = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const b = job.sessionBinding;
  if (!b || ['bound', 'unbound'].includes(b.status)) return;
  const finish = (status, reason) => { b.status = status; if (reason) b.reason = reason; save(); };
  // Persist a proposal before calling record. A lost response replays exactly
  // that fact, including after ingestion or deadline, without another prompt.
  const commit = () => {
    try { record(); finish('bound'); }
    catch (e) {
      if (e.recordRefusal) finish('unbound', e.message);
      else {
        b.reason = `bind reply unknown; retry the saved proposal with node dispatch/dispatch.mjs --retry ${job.run}`;
        save();
        process.stderr.write(`dispatch: ${b.reason}\n`);
      }
    }
  };
  if (b.proposed) { commit(); return; }
  if (!b.process) { finish('unbound', 'native process continuity unavailable at launch'); return; }
  const end = Math.min(60000, Date.parse(b.deadline) - now()), started = monotonic();
  while (now() < Date.parse(b.deadline) && monotonic() - started < end) {
    let seen;
    try { seen = observe(); }
    catch { finish('unbound', 'occupant changed or continuity evidence unavailable'); return; }
    if (seen.process.pid !== b.process.pid || seen.process.identity !== b.process.identity) {
      finish('unbound', 'native process changed'); return;
    }
    if (seen.session && now() <= Date.parse(b.deadline) && monotonic() - started < end) {
      b.proposed = { type: 'run.session_bound', run: job.run,
        dispatch: { journal: job.journal, attempt: job.token, project: job.common, record: job.org },
        receipt: b.receipt, process: b.process, prompted_at: b.prompted_at, deadline: b.deadline,
        observed_at: new Date(now()).toISOString(), session: seen.session };
      save(); commit(); return;
    }
    await pause(Math.max(0, Math.min(250, Date.parse(b.deadline) - now(), end - (monotonic() - started))));
  }
  finish('unbound', 'native session not established within the original launch deadline');
}
