// The launch receipt stays raw. A late native session is a separate, checked
// fact; every identity consumer uses this projection and rejects conflicts.
export const WORKER_KEYS = ['agent', 'pane', 'worker_workspace', 'terminal_id', 'agent_session_id'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => Number.isSafeInteger(value) && value > 0;
export const sameReceipt = (a, b) => Boolean(a && b &&
  ['run', 'started_seq', 'seq', 'cwd', ...WORKER_KEYS].every(k => (a[k] ?? null) === (b[k] ?? null)));

export function workerReceipt(run) {
  if (!run?.worker_receipt) return null;
  return { run: run.id, started_seq: run.started.seq, cwd: run.workspace, ...run.worker_receipt };
}

export function validSessionBind(run, bind) {
  const receipt = workerReceipt(run), m = run?.meta ?? {}, d = bind?.dispatch;
  const start = Date.parse(bind?.prompted_at), deadline = Date.parse(bind?.deadline), observed = Date.parse(bind?.observed_at);
  return Boolean(receipt && sameReceipt(receipt, bind?.receipt) &&
    WORKER_KEYS.every(k => (receipt[k] ?? null) === (m[k] ?? null)) &&
    ['agent', 'pane', 'worker_workspace', 'terminal_id'].every(k => text(receipt[k])) &&
    stamp(receipt.seq) && receipt.seq > receipt.started_seq && text(bind.session) &&
    (!receipt.agent_session_id || receipt.agent_session_id === bind.session) &&
    bind.run === run.id && text(d?.attempt) && d.attempt === m.dispatch_attempt &&
    text(d?.journal) && d.journal === m.dispatch_journal &&
    text(d?.project) && d.project === m.dispatch_project && text(d?.record) && d.record === m.dispatch_record &&
    stamp(bind.process?.pid) && text(bind.process?.identity) &&
    Number.isFinite(start) && deadline > start && deadline - start <= 60000 && observed >= start && observed <= deadline &&
    (bind.seq === undefined || (stamp(bind.seq) && bind.seq > receipt.seq && (!run.report || bind.seq < run.report.seq) &&
      (!run.abandoned || bind.seq < run.abandoned.seq))));
}

export function effectiveWorkerIdentity(run) {
  const m = run?.meta ?? {}, binds = run?.session_bindings ?? [];
  if (!binds.length) return { ...m, identity_conflict: false };
  if (binds.length !== 1 || !stamp(binds[0]?.seq) || !validSessionBind(run, binds[0])) return { ...m, identity_conflict: true };
  return { ...m, agent_session_id: binds[0].session, identity_conflict: false };
}

export function sharesWorker(a, b) {
  const x = effectiveWorkerIdentity(a), y = effectiveWorkerIdentity(b);
  return Boolean((x.agent && x.agent === y.agent) ||
    (x.pane && x.pane === y.pane) ||
    (x.terminal_id && x.terminal_id === y.terminal_id) ||
    (x.agent_session_id && x.agent_session_id === y.agent_session_id));
}
