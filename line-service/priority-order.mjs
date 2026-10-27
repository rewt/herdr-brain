// Standing order selects among candidates; it never changes eligibility.
import {ancestors,sortItems} from '../lib/state.mjs';
import {isQueueReview} from './review-queue.mjs';

export function queueSelected(item) {
  if(!item)return false;
  if(item.meta.queue_selected===false)return false;
  // A captured post-code review is an existing landed-source obligation.
  // Report proposals need an explicit own-item selection; selecting their
  // parent does not select every future proposal under it.
  return item.meta.queue_selected===true||isQueueReview(item)||!item.created.run;
}

export function queuePolicy(state) {
  const owners=[...state.items.values()].filter(i=>!i.closed&&i.meta.queue_order!=null);
  if(owners.length>1)throw Error('standing queue order has multiple owners; retain holds and resolve the ambiguity');
  if(!owners.length)return null;
  const owner=owners[0];let order=owner.meta.queue_order;
  if(typeof order==='string')try{order=JSON.parse(order);}catch{throw Error('standing queue_order must be a JSON array');}
  if(!Array.isArray(order)||!order.length||order.some(v=>typeof v!=='string'||!v.trim())||new Set(order).size!==order.length)
    throw Error('standing queue_order must contain distinct nonempty class names');
  return {owner:owner.id,order,default:owner.meta.queue_default??null};
}

export function queueClass(state,item,policy=queuePolicy(state)) {
  if(!policy)return null;
  // A normal queued review serves its captured source's outcome. Canonical
  // reviews point to themselves and retain their ordinary classification.
  const source=isQueueReview(item)&&state.items.get(item.meta.review_source_item);
  if(source&&source.id!==item.id)item=source;
  if(item.meta.queue_class!=null)return item.meta.queue_class;
  if(item.runs.length&&policy.order.includes('finish-open-owned-work'))return 'finish-open-owned-work';
  const lineage=ancestors(state,item.id);
  const inherited=lineage.find(i=>i.meta.queue_class!=null)?.meta.queue_class;
  if(inherited!=null)return inherited;
  return [item,...lineage].some(i=>i.id===policy.owner)?policy.default:null;
}

export function orderQueue(state,items,policy=queuePolicy(state)) {
  const rank=item=>{
    const group=queueClass(state,item,policy),n=policy?.order.indexOf(group)??-1;
    return n>=0?n:(policy?.order.length??0)+(group==='historical-backlog'?1:0);
  };
  // Numeric item priority and review preference remain tie breakers within an
  // outcome. A held high outcome never gates independent lower ready work.
  return sortItems(items).sort((a,b)=>rank(a)-rank(b)||Number(isQueueReview(b))-Number(isQueueReview(a)));
}
