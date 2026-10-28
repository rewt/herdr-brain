// Additive completion data, deliberately outside historical folded run shapes.
import { effectiveWorkerIdentity } from './worker-identity.mjs';

export function completionSession(run, state, native = {}) {
  const identity = effectiveWorkerIdentity(run, state);
  const harness = identity.harness ?? native.harness;
  return {
    agent_session_id: identity.identity_conflict ? null : identity.agent_session_id ?? native.session ?? null,
    harness: ['claude', 'codex'].includes(harness) ? harness : null,
    resume: { workspace: run?.workspace ?? null, lane: identity.lane ?? null,
      branch: identity.lane ? `lane/${identity.lane}` : null },
  };
}

// Older settle reviewers can be associated with the author's run. The pane's
// bound conversation must never be replaced by that author's different UUID.
export function closedSessionCompletion(run, state, { session, harness, workspace, branch }) {
  const identity = effectiveWorkerIdentity(run, state);
  const own = !identity.identity_conflict && identity.agent_session_id === session;
  return { ...completionSession(own ? run : undefined, state, { session, harness }),
    resume: { workspace, lane: branch.slice('lane/'.length), branch } };
}

// A completion alone supplies the saved conversation and its working directory.
// Neither mutable run metadata nor a bind-event join supplies resume identity.
export function completedSession(events, session) {
  for (const event of events.toReversed()) {
    const records = event.type === 'report.ingested' ? [event]
      : event.type === 'closeout.effect' && event.outcome?.action === 'closed' ? event.outcome.sessions ?? [] : [];
    const record = records.find(row => row.agent_session_id === session);
    if (record) return { run: event.run, item: event.item, ...record };
  }
  return null;
}
