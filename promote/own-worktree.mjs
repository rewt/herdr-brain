// Self-promotion authority is the live worker and active claim, never cwd labels.
// Native reads and derivation precede the short source/claim fence across FF.
import fs from '../lib/record-observation.mjs';
import { findOrgDir, withRecordGuard } from '../lib/store.mjs';
import { openQuestionsFor } from '../lib/state.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner-guard.mjs';
import { dispatchSourceBinding } from '../lib/source-provenance.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';

const tuple = b => [b.project.identity, b.project.canonical, b.project.checkout, b.org,
  b.native.name, b.native.pane_id, b.native.workspace_id, b.native.terminal_id,
  b.native.agent_session.value, b.native.cwd];

export function ownWorktreeGuard({ canonical, identity, workspace, topic, env = process.env, call }) {
  const org = findOrgDir({ cwd: workspace, env });
  if (!org) throw Error('self-promotion requires the owning record; nothing merged');
  let captured;
  const guard = (operation = () => {}) => withRecordGuard(org, (events, state) => {
    const binding = nativeSender(org, { cwd: workspace, env, ...(call ? { call } : {}) });
    if (binding.project.identity !== identity || binding.project.canonical !== canonical ||
        binding.project.checkout !== fs.realpathSync(workspace)) throw Error('self-promotion source/project differs; nothing merged');
    const native = binding.native;
    const matches = [...state.runs.values()].filter(run => {
      const item = state.items.get(run.item), worker = effectiveWorkerIdentity(run, state);
      return item?.kind === 'work' && item.role === 'engineer' &&
        item.runs.findLast(id => !state.runs.get(id)?.abandoned) === run.id &&
        !item.closed && !item.meta.operator_reserved && !run.abandoned && !run.report &&
        run.workspace && (!run.meta.lane || run.meta.lane === topic) && !worker.identity_conflict &&
        worker.agent === native.name && worker.pane === native.pane_id &&
        worker.worker_workspace === native.workspace_id && worker.terminal_id === native.terminal_id &&
        worker.agent_session_id === native.agent_session.value &&
        // Removed workspaces on unrelated open runs are valid. Resolve only
        // the exact native worker's source; its real path must still match.
        fs.realpathSync(run.workspace) === fs.realpathSync(workspace);
    });
    if (matches.length !== 1) throw Error('self-promotion requires one active owning native worker/run; nothing merged');
    const run = readOwnedRun(org, matches[0].id, events), owner = requireController(run, 'brain');
    dispatchSourceBinding({run,events,identity,org,workspace});
    let item = state.items.get(run.item);
    while (item) {
      if (item.meta.hold) throw Error(`self-promotion HOLD on ${item.id}; nothing merged`);
      item = state.items.get(item.parent);
    }
    const [question] = openQuestionsFor(state, run.item);
    if (question) throw Error(`self-promotion has an open operator question ${question.id}; nothing merged`);
    if (captured) {
      if (captured.run !== run.id || JSON.stringify(captured.native) !== JSON.stringify(tuple(binding)))
        throw Error('self-promotion native worker/run changed; nothing merged');
      assertOwner(run, captured.owner);
    } else captured = { run: run.id, owner, native: tuple(binding) };
  }, operation, { label: 'own-promotion' });
  guard();
  return guard;
}
