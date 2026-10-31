import {claimRetirementAllocation,claimRetirementOwner,closeoutPolicy,
  closeoutRecordMatches,assertQueueOwnership} from '../lib/closeout.mjs';

// Dispatch and the source-bound closer exclude one another on the exact
// branch. The project owner is only admission when the queue owns retirement;
// legacy sweepers still need the original project-wide exclusion throughout.
export function dispatchAllocationEffect({project,org,branch,waitMs=60000,deadline=Infinity},operation){
  const allocation=claimRetirementAllocation(project.identity,branch,{deadline});
  let release;
  try{
    release=claimRetirementOwner(project.identity,{waitMs,deadline});
    if(closeoutRecordMatches(project,org)&&closeoutPolicy(project.canonical)){
      assertQueueOwnership(project,org);
      release();release=null;
    }
    return operation();
  }finally{
    release?.();allocation();
  }
}
