// Additional read-only process and experiment evidence, scoped to an explicitly
// selected enrolled workspace. No synthetic empty/exit claim is accepted from
// a document without fresh native process/topology checks.
import { readPlainFile } from '../lib/files.mjs';
import { parseUniqueJson } from './json.mjs';
import { readControllerJournal } from './runtime.mjs';
import { readAdapterReceipts, herdrEdge } from './live.mjs';
import { enrolledWorkspace } from './authorization.mjs';
import { equalBinding, digest } from './lifecycle-evidence.mjs';

export function experimentEvidence(file, project, bound) {
  if (!file) return null;
  const e = parseUniqueJson(readPlainFile(file));
  if (e.schema !== 'session-experiment-evidence/v1' || e.common !== project.common || e.server !== bound.server || e.workspace !== bound.workspace ||
      Object.keys(e).some(k => !['schema', 'common', 'server', 'workspace', 'resetRequests', 'recovery', 'quiescence', 'losses', 'inbox'].includes(k)) ||
      !['resetRequests', 'recovery', 'quiescence'].every(k => e[k] && typeof e[k] === 'object' && !Array.isArray(e[k])) || !Array.isArray(e.losses))
    throw Error('invalid scoped experiment evidence');
  return e;
}
export async function observeLive({ observer, project, workspace, evidence, env, herdr = herdrEdge(env) }) {
  const o = await observer.observe(), receipts = readAdapterReceipts(project.common);
  o.receipts = [...(o.receipts ?? []), ...receipts];
  if (!evidence) return { observation: o, experiment: null };
  const bound = enrolledWorkspace(project, workspace), e = experimentEvidence(evidence, project, bound);
  if (!e) return { observation: o, experiment: null };
  if (o.server !== bound.server || !o.complete) throw Error('experiment endpoint or snapshot changed');
  for (const pane of o.panes.filter(p => p.workspace_id === bound.workspace)) {
    // Process reads never type a readiness probe. The launch owner does that
    // only after intent, exact ownership and authorization have been checked.
    pane.emptyConfirmed = false;
    if (o.agents.some(a => a.pane_id === pane.pane_id)) continue;
    const first = herdr(['pane', 'get', pane.pane_id]).pane;
    const info = herdr(['pane', 'process-info', '--pane', pane.pane_id]).process_info;
    const last = herdr(['pane', 'get', pane.pane_id]).pane;
    if (!first || !last || digest(first) !== digest(last) || ['pane_id', 'tab_id', 'workspace_id', 'terminal_id'].some(k => pane[k] !== last[k]))
      throw Error('pane changed during process observation');
    pane.emptyConfirmed = Number.isSafeInteger(info?.shell_pid) && info.shell_pid > 0 && info.foreground_processes?.length === 1 &&
      info.foreground_processes[0].pid === info.shell_pid && last.foreground_cwd === bound.checkout &&
      !last.agent && !last.launch_pending && !last.restore_error && !last.agent_session?.value;
  }
  const journal = readControllerJournal(project.common);
  o.losses = e.losses.filter(l => l.binding?.workspace === bound.workspace).map(l => {
    const b = l.binding, pane = o.panes.find(p => p.pane_id === b.pane);
    if (b.server !== bound.server || b.checkout !== bound.checkout) throw Error('foreign exit evidence');
    const resumed = receipts.some(r => ['resume', 'native-restore'].includes(r.kind) && r.incarnations.some(i =>
      journal.operations.find(op => op.id === r.operationId)?.participants.some(p => equalBinding(p.binding, b)) &&
      o.agents.some(a => equalBinding({ server: o.server, workspace: a.workspace_id, checkout: a.cwd, tab: a.tab_id,
        pane: a.pane_id, terminalId: a.terminal_id, agentName: a.name, nativeSessionId: a.agent_session?.value ?? a.agent_session_id }, i.binding))));
    if (!resumed && (!pane?.emptyConfirmed || pane.tab_id !== b.tab || o.agents.some(a => a.pane_id === b.pane || a.terminal_id === b.terminalId ||
        b.nativeSessionId && b.nativeSessionId === (a.agent_session?.value ?? a.agent_session_id))))
      return { ...l, state: 'unknown', processConfirmedGone: false };
    // An experiment owner must capture native restore state explicitly; absence
    // from agent.list alone can never assert restore ownership or process exit.
    return l;
  });
  // A model-free viewer is one rendered view retained in the exact terminal.
  // It is never inferred from a tab label or arbitrary native occupant.
  o.viewers = receipts.filter(r => !r.kind && journal.operations.find(op => op.id === r.operationId)?.spec.viewer)
    .filter(r => o.panes.some(p => p.pane_id === r.binding.pane && p.tab_id === r.binding.tab && p.terminal_id === r.binding.terminalId) &&
      !o.agents.some(a => a.pane_id === r.binding.pane) && o.panes.find(p => p.pane_id === r.binding.pane)?.emptyConfirmed === true).map(r => ({ binding: r.binding }));
  return { observation: o, experiment: e };
}
