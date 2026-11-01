import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {boundSuccessor} from './session-release.mjs';

// Release exceptions cover only the original report and every bound predecessor.
export function reportedCloseout(entry,state) {
  return Boolean(entry.reportCloseout&&state.runs.get(entry.run)?.report&&
    entry.panes.every(p=>state.runs.get(p.run??entry.run)?.report));
}

// A newer item run does not acquire an older run's separate allocation. This
// admits only the unchanged finished owner, never a reused lane or occupant.
export function finishedOlderAllocation(entry,state) {
  if(!entry.reportCloseout)return false;
  return unchangedFinishedAllocation(entry,state,false);
}

// Supersession releases the old native occupant, including in a reused lane.
// It grants no physical removal authority over the successor's allocation.
export function supersededSessionAllocation(entry,state) {
  const run=state.runs.get(entry.run);
  return entry.signal==='ready'&&entry.panes.length>0&&
    Boolean(run&&boundSuccessor(state,run))&&unchangedFinishedAllocation(entry,state,true);
}

function unchangedFinishedAllocation(entry,state,sharedLane) {
  const run=state.runs.get(entry.run),a=entry.allocation,item=state.items.get(entry.item),
    index=item?.runs.indexOf(entry.run)??-1;
  if(!a||index<0||!run||( !run.report&&!run.abandoned)||
      run.item!==entry.item||run.workspace!==entry.cwd||run.started.seq!==a.started_seq||
      (run.owner_generation??null)!==a.claim_generation||(run.meta?.dispatch_attempt??null)!==a.dispatch||
      (run.report?.sha256??null)!==a.report_sha256||
      JSON.stringify(state.workerReceipts?.get(run.id)??null)!==JSON.stringify(a.worker))return false;
  const worker=effectiveWorkerIdentity(run,state);
  if(worker.identity_conflict||entry.panes.some(p=>(p.run??entry.run)===run.id&&
      (p.agent!==worker.agent||p.pane!==worker.pane||p.terminal!==worker.terminal_id||
       p.workspace!==worker.worker_workspace||p.session!==worker.agent_session_id)))return false;
  return item.runs.slice(index+1).every(id=>{
    const later=state.runs.get(id),m=effectiveWorkerIdentity(later,state);
    return later&&(sharedLane||later.workspace!==entry.cwd)&&!m.identity_conflict&&
      !['agent','pane','terminal_id','agent_session_id'].some(k=>worker[k]&&worker[k]===m[k])&&
      !entry.panes.some(p=>p.pane===m.pane||p.terminal===m.terminal_id||p.session===m.agent_session_id||p.agent===m.agent);
  });
}
