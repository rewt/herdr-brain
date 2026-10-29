import { roleIs } from './roles.mjs';

// An open formal correction may run beneath its own completed review. Only
// that exact review parent's closure is excused; its hold/reserved flags and
// every further ancestor keep the ordinary checks. Callers without the event log
// get no exemption.
function formalReviewParent(state, events, child, review) {
  const meta = child.meta ?? {}, target = review.meta?.review_target, keys = meta.review_finding_keys;
  if (!events || child.closed || !roleIs(child, 'ENG') || !roleIs(review, 'REV') || review.closed?.as !== 'done' ||
      !meta.review_fix_of || !target?.head || meta.review_fix_of !== review.meta.review_key ||
      meta.review_fix_of !== `${review.meta.review_source_item}:${target.head}` ||
      meta.review_source_item !== review.meta.review_source_item || meta.review_source_run !== review.meta.review_source_run ||
      !Array.isArray(keys) || !keys.length) return false;
  const links = events.filter(e => e.type === 'review.finding-linked' && keys.includes(e.finding_key));
  return keys.every(key => {
    const bound = links.filter(e => e.finding_key === key), run = state.runs.get(bound[0]?.review_run);
    return bound.length && run && bound.every(e => e.correction_item === child.id && e.review_item === review.id &&
      e.review_run === run.id && e.source_item === meta.review_source_item && e.head === target.head && e.base === target.base) &&
      run.item === review.id && review.runs.includes(run.id) && run.report && child.created?.run === run.id;
  });
}

// Completing work archives the parent's result, not its open follow-ups. Goals
// and dropped work still close their subtree. Reviews retain their exact typed
// correction exception; reparenting a correction must never bypass that rule.
function completedWorkAncestor(current, target, depth) {
  return depth > 1 && current.kind === 'work' && current.closed?.as === 'done' &&
    !roleIs(current, 'REV') && !(depth === 2 && target.meta?.review_fix_of);
}

// Shared selection/launch ancestry predicate. Callers still re-read at each
// native boundary; a prior selection result grants no authority.
export function itemLaunchHold(state, item, events) {
  const seen=new Set(),target=state.items.get(item);
  for(let id=item;id;){
    if(seen.has(id))return {subject:id,reason:`ancestor cycle at ${id}`};
    seen.add(id);const current=state.items.get(id);
    if(!current)return {subject:id,reason:`item/ancestor ${id} is missing`};
    const closed=current.closed&&!completedWorkAncestor(current,target,seen.size)&&
      !(seen.size===2&&formalReviewParent(state,events,target,current));
    if(closed||current.meta.hold||current.meta.held||current.meta.operator_reserved||current.meta.reserved||current.role==='human')
      return {subject:id,reason:`item/ancestor ${id} is closed/held/reserved`};
    id=current.parent;
  }
  return null;
}
