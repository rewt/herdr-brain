import {roleIs} from './roles.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';

// Completion evidence only: never reopens the item or reapplies its judgment.
export function selfClosedDecision(run,state,events) {
  const item=state.items.get(run?.item),worker=effectiveWorkerIdentity(run,state);
  if(!roleIs(item,'DEC')||!['done','dropped'].includes(item.closed?.as)||item.runs.at(-1)!==run?.id||
      run.report||run.abandoned||worker.identity_conflict||!worker.agent)return null;
  const closed=events.find(e=>e.seq===item.closed.seq&&e.type==='item.closed'&&e.id===item.id);
  if(!closed||closed.seq<=run.started.seq||closed.by!==worker.agent||
      (closed.completed_run&&closed.completed_run!==run.id))return null;
  return {item:item.id,run:run.id,seq:closed.seq,by:closed.by};
}
