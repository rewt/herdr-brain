// One doctrine shared by current generators; old delivered bytes are immutable.
export const uncertainOutcomeDoctrine = 'An uncertain attempt blocks only its own subject (that lane, head or recipient) until its completion is recorded. Whatever completes or fails (a worker, a command, the runtime reporting an exit) writes its status to the record, linked to the queue entry waiting on it; nothing waits on a manual command, a timer or a re-check. A pending status with no producer is a defect and becomes a decision item. Elapsed time never proves absence or completion. A native refusal is a recorded status and becomes a decision item. Unlanded work, claims, STOP/HOLD and outward actions stay protected.';

const refusals = new Set(['EPERM','EACCES','NATIVE_REFUSAL','native_refusal','permission_denied','permission_refused','permission_required','forbidden','unauthorized','native_permission_denied','SHELL_NATIVE_MISMATCH','RUN_OWNED_ELSEWHERE','RUN_CLAIM_INVALID','DISPATCH_STOPPED','SOURCE_GUARD']);
export function outcomeFailure(error) {
  let code=error.failure?.code??error.code??error.receipt?.error;
  for(const raw of [error.receipt?.stdout,error.receipt?.stderr])try{
    const value=JSON.parse(raw);code=value.failure?.code??value.error?.code??value.code??code;
  }catch{}
  return {code:code??'OUTCOME_UNKNOWN',kind:error.failure?.kind==='fence'||refusals.has(code)?'fence':'unknown'};
}
