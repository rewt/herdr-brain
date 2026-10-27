// The launch receipt stays raw. A late native session is a separate, checked
// fact; every identity consumer uses this projection and rejects conflicts.
export const WORKER_KEYS = ['agent', 'pane', 'worker_workspace', 'terminal_id', 'agent_session_id'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => Number.isSafeInteger(value) && value > 0;
export const sameReceipt = (a, b) => Boolean(a && b &&
  ['run', 'started_seq', 'seq', 'cwd', ...WORKER_KEYS].every(k => (a[k] ?? null) === (b[k] ?? null)));

const entry = (table, id) => table instanceof Map ? table.get(id) : Array.isArray(table) ? table.find(row => row.id === id) : table?.[id];
// Adapters transport the side tables separately; never enrich a run object,
// whose exact shape is part of historical completion fingerprints.
export function workerIdentityEvidence(state) {
  const entries = table => table instanceof Map ? Object.fromEntries(table) : table ?? {};
  return { workerReceipts: entries(state?.workerReceipts), sessionBindings: entries(state?.sessionBindings) };
}

export function workerReceipt(run, state) {
  const receipt = entry(state?.workerReceipts, run?.id);
  if (!receipt) return null;
  return { run: run.id, started_seq: run.started.seq, cwd: run.workspace, ...receipt };
}

export function validSessionBind(run, bind, state) {
  const receipt = workerReceipt(run, state), m = run?.meta ?? {}, d = bind?.dispatch;
  const start = Date.parse(bind?.prompted_at), deadline = Date.parse(bind?.deadline), observed = Date.parse(bind?.observed_at);
  const r = bind?.recovery, q = r?.request;
  const decision = [...(run?.notes ?? []), ...(entry(state?.items, run?.item)?.notes ?? [])]
    .find(n => n.seq === q?.decision_seq && n.decision && n.by === r?.supervisor?.name);
  const recovered = r?.kind === 'finished-original' && stamp(q?.decision_seq) && decision &&
    /^[-a-zA-Z0-9_]{1,80}$/.test(q.id ?? '') &&
    [run.id, d?.journal, q.id, q.head, q.source, q.session].every(v => text(v) && decision.text.includes(v)) &&
    q.session === bind.session && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(q.head) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(q.source) && /^[a-f0-9]{64}$/.test(q.journal_sha256) &&
    stamp(r.generation) && text(r.supervisor.session) &&
    r.archive?.file === `${d?.record}/evidence/session-bind/${run.id}/manifest.json` && /^[a-f0-9]{64}$/.test(r.archive?.sha256) &&
    (bind.seq === undefined || bind.by === r.supervisor.name && r.generation < bind.seq && q.decision_seq < bind.seq);
  return Boolean(receipt && sameReceipt(receipt, bind?.receipt) &&
    WORKER_KEYS.every(k => (receipt[k] ?? null) === (m[k] ?? null)) &&
    ['agent', 'pane', 'worker_workspace', 'terminal_id'].every(k => text(receipt[k])) &&
    stamp(receipt.seq) && receipt.seq > receipt.started_seq && text(bind.session) &&
    (!receipt.agent_session_id || receipt.agent_session_id === bind.session) &&
    bind.run === run.id && text(d?.attempt) && d.attempt === m.dispatch_attempt &&
    text(d?.journal) && d.journal === m.dispatch_journal &&
    text(d?.project) && d.project === m.dispatch_project && text(d?.record) && d.record === m.dispatch_record &&
    stamp(bind.process?.pid) && text(bind.process?.identity) &&
    (!r || recovered) && Number.isFinite(start) && deadline > start && deadline - start <= 60000 && observed >= start &&
    (observed <= deadline || recovered) &&
    (bind.seq === undefined || (stamp(bind.seq) && bind.seq > receipt.seq && (!run.report || bind.seq < run.report.seq ||
      (recovered && r.report_seq === run.report.seq && r.report_sha256 === run.report.sha256)) &&
      (!run.abandoned || bind.seq < run.abandoned.seq))));
}

export function effectiveWorkerIdentity(run, state) {
  const m = run?.meta ?? {}, binds = entry(state?.sessionBindings, run?.id) ?? [];
  if (!binds.length) return { ...m, identity_conflict: false };
  if (binds.length !== 1 || !stamp(binds[0]?.seq) || !validSessionBind(run, binds[0], state)) return { ...m, identity_conflict: true };
  return { ...m, agent_session_id: binds[0].session, identity_conflict: false };
}

export function sharesWorker(a, b, state) {
  const x = effectiveWorkerIdentity(a, state), y = effectiveWorkerIdentity(b, state);
  return Boolean((x.agent && x.agent === y.agent) ||
    (x.pane && x.pane === y.pane) ||
    (x.terminal_id && x.terminal_id === y.terminal_id) ||
    (x.agent_session_id && x.agent_session_id === y.agent_session_id));
}
