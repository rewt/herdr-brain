// Read-only recipient lifecycle evidence. Native idle/done/unknown is not a
// completed run; only the owning record can establish that outcome.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';

export function recipientOutcomes() {
  const records = new Map(), projects = new Map();
  return (entry, binding) => {
    // A named supervisor is a role across session recycles. Missing native
    // binding grants no input, but does not retire its durable exception.
    if (entry.recipient_role === 'project-supervisor') return null;
    const project = entry.project, key = JSON.stringify(project);
    if (project) {
      try {
        if (!projects.has(key)) {
          const actual = gitProject(project.repo);
          if (actual.canonical !== project.repo || actual.identity !== project.identity || fs.realpathSync(project.org) !== project.org)
            throw Error('recipient record/project binding changed');
          projects.set(key, readProjectPolicy(project.repo, 'promote', process.env, { canonical: actual.canonical }).config.to);
        }
        // Saved watcher callbacks predate recipient_role. Resolve their owning
        // project's supervisor without folding the worker record at all.
        if (projects.get(key) === entry.to) return null;
      } catch (error) { return { hold: error.message }; }
    }
    if (binding.code === 'agent_not_found') return { reason: 'recipient-absent', native_error: binding.error };
    if (!binding.agent || !project) return null;
    try {
      const file = path.join(project.org, 'events.jsonl');
      let stamp;
      try {
        const s = fs.statSync(file, { bigint: true });
        stamp = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
      } catch (error) { if (error.code !== 'ENOENT') throw error; stamp = 'missing'; }
      if (records.get(key)?.stamp !== stamp) {
        try {
          const { events, tornTail } = loadEvents(project.org);
          if (tornTail) throw Error('recipient record has an incomplete tail');
          records.set(key, { stamp, state: fold(events) });
        } catch (error) {
          if (error.code !== 'ENOENT' || error.path !== path.join(project.org, 'events.jsonl')) throw error;
          // A missing log cannot establish recipient completion. Let the
          // existing native/quiet gate deliver the original exception notice.
          records.set(key, { stamp });
        }
      }
    } catch (error) { return { hold: error.message }; }
    const { state } = records.get(key);
    if (!state) return null;
    const agent = binding.agent;
    const named = [...state.runs.values()].map(run => ({ run, worker: effectiveWorkerIdentity(run, state) }))
      .filter(({ worker }) => [entry.to, agent.name].includes(worker.agent));
    if (!named.length) return null; // Named supervisors need not be worker runs.
    // Incomplete active bindings are governed by the existing quiet gate, not
    // by the stronger evidence required to retire a terminal worker's notice.
    if (named.some(({ run }) => !run.report && !run.abandoned)) return null;
    const matching = named.filter(({ run, worker: w }) => !w.identity_conflict &&
      [w.agent, w.pane, w.worker_workspace, w.terminal_id, w.agent_session_id, run.workspace].every(v => typeof v === 'string' && v) &&
      w.agent === agent.name && w.pane === agent.pane_id && w.worker_workspace === agent.workspace_id &&
      w.terminal_id === agent.terminal_id && w.agent_session_id === agent.agent_session?.value && run.workspace === agent.cwd);
    if (!matching.length) return { hold: 'recipient differs from recorded worker identity; no input attempted' };
    const { run } = matching.sort((a, b) => b.run.started.seq - a.run.started.seq)[0];
    const terminal = run.report ?? run.abandoned;
    return { reason: run.report ? 'recipient-finished' : 'recipient-abandoned', run: run.id,
      record: project.org, project: project.identity, evidence_seq: terminal.seq, occupant: binding.occupant };
  };
}
