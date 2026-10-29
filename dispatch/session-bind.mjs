import { performance } from 'node:perf_hooks';
import { ownerIdentity } from '../lib/process-owner.mjs';
import path from 'node:path';

// Pin the actual native foreground process, not its persistent terminal/shell.
// An unreadable source or ambiguous foreground is no continuity evidence.
export function nativeProcess(agent, info, readOwner) {
  const fg = info?.foreground_processes;
  if (!Array.isArray(fg) || fg.length !== 1 || fg[0].pid === info.shell_pid ||
      (fg[0].name !== agent.agent && path.basename(fg[0].argv0 ?? '') !== agent.agent))
    throw Object.assign(Error('native foreground process is unavailable or ambiguous'), { code: 'NATIVE_FOREGROUND_UNAVAILABLE' });
  const pid = fg[0].pid;
  return { pid, identity: ownerIdentity(pid, readOwner) };
}

// Dispatch saves the deadline before delivery or explicit delivery confirmation.
// Never initialize it here: observation retries only get the saved remainder.
export async function observeSessionBinding({ job, save, observe, record, qualify, now = Date.now,
  monotonic = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const b = job.sessionBinding;
  if (!b || b.status === 'bound' || b.status === 'unbound' && !b.proposed) return;
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
    catch (error) {
      const expired = now() >= Date.parse(b.deadline) || monotonic() - started >= end;
      // Native process-info can briefly expose the login shell while the
      // original agent changes foreground groups. This is no continuity proof.
      // Wait only inside the original delivery window; refusals still stop.
      if (!expired && error.code === 'NATIVE_FOREGROUND_UNAVAILABLE') {
        await pause(Math.max(0, Math.min(250, Date.parse(b.deadline) - now(), end - (monotonic() - started))));
        continue;
      }
      finish('unbound', expired ? 'native session observation deadline expired' :
        `native session observation failed: ${error.message}`);
      return;
    }
    if (seen.process.pid !== b.process.pid || seen.process.identity !== b.process.identity) {
      finish('unbound', 'native process changed'); return;
    }
    let session;
    try { session = qualify ? qualify(seen) : seen.session; }
    catch (error) { finish('unbound', `resume delivery qualification failed: ${error.message}`); return; }
    if (qualify && session) {
      let after;
      try { after = observe(); } catch (error) { finish('unbound', `native observation after delivery failed: ${error.message}`); return; }
      if (after.process.pid !== b.process.pid || after.process.identity !== b.process.identity || after.session && after.session !== session) {
        finish('unbound', 'native identity changed during delivery qualification'); return;
      }
    }
    if (session && now() <= Date.parse(b.deadline) && monotonic() - started < end) {
      b.proposed = { type: 'run.session_bound', run: job.run,
        dispatch: { journal: job.journal, attempt: job.token, project: job.common, record: job.org },
        receipt: b.receipt, process: b.process, prompted_at: b.prompted_at, deadline: b.deadline,
        observed_at: new Date(now()).toISOString(), session };
      save(); commit(); return;
    }
    await pause(Math.max(0, Math.min(250, Date.parse(b.deadline) - now(), end - (monotonic() - started))));
  }
  finish('unbound', 'native session not established within the saved delivery deadline');
}
