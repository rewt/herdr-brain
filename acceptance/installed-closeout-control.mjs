import assert from 'node:assert/strict';

export async function expiredCloseoutControl({runCloseoutTurn, until, options}) {
  let deadline, contentions=0;
  // Lock absence cannot reserve the next turn. Retry only the supported
  // contention result, within the caller's existing bounded observation.
  await until(()=>{
    let ticks=0;
    deadline=runCloseoutTurn({...options,budgetMs:0,clock:()=>ticks++});
    if(deadline.already_running===true){contentions++;return false;}
    return true;
  },'expired-budget control acquired its finite turn');
  assert.equal(deadline.steps,0);assert.equal(deadline.backlog_classified,0);
  return {deadline,contentions};
}

