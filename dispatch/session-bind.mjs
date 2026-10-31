import { performance } from 'node:perf_hooks';
import { ownerIdentity } from '../lib/process-owner.mjs';
import path from 'node:path';
import { outcomeFailure } from '../lib/uncertain-outcome.mjs';

// Stderr's record: prefix also covers transient storage errors. Only the
// writer's explicit fact-refusal receipt establishes a final record refusal.
export function sessionBindRefused(receipt) {
  if (!receipt || receipt.error || receipt.signal || !Number.isInteger(receipt.status) || receipt.status === 0) return false;
  try {
    const reply = JSON.parse(receipt.stdout);
    return reply.schema === 'dispatch-session-binding/v1' && reply.outcome === 'refused' &&
      reply.code === 'SESSION_BIND_REFUSED';
  } catch { return false; }
}

// Opt in only fresh requests. Saved deliveries and resumed conversations retain
// their original observation/recovery path.
export const requiresLaunchSessionBinding = job => job.launchSessionBindProtocol === 1 &&
  job.workerSessionWaitProtocol === 2 && !job.resumeDeliveryProtocol && !job.reuse && Boolean(job.worker?.agentSessionId);

// Protocol 2 gives launch-time sessions the same explicit fact as late sessions.
// Saved requests keep their original receipt-only behavior and observation window.
export function prepareSessionObservation({ job, run, receipt, now = Date.now }) {
  const binding = job.sessionBinding;
  if ((job.worker.agentSessionId && job.workerSessionWaitProtocol !== 2) ||
      run.meta.dispatch_attempt !== job.token || binding?.status === 'bound' || binding?.proposed) return;
  const launchReceipt = binding ? binding.receipt : receipt();
  const prompted = job.resumeDeliveryProtocol ? Date.parse(job.resumeDelivery.started_at) : now();
  job.sessionBinding = { status: 'observing', process: binding ? binding.process : job.launchProcess ?? null,
    receipt: launchReceipt, prompted_at: new Date(prompted).toISOString(), deadline: new Date(prompted + 60000).toISOString() };
}

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

// Only the saved record fact is replayable. Native delivery is never part of
// this operation. Keep every attempt, including a lost reply, on its proposal.
export function commitSessionBinding({ job, save, record, now = Date.now }) {
  const b = job.sessionBinding;
  if (b?.status !== 'observing' || !b.proposed || b.record_refusal) return;
  const attempt = { started_at: new Date(now()).toISOString(), outcome: 'unknown' };
  (b.commit_attempts ??= []).push(attempt);
  save();
  try {
    const reply = record();
    attempt.receipt = typeof reply === 'string' ? JSON.parse(reply) : reply;
    attempt.outcome = 'bound';
    b.status = 'bound'; delete b.reason;
    b.commit_receipt = attempt.receipt;
  } catch (error) {
    const r = error.receipt;
    const refused = error.recordRefusal || outcomeFailure(error).kind === 'fence' || sessionBindRefused(r);
    attempt.error = { message: error.message, ...(error.code ? { code: error.code } : {}), ...(r ? { receipt: r } : {}) };
    if (refused) {
      attempt.outcome = 'refused'; b.status = 'unbound'; b.record_refusal = true; b.reason = error.message;
    } else {
      b.reason = 'bind reply unknown; saved proposal awaits line replay';
      process.stderr.write(`dispatch: ${b.reason}\n`);
    }
  }
  attempt.finished_at = new Date(now()).toISOString();
  save();
  return attempt;
}

// Dispatch saves the deadline before delivery or explicit delivery confirmation.
// Never initialize it here: observation retries only get the saved remainder.
export async function observeSessionBinding({ job, save, observe, record, qualify, now = Date.now,
  monotonic = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const b = job.sessionBinding;
  if (!b || b.status !== 'observing' || b.record_refusal) return;
  const finish = (status, reason) => { b.status = status; if (reason) b.reason = reason; save(); };
  // Persist a proposal before calling record. A lost response replays exactly
  // that fact, including after ingestion or deadline, without another prompt.
  const commit = () => commitSessionBinding({ job, save, record, now });
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
