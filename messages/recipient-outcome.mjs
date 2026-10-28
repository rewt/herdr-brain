// Read-only recipient lifecycle evidence. Native idle/done/unknown is not a
// completed run; only the owning record can establish that outcome.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';

export function recipientOutcomes() {
  const records = new Map();
  return (entry, binding) => {
    if (binding.code === 'agent_not_found') return { reason: 'recipient-absent', native_error: binding.error };
    if (!binding.agent || !entry.project) return null;
    const project = entry.project, key = JSON.stringify(project);
    if (!records.has(key)) {
      try {
        const actual = gitProject(project.repo);
        if (actual.canonical !== project.repo || actual.identity !== project.identity || fs.realpathSync(project.org) !== project.org)
          throw Error('recipient record/project binding changed');
        try {
          const { events, tornTail } = loadEvents(project.org);
          if (tornTail) throw Error('recipient record has an incomplete tail');
          records.set(key, { state: fold(events) });
        } catch (error) {
          if (error.code !== 'ENOENT' || error.path !== path.join(project.org, 'events.jsonl')) throw error;
          // A missing log cannot establish recipient completion. Let the
          // existing native/quiet gate deliver the original exception notice.
          records.set(key, {});
        }
      } catch (error) { records.set(key, { error: error.message }); }
    }
    const { state, error } = records.get(key);
    if (error) return { hold: error };
    if (!state) return null;
    const agent = binding.agent;
    const named = [...state.runs.values()].map(run => ({ run, worker: effectiveWorkerIdentity(run, state) }))
      .filter(({ worker }) => [entry.to, agent.name].includes(worker.agent));
    if (!named.length) return null; // Named supervisors need not be worker runs.
    const matching = named.filter(({ run, worker: w }) => !w.identity_conflict &&
      [w.agent, w.pane, w.worker_workspace, w.terminal_id, w.agent_session_id, run.workspace].every(v => typeof v === 'string' && v) &&
      w.agent === agent.name && w.pane === agent.pane_id && w.worker_workspace === agent.workspace_id &&
      w.terminal_id === agent.terminal_id && w.agent_session_id === agent.agent_session?.value && run.workspace === agent.cwd);
    // A continuation sharing this native session remains an active recipient.
    if (matching.some(({ run }) => !run.report && !run.abandoned)) return null;
    if (!matching.length) return { hold: 'recipient differs from recorded worker identity; no input attempted' };
    const { run } = matching.sort((a, b) => b.run.started.seq - a.run.started.seq)[0];
    const terminal = run.report ?? run.abandoned;
    return { reason: run.report ? 'recipient-finished' : 'recipient-abandoned', run: run.id,
      record: project.org, project: project.identity, evidence_seq: terminal.seq, occupant: binding.occupant };
  };
}
