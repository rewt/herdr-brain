// Project-local selection; readiness, ownership and effect guards remain separate.
import {ancestors} from './state.mjs';
import {roleIs} from './roles.mjs';

export function validateOrdinaryAdmission(policy){
  const check=(ok,message)=>{if(!ok)throw Error(`ordinary_admission ${message}`);};
  check(policy!==null&&typeof policy==='object'&&!Array.isArray(policy),'must be an object');
  for(const key of Object.keys(policy))check(['selected_only','items'].includes(key),`unknown field: ${key}`);
  check(typeof policy.selected_only==='boolean','selected_only must be boolean');
  if(policy.items!==undefined)check(Array.isArray(policy.items)&&policy.items.every(id=>typeof id==='string'&&/^[A-Z]+-[1-9]\d*$/.test(id))&&new Set(policy.items).size===policy.items.length,'items must contain distinct exact item or ancestor IDs');
  return policy;
}

export function ordinaryAdmissionHold(policy,{item,state}={}){
  if(!policy?.selected_only||!item||item.kind==='goal'||roleIs(item,'REV'))return null;
  if(item.meta.queue_selected===false)return{code:'ORDINARY_ADMISSION_DESELECTED',reason:'Ordinary item is explicitly deselected; retain it pending.'};
  if(item.meta.queue_selected===true)return null;
  const named=new Set(policy.items??[]);
  if(named.has(item.id)||state&&ancestors(state,item.id).some(a=>named.has(a.id)))return null;
  return{code:'ORDINARY_ADMISSION_NOT_SELECTED',reason:'Ordinary item has no explicit selection or named item/ancestor in the project admission policy; retain it pending.'};
}
