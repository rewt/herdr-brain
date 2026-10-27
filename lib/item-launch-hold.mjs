// Shared selection/launch ancestry predicate. Callers still re-read at each
// native boundary; a prior selection result grants no authority.
export function itemLaunchHold(state, item) {
  const seen=new Set();
  for(let id=item;id;){
    if(seen.has(id))return {subject:id,reason:`ancestor cycle at ${id}`};
    seen.add(id);const current=state.items.get(id);
    if(!current)return {subject:id,reason:`item/ancestor ${id} is missing`};
    if(current.closed||current.meta.hold||current.meta.held||current.meta.operator_reserved||current.meta.reserved||current.role==='human')
      return {subject:id,reason:`item/ancestor ${id} is closed/held/reserved`};
    id=current.parent;
  }
  return null;
}
