// Standing order selects among candidates; it never changes eligibility.
import {ancestors,sortItems} from '../lib/state.mjs';
import {isQueueReview} from './review-queue.mjs';
import {ordinaryAdmissionHold} from '../lib/ordinary-admission.mjs';
import {roleIs} from '../lib/roles.mjs';

export function queueSelected(item,state,ordinaryAdmission) {
  if(!item)return false;
  if(ordinaryAdmission?.selected_only&&item.kind!=='goal'&&!roleIs(item,'REV'))return !ordinaryAdmissionHold(ordinaryAdmission,{item,state});
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

function sourceItem(state,item) {
  // A normal queued review serves its captured source's outcome. Canonical
  // reviews point to themselves and retain their ordinary classification.
  const source=isQueueReview(item)&&state.items.get(item.meta.review_source_item);
  return source&&source.id!==item.id?source:item;
}

function ownClass(state,item,policy) {
  if(item.meta.queue_class!=null)return item.meta.queue_class;
  if(item.runs.length&&policy.order.includes('finish-open-owned-work'))return 'finish-open-owned-work';
  const lineage=ancestors(state,item.id);
  const inherited=lineage.find(i=>i.meta.queue_class!=null)?.meta.queue_class;
  if(inherited!=null)return inherited;
  return [item,...lineage].some(i=>i.id===policy.owner)?policy.default:null;
}

function classRank(group,policy) {
  const n=policy?.order.indexOf(group)??-1;
  return n>=0?n:(policy?.order.length??0)+(group==='historical-backlog'?1:0);
}

function classifier(state,policy) {
  if(!policy)return ()=>null;
  // Dependency urgency is a snapshot view, never a stored class change. Walk
  // open dependents with a per-root seen set so cycles cannot invent urgency.
  const dependents=new Map(),cache=new Map();
  for(const {blocker,blocked} of state.links){
    const target=state.items.get(blocked);
    if(!target||target.closed)continue;
    if(!dependents.has(blocker))dependents.set(blocker,[]);
    dependents.get(blocker).push(target);
  }
  return item=>{
    item=sourceItem(state,item);
    if(cache.has(item.id))return cache.get(item.id);
    let best=ownClass(state,item,policy);
    const pending=[item],seen=new Set();
    while(pending.length){
      const current=sourceItem(state,pending.pop());
      if(seen.has(current.id))continue;
      seen.add(current.id);
      const group=ownClass(state,current,policy);
      if(policy.order.includes(group)&&classRank(group,policy)<classRank(best,policy))best=group;
      pending.push(...(dependents.get(current.id)??[]));
    }
    cache.set(item.id,best);
    return best;
  };
}

export function queueClass(state,item,policy=queuePolicy(state)) {
  return classifier(state,policy)(item);
}

export function orderQueue(state,items,policy=queuePolicy(state)) {
  const classify=classifier(state,policy),rank=item=>classRank(classify(item),policy);
  // Numeric item priority and review preference remain tie breakers within an
  // outcome. A held high outcome never gates independent lower ready work.
  return sortItems(items).sort((a,b)=>rank(a)-rank(b)||Number(isQueueReview(b))-Number(isQueueReview(a)));
}
