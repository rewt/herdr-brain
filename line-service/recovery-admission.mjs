// Read-only observations and exact, existing note authority. No new event types,
// effect authority, target execution, service changes or frozen-root edits.
import { createHash } from 'node:crypto';
import { requireRecordCompatibility, recoveryContract } from '../lib/record-compatibility.mjs';
import { canonical } from '../messages/schema.mjs';

export function recoveryEntryDecision(candidate, recovery) {
  const contract = recoveryContract(candidate, recovery);
  return { ...contract, required_decision: contract.excess.length
    ? `Brain recovery contract excess accepted: ${createHash('sha256').update(canonical(contract)).digest('hex')}` : null };
}

export function requireRecoveryEntry({candidate, recovery, events, authority, owner, validateOwner}) {
  const contract = recoveryEntryDecision(candidate, recovery);
  if (!contract.required_decision) return contract;
  const note = events.find(event => event.seq === Number(authority));
  if (note?.type !== 'note.added' || note.decision !== true || note.by !== owner || note.text !== contract.required_decision)
    throw Error(`recovery-contract-exceeded: ${contract.excess.join(', ')}; separate explicit decision required: ${contract.required_decision}`);
  validateOwner(note, events);
  return { ...contract, authority: note.seq };
}

export function observeRecoveryAdmission({events, identity, org, log, tornTail=false}) {
  const trials = events.filter(event => event.type === 'line-service.probation-authorized' && event.project === identity && event.org === org &&
    !events.some(end => ['line-service.probation-withdrawn', 'line-service.probation-completed'].includes(end.type) &&
      end.project === identity && end.org === org && end.id === event.id));
  return trials.map(trial => {
    const root = trial.scope?.previous?.release?.root;
    let row;
    try {
      if (tornTail) throw Error('incomplete record prevents recovery admission');
      const proof = requireRecordCompatibility(root, events);
      row = { action: 'recovery-admission', trial: trial.id, root, through: proof.through, admissible: true };
    } catch (error) {
      row = { action: 'recovery-admission-supervisor-alarm', trial: trial.id, root, admissible: false,
        owner: 'project-supervisor', reason: error.message, authority: 'visibility only; original holds and effects retained' };
    }
    log(row);
    return row;
  });
}
