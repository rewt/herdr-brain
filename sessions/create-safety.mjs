// Shared read-only creation guards. An enrollment never claims a live agent.
import { matchingRun } from '../lib/retire.mjs';
import { agentBinding } from './observe.mjs';
import { equalBinding, validLaunchReceipt } from './lifecycle-evidence.mjs';
import { validAdoptOperation } from './adoption-evidence.mjs';

// Only the adapter can prove that it has not entered the native create call.
export class CreateNotInvokedError extends Error {
  constructor(cause) { super(cause.message, { cause }); this.name = 'CreateNotInvokedError'; }
}

export const sameWorkspace = (a, b) => ['server', 'workspace', 'checkout'].every(k => a?.[k] === b?.[k]);
export const claimsPosition = (op, uid, target, standardSlot) => op.state !== 'never-started' &&
  (op.uid === uid || sameWorkspace(op.target, target) && (op.standardSlot ?? op.spec?.standardSlot) === standardSlot);
export function unownedWorkspaceReason(observation, journal, facts, target) {
  const bindings = journal.operations.filter(op => ['start-standard-slot', 'create-standard-slot'].includes(op.kind))
    .flatMap(op => [op.receipt, ...(observation.receipts ?? []).filter(r => r.operationId === op.id)]
      .filter(r => validLaunchReceipt(op, r)).map(r => r.binding));
  bindings.push(...(journal.incarnations ?? []).map(i => i.binding));
  bindings.push(...journal.operations.filter(op => op.state === 'acknowledged' && validAdoptOperation(op)).map(op => op.binding));
  const unowned = observation.agents.filter(a => {
    const run = matchingRun(a, facts.record);
    return a.workspace_id === target.workspace && !bindings.some(b => equalBinding(b, agentBinding(a, observation.server, a.tab_id))) && (!run || run.abandoned);
  });
  return unowned.length ? `unowned live occupant in workspace: ${unowned.map(a => a.name ?? a.pane_id).sort().join(', ')}; preserve, never create beside it` : null;
}
