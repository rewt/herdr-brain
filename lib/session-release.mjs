// Per-run evidence only. No fold keys, session metadata, clock or stored status.
import { roleIs } from './roles.mjs';
import { effectiveWorkerIdentity } from './worker-identity.mjs';

export const SESSION_RELEASE_POLICY = 'per-run-session-release/v1';
const rows = value => value instanceof Map ? [...value.values()] : value ?? [];
const pass = run => run?.report?.outcome === 'done' && String(run.report.extra?.verdict ?? '').trim().toUpperCase() === 'PASS';
const sameReviewer = (e, c) => e.run === c.run && e.pane === c.pane && e.terminal === c.terminal_id &&
  e.session === c.agent_session_id && e.workspace === c.workspace && e.cwd === c.cwd && e.agent === c.agent;

export function callbackVerdict(snapshot, callback) {
  return (snapshot.reviewVerdicts ?? []).find(e => sameReviewer(e, callback));
}

export function callbackRelease(snapshot, callback, git) {
  return (snapshot.releases ?? []).find(e => e.recipient === 'reviewer' && (e.policy !== SESSION_RELEASE_POLICY || snapshot.sessionReleasePolicy === true) && e.confirmed === true && sameReviewer(e, callback) &&
    e.review_id === callbackVerdict(snapshot, callback)?.id && e.seq > callbackVerdict(snapshot, callback)?.record_seq &&
    e.head === git?.head && git.common === snapshot.common && !git.error);
}

function terminalEvidence(snapshot, run) {
  const runs = rows(snapshot.record.runs), items = rows(snapshot.record.items), events = snapshot.events ?? [];
  if (!run.report?.seq || run.abandoned) return null;
  if (roleIs(items.find(i => i.id === run.item), 'REV'))
    return pass(run) ? { why: 'reviewer PASS verdict recorded', evidence: `event:${run.report.seq}` } : null;
  const handoff = (snapshot.handoffs ?? []).find(h => h.from === run.id && h.confirmed === true && h.seq > run.started.seq);
  if (handoff) {
    const successor = runs.find(r => r.id === handoff.to), a = effectiveWorkerIdentity(run, snapshot.record), b = effectiveWorkerIdentity(successor, snapshot.record);
    if (successor && successor.item === run.item && successor.started.seq > run.started.seq && !successor.abandoned &&
        !b.identity_conflict && b.pane && b.terminal_id && b.agent_session_id && b.pane !== a.pane && b.terminal_id !== a.terminal_id && b.agent_session_id !== a.agent_session_id &&
        snapshot.agents.some(agent => agent.name === b.agent && agent.pane_id === b.pane && agent.terminal_id === b.terminal_id &&
          (agent.agent_session?.value ?? agent.agent_session_id) === b.agent_session_id && agent.workspace_id === b.worker_workspace && agent.cwd === successor.workspace))
      return { why: `confirmed retained successor ${successor.id}`, evidence: `event:${handoff.seq}` };
  }
  if (run.report.outcome !== 'done') return null;
  const landed = events.findLast(e => e.type === 'promotion.reconciled' && e.identity === snapshot.common && e.seq > run.report.seq &&
    e.heads?.some(h => h.run === run.id && h.item === run.item) && e.runs?.includes(run.id));
  if (!landed) return null;
  const git = snapshot.git?.find(g => g.path === run.workspace);
  if (!git?.clean || !git.integrated) return null;
  // The integration receipt binds this run, even when siblings keep its item
  // chain open. A newer report/review cannot be borrowed for an older run.
  const next = runs.filter(r => r.item === run.item && r.started.seq > run.started.seq).sort((a,b) => a.started.seq - b.started.seq)[0];
  const reviews = items.filter(i => roleIs(i, 'REV') && i.closed?.as !== 'dropped' &&
    (i.parent === run.item || (snapshot.record.links ?? []).some(l => l.blocker === i.id && l.blocked === run.item)))
    .map(i => runs.filter(r => r.item === i.id && r.started.seq > run.started.seq && (!next || r.started.seq < next.started.seq) &&
      r.report?.seq < landed.seq).sort((a,b) => b.started.seq - a.started.seq)[0]).filter(Boolean);
  const verdicts = (snapshot.reviewVerdicts ?? []).filter(e => e.run === run.id && e.record_seq >= run.report.seq && e.record_seq < landed.seq);
  const latest = new Map(verdicts.map(e => [e.pane, e]));
  const reviewed = reviews.length ? reviews.every(pass) : latest.size > 0 && [...latest.values()].every(e => e.verdict === 'PASS');
  return reviewed ? { why: 'terminal PASS consumed by landed integration', evidence: `event:${landed.seq}` } : null;
}

// The planner tests these prospective releases against every ordinary guard
// before offering them to the shared pane-release transaction on apply.
export function sessionReleaseCandidates(snapshot, matchingRun) {
  const candidates = [], runs = rows(snapshot.record?.runs);
  for (const agent of snapshot.agents ?? []) {
    const callback = (snapshot.callbacks ?? []).find(c => c.kind === 'settle' && c.pane === agent.pane_id && c.agent === agent.name);
    const run = callback ? runs.find(r => r.id === callback.run) : matchingRun(agent, snapshot.record);
    const git = (snapshot.git ?? []).find(g => g.path === run?.workspace);
    if (!run?.report?.seq || run.abandoned || !git?.head || git.error || git.common !== snapshot.common) continue;
    const m = callback ? { pane: callback.pane, terminal_id: callback.terminal_id, agent_session_id: callback.agent_session_id,
      worker_workspace: callback.workspace, agent: callback.agent } : effectiveWorkerIdentity(run, snapshot.record);
    if (m.identity_conflict || !m.agent_session_id || !m.terminal_id || m.pane !== agent.pane_id || m.agent !== agent.name ||
        m.terminal_id !== agent.terminal_id || m.agent_session_id !== (agent.agent_session?.value ?? agent.agent_session_id) ||
        m.worker_workspace !== agent.workspace_id || agent.cwd !== run.workspace) continue;
    const prior = (snapshot.releases ?? []).find(e => e.run === run.id && (e.recipient ?? 'worker') === (callback ? 'reviewer' : 'worker') && (!callback || e.pane === m.pane));
    if (prior) continue; // Never replace or refresh an existing disposition.
    if (runs.some(r => r.started.seq > run.started.seq && (r.meta?.pane === m.pane || effectiveWorkerIdentity(r, snapshot.record).terminal_id === m.terminal_id ||
        effectiveWorkerIdentity(r, snapshot.record).agent_session_id === m.agent_session_id))) continue;
    const verdict = callback && callbackVerdict(snapshot, callback);
    const evidence = callback ? verdict?.verdict === 'PASS' && verdict.record_seq >= run.report.seq &&
      { why: 'reviewer PASS verdict recorded', evidence: `review:${verdict.id}` } : terminalEvidence(snapshot, run);
    if (!evidence) continue;
    const opt = { pane: m.pane, terminal: m.terminal_id, session: m.agent_session_id, head: git.head,
      authority: SESSION_RELEASE_POLICY, policy: SESSION_RELEASE_POLICY, confirm: true,
      next: callback || roleIs(rows(snapshot.record.items).find(i => i.id === run.item), 'REV') ? 'supervisor: continue worker review/integration' : 'supervisor: continue remaining item chain',
      unresolved: 'remaining item work retains its own runs, lanes and record', evidence: [evidence.evidence], why: evidence.why,
      ...(callback ? { reviewer: true } : {}) };
    candidates.push({ run: run.id, tab_id: agent.tab_id, workspace_id: agent.workspace_id, opt,
      release: { type: 'retirement.release', run: run.id, item: run.item, pane: m.pane, terminal: m.terminal_id,
        session: m.agent_session_id, workspace: m.worker_workspace, cwd: run.workspace, head: git.head, confirmed: true,
        seq: Math.max(snapshot.record.revision ?? 0, snapshot.events?.at(-1)?.seq ?? 0, run.report.seq, verdict?.record_seq ?? 0) + 1,
        ...(callback ? { recipient: 'reviewer', agent: m.agent, review_id: verdict.id } : {}) } });
  }
  return candidates;
}
