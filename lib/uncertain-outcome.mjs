// One doctrine shared by current generators; old delivered bytes are immutable.
export const uncertainOutcomeDoctrine = 'When a worker report is in, close its session and remove its worktree folder in the same step; delete its branch only if it is already on main, otherwise keep the branch so a fix can continue from it, and keep the folder only if it has unsaved changes. Reviews and fixes start fresh from the record and may resume a saved session by its ID; nothing stays open waiting.';

const refusals = new Set(['EPERM','EACCES','NATIVE_REFUSAL','native_refusal','permission_denied','permission_refused','permission_required','forbidden','unauthorized','native_permission_denied','SHELL_NATIVE_MISMATCH','RUN_OWNED_ELSEWHERE','RUN_CLAIM_INVALID','DISPATCH_STOPPED','SOURCE_GUARD']);
export function outcomeFailure(error) {
  let code=error.failure?.code??error.code??error.receipt?.error;
  for(const raw of [error.receipt?.stdout,error.receipt?.stderr])try{
    const value=JSON.parse(raw);code=value.failure?.code??value.error?.code??value.code??code;
  }catch{}
  return {code:code??'OUTCOME_UNKNOWN',kind:error.failure?.kind==='fence'||refusals.has(code)?'fence':'unknown'};
}
